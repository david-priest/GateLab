// CellInspector.tsx — the docked panel that shows the cell under the cursor, or the pinned one:
// the composite of the enabled channels at true shape, each channel on its own, the exposure
// and the channel toggles, and the per-event features Chorus wrote into the FCS. Rendered only
// when a file in the workspace has images attached, in the Gating tab's side pane. It reads
// the hovered cell from its store, so a hover re-renders this panel and nothing else.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CellHoverStore, HoveredCell } from "../engine/cellHoverStore";
import type { Sample } from "../engine/sample";
import { useI18n } from "../ui/i18n";
import type { RenderedPicture, RenderSpecMessage } from "./cvwProtocol";
import type { ImageService, SourceInfo } from "./imageService";
import type { CellImageSource } from "./imageSource";
import type { ChannelDisplay } from "./imageWallSettings";
import { NATIVE_HOP } from "./cvwDecode";
import { useCellImage } from "./useCellImage";

export interface CellInspectorEntry {
  readonly id: string;
  readonly name: string;
  readonly images: CellImageSource | null;
  readonly sample: Sample;
}

export interface CellImageView {
  readonly display: ChannelDisplay[];
  readonly exposure: number;
  /** Draw the counted objects' outline over the pictures. */
  readonly outline?: boolean;
}

/** What a render request carries for the outline: Chorus's mask when the FCS records it, else the worker's default. */
export function outlineSpecOf(outline: boolean, images: { readonly mask: { readonly slot: number; readonly fraction: number } | null } | null): { slot?: number; fraction?: number } | undefined {
  if (!outline) return undefined;
  return images?.mask ? { slot: images.mask.slot, fraction: images.mask.fraction } : {};
}

export interface CellInspectorProps {
  readonly service: ImageService | null;
  readonly hoverStore: CellHoverStore;
  /** The pinned cell, which takes precedence over the hovered one. */
  readonly pinned: HoveredCell | null;
  /** The file a cell belongs to; null when it is no longer loaded. */
  readonly resolveEntry: (sampleId: string) => CellInspectorEntry | null;
  /** Per-file display settings the user has changed; a file not listed shows its own defaults. */
  readonly view: Readonly<Record<string, CellImageView>>;
  readonly onViewChange: (sampleId: string, view: CellImageView) => void;
  readonly onUnpin: () => void;
  /** The objects counted in the cell's image, when the file has been classified. */
  readonly objectCountOf?: (cell: HoveredCell) => number | null;
  /** The cell's single-cell class and, when irregular, why. */
  readonly cellClassOf?: (cell: HoveredCell) => { label: string; reasons: string[] } | null;
  /** Folded to its header; nothing is requested while folded. */
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  /** Where the panel sits: at the bottom of the gating side pane, or in a column of its own. */
  readonly dock: "pane" | "column";
  readonly onToggleDock: () => void;
}

/**
 * The composite is drawn at a fixed height and shown inside a box of constant size, so the panel
 * does not change height from one event to the next (an event's image is as wide as its waveform
 * was long, 50 to 300 columns, and all are 104 rows). The box contains the picture at its own
 * aspect; the bars that remain are the box's black.
 */
const COMPOSITE_HEIGHT = 512;
const TILE_HEIGHT = 112;

/** Draw a rendered picture scaled to `width × height`, from its bitmap or its pixels. */
export function drawPicture(canvas: HTMLCanvasElement, picture: RenderedPicture, width: number, height: number): void {
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (picture.bitmap) {
    ctx.drawImage(picture.bitmap, 0, 0, canvas.width, canvas.height);
    return;
  }
  if (!picture.pixels) return;
  const scratch = document.createElement("canvas");
  scratch.width = picture.width;
  scratch.height = picture.height;
  const sctx = scratch.getContext("2d");
  if (!sctx) return;
  sctx.putImageData(new ImageData(picture.pixels as Uint8ClampedArray<ArrayBuffer>, picture.width, picture.height), 0, 0);
  ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
}

const formatFeature = (value: number): string => {
  if (!Number.isFinite(value)) return "–";
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString();
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(3);
};

