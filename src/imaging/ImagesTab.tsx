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
import { drawPicture, outlineSpecOf } from "./CellInspector";
import { NATIVE_HOP } from "./cvwDecode";
import type { RenderSpecMessage } from "./cvwProtocol";
import type { ImageService, SourceInfo } from "./imageService";
import { useCellImage } from "./useCellImage";
import type { LayoutImageWallRecipe } from "../engine/imageWallBlock";
import { WallHistogram } from "./WallHistogram";
import { eventsInRange, formatWallValue, wallHistogram } from "./wallBins";

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
  /** The plotted population, when it is one population; null for a union of checked ones. */
  readonly populationId?: string | null;
  /** The tree's populations in order, for the picker. */
  readonly populations?: readonly { id: string; name: string; depth: number }[];
  readonly onChoosePopulation?: (popId: string) => void;
  /** The cells of the population's parent that its gate leaves out, with the parent's name. */
  readonly excludedMask?: Uint8Array | null;
  readonly parentName?: string | null;
  /** Send the wall, as shown, to the Layout tab as one block. */
  readonly onSendToLayout?: (recipe: LayoutImageWallRecipe) => void;
  /** The class of an event under the plot's colouring, as an index into `classes`; null when unknown. */
  readonly classOf?: (eventIndex: number) => number | null;
  /** Make a population of cells picked on the wall (an image set), under the wall's population. */
  readonly onMakePopulation?: (events: number[], name: string) => void;
  /** Score every cell of the wall by likeness to the picked ones, as a channel of the file; returns its key, or null. */
  readonly onFindSimilar?: (events: number[], name: string) => string | null;
  readonly classes?: readonly { label: string; colour: string }[];
  /** What the classes are: the colouring's name. */
  readonly classTitle?: string;
}

/** The sort key that orders the wall by class. */
export const CLASS_SORT = "__class__";

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
  /** The tile's class colour, drawn as its border. */
  readonly colour?: string | null;
  /** Picked for an image set; a Cmd/Ctrl-click toggles it, a Shift-click picks the run from the last pick. */
  readonly picked?: boolean;
  readonly onPick?: (eventIndex: number, run: boolean) => void;
}

function WallTile({ service, fileKey, sampleId, eventIndex, spec, size, pinned, onPin, onOpen, label, colour = null, picked = false, onPick }: WallTileProps) {
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
      className={"gl-wall-tile" + (pinned ? " gl-wall-tile-pinned" : "") + (colour ? " gl-wall-tile-classed" : "") + (picked ? " gl-wall-tile-picked" : "")}
      style={{ width: size, height: size }}
      title={label}
      aria-label={label}
      aria-selected={pinned}
      aria-checked={onPick ? picked : undefined}
      data-event={eventIndex}
      onClick={(event) => {
        if (onPick && (event.metaKey || event.ctrlKey || event.shiftKey)) { onPick(eventIndex, event.shiftKey); return; }
        onPin({ sampleId, eventIndex });
      }}
      onDoubleClick={onOpen}
    >
      {shown ? <canvas ref={canvasRef} /> : <span className="gl-wall-tile-empty">{image.status === "none" ? "·" : ""}</span>}
      {/* The class ring sits in front of the picture: an inset shadow on the tile itself is painted under the canvas, so it showed only in the letterbox bars (David, 2026-10-14). */}
      {colour && <span className="gl-wall-tile-ring" aria-hidden="true" style={{ boxShadow: `inset 0 0 0 2px ${colour}` }} />}
      {picked && <span className="gl-wall-tile-pick" aria-hidden="true">✓</span>}
      <span className="gl-wall-tile-index">{eventIndex.toLocaleString()}</span>
    </button>
  );
}

