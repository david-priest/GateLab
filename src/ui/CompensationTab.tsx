import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DEFAULT_DENSITY_COLOR_POWER } from "../engine/pseudocolor";
import {
  reportMatrixCompatibility,
  type MatrixCompatibilityReport,
} from "../engine/compensationCompatibility";
import {
  parseCompensationMatrixTable,
  type ParsedCompensationMatrixTable,
} from "../engine/compensationMatrixImport";
import {
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationProfileHashInput,
  type MatrixValidationIssue,
} from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  createCompensationProfileRevision,
  createResetToBaselineRevision,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import {
  CYTOF_NNLS_SOLVER_VERSION,
  DEFAULT_CYTOF_NNLS_SETTINGS,
} from "../engine/cytofCompensationEngine";
import {
  DEFAULT_FLOW_SOLVER_SETTINGS,
  FLOW_SOLVER_VERSION,
} from "../engine/flowCompensationEngine";
import {
  cytofInteractionType,
  cytofMatrixForDisplay,
  type CytofInteractionType,
} from "../engine/compensationMatrixView";
import {
  buildCompensationPairPreview,
  buildSolvedCompensationPairPreview,
  deterministicCompensationEventIndices,
  type CompensationPairEvidence,
  type CompensationPairPreview,
} from "../engine/compensationPairPreview";
import {
  assessCompensationEvidence,
  rankConservativeCompensationAttention,
  type CompensationEvidenceMode,
} from "../engine/compensationAttention";
import {
  buildCompensationGlobalInspectorDataset,
  buildCompensationGlobalPairPreview,
  type CompensationGlobalInspectorDataset,
} from "../engine/compensationGlobalInspector";
import type { CompensationApplyProgress } from "../engine/compensationManager";
import type { PreviewSolvedResponse } from "../workers/compensationProtocol";
import type { Sample } from "../engine/sample";
import {
  exportCompensationComparison,
  type CompensationComparisonExportFormat,
  type CompensationComparisonExportProgress,
} from "../plots/compensationComparisonExport";
import { CompensationComparisonExportDialog } from "./CompensationComparisonExportDialog";
import { CompensationMatrixExportDialog } from "./CompensationMatrixExportDialog";
import { usePersistedTabState } from "./tabState";
import { DensityColourControl } from "./DensityColourControl";
import { useI18n } from "./i18n";
import {
  compensationMatrixCellAppearance,
  percentText,
  significantNumber,
} from "./compensationUiFormat";
import { ScrubbableNumberInput } from "./ScrubbableNumberInput";
import {
  CompensationPairBiplots,
  CompensationPointAlphaContext,
  DensityBiplot,
  DensityColorPowerContext,
  GlobalCompensationPlotTile,
  GlobalInspectorLayerScope,
  MiniCompensationMatrix,
  type CompensationGlobalPairCandidate,
  type CompensationMatrixView,
} from "./CompensationPlots";

interface Props {
  sample: Sample;
  sampleName?: string;
  compensationOn: boolean;
  onApplyProfile?: (
    profile: CompensationProfileRecord,
    onProgress?: (progress: CompensationApplyProgress) => void,
  ) => Promise<void>;
  onCancelApply?: () => void;
  hasExistingGates?: boolean;
  applyStatus?: CompensationApplyUiStatus | null;
  installedProfile?: CompensationProfileRecord | null;
  applyWorkerCount?: number;
  applyWorkerLimit?: number;
  onApplyWorkerCountChange?: (count: number) => void;
  installedBaselineProfile?: CompensationProfileRecord | null;
  reviewPopulations?: readonly CompensationReviewPopulation[];
  reviewPopulationMasks?: Readonly<Record<string, Uint8Array>>;
  onPreviewCompensationCandidate?: CompensationCandidatePreviewSolver;
  onSolveCompensationSweep?: CompensationSweepSolver;
  onCancelCompensationSweep?: () => void;
  onSuspendBackgroundWork?: () => void;
  visible?: boolean;
  stateKey: string;
  densityColorPower?: number;
  onDensityColorPowerChange?: (value: number) => void;
}

export interface CompensationReviewPopulation {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly eventCount: number;
}

export type CompensationSweepSolver = (
  profile: CompensationProfileRecord,
  fixedEventIndices: Uint32Array,
  candidateMatrices: readonly (readonly (readonly number[])[])[],
  onProgress?: (completed: number, total: number) => void,
  workerCount?: number,
) => Promise<readonly PreviewSolvedResponse[]>;

export type CompensationCandidatePreviewSolver = (
  profile: CompensationProfileRecord,
  fixedEventIndices: Uint32Array,
  candidateMatrix: readonly (readonly number[])[],
) => Promise<PreviewSolvedResponse>;

export interface CompensationApplyUiStatus {
  readonly phase: "preparing" | "applying" | "cancelling";
  /** Restore rehydrates a saved derived assay; omitted/"apply" is an interactive Apply. */
  readonly operation?: "apply" | "restore";
  readonly profileName: string;
  readonly fraction: number;
  readonly processedEvents: number;
  readonly totalEvents: number;
}

interface CytofMatrixDraft {
  readonly fileName: string;
  readonly parsed: ParsedCompensationMatrixTable;
  readonly matrix: CanonicalCompensationMatrix;
  readonly validationWarnings: readonly MatrixValidationIssue[];
}

interface CompensationImpactSummary {
  readonly previewEvents: number;
  readonly comparedValues: number;
  readonly changedValues: number;
  readonly medianAbsoluteDelta: number;
  readonly maxAbsoluteDelta: number;
  readonly zeroedNegativeValues: number;
  readonly mostChangedChannel: string;
  readonly mostChangedChannelMedianDelta: number;
}

interface CompensationEvidenceCandidate {
  readonly sourceIndex: number;
  readonly receiverIndex: number;
  readonly pairKey: string;
  readonly source: ReturnType<typeof channelDisplay>;
  readonly receiver: ReturnType<typeof channelDisplay>;
  readonly coefficient: number;
  readonly interaction: CytofInteractionType | null;
  readonly physicalPrior: number;
  readonly evidence: CompensationPairEvidence;
  readonly relativePriority: number;
}

interface CompensationSweepValue {
  readonly value: number;
  readonly isCurrent: boolean;
  readonly preview: CompensationPairPreview;
}

interface CompensationPairSweep {
  readonly pairKey: string;
  readonly values: readonly CompensationSweepValue[];
}

interface CompensationSweepBoundsDraft {
  readonly lowerPercent: string;
  readonly upperPercent: string;
}

type FlowCandidatePreviewState =
  | { readonly state: "idle" }
  | {
      readonly state: "updating";
      readonly pairKey: string;
      readonly preview?: CompensationPairPreview;
    }
  | {
      readonly state: "ready";
      readonly pairKey: string;
      readonly preview: CompensationPairPreview;
    }
  | { readonly state: "error"; readonly pairKey: string; readonly message: string };

type CompensationWorkspaceView = "matrix" | "global" | "attention";
type CompensationGlobalPairFilter = "relevant" | "nonzero" | "physical" | "flagged" | "all";
type CompensationGlobalLayout = "compact" | "source" | "receiver";

const GLOBAL_PAIR_FILTER_LABELS: Readonly<Record<CompensationGlobalPairFilter, string>> = {
  relevant: "Matrix-linked / relevant",
  nonzero: "Non-zero coefficients",
  physical: "Physical CyTOF relationships",
  flagged: "Flagged for follow-up",
  all: "All included pairs",
};

type DrawerId = "evidence" | "review";

const DRAWERS: ReadonlyArray<Readonly<{ id: DrawerId; label: string }>> = [
  { id: "evidence", label: "Evidence" },
  { id: "review", label: "Review queue" },
];

const PAIR_SEPARATOR = "\u001f";
const SWEEP_EVENT_LIMIT = 2_500;
const BOUNDS_PREVIEW_EVENT_LIMIT = 400;
const GLOBAL_INSPECTOR_EVENT_LIMIT = 2_500;
const DEFAULT_PAIR_PREVIEW_EVENT_LIMIT = 15_000;
const PAIR_PREVIEW_EVENT_LIMITS = [2_500, 5_000, 15_000, 50_000] as const;
type PairPreviewEventLimit = typeof PAIR_PREVIEW_EVENT_LIMITS[number] | "all";
const FLOW_INLINE_MATRIX_LIMIT = 24;
const MAX_SWEEP_WORKERS = 4;
const DEFAULT_INSPECTOR_WIDTH = 624;
const EMPTY_POPULATION_MASKS: Readonly<Record<string, Uint8Array>> = Object.freeze({});

function editableCoefficientPercent(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const percent = value * 100;
  if (percent === 0) return "0.0";
  const absolute = Math.abs(percent);
  const digits = absolute >= 1 ? 1 : absolute >= 0.1 ? 2 : 3;
  return percent.toFixed(digits);
}

function compensationProfileBaseName(name: string): string {
  return name.replace(/(?: · (?:edited|revised))+$/u, "");
}

function channelDisplay(sample: Sample, key: string): Readonly<{
  key: string;
  pnn: string;
  label: string;
  combined: string;
}> {
  const index = sample.index(key);
  const pnn = index === undefined ? key : sample.channels[index].pnn;
  const label = sample.labelForKey(key);
  return {
    key,
    pnn,
    label,
    combined: label === pnn ? pnn : `${label} (${pnn})`,
  };
}

function channelDisplayForPnn(sample: Sample, pnn: string): ReturnType<typeof channelDisplay> {
  const channel = sample.channels.find((candidate) => candidate.pnn === pnn);
  return channelDisplay(sample, channel?.key ?? pnn);
}

function methodLabel(kind: "flow-spillover" | "cytof-spillover", method: "matrix-inverse" | "nnls"): string {
  if (kind === "cytof-spillover" && method === "nnls") return "CyTOF NNLS";
  return "Flow linear inverse";
}

