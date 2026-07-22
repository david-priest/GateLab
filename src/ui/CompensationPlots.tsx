import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { DEFAULT_DENSITY_COLOR_POWER } from "../engine/pseudocolor";
import type { CytofInteractionType } from "../engine/compensationMatrixView";
import type {
  CompensationDensityPanel,
  CompensationPairPreview,
} from "../engine/compensationPairPreview";
import {
  buildCompensationGlobalPairPreview,
  compensationDensitySmoothingRadiusForPlot,
  compensationSharedDensityCeiling,
  type CompensationGlobalInspectorDataset,
  type CompensationGlobalPairPreview,
  type CompensationInspectorLayer,
} from "../engine/compensationGlobalInspector";
import { renderCompensationDensityBiplotSurface } from "../plots/compensationDensityPlot";
import { usePersistedTabState } from "./tabState";
import { useI18n } from "./i18n";
import { percentText, significantNumber } from "./compensationUiFormat";

export const DensityColorPowerContext = createContext(DEFAULT_DENSITY_COLOR_POWER);
export const CompensationPointAlphaContext = createContext(0.85);

export interface CompensationChannelDisplay {
  readonly key: string;
  readonly pnn: string;
  readonly label: string;
  readonly combined: string;
}

export interface CompensationMatrixView {
  readonly sourceAxisKeys: readonly string[];
  readonly receiverAxisKeys: readonly string[];
  readonly sourceChannels: readonly CompensationChannelDisplay[];
  readonly receiverChannels: readonly CompensationChannelDisplay[];
  readonly matrix: readonly (readonly number[])[];
  readonly kind: "flow" | "cytof";
  readonly title: string;
  readonly subtitle: string;
  readonly coefficientNote: string;
}

export interface CompensationGlobalPairCandidate {
  readonly sourceIndex: number;
  readonly receiverIndex: number;
  readonly pairKey: string;
  readonly source: CompensationChannelDisplay;
  readonly receiver: CompensationChannelDisplay;
  readonly coefficient: number;
  readonly interaction: CytofInteractionType | null;
  readonly physicalPrior: number;
}

const PAIR_SEPARATOR = "\u001f";

interface QueuedCompensationPlotRender {
  cancelled: boolean;
  readonly run: () => void;
}

const compensationPlotRenderQueue: QueuedCompensationPlotRender[] = [];
let compensationPlotRenderScheduled = false;

/** Keep dual-canvas cache construction cooperative so input events can run between plot pairs. */
function enqueueCompensationPlotRender(run: () => void): () => void {
  const queued: QueuedCompensationPlotRender = { cancelled: false, run };
  compensationPlotRenderQueue.push(queued);
  const scheduleNext = () => {
    if (compensationPlotRenderScheduled) return;
    compensationPlotRenderScheduled = true;
    const flushOne = () => {
      compensationPlotRenderScheduled = false;
      let next = compensationPlotRenderQueue.shift();
      while (next?.cancelled) next = compensationPlotRenderQueue.shift();
      next?.run();
      if (compensationPlotRenderQueue.length > 0) scheduleNext();
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleWindow.requestIdleCallback(flushOne, { timeout: 50 });
    } else if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(flushOne);
    } else {
      setTimeout(flushOne, 0);
    }
  };
  scheduleNext();
  return () => {
    queued.cancelled = true;
  };
}

