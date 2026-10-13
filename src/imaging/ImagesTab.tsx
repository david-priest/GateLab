// ImagesTab.tsx — the image wall: every cell of the plotted population that has an image, as a
// grid of thumbnails sorted by any channel, with the same channel and exposure controls as the
// inspector. Kept mounted once visited, like the Compensation tab, and dormant while hidden: a
// gating-only update must not reach it (App.hiddenTabWork.test.tsx), so its memo comparator
// ignores every prop while both the old and the new render are hidden.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { HoveredCell } from "../engine/cellHoverStore";
import { useI18n } from "../ui/i18n";
import { usePersistedTabState } from "../ui/tabState";
import type { CellImageView, CellInspectorEntry } from "./CellInspector";
import { drawPicture } from "./CellInspector";
import { NATIVE_HOP } from "./cvwDecode";
import type { RenderSpecMessage } from "./cvwProtocol";
import type { ImageService, SourceInfo } from "./imageService";
import { useCellImage } from "./useCellImage";

export interface ImagesTabProps {
  readonly visible: boolean;
  /** Workspace and sample; a change remounts the tab with fresh state. */
  readonly stateKey: string;
  readonly service: ImageService | null;
  /** The viewed sample. */
  readonly entry: CellInspectorEntry | null;
  /** The plotted population's membership; null means every event. */
  readonly mask: Uint8Array | null;
  readonly populationLabel: string;
  readonly view: CellImageView | undefined;
  readonly onViewChange: (sampleId: string, view: CellImageView) => void;
  readonly pinned: HoveredCell | null;
  readonly onPin: (cell: HoveredCell | null) => void;
  /** Go to the Gating tab, where the pinned cell is marked on the plot. */
  readonly onShowOnPlot: () => void;
}

const GAP = 4;
const OVERSCAN_ROWS = 2;
const THUMBNAIL_HOP = NATIVE_HOP;

interface WallTileProps {
  readonly service: ImageService | null;
  readonly fileKey: string;
  readonly sampleId: string;
  readonly eventIndex: number;
  readonly spec: RenderSpecMessage | null;
  readonly size: number;
  readonly pinned: boolean;
  readonly onPin: (cell: HoveredCell) => void;
  readonly onOpen: () => void;
  readonly label: string;
}

function WallTile({ service, fileKey, sampleId, eventIndex, spec, size, pinned, onPin, onOpen, label }: WallTileProps) {
  const image = useCellImage(service, fileKey, eventIndex, spec, "batch");
  const shown = image.result?.kind === "image" ? image.result.image : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!shown?.composite || !canvasRef.current) return;
    const width = shown.cols * shown.aspect;
    const zoom = Math.min(size / width, size / shown.rows);
    drawPicture(canvasRef.current, shown.composite, width * zoom, shown.rows * zoom);
  }, [shown, size]);
  return (
    <button
      type="button"
      role="gridcell"
      className={"gl-wall-tile" + (pinned ? " gl-wall-tile-pinned" : "")}
      style={{ width: size, height: size }}
      title={label}
      aria-label={label}
      aria-selected={pinned}
      onClick={() => onPin({ sampleId, eventIndex })}
      onDoubleClick={onOpen}
    >
      {shown ? <canvas ref={canvasRef} /> : <span className="gl-wall-tile-empty">{image.status === "none" ? "·" : ""}</span>}
      <span className="gl-wall-tile-index">{eventIndex.toLocaleString()}</span>
    </button>
  );
}

