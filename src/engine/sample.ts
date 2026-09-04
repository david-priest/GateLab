// sample.ts — a loaded FCS wrapped with its per-channel display transforms and the
// raw / gating / display coordinate spaces GateLabR uses.
//
// GateLabR distinction (fcs_import.R + app.R is_flow_display_context):
//   • DISPLAY space — what the plot shows (logicle / arcsinh). Gates are DRAWN here.
//   • GATING space  — where masks are computed and gates are STORED. For FLOW this is
//     RAW FCS values (so polygon edges are straight in raw space, invariant to logicle
//     params); for CyTOF it equals the display asinh space (no separate raw display).
// Masking in the wrong space would bend polygon edges and change counts, so this class
// keeps them separate and exposes gating↔display vertex conversion.

import type { FcsFile, NumericColumn } from "./fcs";
import type { AssayData, GateAssayData } from "./gates";
import type { Gate, GateSpace, GateTransforms, TransformSpec } from "./models";
import { resolveChannels, type ResolvedChannel } from "./channels";
import { biexTransform, wspLogTransform } from "./biex";
import type { MatrixChannelBinding } from "./compensationCompatibility";
import type {
  PersistedCompensatedLayerBinding,
  PersistedTransformBinding,
} from "./workspaceCompensation";
import { encodeFloat32Base64, encodeUint8Base64 } from "./encode";
import { robustAxisRange } from "./axisRange";
import { DEFAULT_DENSITY_COLOR_POWER } from "./pseudocolor";
import type { ChannelScales } from "./channelScales";
import { logicleTicks, scatterTicks, linearScatterTicks, type AxisTicks } from "./ticks";
import {
  extractDisplaySpillover,
  type DisplaySpillover,
} from "./compensation";
import {
  DEFAULT_FLOW_SOLVER_SETTINGS,
  FlowCompensationError,
  solveFlowCompensation,
} from "./flowCompensationEngine";
import {
  Logicle,
  isCytofRawChannel,
  isQcChannel,
  isScatterChannel,
  estimateLogicleParams,
} from "./transforms";

/** Anything carrying a gate's coordinate-space identity — a Gate satisfies this structurally. */
export interface GateSpaceRef {
  space?: GateSpace;
  transforms?: GateTransforms;
}

export interface ChannelTransform {
  kind: "logicle" | "asinh" | "identity";
  forward(v: number): number; // raw → display
  inverse(v: number): number; // display → raw
}

/**
 * DEFAULT cofactor for arcsinh-displayed FLOW FLUORESCENCE channels.
 *
 * 150 is GateLabR's own value (fcs_import.R:862). It is only a starting point: the cofactor is
 * the sole thing that distinguishes arcsinh from a log axis, because it sets where the linear
 * region around zero gives way to log behaviour. At 150 on data reaching 10M nearly the whole
 * axis is already log, which is why such a plot looks much like the logicle it replaced.
 * Raising the cofactor widens the linear region and packs the near-zero noise into a tighter
 * band; lowering it blows that noise out across the plot. Hence the per-channel control.
 */
export const FLUOR_ARCSINH_COFACTOR = 150;

const IDENTITY: ChannelTransform = { kind: "identity", forward: (v) => v, inverse: (v) => v };
function asinhTransform(cf: number): ChannelTransform {
  return { kind: "asinh", forward: (v) => Math.asinh(v / cf), inverse: (v) => cf * Math.sinh(v) };
}

/**
 * Rebuild a display transform from a serialised spec.
 *
 * A display-space gate carries the transform it was drawn under, so its membership must be
 * computable from the gate alone — never from whatever the sample is currently showing. That is
 * the whole difference between a stable Gating-ML gate and a FlowJo one.
 */
export function transformFromSpec(spec: TransformSpec): ChannelTransform {
  if (spec.kind === "identity") return IDENTITY;
  if (spec.kind === "asinh") return asinhTransform(spec.cofactor);
  if (spec.kind === "biex") {
    const t = biexTransform(spec);
    return { kind: "asinh", forward: t.forward, inverse: t.inverse };
  }
  if (spec.kind === "wsplog") {
    const t = wspLogTransform(spec);
    return { kind: "asinh", forward: t.forward, inverse: t.inverse };
  }
  const lg = new Logicle(spec.T, spec.W, spec.M, spec.A);
  const fallback = asinhTransform(150);
  return {
    kind: "logicle",
    forward: (v) => {
      const x = lg.scale(v);
      return x === -1 || !Number.isFinite(x) ? fallback.forward(v) : x;
    },
    inverse: (v) => lg.inverse(v),
  };
}

type ScatterRole = "forward" | "side" | "other";

/** Classify a resolved flow channel by its original parameter name first. */
function scatterRole(channel: ResolvedChannel): ScatterRole | null {
  const names = [channel.pnn, channel.key];
  if (!names.some((name) => isScatterChannel(name))) return null;
  if (names.some((name) => /^(?:FSC|FS(?:[\s\-_]|$))/i.test(name))) return "forward";
  if (names.some((name) => /^(?:SSC|SS(?:[\s\-_]|$))/i.test(name))) return "side";
  return "other";
}

/** Area/integral scatter is the conventional overview view; height/width are fallbacks. */
function scatterPreference(channel: ResolvedChannel): number {
  const names = [channel.pnn, channel.key];
  if (names.some((name) => /(?:^|[\s._-])A(?:$|[\s.)_-])|AREA|INT(?:EGRAL)?/i.test(name))) return 0;
  if (names.some((name) => /(?:^|[\s._-])H(?:$|[\s.)_-])|HEIGHT/i.test(name))) return 1;
  if (names.some((name) => /(?:^|[\s._-])W(?:$|[\s.)_-])|WIDTH/i.test(name))) return 2;
  return 3;
}

export type DisplayMode = "pseudocolor" | "dots" | "contour";

/** Max points drawn per plot; more are downsampled for speed (gating uses all events). */
export const PLOT_CAP = 50000;

export interface ScatterPayload {
  x_b64: string;
  y_b64: string;
  x_label: string;
  y_label: string;
  x_range: [number, number];
  /** Display-transform identity per axis; see scatterPayload. Absent on older payloads. */
  x_binding?: string;
  y_binding?: string;
  y_range: [number, number];
  display_mode: DisplayMode;
  point_alpha: number;
  /** Density-to-palette exponent for pseudocolour rendering. */
  density_color_power: number;
  /** Outer contour threshold as % of peak density (contour mode). */
  contour_threshold: number;
  n_events: number;
  gates: unknown[];
  selected_gate_id?: string | null;
  /** All channel keys, for the axis-label channel picker built into cytof_plot.js. */
  channels: string[];
  // Logicle/scatter axis ticks (null → cytof_plot.js uses D3 default linear ticks).
  x_is_logicle: boolean;
  y_is_logicle: boolean;
  x_logicle_ticks: AxisTicks | null;
  y_logicle_ticks: AxisTicks | null;
  // Colour-by-factor overlay (population / metadata / division): per-plotted-point palette index.
  overlay_mode?: boolean;
  color_b64?: string;
  color_palette?: string[];
  color_labels?: string[];
}

/** Per-event palette index (length = nEvents) + the palette/labels it indexes, for the colour overlay. */
export interface OverlaySpec {
  colors: Uint8Array;
  palette: string[];
  labels: string[];
}

/**
 * Where the active spillover matrix came from.
 *
 * An FCS-embedded matrix and one supplied from outside the file compensate identically, but they
 * are not interchangeable as provenance: only the embedded one can be re-derived from the file,
 * so an external matrix has to be recorded wherever the compensation state is written down.
 */
export type SpilloverOrigin =
  | { kind: "fcs" }
  | {
      kind: "external";
      label: string;
      droppedChannels: readonly string[];
      /** True when this replaced a matrix the file itself carried. */
      replacedEmbedded: boolean;
      /** Largest absolute coefficient difference from the replaced matrix, if there was one. */
      maxDeviationFromEmbedded: number | null;
    };

/**
 * Largest absolute difference between two matrices over the channels they share.
 *
 * Used to say how far apart an external matrix and the file's own one are. Channels present in
 * only one of them are ignored: the question is whether the shared coefficients agree.
 */
export function maxCoefficientDelta(a: DisplaySpillover, b: DisplaySpillover): number {
  const ai = new Map(a.channels.map((c, i) => [c, i]));
  const bi = new Map(b.channels.map((c, i) => [c, i]));
  let worst = 0;
  for (const r of a.channels) {
    for (const c of a.channels) {
      if (!bi.has(r) || !bi.has(c)) continue;
      const x = a.matrix[ai.get(r)!][ai.get(c)!];
      const y = b.matrix[bi.get(r)!][bi.get(c)!];
      if (Number.isFinite(x) && Number.isFinite(y)) worst = Math.max(worst, Math.abs(x - y));
    }
  }
  return worst;
}

export interface SampleOpts {
  /** CyTOF arcsinh cofactor (default 5). */
  cytofCofactor?: number;
  /**
   * Workspace-wide owner of display scales. When supplied, logicle W and the scatter scale are
   * read from and written to it, so every file drawn together shares one transform per channel
   * — including files loaded after the setting was made. Omitted in unit tests and any
   * single-sample use, where the per-sample fallbacks below behave exactly as before.
   */
  channelScales?: ChannelScales;
}

/** Axis and picker naming: the marker alone, or the marker with its detector. */
export type ChannelLabelMode = "marker" | "channel-marker";

export type AssayLayer = "original" | "compensated";

/** One derived output column, identified only by exact FCS identity. */
export interface CompensatedLayerColumn {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  /** Apply workers transfer ownership of these arrays to Sample after a complete solve. */
  readonly values: Float32Array;
}

export interface CompensatedLayerInput {
  readonly metadata: PersistedCompensatedLayerBinding;
  readonly columns: readonly CompensatedLayerColumn[];
}

export interface PrepareCompensatedLayerOptions {
  readonly activeLayer?: AssayLayer;
}

export interface BeginCompensatedLayerStagingOptions extends PrepareCompensatedLayerOptions {
  /** Parallel workers may complete disjoint event ranges out of order. */
  readonly allowOutOfOrderChunks?: boolean;
}

export interface CompensatedLayerOutputBinding {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  /** Source index in the worker's effective square solve (adapted for CyTOF). */
  readonly matrixSourceIndex: number;
}

export interface CompensatedLayerStagingIdentity {
  readonly jobId: string;
  readonly jobToken: string;
  readonly bindingKey: string;
}

const COMPENSATED_LAYER_STAGING: unique symbol = Symbol(
  "GateLab.CompensatedLayerStaging",
);

/** Opaque private-output transaction used while verified worker chunks are copied into Sample. */
export type CompensatedLayerStaging = Readonly<{
  readonly [COMPENSATED_LAYER_STAGING]: true;
}>;

export interface CompensatedLayerStagingChunk extends CompensatedLayerStagingIdentity {
  readonly startEvent: number;
  readonly outputBindings: readonly CompensatedLayerOutputBinding[];
  readonly columns: readonly Float32Array[];
}

const PREPARED_COMPENSATED_LAYER: unique symbol = Symbol(
  "GateLab.PreparedCompensatedLayer",
);

/** Opaque, single-use result of complete Sample-side validation. */
export type PreparedCompensatedLayer = Readonly<{
  readonly [PREPARED_COMPENSATED_LAYER]: true;
}>;

export type ProfileCompensatedLayerMetadata = Readonly<
  PersistedCompensatedLayerBinding & { readonly runtimeIdentity: "profile" }
>;

/**
 * Compatibility state for today's synchronous embedded-$SPILLOVER toggle.
 * It is intentionally not given invented profile/matrix hashes: the canonical
 * SHA-256 boundary is asynchronous and belongs to imported/versioned profiles.
 */
export interface LegacyEmbeddedCompensatedLayerMetadata {
  readonly runtimeIdentity: "legacy-embedded-fcs";
  readonly kind: "flow-spillover";
  readonly method: "matrix-inverse";
  readonly includedPnns: readonly string[];
  readonly channelBindings: readonly MatrixChannelBinding[];
  readonly transformBinding: Readonly<{ kind: "flow-linear" }>;
}

export type CompensatedLayerMetadata =
  | ProfileCompensatedLayerMetadata
  | LegacyEmbeddedCompensatedLayerMetadata;

export type CompensatedLayerStaleReason =
  | "sample-kind-mismatch"
  | "legacy-layer-unverifiable"
  | "profile-id-mismatch"
  | "profile-hash-mismatch"
  | "matrix-hash-mismatch"
  | "kind-mismatch"
  | "method-mismatch"
  | "included-pnns-mismatch"
  | "channel-bindings-mismatch"
  | "transform-binding-mismatch";

export type CompensatedLayerStatus =
  | Readonly<{ state: "missing" }>
  | Readonly<{
      state: "stale";
      metadata: CompensatedLayerMetadata;
      reasons: readonly CompensatedLayerStaleReason[];
    }>
  | Readonly<{ state: "ready"; metadata: CompensatedLayerMetadata }>;

interface RuntimeCompensatedLayer {
  readonly metadata: CompensatedLayerMetadata;
  readonly columnsByFcsIndex: ReadonlyMap<number, Float32Array>;
}