export function DensityBiplot({
  title,
  panel,
  preview,
  sourceLabel,
  receiverLabel,
  minimumSize = 210,
  maximumSize = 420,
  densityColorCeiling,
  densitySmoothing,
  showZeroPile = true,
}: Readonly<{
  title: string;
  panel: CompensationDensityPanel;
  preview: CompensationPairPreview;
  sourceLabel: string;
  receiverLabel: string;
  minimumSize?: number;
  maximumSize?: number;
  densityColorCeiling?: number;
  densitySmoothing: number;
  showZeroPile?: boolean;
}>) {
  const { t } = useI18n();
  const densityColorPower = useContext(DensityColorPowerContext);
  const pointAlpha = useContext(CompensationPointAlphaContext);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let animationFrame: number | null = null;
    let lastSize = 0;
    const render = () => {
      animationFrame = null;
      const available = container.parentElement?.clientWidth ?? 230;
      const size = Math.max(minimumSize, Math.min(maximumSize, Math.floor(available)));
      if (size === lastSize && container.childElementCount > 0) return;
      lastSize = size;
      const densitySmoothingRadius = compensationDensitySmoothingRadiusForPlot(densitySmoothing, size);
      renderCompensationDensityBiplotSurface(container, {
        title,
        panel,
        preview,
        sourceLabel,
        receiverLabel,
        size,
        densityColorCeiling: densityColorCeiling ?? compensationSharedDensityCeiling(
          preview,
          0.95,
          densitySmoothingRadius,
          densityColorPower,
        ),
        densitySmoothingRadius,
        densityColorPower,
        pointAlpha,
      });
    };
    const schedule = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(render);
    };
    schedule();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    resizeObserver?.observe(container.parentElement ?? container);
    return () => {
      resizeObserver?.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [densityColorCeiling, densityColorPower, densitySmoothing, maximumSize, minimumSize, panel, pointAlpha, preview, receiverLabel, sourceLabel, title]);
  const zeroPercent = (count: number) => preview.eventCount > 0
    ? `${(count / preview.eventCount * 100).toFixed(1)}%`
    : "0.0%";
  const hasZeroPile = panel.zeroPile.source > 0 || panel.zeroPile.receiver > 0 || panel.zeroPile.corner > 0;
  return (
    <figure className="gl-comp-biplot" aria-label={t("{title} density biplot; {source} on x, {receiver} on y", {
      title,
      source: sourceLabel,
      receiver: receiverLabel,
    })}>
      <div ref={containerRef} className="gl-comp-biplot-surface" />
      {showZeroPile && hasZeroPile && (
        <figcaption className="gl-comp-zero-pile">
          {t("Exact zero · source {source} · receiver {receiver} · both {both}", {
            source: zeroPercent(panel.zeroPile.source),
            receiver: zeroPercent(panel.zeroPile.receiver),
            both: zeroPercent(panel.zeroPile.corner),
          })}
        </figcaption>
      )}
    </figure>
  );
}
/**
 * Global-inspector plots retain one canvas per assay layer beneath a single shared SVG frame.
 * The uncompensated/compensated toggle therefore changes only CSS visibility; it never rebuilds
 * density bins, sorts events, or redraws axes while the user is flicking between layers.
 */