function reasonLabel(reason: string): string {
  return reason.replaceAll("-", " ");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function solverSettingsObject(profile: CompensationProfileRecord): Record<string, string | number | boolean> {
  return Object.fromEntries(profile.scientific.solverSettings.map(({ key, value }) => [key, value]));
}

function scientificCandidate(
  profile: CompensationProfileRecord,
  matrix: readonly (readonly number[])[],
): CompensationProfileHashInput {
  const canonicalMatrix = Object.freeze({ ...profile.scientific.matrix, matrix });
  const settings = solverSettingsObject(profile);
  return profile.scientific.kind === "flow-spillover"
    ? {
        kind: "flow-spillover",
        method: "matrix-inverse",
        solverVersion: profile.scientific.solverVersion,
        solverSettings: {
          singularTolerance: Number(settings.singularTolerance),
          conditionWarningThreshold: Number(settings.conditionWarningThreshold),
        },
        matrix: canonicalMatrix,
      }
    : {
        kind: "cytof-spillover",
        method: "nnls",
        solverVersion: profile.scientific.solverVersion,
        solverSettings: {
          tolerance: Number(settings.tolerance),
          kktTolerance: Number(settings.kktTolerance),
          maxIterations: Number(settings.maxIterations),
          adaptationVersion: String(settings.adaptationVersion),
        },
        matrix: canonicalMatrix,
        includedChannels: profile.scientific.includedChannels,
      };
}

function matrixWithCoefficient(
  profile: CompensationProfileRecord,
  sourceKey: string,
  receiverKey: string,
  value: number,
): readonly (readonly number[])[] {
  const sourceIndex = profile.scientific.matrix.sourceChannels.indexOf(sourceKey);
  const receiverIndex = profile.scientific.matrix.receiverChannels.indexOf(receiverKey);
  if (sourceIndex < 0 || receiverIndex < 0) {
    throw new Error("The selected coefficient is absent from the installed profile axes.");
  }
  return Object.freeze(profile.scientific.matrix.matrix.map((row, rowIndex) =>
    Object.freeze(row.map((coefficient, columnIndex) =>
      rowIndex === sourceIndex && columnIndex === receiverIndex ? value : coefficient)),
  ));
}

function profileCoefficient(
  profile: CompensationProfileRecord | null | undefined,
  sourceKey: string,
  receiverKey: string,
): number | null {
  if (!profile) return null;
  const sourceIndex = profile.scientific.matrix.sourceChannels.indexOf(sourceKey);
  const receiverIndex = profile.scientific.matrix.receiverChannels.indexOf(receiverKey);
  if (sourceIndex < 0 || receiverIndex < 0) return null;
  const value = profile.scientific.matrix.matrix[sourceIndex]?.[receiverIndex];
  return Number.isFinite(value) ? value : null;
}

function defaultSweepBounds(
  current: number,
  reference: number,
  kind: "flow" | "cytof",
): Readonly<{ lower: number; upper: number }> {
  const span = Math.max(Math.abs(current), Math.abs(reference), 0.001);
  if (kind === "cytof") {
    return Object.freeze({ lower: 0, upper: Math.max(current + span, span * 2) });
  }
  return Object.freeze({ lower: current - span, upper: current + span });
}

function interpolatedSweepValues(lower: number, upper: number): readonly number[] {
  const step = (upper - lower) / 3;
  return Object.freeze([lower, lower + step, lower + 2 * step, upper]);
}

function exactSameMatrix(
  left: readonly (readonly number[])[],
  right: readonly (readonly number[])[],
): boolean {
  return left.length === right.length && left.every((row, index) =>
    row.length === right[index]?.length && row.every((value, column) => value === right[index][column]));
}

function summarizeInstalledCompensation(
  sample: Sample,
  includedPnns: readonly string[],
): CompensationImpactSummary | null {
  const status = sample.compensatedLayerStatus();
  if (status.state !== "ready" || includedPnns.length === 0 || sample.fcs.nEvents === 0) return null;
  const indices = includedPnns.flatMap((pnn) => {
    const index = sample.channels.findIndex((channel) => channel.pnn === pnn);
    return index < 0 ? [] : [index];
  });
  if (indices.length === 0) return null;

  const previewEvents = Math.min(2048, sample.fcs.nEvents);
  const allDeltas: number[] = [];
  let changedValues = 0;
  let maxAbsoluteDelta = 0;
  let zeroedNegativeValues = 0;
  let mostChangedChannel = "";
  let mostChangedChannelMedianDelta = -1;

  for (const index of indices) {
    const original = sample.originalColumnData(index);
    const compensated = sample.compensatedColumnData(index);
    const channelDeltas: number[] = [];
    for (let previewIndex = 0; previewIndex < previewEvents; previewIndex++) {
      const event = previewEvents === 1
        ? 0
        : Math.floor(previewIndex * (sample.fcs.nEvents - 1) / (previewEvents - 1));
      const before = original[event];
      const after = compensated[event];
      const delta = Math.abs(after - before);
      channelDeltas.push(delta);
      allDeltas.push(delta);
      if (delta > Math.max(1e-6, Math.abs(before) * 1e-6)) changedValues++;
      if (before < 0 && after === 0) zeroedNegativeValues++;
      maxAbsoluteDelta = Math.max(maxAbsoluteDelta, delta);
    }
    const channelMedian = median(channelDeltas);
    if (channelMedian > mostChangedChannelMedianDelta) {
      mostChangedChannelMedianDelta = channelMedian;
      mostChangedChannel = channelDisplay(sample, sample.channels[index].key).combined;
    }
  }

  return {
    previewEvents,
    comparedValues: allDeltas.length,
    changedValues,
    medianAbsoluteDelta: median(allDeltas),
    maxAbsoluteDelta,
    zeroedNegativeValues,
    mostChangedChannel,
    mostChangedChannelMedianDelta: Math.max(0, mostChangedChannelMedianDelta),
  };
}

function profileOriginText(profile: CompensationProfileRecord, translate: (source: string) => string): string {
  if (profile.origin.type === "uploaded") return profile.origin.fileName;
  if (profile.origin.type === "embedded-fcs") return `${profile.origin.fileName} · ${translate("embedded FCS")}`;
  return `${profile.origin.presetId} · ${translate("bundled preset")} ${profile.origin.presetVersion}`;
}

function CompensationTabImpl({
  sample,
  sampleName = "sample.fcs",
  compensationOn,
  onApplyProfile,
  onCancelApply,
  hasExistingGates = false,
  applyStatus = null,
  installedProfile = null,
  applyWorkerCount,
  applyWorkerLimit,
  onApplyWorkerCountChange,
  installedBaselineProfile = null,
  reviewPopulations = [],
  reviewPopulationMasks = EMPTY_POPULATION_MASKS,
  onPreviewCompensationCandidate,
  onSolveCompensationSweep,
  onCancelCompensationSweep,
  onSuspendBackgroundWork,
  visible = true,
  stateKey,
  densityColorPower = DEFAULT_DENSITY_COLOR_POWER,
  onDensityColorPowerChange = () => undefined,
}: Props) {
  const { t } = useI18n();
  const installedStatus = sample.compensatedLayerStatus();
  const installedMetadata = installedStatus.state === "missing" ? null : installedStatus.metadata;
  const profileMetadata = installedMetadata?.runtimeIdentity === "profile" ? installedMetadata : null;
  const profileRecord = installedProfile?.profileId === profileMetadata?.profileId
    ? installedProfile
    : null;
  // A profile-derived result and the embedded FCS matrix are different scientific sources. Never
  // present the embedded matrix as the active profile's coefficients.
  const spill = !profileMetadata && sample.instrument === "flow" ? sample.spillover : null;
  const [selectedPairKey, setSelectedPairKey] = usePersistedTabState<string | null>(
    `compensation.${stateKey}.selectedPair`,
    null,
  );
  const [hoveredPairKey, setHoveredPairKey] = useState<string | null>(null);
  const [openDrawers, setOpenDrawers] = usePersistedTabState<Record<DrawerId, boolean>>(
    `compensation.${stateKey}.openDrawers`,
    { evidence: false, review: false },
  );
  const [inspectorWidth, setInspectorWidth] = usePersistedTabState<number>(
    "compensation.inspectorWidth",
    DEFAULT_INSPECTOR_WIDTH,
  );
  const [workspaceView, setWorkspaceView] = usePersistedTabState<CompensationWorkspaceView>(
    `compensation.${stateKey}.workspaceView`,
    "matrix",
  );
  const [globalPairFilter, setGlobalPairFilter] = usePersistedTabState<CompensationGlobalPairFilter>(
    `compensation.${stateKey}.globalPairFilter`,
    "relevant",
  );
  const [globalLayout, setGlobalLayout] = usePersistedTabState<CompensationGlobalLayout>(
    `compensation.${stateKey}.globalLayout`,
    "compact",
  );
  const [globalPlotSize, setGlobalPlotSize] = usePersistedTabState<number>(
    "compensation.globalPlotSize.v5",
    160,
  );
  const [densitySmoothing, setDensitySmoothing] = usePersistedTabState<number>(
    "compensation.densitySmoothing.v3",
    6,
  );
  const [pointAlpha, setPointAlpha] = usePersistedTabState<number>(
    "compensation.pointAlpha.v1",
    0.85,
  );
  const [pairPreviewEventLimit, setPairPreviewEventLimit] = usePersistedTabState<PairPreviewEventLimit>(
    "compensation.pairPreviewEventLimit.v1",
    DEFAULT_PAIR_PREVIEW_EVENT_LIMIT,
  );
  const [globalPairSearch, setGlobalPairSearch] = useState("");
  const [globalInspectorDetailsOpen, setGlobalInspectorDetailsOpen] = useState(false);
  const [pendingGlobalScrollPairKey, setPendingGlobalScrollPairKey] = useState<string | null>(null);
  const [reviewPopulationId, setReviewPopulationId] = usePersistedTabState<string>(
    `compensation.${stateKey}.reviewPopulation`,
    "all",
  );
  const [flaggedPairKeys, setFlaggedPairKeys] = usePersistedTabState<string[]>(
    `compensation.${stateKey}.flaggedPairs`,
    [],
  );
  const [evidenceMode, setEvidenceMode] = usePersistedTabState<CompensationEvidenceMode>(
    `compensation.${stateKey}.evidenceMode`,
    "biological",
  );
  const [sweepBoundsDrafts, setSweepBoundsDrafts] = usePersistedTabState<Record<string, CompensationSweepBoundsDraft>>(
    `compensation.${stateKey}.sweepBounds`,
    {},
  );
  const [sweepWorkerCount, setSweepWorkerCount] = usePersistedTabState<number>(
    `compensation.${stateKey}.sweepWorkers`,
    2,
  );
  const [manualSourceKey, setManualSourceKey] = useState("");
  const [manualReceiverKey, setManualReceiverKey] = useState("");
  const [attentionScanRevision, setAttentionScanRevision] = useState(0);
  const [stagedCoefficients, setStagedCoefficients] = useState<Record<string, number>>({});
  const [matrixCellDraftPercents, setMatrixCellDraftPercents] = useState<Record<string, string>>({});
  const [flowCandidatePreview, setFlowCandidatePreview] = useState<FlowCandidatePreviewState>({ state: "idle" });
  const [sweepResults, setSweepResults] = useState<Record<string, CompensationPairSweep>>({});
  const [boundsPreviewResults, setBoundsPreviewResults] = useState<Record<string, CompensationPairSweep>>({});
  const [boundsPreviewPairKey, setBoundsPreviewPairKey] = useState<string | null>(null);
  const [expandedSweepPair, setExpandedSweepPair] = useState<string | null>(null);
  const [sweepProgress, setSweepProgress] = useState<Readonly<{
    completed: number;
    total: number;
  }> | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const [coefficientDraftPercent, setCoefficientDraftPercent] = useState("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [comparisonExportDialogOpen, setComparisonExportDialogOpen] = useState(false);
  const sweepGenerationRef = useRef(0);
  const candidatePreviewGenerationRef = useRef(0);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionIsError, setActionIsError] = useState(false);
  const [cytofDraft, setCytofDraft] = useState<CytofMatrixDraft | null>(null);
  const [includedCytofChannels, setIncludedCytofChannels] = useState<Set<string>>(
    () => new Set(),
  );
  const [cytofImportError, setCytofImportError] = useState<string | null>(null);
  const [gateRecomputeAcknowledged, setGateRecomputeAcknowledged] = useState(false);
  const [applyProgress, setApplyProgress] = useState<CompensationApplyProgress | null>(null);
  const [applyingProfile, setApplyingProfile] = useState(false);
  const [localApplyProfileName, setLocalApplyProfileName] = useState<string | null>(null);
  const applySubmissionRef = useRef(false);
  const cytofFileRef = useRef<HTMLInputElement>(null);
  const matrixRef = useRef<HTMLDivElement>(null);
  const commonPathRef = useRef<HTMLDivElement>(null);
  const applyBusy = applyingProfile || applyStatus !== null;
  const visibleApplyProgress: CompensationApplyUiStatus | null = applyStatus ??
    (applyProgress
      ? {
          phase: "applying",
          profileName: localApplyProfileName ?? cytofDraft?.fileName ?? "Compensation",
          fraction: applyProgress.fraction,
          processedEvents: applyProgress.processedEvents,
          totalEvents: applyProgress.totalEvents,
        }
      : null);

  useEffect(() => {
    if (visible) return;
    // Applying compensation is an explicit, durable operation and deliberately continues in
    // App. Pair previews and coefficient sweeps are speculative editor work: stop them as soon
    // as the tab is hidden so they cannot compete with gating interactions for workers/CPU.
    candidatePreviewGenerationRef.current++;
    sweepGenerationRef.current++;
    setFlowCandidatePreview({ state: "idle" });
    setSweepProgress(null);
    setBoundsPreviewPairKey(null);
    onSuspendBackgroundWork?.();
  }, [onSuspendBackgroundWork, visible]);

  const samplePnnChannels = useMemo(
    () => sample.channels.map(({ pnn, columnIndex }) => ({ pnn, columnIndex })),
    [sample],
  );
  const embeddedFlowProfileMatrix = useMemo(() => {
    if (!spill) return null;
    const pnnChannels = spill.channels.map((key) => {
      const index = sample.index(key);
      return index === undefined ? null : sample.channels[index].pnn;
    });
    if (pnnChannels.some((pnn) => pnn === null)) {
      return {
        validation: null,
        error: "The embedded matrix could not be mapped back to exact FCS channel identities.",
        keyword: undefined,
      } as const;
    }
    const validation = validateAndCanonicalizeCompensationMatrix({
      sourceChannels: pnnChannels as string[],
      receiverChannels: pnnChannels as string[],
      matrix: spill.matrix,
    }, "flow-spillover");
    const keyword = (["$SPILLOVER", "$SPILL", "SPILL"] as const)
      .find((candidate) => typeof sample.fcs.keywords[candidate] === "string");
    return {
      validation,
      error: validation.ok
        ? null
        : `The embedded compensation matrix cannot be applied or edited. ${validation.errors.map(({ message }) => message).join(" ")}`,
      keyword,
    } as const;
  }, [sample, spill]);
  const activeReviewPopulation = reviewPopulationId === "all"
    ? null
    : reviewPopulations.find(({ id }) => id === reviewPopulationId) ?? null;
  const reviewMask = activeReviewPopulation
    ? reviewPopulationMasks[activeReviewPopulation.id] ?? null
    : null;
  const reviewEventCount = reviewMask
    ? activeReviewPopulation?.eventCount ?? 0
    : sample.fcs.nEvents;
  const resolvedPairPreviewEventLimit: PairPreviewEventLimit = pairPreviewEventLimit === "all"
    ? "all"
    : PAIR_PREVIEW_EVENT_LIMITS.includes(Number(pairPreviewEventLimit) as typeof PAIR_PREVIEW_EVENT_LIMITS[number])
      ? Number(pairPreviewEventLimit) as typeof PAIR_PREVIEW_EVENT_LIMITS[number]
      : DEFAULT_PAIR_PREVIEW_EVENT_LIMIT;
  const reviewBiplotEventIndices = useMemo(
    () => deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      resolvedPairPreviewEventLimit === "all"
        ? Math.max(1, sample.fcs.nEvents)
        : resolvedPairPreviewEventLimit,
      reviewMask,
    ),
    [resolvedPairPreviewEventLimit, reviewEventCount, reviewMask, sample],
  );
  const reviewEvidenceEventIndices = useMemo(
    () => deterministicCompensationEventIndices(sample.fcs.nEvents, 2_048, reviewMask),
    [reviewMask, sample],
  );
  const globalInspectorEventIndices = useMemo(
    () => deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      GLOBAL_INSPECTOR_EVENT_LIMIT,
      reviewMask,
    ),
    [reviewMask, sample],
  );
  useEffect(() => {
    if (reviewPopulationId !== "all" && !reviewPopulations.some(({ id }) => id === reviewPopulationId)) {
      setReviewPopulationId("all");
    }
  }, [reviewPopulationId, reviewPopulations, setReviewPopulationId]);
  useEffect(() => {
    sweepGenerationRef.current++;
    onCancelCompensationSweep?.();
    setSweepResults({});
    setBoundsPreviewResults({});
    setBoundsPreviewPairKey(null);
    setSweepProgress(null);
    setSweepError(null);
  }, [reviewPopulationId, reviewMask, onCancelCompensationSweep]);
  const cytofCompatibility = useMemo<MatrixCompatibilityReport | null>(() => {
    if (!cytofDraft) return null;
    return reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofDraft.matrix,
      sampleChannels: samplePnnChannels,
      includedChannels: Array.from(includedCytofChannels),
    });
  }, [cytofDraft, includedCytofChannels, samplePnnChannels]);

  const matrixView = useMemo<CompensationMatrixView | null>(() => {
    if (spill) {
      return {
        sourceAxisKeys: spill.channels,
        receiverAxisKeys: spill.channels,
        sourceChannels: spill.channels.map((key) => channelDisplay(sample, key)),
        receiverChannels: spill.channels.map((key) => channelDisplay(sample, key)),
        matrix: spill.matrix,
        kind: "flow",
        title: "Embedded compensation matrix",
        subtitle: "Source rows ↓ · Receiver columns → · values are spillover percentages",
        coefficientNote: "Applying the embedded matrix leaves its coefficients unchanged.",
      };
    }
    if (!profileRecord || !profileMetadata) return null;
    const displayMatrix = profileRecord.scientific.kind === "cytof-spillover"
      ? cytofMatrixForDisplay(profileRecord.scientific.matrix)
      : profileRecord.scientific.matrix;
    if (
      displayMatrix.matrix.length !== displayMatrix.sourceChannels.length ||
      displayMatrix.matrix.some((row) => !row || row.length !== displayMatrix.receiverChannels.length)
    ) return null;
    return {
      sourceAxisKeys: displayMatrix.sourceChannels,
      receiverAxisKeys: displayMatrix.receiverChannels,
      sourceChannels: displayMatrix.sourceChannels.map((pnn) => channelDisplayForPnn(sample, pnn)),
      receiverChannels: displayMatrix.receiverChannels.map((pnn) => channelDisplayForPnn(sample, pnn)),
      matrix: displayMatrix.matrix,
      kind: profileRecord.scientific.kind === "cytof-spillover" ? "cytof" : "flow",
      title: profileRecord.scientific.kind === "cytof-spillover"
        ? "Uploaded spill matrix"
        : "Applied compensation matrix",
      subtitle: profileRecord.scientific.kind === "cytof-spillover"
        ? t("{sources} source rows ↓ · {receivers} receiver columns → · isotope-mass order", {
            sources: displayMatrix.sourceChannels.length,
            receivers: displayMatrix.receiverChannels.length,
          })
        : "Source rows ↓ · Receiver columns → · exact installed coefficients",
      coefficientNote: profileRecord.scientific.kind === "cytof-spillover"
        ? "This is the exact uploaded matrix. The NNLS solve uses its selected, matched channels; original measurements remain stored separately."
        : "This is the exact installed matrix. Original measurements remain stored separately.",
    };
  }, [profileMetadata, profileRecord, sample, spill, t]);
  const sourceChannels = matrixView?.sourceChannels ?? [];
  const receiverChannels = matrixView?.receiverChannels ?? [];
  useEffect(() => {
    setSweepWorkerCount((current) => Math.max(1, Math.min(MAX_SWEEP_WORKERS, Math.round(current) || 1)));
  }, [setSweepWorkerCount]);
  const activePairKey = hoveredPairKey ?? selectedPairKey;
  const selectedPair = useMemo(() => {
    if (!matrixView || !activePairKey) return null;
    const [sourceKey, receiverKey] = activePairKey.split(PAIR_SEPARATOR);
    const sourceIndex = matrixView.sourceAxisKeys.indexOf(sourceKey);
    const receiverIndex = matrixView.receiverAxisKeys.indexOf(receiverKey);
    if (
      sourceIndex < 0 ||
      receiverIndex < 0 ||
      matrixView.sourceAxisKeys[sourceIndex] === matrixView.receiverAxisKeys[receiverIndex]
    ) return null;
    return {
      pairKey: activePairKey,
      sourceIndex,
      receiverIndex,
      source: sourceChannels[sourceIndex],
      receiver: receiverChannels[receiverIndex],
      value: matrixView.matrix[sourceIndex][receiverIndex],
      interaction: matrixView.kind === "cytof"
        ? cytofInteractionType(
            matrixView.sourceAxisKeys[sourceIndex],
            matrixView.receiverAxisKeys[receiverIndex],
          )
        : null,
    };
  }, [activePairKey, matrixView, receiverChannels, sourceChannels]);
  useEffect(() => {
    if (!selectedPair) {
      setCoefficientDraftPercent("");
      return;
    }
    const staged = stagedCoefficients[selectedPair.pairKey];
    setCoefficientDraftPercent(significantNumber((staged ?? selectedPair.value) * 100, 6));
  }, [selectedPair?.pairKey, selectedPair?.value, stagedCoefficients]);
  const selectedPairPreview = useMemo(() => {
    if (!selectedPair) return null;
    return buildCompensationPairPreview(
      sample,
      selectedPair.source.key,
      selectedPair.receiver.key,
      {
        eventMask: reviewMask,
        fixedEventIndices: reviewBiplotEventIndices,
        eligibleEventCount: reviewEventCount,
      },
    );
  }, [compensationOn, installedStatus.state, reviewBiplotEventIndices, reviewEventCount, reviewMask, sample, selectedPair]);
  const residualEvidenceReview = useMemo(() => {
    // The revision is an explicit user-triggered rescan boundary. Population/sample changes
    // still recompute automatically through their own dependencies.
    void attentionScanRevision;
    if (!matrixView || installedStatus.state !== "ready") {
      return { candidateCount: 0, screenedCount: 0, evaluableCount: 0, items: [] as CompensationEvidenceCandidate[] };
    }
    const candidates: Array<Omit<CompensationEvidenceCandidate, "evidence" | "relativePriority">> = [];
    for (let sourceIndex = 0; sourceIndex < matrixView.matrix.length; sourceIndex++) {
      for (let receiverIndex = 0; receiverIndex < matrixView.matrix[sourceIndex].length; receiverIndex++) {
        const sourceKey = matrixView.sourceAxisKeys[sourceIndex];
        const receiverKey = matrixView.receiverAxisKeys[receiverIndex];
        if (sourceKey === receiverKey) continue;
        const coefficient = matrixView.matrix[sourceIndex][receiverIndex];
        if (!Number.isFinite(coefficient)) continue;
        const interaction = matrixView.kind === "cytof"
          ? cytofInteractionType(sourceKey, receiverKey)
          : null;
        const physicallyPlausible = interaction !== null && interaction !== "self" && interaction !== "other";
        if (coefficient === 0 && !physicallyPlausible && evidenceMode === "biological") continue;
        candidates.push({
          sourceIndex,
          receiverIndex,
          pairKey: `${sourceKey}${PAIR_SEPARATOR}${receiverKey}`,
          source: sourceChannels[sourceIndex],
          receiver: receiverChannels[receiverIndex],
          coefficient,
          interaction,
          physicalPrior: physicallyPlausible ? 1 : 0,
        });
      }
    }
    candidates.sort((left, right) =>
      right.physicalPrior - left.physicalPrior ||
      Math.abs(right.coefficient) - Math.abs(left.coefficient));
    const screened = candidates.slice(0, 240);
    const measured = screened.flatMap((candidate) => {
      const result = buildCompensationPairPreview(
        sample,
        candidate.source.key,
        candidate.receiver.key,
        {
          eventMask: reviewMask,
          fixedEventIndices: reviewEvidenceEventIndices,
          eligibleEventCount: reviewEventCount,
        },
      );
      if (!result.ready) return [];
      return [{ ...candidate, evidence: result.preview.evidence }];
    });
    const ranked = rankConservativeCompensationAttention(
      measured.map(({ coefficient, physicalPrior, evidence }) => ({ coefficient, physicalPrior, evidence })),
      matrixView.kind,
      evidenceMode,
    ).map(({ index, relativePriority }) => ({ ...measured[index], relativePriority }));
    return {
      candidateCount: candidates.length,
      screenedCount: screened.length,
      evaluableCount: measured.length,
      items: ranked.slice(0, 8),
    };
  }, [attentionScanRevision, evidenceMode, installedStatus.state, matrixView, receiverChannels, reviewEvidenceEventIndices, reviewEventCount, reviewMask, sample, sourceChannels]);
  const includedProfileChannels = useMemo(() => new Set(
    !profileRecord
      ? []
      : profileRecord.scientific.kind === "flow-spillover"
        ? profileRecord.scientific.matrix.receiverChannels
        : profileRecord.scientific.includedChannels,
  ), [profileRecord]);
  const globalInspectorDataset = useMemo(() => {
    if (!matrixView) return null;
    return buildCompensationGlobalInspectorDataset(
      sample,
      Array.from(new Set([
        ...matrixView.sourceAxisKeys,
        ...matrixView.receiverAxisKeys,
      ])),
      {
        eventMask: reviewMask,
        fixedEventIndices: globalInspectorEventIndices,
        eligibleEventCount: reviewEventCount,
      },
    );
  }, [
    compensationOn,
    globalInspectorEventIndices,
    installedStatus.state,
    matrixView,
    reviewEventCount,
    reviewMask,
    sample,
  ]);
  useEffect(() => {
    if (!matrixView || includedProfileChannels.size === 0) return;
    const nextSource = includedProfileChannels.has(manualSourceKey)
      ? manualSourceKey
      : matrixView.sourceAxisKeys.find((key) => includedProfileChannels.has(key)) ?? "";
    const nextReceiver = includedProfileChannels.has(manualReceiverKey) && manualReceiverKey !== nextSource
      ? manualReceiverKey
      : matrixView.receiverAxisKeys.find((key) => key !== nextSource && includedProfileChannels.has(key)) ?? "";
    if (nextSource !== manualSourceKey) setManualSourceKey(nextSource);
    if (nextReceiver !== manualReceiverKey) setManualReceiverKey(nextReceiver);
  }, [includedProfileChannels, manualReceiverKey, manualSourceKey, matrixView]);
  const flaggedPairSet = useMemo(() => new Set(flaggedPairKeys), [flaggedPairKeys]);
  const globalInspectorCandidates = useMemo(() => {
    if (!matrixView) return [];
    const candidates: CompensationGlobalPairCandidate[] = [];
    const restrictToInstalledChannels = includedProfileChannels.size > 0;
    for (let sourceIndex = 0; sourceIndex < matrixView.sourceAxisKeys.length; sourceIndex++) {
      const sourceKey = matrixView.sourceAxisKeys[sourceIndex];
      if (restrictToInstalledChannels && !includedProfileChannels.has(sourceKey)) continue;
      for (let receiverIndex = 0; receiverIndex < matrixView.receiverAxisKeys.length; receiverIndex++) {
        const receiverKey = matrixView.receiverAxisKeys[receiverIndex];
        if (
          sourceKey === receiverKey ||
          (restrictToInstalledChannels && !includedProfileChannels.has(receiverKey))
        ) continue;
        const coefficient = matrixView.matrix[sourceIndex]?.[receiverIndex];
        if (!Number.isFinite(coefficient)) continue;
        const source = sourceChannels[sourceIndex];
        const receiver = receiverChannels[receiverIndex];
        if (!source || !receiver) continue;
        if (
          globalInspectorDataset?.ready &&
          (!globalInspectorDataset.dataset.channels.has(source.key) ||
            !globalInspectorDataset.dataset.channels.has(receiver.key))
        ) continue;
        const interaction = matrixView.kind === "cytof"
          ? cytofInteractionType(sourceKey, receiverKey)
          : null;
        const physicallyPlausible = interaction !== null &&
          interaction !== "self" &&
          interaction !== "other";
        candidates.push({
          sourceIndex,
          receiverIndex,
          pairKey: `${sourceKey}${PAIR_SEPARATOR}${receiverKey}`,
          source,
          receiver,
          coefficient,
          interaction,
          physicalPrior: physicallyPlausible ? 1 : 0,
        });
      }
    }
    return candidates;
  }, [globalInspectorDataset, includedProfileChannels, matrixView, receiverChannels, sourceChannels]);
  const visibleGlobalInspectorCandidates = useMemo(() => {
    const query = globalPairSearch.trim().toLocaleLowerCase();
    return globalInspectorCandidates.filter((candidate) => {
      const nonZero = Math.abs(candidate.coefficient) > 1e-12;
      const physicallyPlausible = candidate.physicalPrior > 0;
      const inFilter = globalPairFilter === "all" ||
        (globalPairFilter === "relevant" && (nonZero || physicallyPlausible)) ||
        (globalPairFilter === "nonzero" && nonZero) ||
        (globalPairFilter === "physical" && physicallyPlausible) ||
        (globalPairFilter === "flagged" && flaggedPairSet.has(candidate.pairKey));
      if (!inFilter) return false;
      if (!query) return true;
      return `${candidate.source.combined} ${candidate.receiver.combined}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [flaggedPairSet, globalInspectorCandidates, globalPairFilter, globalPairSearch]);
  useEffect(() => {
    if (!pendingGlobalScrollPairKey || workspaceView !== "global") return;
    const tile = [...(commonPathRef.current?.querySelectorAll<HTMLElement>(".gl-comp-global-tile") ?? [])]
      .find((candidate) => candidate.dataset.pairKey === pendingGlobalScrollPairKey);
    if (!tile) return;
    tile.scrollIntoView({ block: "center", inline: "center" });
    setPendingGlobalScrollPairKey(null);
  }, [globalInspectorDetailsOpen, globalLayout, pendingGlobalScrollPairKey, visibleGlobalInspectorCandidates, workspaceView]);
  const globalInspectorGroups = useMemo(() => {
    if (globalLayout === "compact") return [];
    const groups = new Map<string, {
      channel: ReturnType<typeof channelDisplay>;
      pairs: CompensationGlobalPairCandidate[];
    }>();
    for (const pair of visibleGlobalInspectorCandidates) {
      const channel = globalLayout === "source" ? pair.source : pair.receiver;
      const current = groups.get(channel.key);
      if (current) current.pairs.push(pair);
      else groups.set(channel.key, { channel, pairs: [pair] });
    }
    return [...groups.values()];
  }, [globalLayout, visibleGlobalInspectorCandidates]);
  const orderedGlobalExportCandidates = useMemo(
    () => globalLayout === "compact"
      ? visibleGlobalInspectorCandidates
      : globalInspectorGroups.flatMap((group) => group.pairs),
    [globalInspectorGroups, globalLayout, visibleGlobalInspectorCandidates],
  );
  const globalExportFilterLabel = `${t(GLOBAL_PAIR_FILTER_LABELS[globalPairFilter])}${
    globalPairSearch.trim() ? t(" · search “{query}”", { query: globalPairSearch.trim() }) : ""
  }`;
  const resolvedGlobalPlotSize = Math.max(120, Math.min(220, Math.round(globalPlotSize) || 120));
  const resolvedDensitySmoothing = Math.max(1, Math.min(10, Math.round(densitySmoothing) || 6));
  const resolvedPointAlpha = Math.max(0.1, Math.min(1, Number(pointAlpha) || 0.85));
  const flaggedPairs = useMemo(() => {
    if (!profileRecord || !matrixView || installedStatus.state !== "ready") return [];
    return flaggedPairKeys.flatMap((pairKey): CompensationEvidenceCandidate[] => {
      const [sourceKey, receiverKey] = pairKey.split(PAIR_SEPARATOR);
      const sourceIndex = matrixView.sourceAxisKeys.indexOf(sourceKey);
      const receiverIndex = matrixView.receiverAxisKeys.indexOf(receiverKey);
      if (
        sourceIndex < 0 ||
        receiverIndex < 0 ||
        sourceKey === receiverKey ||
        !includedProfileChannels.has(sourceKey) ||
        !includedProfileChannels.has(receiverKey)
      ) return [];
      const preview = buildCompensationPairPreview(
        sample,
        sourceChannels[sourceIndex].key,
        receiverChannels[receiverIndex].key,
        {
          eventMask: reviewMask,
          fixedEventIndices: reviewEvidenceEventIndices,
          eligibleEventCount: reviewEventCount,
        },
      );
      if (!preview.ready) return [];
      const suggestion = residualEvidenceReview.items.find((candidate) => candidate.pairKey === pairKey);
      return [{
        sourceIndex,
        receiverIndex,
        pairKey,
        source: sourceChannels[sourceIndex],
        receiver: receiverChannels[receiverIndex],
        coefficient: matrixView.matrix[sourceIndex][receiverIndex],
        interaction: matrixView.kind === "cytof"
          ? cytofInteractionType(sourceKey, receiverKey)
          : null,
        physicalPrior: matrixView.kind === "cytof" &&
            cytofInteractionType(sourceKey, receiverKey) !== "other"
          ? 1
          : 0,
        evidence: preview.preview.evidence,
        relativePriority: suggestion?.relativePriority ?? 0,
      }];
    });
  }, [flaggedPairKeys, includedProfileChannels, installedStatus.state, matrixView, profileRecord, receiverChannels, residualEvidenceReview.items, reviewEvidenceEventIndices, reviewEventCount, reviewMask, sample, sourceChannels]);
  const sweepEligiblePairs = flaggedPairs;
  const sweepReferenceCoefficient = useMemo(() => {
    if (!profileRecord) return 0.01;
    const values: number[] = [];
    for (let sourceIndex = 0; sourceIndex < profileRecord.scientific.matrix.matrix.length; sourceIndex++) {
      const sourceKey = profileRecord.scientific.matrix.sourceChannels[sourceIndex];
      for (let receiverIndex = 0; receiverIndex < profileRecord.scientific.matrix.matrix[sourceIndex].length; receiverIndex++) {
        if (sourceKey === profileRecord.scientific.matrix.receiverChannels[receiverIndex]) continue;
        const value = Math.abs(profileRecord.scientific.matrix.matrix[sourceIndex][receiverIndex]);
        if (Number.isFinite(value) && value > 1e-12) values.push(value);
      }
    }
    return values.length > 0 ? median(values) : 0.01;
  }, [profileRecord]);
  const boundsDraftForPair = (pairKey: string, current: number): CompensationSweepBoundsDraft => {
    const stored = sweepBoundsDrafts[pairKey];
    if (stored) return stored;
    const defaults = defaultSweepBounds(current, sweepReferenceCoefficient, matrixView?.kind ?? "flow");
    return {
      lowerPercent: significantNumber(defaults.lower * 100, 5),
      upperPercent: significantNumber(defaults.upper * 100, 5),
    };
  };
  const resolvedBoundsForPair = (
    pairKey: string,
    current: number,
  ): Readonly<{ lower: number; upper: number; error: string | null }> => {
    const draft = boundsDraftForPair(pairKey, current);
    const lower = Number(draft.lowerPercent) / 100;
    const upper = Number(draft.upperPercent) / 100;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      return { lower, upper, error: "Enter finite lower and upper sweep bounds." };
    }
    if (matrixView?.kind === "cytof" && lower < 0) {
      return { lower, upper, error: "CyTOF NNLS sweep bounds cannot be negative." };
    }
    if (!(upper > lower)) {
      return { lower, upper, error: "The upper sweep bound must be greater than the lower bound." };
    }
    return { lower, upper, error: null };
  };
  const setSweepBoundDraft = (
    pairKey: string,
    current: number,
    field: keyof CompensationSweepBoundsDraft,
    value: string,
  ) => {
    setSweepBoundsDrafts((drafts) => ({
      ...drafts,
      [pairKey]: {
        ...(drafts[pairKey] ?? (() => {
          const defaults = defaultSweepBounds(current, sweepReferenceCoefficient, matrixView?.kind ?? "flow");
          return {
            lowerPercent: significantNumber(defaults.lower * 100, 5),
            upperPercent: significantNumber(defaults.upper * 100, 5),
          };
        })()),
        [field]: value,
      },
    }));
    setSweepResults((results) => {
      if (!(pairKey in results)) return results;
      const next = { ...results };
      delete next[pairKey];
      return next;
    });
    setBoundsPreviewResults((results) => {
      if (!(pairKey in results)) return results;
      const next = { ...results };
      delete next[pairKey];
      return next;
    });
  };
  const toggleFlaggedPair = (pairKey: string, flagged: boolean) => {
    setFlaggedPairKeys((current) => flagged
      ? current.includes(pairKey) ? current : [...current, pairKey]
      : current.filter((candidate) => candidate !== pairKey));
    if (flagged) {
      setSelectedPairKey(pairKey);
      setExpandedSweepPair(pairKey);
    } else {
      setSweepResults((results) => {
        if (!(pairKey in results)) return results;
        const next = { ...results };
        delete next[pairKey];
        return next;
      });
      setBoundsPreviewResults((results) => {
        if (!(pairKey in results)) return results;
        const next = { ...results };
        delete next[pairKey];
        return next;
      });
    }
  };
  const addManualFollowupPair = () => {
    if (!matrixView || !manualSourceKey || !manualReceiverKey || manualSourceKey === manualReceiverKey) return;
    if (!includedProfileChannels.has(manualSourceKey) || !includedProfileChannels.has(manualReceiverKey)) {
      setSweepError("Both channels must be included in the installed compensation solve.");
      return;
    }
    const pairKey = `${manualSourceKey}${PAIR_SEPARATOR}${manualReceiverKey}`;
    toggleFlaggedPair(pairKey, true);
    setSweepError(null);
  };
  const invalidSweepPairCount = sweepEligiblePairs.reduce((count, pair) =>
    count + (resolvedBoundsForPair(pair.pairKey, pair.coefficient).error ? 1 : 0), 0);
  const workingProfileMatrix = useMemo(() => {
    if (!profileRecord) return null;
    const matrix = profileRecord.scientific.matrix.matrix.map((row) => Array.from(row));
    for (const [pairKey, value] of Object.entries(stagedCoefficients)) {
      const [sourceKey, receiverKey] = pairKey.split(PAIR_SEPARATOR);
      const sourceIndex = profileRecord.scientific.matrix.sourceChannels.indexOf(sourceKey);
      const receiverIndex = profileRecord.scientific.matrix.receiverChannels.indexOf(receiverKey);
      if (sourceIndex >= 0 && receiverIndex >= 0) matrix[sourceIndex][receiverIndex] = value;
    }
    return Object.freeze(matrix.map((row) => Object.freeze(row)));
  }, [profileRecord, stagedCoefficients]);
  useEffect(() => {
    const editCount = Object.keys(stagedCoefficients).length;
    if (
      !visible ||
      editCount === 0 ||
      !profileRecord ||
      profileRecord.scientific.kind !== "flow-spillover" ||
      installedStatus.state !== "ready" ||
      !workingProfileMatrix ||
      !selectedPair ||
      !onPreviewCompensationCandidate
    ) {
      candidatePreviewGenerationRef.current++;
      setFlowCandidatePreview({ state: "idle" });
      return;
    }
    // Preserve the exact same frozen event set before and after a matrix edit. A smaller
    // candidate-only sample makes events appear to vanish when the Candidate panel arrives.
    const fixedEventIndices = reviewBiplotEventIndices;
    if (fixedEventIndices.length === 0) {
      setFlowCandidatePreview({
        state: "error",
        pairKey: selectedPair.pairKey,
        message: t("The selected review population contains no events."),
      });
      return;
    }
    const generation = ++candidatePreviewGenerationRef.current;
    const pairKey = selectedPair.pairKey;
    setFlowCandidatePreview((current) => ({
      state: "updating",
      pairKey,
      ...((current.state === "ready" || current.state === "updating") &&
          current.pairKey === pairKey && current.preview
        ? { preview: current.preview }
        : {}),
    }));
    const timeout = window.setTimeout(() => {
      void onPreviewCompensationCandidate(
        profileRecord,
        fixedEventIndices,
        workingProfileMatrix,
      ).then((response) => {
        if (candidatePreviewGenerationRef.current !== generation) return;
        const sourceOutput = response.sourceChannels.indexOf(selectedPair.source.pnn);
        const receiverOutput = response.sourceChannels.indexOf(selectedPair.receiver.pnn);
        if (sourceOutput < 0 || receiverOutput < 0) {
          throw new Error(t("The preview result did not contain the selected flow channels."));
        }
        const candidate = buildSolvedCompensationPairPreview(
          sample,
          selectedPair.source.pnn,
          selectedPair.receiver.pnn,
          fixedEventIndices,
          response.candidateColumns[sourceOutput],
          response.candidateColumns[receiverOutput],
          { totalEvents: reviewEventCount },
        );
        if (!candidate.ready) throw new Error(candidate.reason);
        setFlowCandidatePreview({
          state: "ready",
          pairKey,
          preview: candidate.preview,
        });
      }).catch((cause) => {
        if (candidatePreviewGenerationRef.current !== generation) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (/cancel|supersed|stale/i.test(message)) return;
        setFlowCandidatePreview({ state: "error", pairKey, message });
      });
    }, 90);
    return () => window.clearTimeout(timeout);
  }, [
    installedStatus.state,
    onPreviewCompensationCandidate,
    profileRecord,
    reviewBiplotEventIndices,
    reviewEventCount,
    sample,
    sample.dataRevision,
    sample.displayTransformContextKey,
    sample.layerRevision,
    selectedPair,
    stagedCoefficients,
    t,
    visible,
    workingProfileMatrix,
  ]);
  const workingExportMatrix = useMemo(() => {
    if (!matrixView || Object.keys(stagedCoefficients).length === 0) return null;
    return {
      sourceChannels: matrixView.sourceAxisKeys,
      receiverChannels: matrixView.receiverAxisKeys,
      matrix: matrixView.matrix.map((row, sourceIndex) =>
        row.map((value, receiverIndex) => {
          const pairKey = `${matrixView.sourceAxisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView.receiverAxisKeys[receiverIndex]}`;
          return stagedCoefficients[pairKey] ?? value;
        }),
      ),
    };
  }, [matrixView, stagedCoefficients]);
  const unusualCoefficients = useMemo(() => {
    if (!matrixView) return [];
    const found: string[] = [];
    for (let source = 0; source < matrixView.matrix.length; source++) {
      for (let receiver = 0; receiver < matrixView.matrix[source].length; receiver++) {
        const value = matrixView.matrix[source][receiver];
        if (
          matrixView.sourceAxisKeys[source] === matrixView.receiverAxisKeys[receiver] ||
          !Number.isFinite(value) ||
          value <= 1
        ) continue;
        found.push(`${sourceChannels[source].combined} → ${receiverChannels[receiver].combined}`);
      }
    }
    return found;
  }, [matrixView, receiverChannels, sourceChannels]);
  const matrixReviewItems = useMemo(() => {
    if (!matrixView) return [];
    const found: string[] = [];
    for (let source = 0; source < matrixView.matrix.length; source++) {
      for (let receiver = 0; receiver < matrixView.matrix[source].length; receiver++) {
        const value = matrixView.matrix[source][receiver];
        const diagonal = matrixView.sourceAxisKeys[source] === matrixView.receiverAxisKeys[receiver];
        const pair = `${sourceChannels[source].combined} → ${receiverChannels[receiver].combined}`;
        if (!Number.isFinite(value)) {
          found.push(`${pair}: non-finite coefficient (${String(value)})`);
        } else if (diagonal && Math.abs(value - 1) > 1e-8) {
          found.push(`${sourceChannels[source].combined}: diagonal is ${percentText(value)}, not 100%`);
        } else if (!diagonal && value < 0) {
          found.push(`${pair}: negative coefficient (${percentText(value)})`);
        } else if (!diagonal && value > 1) {
          found.push(`${pair}: coefficient above 100%`);
        }
      }
    }
    return found;
  }, [matrixView, receiverChannels, sourceChannels]);
  const matrixHasNonFinite = useMemo(
    () => matrixView?.matrix.some((row) => row.some((value) => !Number.isFinite(value))) ?? false,
    [matrixView],
  );
  const impactSummary = useMemo(
    () => profileMetadata && installedStatus.state === "ready"
      ? summarizeInstalledCompensation(sample, profileMetadata.includedPnns)
      : null,
    [installedStatus.state, profileMetadata, sample],
  );
  const reviewItems = useMemo(() => {
    const items = [...matrixReviewItems];
    if (installedStatus.state === "stale") {
      items.push(...installedStatus.reasons.map((reason) => `Profile unavailable: ${reasonLabel(reason)}`));
    }
    return items;
  }, [installedStatus, matrixReviewItems]);

  const source = profileMetadata
    ? profileRecord?.name ?? "Installed compensation profile"
    : spill
      ? "Embedded FCS matrix"
      : "No compatible matrix";
  const method = profileMetadata
    ? methodLabel(profileMetadata.kind, profileMetadata.method)
    : spill
      ? "Flow linear inverse"
      : "Not configured";
  const displayMethod = t(method);
  const channelCount = profileMetadata?.includedPnns.length ?? spill?.channels.length ?? 0;
  const profileDisplaySource = profileRecord?.name ?? profileMetadata?.profileId ?? source;
  const cleanedProfileSource = compensationProfileBaseName(profileDisplaySource);
  const compactProfileSource = cleanedProfileSource !== profileDisplaySource || profileRecord?.recordType === "revision"
    ? `${cleanedProfileSource} · ${t("revised")}`
    : profileDisplaySource;
  const canToggle = (spill !== null && !matrixHasNonFinite) ||
    (profileMetadata !== null && installedStatus.state === "ready");
  const matrixMaxAbsoluteOffDiagonal = useMemo(() => {
    if (!matrixView) return 0;
    let maximum = 0;
    for (let source = 0; source < matrixView.matrix.length; source++) {
      for (let receiver = 0; receiver < matrixView.matrix[source].length; receiver++) {
        if (matrixView.sourceAxisKeys[source] === matrixView.receiverAxisKeys[receiver]) continue;
        const value = matrixView.matrix[source][receiver];
        if (Number.isFinite(value)) maximum = Math.max(maximum, Math.abs(value));
      }
    }
    return maximum;
  }, [matrixView]);
  const flowInlineMatrix = Boolean(
    profileRecord?.scientific.kind === "flow-spillover" &&
    installedStatus.state === "ready" &&
    matrixView &&
    Math.max(matrixView.sourceAxisKeys.length, matrixView.receiverAxisKeys.length) <= FLOW_INLINE_MATRIX_LIMIT,
  );
  const matrixCellSize = matrixView
    ? flowInlineMatrix
      ? Math.max(42, Math.min(54, Math.floor(960 / Math.max(
          matrixView.sourceAxisKeys.length,
          matrixView.receiverAxisKeys.length,
        ))))
      : Math.max(13, Math.min(38, Math.floor(760 / Math.max(
          matrixView.sourceAxisKeys.length,
          matrixView.receiverAxisKeys.length,
        ))))
    : 13;

  useEffect(() => {
    setStagedCoefficients({});
    setMatrixCellDraftPercents({});
    setFlowCandidatePreview({ state: "idle" });
    candidatePreviewGenerationRef.current++;
  }, [profileRecord?.profileId]);

  useEffect(() => {
    if (matrixView?.kind === "flow" && globalPairFilter === "physical") {
      setGlobalPairFilter("relevant");
    }
  }, [globalPairFilter, matrixView?.kind, setGlobalPairFilter]);

  const toggleDrawer = (id: DrawerId) => {
    setOpenDrawers((current) => ({ ...current, [id]: !current[id] }));
  };

  const clampInspectorWidth = (requestedWidth: number): number => {
    const availableWidth = commonPathRef.current?.getBoundingClientRect().width ?? 1100;
    const maximum = Math.max(360, Math.min(900, availableWidth - 440 - 8));
    return Math.max(360, Math.min(maximum, Math.round(requestedWidth)));
  };

  const startInspectorResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const bounds = commonPathRef.current?.getBoundingClientRect();
      if (!bounds) return;
      setInspectorWidth(clampInspectorWidth(bounds.right - moveEvent.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      handle.releasePointerCapture?.(event.pointerId);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const handleInspectorResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = inspectorWidth + 40;
    else if (event.key === "ArrowRight") next = inspectorWidth - 40;
    else if (event.key === "Home") next = DEFAULT_INSPECTOR_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setInspectorWidth(clampInspectorWidth(next));
  };

  const handleCytofMatrixFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setCytofImportError(null);
    setActionMessage(null);
    setActionIsError(false);
    setApplyProgress(null);
    setGateRecomputeAcknowledged(false);
    try {
      const parsed = parseCompensationMatrixTable(await file.text());
      const validated = validateAndCanonicalizeCompensationMatrix(
        parsed.input,
        "cytof-spillover",
      );
      if (!validated.ok) {
        throw new Error(validated.errors.map(({ message }) => message).join(" "));
      }
      const sampleCounts = new Map<string, number>();
      for (const { pnn } of samplePnnChannels) {
        const exactPnn = pnn.trim().normalize("NFC");
        sampleCounts.set(exactPnn, (sampleCounts.get(exactPnn) ?? 0) + 1);
      }
      const matched = validated.value.receiverChannels.filter(
        (pnn) => sampleCounts.get(pnn) === 1,
      );
      setCytofDraft({
        fileName: file.name,
        parsed,
        matrix: validated.value,
        validationWarnings: validated.warnings,
      });
      setIncludedCytofChannels(new Set(matched));
    } catch (cause) {
      setCytofDraft(null);
      setIncludedCytofChannels(new Set());
      setCytofImportError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const setCytofChannelIncluded = (pnn: string, included: boolean) => {
    setIncludedCytofChannels((current) => {
      const next = new Set(current);
      if (included) next.add(pnn);
      else next.delete(pnn);
      return next;
    });
  };

  const applyCytofProfile = async () => {
    if (
      applySubmissionRef.current ||
      applyBusy ||
      !cytofDraft ||
      !cytofCompatibility?.canApply ||
      !onApplyProfile
    ) return;
    if (hasExistingGates && !gateRecomputeAcknowledged) {
      setCytofImportError(
        t("Confirm that existing gate memberships will be recomputed in compensated coordinates before applying."),
      );
      return;
    }
    setCytofImportError(null);
    setActionMessage(null);
    setApplyProgress(null);
    applySubmissionRef.current = true;
    setApplyingProfile(true);
    setLocalApplyProfileName(cytofDraft.fileName);
    try {
      const suffix = globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const displayName = cytofDraft.fileName.replace(/\.(?:csv|tsv|txt)$/i, "") ||
        "CyTOF compensation";
      const profile = await createCompensationBaselineProfile(
        {
          kind: "cytof-spillover",
          method: "nnls",
          solverVersion: CYTOF_NNLS_SOLVER_VERSION,
          solverSettings: DEFAULT_CYTOF_NNLS_SETTINGS,
          matrix: cytofDraft.matrix,
          includedChannels: Array.from(includedCytofChannels),
        },
        {
          profileId: `cytof-${suffix}`,
          name: displayName,
          createdAt: new Date(),
          origin: {
            type: "uploaded",
            fileName: cytofDraft.fileName,
            format: cytofDraft.parsed.format.delimiter,
            sourceColumnHeader: cytofDraft.parsed.format.sourceColumnHeader,
          },
          provenance: {
            sourceDescription: "User-uploaded CyTOF spillover matrix",
            estimationMethod: "Imported; coefficients preserved exactly",
          },
        },
      );
      await onApplyProfile(profile, setApplyProgress);
      setActionMessage(t("Applied {name} to {count} channels. Original measurements remain available.", {
        name: displayName,
        count: includedCytofChannels.size,
      }));
      setCytofDraft(null);
      setIncludedCytofChannels(new Set());
      setGateRecomputeAcknowledged(false);
      setApplyProgress(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/cancel/i.test(message)) setActionMessage(t("CyTOF compensation was cancelled; the previous assay was left unchanged."));
      else setCytofImportError(message);
    } finally {
      applySubmissionRef.current = false;
      setApplyingProfile(false);
      setLocalApplyProfileName(null);
    }
  };

  const enableEmbeddedFlowEditing = async () => {
    if (
      applySubmissionRef.current ||
      applyBusy ||
      !spill ||
      !embeddedFlowProfileMatrix?.validation?.ok ||
      !onApplyProfile
    ) return;
    if (hasExistingGates && !gateRecomputeAcknowledged) {
      setActionIsError(true);
      setActionMessage(
        t("Confirm that existing gate memberships will be recomputed in compensated coordinates before enabling matrix editing."),
      );
      return;
    }
    const displayName = `${sampleName.replace(/\.fcs$/i, "") || "Flow"} spillover`;
    setActionMessage(null);
    setActionIsError(false);
    setApplyProgress(null);
    applySubmissionRef.current = true;
    setApplyingProfile(true);
    setLocalApplyProfileName(displayName);
    try {
      const suffix = globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const profile = await createCompensationBaselineProfile(
        {
          kind: "flow-spillover",
          method: "matrix-inverse",
          solverVersion: FLOW_SOLVER_VERSION,
          solverSettings: DEFAULT_FLOW_SOLVER_SETTINGS,
          matrix: embeddedFlowProfileMatrix.validation.value,
        },
        {
          profileId: `flow-${suffix}`,
          name: displayName,
          createdAt: new Date(),
          origin: {
            type: "embedded-fcs",
            fileName: sampleName,
            ...(embeddedFlowProfileMatrix.keyword
              ? { keyword: embeddedFlowProfileMatrix.keyword }
              : {}),
          },
          provenance: {
            sourceDescription: "Spillover matrix embedded in the source FCS file",
            estimationMethod: "Imported from FCS; coefficients preserved exactly",
          },
        },
      );
      await onApplyProfile(profile, setApplyProgress);
      setGateRecomputeAcknowledged(false);
      setActionMessage(t("Flow matrix editing is ready. The exact embedded matrix is retained as the baseline, and Original measurements remain available."));
    } catch (cause) {
      setActionIsError(true);
      setActionMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      applySubmissionRef.current = false;
      setApplyingProfile(false);
      setLocalApplyProfileName(null);
      setApplyProgress(null);
    }
  };

  const selectAndFocus = (sourceIndex: number, receiverIndex: number) => {
    const sourceChannel = sourceChannels[sourceIndex];
    const receiverChannel = receiverChannels[receiverIndex];
    if (
      !matrixView ||
      !sourceChannel ||
      !receiverChannel ||
      matrixView.sourceAxisKeys[sourceIndex] === matrixView.receiverAxisKeys[receiverIndex]
    ) return;
    setSelectedPairKey(`${matrixView.sourceAxisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView.receiverAxisKeys[receiverIndex]}`);
    matrixRef.current
      ?.querySelector<HTMLButtonElement>(
        `button[data-source-index="${sourceIndex}"][data-receiver-index="${receiverIndex}"]`,
      )
      ?.focus();
  };

  const handleMatrixKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sourceIndex: number,
    receiverIndex: number,
  ) => {
    if (!matrixView) return;
    const sourceCount = matrixView.sourceAxisKeys.length;
    const receiverCount = matrixView.receiverAxisKeys.length;
    let nextSource = sourceIndex;
    let nextReceiver = receiverIndex;
    const receiverStep = (start: number, delta: -1 | 1) => {
      let candidate = start + delta;
      while (candidate >= 0 && candidate < receiverCount) {
        if (matrixView.sourceAxisKeys[sourceIndex] !== matrixView.receiverAxisKeys[candidate]) return candidate;
        candidate += delta;
      }
      return start;
    };
    const sourceStep = (start: number, delta: -1 | 1) => {
      let candidate = start + delta;
      while (candidate >= 0 && candidate < sourceCount) {
        if (matrixView.sourceAxisKeys[candidate] !== matrixView.receiverAxisKeys[receiverIndex]) return candidate;
        candidate += delta;
      }
      return start;
    };

    switch (event.key) {
      case "ArrowLeft":
        nextReceiver = receiverStep(receiverIndex, -1);
        break;
      case "ArrowRight":
        nextReceiver = receiverStep(receiverIndex, 1);
        break;
      case "ArrowUp":
        nextSource = sourceStep(sourceIndex, -1);
        break;
      case "ArrowDown":
        nextSource = sourceStep(sourceIndex, 1);
        break;
      case "Home": {
        nextReceiver = matrixView.sourceAxisKeys[sourceIndex] === matrixView.receiverAxisKeys[0] ? 1 : 0;
        break;
      }
      case "End": {
        const last = receiverCount - 1;
        nextReceiver = matrixView.sourceAxisKeys[sourceIndex] === matrixView.receiverAxisKeys[last]
          ? last - 1
          : last;
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    selectAndFocus(nextSource, nextReceiver);
  };

  const stageCoefficient = (pairKey: string, value: number) => {
    if (!profileRecord || !Number.isFinite(value)) return;
    const [sourceKey, receiverKey] = pairKey.split(PAIR_SEPARATOR);
    const sourceIndex = profileRecord.scientific.matrix.sourceChannels.indexOf(sourceKey);
    const receiverIndex = profileRecord.scientific.matrix.receiverChannels.indexOf(receiverKey);
    if (sourceIndex < 0 || receiverIndex < 0) return;
    if (profileRecord.scientific.kind === "cytof-spillover" && value < 0) {
      setActionIsError(true);
      setActionMessage(t("CyTOF NNLS spill coefficients cannot be negative."));
      return;
    }
    const baseline = profileRecord.scientific.matrix.matrix[sourceIndex][receiverIndex];
    setStagedCoefficients((current) => {
      const next = { ...current };
      if (value === baseline) delete next[pairKey];
      else next[pairKey] = value;
      return next;
    });
    setActionIsError(false);
    setActionMessage(t("Staged {source} → {receiver} at {value}%. Apply the revised matrix to recompute the assay.", {
      source: sourceKey,
      receiver: receiverKey,
      value: (value * 100).toFixed(2),
    }));
  };

  const buildPairSweepFromResponses = (
    pair: CompensationEvidenceCandidate,
    candidateValues: readonly number[],
    responses: readonly PreviewSolvedResponse[],
    fixedEventIndices: Uint32Array,
  ): CompensationPairSweep | null => {
    const firstResponse = responses[0];
    if (!firstResponse) return null;
    const currentSourceOutput = firstResponse.sourceChannels.indexOf(pair.source.pnn);
    const currentReceiverOutput = firstResponse.sourceChannels.indexOf(pair.receiver.pnn);
    if (currentSourceOutput < 0 || currentReceiverOutput < 0) return null;
    const currentResult = buildSolvedCompensationPairPreview(
      sample,
      pair.source.pnn,
      pair.receiver.pnn,
      fixedEventIndices,
      firstResponse.currentColumns[currentSourceOutput],
      firstResponse.currentColumns[currentReceiverOutput],
      { totalEvents: reviewEventCount },
    );
    if (!currentResult.ready) return null;
    const values: CompensationSweepValue[] = [{
      value: pair.coefficient,
      isCurrent: true,
      preview: currentResult.preview,
    }];
    responses.forEach((response, index) => {
      const sourceOutput = response.sourceChannels.indexOf(pair.source.pnn);
      const receiverOutput = response.sourceChannels.indexOf(pair.receiver.pnn);
      if (sourceOutput < 0 || receiverOutput < 0) return;
      const candidate = buildSolvedCompensationPairPreview(
        sample,
        pair.source.pnn,
        pair.receiver.pnn,
        fixedEventIndices,
        response.candidateColumns[sourceOutput],
        response.candidateColumns[receiverOutput],
        {
          totalEvents: reviewEventCount,
          xRange: currentResult.preview.xRange,
          yRange: currentResult.preview.yRange,
        },
      );
      if (candidate.ready) values.push({
        value: candidateValues[index],
        isCurrent: false,
        preview: candidate.preview,
      });
    });
    values.sort((left, right) => left.value - right.value || Number(right.isCurrent) - Number(left.isCurrent));
    return { pairKey: pair.pairKey, values: Object.freeze(values) };
  };

  const previewSweepBounds = async (pair: CompensationEvidenceCandidate) => {
    if (!profileRecord || !matrixView || !onSolveCompensationSweep || applyBusy || sweepProgress || boundsPreviewPairKey) return;
    const bounds = resolvedBoundsForPair(pair.pairKey, pair.coefficient);
    if (bounds.error) {
      setSweepError(bounds.error);
      return;
    }
    const fixedEventIndices = deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      BOUNDS_PREVIEW_EVENT_LIMIT,
      reviewMask,
    );
    if (fixedEventIndices.length === 0) {
      setSweepError(t("The selected review population contains no events."));
      return;
    }
    const generation = ++sweepGenerationRef.current;
    const values = [bounds.lower, bounds.upper];
    setBoundsPreviewPairKey(pair.pairKey);
    setSweepError(null);
    try {
      const responses = await onSolveCompensationSweep(
        profileRecord,
        fixedEventIndices,
        values.map((value) => matrixWithCoefficient(
          profileRecord,
          matrixView.sourceAxisKeys[pair.sourceIndex],
          matrixView.receiverAxisKeys[pair.receiverIndex],
          value,
        )),
        undefined,
        1,
      );
      if (sweepGenerationRef.current !== generation) return;
      const preview = buildPairSweepFromResponses(pair, values, responses, fixedEventIndices);
      if (!preview) throw new Error(t("The fast bounds preview could not be built for this pair."));
      setBoundsPreviewResults((current) => ({ ...current, [pair.pairKey]: preview }));
    } catch (cause) {
      if (sweepGenerationRef.current !== generation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setSweepError(/cancel/i.test(message) ? t("Fast bounds preview cancelled.") : message);
    } finally {
      if (sweepGenerationRef.current === generation) setBoundsPreviewPairKey(null);
    }
  };

  const runExactSweeps = async () => {
    if (
      !profileRecord ||
      !onSolveCompensationSweep ||
      sweepEligiblePairs.length === 0 ||
      applyBusy ||
      sweepProgress !== null ||
      boundsPreviewPairKey !== null
    ) return;
    if (invalidSweepPairCount > 0) {
      setSweepError(t("Fix the sweep bounds for {count} flagged pairs before running.", { count: invalidSweepPairCount }));
      return;
    }
    const fixedEventIndices = deterministicCompensationEventIndices(
      sample.fcs.nEvents,
      SWEEP_EVENT_LIMIT,
      reviewMask,
    );
    if (fixedEventIndices.length === 0) {
      setSweepError(t("The selected review population contains no events."));
      return;
    }
    const generation = ++sweepGenerationRef.current;
    const plans = sweepEligiblePairs.flatMap((pair) => {
      const bounds = resolvedBoundsForPair(pair.pairKey, pair.coefficient);
      return interpolatedSweepValues(bounds.lower, bounds.upper).map((value) => ({
        pair,
        value,
        matrix: matrixWithCoefficient(
          profileRecord,
          matrixView!.sourceAxisKeys[pair.sourceIndex],
          matrixView!.receiverAxisKeys[pair.receiverIndex],
          value,
        ),
      }));
    });
    setSweepError(null);
    setSweepResults({});
    setSweepProgress({ completed: 0, total: plans.length });
    try {
      const responses = await onSolveCompensationSweep(
        profileRecord,
        fixedEventIndices,
        plans.map(({ matrix }) => matrix),
        (completed, total) => {
          if (sweepGenerationRef.current === generation) setSweepProgress({ completed, total });
        },
        sweepWorkerCount,
      );
      if (sweepGenerationRef.current !== generation) return;
      if (responses.length !== plans.length) {
        throw new Error(t("The compensation worker returned an incomplete coefficient sweep."));
      }
      const byPair: Record<string, CompensationPairSweep> = {};
      for (const pair of sweepEligiblePairs) {
        const planIndices = plans.flatMap((plan, index) => plan.pair.pairKey === pair.pairKey ? [index] : []);
        const sweep = buildPairSweepFromResponses(
          pair,
          planIndices.map((index) => plans[index].value),
          planIndices.map((index) => responses[index]),
          fixedEventIndices,
        );
        if (sweep) byPair[pair.pairKey] = sweep;
      }
      setSweepResults(byPair);
      setExpandedSweepPair(sweepEligiblePairs[0]?.pairKey ?? null);
    } catch (cause) {
      if (sweepGenerationRef.current !== generation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setSweepError(/cancel/i.test(message) ? t("Exact coefficient sweep cancelled.") : message);
    } finally {
      if (sweepGenerationRef.current === generation) setSweepProgress(null);
    }
  };

  const cancelExactSweeps = () => {
    sweepGenerationRef.current++;
    onCancelCompensationSweep?.();
    setSweepProgress(null);
    setBoundsPreviewPairKey(null);
    setSweepError(t("Exact coefficient sweep cancelled."));
  };

  const applyStagedMatrix = async () => {
    if (!profileRecord || !workingProfileMatrix || !onApplyProfile || Object.keys(stagedCoefficients).length === 0) return;
    const revisionName = `${compensationProfileBaseName(profileRecord.name)} · edited`;
    setActionMessage(null);
    setActionIsError(false);
    setApplyingProfile(true);
    setLocalApplyProfileName(revisionName);
    setApplyProgress(null);
    try {
      const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const metadata = {
        profileId: `comp-edit-${suffix}`,
        name: revisionName,
        createdAt: new Date(),
        note: `Edited ${Object.keys(stagedCoefficients).length} compensation coefficient${Object.keys(stagedCoefficients).length === 1 ? "" : "s"} in GateLab.`,
      };
      const revised = installedBaselineProfile?.recordType === "baseline" &&
          exactSameMatrix(workingProfileMatrix, installedBaselineProfile.scientific.matrix.matrix)
        ? await createResetToBaselineRevision(profileRecord, installedBaselineProfile, metadata)
        : await createCompensationProfileRevision(
            profileRecord,
            scientificCandidate(profileRecord, workingProfileMatrix),
            metadata,
          );
      await onApplyProfile(revised, setApplyProgress);
      setStagedCoefficients({});
      setMatrixCellDraftPercents({});
      setSweepResults({});
      setBoundsPreviewResults({});
      setBoundsPreviewPairKey(null);
      setSweepError(null);
      setAttentionScanRevision((revision) => revision + 1);
      if (flaggedPairs.length > 0) {
        setWorkspaceView("attention");
        setSelectedPairKey(flaggedPairs[0].pairKey);
        setExpandedSweepPair(flaggedPairs[0].pairKey);
      }
      setActionMessage(t("Applied revised matrix for {name}. Original measurements and the complete compensation revision history remain available.{flagged}", {
        name: compensationProfileBaseName(revised.name),
        flagged: flaggedPairs.length > 0
          ? t(flaggedPairs.length === 1
              ? " Retained {count} flagged pair for post-correction review."
              : " Retained {count} flagged pairs for post-correction review.",
            { count: flaggedPairs.length })
          : "",
      }));
    } catch (cause) {
      setActionIsError(true);
      setActionMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApplyingProfile(false);
      setLocalApplyProfileName(null);
      setApplyProgress(null);
    }
  };

  const navigateFlaggedPair = (direction: -1 | 1) => {
    if (flaggedPairs.length === 0) return;
    const currentIndex = flaggedPairs.findIndex(({ pairKey }) => pairKey === selectedPairKey);
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : flaggedPairs.length - 1
      : (currentIndex + direction + flaggedPairs.length) % flaggedPairs.length;
    const pair = flaggedPairs[nextIndex];
    setHoveredPairKey(null);
    setSelectedPairKey(pair.pairKey);
    setExpandedSweepPair(pair.pairKey);
  };

  const renderInspectorResizeHandle = () => (
    <div
      className="gl-comp-inspector-resize"
      role="separator"
      aria-label={t("Resize compensation inspector")}
      aria-orientation="vertical"
      aria-valuemin={360}
      aria-valuemax={900}
      aria-valuenow={inspectorWidth}
      tabIndex={0}
      title={t("Drag to resize the coefficient inspector; use Left/Right arrow keys for fine control")}
      onPointerDown={startInspectorResize}
      onKeyDown={handleInspectorResizeKeyDown}
    >
      <span aria-hidden="true" />
    </div>
  );

  const selectGlobalPairFromMatrixMap = (pairKey: string) => {
    setHoveredPairKey(null);
    setSelectedPairKey(pairKey);
    setGlobalInspectorDetailsOpen(true);
    if (!globalInspectorCandidates.some((candidate) => candidate.pairKey === pairKey)) return;
    if (!visibleGlobalInspectorCandidates.some((candidate) => candidate.pairKey === pairKey)) {
      setGlobalPairFilter("all");
      setGlobalPairSearch("");
    }
    setPendingGlobalScrollPairKey(pairKey);
  };

  const renderPairInspector = (onClose?: () => void, compactGlobal = false) => {
    const flagged = selectedPair ? flaggedPairSet.has(selectedPair.pairKey) : false;
    const followupPair = selectedPair
      ? flaggedPairs.find(({ pairKey }) => pairKey === selectedPair.pairKey) ?? null
      : null;
    const boundsDraft = selectedPair
      ? boundsDraftForPair(selectedPair.pairKey, selectedPair.value)
      : null;
    const bounds = selectedPair
      ? resolvedBoundsForPair(selectedPair.pairKey, selectedPair.value)
      : null;
    const boundsPreview = selectedPair ? boundsPreviewResults[selectedPair.pairKey] : null;
    const selectedSourceKey = selectedPair ? matrixView!.sourceAxisKeys[selectedPair.sourceIndex] : "";
    const selectedReceiverKey = selectedPair ? matrixView!.receiverAxisKeys[selectedPair.receiverIndex] : "";
    const selectedPhysicalPrior = selectedPair?.interaction &&
        selectedPair.interaction !== "self" && selectedPair.interaction !== "other"
      ? 1
      : 0;
    const selectedAssessment = selectedPair && selectedPairPreview?.ready
      ? assessCompensationEvidence({
          coefficient: selectedPair.value,
          physicalPrior: selectedPhysicalPrior,
          evidence: selectedPairPreview.preview.evidence,
        }, matrixView!.kind, evidenceMode)
      : null;
    const baselineCoefficient = selectedPair
      ? profileCoefficient(installedBaselineProfile, selectedSourceKey, selectedReceiverKey)
      : null;
    const installedCoefficient = selectedPair?.value ?? null;
    const stagedCoefficient = selectedPair ? stagedCoefficients[selectedPair.pairKey] : undefined;
    const flowCandidateActive = Boolean(
      selectedPair &&
      profileRecord?.scientific.kind === "flow-spillover" &&
      onPreviewCompensationCandidate &&
      Object.keys(stagedCoefficients).length > 0,
    );
    const selectedFlowCandidatePreview = flowCandidatePreview.state !== "idle" &&
        flowCandidatePreview.state !== "error" &&
        flowCandidatePreview.pairKey === selectedPair?.pairKey
      ? flowCandidatePreview.preview
      : null;
    const stableComparisonPreview = selectedFlowCandidatePreview ??
      (selectedPairPreview?.ready ? selectedPairPreview.preview : null);
    const historyEntries: Array<Readonly<{ label: string; value: number }>> = [];
    if (
      baselineCoefficient !== null && installedCoefficient !== null &&
      (profileRecord?.recordType === "revision" || baselineCoefficient !== installedCoefficient)
    ) {
      historyEntries.push({ label: t("Baseline"), value: baselineCoefficient });
    }
    if (installedCoefficient !== null) historyEntries.push({ label: t("Installed"), value: installedCoefficient });
    if (stagedCoefficient !== undefined) historyEntries.push({ label: t("Staged"), value: stagedCoefficient });
    const flaggedPairIndex = flaggedPairs.findIndex(({ pairKey }) => pairKey === selectedPairKey);
    return (
      <section className={`gl-comp-inspector${compactGlobal ? " is-global" : ""}`} aria-labelledby="comp-selected-heading">
        <div className="gl-comp-panel-head gl-comp-inspector-head">
          <div>
            <h3 id="comp-selected-heading">{t("Selected coefficient")}</h3>
            {!compactGlobal && <span>
              {t(hoveredPairKey
                ? "Hover preview · click to pin this pair."
                : selectedPairKey
                  ? "Pinned pair · hover another cell to compare."
                  : "Select a matrix cell or follow-up pair.")}
            </span>}
          </div>
          <div className="gl-comp-inspector-actions">
            <div className="gl-comp-flag-navigation" aria-label={t("Flagged compensation pair navigation")}>
              <button
                type="button"
                className="gl-mini-btn"
                aria-label={t("Previous flagged compensation pair")}
                disabled={flaggedPairs.length === 0}
                onClick={() => navigateFlaggedPair(-1)}
              >
                ←
              </button>
              <span>
                {flaggedPairIndex >= 0
                  ? t("{current} / {total} flagged", { current: flaggedPairIndex + 1, total: flaggedPairs.length })
                  : t("{total} flagged", { total: flaggedPairs.length })}
              </span>
              <button
                type="button"
                className="gl-mini-btn"
                aria-label={t("Next flagged compensation pair")}
                disabled={flaggedPairs.length === 0}
                onClick={() => navigateFlaggedPair(1)}
              >
                →
              </button>
            </div>
            {onClose && (
              <button
                type="button"
                className="gl-mini-btn gl-comp-inspector-close"
                aria-label={t("Close global compensation pair details")}
                title={t("Close details and return to the full gallery")}
                onClick={onClose}
              >
                ×
              </button>
            )}
          </div>
        </div>
        {selectedPair ? (
          <div className={`gl-comp-pair-detail${compactGlobal ? " is-global" : ""}`}>
            <div className="gl-comp-pair-route">
              <div><span>{t("Source channel")}</span><strong>{selectedPair.source.label}</strong><small>{selectedPair.source.pnn}</small></div>
              <span aria-hidden="true">→</span>
              <div><span>{t("Receiver")}</span><strong>{selectedPair.receiver.label}</strong><small>{selectedPair.receiver.pnn}</small></div>
            </div>
            {selectedAssessment && (
              <div
                className={`gl-comp-evidence-badge is-${selectedAssessment.category}`}
                title={t(selectedAssessment.detail)}
              >
                <strong>{t(selectedAssessment.label)}</strong>
                <span>{t(selectedAssessment.detail)}</span>
              </div>
            )}
            <label className="gl-comp-followup-toggle">
              <input
                type="checkbox"
                checked={flagged}
                disabled={!profileRecord || !includedProfileChannels.has(matrixView!.sourceAxisKeys[selectedPair.sourceIndex]) || !includedProfileChannels.has(matrixView!.receiverAxisKeys[selectedPair.receiverIndex])}
                onChange={(event) => toggleFlaggedPair(selectedPair.pairKey, event.currentTarget.checked)}
              />
              <span>{t("Flag for follow-up")}</span>
              <small>{t("Add this pair to the curated Flagged queue.")}</small>
            </label>
            <div className="gl-comp-coefficient-readout" title={t("Stored fraction: {value}", { value: significantNumber(selectedPair.value, 10) })}>
              <span>{t(stagedCoefficients[selectedPair.pairKey] === undefined ? "Matrix coefficient" : "Working coefficient")}</span>
              <strong>
                {Number.isFinite(stagedCoefficients[selectedPair.pairKey] ?? selectedPair.value)
                  ? `${((stagedCoefficients[selectedPair.pairKey] ?? selectedPair.value) * 100).toFixed(1)}%`
                  : String(stagedCoefficients[selectedPair.pairKey] ?? selectedPair.value)}
              </strong>
            </div>
            {historyEntries.length > 0 && (
              <div className="gl-comp-coefficient-history" aria-label={t("Coefficient history")}>
                {historyEntries.map((entry, index) => (
                  <div className="gl-comp-coefficient-history-step" key={`${entry.label}:${index}`}>
                    {index > 0 && <span aria-hidden="true">→</span>}
                    <div title={t("Exact fraction: {value}", { value: significantNumber(entry.value, 10) })}>
                      <small>{entry.label}</small>
                      <strong>{(entry.value * 100).toFixed(1)}%</strong>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {profileRecord && selectedPairKey === selectedPair.pairKey && !hoveredPairKey && (
              <div className="gl-comp-coefficient-editor">
                <label>
                  <span>{t("Coefficient (%)")}</span>
                  <ScrubbableNumberInput
                    step="0.1"
                    value={coefficientDraftPercent}
                    disabled={applyBusy}
                    onValueChange={(value) => {
                      setCoefficientDraftPercent(value);
                      if (
                        profileRecord.scientific.kind === "flow-spillover" &&
                        value.trim() !== "" &&
                        Number.isFinite(Number(value))
                      ) {
                        stageCoefficient(selectedPair.pairKey, Number(value) / 100);
                      }
                    }}
                  />
                </label>
                {profileRecord.scientific.kind === "flow-spillover" ? (
                  <small className="gl-comp-live-edit-hint">{t("Type, use arrows, or drag ↕ · previews immediately")}</small>
                ) : (
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy || !Number.isFinite(Number(coefficientDraftPercent)) || coefficientDraftPercent.trim() === ""}
                    onClick={() => stageCoefficient(selectedPair.pairKey, Number(coefficientDraftPercent) / 100)}
                  >
                    {t("Stage value")}
                  </button>
                )}
                {stagedCoefficients[selectedPair.pairKey] !== undefined && (
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy}
                    onClick={() => {
                      stageCoefficient(selectedPair.pairKey, selectedPair.value);
                      setMatrixCellDraftPercents((current) => {
                        const next = { ...current };
                        delete next[selectedPair.pairKey];
                        return next;
                      });
                    }}
                  >
                    {t("Reset")}
                  </button>
                )}
              </div>
            )}
            {flowCandidateActive && (
              <div className={`gl-comp-candidate-status${compactGlobal ? " is-compact" : ""}`} aria-label={t("Flow compensation coefficient preview")}>
                <div>
                  <strong>{t("Coefficient preview")}</strong>
                  <span>
                    {t("Original remains fixed; the right panel shows the complete working matrix.")}
                    {compactGlobal ? t(" The gallery remains installed until Apply.") : ""}
                  </span>
                </div>
                <em>
                  {stagedCoefficient === undefined
                    ? t("Working matrix")
                    : `${(selectedPair.value * 100).toFixed(1)}% → ${(stagedCoefficient * 100).toFixed(1)}%`}
                </em>
                {flowCandidatePreview.state === "updating" &&
                  flowCandidatePreview.pairKey === selectedPair.pairKey && (
                    <span role="status">{t("Updating…")}</span>
                  )}
                {flowCandidatePreview.state === "error" &&
                  flowCandidatePreview.pairKey === selectedPair.pairKey && (
                    <span className="is-error" role="alert">{t(flowCandidatePreview.message)}</span>
                  )}
              </div>
            )}
            {selectedPair.interaction && selectedPair.interaction !== "other" && (
              <div className="gl-comp-interaction-type">
                {t("Physical relationship:")} <strong>{selectedPair.interaction}</strong>
              </div>
            )}
            {compactGlobal && (stableComparisonPreview ? (
              <CompensationPairBiplots
                preview={stableComparisonPreview}
                sourceLabel={selectedPair.source.label}
                receiverLabel={selectedPair.receiver.label}
                kind={matrixView!.kind}
                densitySmoothing={resolvedDensitySmoothing}
                compact
                compensatedTitle={t(selectedFlowCandidatePreview ? "Candidate" : "Compensated")}
              />
            ) : selectedPairPreview && !selectedPairPreview.ready ? (
              <div className="gl-comp-biplot-unavailable">{t(selectedPairPreview.reason)}</div>
            ) : null)}
            {compactGlobal && (
              <MiniCompensationMatrix
                matrixView={matrixView!}
                sourceChannels={sourceChannels}
                receiverChannels={receiverChannels}
                selectedSourceIndex={selectedPair.sourceIndex}
                selectedReceiverIndex={selectedPair.receiverIndex}
                stagedCoefficients={stagedCoefficients}
                maximumAbsoluteOffDiagonal={matrixMaxAbsoluteOffDiagonal}
                onSelect={selectGlobalPairFromMatrixMap}
              />
            )}
            {!compactGlobal && (
              stableComparisonPreview ? (
                <CompensationPairBiplots
                  preview={stableComparisonPreview}
                  sourceLabel={selectedPair.source.label}
                  receiverLabel={selectedPair.receiver.label}
                  kind={matrixView!.kind}
                  densitySmoothing={resolvedDensitySmoothing}
                  compensatedTitle={t(selectedFlowCandidatePreview ? "Candidate" : "Compensated")}
                />
              ) : selectedPairPreview && !selectedPairPreview.ready ? (
                <div className="gl-comp-biplot-unavailable">{t(selectedPairPreview.reason)}</div>
              ) : null
            )}
            {flagged && followupPair && boundsDraft && bounds && (
              <div className="gl-comp-bounds-tool">
                <div>
                  <strong>{t("Sweep bounds")}</strong>
                  <span>{t("Four exact candidates will be interpolated across these endpoints.")}</span>
                </div>
                <div className="gl-comp-bounds-inputs">
                  <label>
                    <span>{t("Lower (%)")}</span>
                    <ScrubbableNumberInput
                      step="0.1"
                      value={boundsDraft.lowerPercent}
                      disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null}
                      onValueChange={(value) => setSweepBoundDraft(selectedPair.pairKey, selectedPair.value, "lowerPercent", value)}
                    />
                  </label>
                  <label>
                    <span>{t("Upper (%)")}</span>
                    <ScrubbableNumberInput
                      step="0.1"
                      value={boundsDraft.upperPercent}
                      disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null}
                      onValueChange={(value) => setSweepBoundDraft(selectedPair.pairKey, selectedPair.value, "upperPercent", value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null || bounds.error !== null}
                    onClick={() => void previewSweepBounds(followupPair)}
                  >
                    {t(boundsPreviewPairKey === selectedPair.pairKey ? "Previewing…" : "Preview endpoints")}
                  </button>
                </div>
                {bounds.error ? (
                  <div className="gl-comp-bounds-error">{t(bounds.error)}</div>
                ) : (
                  <small>
                    {t("Fast preview: exact solver on {preview} frozen events. Screening only; the four-option sweep uses up to {sweep} events.", {
                      preview: Math.min(reviewEventCount, BOUNDS_PREVIEW_EVENT_LIMIT).toLocaleString(),
                      sweep: Math.min(reviewEventCount, SWEEP_EVENT_LIMIT).toLocaleString(),
                    })}
                  </small>
                )}
                {boundsPreview && (
                  <div className="gl-comp-bounds-preview">
                    {boundsPreview.values.map((value) => (
                      <div className={value.isCurrent ? "is-current" : undefined} key={`${selectedPair.pairKey}:bounds:${value.value}:${value.isCurrent}`}>
                        <DensityBiplot
                          title={`${value.isCurrent ? `${t("Current")} · ` : ""}${(value.value * 100).toFixed(2)}%`}
                          panel={value.preview.compensated}
                          preview={value.preview}
                          sourceLabel={selectedPair.source.label}
                          receiverLabel={selectedPair.receiver.label}
                          minimumSize={145}
                          maximumSize={220}
                          densitySmoothing={resolvedDensitySmoothing}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="gl-hint">{t(matrixView!.coefficientNote)}</p>
          </div>
        ) : (
          <div className="gl-comp-inspector-empty">{t("No coefficient selected.")}</div>
        )}
      </section>
    );
  };

  const renderGlobalPlotTile = (
    pair: CompensationGlobalPairCandidate,
    dataset: CompensationGlobalInspectorDataset,
  ) => (
    <GlobalCompensationPlotTile
      key={pair.pairKey}
      dataset={dataset}
      pair={pair}
      plotSize={resolvedGlobalPlotSize}
      densitySmoothing={resolvedDensitySmoothing}
      flagged={flaggedPairSet.has(pair.pairKey)}
      selected={selectedPairKey === pair.pairKey}
      onSelect={() => {
        setHoveredPairKey(null);
        setSelectedPairKey(pair.pairKey);
        setGlobalInspectorDetailsOpen(true);
      }}
      onFlag={(flagged) => toggleFlaggedPair(pair.pairKey, flagged)}
    />
  );

  const exportGlobalComparison = async (
    format: CompensationComparisonExportFormat,
    onProgress: (progress: CompensationComparisonExportProgress) => void,
  ) => {
    if (!globalInspectorDataset?.ready || !matrixView) {
      throw new Error("Apply compensation before exporting the Global inspector comparison.");
    }
    const pairs = orderedGlobalExportCandidates.map((pair) => ({
      pairKey: pair.pairKey,
      sourceLabel: pair.source.label,
      receiverLabel: pair.receiver.label,
      coefficient: pair.coefficient,
      relationship: pair.interaction,
      buildPreview: () => {
        const result = buildCompensationGlobalPairPreview(
          globalInspectorDataset.dataset,
          pair.source.key,
          pair.receiver.key,
        );
        if (!result.ready) throw new Error(result.reason);
        return result.preview;
      },
    }));
    await exportCompensationComparison(pairs, {
      sampleName,
      profileName: profileRecord?.name ?? t(matrixView.title),
      populationName: activeReviewPopulation?.name ?? t("All Events"),
      filterLabel: globalExportFilterLabel,
      densitySmoothing: resolvedDensitySmoothing,
      densityColorPower,
      pointAlpha: resolvedPointAlpha,
    }, format, onProgress);
  };

  if (!visible) {
    // Preserve this component's imported matrix, staged coefficients, and persisted controls,
    // but unmount the matrix/gallery/canvas subtree. Hidden canvases can otherwise keep draining
    // the cooperative render queue long after the user has returned to the gating editor.
    return (
      <div
        className="gl-tab-panel gl-tab-fill gl-compensation-tab"
        style={{ display: "none" }}
        aria-hidden="true"
        data-compensation-dormant="true"
      />
    );
  }

  return (
    <DensityColorPowerContext.Provider value={densityColorPower}>
    <CompensationPointAlphaContext.Provider value={resolvedPointAlpha}>
    <div
      className="gl-tab-panel gl-tab-fill gl-compensation-tab"
    >
      <div className={`gl-comp-overview${workspaceView === "global" ? " is-global-scan" : ""}`}>
        <div className="gl-comp-overview-title">
          <h2 className="gl-tab-title">{t("Compensation")}</h2>
          {!profileMetadata && <span className="gl-comp-method">{displayMethod}</span>}
        </div>
        {profileMetadata ? (
          <div
            id="comp-profile-heading"
            className={`gl-comp-profile-pill${installedStatus.state === "ready" ? " is-ready" : " is-stale"}`}
            role="status"
            title={t("{source} · {method} · {count} solve channels · {status} · {assay}", {
              source: profileDisplaySource,
              method: displayMethod,
              count: channelCount,
              status: t(installedStatus.state === "ready" ? "Ready" : "Unavailable"),
              assay: t(compensationOn ? "Compensated assay active" : "Original assay active"),
            })}
          >
            <span className={`gl-comp-status-dot${installedStatus.state === "ready" ? " is-ready" : " is-stale"}`} aria-hidden="true" />
            <span className="gl-sr-only">{t("{kind} compensation installed. Installed compensation profile.", {
              kind: profileMetadata.kind === "cytof-spillover" ? "CyTOF" : "Flow",
            })} </span>
            <strong>{compactProfileSource}</strong>
            <span>{t("{method} · {count} ch · {status}", {
              method: displayMethod,
              count: channelCount,
              status: installedStatus.state === "ready" ? t("Ready") : t("Unavailable"),
            })}</span>
            <em>{compensationOn ? t("Comp active") : t("Original active")}</em>
          </div>
        ) : (
          <span
            className="gl-comp-summary"
            aria-label={t("Compensation summary")}
            data-active-layer={compensationOn ? "compensated" : "original"}
          >
            {t("{source} · {assay} · {count} channels", {
              source: t(source),
              assay: t(compensationOn ? "Compensated assay active" : "Original assay active"),
              count: channelCount,
            })}
          </span>
        )}
        {profileMetadata && sample.instrument === "cytof" && (
          <button
            type="button"
            className="gl-mini-btn gl-comp-header-replace"
            disabled={applyBusy}
            onClick={() => cytofFileRef.current?.click()}
          >
            {t("Replace matrix…")}
          </button>
        )}
        {applyWorkerCount !== undefined && applyWorkerLimit !== undefined && onApplyWorkerCountChange && (
          <label
            className="gl-comp-worker-control"
            title={t("Event-parallel Apply workers. The aggregate memory budget stays fixed; more workers are not always faster.")}
          >
            <span>{t("Apply workers")}</span>
            <select
              aria-label={t("Compensation Apply worker count")}
              value={applyWorkerCount}
              disabled={applyBusy}
              onChange={(event) => onApplyWorkerCountChange(Number(event.currentTarget.value))}
            >
              {Array.from({ length: applyWorkerLimit }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>{count}</option>
              ))}
            </select>
            <small>/ {applyWorkerLimit}</small>
          </label>
        )}
        <label className="gl-comp-review-population">
          <span>{t("Review population")}</span>
          <select
            aria-label={t("Compensation review population")}
            value={activeReviewPopulation?.id ?? "all"}
            disabled={sweepProgress !== null || boundsPreviewPairKey !== null}
            onChange={(event) => setReviewPopulationId(event.currentTarget.value)}
          >
            <option value="all">{t("All Events")}</option>
            {reviewPopulations.map((population) => (
              <option key={population.id} value={population.id}>
                {`${"· ".repeat(population.depth)}${population.name} (${population.eventCount.toLocaleString()})`}
              </option>
            ))}
          </select>
          <small>{t("{count} events · applies to biplots, attention ranking, and sweeps; membership frozen from the current assay", {
            count: reviewEventCount.toLocaleString(),
          })}</small>
        </label>
        {workspaceView !== "global" && (
          <label
            className="gl-comp-preview-events"
            title={t("Controls the frozen event set shown in the selected-pair Original and comparison biplots. Applying compensation still processes every event.")}
          >
            <span>{t("Pair preview")}</span>
            <select
              aria-label={t("Compensation pair preview event count")}
              value={String(resolvedPairPreviewEventLimit)}
              disabled={applyBusy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setPairPreviewEventLimit(value === "all" ? "all" : Number(value) as PairPreviewEventLimit);
              }}
            >
              {PAIR_PREVIEW_EVENT_LIMITS.map((limit) => (
                <option key={limit} value={limit}>{t("{count} events", { count: limit.toLocaleString() })}</option>
              ))}
              <option value="all">{t("All available")}</option>
            </select>
            <small>{t("Showing {shown} of {total}; Apply always uses all events.", {
              shown: reviewBiplotEventIndices.length.toLocaleString(),
              total: reviewEventCount.toLocaleString(),
            })}</small>
          </label>
        )}
        {canToggle && <span className="gl-comp-global-layer-note">{t("Assay selection in the top bar applies to every tab.")}</span>}
      </div>

      {sample.instrument === "cytof" && (
        <input
          ref={cytofFileRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          className="gl-sr-only"
          aria-label={t("Choose CyTOF spillover matrix")}
          onChange={(event) => void handleCytofMatrixFile(event)}
        />
      )}

      {actionMessage && (
        <div className={actionIsError ? "gl-comp-error" : "gl-comp-status"} role={actionIsError ? "alert" : "status"}>
          {t(actionMessage)}
        </div>
      )}

      {sample.instrument === "flow" && spill && !profileMetadata && (
        <section className="gl-comp-flow-enable" aria-labelledby="comp-flow-enable-heading">
          <div>
            <strong id="comp-flow-enable-heading">{t("Embedded FCS matrix")}</strong>
            <span>{t("Install this exact matrix as the immutable baseline to edit coefficients and preview their effect.")}</span>
          </div>
          {hasExistingGates && (
            <label className="gl-comp-gate-acknowledgement is-compact">
              <input
                type="checkbox"
                checked={gateRecomputeAcknowledged}
                disabled={applyBusy}
                onChange={(event) => setGateRecomputeAcknowledged(event.currentTarget.checked)}
              />
              <span>{t("Recompute existing gate memberships in compensated coordinates.")}</span>
            </label>
          )}
          {embeddedFlowProfileMatrix?.error ? (
            <div className="gl-comp-error" role="alert">{embeddedFlowProfileMatrix.error}</div>
          ) : applyBusy ? (
            <div className="gl-comp-flow-enable-progress" role="status">
              {visibleApplyProgress
                ? t("Preparing editor… {percent}%", { percent: Math.round(visibleApplyProgress.fraction * 100) })
                : t("Preparing editor…")}
              <button
                type="button"
                className="gl-btn-ghost"
                disabled={visibleApplyProgress?.phase === "cancelling"}
                onClick={onCancelApply}
              >
                {t(visibleApplyProgress?.phase === "cancelling" ? "Cancelling…" : "Cancel")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="gl-btn"
              disabled={!onApplyProfile || (hasExistingGates && !gateRecomputeAcknowledged)}
              onClick={() => void enableEmbeddedFlowEditing()}
            >
              {t("Enable matrix editing")}
            </button>
          )}
        </section>
      )}

      {sample.instrument === "cytof" && (!profileMetadata || cytofDraft) && (
        <section className="gl-comp-cytof-import" aria-labelledby="comp-cytof-import-heading">
          <div className="gl-comp-panel-head gl-comp-import-head">
            <div>
              <h3 id="comp-cytof-import-heading">{t("CyTOF spillover matrix")}</h3>
              <span>{t("Linear counts → non-negative least squares → arcsinh display")}</span>
            </div>
            <div className="gl-comp-import-actions">
              <button
                type="button"
                className={cytofDraft ? "gl-btn-ghost" : "gl-btn"}
                disabled={applyBusy}
                onClick={() => cytofFileRef.current?.click()}
              >
                {cytofDraft ? t("Choose another matrix…") : t("Import matrix…")}
              </button>
            </div>
          </div>

          {cytofImportError && <div className="gl-comp-error" role="alert">{t(cytofImportError)}</div>}

          {cytofDraft && cytofCompatibility && (
            <div className="gl-comp-import-body">
              <div className="gl-comp-import-summary">
                <div>
                  <strong>{cytofDraft.fileName}</strong>
                  <span>{t("{sources} sources × {receivers} receivers", {
                    sources: cytofDraft.matrix.sourceChannels.length,
                    receivers: cytofDraft.matrix.receiverChannels.length,
                  })}</span>
                </div>
                <dl>
                  <div><dt>{t("Exact matches")}</dt><dd>{cytofCompatibility.matchedChannels.length}</dd></div>
                  <div><dt>{t("Included")}</dt><dd>{cytofCompatibility.includedChannels.length}</dd></div>
                  <div><dt>{t("Not in FCS")}</dt><dd>{cytofCompatibility.matrixOnlyChannels.length}</dd></div>
                </dl>
              </div>

              <div className="gl-comp-channel-head">
                <div>
                  <h4>{t("Channels included in NNLS")}</h4>
                  <span>{t("Exact, case-sensitive $PnN matching; unchecked channels pass through unchanged.")}</span>
                </div>
                <div>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy}
                    onClick={() => setIncludedCytofChannels(new Set(cytofCompatibility.matchedChannels))}
                  >
                    {t("All matched")}
                  </button>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy}
                    onClick={() => setIncludedCytofChannels(new Set())}
                  >
                    {t("None")}
                  </button>
                </div>
              </div>
              <div className="gl-comp-channel-grid">
                {cytofDraft.matrix.receiverChannels.map((pnn) => {
                  const matched = cytofCompatibility.matchedChannels.includes(pnn);
                  return (
                    <label key={pnn} className={matched ? "" : "is-unavailable"} title={matched ? pnn : t("{channel} is not uniquely present in this FCS file", { channel: pnn })}>
                      <input
                        type="checkbox"
                        checked={includedCytofChannels.has(pnn)}
                        disabled={!matched || applyBusy}
                        onChange={(event) => setCytofChannelIncluded(pnn, event.currentTarget.checked)}
                      />
                      <span>{channelDisplayForPnn(sample, pnn).combined}</span>
                      {!matched && <small>{t("not matched")}</small>}
                    </label>
                  );
                })}
              </div>

              {(cytofDraft.validationWarnings.length > 0 || cytofCompatibility.warnings.length > 0) && (
                <div className="gl-comp-warning" role="status">
                  <span>
                    {t("{count} review items: {messages}", {
                      count: cytofDraft.validationWarnings.length + cytofCompatibility.warnings.length,
                      messages: [
                      ...cytofDraft.validationWarnings.map(({ message }) => message),
                      ...cytofCompatibility.warnings.map(({ message }) => message),
                      ].map((message) => t(message)).join(" "),
                    })}
                  </span>
                </div>
              )}

              {cytofCompatibility.blockers.length > 0 && (
                <div className="gl-comp-error" role="alert">
                  {cytofCompatibility.blockers.map(({ message }) => t(message)).join(" ")}
                </div>
              )}

              {hasExistingGates && (
                <label className="gl-comp-gate-acknowledgement">
                  <input
                    type="checkbox"
                    checked={gateRecomputeAcknowledged}
                    disabled={applyBusy}
                    onChange={(event) => setGateRecomputeAcknowledged(event.currentTarget.checked)}
                  />
                  <span>{t("I understand that existing gates are retained, but their memberships will be recomputed using the compensated coordinates.")}</span>
                </label>
              )}

              <div className="gl-comp-apply-row">
                <div>
                  {applyBusy
                    ? visibleApplyProgress
                      ? t("{phase}… {percent}% ({processed} / {total} events)", {
                          phase: t(visibleApplyProgress.phase === "cancelling" ? "Cancelling" : visibleApplyProgress.phase === "preparing" ? "Preparing" : "Applying"),
                          percent: Math.round(visibleApplyProgress.fraction * 100),
                          processed: visibleApplyProgress.processedEvents.toLocaleString(),
                          total: visibleApplyProgress.totalEvents.toLocaleString(),
                        })
                      : t("Preparing compensation…")
                    : t("The Original assay is retained and can be restored at any time.")}
                </div>
                {applyBusy ? (
                  <button
                    type="button"
                    className="gl-btn-ghost"
                    disabled={visibleApplyProgress?.phase === "cancelling"}
                    onClick={onCancelApply}
                  >
                    {t(visibleApplyProgress?.phase === "cancelling" ? "Cancelling…" : "Cancel")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="gl-btn"
                    disabled={
                      !onApplyProfile ||
                      !cytofCompatibility.canApply ||
                      (hasExistingGates && !gateRecomputeAcknowledged)
                    }
                    onClick={() => void applyCytofProfile()}
                  >
                    {t("Apply NNLS compensation")}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {matrixHasNonFinite && (
        <div className="gl-comp-error" role="alert">
          {t("The embedded compensation matrix contains non-finite values and cannot be applied.")}
        </div>
      )}

      {unusualCoefficients.length > 0 && (
        <div className="gl-comp-warning" role="status">
          <span>{t("{count} off-diagonal coefficients are above 100%. Review the matrix source before applying it.", {
            count: unusualCoefficients.length,
          })}</span>
          <button type="button" className="gl-mini-btn" onClick={() => setOpenDrawers((current) => ({ ...current, review: true }))}>
            {t("Review details")}
          </button>
        </div>
      )}

      {profileMetadata && installedStatus.state === "stale" && (
        <div className="gl-comp-warning" role="status">
          {t("This profile cannot be applied to the current sample context. Open the review queue for exact reasons.")}
        </div>
      )}

      {matrixView && (
        <div className="gl-comp-workspace-tabs" role="tablist" aria-label={t("Compensation workspace")}>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceView === "matrix"}
            className={workspaceView === "matrix" ? "active" : undefined}
            onClick={() => {
              setHoveredPairKey(null);
              setWorkspaceView("matrix");
            }}
          >
            {t("Matrix")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceView === "global"}
            className={workspaceView === "global" ? "active" : undefined}
            onClick={() => {
              setHoveredPairKey(null);
              setWorkspaceView("global");
            }}
          >
            {t("Global inspector")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceView === "attention"}
            className={workspaceView === "attention" ? "active" : undefined}
            onClick={() => {
              setHoveredPairKey(null);
              setWorkspaceView("attention");
            }}
          >
            {t("Flagged")}{flaggedPairs.length > 0 ? ` (${flaggedPairs.length})` : ""}
          </button>
          <label
            className="gl-comp-density-smoothing"
            title={t("Blur radius for every compensation biplot; both assay layers always use the same setting")}
          >
            <span>{t("Density smooth")}</span>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={resolvedDensitySmoothing}
              aria-label={t("Compensation biplot density smoothing")}
              onChange={(event) => setDensitySmoothing(Number(event.currentTarget.value))}
            />
            <output>{resolvedDensitySmoothing}</output>
          </label>
          <label
            className="gl-comp-point-alpha"
            title={t("Point opacity for every compensation biplot")}
          >
            <span>{t("Point alpha")}</span>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={resolvedPointAlpha}
              aria-label={t("Compensation biplot point alpha")}
              onChange={(event) => setPointAlpha(Number(event.currentTarget.value))}
            />
            <output>{resolvedPointAlpha.toFixed(2)}</output>
          </label>
          <DensityColourControl
            className="gl-comp-density-colour"
            value={densityColorPower}
            onChange={onDensityColorPowerChange}
          />
          {Object.keys(stagedCoefficients).length > 0 && (
            <div className="gl-comp-staged-actions">
              <span>{t("{count} pending edits", { count: Object.keys(stagedCoefficients).length })}</span>
              <button
                type="button"
                className="gl-mini-btn"
                disabled={applyBusy}
                onClick={() => {
                  setStagedCoefficients({});
                  setMatrixCellDraftPercents({});
                  setActionMessage(null);
                }}
              >
                {t("Discard")}
              </button>
              <button
                type="button"
                className="gl-btn"
                disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null || !onApplyProfile}
                onClick={() => void applyStagedMatrix()}
              >
                {t("Apply revised matrix")}
              </button>
            </div>
          )}
        </div>
      )}

      {matrixView && workspaceView === "matrix" ? (
        <div
          ref={commonPathRef}
          className="gl-comp-common-path"
          style={{ gridTemplateColumns: `minmax(440px, 1fr) 8px ${inspectorWidth}px` }}
        >
          <section className="gl-comp-matrix-panel" aria-labelledby="comp-matrix-heading">
            <div className="gl-comp-panel-head gl-comp-matrix-head">
              <div>
                <h3 id="comp-matrix-heading">{t(matrixView.title)}</h3>
                <span>{t(matrixView.subtitle)}</span>
              </div>
              <div className="gl-comp-matrix-head-actions">
                {flowInlineMatrix && (
                  <span className="gl-comp-inline-edit-note">{t("Edit cells directly (%)")}</span>
                )}
                <div className="gl-comp-matrix-legend" aria-label={t("Matrix colour key")}>
                  <span><i className="is-diagonal" aria-hidden="true" />{t("Diagonal (self)")}</span>
                  <span><i className="is-positive" aria-hidden="true" />{t("Positive spill")}</span>
                  <span><i className="is-negative" aria-hidden="true" />{t("Negative")}</span>
                </div>
                <button
                  type="button"
                  className="gl-mini-btn"
                  onClick={() => setExportDialogOpen(true)}
                >
                  {t("Export CSV…")}
                </button>
              </div>
            </div>
            <div className="gl-comp-matrix-scroll">
              <div
                className={`gl-comp-matrix-stage${flowInlineMatrix ? " is-flow-inline" : ""}`}
                style={{
                  width: 112 + matrixView.receiverAxisKeys.length * matrixCellSize,
                }}
              >
                <div className="gl-comp-matrix-axis gl-comp-matrix-receiver-axis">{t("Receiver channels →")}</div>
                <div className="gl-comp-matrix-body">
                  <div className="gl-comp-matrix-axis gl-comp-matrix-source-axis">{t("Source channels ↓")}</div>
                  <div className="gl-comp-matrix-labelled">
                    <div className="gl-comp-matrix-corner" aria-hidden="true">%</div>
                    <div
                      className="gl-comp-column-labels"
                      aria-label={t("Receiver channel labels")}
                      style={{
                        gridTemplateColumns: `repeat(${matrixView.receiverAxisKeys.length}, ${matrixCellSize}px)`,
                      }}
                    >
                      {receiverChannels.map((channel, receiverIndex) => (
                        <div
                          key={matrixView.receiverAxisKeys[receiverIndex]}
                          className={selectedPair?.receiverIndex === receiverIndex ? "is-selected" : undefined}
                          title={channel.combined}
                        >
                          <span>{channel.pnn}</span>
                        </div>
                      ))}
                    </div>
                    <div
                      className="gl-comp-row-labels"
                      aria-label={t("Source channel labels")}
                      style={{
                        gridTemplateRows: `repeat(${matrixView.sourceAxisKeys.length}, ${matrixCellSize}px)`,
                      }}
                    >
                      {sourceChannels.map((channel, sourceIndex) => (
                        <div
                          key={matrixView.sourceAxisKeys[sourceIndex]}
                          className={selectedPair?.sourceIndex === sourceIndex ? "is-selected" : undefined}
                          title={channel.combined}
                        >
                          {channel.pnn}
                        </div>
                      ))}
                    </div>
                    <div
                      ref={matrixRef}
                      className="gl-comp-matrix shows-values"
                      role="grid"
                      aria-label={t("Compensation matrix; source rows and receiver columns")}
                      aria-rowcount={matrixView.sourceAxisKeys.length}
                      aria-colcount={matrixView.receiverAxisKeys.length}
                      style={{
                        gridTemplateColumns: `repeat(${matrixView.receiverAxisKeys.length}, ${matrixCellSize}px)`,
                        gridTemplateRows: `repeat(${matrixView.sourceAxisKeys.length}, ${matrixCellSize}px)`,
                      }}
                    >
                      {matrixView.matrix.map((row, sourceIndex) => (
                        <div
                          role="row"
                          className="gl-comp-matrix-row"
                          key={matrixView.sourceAxisKeys[sourceIndex]}
                          aria-rowindex={sourceIndex + 1}
                        >
                          {row.map((value, receiverIndex) => {
                            const sourceKey = matrixView.sourceAxisKeys[sourceIndex];
                            const receiverKey = matrixView.receiverAxisKeys[receiverIndex];
                            const pairKey = `${sourceKey}${PAIR_SEPARATOR}${receiverKey}`;
                            const stagedValue = stagedCoefficients[pairKey];
                            const workingValue = stagedValue ?? value;
                            const diagonal = sourceKey === receiverKey;
                            const selected = selectedPair?.sourceIndex === sourceIndex && selectedPair.receiverIndex === receiverIndex;
                            const sourceSelected = selectedPair?.sourceIndex === sourceIndex;
                            const receiverSelected = selectedPair?.receiverIndex === receiverIndex;
                            const sourceChannel = sourceChannels[sourceIndex];
                            const receiverChannel = receiverChannels[receiverIndex];
                            const interaction: CytofInteractionType | null = matrixView.kind === "cytof"
                              ? cytofInteractionType(sourceKey, receiverKey)
                              : null;
                            const cellAppearance = compensationMatrixCellAppearance(
                              workingValue,
                              matrixMaxAbsoluteOffDiagonal,
                              diagonal,
                            );
                            const firstReceiver = matrixView.receiverAxisKeys.findIndex((candidate) => candidate !== sourceKey);
                            const pinned = selectedPairKey === pairKey;
                            const defaultTabStop = selectedPairKey === null && sourceIndex === 0 && receiverIndex === firstReceiver;
                            const displayValue = !Number.isFinite(workingValue)
                              ? String(workingValue)
                              : workingValue === 0
                                ? ""
                                : (workingValue * 100).toFixed(1);
                            const interactionText = interaction && interaction !== "other" && interaction !== "self"
                              ? ` · ${interaction}`
                              : "";
                            const cellDraftPercent = matrixCellDraftPercents[pairKey] ??
                              editableCoefficientPercent(workingValue);
                            if (flowInlineMatrix && !diagonal) {
                              return (
                                <ScrubbableNumberInput
                                  key={receiverKey}
                                  role="gridcell"
                                  className={`gl-comp-cell gl-comp-cell-input${selected ? " selected" : ""}${pinned ? " is-pinned" : ""}${stagedValue === undefined ? "" : " is-staged"}${sourceSelected ? " is-selected-source" : ""}${receiverSelected ? " is-selected-receiver" : ""}`}
                                  min="0"
                                  step="0.1"
                                  value={cellDraftPercent}
                                  disabled={applyBusy}
                                  data-source-index={sourceIndex}
                                  data-receiver-index={receiverIndex}
                                  aria-colindex={receiverIndex + 1}
                                  aria-selected={pinned}
                                  aria-label={t("{source} source to {receiver} receiver coefficient, percent{pending}", {
                                    source: sourceChannel.combined,
                                    receiver: receiverChannel.combined,
                                    pending: stagedValue === undefined ? "" : t(", pending edit"),
                                  })}
                                  title={t("{source} → {receiver} · type or drag vertically to edit spillover percentage{pending}", {
                                    source: sourceChannel.combined,
                                    receiver: receiverChannel.combined,
                                    pending: stagedValue === undefined ? "" : t(" · pending edit"),
                                  })}
                                  style={cellAppearance}
                                  onFocus={() => setSelectedPairKey(pairKey)}
                                  onMouseEnter={() => setHoveredPairKey(pairKey)}
                                  onMouseLeave={() => setHoveredPairKey((current) => current === pairKey ? null : current)}
                                  onClick={() => setSelectedPairKey(pairKey)}
                                  onValueChange={(next) => {
                                    setSelectedPairKey(pairKey);
                                    setMatrixCellDraftPercents((current) => ({ ...current, [pairKey]: next }));
                                    if (next.trim() !== "" && Number.isFinite(Number(next))) {
                                      stageCoefficient(pairKey, Number(next) / 100);
                                    }
                                  }}
                                  onBlur={(event) => {
                                    const next = event.currentTarget.value;
                                    if (next.trim() === "" || !Number.isFinite(Number(next))) {
                                      setMatrixCellDraftPercents((current) => {
                                        const updated = { ...current };
                                        delete updated[pairKey];
                                        return updated;
                                      });
                                      return;
                                    }
                                    setMatrixCellDraftPercents((current) => ({
                                      ...current,
                                      [pairKey]: editableCoefficientPercent(Number(next) / 100),
                                    }));
                                  }}
                                />
                              );
                            }
                            return (
                              <button
                                type="button"
                                key={receiverKey}
                                role="gridcell"
                                className={`gl-comp-cell${diagonal ? " diagonal" : ""}${selected ? " selected" : ""}${pinned ? " is-pinned" : ""}${stagedValue === undefined ? "" : " is-staged"}${sourceSelected ? " is-selected-source" : ""}${receiverSelected ? " is-selected-receiver" : ""}`}
                                disabled={diagonal}
                                tabIndex={diagonal ? -1 : selected || defaultTabStop ? 0 : -1}
                                data-source-index={sourceIndex}
                                data-receiver-index={receiverIndex}
                                data-interaction={interaction ?? undefined}
                                aria-colindex={receiverIndex + 1}
                                aria-pressed={diagonal ? undefined : pinned}
                                aria-label={
                                  diagonal
                                    ? t("{channel} diagonal: {value}", { channel: sourceChannel.combined, value: percentText(workingValue) })
                                    : t("{source} source to {receiver} receiver: {value}{pending}{interaction}", {
                                        source: sourceChannel.combined,
                                        receiver: receiverChannel.combined,
                                        value: percentText(workingValue),
                                        pending: stagedValue === undefined ? "" : t(" (pending edit)"),
                                        interaction: interactionText,
                                      })
                                }
                                title={
                                  diagonal
                                    ? `${sourceChannel.combined} · self · ${percentText(workingValue)}`
                                    : `${sourceChannel.combined} → ${receiverChannel.combined} · ${percentText(workingValue)}${stagedValue === undefined ? "" : " · pending edit"}${interactionText}`
                                }
                                style={cellAppearance}
                                onFocus={() => {
                                  if (!diagonal) setSelectedPairKey(pairKey);
                                }}
                                onMouseEnter={() => {
                                  if (!diagonal) setHoveredPairKey(pairKey);
                                }}
                                onMouseLeave={() => setHoveredPairKey((current) => current === pairKey ? null : current)}
                                onClick={() => setSelectedPairKey(pairKey)}
                                onKeyDown={(event) => handleMatrixKeyDown(event, sourceIndex, receiverIndex)}
                              >
                                <span>{displayValue}</span>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {renderInspectorResizeHandle()}
          {renderPairInspector()}
        </div>
      ) : matrixView && workspaceView === "global" ? (
        <div
          ref={commonPathRef}
          className={`gl-comp-common-path gl-comp-global-path${globalInspectorDetailsOpen ? " has-details" : ""}`}
          style={{
            gridTemplateColumns: globalInspectorDetailsOpen
              ? `minmax(440px, 1fr) 8px ${inspectorWidth}px`
              : "minmax(0, 1fr)",
          }}
        >
          <GlobalInspectorLayerScope
            stateKey={stateKey}
            header={<>
              <div className="gl-comp-global-head-title">
                <h3 id="comp-global-inspector-heading">{t("Global data inspector")}</h3>
                <span
                  className="gl-comp-lock-pill"
                  title={t("The assay flip keeps the same events, axes, transform, density bins, colour scale, and tile geometry.")}
                >
                  {t("View locked")}
                </span>
              </div>
              <select
                aria-label={t("Global compensation pair filter")}
                title={t("Choose which channel pairs appear")}
                value={globalPairFilter}
                onChange={(event) => setGlobalPairFilter(event.currentTarget.value as CompensationGlobalPairFilter)}
              >
                <option value="relevant">{t("Matrix-linked / relevant")}</option>
                <option value="nonzero">{t("Non-zero coefficients")}</option>
                {matrixView.kind === "cytof" && (
                  <option value="physical">{t("Physical CyTOF relationships")}</option>
                )}
                <option value="flagged">{t("Flagged for follow-up")}</option>
                <option value="all">{t("All included pairs")}</option>
              </select>
              <select
                className="gl-comp-global-layout"
                aria-label={t("Global compensation plot layout")}
                title={t("Show one compressed gallery or organise channel pairs into labelled rows")}
                value={globalLayout}
                onChange={(event) => setGlobalLayout(event.currentTarget.value as CompensationGlobalLayout)}
              >
                <option value="compact">{t("Compact gallery")}</option>
                <option value="source">{t("Rows by source")}</option>
                <option value="receiver">{t("Rows by receiver")}</option>
              </select>
              <input
                className="gl-comp-global-search"
                type="search"
                value={globalPairSearch}
                placeholder={t("Find channel…")}
                aria-label={t("Search global compensation pairs")}
                onChange={(event) => setGlobalPairSearch(event.currentTarget.value)}
              />
              <label className="gl-comp-global-size">
                <span className="gl-sr-only">{t("Plot size")}</span>
                <input
                  type="range"
                  min="120"
                  max="220"
                  step="4"
                  value={resolvedGlobalPlotSize}
                  aria-label={t("Global compensation plot size")}
                  onChange={(event) => setGlobalPlotSize(Number(event.currentTarget.value))}
                />
                <output>{t("{size}px", { size: resolvedGlobalPlotSize })}</output>
              </label>
              <button
                type="button"
                className="gl-mini-btn gl-comp-global-export"
                disabled={!globalInspectorDataset?.ready || visibleGlobalInspectorCandidates.length === 0}
                title={t("Export the currently filtered pairs as locked Original and Compensated comparison pages")}
                onClick={() => setComparisonExportDialogOpen(true)}
              >
                {t("Export…")}
              </button>
              <span
                className="gl-comp-global-count"
                title={t("The Global gallery uses one fixed representative event set so every pair and both assay layers remain directly comparable.")}
              >
                {t("{pairs} pairs · {shown} / {total} events · {population}", {
                  pairs: visibleGlobalInspectorCandidates.length.toLocaleString(),
                  shown: globalInspectorEventIndices.length.toLocaleString(),
                  total: reviewEventCount.toLocaleString(),
                  population: activeReviewPopulation?.name ?? t("All Events"),
                })}
              </span>
            </>}
          >

            {!globalInspectorDataset ? (
              <div className="gl-comp-global-empty">{t("No matrix is available for the global inspector.")}</div>
            ) : !globalInspectorDataset.ready ? (
              <div className="gl-comp-global-empty">{t(globalInspectorDataset.reason)}</div>
            ) : visibleGlobalInspectorCandidates.length === 0 ? (
              <div className="gl-comp-global-empty">
                {t("No pairs match the current filter. Choose another filter or clear the channel search.")}
              </div>
            ) : globalLayout === "compact" ? (
              <div
                className="gl-comp-global-gallery"
                data-event-signature={globalInspectorDataset.dataset.eventSignature}
              >
                {visibleGlobalInspectorCandidates.map((pair) =>
                  renderGlobalPlotTile(pair, globalInspectorDataset.dataset))}
              </div>
            ) : (
              <div
                className="gl-comp-global-groups"
                data-event-signature={globalInspectorDataset.dataset.eventSignature}
                data-layout={globalLayout}
              >
                {globalInspectorGroups.map((group) => (
                  <section className="gl-comp-global-group" key={group.channel.key}>
                    <header>
                      <span>{t(globalLayout === "source" ? "Source channel" : "Receiver")}</span>
                      <strong title={group.channel.combined}>{group.channel.label}</strong>
                      <small>{group.channel.pnn}</small>
                      <em>{t("{count} pairs", { count: group.pairs.length })}</em>
                    </header>
                    <div className="gl-comp-global-group-plots">
                      {group.pairs.map((pair) =>
                        renderGlobalPlotTile(pair, globalInspectorDataset.dataset))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </GlobalInspectorLayerScope>
          {globalInspectorDetailsOpen && renderInspectorResizeHandle()}
          {globalInspectorDetailsOpen && renderPairInspector(() => setGlobalInspectorDetailsOpen(false), true)}
        </div>
      ) : matrixView ? (
        <div
          ref={commonPathRef}
          className="gl-comp-common-path"
          style={{ gridTemplateColumns: `minmax(440px, 1fr) 8px ${inspectorWidth}px` }}
        >
          <section className="gl-comp-attention gl-comp-attention-panel" aria-labelledby="comp-attention-heading">
            <div className="gl-comp-attention-head">
              <div>
                <h3 id="comp-attention-heading">{t("Flagged pairs")}</h3>
                <p>{t("This is your follow-up queue. Suggestions are a population-scoped evidence screen, not a verdict and not automatically included. Exact sweeps change one coefficient at a time across four user-bounded values using the same frozen events.")}</p>
              </div>
              <div className="gl-comp-attention-actions">
                <label>
                  <span>{t("Sweep workers")}</span>
                  <select
                    aria-label={t("Compensation sweep workers")}
                    value={sweepWorkerCount}
                    disabled={sweepProgress !== null || boundsPreviewPairKey !== null}
                    onChange={(event) => setSweepWorkerCount(Number(event.currentTarget.value))}
                  >
                    {Array.from({ length: MAX_SWEEP_WORKERS }, (_, index) => index + 1).map((count) => (
                      <option value={count} key={count}>{count}</option>
                    ))}
                  </select>
                </label>
                {sweepProgress ? (
                  <button type="button" className="gl-btn-ghost" onClick={cancelExactSweeps}>{t("Cancel sweep")}</button>
                ) : (
                  <button
                    type="button"
                    className="gl-btn"
                    disabled={!profileRecord || !onSolveCompensationSweep || sweepEligiblePairs.length === 0 || invalidSweepPairCount > 0 || applyBusy || boundsPreviewPairKey !== null}
                    onClick={() => void runExactSweeps()}
                  >
                    {t("Run four-value sweeps ({count})", { count: sweepEligiblePairs.length })}
                  </button>
                )}
              </div>
            </div>
            <div className="gl-comp-attention-scope">
              <span>
                {t("Suggestions computed for {population} from up to {count} frozen events.", {
                  population: activeReviewPopulation?.name ?? t("All Events"),
                  count: Math.min(reviewEventCount, reviewEvidenceEventIndices.length).toLocaleString(),
                })}
              </span>
              <label className="gl-comp-evidence-mode">
                <span>{t("Evidence mode")}</span>
                <select
                  aria-label={t("Compensation evidence mode")}
                  value={evidenceMode}
                  disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null}
                  onChange={(event) => {
                    setEvidenceMode(event.currentTarget.value as CompensationEvidenceMode);
                    setAttentionScanRevision((revision) => revision + 1);
                    setSweepResults({});
                    setBoundsPreviewResults({});
                    setSweepError(null);
                  }}
                >
                  <option value="biological">{t("Biological sample (conservative)")}</option>
                  <option value="control">{t("Single-stain / control")}</option>
                </select>
              </label>
              <button
                type="button"
                className="gl-mini-btn"
                disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null}
                onClick={() => {
                  setAttentionScanRevision((revision) => revision + 1);
                  setSweepResults({});
                  setBoundsPreviewResults({});
                  setSweepError(null);
                  setActionIsError(false);
                  setActionMessage(
                    t(flaggedPairs.length === 1
                      ? "Recomputed compensation suggestions for {population}. {count} flagged pair was retained."
                      : "Recomputed compensation suggestions for {population}. {count} flagged pairs were retained.", {
                      population: activeReviewPopulation?.name ?? t("All Events"),
                      count: flaggedPairs.length,
                    }),
                  );
                }}
              >
                {t("Recompute suggestions")}
              </button>
              <small>
                {t(evidenceMode === "biological"
                  ? "Broad positive association is excluded because co-expression and cell size can mimic spill. High-tail shapes remain control-sensitive review prompts."
                  : "Positive residual association may enter the shortlist only because you declared suitable control data.")}
                {" "}{t("Sweep workers are separate from full-Apply workers.")}
              </small>
            </div>
            {sweepProgress && (
              <div className="gl-comp-sweep-progress" role="status" aria-live="polite">
                <progress max={Math.max(1, sweepProgress.total)} value={sweepProgress.completed} />
                <span>{t("{completed} / {total} exact candidate solves · {workers} workers", {
                  completed: sweepProgress.completed,
                  total: sweepProgress.total,
                  workers: sweepWorkerCount,
                })}</span>
              </div>
            )}
            {sweepError && <div className="gl-comp-warning" role="status">{t(sweepError)}</div>}
            {!profileRecord ? (
              <div className="gl-comp-attention-empty">
                {t("Install a profile-derived compensation layer before curating or sweeping pairs. The embedded FCS matrix remains inspectable in the Matrix view.")}
              </div>
            ) : (
              <>
                <div className="gl-comp-manual-followup" role="group" aria-label={t("Add compensation pair for follow-up")}>
                  <strong>{t("Add a pair")}</strong>
                  <label>
                    <span>{t("Source channel")}</span>
                    <select
                      aria-label={t("Follow-up source channel")}
                      value={manualSourceKey}
                      onChange={(event) => {
                        const nextSource = event.currentTarget.value;
                        setManualSourceKey(nextSource);
                        if (manualReceiverKey === nextSource) {
                          setManualReceiverKey(matrixView.receiverAxisKeys.find((key) => key !== nextSource && includedProfileChannels.has(key)) ?? "");
                        }
                      }}
                    >
                      {matrixView.sourceAxisKeys.map((key, index) => includedProfileChannels.has(key) ? (
                        <option value={key} key={key}>{sourceChannels[index].combined}</option>
                      ) : null)}
                    </select>
                  </label>
                  <span aria-hidden="true">→</span>
                  <label>
                    <span>{t("Receiver")}</span>
                    <select
                      aria-label={t("Follow-up receiver channel")}
                      value={manualReceiverKey}
                      onChange={(event) => setManualReceiverKey(event.currentTarget.value)}
                    >
                      {matrixView.receiverAxisKeys.map((key, index) => key !== manualSourceKey && includedProfileChannels.has(key) ? (
                        <option value={key} key={key}>{receiverChannels[index].combined}</option>
                      ) : null)}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={!manualSourceKey || !manualReceiverKey || manualSourceKey === manualReceiverKey}
                    onClick={addManualFollowupPair}
                  >
                    {t("Flag for follow-up")}
                  </button>
                </div>

                <div className="gl-comp-flagged-columns">
                  <div className="gl-comp-attention-section">
                  <div className="gl-comp-attention-section-head">
                    <div>
                      <h4>{t("Flagged by you ({count})", { count: sweepEligiblePairs.length })}</h4>
                      <span>{t("Only these pairs are included when you run sweeps.")}</span>
                    </div>
                  </div>
                  {sweepEligiblePairs.length === 0 ? (
                    <div className="gl-comp-attention-empty">
                      {t("No pairs are flagged yet. Tick “Flag for follow-up” in the inspector, add a pair above, or accept a suggestion below.")}
                    </div>
                  ) : (
                    <div className="gl-comp-sweep-list">
                      {sweepEligiblePairs.map((candidate, rank) => {
                        const result = sweepResults[candidate.pairKey];
                        const expanded = expandedSweepPair === candidate.pairKey;
                        const bounds = resolvedBoundsForPair(candidate.pairKey, candidate.coefficient);
                        const draft = boundsDraftForPair(candidate.pairKey, candidate.coefficient);
                        return (
                          <article className={`gl-comp-sweep-pair${selectedPairKey === candidate.pairKey ? " is-selected" : ""}`} key={candidate.pairKey}>
                            <div className="gl-comp-sweep-pair-head-row">
                              <button
                                type="button"
                                className="gl-comp-sweep-pair-head"
                                aria-expanded={expanded}
                                onClick={() => {
                                  setSelectedPairKey(candidate.pairKey);
                                  setExpandedSweepPair(expanded ? null : candidate.pairKey);
                                }}
                              >
                                <span className="gl-comp-sweep-rank">{rank + 1}</span>
                                <span>
                                  <strong>{candidate.source.label} → {candidate.receiver.label}</strong>
                                  <small>
                                    {candidate.interaction && candidate.interaction !== "other" ? `${candidate.interaction} · ` : ""}
                                    {t("installed {value}%", { value: (candidate.coefficient * 100).toFixed(1) })}
                                  </small>
                                </span>
                                <span>
                                  {candidate.evidence.status === "ready"
                                    ? t("shift {shift} MAD · slope {slope}", {
                                        shift: significantNumber(candidate.evidence.normalizedNegativeShift ?? 0, 3),
                                        slope: significantNumber(candidate.evidence.residualSlope ?? 0, 4),
                                      })
                                    : t("visual review · residual groups insufficient")}
                                </span>
                                <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                              </button>
                              <label className="gl-comp-followup-list-toggle" title={t("Remove from follow-up queue")}>
                                <input
                                  type="checkbox"
                                  checked
                                  aria-label={t("Flag {source} to {receiver} for follow-up", {
                                    source: candidate.source.label,
                                    receiver: candidate.receiver.label,
                                  })}
                                  onChange={(event) => toggleFlaggedPair(candidate.pairKey, event.currentTarget.checked)}
                                />
                              </label>
                            </div>
                            {expanded && (
                              <div className="gl-comp-sweep-pair-body">
                                <div className="gl-comp-inline-bounds">
                                  <span>{t("Four values across")}</span>
                                  <label>{t("Lower (%)")}<ScrubbableNumberInput step="0.1" value={draft.lowerPercent} disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null} onValueChange={(value) => setSweepBoundDraft(candidate.pairKey, candidate.coefficient, "lowerPercent", value)} /></label>
                                  <span>{t("to")}</span>
                                  <label>{t("Upper (%)")}<ScrubbableNumberInput step="0.1" value={draft.upperPercent} disabled={applyBusy || sweepProgress !== null || boundsPreviewPairKey !== null} onValueChange={(value) => setSweepBoundDraft(candidate.pairKey, candidate.coefficient, "upperPercent", value)} /></label>
                                  {bounds.error && <small>{t(bounds.error)}</small>}
                                </div>
                                {result ? (
                                  <div className="gl-comp-sweep-values">
                                    {result.values.map((value) => (
                                      <div
                                        className={`gl-comp-sweep-value${value.isCurrent ? " is-current" : ""}${stagedCoefficients[candidate.pairKey] === value.value ? " is-staged" : ""}`}
                                        key={`${candidate.pairKey}:${value.value}:${value.isCurrent}`}
                                      >
                                        <DensityBiplot
                                          title={`${value.isCurrent ? `${t("Current")} · ` : ""}${(value.value * 100).toFixed(2)}%`}
                                          panel={value.preview.compensated}
                                          preview={value.preview}
                                          sourceLabel={candidate.source.label}
                                          receiverLabel={candidate.receiver.label}
                                          minimumSize={150}
                                          maximumSize={230}
                                          densitySmoothing={resolvedDensitySmoothing}
                                        />
                                        <dl>
                                          <div><dt>{t("Shift")}</dt><dd>{t("{value} MAD", { value: significantNumber(value.preview.evidence.normalizedNegativeShift ?? 0, 3) })}</dd></div>
                                          <div><dt>{t("Slope")}</dt><dd>{significantNumber(value.preview.evidence.residualSlope ?? 0, 4)}</dd></div>
                                          {matrixView.kind === "cytof" && (
                                            <div><dt>{t("Receiver zero")}</dt><dd>{(value.preview.compensated.zeroPile.receiver / Math.max(1, value.preview.eventCount) * 100).toFixed(1)}%</dd></div>
                                          )}
                                        </dl>
                                        <button
                                          type="button"
                                          className="gl-mini-btn"
                                          disabled={applyBusy || value.isCurrent}
                                          onClick={() => stageCoefficient(candidate.pairKey, value.value)}
                                        >
                                          {t(value.isCurrent ? "Installed" : stagedCoefficients[candidate.pairKey] === value.value ? "Staged" : "Use this value")}
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p>{t("Set or fast-preview the endpoints in the inspector, then run the four-value exact sweep. Panels use the same events and locked axes.")}</p>
                                )}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                  </div>

                  <div className="gl-comp-attention-section gl-comp-suggestions">
                  <div className="gl-comp-attention-section-head">
                    <div>
                      <h4>{t(evidenceMode === "biological" ? "Conservative suggestions" : "Control-data suggestions")} ({residualEvidenceReview.items.length})</h4>
                      <span>{t("{evaluable} evaluable of {screened} screened pairs for {population}. Inspect before flagging.", {
                        evaluable: residualEvidenceReview.evaluableCount.toLocaleString(),
                        screened: residualEvidenceReview.screenedCount.toLocaleString(),
                        population: activeReviewPopulation?.name ?? t("All Events"),
                      })}</span>
                    </div>
                  </div>
                  {residualEvidenceReview.items.length === 0 ? (
                    <div className="gl-comp-attention-empty">{t("No pair met the residual-screen evidence requirements. Manual flagging remains available.")}</div>
                  ) : (
                    <div className="gl-comp-suggestion-list">
                      {residualEvidenceReview.items.map((candidate) => {
                        const assessment = assessCompensationEvidence(candidate, matrixView.kind, evidenceMode);
                        return (
                          <article className={flaggedPairSet.has(candidate.pairKey) ? "is-flagged" : undefined} key={candidate.pairKey}>
                            <button
                              type="button"
                              onClick={() => setSelectedPairKey(candidate.pairKey)}
                            >
                              <strong>{candidate.source.label} → {candidate.receiver.label}</strong>
                              <em className={`gl-comp-suggestion-badge is-${assessment.category}`}>{t(assessment.label)}</em>
                              <span>
                                {candidate.interaction && candidate.interaction !== "other" ? `${candidate.interaction} · ` : ""}
                                {t("{coefficient}% · shift {shift} MAD · slope {slope}", {
                                  coefficient: (candidate.coefficient * 100).toFixed(1),
                                  shift: significantNumber(candidate.evidence.normalizedNegativeShift ?? 0, 3),
                                  slope: significantNumber(candidate.evidence.residualSlope ?? 0, 4),
                                })}
                              </span>
                            </button>
                            <label>
                              <input
                                type="checkbox"
                                checked={flaggedPairSet.has(candidate.pairKey)}
                                aria-label={t("Flag suggested {source} to {receiver} for follow-up", {
                                  source: candidate.source.label,
                                  receiver: candidate.receiver.label,
                                })}
                                onChange={(event) => toggleFlaggedPair(candidate.pairKey, event.currentTarget.checked)}
                              />
                              <span>{t("Follow up")}</span>
                            </label>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  </div>
                </div>
              </>
            )}
          </section>
          {renderInspectorResizeHandle()}
          {renderPairInspector()}
        </div>
      ) : (
        <div className="gl-tab-placeholder gl-comp-empty">
          <p>
            {t(profileMetadata
              ? "The compensated assay is installed, but its numerical profile record is unavailable for matrix inspection."
              : sample.instrument === "cytof"
                ? "No CyTOF compensation profile is installed for this sample."
                : "This sample has no compatible embedded compensation matrix or imported profile.")}
          </p>
        </div>
      )}

      {(matrixView || profileMetadata) && (
        <div className="gl-comp-advanced" role="group" aria-label={t("Advanced compensation tools")}>
          <div className="gl-comp-drawer-buttons">
            {DRAWERS.map(({ id, label }) => (
              <button
                type="button"
                key={id}
                id={`comp-drawer-${id}-button`}
                className="gl-comp-drawer-toggle"
                aria-expanded={openDrawers[id]}
                aria-controls={`comp-drawer-${id}`}
                onClick={() => toggleDrawer(id)}
              >
                <span>{t(label)}{id === "review" && reviewItems.length > 0 ? ` (${reviewItems.length})` : ""}</span>
                <span aria-hidden="true">{openDrawers[id] ? "▾" : "▸"}</span>
              </button>
            ))}
          </div>
          {openDrawers.evidence && (
            <section id="comp-drawer-evidence" role="region" aria-labelledby="comp-drawer-evidence-button" className="gl-comp-drawer-region">
              <h3>{t("Matrix evidence")}</h3>
              {profileMetadata ? (
                profileRecord ? (
                  <>
                    <dl className="gl-comp-evidence-grid">
                      <div><dt>{t("Profile ID")}</dt><dd>{profileRecord.profileId}</dd></div>
                      <div><dt>{t("Created")}</dt><dd>{new Date(profileRecord.createdAt).toLocaleString()}</dd></div>
                      <div><dt>{t("Matrix source")}</dt><dd>{profileOriginText(profileRecord, t)}</dd></div>
                      <div><dt>{t("Orientation")}</dt><dd>{t("Source rows → receiver columns")}</dd></div>
                      <div><dt>{t("Imported dimensions")}</dt><dd>{t("{sources} sources × {receivers} receivers", {
                        sources: profileRecord.scientific.matrix.sourceChannels.length,
                        receivers: profileRecord.scientific.matrix.receiverChannels.length,
                      })}</dd></div>
                      <div><dt>{t("Applied solve")}</dt><dd>{t("{count} exact $PnN channels · {status}", {
                        count: profileMetadata.includedPnns.length,
                        status: installedStatus.state,
                      })}</dd></div>
                      <div><dt>{t("Matrix hash")}</dt><dd title={profileRecord.matrixHash}>{profileRecord.matrixHash.slice(0, 19)}…</dd></div>
                      <div><dt>{t("Profile hash")}</dt><dd title={profileRecord.profileHash}>{profileRecord.profileHash.slice(0, 19)}…</dd></div>
                      <div><dt>{t("Provenance")}</dt><dd>{t(profileRecord.provenance?.sourceDescription ?? "No additional source note supplied")}</dd></div>
                      <div><dt>{t("Estimation")}</dt><dd>{t(profileRecord.provenance?.estimationMethod ?? "Imported coefficients preserved exactly")}</dd></div>
                    </dl>
                    <div className="gl-comp-method-card" aria-label={t("Installed compensation method")}>
                      <div>
                        <span>{t("Pipeline")}</span>
                        <strong>{t(profileRecord.scientific.kind === "cytof-spillover" ? "Original counts → NNLS → Compensated counts → arcsinh display" : "Original values → linear matrix inverse → Compensated values → display transform")}</strong>
                      </div>
                      <div>
                        <span>{t("Solver")}</span>
                        <strong>{profileRecord.scientific.solverVersion}</strong>
                        <small>{profileRecord.scientific.solverSettings.map(({ key, value }) => `${key}=${String(value)}`).join(" · ")}</small>
                      </div>
                    </div>
                    {impactSummary && (
                      <div className="gl-comp-impact" aria-label={t("Original versus Compensated preview")}>
                        <div className="gl-comp-impact-head">
                          <div>
                            <h4>{t("Original → Compensated impact")}</h4>
                            <span>{t("Deterministic preview of {events} evenly spaced events across {channels} solve channels", {
                              events: impactSummary.previewEvents.toLocaleString(),
                              channels: profileMetadata.includedPnns.length,
                            })}</span>
                          </div>
                        </div>
                        <dl>
                          <div><dt>{t("Values changed")}</dt><dd>{impactSummary.changedValues.toLocaleString()} / {impactSummary.comparedValues.toLocaleString()} ({percentText(impactSummary.changedValues / impactSummary.comparedValues, false, 4)})</dd></div>
                          <div><dt>{t("Median |Δ|")}</dt><dd>{significantNumber(impactSummary.medianAbsoluteDelta, 5)}</dd></div>
                          <div><dt>{t("Maximum |Δ|")}</dt><dd>{significantNumber(impactSummary.maxAbsoluteDelta, 5)}</dd></div>
                          <div><dt>{t("Largest median shift")}</dt><dd title={impactSummary.mostChangedChannel}>{impactSummary.mostChangedChannel} · {significantNumber(impactSummary.mostChangedChannelMedianDelta, 5)}</dd></div>
                          {profileMetadata.kind === "cytof-spillover" && (
                            <div><dt>{t("Negative → zero")}</dt><dd>{t("{count} preview values", { count: impactSummary.zeroedNegativeValues.toLocaleString() })}</dd></div>
                          )}
                        </dl>
                      </div>
                    )}
                  </>
                ) : (
                  <p>{t("{profile} · {method} · {count} exact $PnN channel bindings · {status}. The numerical profile record is not available in this live workspace state.", {
                    profile: profileMetadata.profileId,
                    method: displayMethod,
                    count: profileMetadata.includedPnns.length,
                    status: installedStatus.state,
                  })}</p>
                )
              ) : (
                <p>{t("Embedded $SPILLOVER · {channels} matched channels · {warnings} coefficient warnings.", {
                  channels: spill!.channels.length,
                  warnings: matrixReviewItems.length || t("no"),
                })}</p>
              )}
            </section>
          )}
          {openDrawers.review && (
            <section id="comp-drawer-review" role="region" aria-labelledby="comp-drawer-review-button" className="gl-comp-drawer-region">
              <h3>{t("Review queue")}</h3>
              <div className="gl-comp-review-section">
                <h4>{t("Matrix integrity")}</h4>
                {reviewItems.length > 0 ? (
                  <ul>{reviewItems.map((item) => <li key={item}>{t(item)}</li>)}</ul>
                ) : (
                  <p>{t("No matrix-level items currently require review.")}</p>
                )}
              </div>
              {installedStatus.state === "ready" && matrixView && (
                <div className="gl-comp-review-section">
                  <h4>{t("Residual-evidence shortlist")}</h4>
                  <p>{t("Relative ranking of {screened}{candidateSuffix} non-zero or physically plausible pairs. It combines receiver-negative population shift, robust residual slope, upper-tail departure{zeroSuffix}.{modeNote} A high rank is a prompt to inspect, not proof that a coefficient is wrong.", {
                    screened: residualEvidenceReview.screenedCount.toLocaleString(),
                    candidateSuffix: residualEvidenceReview.candidateCount > residualEvidenceReview.screenedCount
                      ? t(" of {count}", { count: residualEvidenceReview.candidateCount.toLocaleString() })
                      : "",
                    zeroSuffix: matrixView.kind === "cytof" ? t(", and new exact-zero pile") : "",
                    modeNote: t(evidenceMode === "biological"
                      ? " Broad positive association is excluded because biological co-expression and cell size can mimic spill."
                      : " Positive residual association is enabled because control-data mode is active."),
                  })}</p>
                  {residualEvidenceReview.items.length > 0 ? (
                    <div className="gl-comp-review-candidates">
                      {residualEvidenceReview.items.map((candidate) => (
                        <button
                          type="button"
                          key={candidate.pairKey}
                          onClick={() => selectAndFocus(candidate.sourceIndex, candidate.receiverIndex)}
                        >
                          <span>
                            <strong>{candidate.source.label} → {candidate.receiver.label}</strong>
                            <small>
                              {candidate.interaction && candidate.interaction !== "other"
                                ? <>{candidate.interaction} · </>
                                : null}
                              {t("matrix {value}%", { value: (candidate.coefficient * 100).toFixed(1) })}
                            </small>
                          </span>
                          <span>
                            {t("shift {shift} MAD · slope {slope}", {
                              shift: significantNumber(candidate.evidence.normalizedNegativeShift ?? 0, 3),
                              slope: significantNumber(candidate.evidence.residualSlope ?? 0, 4),
                            })}
                            {matrixView.kind === "cytof" ? (
                              <> {t("· zero Δ {value} pp", { value: `${candidate.evidence.receiverZeroDeltaFraction >= 0 ? "+" : ""}${(candidate.evidence.receiverZeroDeltaFraction * 100).toFixed(1)}` })}</>
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>
                      {t("No pair had enough source-high, source-low, and receiver-negative events for this conservative screen. Visual inspection remains available from the matrix.")}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {exportDialogOpen && matrixView && (
        <CompensationMatrixExportDialog
          profileLabel={profileRecord?.name ?? "embedded_FCS"}
          installedLabel={t(profileRecord ? "Installed matrix" : "Embedded FCS matrix")}
          installedMatrix={{
            sourceChannels: matrixView.sourceAxisKeys,
            receiverChannels: matrixView.receiverAxisKeys,
            matrix: matrixView.matrix,
          }}
          workingMatrix={workingExportMatrix}
          pendingEditCount={Object.keys(stagedCoefficients).length}
          onClose={() => setExportDialogOpen(false)}
        />
      )}
      {comparisonExportDialogOpen && (
        <CompensationComparisonExportDialog
          sampleName={sampleName}
          populationName={activeReviewPopulation?.name ?? t("All Events")}
          filterLabel={globalExportFilterLabel}
          pairCount={orderedGlobalExportCandidates.length}
          onExport={exportGlobalComparison}
          onClose={() => setComparisonExportDialogOpen(false)}
        />
      )}
    </div>
    </CompensationPointAlphaContext.Provider>
    </DensityColorPowerContext.Provider>
  );
}

/**
 * Compensation's lightweight state keeper remains mounted after its first visit so imported
 * matrices and staged edits survive tab changes. Its heavy child tree is unmounted while hidden,
 * and gating-only population/mask changes do not render the state keeper. A transition back to
 * visible always renders once with the latest props.
 */
function compensationTabPropsEqual(previous: Readonly<Props>, next: Readonly<Props>): boolean {
  const previousVisible = previous.visible !== false;
  const nextVisible = next.visible !== false;
  if (previousVisible || nextVisible) return false;
  return previous.sample === next.sample && previous.stateKey === next.stateKey;
}

export const CompensationTab = memo(CompensationTabImpl, compensationTabPropsEqual);