interface AssayPreparationContext {
  readonly sample: Sample;
  readonly fcs: FcsFile;
  readonly eventCount: number;
  readonly dataRevision: number;
  readonly layerRevision: number;
  readonly activeLayer: AssayLayer;
  readonly compensatedLayer: RuntimeCompensatedLayer | null;
  readonly instrumentMode: "auto" | "flow" | "cytof";
  readonly instrument: "flow" | "cytof";
  readonly cytofCofactor: number;
  readonly displayTransformContextKey: string;
}

interface CompensatedLayerStagingRecord {
  readonly sample: Sample;
  readonly context: AssayPreparationContext;
  readonly jobId: string;
  readonly jobToken: string;
  readonly bindingKey: string;
  readonly outputBindings: readonly CompensatedLayerOutputBinding[];
  readonly eventCount: number;
  readonly compensatedLayer: RuntimeCompensatedLayer;
  readonly activeLayer: AssayLayer;
  readonly allowOutOfOrderChunks: boolean;
  readonly writtenRanges: Array<readonly [number, number]>;
  processedEvents: number;
}

interface PreparedCompensatedLayerRecord {
  readonly sample: Sample;
  readonly context: AssayPreparationContext;
  readonly compensatedLayer: RuntimeCompensatedLayer;
  readonly activeLayer: AssayLayer;
}

interface AssayLayerChange {
  readonly sample: Sample;
  readonly compensatedLayer: RuntimeCompensatedLayer | null;
  readonly activeLayer: AssayLayer;
  readonly activeDataChanged: boolean;
  readonly layerChanged: boolean;
}

const compensatedLayerStagings = new WeakMap<
  CompensatedLayerStaging,
  CompensatedLayerStagingRecord
>();
const preparedCompensatedLayers = new WeakMap<
  PreparedCompensatedLayer,
  PreparedCompensatedLayerRecord
>();

const MISSING_COMPENSATED_LAYER = Object.freeze({ state: "missing" }) as CompensatedLayerStatus;