export function CachedDensityBiplot({
  title,
  preview,
  sourceLabel,
  receiverLabel,
  minimumSize,
  maximumSize,
  densityColorCeiling,
  densitySmoothing,
}: Readonly<{
  title: string;
  preview: CompensationGlobalPairPreview;
  sourceLabel: string;
  receiverLabel: string;
  minimumSize: number;
  maximumSize: number;
  densityColorCeiling?: number;
  densitySmoothing: number;
}>) {
  const { t } = useI18n();
  const densityColorPower = useContext(DensityColorPowerContext);
  const pointAlpha = useContext(CompensationPointAlphaContext);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelQueuedRender: (() => void) | null = null;
    let lastSize = 0;
    const render = () => {
      cancelQueuedRender = null;
      const available = container.parentElement?.clientWidth ?? minimumSize;
      const size = Math.max(minimumSize, Math.min(maximumSize, Math.floor(available)));
      if (size === lastSize && container.dataset.cacheReady === "true") return;
      lastSize = size;
      container.dataset.cacheReady = "false";
      const densitySmoothingRadius = compensationDensitySmoothingRadiusForPlot(densitySmoothing, size);
      const resolvedDensityColorCeiling = densityColorCeiling ?? compensationSharedDensityCeiling(
        preview,
        0.95,
        densitySmoothingRadius,
        densityColorPower,
      );

      renderCompensationDensityBiplotSurface(container, {
        title,
        panel: preview.original,
        preview,
        sourceLabel,
        receiverLabel,
        size,
        densityColorCeiling: resolvedDensityColorCeiling,
        densitySmoothingRadius,
        densityColorPower,
        pointAlpha,
        canvasScale: 2,
      });
      const originalCanvas = container.querySelector("canvas");
      const sharedFrame = container.querySelector("svg");

      const compensatedHost = document.createElement("div");
      renderCompensationDensityBiplotSurface(compensatedHost, {
        title,
        panel: preview.compensated,
        preview,
        sourceLabel,
        receiverLabel,
        size,
        densityColorCeiling: resolvedDensityColorCeiling,
        densitySmoothingRadius,
        densityColorPower,
        pointAlpha,
        canvasScale: 2,
      });
      const compensatedCanvas = compensatedHost.querySelector("canvas");
      if (!originalCanvas || !compensatedCanvas || !sharedFrame) return;

      originalCanvas.classList.add("gl-comp-cached-canvas", "is-original");
      originalCanvas.dataset.assayLayer = "original";
      compensatedCanvas.classList.add("gl-comp-cached-canvas", "is-compensated");
      compensatedCanvas.dataset.assayLayer = "compensated";
      container.insertBefore(compensatedCanvas, sharedFrame);
      container.dataset.cacheReady = "true";
    };
    const schedule = () => {
      cancelQueuedRender?.();
      cancelQueuedRender = enqueueCompensationPlotRender(render);
    };
    schedule();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedule);
    resizeObserver?.observe(container.parentElement ?? container);
    return () => {
      resizeObserver?.disconnect();
      cancelQueuedRender?.();
    };
  }, [densityColorCeiling, densityColorPower, densitySmoothing, maximumSize, minimumSize, pointAlpha, preview, receiverLabel, sourceLabel, title]);

  return (
    <figure
      className="gl-comp-biplot"
      aria-label={t("Cached uncompensated and compensated density biplot; {source} on x, {receiver} on y", {
        source: sourceLabel,
        receiver: receiverLabel,
      })}
    >
      <div
        ref={containerRef}
        className="gl-comp-biplot-surface gl-comp-cached-biplot"
        data-cache-mode="dual-canvas"
      />
    </figure>
  );
}