function ImagesTabImpl({
  visible, service, entry, mask, populationLabel, view, onViewChange, pinned, onPin, onShowOnPlot,
  populationId = null, populations, onChoosePopulation, excludedMask = null, parentName = null, onSendToLayout,
  classOf, classes, classTitle, onMakePopulation, onFindSimilar,
}: ImagesTabProps) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = usePersistedTabState<string>("images.sortKey", "");
  const [sortDesc, setSortDesc] = usePersistedTabState<boolean>("images.sortDesc", false);
  const [tileSize, setTileSize] = usePersistedTabState<number>("images.tileSize", 72);
  // Which cells the wall shows: the population, or the cells its gate leaves out of the parent.
  const [showExcluded, setShowExcluded] = useState(false);
  useEffect(() => { setShowExcluded(false); }, [populationId]);
  const excluded = showExcluded && !!excludedMask && !!parentName;
  const wallMask = excluded ? excludedMask : mask;
  const wallLabel = excluded ? t("{parent} without {population}", { parent: parentName ?? "", population: populationLabel }) : populationLabel;
  const [wallCount, setWallCount] = usePersistedTabState<number>("images.wallCount", 48);
  // A limit on the sort channel's values, drawn on its histogram; it belongs to the channel it was drawn for.
  const [wallRange, setWallRange] = usePersistedTabState<{ key: string; lo: number; hi: number } | null>("images.range", null);
  const sortIdx = entry && sortKey && sortKey !== CLASS_SORT ? entry.sample.channels.findIndex((c) => c.key === sortKey) : -1;
  const sortChannel = sortIdx >= 0 && entry ? entry.sample.channels[sortIdx] : null;
  const sortLabel = sortChannel ? sortChannel.label ?? sortChannel.key : "";
  const sortColumn = useMemo(() => (entry && sortIdx >= 0 ? entry.sample.displayColumn(sortIdx) : null), [entry, sortIdx]);
  const activeRange: [number, number] | null = sortColumn && wallRange && wallRange.key === sortKey ? [wallRange.lo, wallRange.hi] : null;
  // Cells picked for an image set: a Cmd/Ctrl-click toggles one, a Shift-click picks the run from the
  // last pick in wall order, Space toggles the focused tile. The picks belong to this wall: a new file
  // or population starts empty.
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [setName, setSetName] = useState("");
  const lastPickRef = useRef<number | null>(null);
  useEffect(() => { setPicked(new Set()); lastPickRef.current = null; }, [entry?.id, wallMask]);
  // Under a class colouring, the wall can be limited to one class and ordered by class.
  const classed = !!classes && !!classOf;
  const [wallClass, setWallClass] = usePersistedTabState<string>("images.wallClass", "all");
  const colourOf = (eventIndex: number): string | null => {
    if (!classes || !classOf) return null;
    const c = classOf(eventIndex);
    return c === null ? null : classes[c]?.colour ?? null;
  };
  const images = entry?.images ?? null;
  const channels = view?.display ?? images?.display ?? null;
  const exposure = view?.exposure ?? 1;
  const outline = view?.outline ?? false;
  const outlineSpec = outlineSpecOf(outline, images);

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
    return { display: channels, scale: sourceInfo.scale, exposure, hop: THUMBNAIL_HOP, composite: true, channels: [], ...(outlineSpec ? { outline: outlineSpec } : {}) };
    // outlineSpec is a fresh object per render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, sourceInfo, exposure, outline, images]);

  /** The events on the wall: in the population, with an image, within the range, in the chosen order; `all` is before the range. */
  const { events, inPopulation, all } = useMemo(() => {
    if (!entry || !sourceInfo) return { events: new Int32Array(0), inPopulation: 0, all: new Int32Array(0) };
    const n = entry.sample.fcs.nEvents;
    const flags = sourceInfo.hasImage;
    let count = 0;
    let shown = 0;
    for (let i = 0; i < n; i++) {
      if (wallMask && !wallMask[i]) continue;
      count++;
      if (flags[i]) shown++;
    }
    let out = new Int32Array(shown);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (wallMask && !wallMask[i]) continue;
      if (flags[i]) out[k++] = i;
    }
    if (classed && wallClass !== "all") {
      const want = Number(wallClass);
      out = out.filter((e) => classOf!(e) === want);
    }
    const all = out;
    if (sortColumn && activeRange) out = eventsInRange(sortColumn, out, activeRange[0], activeRange[1]).slice();
    const sign = sortDesc ? -1 : 1;
    if (sortKey === CLASS_SORT && classed) {
      out.sort((a, b) => sign * ((classOf!(a) ?? 99) - (classOf!(b) ?? 99)) || a - b);
    } else if (sortColumn) {
      out.sort((a, b) => sign * (sortColumn[a] - sortColumn[b]) || a - b);
    } else if (sortDesc) {
      out.reverse();
    }
    return { events: out, inPopulation: count, all };
    // activeRange is a fresh tuple per render; its two numbers are what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, sourceInfo, wallMask, sortKey, sortDesc, classed, classOf, wallClass, sortColumn, activeRange?.[0], activeRange?.[1]]);
  const histogram = useMemo(() => (sortColumn ? wallHistogram(sortColumn, all) : null), [sortColumn, all]);

  const pick = (eventIndex: number, run: boolean) => {
    // Read the last pick now: the updater runs later, after the ref has moved on to this pick.
    const last = lastPickRef.current;
    setPicked((prev) => {
      const next = new Set(prev);
      if (run && last !== null) {
        const a = events.indexOf(last);
        const b = events.indexOf(eventIndex);
        if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) next.add(events[k]);
        else next.add(eventIndex);
      } else if (next.has(eventIndex)) next.delete(eventIndex);
      else next.add(eventIndex);
      return next;
    });
    lastPickRef.current = eventIndex;
  };
  const pickedOnWall = useMemo(() => {
    if (picked.size === 0) return [];
    const here: number[] = [];
    for (let k = 0; k < events.length; k++) if (picked.has(events[k])) here.push(events[k]);
    return here.sort((a, b) => a - b);
  }, [picked, events]);

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
  // The tiles actually in view (no overscan), as a band on the histogram.
  const inView = ((): [number, number] | null => {
    if (!sortColumn || events.length === 0 || viewport.height === 0) return null;
    const a = Math.min(events.length - 1, Math.max(0, Math.floor(viewport.scrollTop / step)) * columns);
    const b = Math.min(events.length - 1, Math.ceil((viewport.scrollTop + viewport.height) / step) * columns - 1);
    return [sortColumn[events[a]], sortColumn[events[b]]];
  })();

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
    if (event.key === " " && onMakePopulation) {
      const at = Number(target.getAttribute("data-event"));
      if (Number.isInteger(at)) { event.preventDefault(); pick(at, event.shiftKey); }
      return;
    }
    const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : null;
    if (by === null) return;
    event.preventDefault();
    moveFocus(target, by);
  };

  if (!visible) return <div style={{ display: "none" }} />;

  const toggleChannel = (slot: number) => {
    if (!entry || !channels) return;
    onViewChange(entry.id, { display: channels.map((c) => (c.slot === slot ? { ...c, enabled: !c.enabled } : c)), exposure, outline });
  };

  return (
    <section className="gl-tab-panel gl-tab-fill gl-images-tab" aria-label={t("Images")}>
      {!entry || !images ? (
        <div className="gl-empty">{t("No cell images are attached to the viewed file. Attach a .cvw from the Import menu.")}</div>
      ) : (
        <>
          <div className="gl-images-toolbar">
            {populations && populations.length > 0 && onChoosePopulation && (
              <label className="gl-images-control">
                <span>{t("Population")}</span>
                <select value={populationId ?? ""} onChange={(event) => { if (event.target.value) onChoosePopulation(event.target.value); }} aria-label={t("Population")}>
                  {populationId === null && <option value="">{populationLabel}</option>}
                  {populations.map((p) => (
                    <option key={p.id} value={p.id}>{"\u00a0\u00a0".repeat(p.depth)}{p.name}</option>
                  ))}
                </select>
              </label>
            )}
            {excludedMask && parentName && (
              <span className="gl-images-control gl-images-show" role="group" aria-label={t("Show")}>
                <button type="button" className="gl-chip" aria-pressed={!showExcluded} onClick={() => setShowExcluded(false)}>{t("In the population")}</button>
                <button
                  type="button"
                  className="gl-chip"
                  aria-pressed={showExcluded}
                  onClick={() => setShowExcluded(true)}
                  title={t("The cells of {parent} that this population's gate leaves out", { parent: parentName })}
                >
                  {t("Left out by its gate")}
                </button>
              </span>
            )}
            <span className="gl-images-count">
              {t("{count} cells in {population} · {shown} with images", {
                count: inPopulation.toLocaleString(),
                population: wallLabel,
                shown: events.length.toLocaleString(),
              })}
            </span>
            <label className="gl-images-control">
              <span>{t("Sort by")}</span>
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>
                <option value="">{t("Event order")}</option>
                {classed && <option value={CLASS_SORT}>{t("Class")}</option>}
                {entry.sample.channels.map((channel) => (
                  <option key={channel.key} value={channel.key}>{channel.label ?? channel.key}</option>
                ))}
              </select>
              <button type="button" className="gl-mini-btn" aria-pressed={sortDesc} onClick={() => setSortDesc((d) => !d)} title={t("Reverse the order")}>
                {sortDesc ? "↓" : "↑"}
              </button>
            </label>
            {histogram && sortChannel && (
              <span className="gl-images-histogram">
                <WallHistogram
                  histogram={histogram}
                  label={sortLabel}
                  inView={inView}
                  range={activeRange}
                  onRange={(range) => setWallRange(range ? { key: sortKey, lo: range[0], hi: range[1] } : null)}
                />
                {activeRange && (
                  <span className="gl-images-range">
                    {`${formatWallValue(activeRange[0])}–${formatWallValue(activeRange[1])}`}
                    <button type="button" className="gl-mini-btn" onClick={() => setWallRange(null)} title={t("Show every cell again")}>×</button>
                  </span>
                )}
              </span>
            )}
            {classed && (
              <label className="gl-images-control">
                <span>{classTitle ?? t("Class")}</span>
                <select value={wallClass} aria-label={t("Show class")} onChange={(event) => setWallClass(event.target.value)}>
                  <option value="all">{t("all classes")}</option>
                  {classes!.map((c, i) => <option key={c.label} value={String(i)}>{c.label}</option>)}
                </select>
              </label>
            )}
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
                onChange={(event) => { if (channels) onViewChange(entry.id, { display: channels.slice(), exposure: Math.pow(2, Number(event.target.value)), outline }); }}
              />
            </label>
            <label className="gl-images-control gl-images-check" title={t("Outline the objects the count found on the mask image, in magenta")}>
              <input type="checkbox" checked={outline} onChange={(event) => { if (channels) onViewChange(entry.id, { display: channels.slice(), exposure, outline: event.target.checked }); }} />
              <span>{t("Mask outline")}</span>
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
            {onSendToLayout && (
              <label className="gl-images-control gl-images-send">
                <span>{t("Cells")}</span>
                <select value={wallCount} onChange={(event) => setWallCount(Number(event.target.value))} aria-label={t("Cells to send")}>
                  {[12, 24, 48, 96, 192].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button
                  type="button"
                  className="gl-mini-btn"
                  disabled={events.length === 0 || !channels}
                  title={t("Lay the first cells of this wall, in this order, on the Layout tab as one labelled block")}
                  onClick={() => {
                    if (!channels) return;
                    const take = Math.min(wallCount, events.length);
                    const sortChannel = sortKey ? entry.sample.channels.find((c) => c.key === sortKey) : undefined;
                    onSendToLayout({
                      kind: "imagewall",
                      sampleId: entry.id,
                      fileName: entry.name,
                      populationId: populationId ?? "",
                      populationName: wallLabel,
                      events: Array.from(events.subarray(0, take)),
                      imaged: events.length,
                      populationCount: inPopulation,
                      sortKey,
                      sortLabel: sortKey === CLASS_SORT ? (classTitle ?? t("Class")) : sortChannel ? sortChannel.label ?? sortChannel.key : "",
                      sortDesc,
                      display: channels.map((c) => ({ ...c })),
                      exposure,
                      tile: Math.max(24, Math.min(96, Math.round(tileSize * 0.75))),
                      columns: take <= 12 ? 6 : take <= 48 ? 8 : 12,
                      ...(outlineSpec ? { outline: outlineSpec } : {}),
                      ...(activeRange ? { rangeLabel: `${sortLabel} ${formatWallValue(activeRange[0])}–${formatWallValue(activeRange[1])}` } : {}),
                      ...(classed
                        ? {
                            tileColours: Array.from(events.subarray(0, take), (e) => colourOf(e) ?? ""),
                            legend: classes!.map((c) => ({ label: c.label, colour: c.colour })),
                          }
                        : {}),
                    });
                  }}
                >
                  {t("Send to Layout")}
                </button>
              </label>
            )}
            {onMakePopulation && (
              <span
                className="gl-images-control gl-images-picked"
                title={t("Pick cells for a population: Cmd/Ctrl-click a tile, Shift-click a run of tiles, Space on the focused tile")}
              >
                <span>{t("{count} picked", { count: pickedOnWall.length.toLocaleString() })}</span>
                <button
                  type="button"
                  className="gl-mini-btn"
                  disabled={events.length === 0}
                  title={t("Pick every cell now on the wall, within its range and class")}
                  onClick={() => { setPicked((prev) => { const next = new Set(prev); for (let k = 0; k < events.length; k++) next.add(events[k]); return next; }); }}
                >
                  {t("Pick all shown")}
                </button>
                {pickedOnWall.length > 0 && (
                  <>
                    <input
                      type="text"
                      value={setName}
                      placeholder={t("Population name")}
                      aria-label={t("Population name")}
                      onChange={(event) => setSetName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && setName.trim()) { onMakePopulation(pickedOnWall, setName.trim()); setPicked(new Set()); setSetName(""); } }}
                    />
                    <button
                      type="button"
                      className="gl-mini-btn"
                      disabled={!setName.trim()}
                      title={t("A population of the picked cells under {population}, and one of the rest; the picks become a channel of the file saved with the workspace", { population: wallLabel })}
                      onClick={() => { onMakePopulation(pickedOnWall, setName.trim()); setPicked(new Set()); setSetName(""); }}
                    >
                      {t("Make population")}
                    </button>
                    {onFindSimilar && (
                      <button
                        type="button"
                        className="gl-mini-btn"
                        title={t("Sort the wall by likeness to the picked cells over the file's channels: the most alike come first, and a range on the histogram keeps them")}
                        onClick={() => {
                          const key = onFindSimilar(pickedOnWall, setName.trim() || t("picks"));
                          if (!key) return;
                          setSortKey(key);
                          setSortDesc(false);
                          setWallRange(null);
                        }}
                      >
                        {t("Find similar")}
                      </button>
                    )}
                    <button type="button" className="gl-mini-btn" onClick={() => { setPicked(new Set()); lastPickRef.current = null; }} title={t("Pick none")}>×</button>
                  </>
                )}
              </span>
            )}
          </div>
          {classed && (
            <div className="gl-images-legend" aria-label={classTitle ?? t("Class")}>
              {classes!.map((c) => (
                <span key={c.label} className="gl-images-legend-item">
                  <span className="gl-cell-chip" style={{ background: c.colour }} />
                  {c.label}
                </span>
              ))}
            </div>
          )}
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
                    colour={colourOf(eventIndex)}
                    picked={picked.has(eventIndex)}
                    onPick={onMakePopulation ? pick : undefined}
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