function normalizePnn(value: string): string {
  return value.trim().normalize("NFC");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameChannelBindings(
  left: readonly MatrixChannelBinding[],
  right: readonly MatrixChannelBinding[],
): boolean {
  return left.length === right.length && left.every((binding, index) => {
    const candidate = right[index];
    return binding.pnn === candidate.pnn &&
      binding.fcsColumnIndex === candidate.fcsColumnIndex &&
      binding.matrixSourceIndex === candidate.matrixSourceIndex &&
      binding.matrixReceiverIndex === candidate.matrixReceiverIndex &&
      binding.included === candidate.included;
  });
}

function sameTransformBinding(
  left: PersistedTransformBinding,
  right: PersistedTransformBinding,
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "flow-linear" ||
    (right.kind === "cytof-asinh" && left.cofactor === right.cofactor);
}

function freezeChannelBindings(
  bindings: readonly MatrixChannelBinding[],
): readonly MatrixChannelBinding[] {
  return Object.freeze(bindings.map((binding) => Object.freeze({ ...binding })));
}

function freezeTransformBinding(
  binding: PersistedTransformBinding,
): PersistedTransformBinding {
  return binding.kind === "flow-linear"
    ? Object.freeze({ kind: "flow-linear" })
    : Object.freeze({ kind: "cytof-asinh", cofactor: binding.cofactor });
}

export class Sample {
  readonly fcs: FcsFile;
  /** Auto-detected instrument (from channel names). The effective value can be overridden. */
  readonly detectedInstrument: "flow" | "cytof";
  private _instrumentMode: "auto" | "flow" | "cytof" = "auto";
  /** Effective instrument: the manual override if set, else the auto-detected value. */
  get instrument(): "flow" | "cytof" {
    return this._instrumentMode === "auto" ? this.detectedInstrument : this._instrumentMode;
  }
  get instrumentMode(): "auto" | "flow" | "cytof" {
    return this._instrumentMode;
  }
  /** "raw" for flow (gates stored/masked in raw space), "display" for CyTOF. */
  get gatingSpace(): "raw" | "display" {
    return this.instrument === "flow" ? "raw" : "display";
  }

  // Transforms are built lazily per channel: a logicle transform sorts the full
  // column, so eagerly building all of them is O(nChannels · n·log n) — pathological
  // for wide spectral panels (100s of channels). Only displayed channels get built.
  private cytofCofactor: number;
  /** User-set flow-scatter cofactors, keyed by resolved channel index. */
  private readonly scatterCofactorOverride = new Map<number, number>();
  private readonly transformCache = new Map<number, ChannelTransform>();
  private readonly pinnedCache = new Map<string, NumericColumn>();
  private readonly byName = new Map<string, number>();
  private readonly displayCache = new Map<number, Float32Array>();
  private readonly gatingCache = new Map<number, Float32Array>();
  /** Kept/renamed channels (spectral raw detectors filtered out for flow). */
  readonly channels: ResolvedChannel[];
  private _spillover: DisplaySpillover | null;
  private _spilloverOrigin: SpilloverOrigin = { kind: "fcs" };

  /** Spillover mapped to display-named fluorochrome channels (null when none is available). */
  get spillover(): DisplaySpillover | null {
    return this._spillover;
  }

  /** Where the active matrix came from. Exports and the UI must be able to tell them apart. */
  get spilloverOrigin(): SpilloverOrigin {
    return this._spilloverOrigin;
  }

  constructor(fcs: FcsFile, opts: SampleOpts = {}) {
    this.fcs = fcs;
    this.detectedInstrument = fcs.instrument;
    this.cytofCofactor = opts.cytofCofactor ?? 5;
    this.channels = resolveChannels(fcs);
    this.channels.forEach((c, i) => this.byName.set(c.key, i));
    const pnnToKey = new Map<string, string>();
    for (const c of this.channels) pnnToKey.set(c.pnn, c.key);
    this._spillover = extractDisplaySpillover(
      fcs.spillover,
      (pnn) => pnnToKey.get(pnn) ?? null,
      isScatterChannel,
      isQcChannel,
    );
  }

  // ── Compensation ────────────────────────────────────────────────────────────
  private _activeLayer: AssayLayer = "original";
  private _dataRevision = 0;
  private _layerRevision = 0;
  private compensatedLayer: RuntimeCompensatedLayer | null = null;
  private readonly dataRevisionListeners = new Set<() => void>();
  private readonly layerRevisionListeners = new Set<() => void>();

  /** The active linear-count layer used by display, gating, statistics, and plots. */
  get activeLayer(): AssayLayer {
    return this._activeLayer;
  }

  /** Stable identity for display-space annotations derived from the active assay. */
  get activeAssayBindingKey(): string {
    if (this._activeLayer === "original") return "original";
    const metadata = this.compensatedLayer?.metadata;
    if (!metadata) return "compensated:unavailable";
    return metadata.runtimeIdentity === "profile"
      ? `compensated:profile:${metadata.profileHash}`
      : "compensated:legacy-embedded-fcs";
  }

  /**
   * Exact display-coordinate context shared by per-channel plot ranges.
   *
   * Unlike `displayCoordinateBindingKey`, this deliberately avoids constructing
   * every channel transform (which can sort an entire signal column). For this Sample,
   * it contains every setting that can change those transforms, plus the active assay
   * identity, so UI state fitted in one context is never silently reused in another.
   */
  get displayTransformContextKey(): string {
    const orderedOverrides = (source: ReadonlyMap<number, number>) =>
      [...source.entries()]
        .map(([index, value]) => [this.channels[index]?.key ?? `#${index}`, value] as const)
        .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([
      this.activeAssayBindingKey,
      this.instrument,
      this.instrument === "cytof" ? this.cytofCofactor : null,
      this.instrument === "flow" ? orderedOverrides(this.wOverride) : [],
      this.instrument === "flow" ? orderedOverrides(this.scatterCofactorOverride) : [],
      // Shared settings, and the generation of the participant roster. An explicit change
      // re-keys only the channels it touched; the roster moves only when a file is added or
      // removed, which is the only time the shared auto estimate can change. Keeping this
      // precise matters because compensation staging keys off this same identity.
      this.channelScales
        ? [
            this.channelScales.identityFor(
              this.workspaceScaleContextKey,
              this.channels.map((channel) => channel.key),
            ),
            this.channelScales.rosterVersion,
          ]
        : [],
      // Linear scatter changes a channel's transform to identity, so it belongs here for
      // the same reason the cofactor does. Omitting it let the plot reuse display
      // coordinates computed under arcsinh while the gate outline, which is transformed
      // live from raw space, moved to the new scale — the gate appeared to jump off its
      // own events while the event count stayed correct.
      this.instrument === "flow" ? [...this.scatterLinear].map((i) => this.channels[i]?.key ?? `#${i}`).sort() : [],
      // Same reasoning for the fluorescence arcsinh choice: it swaps logicle for asinh, so
      // display coordinates computed under the old transform must not be reused.
      this.instrument === "flow" ? [...this.fluorArcsinh].map((i) => this.channels[i]?.key ?? `#${i}`).sort() : [],
    ]);
  }

  /**
   * Workspace-wide axis ranges are shared across files in the same assay family.
   *
   * Individual FCS files can have different automatically estimated transform
   * parameters, but selecting a different file must not swap the user's axis frame.
   * Original and compensated measurements remain separate because their coordinates
   * are not interchangeable.
   */
  get workspaceScaleContextKey(): string {
    return JSON.stringify([
      this.activeLayer,
      this.instrument,
    ]);
  }

  /** Exact active assay + display-transform identity for one channel's annotations. */
  displayCoordinateBindingKey(channelKey: string): string {
    const idx = this.byName.get(channelKey);
    if (idx === undefined) throw new Error(`Unknown channel '${channelKey}'.`);
    const channel = this.channels[idx];
    const transform = this.transform(idx);
    let transformBinding: readonly unknown[];
    if (transform.kind === "identity") {
      transformBinding = ["identity"];
    } else if (this.instrument === "cytof") {
      transformBinding = ["asinh", this.cytofCofactor];
    } else if (isScatterChannel(channel.pnn) || isScatterChannel(channel.key)) {
      transformBinding = ["asinh", this.currentScatterCofactor(idx)];
    } else if (transform.kind === "logicle") {
      transformBinding = ["logicle", this.logicleT(idx), this.currentLogicleW(idx)];
    } else {
      transformBinding = ["asinh-fallback", this.currentFluorCofactor(idx)];
    }
    return JSON.stringify([
      this.activeAssayBindingKey,
      this.instrument,
      channel.pnn,
      channel.columnIndex,
      transformBinding,
    ]);
  }

  /** Monotonic identity for changes to values/coordinates read from the active assay. */
  get dataRevision(): number {
    return this._dataRevision;
  }

  /** Observe active-data revisions without exposing mutable Sample internals. */
  subscribeDataRevision(listener: () => void): () => void {
    this.dataRevisionListeners.add(listener);
    return () => this.dataRevisionListeners.delete(listener);
  }

  /** Monotonic identity for installed-layer, readiness, or active-layer state changes. */
  get layerRevision(): number {
    return this._layerRevision;
  }

  /** Observe compensation-layer/status revisions without invalidating analytical consumers. */
  subscribeLayerRevision(listener: () => void): () => void {
    this.layerRevisionListeners.add(listener);
    return () => this.layerRevisionListeners.delete(listener);
  }

  /** True when a (non-identity) spillover is available to apply, from the file or otherwise. */
  get hasCompensation(): boolean {
    return this.spillover !== null;
  }

  /** Backward-compatible UI bridge; explicit consumers should use activeLayer/status. */
  get compensationEnabled(): boolean {
    return this._activeLayer === "compensated";
  }

  /** Metadata for the active Compensated layer, or null while Original is active. */
  get activeCompensatedLayerMetadata(): CompensatedLayerMetadata | null {
    return this._activeLayer === "compensated"
      ? this.compensatedLayer?.metadata ?? null
      : null;
  }

  /** True only for the legacy embedded-FCS layer understood by current Gating-ML I/O. */
  get embeddedCompensationEnabled(): boolean {
    return this.activeCompensatedLayerMetadata?.runtimeIdentity === "legacy-embedded-fcs";
  }

  /**
   * Describe the installed layer and, when supplied, verify it is the exact
   * persisted profile binding the caller expects. A legacy embedded layer is
   * usable by the existing toggle but cannot impersonate a hashed profile.
   */
  compensatedLayerStatus(
    expected?: PersistedCompensatedLayerBinding,
  ): CompensatedLayerStatus {
    const layer = this.compensatedLayer;
    if (!layer) return MISSING_COMPENSATED_LAYER;

    const reasons: CompensatedLayerStaleReason[] = [];
    const metadata = layer.metadata;
    const expectedInstrument = metadata.kind === "flow-spillover" ? "flow" : "cytof";
    if (this.instrument !== expectedInstrument) reasons.push("sample-kind-mismatch");
    if (
      metadata.transformBinding.kind === "cytof-asinh" &&
      metadata.transformBinding.cofactor !== this.cytofCofactor
    ) {
      reasons.push("transform-binding-mismatch");
    }

    if (expected) {
      if (metadata.runtimeIdentity === "legacy-embedded-fcs") {
        reasons.push("legacy-layer-unverifiable");
      } else {
        if (metadata.profileId !== expected.profileId) reasons.push("profile-id-mismatch");
        if (metadata.profileHash !== expected.profileHash) reasons.push("profile-hash-mismatch");
        if (metadata.matrixHash !== expected.matrixHash) reasons.push("matrix-hash-mismatch");
        if (metadata.kind !== expected.kind) reasons.push("kind-mismatch");
        if (metadata.method !== expected.method) reasons.push("method-mismatch");
        if (!sameStrings(metadata.includedPnns, expected.includedPnns)) {
          reasons.push("included-pnns-mismatch");
        }
        if (!sameChannelBindings(metadata.channelBindings, expected.channelBindings)) {
          reasons.push("channel-bindings-mismatch");
        }
        if (!sameTransformBinding(metadata.transformBinding, expected.transformBinding)) {
          reasons.push("transform-binding-mismatch");
        }
      }
    }

    return reasons.length > 0
      ? Object.freeze({
          state: "stale",
          metadata,
          reasons: Object.freeze(reasons),
        })
      : Object.freeze({ state: "ready", metadata });
  }

  /**
   * Fully validate one caller-owned layer without changing the installed or active assay. The
   * validated values are defensively copied before an opaque prepared token is returned, so the
   * caller cannot mutate scientific state between preparation and an atomic batch commit.
   */
  prepareCompensatedLayer(
    input: CompensatedLayerInput,
    options: PrepareCompensatedLayerOptions = {},
  ): PreparedCompensatedLayer {
    if (!input || typeof input !== "object") {
      throw new Error("Invalid compensated layer: input is required.");
    }
    const metadata = this.freezeProfileMetadata(input.metadata);
    const nextActive = options.activeLayer ?? this._activeLayer;
    if (nextActive !== "original" && nextActive !== "compensated") {
      throw new Error(`Invalid active assay layer '${String(nextActive)}'.`);
    }

    if (Array.isArray(input.columns)) {
      for (const output of input.columns) {
        if (
          output &&
          typeof SharedArrayBuffer !== "undefined" &&
          output.values?.buffer instanceof SharedArrayBuffer
        ) {
          throw new Error(
            "Invalid compensated layer: SharedArrayBuffer inputs are not accepted.",
          );
        }
      }
    }
    this.validateRuntimeLayer(metadata, input.columns);
    const ownedColumns = input.columns.map((output) => Object.freeze({
      pnn: output.pnn,
      fcsColumnIndex: output.fcsColumnIndex,
      values: Float32Array.from(output.values),
    }));
    // Revalidate the owned snapshot as well as the caller's source so only finite copied
    // values can cross the prepared-layer boundary.
    const candidate = this.validateRuntimeLayer(metadata, ownedColumns);
    return this.registerPreparedCompensatedLayer(candidate, nextActive);
  }

  /**
   * Allocate a private, non-installed output transaction for one worker Apply job. The returned
   * token exposes none of its destination arrays; every appended value is checked and copied.
   */
  beginCompensatedLayerStaging(
    metadataInput: PersistedCompensatedLayerBinding,
    outputBindingsInput: readonly CompensatedLayerOutputBinding[],
    identity: CompensatedLayerStagingIdentity,
    options: BeginCompensatedLayerStagingOptions = {},
  ): CompensatedLayerStaging {
    const metadata = this.freezeProfileMetadata(metadataInput);
    const nextActive = options.activeLayer ?? this._activeLayer;
    if (nextActive !== "original" && nextActive !== "compensated") {
      throw new Error(`Invalid active assay layer '${String(nextActive)}'.`);
    }
    if (
      !identity ||
      typeof identity.jobId !== "string" ||
      identity.jobId.trim().length === 0 ||
      typeof identity.jobToken !== "string" ||
      identity.jobToken.trim().length === 0 ||
      typeof identity.bindingKey !== "string" ||
      identity.bindingKey.trim().length === 0
    ) {
      throw new Error("Invalid compensated staging identity.");
    }
    if (!Array.isArray(outputBindingsInput)) {
      throw new Error("Invalid compensated staging: output bindings must be an array.");
    }
    const expected = metadata.channelBindings
      .filter(({ included }) => included)
      .map((binding, solveIndex) => {
        if (metadata.kind === "flow-spillover" && binding.matrixSourceIndex === null) {
          throw new Error("Invalid compensated staging: every flow output needs a matrix source.");
        }
        return Object.freeze({
          pnn: binding.pnn,
          fcsColumnIndex: binding.fcsColumnIndex,
          matrixSourceIndex: metadata.kind === "cytof-spillover"
            ? solveIndex
            : binding.matrixSourceIndex!,
        });
      })
      .sort((left, right) => left.matrixSourceIndex - right.matrixSourceIndex);
    if (outputBindingsInput.length !== expected.length) {
      throw new Error("Invalid compensated staging: output bindings do not match the profile.");
    }
    const outputBindings = expected.map((binding, index) => {
      if (!Object.prototype.hasOwnProperty.call(outputBindingsInput, index)) {
        throw new Error("Invalid compensated staging: output bindings must not be sparse.");
      }
      const supplied = outputBindingsInput[index];
      if (
        !supplied ||
        supplied.pnn !== binding.pnn ||
        supplied.fcsColumnIndex !== binding.fcsColumnIndex ||
        supplied.matrixSourceIndex !== binding.matrixSourceIndex
      ) {
        throw new Error("Invalid compensated staging: source-order output identity mismatch.");
      }
      return binding;
    });
    const columns = outputBindings.map(({ pnn, fcsColumnIndex }) => Object.freeze({
      pnn,
      fcsColumnIndex,
      values: new Float32Array(this.fcs.nEvents),
    }));
    const candidate = this.validateRuntimeLayer(metadata, columns, {
      skipFiniteValidation: true,
    });
    const staging = Object.freeze({
      [COMPENSATED_LAYER_STAGING]: true as const,
    });
    compensatedLayerStagings.set(staging, {
      sample: this,
      context: this.captureAssayPreparationContext(),
      jobId: identity.jobId,
      jobToken: identity.jobToken,
      bindingKey: identity.bindingKey,
      outputBindings: Object.freeze(outputBindings),
      eventCount: this.fcs.nEvents,
      compensatedLayer: candidate,
      activeLayer: nextActive,
      allowOutOfOrderChunks: options.allowOutOfOrderChunks === true,
      writtenRanges: [],
      processedEvents: 0,
    });
    return staging;
  }

  /** Verify and copy one contiguous source-order worker segment into private staging arrays. */
  appendCompensatedLayerStagingChunk(
    staging: CompensatedLayerStaging,
    chunk: CompensatedLayerStagingChunk,
  ): void {
    const record = compensatedLayerStagings.get(staging);
    if (!record || record.sample !== this) {
      throw new Error("Invalid compensated staging: forged, aborted, or already finished token.");
    }
    if (
      !chunk ||
      chunk.jobId !== record.jobId ||
      chunk.jobToken !== record.jobToken ||
      chunk.bindingKey !== record.bindingKey
    ) {
      throw new Error("Invalid compensated staging: worker job identity mismatch.");
    }
    if (!this.assayPreparationContextMatches(record.context)) {
      compensatedLayerStagings.delete(staging);
      throw new Error("Invalid compensated staging: Sample context changed during Apply.");
    }
    if (!Number.isSafeInteger(chunk.startEvent) || chunk.startEvent < 0) {
      throw new Error("Invalid compensated staging: chunk start must be a non-negative safe integer.");
    }
    if (
      !Array.isArray(chunk.outputBindings) ||
      !Array.isArray(chunk.columns) ||
      chunk.outputBindings.length !== record.outputBindings.length ||
      chunk.columns.length !== record.outputBindings.length
    ) {
      throw new Error("Invalid compensated staging: malformed worker output columns.");
    }
    const eventCount = chunk.columns[0]?.length ?? 0;
    if (
      eventCount <= 0 ||
      chunk.startEvent + eventCount > record.eventCount
    ) {
      throw new Error("Invalid compensated staging: worker chunk is empty or outside the sample.");
    }
    for (let source = 0; source < record.outputBindings.length; source++) {
      if (
        !Object.prototype.hasOwnProperty.call(chunk.outputBindings, source) ||
        !Object.prototype.hasOwnProperty.call(chunk.columns, source)
      ) {
        throw new Error("Invalid compensated staging: worker output must not be sparse.");
      }
      const expected = record.outputBindings[source];
      const supplied = chunk.outputBindings[source];
      const column = chunk.columns[source];
      if (
        !supplied ||
        supplied.pnn !== expected.pnn ||
        supplied.fcsColumnIndex !== expected.fcsColumnIndex ||
        supplied.matrixSourceIndex !== expected.matrixSourceIndex ||
        !(column instanceof Float32Array) ||
        column.length !== eventCount
      ) {
        throw new Error("Invalid compensated staging: source-order worker output mismatch.");
      }
      if (
        typeof SharedArrayBuffer !== "undefined" &&
        column.buffer instanceof SharedArrayBuffer
      ) {
        throw new Error(
          "Invalid compensated staging: SharedArrayBuffer worker outputs are not accepted.",
        );
      }
      for (let event = 0; event < eventCount; event++) {
        if (!Number.isFinite(column[event])) {
          compensatedLayerStagings.delete(staging);
          throw new Error(
            `Invalid compensated staging: output '${expected.pnn}' contains a non-finite value at event ${chunk.startEvent + event + 1}.`,
          );
        }
      }
    }
    const chunkEnd = chunk.startEvent + eventCount;
    if (record.allowOutOfOrderChunks) {
      if (record.writtenRanges.some(([start, end]) => chunk.startEvent < end && chunkEnd > start)) {
        throw new Error("Invalid compensated staging: parallel chunks must not overlap.");
      }
    } else if (chunk.startEvent !== record.processedEvents) {
      throw new Error("Invalid compensated staging: chunks must be contiguous and ordered.");
    }
    for (let source = 0; source < record.outputBindings.length; source++) {
      const binding = record.outputBindings[source];
      record.compensatedLayer.columnsByFcsIndex
        .get(binding.fcsColumnIndex)!
        .set(chunk.columns[source], chunk.startEvent);
    }
    record.writtenRanges.push(Object.freeze([chunk.startEvent, chunkEnd]));
    record.processedEvents += eventCount;
  }

  /** Seal a complete private staging transaction into a batch-commit token. */
  finishCompensatedLayerStaging(
    staging: CompensatedLayerStaging,
    identity: CompensatedLayerStagingIdentity,
  ): PreparedCompensatedLayer {
    const record = compensatedLayerStagings.get(staging);
    if (!record || record.sample !== this) {
      throw new Error("Invalid compensated staging: forged, aborted, or already finished token.");
    }
    if (
      identity.jobId !== record.jobId ||
      identity.jobToken !== record.jobToken ||
      identity.bindingKey !== record.bindingKey
    ) {
      throw new Error("Invalid compensated staging: worker job identity mismatch.");
    }
    if (
      record.processedEvents !== record.eventCount ||
      !this.assayPreparationContextMatches(record.context)
    ) {
      throw new Error("Invalid compensated staging: result is incomplete or Sample context changed.");
    }
    compensatedLayerStagings.delete(staging);
    return this.registerPreparedCompensatedLayer(
      record.compensatedLayer,
      record.activeLayer,
      record.context,
    );
  }

  abortCompensatedLayerStaging(staging: CompensatedLayerStaging): void {
    const record = compensatedLayerStagings.get(staging);
    if (record?.sample === this) compensatedLayerStagings.delete(staging);
  }

  /**
   * Commit one or more prepared Samples as a batch. Every token and captured context is checked
   * before the first mutation; all states and revisions advance before any observer is notified.
   */
  static commitPreparedCompensatedLayers(
    preparedLayers: readonly PreparedCompensatedLayer[],
  ): void {
    if (!Array.isArray(preparedLayers)) {
      throw new Error("Invalid prepared compensation batch: an array is required.");
    }

    const records: PreparedCompensatedLayerRecord[] = [];
    const seenSamples = new Set<Sample>();
    for (let index = 0; index < preparedLayers.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(preparedLayers, index)) {
        throw new Error("Invalid prepared compensation batch: entries must not be sparse.");
      }
      const prepared = preparedLayers[index];
      const record = preparedCompensatedLayers.get(prepared);
      if (!record) {
        throw new Error("Invalid prepared compensation batch: forged or already committed token.");
      }
      if (seenSamples.has(record.sample)) {
        throw new Error("Invalid prepared compensation batch: each Sample may appear only once.");
      }
      seenSamples.add(record.sample);
      records.push(record);
    }

    const changes: AssayLayerChange[] = [];
    for (const record of records) {
      if (!record.sample.assayPreparationContextMatches(record.context)) {
        throw new Error("Cannot commit compensated layer: Sample context changed after preparation.");
      }
      changes.push(record.sample.describeAssayLayerChange(
        record.compensatedLayer,
        record.activeLayer,
      ));
    }

    // Prepared tokens become single-use only once the entire batch has passed prevalidation.
    for (const prepared of preparedLayers) preparedCompensatedLayers.delete(prepared);
    for (const change of changes) change.sample.applyAssayLayerChange(change);
    for (const change of changes) {
      change.sample.notifyRevisions(change.activeDataChanged, change.layerChanged);
    }
  }

  /**
   * Install a complete, already-solved profile result. Validation is
   * transactional: no Sample state or cache changes until every binding and
   * every value has passed the scientific identity boundary.
   */
  installCompensatedLayer(
    input: CompensatedLayerInput,
    options: PrepareCompensatedLayerOptions = {},
  ): void {
    const prepared = this.prepareCompensatedLayer(input, options);
    Sample.commitPreparedCompensatedLayers([prepared]);
  }

  /** Remove the derived layer; an active Compensated view returns to Original atomically. */
  removeCompensatedLayer(): void {
    if (!this.compensatedLayer) return;
    this.commitAssayLayerChange(null, "original");
  }

  /** Switch which complete linear-count layer all Sample consumers read. */
  setActiveLayer(
    layer: AssayLayer,
    expected?: PersistedCompensatedLayerBinding,
  ): void {
    if (layer !== "original" && layer !== "compensated") {
      throw new Error(`Invalid active assay layer '${String(layer)}'.`);
    }
    if (layer === "compensated") {
      const status = this.compensatedLayerStatus(expected);
      if (status.state !== "ready") throw this.unavailableCompensatedLayerError(status);
    }
    if (layer === this._activeLayer) return;
    this.commitAssayLayerChange(this.compensatedLayer, layer);
  }

  /**
   * What an external matrix would compensate here, without installing anything.
   *
   * Lets a caller show the consequences — including which parameters this file does not have —
   * and get confirmation before the sample is changed.
   */
  externalSpilloverPreview(matrix: { channels: string[]; matrix: number[][] }): {
    display: DisplaySpillover | null;
    dropped: string[];
  } {
    const pnnToKey = new Map<string, string>();
    for (const c of this.channels) pnnToKey.set(c.pnn, c.key);
    // FlowJo rewrites a parameter name containing "/" with "_" inside its workspace, in the
    // keyword table, the spillover matrix and the gate dimensions alike: "LIVE/DEAD Aqua-A" in
    // the file is "LIVE_DEAD Aqua-A" in the matrix (Michaelis et al. 2025, LSRFortessa X-20).
    // Looked up by exact name that channel was dropped, and the other seven were compensated
    // without the row that spills into them. A matrix channel with no exact match is therefore
    // tried with that one substitution, and accepted only when it names exactly one parameter
    // that way. Nothing else is fuzzed.
    const lookup = (pnn: string): string | null => {
      const exact = pnnToKey.get(pnn);
      if (exact !== undefined) return exact;
      const hits = this.channels.filter((c) => c.pnn.replace(/\//g, "_") === pnn);
      return hits.length === 1 ? hits[0].key : null;
    };
    const display = extractDisplaySpillover(matrix, lookup, isScatterChannel, isQcChannel);
    // extractDisplaySpillover keeps only the channels this file has and takes that sub-matrix.
    // Dropping a channel that spills into the others changes the result, so it is reported
    // rather than absorbed silently.
    const kept = new Set(display?.channels ?? []);
    const dropped = matrix.channels.filter((pnn) => {
      const key = lookup(pnn);
      return key === null || !kept.has(key);
    });
    return { display, dropped };
  }

  /**
   * Supply a spillover matrix the FCS itself does not carry.
   *
   * BD FACSDiva exports routinely have no `$SPILLOVER`: the matrix lives in the FlowJo workspace
   * instead, and gates drawn on `Comp-`-prefixed parameters cannot be evaluated without it. Once
   * installed, the matrix behaves exactly like an embedded one — `setCompensation()`, gating,
   * statistics and export all read it through `spillover` — so nothing downstream needs to know.
   *
   * Replacing a matrix the file already carries requires `replaceEmbedded`, because doing it
   * silently would change every gated population with nothing on screen to explain why. It is a
   * real case rather than a hypothetical: a BD FACSDiva export writes the ACQUISITION matrix into
   * the file (under `SPILL`), while the operator's later adjustment lives only in the FlowJo
   * workspace -- and it is the adjusted one the gates were drawn under. Preferring the file's
   * would place every fluorescence gate slightly wrong and look entirely healthy.
   */
  installExternalSpillover(
    matrix: { channels: string[]; matrix: number[][] },
    label: string,
    opts: { replaceEmbedded?: boolean } = {},
  ): void {
    if (this.instrument !== "flow") {
      throw new Error("An external spillover matrix applies to flow data only.");
    }
    const embedded = this._spillover;
    if (embedded !== null && !opts.replaceEmbedded) {
      throw new Error(
        "This file already carries a spillover matrix, so an external one was not applied.",
      );
    }
    const { display, dropped } = this.externalSpilloverPreview(matrix);
    if (!display) {
      throw new Error(
        `"${label}" has no usable compensation for this file: fewer than two of its ` +
          `${matrix.channels.length} parameters are fluorescence channels present here, or the ` +
          "matrix is an identity.",
      );
    }
    // Compensation must be off before the layer beneath it changes, or the installed compensated
    // layer would keep values derived from the matrix being replaced.
    if (embedded !== null && this.compensationEnabled) this.setCompensation(false);
    this._spillover = display;
    this._spilloverOrigin = Object.freeze({
      kind: "external" as const,
      label,
      droppedChannels: Object.freeze(dropped),
      replacedEmbedded: embedded !== null,
      maxDeviationFromEmbedded: embedded === null ? null : maxCoefficientDelta(embedded, display),
    });
  }

  /** Toggle spillover compensation (applied to raw fluor values before transforms). */
  setCompensation(on: boolean): void {
    if (
      on &&
      this.compensatedLayer?.metadata.runtimeIdentity === "profile"
    ) {
      throw new Error(
        "Embedded FCS compensation cannot be enabled while a profile-derived layer is installed.",
      );
    }
    if (on === this.compensationEnabled) return;
    if (!on) {
      if (this.compensatedLayer?.metadata.runtimeIdentity === "legacy-embedded-fcs") {
        this.removeCompensatedLayer();
      } else {
        this.setActiveLayer("original");
      }
      return;
    }

    const installed = this.compensatedLayerStatus();
    if (
      installed.state === "ready" &&
      installed.metadata.runtimeIdentity === "legacy-embedded-fcs"
    ) {
      this.setActiveLayer("compensated");
      return;
    }
    if (!this.spillover || this.instrument !== "flow") return;

    const resolvedIndices = this.spillover.channels.map((key) => this.byName.get(key));
    if (resolvedIndices.some((index) => index === undefined)) return;
    const fluor = resolvedIndices.map((index) => this.originalColumnData(index!));
    let compensated: readonly Float32Array[];
    try {
      const result = solveFlowCompensation(
        fluor,
        this.spillover.matrix,
        DEFAULT_FLOW_SOLVER_SETTINGS,
        {
          output: "float32",
          computeReconstructionResidual: false,
          // The FCS parser has already materialised numeric columns, and validateRuntimeLayer()
          // transactionally checks every final Float32 value before the layer can be installed.
          validateMeasuredValues: false,
        },
      );
      if (!result.columns.every((column) => column instanceof Float32Array)) {
        throw new Error("Flow Apply did not return Float32 assay columns.");
      }
      compensated = result.columns as readonly Float32Array[];
    } catch (error) {
      if (error instanceof FlowCompensationError) return;
      throw error;
    }
    const bindings = resolvedIndices.map((index, matrixIndex) => {
      const channel = this.channels[index!];
      return Object.freeze({
        pnn: normalizePnn(channel.pnn),
        fcsColumnIndex: channel.columnIndex,
        matrixSourceIndex: matrixIndex,
        matrixReceiverIndex: matrixIndex,
        included: true,
      });
    });
    const metadata: LegacyEmbeddedCompensatedLayerMetadata = Object.freeze({
      runtimeIdentity: "legacy-embedded-fcs",
      kind: "flow-spillover",
      method: "matrix-inverse",
      includedPnns: Object.freeze(bindings.map(({ pnn }) => pnn)),
      channelBindings: Object.freeze(bindings),
      transformBinding: Object.freeze({ kind: "flow-linear" }),
    });
    const columns = resolvedIndices.map((index, matrixIndex) => ({
      pnn: normalizePnn(this.channels[index!].pnn),
      fcsColumnIndex: this.channels[index!].columnIndex,
      values: compensated[matrixIndex],
    }));
    const candidate = this.validateRuntimeLayer(metadata, columns);
    this.commitAssayLayerChange(candidate, "compensated");
  }
  /** Force the instrument mode ('auto' = the detected value). Rebuilds all derived caches
   *  because the display transform + gating space depend on the instrument. Intended as a
   *  recovery for an auto-detect miss — switch it before gating for best results, since the
   *  gating space (raw vs display) also flips with it. */
  setInstrumentMode(mode: "auto" | "flow" | "cytof"): void {
    if (mode === this._instrumentMode) return;
    const previousInstrument = this.instrument;
    const previousActiveLayer = this._activeLayer;
    const previousLayerStatus = this.compensatedLayerStatusKey();
    this._instrumentMode = mode;
    if (
      this._activeLayer === "compensated" &&
      this.compensatedLayerStatus().state !== "ready"
    ) {
      this._activeLayer = "original";
    }
    const activeDataChanged = previousInstrument !== this.instrument ||
      previousActiveLayer !== this._activeLayer;
    const layerStateChanged = previousActiveLayer !== this._activeLayer ||
      this.compensatedLayerStatusKey() !== previousLayerStatus;
    if (activeDataChanged) this.invalidateAll();
    this.publishRevisions(activeDataChanged, layerStateChanged);
  }
  /** Drop every derived cache — raw data changed underneath (compensation / instrument change). */
  private invalidateAll(): void {
    this.transformCache.clear();
    this.displayCache.clear();
    this.gatingCache.clear();
    this.rangeCache.clear();
    this.logicleParamsCache.clear();
  }

  private freezeProfileMetadata(
    metadata: PersistedCompensatedLayerBinding,
  ): ProfileCompensatedLayerMetadata {
    if (!metadata || typeof metadata !== "object") {
      throw new Error("Invalid compensated layer: profile metadata is required.");
    }
    if (typeof metadata.profileId !== "string" || metadata.profileId.trim().length === 0) {
      throw new Error("Invalid compensated layer: profileId must be a non-blank string.");
    }
    const digest = /^sha256:[0-9a-f]{64}$/;
    if (!digest.test(metadata.profileHash) || !digest.test(metadata.matrixHash)) {
      throw new Error("Invalid compensated layer: profile and matrix SHA-256 hashes are required.");
    }
    if (
      !Array.isArray(metadata.includedPnns) ||
      !Array.isArray(metadata.channelBindings) ||
      !metadata.transformBinding ||
      typeof metadata.transformBinding !== "object"
    ) {
      throw new Error("Invalid compensated layer: profile bindings are incomplete.");
    }
    if (
      metadata.transformBinding.kind !== "flow-linear" &&
      metadata.transformBinding.kind !== "cytof-asinh"
    ) {
      throw new Error("Invalid compensated layer: unsupported transform binding.");
    }
    return Object.freeze({
      runtimeIdentity: "profile",
      profileId: metadata.profileId,
      profileHash: metadata.profileHash,
      matrixHash: metadata.matrixHash,
      kind: metadata.kind,
      method: metadata.method,
      includedPnns: Object.freeze(Array.from(metadata.includedPnns)),
      channelBindings: freezeChannelBindings(metadata.channelBindings),
      transformBinding: freezeTransformBinding(metadata.transformBinding),
    });
  }

  private validateRuntimeLayer(
    metadata: CompensatedLayerMetadata,
    columns: readonly CompensatedLayerColumn[],
    options: Readonly<{ skipFiniteValidation?: boolean }> = {},
  ): RuntimeCompensatedLayer {
    if (metadata.kind !== "flow-spillover" && metadata.kind !== "cytof-spillover") {
      throw new Error(`Invalid compensated layer: unsupported kind '${String(metadata.kind)}'.`);
    }
    if (metadata.method !== "matrix-inverse" && metadata.method !== "nnls") {
      throw new Error(`Invalid compensated layer: unsupported method '${String(metadata.method)}'.`);
    }
    const expectedInstrument = metadata.kind === "flow-spillover" ? "flow" : "cytof";
    const expectedMethod = metadata.kind === "flow-spillover" ? "matrix-inverse" : "nnls";
    if (metadata.method !== expectedMethod) {
      throw new Error(
        `Invalid compensated layer: ${metadata.kind} requires method ${expectedMethod}.`,
      );
    }
    if (this.instrument !== expectedInstrument) {
      throw new Error(
        `Invalid compensated layer: ${metadata.kind} cannot be installed on a ${this.instrument} sample.`,
      );
    }
    if (
      (metadata.kind === "flow-spillover" && metadata.transformBinding.kind !== "flow-linear") ||
      (metadata.kind === "cytof-spillover" && metadata.transformBinding.kind !== "cytof-asinh")
    ) {
      throw new Error("Invalid compensated layer: transform binding does not match its modality.");
    }
    if (
      metadata.transformBinding.kind === "cytof-asinh" &&
      (!Number.isFinite(metadata.transformBinding.cofactor) ||
        metadata.transformBinding.cofactor <= 0 ||
        metadata.transformBinding.cofactor !== this.cytofCofactor)
    ) {
      throw new Error(
        "Invalid compensated layer: CyTOF transform binding does not match the sample cofactor.",
      );
    }
    if (!Array.isArray(metadata.includedPnns) || metadata.includedPnns.length === 0) {
      throw new Error("Invalid compensated layer: at least one included $PnN is required.");
    }
    if (!Array.isArray(metadata.channelBindings) || !Array.isArray(columns)) {
      throw new Error("Invalid compensated layer: bindings and output columns must be arrays.");
    }
    for (let index = 0; index < metadata.includedPnns.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(metadata.includedPnns, index)) {
        throw new Error("Invalid compensated layer: included $PnNs must not contain sparse entries.");
      }
    }
    for (let index = 0; index < metadata.channelBindings.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(metadata.channelBindings, index)) {
        throw new Error("Invalid compensated layer: channel bindings must not contain sparse entries.");
      }
    }
    for (let index = 0; index < columns.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(columns, index)) {
        throw new Error("Invalid compensated layer: output columns must not contain sparse entries.");
      }
    }

    const includedPnns = metadata.includedPnns.map((pnn) =>
      typeof pnn === "string" ? normalizePnn(pnn) : ""
    );
    if (
      includedPnns.some((pnn, index) => pnn.length === 0 || pnn !== metadata.includedPnns[index]) ||
      new Set(includedPnns).size !== includedPnns.length
    ) {
      throw new Error("Invalid compensated layer: included $PnN identities must be canonical and unique.");
    }

    const includedBindings = new Map<string, MatrixChannelBinding>();
    const seenBindingIndices = new Set<number>();
    const seenBindingPnns = new Set<string>();
    const seenReceiverIndices = new Set<number>();
    const seenSourceIndices = new Set<number>();
    let previousReceiverIndex = -1;
    const sampleChannelsByPnn = new Map<string, ResolvedChannel[]>();
    for (const channel of this.channels) {
      const pnn = normalizePnn(channel.pnn);
      const matches = sampleChannelsByPnn.get(pnn) ?? [];
      matches.push(channel);
      sampleChannelsByPnn.set(pnn, matches);
    }
    for (const binding of metadata.channelBindings) {
      if (
        !binding ||
        typeof binding.pnn !== "string" ||
        !Number.isSafeInteger(binding.fcsColumnIndex) ||
        binding.fcsColumnIndex < 0 ||
        !Number.isSafeInteger(binding.matrixReceiverIndex) ||
        binding.matrixReceiverIndex < 0 ||
        (binding.matrixSourceIndex !== null &&
          (!Number.isSafeInteger(binding.matrixSourceIndex) || binding.matrixSourceIndex < 0)) ||
        typeof binding.included !== "boolean"
      ) {
        throw new Error("Invalid compensated layer: malformed channel binding.");
      }
      const pnn = normalizePnn(binding.pnn);
      if (pnn.length === 0 || pnn !== binding.pnn) {
        throw new Error("Invalid compensated layer: binding $PnN identities must be canonical.");
      }
      if (seenBindingIndices.has(binding.fcsColumnIndex)) {
        throw new Error("Invalid compensated layer: duplicate FCS column binding.");
      }
      if (seenBindingPnns.has(pnn)) {
        throw new Error("Invalid compensated layer: duplicate $PnN binding.");
      }
      if (
        seenReceiverIndices.has(binding.matrixReceiverIndex) ||
        binding.matrixReceiverIndex <= previousReceiverIndex
      ) {
        throw new Error(
          "Invalid compensated layer: matrix receiver bindings must be unique and ordered.",
        );
      }
      if (
        binding.matrixSourceIndex !== null &&
        seenSourceIndices.has(binding.matrixSourceIndex)
      ) {
        throw new Error("Invalid compensated layer: duplicate matrix source binding.");
      }
      if (
        metadata.kind === "flow-spillover" &&
        (binding.matrixSourceIndex === null || !binding.included)
      ) {
        throw new Error(
          "Invalid compensated layer: conventional-flow bindings must all be included source/receiver channels.",
        );
      }
      seenBindingIndices.add(binding.fcsColumnIndex);
      seenBindingPnns.add(pnn);
      seenReceiverIndices.add(binding.matrixReceiverIndex);
      previousReceiverIndex = binding.matrixReceiverIndex;
      if (binding.matrixSourceIndex !== null) {
        seenSourceIndices.add(binding.matrixSourceIndex);
      }
      const matchingSampleChannels = sampleChannelsByPnn.get(pnn) ?? [];
      const channel = matchingSampleChannels[0];
      if (matchingSampleChannels.length !== 1 || channel.columnIndex !== binding.fcsColumnIndex) {
        throw new Error(
          `Invalid compensated layer: exact $PnN/FCS binding '${pnn}' → ${binding.fcsColumnIndex} does not match this sample.`,
        );
      }
      if (binding.included) {
        if (includedBindings.has(pnn)) {
          throw new Error("Invalid compensated layer: duplicate included $PnN binding.");
        }
        includedBindings.set(pnn, binding);
      }
    }
    const includedBindingPnns = metadata.channelBindings
      .filter(({ included }) => included)
      .map(({ pnn }) => pnn);
    if (
      includedBindings.size !== includedPnns.length ||
      !sameStrings(includedPnns, includedBindingPnns) ||
      includedPnns.some((pnn) => !includedBindings.has(pnn))
    ) {
      throw new Error("Invalid compensated layer: included $PnNs and bindings do not match exactly.");
    }
    if (metadata.kind === "flow-spillover") {
      const count = metadata.channelBindings.length;
      const expectedIndices = Array.from({ length: count }, (_, index) => index);
      const receiverIndices = metadata.channelBindings.map(({ matrixReceiverIndex }) =>
        matrixReceiverIndex
      );
      const sourceIndices = metadata.channelBindings
        .map(({ matrixSourceIndex }) => matrixSourceIndex!)
        .sort((left, right) => left - right);
      if (
        !sameStrings(receiverIndices.map(String), expectedIndices.map(String)) ||
        !sameStrings(sourceIndices.map(String), expectedIndices.map(String))
      ) {
        throw new Error(
          "Invalid compensated layer: conventional-flow bindings must cover every matrix source and receiver exactly once.",
        );
      }
    }

    const columnsByFcsIndex = new Map<number, Float32Array>();
    const outputPnns = new Set<string>();
    for (const output of columns) {
      if (
        !output ||
        typeof output.pnn !== "string" ||
        !Number.isSafeInteger(output.fcsColumnIndex) ||
        !(output.values instanceof Float32Array)
      ) {
        throw new Error("Invalid compensated layer: malformed output column.");
      }
      const pnn = normalizePnn(output.pnn);
      const binding = includedBindings.get(pnn);
      if (!binding || binding.fcsColumnIndex !== output.fcsColumnIndex) {
        throw new Error(
          `Invalid compensated layer: output '${pnn}' → ${output.fcsColumnIndex} is not an exact included binding.`,
        );
      }
      if (columnsByFcsIndex.has(output.fcsColumnIndex) || outputPnns.has(pnn)) {
        throw new Error("Invalid compensated layer: duplicate output column.");
      }
      if (output.values.length !== this.fcs.nEvents) {
        throw new Error(
          `Invalid compensated layer: output '${pnn}' has ${output.values.length} events; expected ${this.fcs.nEvents}.`,
        );
      }
      if (!options.skipFiniteValidation) {
        for (let event = 0; event < output.values.length; event++) {
          if (!Number.isFinite(output.values[event])) {
            throw new Error(
              `Invalid compensated layer: output '${pnn}' contains a non-finite value at event ${event + 1}.`,
            );
          }
        }
      }
      columnsByFcsIndex.set(output.fcsColumnIndex, output.values);
      outputPnns.add(pnn);
    }
    if (
      columnsByFcsIndex.size !== includedBindings.size ||
      includedPnns.some((pnn) => !outputPnns.has(pnn))
    ) {
      throw new Error("Invalid compensated layer: every included binding needs one complete output column.");
    }
    return Object.freeze({ metadata, columnsByFcsIndex });
  }

  private captureAssayPreparationContext(): AssayPreparationContext {
    return Object.freeze({
      sample: this,
      fcs: this.fcs,
      eventCount: this.fcs.nEvents,
      dataRevision: this._dataRevision,
      layerRevision: this._layerRevision,
      activeLayer: this._activeLayer,
      compensatedLayer: this.compensatedLayer,
      instrumentMode: this._instrumentMode,
      instrument: this.instrument,
      cytofCofactor: this.cytofCofactor,
      displayTransformContextKey: this.displayTransformContextKey,
    });
  }

  private assayPreparationContextMatches(context: AssayPreparationContext): boolean {
    return context.sample === this &&
      context.fcs === this.fcs &&
      context.eventCount === this.fcs.nEvents &&
      context.dataRevision === this._dataRevision &&
      context.layerRevision === this._layerRevision &&
      context.activeLayer === this._activeLayer &&
      context.compensatedLayer === this.compensatedLayer &&
      context.instrumentMode === this._instrumentMode &&
      context.instrument === this.instrument &&
      context.cytofCofactor === this.cytofCofactor &&
      context.displayTransformContextKey === this.displayTransformContextKey;
  }

  private registerPreparedCompensatedLayer(
    compensatedLayer: RuntimeCompensatedLayer,
    activeLayer: AssayLayer,
    context: AssayPreparationContext = this.captureAssayPreparationContext(),
  ): PreparedCompensatedLayer {
    const prepared = Object.freeze({
      [PREPARED_COMPENSATED_LAYER]: true as const,
    });
    preparedCompensatedLayers.set(prepared, Object.freeze({
      sample: this,
      context,
      compensatedLayer,
      activeLayer,
    }));
    return prepared;
  }

  private commitAssayLayerChange(
    compensatedLayer: RuntimeCompensatedLayer | null,
    activeLayer: AssayLayer,
  ): void {
    const change = this.describeAssayLayerChange(compensatedLayer, activeLayer);
    this.applyAssayLayerChange(change);
    this.notifyRevisions(change.activeDataChanged, change.layerChanged);
  }

  private describeAssayLayerChange(
    compensatedLayer: RuntimeCompensatedLayer | null,
    activeLayer: AssayLayer,
  ): AssayLayerChange {
    if (activeLayer === "compensated" && !compensatedLayer) {
      throw new Error("Cannot activate Compensated: no complete layer is installed.");
    }
    const installedLayerChanged = compensatedLayer !== this.compensatedLayer;
    const activeLayerChanged = activeLayer !== this._activeLayer;
    const activeDataChanged = activeLayerChanged ||
      (activeLayer === "compensated" && installedLayerChanged);
    return Object.freeze({
      sample: this,
      compensatedLayer,
      activeLayer,
      activeDataChanged,
      layerChanged: installedLayerChanged || activeLayerChanged,
    });
  }

  private applyAssayLayerChange(change: AssayLayerChange): void {
    if (!change.layerChanged) return;
    this.compensatedLayer = change.compensatedLayer;
    this._activeLayer = change.activeLayer;
    if (change.activeDataChanged) this.invalidateAll();
    if (change.activeDataChanged) this._dataRevision++;
    this._layerRevision++;
  }

  private publishRevisions(dataChanged: boolean, layerChanged: boolean): void {
    if (!dataChanged && !layerChanged) return;
    // Increment both identities before notifying either observer set so every callback sees
    // one fully committed, internally consistent Sample state.
    if (dataChanged) this._dataRevision++;
    if (layerChanged) this._layerRevision++;

    this.notifyRevisions(dataChanged, layerChanged);
  }

  private notifyRevisions(dataChanged: boolean, layerChanged: boolean): void {
    const notify = (listeners: ReadonlySet<() => void>) => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A UI observer cannot roll back an already committed scientific state change.
        }
      }
    };
    if (dataChanged) notify(this.dataRevisionListeners);
    if (layerChanged) notify(this.layerRevisionListeners);
  }

  private unavailableCompensatedLayerError(status: CompensatedLayerStatus): Error {
    if (status.state === "missing") {
      return new Error("Compensated assay layer is unavailable: no complete result is installed.");
    }
    if (status.state === "stale") {
      return new Error(
        `Compensated assay layer is stale: ${status.reasons.join(", ")}.`,
      );
    }
    return new Error("Compensated assay layer is unavailable.");
  }

  private compensatedLayerStatusKey(): string {
    const status = this.compensatedLayerStatus();
    return status.state === "stale"
      ? `stale:${status.reasons.join("|")}`
      : status.state;
  }

  private resolvedChannel(idx: number): ResolvedChannel {
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= this.channels.length) {
      throw new RangeError(`Resolved channel index ${idx} is out of range.`);
    }
    return this.channels[idx];
  }

  /** Active linear column for a resolved-channel index. */
  private activeLinearColumn(idx: number): NumericColumn {
    if (this._activeLayer === "compensated") return this.compensatedColumnData(idx);
    return this.originalColumnData(idx);
  }

  /** Borrowed read-only view of the current linear column. Internal callers must not mutate it. */
  rawColumnData(idx: number): NumericColumn {
    return this.activeLinearColumn(idx);
  }
  /** Borrowed read-only view of stored FCS measurements. Internal callers must not mutate it. */
  originalColumnData(idx: number): NumericColumn {
    const channel = this.resolvedChannel(idx);
    return this.fcs.columns[channel.columnIndex];
  }
  /**
   * Borrowed read-only view of the installed compensated-count assay. Unmatched/excluded
   * channels pass through Original only after a complete matching layer is ready.
   */
  compensatedColumnData(
    idx: number,
    expected?: PersistedCompensatedLayerBinding,
  ): NumericColumn {
    const channel = this.resolvedChannel(idx);
    const status = this.compensatedLayerStatus(expected);
    if (status.state !== "ready") throw this.unavailableCompensatedLayerError(status);
    return this.compensatedLayer!.columnsByFcsIndex.get(channel.columnIndex) ??
      this.fcs.columns[channel.columnIndex];
  }

  /** Auto-estimated {T, W} per channel (single sort), cached. */
  private readonly logicleParamsCache = new Map<number, { t: number; w: number }>();
  /** User-set logicle W per channel (overrides the auto estimate). */
  private readonly wOverride = new Map<number, number>();
  /** Workspace-wide owner of display scales; absent in single-sample and unit-test use. */
  private channelScales?: ChannelScales;

  /**
   * Join a workspace's shared display scales. Registering also contributes this file's own auto
   * estimate to the shared one, so the roster generation moves and dependent caches re-key.
   */
  attachChannelScales(scales: ChannelScales): () => void {
    this.channelScales = scales;
    scales.register(this);
    return () => {
      scales.unregister(this);
      if (this.channelScales === scales) this.channelScales = undefined;
    };
  }

  private logicleParams(idx: number): { t: number; w: number } {
    let p = this.logicleParamsCache.get(idx);
    if (!p) {
      p = estimateLogicleParams(this.activeLinearColumn(idx));
      this.logicleParamsCache.set(idx, p);
    }
    return p;
  }

  /** Lazily build + cache the raw→display transform for one channel. */
  private transform(idx: number): ChannelTransform {
    const hit = this.transformCache.get(idx);
    if (hit) return hit;
    const { key: name, pnn } = this.channels[idx];
    let t: ChannelTransform;
    if (this.instrument === "cytof") {
      t = isCytofRawChannel(name) ? IDENTITY : asinhTransform(this.cytofCofactor);
    } else if (isQcChannel(name) || isQcChannel(pnn)) {
      t = IDENTITY;
      // Classify on $PnN as well as the display key, as the spillover resolution above
      // already does. On instruments whose $PnS is prose ("Forward Scatter (FSC-HLin)"
      // on a Guava Muse) the key is the prose and only $PnN ("FSC-HLin") is recognisable
      // as scatter, so keying on the label alone silently gave scatter a logicle.
    } else if (isScatterChannel(name) || isScatterChannel(pnn)) {
      // Linear scatter reuses the identity transform rather than introducing a new kind:
      // raw == display for that channel, which axis ticks and gate rendering already handle.
      t = this.scatterIsLinear(idx) ? IDENTITY : asinhTransform(this.currentScatterCofactor(idx));
    } else if (this.fluorIsArcsinh(idx)) {
      // Arcsinh cofactor 150 for a fluorescence channel, chosen per channel. It is the same
      // transform the unhealthy-logicle path below falls back to, and the same one GateLabR uses
      // (fcs_import.R:862) -- offered here as a deliberate choice rather than only as a rescue.
      // Flow gates live in raw space, so this moves no event in or out of a gate.
      t = asinhTransform(this.currentFluorCofactor(idx));
    } else {
      const { t: tv } = this.logicleParams(idx);
      const w = this.currentLogicleW(idx);
      const lg = new Logicle(tv, w, 4.5, 0);
      // GateLabR (fcs_import.R:862) falls back to asinh(x/150) when the logicle can't be built /
      // doesn't converge (Logicle.scale returns -1). Health-check at representative values; an
      // unhealthy channel uses asinh outright, a healthy one still guards rare per-value failures
      // so no -1/NaN display coord ever reaches the plot / ticks / stats.
      //
      // The PER-VALUE rescue inside a healthy logicle is pinned at 150, because
      // transformFromSpec() rebuilds this transform from a {kind:"logicle"} spec that carries no
      // cofactor and rescues at 150. Using the adjustable fluor cofactor here made the live
      // transform and its own serialised spec disagree on exactly the values where the logicle
      // fails — the one drift the mirror rule exists to prevent. The UNHEALTHY branch tracks the
      // cofactor deliberately: that channel reports {kind:"asinh", cofactor} as its spec, so the
      // pair stays consistent there too.
      const perValueRescue = asinhTransform(150);
      const healthy = [0, tv * 0.5, tv].every((v) => {
        const s = lg.scale(v);
        return Number.isFinite(s) && s !== -1;
      });
      t = healthy
        ? {
            kind: "logicle",
            forward: (v) => { const s = lg.scale(v); return s === -1 || !Number.isFinite(s) ? perValueRescue.forward(v) : s; },
            inverse: (v) => lg.inverse(v),
          }
        : asinhTransform(this.currentFluorCofactor(idx));
    }
    this.transformCache.set(idx, t);
    return t;
  }

  /** True when the channel is displayed with a logicle transform (flow signal). */
  isLogicleChannel(idx: number): boolean {
    return this.transform(idx).kind === "logicle";
  }
  /** Auto-estimated logicle W (the slider's reset target). */
  autoLogicleW(idx: number): number {
    return this.logicleParams(idx).w;
  }
  /** Logicle T (top-of-scale) for a channel — used when exporting a logicle transform. */
  logicleT(idx: number): number {
    return this.logicleParams(idx).t;
  }
  /** CyTOF arcsinh cofactor (for exporting the fasinh transform). */
  get arcsinhCofactor(): number {
    return this.cytofCofactor;
  }
  /** Restore the global CyTOF arcsinh cofactor carried by a workspace/Gating-ML file. */
  setCytofCofactor(cofactor: number): void {
    if (!Number.isFinite(cofactor) || cofactor <= 0 || cofactor === this.cytofCofactor) return;
    const previousActiveLayer = this._activeLayer;
    const previousLayerStatus = this.compensatedLayerStatusKey();
    this.cytofCofactor = cofactor;
    if (
      this._activeLayer === "compensated" &&
      this.compensatedLayerStatus().state !== "ready"
    ) {
      this._activeLayer = "original";
    }
    const activeDataChanged = this.instrument === "cytof" ||
      previousActiveLayer !== this._activeLayer;
    const layerStateChanged = previousActiveLayer !== this._activeLayer ||
      this.compensatedLayerStatusKey() !== previousLayerStatus;
    if (activeDataChanged) this.invalidateAll();
    this.publishRevisions(activeDataChanged, layerStateChanged);
  }
  /** Flow-scatter channels the user has switched to a linear display, by column index. */
  private readonly scatterLinear = new Set<number>();
  /** Fallback for a Sample with no ChannelScales owner; mirrors scatterLinear. */
  private readonly fluorArcsinh = new Set<number>();

  /**
   * True for a flow scatter axis — the only channels the scatter scale control applies to.
   * CyTOF is excluded deliberately: arcsinh cofactor 5 is the field convention there and
   * is not offered as a choice.
   */
  isScatterAxis(idx: number): boolean {
    if (this.instrument !== "flow") return false;
    const channel = this.channels[idx];
    if (!channel) return false;
    return isScatterChannel(channel.key) || isScatterChannel(channel.pnn);
  }

  /**
   * True for a flow FLUORESCENCE channel -- not scatter, not QC/Time, not CyTOF.
   *
   * Classification, not current appearance: it stays true whether the channel is showing its
   * logicle or an arcsinh, which is what lets the scale control and the W override survive a
   * switch. Classified on $PnN as well as the display key, as transform() does, because on some
   * instruments the key is prose and only $PnN is recognisable.
   */
  isFluorChannel(idx: number): boolean {
    if (this.instrument !== "flow") return false;
    const channel = this.channels[idx];
    if (!channel) return false;
    if (isQcChannel(channel.key) || isQcChannel(channel.pnn)) return false;
    return !isScatterChannel(channel.key) && !isScatterChannel(channel.pnn);
  }

  /** Display scale for a flow fluorescence channel. */
  fluorScale(idx: number): "logicle" | "arcsinh" {
    return this.fluorIsArcsinh(idx) ? "arcsinh" : "logicle";
  }

  /**
   * Switch a flow fluorescence channel between its logicle and arcsinh (cofactor 150).
   *
   * Gates are stored in raw space for flow, so this never moves a gate -- only what the axis
   * looks like. Any logicle W the user set is kept, so switching back restores their axis.
   */
  setFluorScale(idx: number, scale: "logicle" | "arcsinh"): void {
    if (!this.isFluorChannel(idx)) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.setFluorArcsinh(this.workspaceScaleContextKey, key, scale === "arcsinh");
      return;
    }
    if (scale === "arcsinh") this.fluorArcsinh.add(idx);
    else this.fluorArcsinh.delete(idx);
    this.invalidateChannel(idx);
  }

  /** Channel keys displayed with arcsinh instead of logicle, for workspace save. */
  fluorArcsinhKeys(): string[] {
    const keys = new Set(
      [...this.fluorArcsinh].map((idx) => this.channels[idx]?.key).filter((k): k is string => !!k),
    );
    if (this.channelScales) {
      const context = this.workspaceScaleContextKey;
      for (const channel of this.channels) {
        if (this.channelScales.isFluorArcsinh(context, channel.key)) keys.add(channel.key);
      }
    }
    return [...keys];
  }

  /** Restore arcsinh fluorescence channels from a saved workspace. */
  applyFluorArcsinhKeys(keys: readonly string[]): void {
    this.fluorArcsinh.clear();
    for (const key of keys) {
      const idx = this.byName.get(key);
      if (idx !== undefined && this.isFluorChannel(idx)) {
        if (this.channelScales) {
          this.channelScales.setFluorArcsinh(this.workspaceScaleContextKey, key, true);
          continue;
        }
        this.fluorArcsinh.add(idx);
        this.invalidateChannel(idx);
      }
    }
  }

  /**
   * Arcsinh cofactor in force for a fluorescence channel (default 150).
   *
   * Shares the per-channel cofactor store with scatter: a channel is one or the other, never
   * both, so one map serves and a workspace written now still opens in an older build.
   */
  currentFluorCofactor(idx: number): number {
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      const shared = this.channelScales.scatterCofactor(this.workspaceScaleContextKey, key);
      if (shared !== undefined) return shared;
    }
    return this.scatterCofactorOverride.get(idx) ?? FLUOR_ARCSINH_COFACTOR;
  }

  /** Override one fluorescence arcsinh cofactor; invalidates its display caches. */
  setFluorCofactor(idx: number, cofactor: number): void {
    if (!this.isFluorChannel(idx) || !Number.isFinite(cofactor) || cofactor <= 0) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.setScatterCofactor(this.workspaceScaleContextKey, key, cofactor);
      return;
    }
    this.scatterCofactorOverride.set(idx, cofactor);
    this.invalidateChannel(idx);
  }

  /** Clear a fluorescence cofactor override, reverting to the 150 default. */
  resetFluorCofactor(idx: number): void {
    if (!this.isFluorChannel(idx)) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.resetScatterCofactor(this.workspaceScaleContextKey, key);
      return;
    }
    this.scatterCofactorOverride.delete(idx);
    this.invalidateChannel(idx);
  }

  /** True when this fluorescence channel is drawn on an arcsinh axis. */
  private fluorIsArcsinh(idx: number): boolean {
    if (this.instrument !== "flow") return false;
    const shared = this.channelScales;
    const key = this.channels[idx]?.key;
    if (shared && key) return shared.isFluorArcsinh(this.workspaceScaleContextKey, key);
    return this.fluorArcsinh.has(idx);
  }

  /** Display scale for a flow scatter channel. */
  scatterScale(idx: number): "arcsinh" | "linear" {
    return this.scatterIsLinear(idx) ? "linear" : "arcsinh";
  }

  /**
   * Switch a flow scatter channel between arcsinh and linear display. Gates are stored in
   * raw space for flow, so this never moves a gate — only what the axis looks like.
   */
  setScatterScale(idx: number, scale: "arcsinh" | "linear"): void {
    if (!this.isScatterAxis(idx)) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.setScatterLinear(this.workspaceScaleContextKey, key, scale === "linear");
      return;
    }
    if (scale === "linear") this.scatterLinear.add(idx);
    else this.scatterLinear.delete(idx);
    this.invalidateChannel(idx);
  }

  /** Channel keys displayed linearly, for workspace save. */
  scatterLinearKeys(): string[] {
    const keys = new Set(
      [...this.scatterLinear].map((idx) => this.channels[idx]?.key).filter((k): k is string => !!k),
    );
    if (this.channelScales) {
      const context = this.workspaceScaleContextKey;
      for (const channel of this.channels) {
        if (this.channelScales.isScatterLinear(context, channel.key)) keys.add(channel.key);
      }
    }
    return [...keys];
  }

  /** Restore linear scatter channels from a saved workspace. */
  applyScatterLinearKeys(keys: readonly string[]): void {
    this.scatterLinear.clear();
    for (const key of keys) {
      const idx = this.byName.get(key);
      if (idx !== undefined && this.isScatterAxis(idx)) {
        if (this.channelScales) {
          this.channelScales.setScatterLinear(this.workspaceScaleContextKey, key, true);
          continue;
        }
        this.scatterLinear.add(idx);
        this.invalidateChannel(idx);
      }
    }
  }

  /** Clear a scatter cofactor override, reverting to the 150 default. */
  resetScatterCofactor(idx: number): void {
    this.scatterCofactorOverride.delete(idx);
    this.invalidateChannel(idx);
  }

  /** Current flow-scatter arcsinh cofactor (default 150). */
  currentScatterCofactor(idx: number): number {
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      const shared = this.channelScales.scatterCofactor(this.workspaceScaleContextKey, key);
      if (shared !== undefined) return shared;
    }
    return this.scatterCofactorOverride.get(idx) ?? 150;
  }
  /** Override one flow-scatter cofactor; invalidates its display/gating caches. */
  setScatterCofactor(idx: number, cofactor: number): void {
    if (!Number.isFinite(cofactor) || cofactor <= 0) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.setScatterCofactor(this.workspaceScaleContextKey, key, cofactor);
      return;
    }
    this.scatterCofactorOverride.set(idx, cofactor);
    this.invalidateChannel(idx);
  }
  /** User-set flow-scatter cofactors, keyed by channel key (for workspace save). */
  scatterCofactorOverrides(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [idx, cofactor] of this.scatterCofactorOverride) {
      out[this.channels[idx].key] = cofactor;
    }
    if (this.channelScales) {
      // Shared settings are saved into every sample's record, so the on-disk format is
      // unchanged and a workspace written now still opens in an older build.
      const context = this.workspaceScaleContextKey;
      for (const channel of this.channels) {
        const shared = this.channelScales.scatterCofactor(context, channel.key);
        if (shared !== undefined) out[channel.key] = shared;
      }
    }
    return out;
  }
  /** Current logicle W (user override or auto). */
  currentLogicleW(idx: number): number {
    const shared = this.channelScales;
    const key = this.channels[idx]?.key;
    if (shared && key) {
      const context = this.workspaceScaleContextKey;
      const explicit = shared.logicleW(context, key);
      if (explicit !== undefined) return explicit;
      // The shared auto estimate, not this file's own: per-file estimates differ (0.500 vs
      // 1.143 on one real channel), which is what made a pooled cloud open already split.
      const auto = shared.autoLogicleW(context, key);
      if (auto !== undefined) return auto;
    }
    return this.wOverride.get(idx) ?? this.logicleParams(idx).w;
  }

  /** This file's own estimate, ignoring the shared owner. Used by it to derive the shared W. */
  ownAutoLogicleW(idx: number): number {
    return this.logicleParams(idx).w;
  }

  /** Invalidate one channel's display cache after a shared-scale change. */
  invalidateChannelForScales(idx: number): void {
    this.invalidateChannel(idx);
  }

  /** True when this channel is drawn on a linear scatter axis. */
  private scatterIsLinear(idx: number): boolean {
    const shared = this.channelScales;
    const key = this.channels[idx]?.key;
    if (shared && key) return shared.isScatterLinear(this.workspaceScaleContextKey, key);
    return this.scatterLinear.has(idx);
  }
  /** Override the logicle W for a channel; invalidates its cached display column. */
  setLogicleW(idx: number, w: number): void {
    // Guarded like setScatterScale. Without it a workspace-wide write lands on files where the
    // same channel key resolves to scatter or QC, persisting an override that does nothing but
    // churn this sample's display-transform identity.
    // Guarded on the channel's CLASS, not on what it currently displays: a channel switched to
    // arcsinh is still a fluorescence channel with a logicle W, and it must keep the W the user
    // set so switching back restores the axis they left. Guarding on isLogicleChannel() would
    // also make restore order load-bearing -- a workspace that applied its arcsinh keys before
    // its W overrides would silently drop every W.
    if (!this.isFluorChannel(idx)) return;
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      this.channelScales.setLogicleW(this.workspaceScaleContextKey, key, w);
      return;
    }
    this.wOverride.set(idx, Math.max(0.1, Math.min(w, 2.0)));
    this.invalidateChannel(idx);
  }
  /** User-set logicle W overrides, keyed by channel key (for workspace save). */
  logicleWOverrides(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [idx, w] of this.wOverride) out[this.channels[idx].key] = w;
    if (this.channelScales) {
      for (const [key, w] of Object.entries(
        this.channelScales.logicleWEntries(this.workspaceScaleContextKey),
      )) {
        if (this.byName.has(key)) out[key] = w;
      }
    }
    return out;
  }
  /** Clear a W override, reverting to the auto estimate. */
  resetLogicleW(idx: number): void {
    const key = this.channels[idx]?.key;
    if (this.channelScales && key) {
      // Reverts to the SHARED estimate. Reverting to each file's own estimate is what made the
      // reset button deterministically re-split a pooled cloud.
      this.channelScales.resetLogicleW(this.workspaceScaleContextKey, key);
      return;
    }
    this.wOverride.delete(idx);
    this.invalidateChannel(idx);
  }
  private invalidateChannel(idx: number): void {
    this.transformCache.delete(idx);
    this.displayCache.delete(idx);
    this.gatingCache.delete(idx);
    this.rangeCache.delete(idx);
  }

  index(channel: string): number | undefined {
    return this.byName.get(channel);
  }

  channelNames(): string[] {
    return this.channels.map((c) => c.key);
  }

  /** Display label for a resolved-channel index — the Panel-tab override, else the key. */
  channelLabel(idx: number): string {
    const channel = this.channels[idx];
    // A Panel-tab rename is an explicit instruction and always wins.
    if (channel.label) return channel.label;
    if (this.channelLabelMode === "channel-marker") {
      // $PnS is the marker, $PnN the detector it was measured on. Which of them the identity
      // key ended up as depends on the file, so the label is built from the PARTS rather than
      // decorating the key -- decorating would double up on a file whose key already carries
      // both, which is exactly what a spectral export produces.
      const marker = channel.marker?.trim();
      if (marker && marker !== channel.pnn) return `${marker} (${channel.pnn})`;
      return channel.pnn || channel.key;
    }
    return channel.key;
  }

  /**
   * How channels are named on axes, pickers and tables.
   *
   * A workspace can lose the fluorophore: a file whose $PnS is "CD19" resolves to the key
   * "CD19" and the detector never appears, even though $PnN still holds it and the Panel tab
   * shows it. This is a display choice, not an identity one -- gates, masks, compensation and
   * the workspace all key off `key`, so switching modes cannot move anything.
   */
  private channelLabelMode: ChannelLabelMode = "marker";

  setChannelLabelMode(mode: ChannelLabelMode): void {
    this.channelLabelMode = mode;
  }

  get labelMode(): ChannelLabelMode {
    return this.channelLabelMode;
  }

  /** Display label for a channel identity key (key unchanged if not found). */
  labelForKey(key: string): string {
    const i = this.byName.get(key);
    return i === undefined ? key : this.channelLabel(i);
  }

  /** Resolve a display label back to its identity key (identity for un-renamed channels). */
  keyForLabel(label: string): string {
    for (let i = 0; i < this.channels.length; i++) {
      if (this.channelLabel(i) === label) return this.channels[i].key;
    }
    return label; // already a key, or unknown
  }

  /** Set (or clear, when equal to the key / empty) a channel's Panel-tab display label. */
  setChannelLabel(idx: number, label: string): void {
    const key = this.channels[idx].key;
    const trimmed = label.trim();
    this.channels[idx].label = trimmed && trimmed !== key ? trimmed : undefined;
  }

  /** True when a channel may be renamed — scatter (FSC/SSC) and QC/Time channels are locked. */
  isRenamable(idx: number): boolean {
    const key = this.channels[idx].key;
    return !isQcChannel(key) && !isScatterChannel(key);
  }

  /** Non-default display labels, keyed by identity key (for workspace save). */
  labelOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    this.channels.forEach((c) => {
      if (c.label && c.label !== c.key) out[c.key] = c.label;
    });
    return out;
  }

  /** Restore display labels from a saved {key: label} map (workspace open). */
  applyLabelOverrides(map: Record<string, string>): void {
    for (const [key, label] of Object.entries(map ?? {})) {
      const i = this.byName.get(key);
      if (i !== undefined) this.setChannelLabel(i, label);
    }
  }

  transformKind(idx: number): ChannelTransform["kind"] {
    return this.transform(idx).kind;
  }

  /** Display-space column (what the plot shows). Cached. */
  displayColumn(idx: number): Float32Array {
    const hit = this.displayCache.get(idx);
    if (hit) return hit;
    const raw = this.activeLinearColumn(idx);
    const t = this.transform(idx);
    const out = new Float32Array(raw.length);
    if (t.kind === "identity") out.set(raw);
    else for (let i = 0; i < raw.length; i++) out[i] = t.forward(raw[i]);
    this.displayCache.set(idx, out);
    return out;
  }

  /** Gating-space column (masks run on this). Flow → raw; CyTOF → display. */
  gatingColumn(idx: number): NumericColumn {
    if (this.gatingSpace === "raw") return this.activeLinearColumn(idx);
    const hit = this.gatingCache.get(idx);
    if (hit) return hit;
    const col = this.displayColumn(idx); // CyTOF gating == display
    this.gatingCache.set(idx, col);
    return col;
  }

  /** Convert one axis coordinate gating → display (for rendering gates). */
  gatingToDisplay(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    if (idx === undefined) return v;
    return this.gatingSpace === "raw" ? this.transform(idx).forward(v) : v;
  }

  /** Convert one axis coordinate display → gating (for storing a drawn gate). */
  displayToGating(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    if (idx === undefined) return v;
    return this.gatingSpace === "raw" ? this.transform(idx).inverse(v) : v;
  }

  /** Convert a compensated linear measurement into this app's display coordinates. */
  rawToDisplay(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    return idx === undefined ? v : this.transform(idx).forward(v);
  }

  /** Convert this app's display coordinate into compensated linear measurement space. */
  displayToRaw(channel: string, v: number): number {
    const idx = this.byName.get(channel);
    return idx === undefined ? v : this.transform(idx).inverse(v);
  }

  /** AssayData over gating columns, for getGateMask / applyGatingStrategy. */
  gatingData(): AssayData {
    return {
      n: this.fcs.nEvents,
      column: (ch) => {
        const i = this.byName.get(ch);
        return i === undefined ? undefined : this.gatingColumn(i);
      },
    };
  }

  /**
   * Columns resolved per gate, for the whole gating strategy.
   *
   * This is what evaluation must use: a workspace can hold gates in different spaces, and each
   * has to be tested against its own columns. Handing one AssayData to every gate is what made a
   * display-space gate count zero events — its arcsinh vertices were compared with raw values.
   */
  gateAssayData(): GateAssayData {
    return { n: this.fcs.nEvents, forGate: (gate) => this.gatingDataFor(gate) };
  }

  /**
   * The current display transform for one channel, in serialisable form.
   *
   * Mirrors transform() branch for branch. They must not drift, so
   * sample.transformSpec.test.ts asserts transformFromSpec(transformSpec(k)) reproduces
   * transform(idx) numerically for every channel of every fixture.
   */
  transformSpec(channelKey: string): TransformSpec {
    const idx = this.byName.get(channelKey);
    if (idx === undefined) return { kind: "identity" };
    const t = this.transform(idx);
    if (t.kind === "identity") return { kind: "identity" };
    if (t.kind === "logicle") {
      return { kind: "logicle", T: this.logicleT(idx), W: this.currentLogicleW(idx), M: 4.5, A: 0 };
    }
    if (this.instrument === "cytof") return { kind: "asinh", cofactor: this.cytofCofactor };
    const { key, pnn } = this.channels[idx];
    if (isScatterChannel(key) || isScatterChannel(pnn)) {
      return { kind: "asinh", cofactor: this.currentScatterCofactor(idx) };
    }
    // A fluorescence channel on arcsinh (chosen), or the unhealthy-logicle fallback: both
    // display asinh at the channel's current fluor cofactor, and the spec says so.
    return { kind: "asinh", cofactor: this.currentFluorCofactor(idx) };
  }

  /** Snapshot every axis of a gate at the current display transforms. */
  gateTransformSnapshot(xChannel: string, yChannel: string): Record<string, TransformSpec> {
    return { [xChannel]: this.transformSpec(xChannel), [yChannel]: this.transformSpec(yChannel) };
  }

  /** The space a gate's vertices live in; absent means this sample's pre-field default. */
  gateSpace(gate: GateSpaceRef): GateSpace {
    return gate.space ?? this.gatingSpace;
  }

  /**
   * One of a gate's stored coordinates → raw.
   *
   * A display-space gate's vertices are in ITS OWN recorded transform, which need not be the one
   * currently on screen, so this inverts the gate's transform and never the sample's.
   */
  gateToRaw(gate: GateSpaceRef, channel: string, v: number): number {
    if (this.gateSpace(gate) === "raw") return v;
    const spec = gate.transforms?.[channel];
    if (!spec) return this.displayToRaw(channel, v); // legacy CyTOF: read in the current display
    return transformFromSpec(spec).inverse(v);
  }

  /** Raw → the space this gate stores its vertices in. */
  rawToGate(gate: GateSpaceRef, channel: string, v: number): number {
    if (this.gateSpace(gate) === "raw") return v;
    const spec = gate.transforms?.[channel];
    if (!spec) return this.rawToDisplay(channel, v);
    return transformFromSpec(spec).forward(v);
  }

  /**
   * A gate's stored coordinate → the current display space, for drawing.
   *
   * Via raw, so that a gate drawn under one transform and viewed under another lands where it
   * actually falls. When the two transforms agree the round trip is exact and the gate draws
   * straight; when they differ, the difference IS the bow, which is the signal we want shown.
   */
  gateToDisplay(gate: GateSpaceRef, channel: string, v: number): number {
    return this.rawToDisplay(channel, this.gateToRaw(gate, channel, v));
  }

  /** A coordinate read off the current plot → the space this gate stores its vertices in. */
  displayToGate(gate: GateSpaceRef, channel: string, v: number): number {
    return this.rawToGate(gate, channel, this.displayToRaw(channel, v));
  }

  /** Snapshot to attach to a NEW gate being created in `space` on these axes. */
  newGateSpaceFields(space: GateSpace, xChannel: string, yChannel: string): GateSpaceRef {
    return space === "raw"
      ? { space }
      : { space, transforms: this.gateTransformSnapshot(xChannel, yChannel) };
  }

  /**
   * AssayData in the space THIS gate's vertices live in.
   *
   * A workspace can legitimately hold both kinds at once — importing a FlowJo .wsp brings in
   * display-space gates alongside gates drawn here in raw space — so the columns a mask runs on
   * are a property of the gate, never of the sample's current view.
   */
  gatingDataFor(gate: Gate): AssayData {
    const space = this.gateSpace(gate);
    if (space === "raw") {
      return {
        n: this.fcs.nEvents,
        column: (ch) => {
          const i = this.byName.get(ch);
          return i === undefined ? undefined : this.activeLinearColumn(i);
        },
      };
    }
    const specs = gate.transforms;
    // No snapshot: a legacy CyTOF gate, which has always been read in the current display space.
    if (!specs) return this.gatingData();
    return {
      n: this.fcs.nEvents,
      column: (ch) => {
        const i = this.byName.get(ch);
        if (i === undefined) return undefined;
        const spec = specs[ch];
        return spec ? this.pinnedColumn(i, spec) : this.gatingColumn(i);
      },
    };
  }

  /** Raw column pushed through a gate's own recorded transform. Cached per (channel, spec). */
  private pinnedColumn(idx: number, spec: TransformSpec): NumericColumn {
    const prefix = `${this.activeAssayBindingKey}|`;
    const key = `${prefix}${idx}|${JSON.stringify(spec)}`;
    const hit = this.pinnedCache.get(key);
    if (hit) return hit;
    // Evict columns pinned under OTHER assay bindings before adding one. Each entry is
    // nEvents x 4 bytes, and nothing else ever clears this cache -- a session that toggled
    // compensation while holding several imported .wsp gates accumulated a full set of pinned
    // columns per layer, forever. Correctness never depended on this (the binding key already
    // prevents stale hits); it is purely the memory bound.
    for (const k of this.pinnedCache.keys()) {
      if (!k.startsWith(prefix)) this.pinnedCache.delete(k);
    }
    const raw = this.activeLinearColumn(idx);
    const t = transformFromSpec(spec);
    const out = new Float32Array(raw.length);
    if (t.kind === "identity") out.set(raw);
    else for (let i = 0; i < raw.length; i++) out[i] = t.forward(raw[i]);
    this.pinnedCache.set(key, out);
    return out;
  }

  /** Robust auto display range for an axis (0.1st–99.9th percentiles), cached. */
  displayRange(idx: number): [number, number] {
    const hit = this.rangeCache.get(idx);
    if (hit) return hit;
    const r = robustAxisRange(this.displayColumn(idx));
    this.rangeCache.set(idx, r);
    return r;
  }
  private readonly rangeCache = new Map<number, [number, number]>();

  /**
   * Display-space axis ticks for a channel over the given visible range (mirrors
   * GateLabR generate_channel_ticks): flow scatter → decade log ticks, flow signal →
   * logicle decade ticks, CyTOF metal / QC → null (cytof_plot.js falls back to D3's
   * linear ticks). Recomputed per view because the tick set depends on the visible range.
   */
  channelTicks(idx: number, axisRange: [number, number]): AxisTicks | null {
    const name = this.channels[idx].key;
    if (isQcChannel(name)) return null;
    const t = this.transform(idx);
    const fwd = (v: number) => t.forward(v);
    const inv = (v: number) => t.inverse(v);
    // Flow scatter (FSC/SSC): asinh display, raw-unit decade labels (1K/10K/100K).
    // On a LINEAR scatter axis the transform is the identity, and those decade labels
    // pile up against the low end of the axis and overlap illegibly — 10K, 100K and 1M
    // land within a few pixels of each other. Evenly spaced linear ticks are correct
    // there, so fall through to the D3 default.
    if (this.instrument === "flow" && isScatterChannel(name)) {
      // A linear scatter axis is the identity transform. Raw-unit DECADE labels pile up
      // against its low end and overlap illegibly, so it gets evenly spaced ticks — but
      // still with the K/M labels the rest of the app uses, not D3's "10,000,000".
      return t.kind === "identity"
        ? linearScatterTicks(axisRange)
        : scatterTicks(fwd, inv, axisRange, this.currentScatterCofactor(idx));
    }
    // Flow signal (fluorophore): logicle display, biexponential decade labels.
    if (t.kind === "logicle") {
      return logicleTicks(fwd, inv, axisRange, this.logicleParams(idx).t);
    }
    // Flow signal on arcsinh -- either chosen, or the unhealthy-logicle fallback. scatterTicks
    // is not scatter-specific: it lays out raw-unit decades over the visible range and is what
    // any asinh axis needs. Without it the axis fell through to D3's linear ticks and was
    // labelled in DISPLAY units (-2, 0, 2, 4 …), which name nothing a cytometrist can read.
    if (this.instrument === "flow" && t.kind === "asinh") {
      return scatterTicks(fwd, inv, axisRange, this.currentFluorCofactor(idx));
    }
    return null; // CyTOF metal / identity → D3 default linear ticks
  }

  /**
   * Build a cytof_plot.js render payload for the chosen display channels.
   * `mask` restricts plotted events to a population; `xRange`/`yRange` override the
   * auto axis range (pan/zoom + Min/Max controls). Plotted points are capped at
   * `plotCap` for speed — gating/counts are unaffected (they use the full masks).
   */
  plotPayload(
    xIdx: number,
    yIdx: number,
    mode: DisplayMode,
    gates: unknown[] = [],
    mask?: Uint8Array | null,
    selectedGateId?: string | null,
    xRange?: [number, number] | null,
    yRange?: [number, number] | null,
    plotCap = PLOT_CAP,
    contourThreshold = 5,
    overlay?: OverlaySpec | null,
  ): ScatterPayload {
    const xdFull = this.displayColumn(xIdx);
    const ydFull = this.displayColumn(yIdx);

    // Ticks depend on the visible range → compute from the effective (possibly panned) range.
    // Automatic axes are data-only and must remain invariant while gates are moved or edited.
    // Gate-aware fitting is an explicit App action that supplies fixed xRange/yRange overrides.
    const xr = xRange ?? this.displayRange(xIdx);
    const yr = yRange ?? this.displayRange(yIdx);
    const xTicks = this.channelTicks(xIdx, xr);
    const yTicks = this.channelTicks(yIdx, yr);

    // Which event indices to plot (masked population, or all). When a population is
    // larger than the plot cap, collect the evenly-spaced sample directly into the
    // capped array: allocating an Int32Array for every selected event (often millions)
    // only to discard it immediately caused severe GC pressure while switching pops.
    let indices: Int32Array | null = null;
    let plottedN = xdFull.length;
    const cap = Number.isFinite(plotCap) && plotCap > 0
      ? Math.max(1, Math.floor(plotCap))
      : null;
    if (mask) {
      let c = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
      plottedN = c;
      if (cap !== null && c > cap) {
        indices = new Int32Array(cap);
        const denom = cap > 1 ? cap - 1 : 1;
        let samplePos = 0;
        let memberPos = 0;
        let target = 0;
        for (let i = 0; i < mask.length && samplePos < cap; i++) {
          if (!mask[i]) continue;
          if (memberPos === target) {
            indices[samplePos++] = i;
            target = samplePos < cap
              ? Math.round((samplePos * (c - 1)) / denom)
              : c;
          }
          memberPos++;
        }
      } else {
        indices = new Int32Array(c);
        let k = 0;
        for (let i = 0; i < mask.length; i++) if (mask[i]) indices[k++] = i;
      }
    }

    // Downsample for display (GateLabR: idx[round(seq(1, N, length.out = cap))]) — keep
    // evenly-spaced points; deterministic → stable across pan/zoom. cap <= 0 or Infinity
    // = no downsampling ("0 = all"). Counts/gating are untouched.
    if (!mask && cap !== null && plottedN > cap) {
      const sub = new Int32Array(cap);
      const denom = cap > 1 ? cap - 1 : 1;
      for (let k = 0; k < cap; k++) {
        const j = Math.round((k * (plottedN - 1)) / denom);
        sub[k] = j;
      }
      indices = sub;
    }

    let xd: Float32Array;
    let yd: Float32Array;
    if (indices) {
      xd = new Float32Array(indices.length);
      yd = new Float32Array(indices.length);
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        xd[k] = xdFull[i];
        yd[k] = ydFull[i];
      }
    } else {
      xd = xdFull;
      yd = ydFull;
    }

    // Colour overlay: subset the per-event palette index in lock-step with the plotted points.
    let overlayFields: Partial<ScatterPayload> = {};
    if (overlay) {
      const src = overlay.colors;
      let cd: Uint8Array;
      if (indices) {
        cd = new Uint8Array(indices.length);
        for (let k = 0; k < indices.length; k++) cd[k] = src[indices[k]] ?? 0;
      } else {
        cd = src.length === xd.length ? src : src.slice(0, xd.length);
      }
      overlayFields = {
        overlay_mode: true,
        color_b64: encodeUint8Base64(cd),
        color_palette: overlay.palette,
        color_labels: overlay.labels,
      };
    }

    return {
      x_b64: encodeFloat32Base64(xd),
      y_b64: encodeFloat32Base64(yd),
      // x_label doubles as the gate channel identifier in cytof_plot.js (gate.x_channel
      // === x_label), so it must be the resolved channel key the Sample indexes by.
      x_label: this.channels[xIdx].key,
      y_label: this.channels[yIdx].key,
      x_range: xr,
      y_range: yr,
      display_mode: mode,
      point_alpha: 0.4,
      density_color_power: DEFAULT_DENSITY_COLOR_POWER,
      contour_threshold: contourThreshold,
      n_events: plottedN, // true population size (title); plotted array may be capped
      gates,
      selected_gate_id: selectedGateId ?? null,
      channels: this.channels.map((c) => c.key),
      // The display binding for each axis: every setting that can change that channel's
      // transform. The contour cache is built in display space, so without this a W change
      // rescales the axes and moves the gates while the cached density stays where it was.
      // Both channels' transforms have just been materialised by displayColumn(), so this
      // costs a string, not a re-derivation.
      x_binding: this.displayCoordinateBindingKey(this.channels[xIdx].key),
      y_binding: this.displayCoordinateBindingKey(this.channels[yIdx].key),
      x_is_logicle: xTicks !== null,
      y_is_logicle: yTicks !== null,
      x_logicle_ticks: xTicks,
      y_logicle_ticks: yTicks,
      ...overlayFields,
    };
  }

  /**
   * Initial biplot axes. Flow opens on FSC vs SSC (area/integral preferred), matching
   * the conventional first view of an FCS file; CyTOF keeps the first two non-QC markers.
   */
  defaultChannelIndices(): [number, number] {
    const usable: number[] = [];
    this.channels.forEach((c, i) => {
      if (!isQcChannel(c.key)) usable.push(i);
    });

    if (this.instrument !== "flow") {
      const x = usable[0] ?? 0;
      const y = usable[1] ?? Math.min(1, this.channels.length - 1);
      return [x, y];
    }

    const scatter = usable
      .map((index) => ({ index, role: scatterRole(this.channels[index]) }))
      .filter((entry): entry is { index: number; role: ScatterRole } => entry.role !== null)
      .sort((a, b) =>
        scatterPreference(this.channels[a.index]) - scatterPreference(this.channels[b.index]) ||
        a.index - b.index,
      );
    const forward = scatter.find((entry) => entry.role === "forward")?.index;
    const side = scatter.find((entry) => entry.role === "side")?.index;
    const x = forward ?? scatter[0]?.index ?? usable[0] ?? 0;
    const y = side ?? scatter.find((entry) => entry.index !== x)?.index ??
      usable.find((index) => index !== x) ?? Math.min(1, this.channels.length - 1);
    return [x, y];
  }
}