function ImagesTabImpl({
  visible, service, entry, mask, populationLabel, view, onViewChange, pinned, onPin, onShowOnPlot,
}: ImagesTabProps) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = usePersistedTabState<string>("images.sortKey", "");
  const [sortDesc, setSortDesc] = usePersistedTabState<boolean>("images.sortDesc", false);
  const [tileSize, setTileSize] = usePersistedTabState<number>("images.tileSize", 72);
  const images = entry?.images ?? null;
  const channels = view?.display ?? images?.display ?? null;
  const exposure = view?.exposure ?? 1;

  // Hidden, the wall renders no tiles, and each tile's request is cancelled as it unmounts. The
  // batch lane itself stays open: the plot's thumbnails and the object count share it.

  const [info, setInfo] = useState<{ id: string; info: SourceInfo | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!service || !entry || !images || !visible) return;
    const known = service.knownInfo(entry.id);
    if (known) {
      setInfo({ id: entry.id, info: known, error: null });
      return;
    }
    let live = true;
    service.info(entry.id).then(
      (found) => { if (live) setInfo({ id: entry.id, info: found, error: null }); },
      (error: unknown) => { if (live) setInfo({ id: entry.id, info: null, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [service, entry, images, visible]);
  const sourceInfo = info && entry && info.id === entry.id ? info.info : null;
  const sourceError = info && entry && info.id === entry.id ? info.error : null;

  const spec = useMemo<RenderSpecMessage | null>(() => {
    if (!channels || !sourceInfo) return null;
    return { display: channels, scale: sourceInfo.scale, exposure, hop: THUMBNAIL_HOP, composite: true, channels: [] };
  }, [channels, sourceInfo, exposure]);

  /** The events on the wall: in the population, with an image, in the chosen order. */
  const { events, inPopulation } = useMemo(() => {
    if (!entry || !sourceInfo) return { events: new Int32Array(0), inPopulation: 0 };
    const n = entry.sample.fcs.nEvents;
    const flags = sourceInfo.hasImage;
    let count = 0;
    let shown = 0;
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      count++;
      if (flags[i]) shown++;
    }
    const out = new Int32Array(shown);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      if (flags[i]) out[k++] = i;
    }
    const idx = sortKey ? entry.sample.channels.findIndex((c) => c.key === sortKey) : -1;
    if (idx >= 0) {
      const column = entry.sample.displayColumn(idx);
      const sign = sortDesc ? -1 : 1;
      out.sort((a, b) => sign * (column[a] - column[b]) || a - b);
    } else if (sortDesc) {
      out.reverse();
    }
    return { events: out, inPopulation: count };
  }, [entry, sourceInfo, mask, sortKey, sortDesc]);

  // Virtual rows: only the tiles in and around the viewport exist.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, scrollTop: 0 });
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !visible) return;
    const measure = () => setViewport({ width: node.clientWidth, height: node.clientHeight, scrollTop: node.scrollTop });
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    node.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      node.removeEventListener("scroll", measure);
    };
  }, [visible]);
  const step = tileSize + GAP;
  const columns = Math.max(1, Math.floor((viewport.width + GAP) / step));
  const rowCount = Math.ceil(events.length / columns);
  const firstRow = Math.max(0, Math.floor(viewport.scrollTop / step) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((viewport.scrollTop + viewport.height) / step) + OVERSCAN_ROWS);
  const firstTile = firstRow * columns;
  const lastTile = Math.min(events.length, lastRow * columns);

  const moveFocus = (from: HTMLElement, by: number) => {
    const tiles = [...(scrollRef.current?.querySelectorAll<HTMLButtonElement>(".gl-wall-tile") ?? [])];
    const at = tiles.indexOf(from as HTMLButtonElement);
    if (at < 0) return;
    const target = tiles[Math.max(0, Math.min(tiles.length - 1, at + by))];
    target?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("gl-wall-tile")) return;
    const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : null;
    if (by === null) return;
    event.preventDefault();
    moveFocus(target, by);
  };

  if (!visible) return <div style={{ display: "none" }} />;

  const toggleChannel = (slot: number) => {
    if (!entry || !channels) return;
    onViewChange(entry.id, { display: channels.map((c) => (c.slot === slot ? { ...c, enabled: !c.enabled } : c)), exposure });
  };

  return (
    <section className="gl-tab-panel gl-tab-fill gl-images-tab" aria-label={t("Images")}>
      {!entry || !images ? (
        <div className="gl-empty">{t("No cell images are attached to the viewed file. Attach a .cvw from the Import menu.")}</div>
      ) : (
        <>
          <div className="gl-images-toolbar">
            <span className="gl-images-count">
              {t("{count} cells in {population} · {shown} with images", {
                count: inPopulation.toLocaleString(),
                population: populationLabel,
                shown: events.length.toLocaleString(),
              })}
            </span>
            <label className="gl-images-control">
              <span>{t("Sort by")}</span>
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>
                <option value="">{t("Event order")}</option>
                {entry.sample.channels.map((channel) => (
                  <option key={channel.key} value={channel.key}>{channel.label ?? channel.key}</option>
                ))}
              </select>
              <button type="button" className="gl-mini-btn" aria-pressed={sortDesc} onClick={() => setSortDesc((d) => !d)} title={t("Reverse the order")}>
                {sortDesc ? "↓" : "↑"}
              </button>
            </label>
            <label className="gl-images-control">
              <span>{t("Tile size")}</span>
              <input type="range" min={40} max={160} step={8} value={tileSize} onChange={(event) => setTileSize(Number(event.target.value))} />
            </label>
            <label className="gl-images-control">
              <span>{t("Exposure")}</span>
              <input
                type="range"
                min={-2}
                max={2}
                step={0.05}
                value={Math.log2(exposure)}
                onChange={(event) => { if (channels) onViewChange(entry.id, { display: channels.slice(), exposure: Math.pow(2, Number(event.target.value)) }); }}
              />
            </label>
            {channels && (
              <span className="gl-images-channels">
                {channels.map((channel) => (
                  <label key={channel.slot} className="gl-images-channel" title={channel.name}>
                    <input type="checkbox" checked={channel.enabled} onChange={() => toggleChannel(channel.slot)} />
                    <span className="gl-cell-chip" style={{ background: channel.colour }} />
                    {channel.name}
                  </label>
                ))}
              </span>
            )}
            <button type="button" className="gl-mini-btn" disabled={!pinned} onClick={onShowOnPlot}>{t("Show on plot")}</button>
          </div>
          {sourceError && <div className="gl-error-inline">{sourceError}</div>}
          <div className="gl-images-scroll" ref={scrollRef} role="grid" aria-rowcount={rowCount} onKeyDown={onKeyDown}>
            <div style={{ height: firstRow * step }} />
            <div className="gl-images-grid" style={{ gridTemplateColumns: `repeat(${columns}, ${tileSize}px)`, gap: GAP }}>
              {Array.from({ length: Math.max(0, lastTile - firstTile) }, (_, k) => {
                const eventIndex = events[firstTile + k];
                return (
                  <WallTile
                    key={eventIndex}
                    service={service}
                    fileKey={entry.id}
                    sampleId={entry.id}
                    eventIndex={eventIndex}
                    spec={spec}
                    size={tileSize}
                    pinned={pinned?.sampleId === entry.id && pinned.eventIndex === eventIndex}
                    onPin={onPin}
                    onOpen={onShowOnPlot}
                    label={t("Event {index} of {name}", { index: eventIndex.toLocaleString(), name: entry.name })}
                  />
                );
              })}
            </div>
            <div style={{ height: Math.max(0, (rowCount - lastRow) * step) }} />
          </div>
        </>
      )}
    </section>
  );
}

/** Exported so a test's stand-in for the tab can be memoised exactly as the tab is. */
export function imagesTabPropsEqual(previous: Readonly<ImagesTabProps>, next: Readonly<ImagesTabProps>): boolean {
  if (previous.visible || next.visible) return false;
  return previous.stateKey === next.stateKey;
}

export const ImagesTab = memo(ImagesTabImpl, imagesTabPropsEqual);