export function CompensationPairBiplots({
  preview,
  sourceLabel,
  receiverLabel,
  kind,
  densitySmoothing,
  compact = false,
  compensatedTitle = "Compensated",
}: Readonly<{
  preview: CompensationPairPreview;
  sourceLabel: string;
  receiverLabel: string;
  kind: "flow" | "cytof";
  densitySmoothing: number;
  compact?: boolean;
  compensatedTitle?: string;
}>) {
  const { t } = useI18n();
  const originalReceiverZero = preview.eventCount > 0
    ? preview.original.zeroPile.receiver / preview.eventCount * 100
    : 0;
  const compensatedReceiverZero = preview.eventCount > 0
    ? preview.compensated.zeroPile.receiver / preview.eventCount * 100
    : 0;
  const zeroDelta = compensatedReceiverZero - originalReceiverZero;
  return (
    <div className={`gl-comp-biplot-comparison${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="gl-comp-biplot-note">
          {t("Same {events} events{sampled} · locked axes · off-scale events piled at edges · colour clipped at the 95th percentile of occupied density bins", {
            events: preview.eventCount.toLocaleString(),
            sampled: preview.totalEvents > preview.eventCount
              ? t(" sampled from {total}", { total: preview.totalEvents.toLocaleString() })
              : "",
          })}
        </div>
      )}
      <div className="gl-comp-biplot-panels">
        <DensityBiplot
          title={t("Original")}
          panel={preview.original}
          preview={preview}
          sourceLabel={sourceLabel}
          receiverLabel={receiverLabel}
          densitySmoothing={densitySmoothing}
          showZeroPile={!compact}
        />
        <DensityBiplot
          title={compensatedTitle}
          panel={preview.compensated}
          preview={preview}
          sourceLabel={sourceLabel}
          receiverLabel={receiverLabel}
          densitySmoothing={densitySmoothing}
          showZeroPile={!compact}
        />
      </div>
      {!compact && <div className="gl-comp-diagnostic-note">
        {kind === "cytof" ? (
          <>
            {t("Receiver events at exact zero: {original}% → {compensated}% ({delta} percentage points). A rise can be consistent with NNLS over-subtraction, while a residual source-associated rise can be consistent with under-compensation. Neither is a verdict without a suitable negative/control population.", {
              original: originalReceiverZero.toFixed(1),
              compensated: compensatedReceiverZero.toFixed(1),
              delta: `${zeroDelta >= 0 ? "+" : ""}${zeroDelta.toFixed(1)}`,
            })}
          </>
        ) : (
          <>
            {t("Residual tilt can be consistent with under- or over-compensation, but spreading error and biological co-expression can produce similar shapes. Use the matched Original/{comparison} view as review evidence, not an automatic coefficient call.", {
              comparison: compensatedTitle,
            })}
          </>
        )}
      </div>}
      {!compact && (preview.evidence.status === "ready" ? (
        <dl className="gl-comp-pair-evidence" aria-label={t("Conservative residual evidence")}>
          <div>
            <dt>{t("Receiver-negative shift")}</dt>
            <dd>{t("{value} MAD", { value: significantNumber(preview.evidence.normalizedNegativeShift ?? 0, 3) })}</dd>
          </div>
          <div>
            <dt>{t("Robust residual slope")}</dt>
            <dd>{significantNumber(preview.evidence.residualSlope ?? 0, 4)}</dd>
          </div>
          {preview.evidence.upperTailExcessMad !== null && (
            <div>
              <dt>{t("Upper-tail departure")}</dt>
              <dd>{t("{value} MAD", { value: significantNumber(preview.evidence.upperTailExcessMad, 3) })}</dd>
            </div>
          )}
          {preview.evidence.upperTailSlopeDeltaMad !== null && (
            <div>
              <dt>{t("Tail slope change")}</dt>
              <dd>{t("{value} MAD", { value: significantNumber(preview.evidence.upperTailSlopeDeltaMad, 3) })}</dd>
            </div>
          )}
          <div>
            <dt>{t("Evidence groups")}</dt>
            <dd>{t("{high} source-high · {low} source-low", {
              high: preview.evidence.sourceHighEvents.toLocaleString(),
              low: preview.evidence.sourceLowEvents.toLocaleString(),
            })}</dd>
          </div>
        </dl>
      ) : (
        <div className="gl-comp-evidence-insufficient">
          {t("Residual screening needs distinct source-low/source-high groups and enough receiver-negative events; this pair remains available for visual review.")}
        </div>
      ))}
    </div>
  );
}

export function MiniCompensationMatrix({
  matrixView,
  sourceChannels,
  receiverChannels,
  selectedSourceIndex,
  selectedReceiverIndex,
  stagedCoefficients,
  maximumAbsoluteOffDiagonal,
  onSelect,
}: Readonly<{
  matrixView: CompensationMatrixView;
  sourceChannels: readonly CompensationChannelDisplay[];
  receiverChannels: readonly CompensationChannelDisplay[];
  selectedSourceIndex: number;
  selectedReceiverIndex: number;
  stagedCoefficients: Readonly<Record<string, number>>;
  maximumAbsoluteOffDiagonal: number;
  onSelect: (pairKey: string) => void;
}>) {
  const { t } = useI18n();
  const cellSize = 6;
  const labelLeft = 74;
  const labelTop = 44;
  const labelBottom = 10;
  const matrixWidth = receiverChannels.length * cellSize;
  const matrixHeight = sourceChannels.length * cellSize;
  // A matching right gutter keeps the heatmap body horizontally centred. The bottom does
  // not need to mirror the rotated labels above it; avoiding that empty gutter brings the
  // matrix visibly up beneath its heading.
  const viewWidth = labelLeft + matrixWidth + labelLeft;
  const viewHeight = labelTop + matrixHeight + labelBottom;
  const colouredCells = useMemo(() => {
    const cells: Array<Readonly<{
      sourceIndex: number;
      receiverIndex: number;
      pairKey: string;
      value: number;
      fill: string;
      diagonal: boolean;
    }>> = [];
    for (let sourceIndex = 0; sourceIndex < matrixView.matrix.length; sourceIndex++) {
      for (let receiverIndex = 0; receiverIndex < matrixView.matrix[sourceIndex].length; receiverIndex++) {
        const sourceKey = matrixView.sourceAxisKeys[sourceIndex];
        const receiverKey = matrixView.receiverAxisKeys[receiverIndex];
        const pairKey = `${sourceKey}${PAIR_SEPARATOR}${receiverKey}`;
        const value = stagedCoefficients[pairKey] ?? matrixView.matrix[sourceIndex][receiverIndex];
        const diagonal = sourceKey === receiverKey;
        if (!diagonal && (!Number.isFinite(value) || value === 0)) continue;
        const relativeMagnitude = maximumAbsoluteOffDiagonal > 0 && Number.isFinite(value)
          ? Math.min(1, Math.abs(value) / maximumAbsoluteOffDiagonal)
          : 0;
        const alpha = relativeMagnitude > 0 ? 0.12 + 0.82 * Math.sqrt(relativeMagnitude) : 0;
        cells.push({
          sourceIndex,
          receiverIndex,
          pairKey,
          value,
          diagonal,
          fill: diagonal
            ? "#cfd4db"
            : !Number.isFinite(value)
              ? "#ae3e3e"
              : value < 0
                ? `rgba(47,128,237,${alpha})`
                : `rgba(211,47,47,${alpha})`,
        });
      }
    }
    return cells;
  }, [matrixView, maximumAbsoluteOffDiagonal, stagedCoefficients]);
  const handleSelect = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return;
    const x = (event.clientX - bounds.left) * viewWidth / bounds.width;
    const y = (event.clientY - bounds.top) * viewHeight / bounds.height;
    const receiverIndex = Math.floor((x - labelLeft) / cellSize);
    const sourceIndex = Math.floor((y - labelTop) / cellSize);
    if (
      sourceIndex < 0 || sourceIndex >= sourceChannels.length ||
      receiverIndex < 0 || receiverIndex >= receiverChannels.length ||
      matrixView.sourceAxisKeys[sourceIndex] === matrixView.receiverAxisKeys[receiverIndex]
    ) return;
    onSelect(`${matrixView.sourceAxisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView.receiverAxisKeys[receiverIndex]}`);
  };
  return (
    <section className="gl-comp-mini-matrix" aria-labelledby="comp-mini-matrix-heading">
      <div className="gl-comp-mini-matrix-head">
        <strong id="comp-mini-matrix-heading">{t("Matrix map")}</strong>
        <span>{t("Source ↓ · receiver → · click a cell")}</span>
      </div>
      <svg
        width={viewWidth}
        height={viewHeight}
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        role="img"
        aria-label={t("Mini compensation matrix with {sources} source rows and {receivers} receiver columns", {
          sources: sourceChannels.length,
          receivers: receiverChannels.length,
        })}
        onPointerDown={handleSelect}
      >
        <rect x={labelLeft} y={labelTop} width={matrixWidth} height={matrixHeight} fill="#f8fafc" stroke="#aeb8c6" strokeWidth="0.7" />
        {receiverChannels.map((channel, receiverIndex) => (
          <text
            key={channel.key}
            x={labelLeft + (receiverIndex + 0.55) * cellSize}
            y={labelTop - 3}
            transform={`rotate(-58 ${labelLeft + (receiverIndex + 0.55) * cellSize} ${labelTop - 3})`}
            textAnchor="start"
            className={receiverIndex === selectedReceiverIndex ? "is-selected" : undefined}
          >
            {channel.pnn}
          </text>
        ))}
        {sourceChannels.map((channel, sourceIndex) => (
          <text
            key={channel.key}
            x={labelLeft - 3}
            y={labelTop + (sourceIndex + 0.72) * cellSize}
            textAnchor="end"
            className={sourceIndex === selectedSourceIndex ? "is-selected" : undefined}
          >
            {channel.pnn}
          </text>
        ))}
        <rect
          x={labelLeft}
          y={labelTop + selectedSourceIndex * cellSize}
          width={matrixWidth}
          height={cellSize}
          fill="rgba(47,128,237,0.08)"
          pointerEvents="none"
        />
        <rect
          x={labelLeft + selectedReceiverIndex * cellSize}
          y={labelTop}
          width={cellSize}
          height={matrixHeight}
          fill="rgba(47,128,237,0.08)"
          pointerEvents="none"
        />
        {colouredCells.map((cell) => (
          <rect
            key={cell.pairKey}
            x={labelLeft + cell.receiverIndex * cellSize}
            y={labelTop + cell.sourceIndex * cellSize}
            width={cellSize}
            height={cellSize}
            fill={cell.fill}
            pointerEvents="none"
          >
            <title>
              {cell.diagonal
                ? t("{channel} · self", { channel: sourceChannels[cell.sourceIndex].combined })
                : `${sourceChannels[cell.sourceIndex].combined} → ${receiverChannels[cell.receiverIndex].combined} · ${percentText(cell.value)}`}
            </title>
          </rect>
        ))}
        <rect
          x={labelLeft + selectedReceiverIndex * cellSize}
          y={labelTop + selectedSourceIndex * cellSize}
          width={cellSize}
          height={cellSize}
          fill="none"
          stroke="#2f80ed"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      </svg>
    </section>
  );
}

export function GlobalCompensationPlotTile({
  dataset,
  pair,
  plotSize,
  densitySmoothing,
  flagged,
  selected,
  onSelect,
  onFlag,
}: Readonly<{
  dataset: CompensationGlobalInspectorDataset;
  pair: CompensationGlobalPairCandidate;
  plotSize: number;
  densitySmoothing: number;
  flagged: boolean;
  selected: boolean;
  onSelect: () => void;
  onFlag: (flagged: boolean) => void;
}>) {
  const { t } = useI18n();
  const tileRef = useRef<HTMLElement>(null);
  const [renderPlot, setRenderPlot] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const tile = tileRef.current;
    if (!tile || typeof IntersectionObserver === "undefined") {
      setRenderPlot(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setRenderPlot(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "450px 0px" },
    );
    observer.observe(tile);
    return () => observer.disconnect();
  }, []);
  const pairPreview = useMemo(
    () => renderPlot
      ? buildCompensationGlobalPairPreview(dataset, pair.source.key, pair.receiver.key)
      : null,
    [dataset, pair.receiver.key, pair.source.key, renderPlot],
  );
  const preview = pairPreview?.ready ? pairPreview.preview : null;
  return (
    <article
      ref={tileRef}
      className={`gl-comp-global-tile${selected ? " is-selected" : ""}${flagged ? " is-flagged" : ""}`}
      data-pair-key={pair.pairKey}
      data-event-signature={preview?.eventSignature}
      data-x-range={preview ? `${preview.xRange[0]},${preview.xRange[1]}` : undefined}
      data-y-range={preview ? `${preview.yRange[0]},${preview.yRange[1]}` : undefined}
      style={{ width: plotSize, height: plotSize }}
    >
      <div className="gl-comp-global-tile-head">
        <button
          type="button"
          onClick={onSelect}
          title={`${pair.source.combined} → ${pair.receiver.combined}`}
          aria-label={t("Open details for {source} to {receiver}", {
            source: pair.source.label,
            receiver: pair.receiver.label,
          })}
        >
          <span>{pair.source.label} → {pair.receiver.label}</span>
          <strong>{(pair.coefficient * 100).toFixed(1)}%</strong>
        </button>
        <label title={t("Keep this pair in Flagged")}>
          <input
            type="checkbox"
            checked={flagged}
            aria-label={t("Flag global inspector pair {source} to {receiver} for follow-up", {
              source: pair.source.label,
              receiver: pair.receiver.label,
            })}
            onChange={(event) => onFlag(event.currentTarget.checked)}
          />
        </label>
      </div>
      <button
        type="button"
        className="gl-comp-global-plot-button"
        onClick={onSelect}
        title={t("{source} → {receiver} · {interaction}matrix {coefficient}%", {
          source: pair.source.combined,
          receiver: pair.receiver.combined,
          interaction: pair.interaction && pair.interaction !== "other" ? `${pair.interaction} · ` : "",
          coefficient: (pair.coefficient * 100).toFixed(1),
        })}
        aria-label={t("Open details for {source} to {receiver}; matrix coefficient {coefficient}%", {
          source: pair.source.label,
          receiver: pair.receiver.label,
          coefficient: (pair.coefficient * 100).toFixed(1),
        })}
      >
        <div className="gl-comp-global-plot" style={{ width: plotSize, height: plotSize }}>
          {preview ? (
            <CachedDensityBiplot
              title=""
              preview={preview}
              sourceLabel={pair.source.label}
              receiverLabel={pair.receiver.label}
              minimumSize={plotSize}
              maximumSize={plotSize}
              densitySmoothing={densitySmoothing}
            />
          ) : pairPreview && !pairPreview.ready ? (
            <span>{pairPreview.reason}</span>
          ) : (
            <span aria-hidden="true" />
          )}
        </div>
      </button>
    </article>
  );
}

/**
 * Own the rapid assay flip below the large CompensationTab state boundary. The plot gallery is
 * passed as an unchanged React node, so toggling updates one ancestor attribute and this button;
 * no tile component, canvas cache, density preview, or renderer effect is revisited.
 */
export function GlobalInspectorLayerScope({
  stateKey,
  header,
  children,
}: Readonly<{
  stateKey: string;
  header: ReactNode;
  children: ReactNode;
}>) {
  const { t } = useI18n();
  const [layer, setLayer] = usePersistedTabState<CompensationInspectorLayer>(
    `compensation.${stateKey}.globalInspectorLayer`,
    "compensated",
  );
  return (
    <section
      className="gl-comp-global-inspector"
      aria-labelledby="comp-global-inspector-heading"
      data-inspector-layer={layer}
    >
      <div className="gl-comp-global-head">
        {header}
        <button
          type="button"
          className="gl-comp-layer-toggle"
          aria-pressed={layer === "compensated"}
          aria-label={t("Showing {shown} data; click to show {other} data", {
            shown: t(layer === "original" ? "uncompensated" : "compensated"),
            other: t(layer === "original" ? "compensated" : "uncompensated"),
          })}
          title={t("Toggle every plot between uncompensated and compensated data without changing its frame")}
          onClick={() => setLayer((current) => current === "original" ? "compensated" : "original")}
        >
          <span className="gl-comp-layer-toggle-track" aria-hidden="true"><i /></span>
          <span>{t(layer === "original" ? "Uncompensated" : "Compensated")}</span>
        </button>
      </div>
      {children}
    </section>
  );
}
