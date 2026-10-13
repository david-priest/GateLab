// PlotThumbnails.tsx — a spread of small cell images laid over the gating plot at their events'
// positions, so the biplot can be read as "what the cells look like here". The cells are chosen
// by thumbnailSpread.ts from the data area's pixel size, so they never overlap; decoded on the
// batch lane; and drawn as an overlay layer: siblings of the renderer's container (which it
// empties on resize), placed through the same data-area rect the hover probe reads, and chosen
// again on pan and resize. Each is drawn at its image's own aspect with its longer edge at the
// chosen size. Clicking one pins the cell.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { HoveredCell } from "../engine/cellHoverStore";
import type { PlottedPoints } from "../engine/sample";
import type { CellImageView, CellInspectorEntry } from "./CellInspector";
import { drawPicture } from "./CellInspector";
import { NATIVE_HOP } from "./cvwDecode";
import type { RenderSpecMessage } from "./cvwProtocol";
import type { ImageService, SourceInfo } from "./imageService";
import { displayToPixel, plotFrame, type PlotFrame } from "./plotGeometry";
import { chooseSpread } from "./thumbnailSpread";
import { useCellImage } from "./useCellImage";

export interface PlotThumbnailsProps {
  readonly plotAreaRef: RefObject<HTMLElement | null>;
  readonly plotted: PlottedPoints | null;
  readonly xRange: readonly [number, number] | null;
  readonly yRange: readonly [number, number] | null;
  readonly service: ImageService | null;
  readonly activeSampleId: string | null;
  readonly resolveEntry: (sampleId: string) => CellInspectorEntry | null;
  readonly hasImage: (sampleId: string | null, eventIndex: number) => boolean;
  /** At most how many cells to show, and the longer edge of each thumbnail in pixels. */
  readonly count: number;
  readonly size: number;
  /** Which cells are drawn from each grid cell; the same seed shows the same cells. */
  readonly seed: number;
  readonly view: Readonly<Record<string, CellImageView>>;
  readonly onPin: (cell: HoveredCell) => void;
  readonly layoutKey?: unknown;
}

interface ThumbProps {
  readonly service: ImageService | null;
  readonly entry: CellInspectorEntry;
  readonly eventIndex: number;
  readonly spec: RenderSpecMessage | null;
  readonly size: number;
  readonly left: number;
  readonly top: number;
  readonly onPin: () => void;
  readonly label: string;
}

/** The thumbnail's box: the image's aspect with its longer edge at `size`. */
export function thumbBox(width: number, height: number, size: number): { width: number; height: number } {
  const zoom = size / Math.max(width, height, 1);
  return { width: Math.max(1, Math.round(width * zoom)), height: Math.max(1, Math.round(height * zoom)) };
}

/** The gap kept between thumbnails, in pixels. */
export const THUMB_GAP = 6;

function Thumb({ service, entry, eventIndex, spec, size, left, top, onPin, label }: ThumbProps) {
  const image = useCellImage(service, entry.images ? entry.id : null, eventIndex, spec, "batch");
  const shown = image.result?.kind === "image" ? image.result.image : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const box = shown ? thumbBox(shown.cols * shown.aspect, shown.rows, size) : null;
  useEffect(() => {
    if (!shown?.composite || !canvasRef.current || !box) return;
    drawPicture(canvasRef.current, shown.composite, box.width, box.height);
  }, [shown, box?.width, box?.height]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown || !box) return null;
  return (
    <button
      type="button"
      className="gl-plot-thumb"
      style={{ left: left - box.width / 2, top: top - box.height / 2, width: box.width, height: box.height }}
      title={label}
      aria-label={label}
      onClick={onPin}
    >
      <canvas ref={canvasRef} />
    </button>
  );
}

export function PlotThumbnails({
  plotAreaRef, plotted, xRange, yRange, service, activeSampleId, resolveEntry, hasImage, count, size, seed, view, onPin, layoutKey,
}: PlotThumbnailsProps) {
  // Where the data area is, re-measured when the plot moves.
  const [frame, setFrame] = useState<PlotFrame | null>(null);
  useEffect(() => {
    const area = plotAreaRef.current;
    if (!area) return;
    const measure = () => setFrame(plotFrame(area, xRange, yRange));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(area);
    return () => observer?.disconnect();
  }, [plotAreaRef, xRange, yRange, layoutKey]);

  // The cells: chosen once per plotted set, count, size and data-area size.
  const frameWidth = frame?.width ?? 0;
  const frameHeight = frame?.height ?? 0;
  const chosen = useMemo(() => {
    if (!plotted || !xRange || !yRange || !(frameWidth > 0) || !(frameHeight > 0)) return new Int32Array(0);
    const include = (k: number) => {
      const sampleId = plotted.sampleOf && plotted.sampleIds ? plotted.sampleIds[plotted.sampleOf[k]] ?? null : null;
      return hasImage(sampleId, plotted.indices ? plotted.indices[k] : k);
    };
    return chooseSpread(plotted, include, count, xRange, yRange, { width: frameWidth, height: frameHeight, cell: size + THUMB_GAP }, seed);
  }, [plotted, xRange, yRange, count, size, seed, hasImage, frameWidth, frameHeight]);

  // The full scale of every file on the plot, from the worker, once each.
  const sampleIds = useMemo(() => {
    const ids = new Set<string>();
    if (!plotted) return ids;
    if (plotted.sampleIds && plotted.sampleOf) for (const k of chosen) ids.add(plotted.sampleIds[plotted.sampleOf[k]]);
    else if (activeSampleId) ids.add(activeSampleId);
    return ids;
  }, [plotted, chosen, activeSampleId]);
  const [infos, setInfos] = useState<Record<string, SourceInfo>>({});
  useEffect(() => {
    if (!service) return;
    let live = true;
    for (const id of sampleIds) {
      if (infos[id]) continue;
      const known = service.knownInfo(id);
      if (known) {
        setInfos((prev) => (prev[id] ? prev : { ...prev, [id]: known }));
        continue;
      }
      service.info(id).then((info) => { if (live) setInfos((prev) => (prev[id] ? prev : { ...prev, [id]: info })); }, () => undefined);
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, sampleIds]);

  if (!plotted || !frame || chosen.length === 0) return null;
  const specFor = (entry: CellInspectorEntry): RenderSpecMessage | null => {
    const info = infos[entry.id];
    const channels = view[entry.id]?.display ?? entry.images?.display ?? null;
    if (!info || !channels) return null;
    return { display: channels, scale: info.scale, exposure: view[entry.id]?.exposure ?? 1, hop: NATIVE_HOP, composite: true, channels: [] };
  };
  const thumbs: JSX.Element[] = [];
  for (const k of chosen) {
    const sampleId = plotted.sampleOf && plotted.sampleIds ? plotted.sampleIds[plotted.sampleOf[k]] : activeSampleId;
    if (!sampleId) continue;
    const entry = resolveEntry(sampleId);
    if (!entry?.images) continue;
    const eventIndex = plotted.indices ? plotted.indices[k] : k;
    const [px, py] = displayToPixel(frame, plotted.xd[k], plotted.yd[k]);
    thumbs.push(
      <Thumb
        key={`${sampleId}:${eventIndex}`}
        service={service}
        entry={entry}
        eventIndex={eventIndex}
        spec={specFor(entry)}
        size={size}
        left={px}
        top={py}
        onPin={() => onPin({ sampleId, eventIndex })}
        label={`${entry.name} · ${eventIndex.toLocaleString()}`}
      />,
    );
  }
  return <div className="gl-plot-thumbs" aria-hidden="false">{thumbs}</div>;
}