/** The imaging features Chorus computed for one event, as the FCS carries them. */
export function imagingFeaturesOf(sample: Sample, eventIndex: number): { name: string; value: number }[] {
  const out: { name: string; value: number }[] = [];
  sample.channels.forEach((channel, idx) => {
    if (!sample.isImagingFeatureChannel(idx)) return;
    const column = sample.fcs.columns[channel.columnIndex];
    out.push({ name: channel.label ?? channel.key, value: column ? Number(column[eventIndex]) : NaN });
  });
  return out;
}

export function CellInspector({
  service, hoverStore, pinned, resolveEntry, view, onViewChange, onUnpin, objectCountOf, cellClassOf, collapsed, onToggleCollapsed, dock, onToggleDock,
}: CellInspectorProps) {
  const { t } = useI18n();
  const hovered = useSyncExternalStore(hoverStore.subscribe, hoverStore.get, hoverStore.get);
  const cell = pinned ?? hovered;
  const entry = useMemo(() => (cell ? resolveEntry(cell.sampleId) : null), [cell, resolveEntry]);
  const images = entry?.images ?? null;
  const own = entry ? view[entry.id] : undefined;
  const channels = own?.display ?? images?.display ?? null;
  const exposure = own?.exposure ?? 1;
  const outline = own?.outline ?? false;

  // The file's measured full scale per channel, from the worker, once per file.
  const [info, setInfo] = useState<{ id: string; info: SourceInfo | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!service || !entry || !images) return;
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
  }, [service, entry, images]);
  const scale = info && entry && info.id === entry.id ? info.info?.scale ?? null : null;
  const sourceError = info && entry && info.id === entry.id ? info.error : null;

  const spec = useMemo<RenderSpecMessage | null>(() => {
    if (!channels || !scale) return null;
    const outlineSpec = outlineSpecOf(outline, images);
    return { display: channels, scale, exposure, hop: NATIVE_HOP, composite: true, channels: channels.map((c) => c.slot), ...(outlineSpec ? { outline: outlineSpec } : {}) };
  }, [channels, scale, exposure, outline, images]);

  const image = useCellImage(service, images && entry && !collapsed ? entry.id : null, cell?.eventIndex ?? null, spec, "interactive");
  const shown = image.result?.kind === "image" ? image.result.image : null;
  const features = useMemo(() => (entry && cell ? imagingFeaturesOf(entry.sample, cell.eventIndex) : []), [entry, cell]);

  const compositeRef = useRef<HTMLCanvasElement | null>(null);
  const tileRefs = useRef(new Map<number, HTMLCanvasElement>());
  useEffect(() => {
    if (!shown) return;
    const zoom = COMPOSITE_HEIGHT / shown.rows;
    if (compositeRef.current && shown.composite) {
      drawPicture(compositeRef.current, shown.composite, shown.cols * shown.aspect * zoom, shown.rows * zoom);
    }
    const tileZoom = TILE_HEIGHT / shown.rows;
    for (const [slot, picture] of Object.entries(shown.channels)) {
      const canvas = tileRefs.current.get(Number(slot));
      if (canvas) drawPicture(canvas, picture, shown.cols * shown.aspect * tileZoom, shown.rows * tileZoom);
    }
  }, [shown]);

  const toggleChannel = (slot: number) => {
    if (!entry || !channels) return;
    onViewChange(entry.id, { display: channels.map((c) => (c.slot === slot ? { ...c, enabled: !c.enabled } : c)), exposure, outline });
  };
  const setExposure = (next: number) => {
    if (!entry || !channels) return;
    onViewChange(entry.id, { display: channels.slice(), exposure: next, outline });
  };
  const setOutline = (next: boolean) => {
    if (!entry || !channels) return;
    onViewChange(entry.id, { display: channels.slice(), exposure, outline: next });
  };

  return (
    <div
      className={"gl-side-section gl-cell-inspector" + (collapsed ? " gl-side-collapsed gl-cell-inspector-collapsed" : "") + (dock === "column" ? " gl-cell-inspector-column" : "")}
      aria-label={t("Cell")}
    >
      <div className="gl-side-head gl-cell-inspector-head">
        <button
          type="button"
          className="gl-side-disclosure"
          aria-expanded={!collapsed}
          title={collapsed ? t("Show the cell panel") : t("Hide the cell panel")}
          onClick={onToggleCollapsed}
        >
          <span className="gl-side-disclosure-mark" aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
          <span className="gl-side-title">{t("Cell")}</span>
        </button>
        {pinned ? (
          <>
            <span className="gl-cell-status gl-cell-status-pinned">{t("Pinned")}</span>
            <button type="button" className="gl-mini-btn" onClick={onUnpin}>{t("Unpin")}</button>
          </>
        ) : (
          <span className="gl-cell-status">{t("Nearest imaged cell")}</span>
        )}
        <button
          type="button"
          className="gl-mini-btn gl-cell-dock"
          title={dock === "column" ? t("Show at the bottom of the gates pane") : t("Show in a column of its own")}
          aria-label={dock === "column" ? t("Show at the bottom of the gates pane") : t("Show in a column of its own")}
          onClick={onToggleDock}
        >
          {dock === "column" ? "⇥" : "⇤"}
        </button>
      </div>
      {collapsed ? null : !entry || !cell ? (
        <div className="gl-hint">{t("Hover a dot to see its cell; click to pin it, Escape to unpin.")}</div>
      ) : !images ? (
        <div className="gl-hint">{t("No cell images are attached to {name}", { name: entry.name })}</div>
      ) : (
        <>
          {/* One line, never two: the panel's height must not move from cell to cell (David, 2026-10-14). The
              class's reasons sit in its tooltip, and the note below keeps its row whether or not it has anything to say. */}
          <div className="gl-cell-event" title={t("Event {index} of {name}", { index: cell.eventIndex.toLocaleString(), name: entry.name })}>
            <span className="gl-cell-event-name">{t("Event {index} of {name}", { index: cell.eventIndex.toLocaleString(), name: entry.name })}</span>
            {(() => {
              const count = objectCountOf?.(cell) ?? null;
              return count === null ? null : <span className="gl-cell-objects">{t("{count} objects", { count })}</span>;
            })()}
            {(() => {
              const cls = cellClassOf?.(cell) ?? null;
              if (cls === null) return null;
              const why = cls.reasons.map((reason) => t(reason)).join(", ");
              return <span className="gl-cell-class" title={why ? `${t(cls.label)}: ${why}` : t(cls.label)}>{t(cls.label)}</span>;
            })()}
          </div>
          <div className={"gl-cell-note" + (sourceError || image.status === "error" ? " gl-cell-note-error" : "")}>
            {sourceError
              ? sourceError
              : image.status === "none"
                ? t("No image for this event")
                : image.status === "error"
                  ? image.error
                  : image.status === "loading" && !shown
                    ? t("Loading the image…")
                    : ""}
          </div>
          <div className="gl-cell-composite" style={{ visibility: shown ? "visible" : "hidden" }}>
            <canvas ref={compositeRef} />
          </div>
          {channels && (
            <div className="gl-cell-tiles">
              {channels.map((channel) => (
                <label key={channel.slot} className={"gl-cell-tile" + (channel.enabled ? "" : " gl-cell-tile-off")} title={channel.name}>
                  <span className="gl-cell-tile-picture">
                    <canvas ref={(node) => { if (node) tileRefs.current.set(channel.slot, node); else tileRefs.current.delete(channel.slot); }} />
                  </span>
                  <span className="gl-cell-tile-name">
                    <input type="checkbox" checked={channel.enabled} onChange={() => toggleChannel(channel.slot)} />
                    <span className="gl-cell-chip" style={{ background: channel.colour }} />
                    {channel.name}
                  </span>
                </label>
              ))}
            </div>
          )}
          <label className="gl-cell-exposure">
            <span>{t("Exposure")}</span>
            <input
              type="range"
              min={-2}
              max={2}
              step={0.05}
              value={Math.log2(exposure)}
              onChange={(event) => setExposure(Math.pow(2, Number(event.target.value)))}
            />
            <span className="gl-cell-exposure-value">{exposure.toFixed(2)}×</span>
          </label>
          <label className="gl-cell-outline" title={t("Outline the objects the count found on the mask image, in magenta")}>
            <input type="checkbox" checked={outline} onChange={(event) => setOutline(event.target.checked)} />
            <span>{t("Mask outline")}</span>
          </label>
          {features.length > 0 && (
            <details className="gl-cell-features">
              <summary>{t("Image features")}</summary>
              <dl>
                {features.map((feature) => (
                  <div key={feature.name}>
                    <dt title={feature.name}>{feature.name}</dt>
                    <dd>{formatFeature(feature.value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </>
      )}
    </div>
  );
}
