// App.tsx — Step 3: FCS → gate drawing → gate list + population tree (reproduced from
// GateLabR) with live counts. Drawing a gate opens the name/population modal; the plot
// shows the active population's events plus its gates (display space).

import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import pkg from "../package.json";
import { clearPersistedTabState } from "./ui/tabState";
import { historyShortcutAction } from "./ui/historyShortcuts";
import { DEFAULT_GATING_FONT_SIZES, GatingPlot, type NewGate } from "./plots/GatingPlot";
import { buildPlotGates, type PlotGate } from "./plots/gatePayload";
import { branchScopedGateOrder } from "./engine/branchGates";
import {
  isFlowJoWorkspace,
  listFlowJoWorkspaceSamples,
  flowJoWorkspaceToGatingML,
  matchFlowJoSamples,
  resolveFlowJoWorkspaceFiles,
  type FlowJoSampleSummary,
  type FlowJoSampleMatchKey,
  type FlowJoSpillover,
} from "./engine/flowjoWorkspace";
import { ChannelScales } from "./engine/channelScales";
import { includePlotGatesInAxisRange } from "./engine/axisRange";
import { parseFcs, type SpilloverMatrix } from "./engine/fcs";
import { Sample, maxCoefficientDelta, type DisplayMode, type OverlaySpec } from "./engine/sample";
import { populationTreeOrder } from "./engine/populations";
import { resolvePartitionLevels, partitionAssign } from "./engine/factors";
import { paletteColors, populationColor, UNGATED_COLOR, OVERLAY_PALETTES, type PaletteName } from "./engine/palettes";
import { assignDivisionLevel, divisionPalette } from "./engine/division";
import { encodeFloat32Base64, encodeUint8Base64 } from "./engine/encode";
import {
  aggregatePopulationTreeStats,
  buildCombinedSamplePointCloud,
  buildWorkspaceAxisRanges,
  type CombinedSamplePlotInput,
} from "./engine/multiSamplePlot";
import {
  importGatingML,
  resolveGatingMLCompensation,
  restoreGatingMLScaleState,
  type GatingMLCompensationResolution,
  type GatingMLResult,
} from "./engine/gatingml";
import { exportGatingML, type GatingMLFormat } from "./engine/gatingmlExport";
import {
  gatingMergeSpaceConflict,
  hasGatingStrategy,
  type GatingImportMode,
} from "./engine/gatingMerge";
import {
  exportPopulationFcs,
  exportPopulationFcsCombined,
  mergeExportFiles,
  inspectCombinedFcsCompatibility,
  passesPopulationFcsExportThreshold,
  sanitizeFcsName,
  sanitizeFilePart,
  type FcsExportAssay,
} from "./engine/fcsExport";
import { zipSync } from "fflate";
import {
  packWorkspace,
  packWorkspaceForStorage,
  packWorkspaceReference,
  readWorkspaceEnvelopeFromFile,
  migrateWorkspaceToV2,
  validateWorkspace,
  WORKSPACE_EXT,
  type WorkspaceFile,
  type WorkspaceEnvelope,
  type WorkspaceStorage,
  type GatingFontSizes,
  type IllustrationConfig,
  type IllustrationPreset,
} from "./engine/workspace";
import {
  WORKSPACE_VERSION_3,
  createPortableWorkspaceV3ArchivePlan,
  newEmptyWorkspaceCompensationState,
  packWorkspaceV3Reference,
  validateWorkspaceV3,
  writePortableWorkspaceV3Archive,
  type WorkspaceFileV3,
  type WorkspaceV3SampleRestoreContexts,
} from "./engine/workspaceV3";
import {
  SAMPLE_ASSAY_BINDING_SCHEMA,
  type SampleAssayBinding,
  type WorkspaceCompensationState,
} from "./engine/workspaceCompensation";
import {
  availableCompensationWorkerCount,
  CompensationCancelledError,
  CompensationManager,
  type CompensationApplyProgress,
} from "./engine/compensationManager";
import { reportMatrixCompatibility } from "./engine/compensationCompatibility";
import type { CompensationProfileRecord } from "./engine/compensationProfileRecord";
import {
  digestFcsBytes,
  installCachedCompensatedAssay,
  readCachedCompensatedAssay,
  writeCachedCompensatedAssay,
} from "./engine/compensationCache";
import { restorePortableAssayLayers } from "./engine/workspacePortableAssays";
import {
  supportsFileSystemAccess,
  supportsDirectoryAccess,
  pickFileSource,
  pickFiles,
  pickDirectoryFiles,
  writeHandle,
  writeHandleStream,
  saveAsHandle,
  saveAsHandleStream,
  readFromHandleIfPermitted,
  rememberHandle,
  recallHandle,
  type PickedFileSource,
} from "./engine/fsAccess";
import {
  planWorkspaceFcsRelink,
  type WorkspaceFcsRequirement,
} from "./engine/workspaceRelink";
import {
  AUTO_CHECKPOINT_INTERVAL_MS,
  requestPersistentWorkspaceHistory,
  saveWorkspaceCheckpoint,
  type WorkspaceCheckpointReason,
} from "./engine/workspaceHistory";
import {
  coreReducer,
  initialCoreState,
  derivePopulationDisplaySelection,
  derivePopulationView,
  recompute,
  recomputeGating,
  type Action,
  type Derived,
  type GatingDerived,
  type PopulationDisplaySelection,
} from "./store";
import { GateList } from "./ui/GateList";
import { PopulationTree } from "./ui/PopulationTree";
import { GateModals } from "./ui/GateModals";
import { GateToolbar, PopToolbar } from "./ui/Toolbars";
import { RenameModal, CreatePopModal, EditPopModal, ConfirmModal, MovePopsModal, BulkRenameModal, FcsExportModal, GatingMlImportModal, GatingMlExportModal } from "./ui/CrudModals";
import { StatsTab } from "./ui/StatsTab";
import { PanelTab } from "./ui/PanelTab";
import { MetadataTab } from "./ui/MetadataTab";
import type { MetaRow } from "./ui/EditableMetaTable";
import { ProportionsTab } from "./ui/ProportionsTab";
import { DivisionTab, type DivisionProfile } from "./ui/DivisionTab";
import { parseMetadataTable, lookupMetadataRow, type MetadataColumn } from "./engine/metadata";
import { ScalesTab } from "./ui/ScalesTab";
import type {
  CompensationApplyUiStatus,
  CompensationCandidatePreviewSolver,
  CompensationSweepSolver,
} from "./ui/CompensationTab";
import { StrategyTab, type StrategyConfig } from "./ui/StrategyTab";
import { IllustrationTab } from "./ui/IllustrationTab";
import {
  FolderImportModal,
  SampleManagerModal,
  SampleNavigator,
  type FolderImportItem,
  type SampleImportProgress,
  type SampleListItem,
} from "./ui/SampleManager";
import { WorkspaceRelinkModal } from "./ui/WorkspaceRelinkModal";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { NavigateIcon, RectIcon, PolyIcon, QuadIcon } from "./ui/icons";
import { useSampleDataRevisionKey } from "./ui/useSampleDataRevisions";
import { useContextualGlobalScales } from "./ui/useContextualGlobalScales";
import {
  DEFAULT_DENSITY_COLOR_POWER,
  normalizeDensityColorPower,
} from "./engine/pseudocolor";
import { DensityColourControl } from "./ui/DensityColourControl";
import { UI_LANGUAGE_OPTIONS, useI18n, type UiLanguage } from "./ui/i18n";
import { useOptionalGateLabHost } from "./host/HostContext";
import { createBrowserHost } from "./host/browserHost";
import {
  loadHostedDataset,
  type GateLabHostedSample,
} from "./host/hostedSample";
import {
  adoptedRProfile,
  authoritativeRProfile,
  GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
} from "./host/compensationContract";
import {
  decodeChannelMajorFloat32,
  type GateLabHostAssayDescriptor,
  type GateLabHostDatasetDescriptor,
} from "./host/datasetContract";
import {
  convertHostedGateSpace,
  readHostedWorkspace,
} from "./host/hostedWorkspace";
import {
  GATELAB_HOST_COLDATA_CONTRACT_VERSION,
  packMembershipBits,
  type GateLabHostCategoricalColumn,
  type GateLabHostPopulationColumn,
} from "./host/colDataContract";
import { GATELAB_HOST_ROWDATA_CONTRACT_VERSION } from "./host/rowDataContract";
import type { GateLabHostWorkspaceWriteResult } from "./host/workspaceContract";
import {
  SceColDataExportModal,
  type ScePopulationColumnSpec,
} from "./ui/SceColDataExportModal";

const CompensationTab = lazy(async () => {
  const module = await import("./ui/CompensationTab");
  return { default: module.CompensationTab };
});

const FCS_FILE_ACCEPT = { "application/octet-stream": [".fcs"] };
const INITIAL_LEFT_PANE_WIDTH = 264;
const INITIAL_RIGHT_PANE_WIDTH = 672;

type CrudModal =
  | { kind: "createPop" }
  | { kind: "renameGate"; id: string; initial: string }
  | { kind: "editPop"; id: string }
  | { kind: "confirmNewWorkspace" }
  | { kind: "confirmDelete"; what: "gates" | "pops"; ids: string[] }
  | { kind: "movePops"; ids: string[] }
  | { kind: "bulkRename" }
  | { kind: "exportSceColData" };

type DrawMode = "navigate" | "draw-rect" | "draw-poly" | "draw-quadrant";
type LiveWorkspaceFile = WorkspaceFile | WorkspaceFileV3;

interface PendingGatingMLImport {
  result: GatingMLResult;
  compensation: GatingMLCompensationResolution;
  sampleId: string;
  mergeBlockedReason: string | null;
  compensationNote: string | null;
  /** Set when the gates came from a FlowJo workspace, so the result line can say which sample. */
  sourceNote: string;
  /**
   * A matrix the FlowJo workspace carries that the FCS does not, held until the user confirms:
   * installing it on the sample changes every fluorescence value, so it must not happen while
   * the import is still cancellable.
   */
  externalSpillover: {
    matrix: SpilloverMatrix;
    label: string;
    dropped: string[];
    /** The loaded FCS already had a matrix, which this one replaces. */
    replacesEmbedded: boolean;
    /** ...and the two are not the same compensation. */
    differsFromEmbedded: boolean;
    maxDelta: number | null;
  } | null;
  /** Which matrix to evaluate the gates with, when the two disagree. */
  matrixChoice: "workspace" | "file";
}

interface PendingNewGate {
  gate: NewGate;
  sampleId: string;
  dataRevision: number;
  coordinateBindingKeys: readonly [string, string];
}

interface CachedSampleGating {
  sample: Sample;
  dataRevision: number;
  gateVersion: number;
  gating: GatingDerived;
}

/** Save data to a file the user downloads (local blob; user-initiated). */
function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const downloadText = (filename: string, text: string, mime: string) =>
  downloadBlob(filename, new Blob([text], { type: mime }));

const makeWorkspaceId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const COMPENSATION_WORKER_STORAGE_KEY = "gatelab.compensation.applyWorkers";

function initialCompensationWorkerCount(limit: number): number {
  const fallback = Math.min(4, limit);
  try {
    const stored = Number(globalThis.localStorage?.getItem(COMPENSATION_WORKER_STORAGE_KEY));
    return Number.isSafeInteger(stored) && stored >= 1
      ? Math.min(limit, stored)
      : fallback;
  } catch {
    return fallback;
  }
}

function findCompensationProfile(
  compensation: WorkspaceCompensationState,
  profileId: string,
): CompensationProfileRecord | null {
  for (const lineage of compensation.lineages) {
    const profile = lineage.records.find((record) => record.profileId === profileId);
    if (profile) return profile;
  }
  return null;
}

const DRAW_TOOLS: { id: DrawMode; Icon: () => React.ReactElement; title: string }[] = [
  { id: "navigate", Icon: NavigateIcon, title: "Navigate (pan / zoom)" },
  { id: "draw-rect", Icon: RectIcon, title: "Rectangle gate — drag a box" },
  { id: "draw-poly", Icon: PolyIcon, title: "Polygon gate — click vertices, double-click to close" },
  { id: "draw-quadrant", Icon: QuadIcon, title: "Quadrant gate — click the crosshair centre" },
];

/**
 * How a gate's edges are drawn.
 *
 * A polygon's edges are straight in gating space, so on a non-linear axis their true image is a
 * curve. Straight edges are what most people expect and what other tools draw, but they are not
 * the gate. The default shows both: straight edges to work with, and a thin grey line where the
 * boundary actually falls, so the difference is visible without having to go looking for it.
 */
type GateEdgeMode = "straight" | "straight-bow" | "bowed";
const GATE_EDGE_MODES: { id: GateEdgeMode; label: string; hint: string }[] = [
  { id: "straight", label: "Straight",
    hint: "Straight lines between vertices. Familiar, and what FlowJo draws — but on a non-linear axis it is not where the gate actually falls." },
  { id: "straight-bow", label: "Straight + true edge",
    hint: "Straight edges to work with, plus a thin grey line showing the real boundary." },
  { id: "bowed", label: "True edge",
    hint: "The boundary the gate actually has on these axes." },
];

/**
 * Elements whose gestures belong to cytof_plot.js, so GateLab's pan must not also start on them.
 *
 * Kept identical to the renderer's own list; a cross-check test compares the two, because the
 * copies drifting apart is exactly how gate labels came to start a pan.
 */
export const CYTOF_OWNED_TARGETS = ".saved-gate, .gate-label, .cytof-xlabel, .cytof-ylabel";

const MODES: { id: DisplayMode; label: string }[] = [
  { id: "pseudocolor", label: "Pseudocolor" },
  { id: "dots", label: "Dots" },
  { id: "contour", label: "Contour" },
];

// Center-column tabs, mirroring GateLabR's tabsetPanel. The left (samples/import/export)
// and right (gates/populations) panels are
// shared across tabs — only the center switches, exactly as in GateLabR.
type TabId = "gating" | "strategy" | "illustration" | "statistics" | "panel" | "compensation" | "scales" | "metadata" | "proportions" | "division";
const TABS: { id: TabId; label: string }[] = [
  { id: "gating", label: "Gating" },
  { id: "strategy", label: "Strategy" },
  { id: "illustration", label: "Illustration" },
  { id: "proportions", label: "Proportions" },
  { id: "division", label: "Division" },
  { id: "statistics", label: "Statistics" },
  { id: "metadata", label: "Metadata" },
  { id: "panel", label: "Panel" },
  { id: "compensation", label: "Compensation" },
  { id: "scales", label: "Scales" },
];

interface SampleEntry {
  id: string;
  name: string;
  sample: Sample;
  /** Original FCS bytes; null for an SCE sample owned by the R host. */
  bytes: Uint8Array | null;
  handle: FileSystemFileHandle | null; // File System Access handle (reference workspaces)
  sourcePath?: string; // display-only path below a folder selected during this session
  hostSource?: Readonly<{
    datasetId: string;
    sampleId: string;
    assayId: string;
    assayRevision: number;
    /** Zero-based original SCE columns for exact host write-back. */
    eventIndex: Uint32Array;
  }>;
}

interface ResolvedReferenceFcs {
  bytes: Uint8Array;
  handle: FileSystemFileHandle | null;
  sourcePath?: string;
}

interface IncludedDisplaySelection {
  entry: SampleEntry;
  gating: GatingDerived | null;
  selection: PopulationDisplaySelection;
}

interface FcsImportCandidate {
  id: string;
  name: string;
  file: File;
  handle: FileSystemFileHandle | null;
  sourcePath?: string;
}

interface PendingFolderImport {
  folderName: string;
  candidates: FcsImportCandidate[];
}

interface PendingWorkspaceRelink {
  requirements: readonly WorkspaceFcsRequirement[];
  workspaceHandle: FileSystemFileHandle | null;
}

function plotInteractionTokenFor(
  sample: Sample | null,
  sampleId: string | null,
  xIdx: number,
  yIdx: number,
  gateVersion: number,
  activePopulationId: string | null,
  panelVersion: number,
): string | null {
  if (!sample || !sampleId) return null;
  const xChannel = sample.channels[xIdx];
  const yChannel = sample.channels[yIdx];
  if (!xChannel || !yChannel) return null;
  return JSON.stringify([
    sampleId,
    sample.dataRevision,
    sample.displayTransformContextKey,
    xChannel.key,
    yChannel.key,
    sample.displayCoordinateBindingKey(xChannel.key),
    sample.displayCoordinateBindingKey(yChannel.key),
    gateVersion,
    activePopulationId,
    panelVersion,
  ]);
}

/** Point-mark settings restored from a workspace, clamped to the ranges the UI offers. */
function restoredPointAlpha(value: unknown): number {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) ? Math.max(0.05, Math.min(1, v)) : 0.4;
}
function restoredPointSize(value: unknown): number {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) ? Math.max(0.5, Math.min(2, v)) : 1.5;
}

export default function App() {
  const providedHost = useOptionalGateLabHost();
  const fallbackBrowserHost = useMemo(() => createBrowserHost(), []);
  const host = providedHost ?? fallbackBrowserHost;
  const isSceHost = host.kind === "r-sce";
  const { language, setLanguage, t } = useI18n();
  // Multiple samples share ONE gating tree (FlowJo-style): add/remove freely, one is active.
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const sampleDataRevisionKey = useSampleDataRevisionKey(samples);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [pendingFolderImport, setPendingFolderImport] = useState<PendingFolderImport | null>(null);
  const [pendingWorkspaceRelink, setPendingWorkspaceRelink] =
    useState<PendingWorkspaceRelink | null>(null);
  const [workspaceRelinkScanning, setWorkspaceRelinkScanning] = useState(false);
  const [workspaceRelinkError, setWorkspaceRelinkError] = useState<string | null>(null);
  const workspaceRelinkResolverRef = useRef<
    ((resolved: ReadonlyMap<string, ResolvedReferenceFcs> | null) => void) | null
  >(null);
  // Global sample filter (R's rv$sample_mask): samples excluded from the multi-sample analysis
  // tabs (Statistics / Proportions). New samples are included by default; default = all included.
  const [excludedSampleIds, setExcludedSampleIds] = useState<Set<string>>(new Set());
  const includedSamples = useMemo(
    () => samples.filter((s) => !excludedSampleIds.has(s.id)),
    [samples, excludedSampleIds, sampleDataRevisionKey],
  );
  const sampleListItems = useMemo<SampleListItem[]>(() => samples.map((entry) => ({
    id: entry.id,
    name: entry.name,
    eventCount: entry.sample.fcs.nEvents,
    channelCount: entry.sample.channels.length,
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
  })), [samples, sampleDataRevisionKey]);
  const folderImportItems = useMemo<FolderImportItem[]>(() => {
    if (!pendingFolderImport) return [];
    const existingNames = new Set(samples.map((entry) => entry.name.toLocaleLowerCase()));
    const prefix = `${pendingFolderImport.folderName}/`;
    return pendingFolderImport.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      relativePath: candidate.sourcePath?.startsWith(prefix)
        ? candidate.sourcePath.slice(prefix.length)
        : candidate.sourcePath ?? candidate.name,
      size: candidate.file.size,
      duplicateName: existingNames.has(candidate.name.toLocaleLowerCase()),
    }));
  }, [pendingFolderImport, samples]);
  const activeEntry = samples.find((s) => s.id === activeSampleId) ?? null;
  const sample = activeEntry?.sample ?? null;
  const activeDataRevision = sample?.dataRevision ?? 0;
  const compensationOn = sample?.compensationEnabled ?? false;
  const fileName = activeEntry?.name ?? "";
  const [wsHandle, setWsHandle] = useState<FileSystemFileHandle | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsStorage, setWsStorage] = useState<WorkspaceStorage>("reference");
  const [workspaceId, setWorkspaceId] = useState(makeWorkspaceId);
  const [workspaceCompensation, setWorkspaceCompensation] =
    useState<WorkspaceCompensationState>(() => newEmptyWorkspaceCompensationState());
  const activeCompensatedStatus = sample?.compensatedLayerStatus() ?? null;
  const activeCompensationProfile = useMemo(() => {
    if (
      !activeCompensatedStatus ||
      activeCompensatedStatus.state === "missing" ||
      activeCompensatedStatus.metadata.runtimeIdentity !== "profile"
    ) return null;
    return findCompensationProfile(
      workspaceCompensation,
      activeCompensatedStatus.metadata.profileId,
    );
  }, [activeCompensatedStatus, workspaceCompensation]);
  const activeCompensationBaseline = useMemo(() => {
    if (!activeCompensationProfile) return null;
    return findCompensationProfile(
      workspaceCompensation,
      activeCompensationProfile.baselineProfileId,
    );
  }, [activeCompensationProfile, workspaceCompensation]);
  const canUseCompensatedAssay = sample !== null && (
    activeCompensatedStatus?.state === "ready" ||
    (activeCompensatedStatus?.state === "missing" && sample.instrument === "flow" && sample.spillover !== null)
  );
  const compensationWorkerLimit = availableCompensationWorkerCount();
  const [compensationWorkerCount, setCompensationWorkerCount] = useState(
    () => initialCompensationWorkerCount(compensationWorkerLimit),
  );
  const compensationManagerRef = useRef<CompensationManager | null>(null);
  if (compensationManagerRef.current === null) {
    compensationManagerRef.current = new CompensationManager({
      workspaceKey: workspaceId,
      workerPoolSize: compensationWorkerCount,
    });
  }
  const compensationCandidatePreviewSessionRef = useRef<Readonly<{
    key: string;
    sessionId: string;
  }> | null>(null);
  const compensationCandidatePreviewPrimeRef = useRef<Readonly<{
    key: string;
    promise: ReturnType<CompensationManager["primePreview"]>;
  }> | null>(null);
  const cancelCompensationCandidatePreview = useCallback((reason: string) => {
    compensationCandidatePreviewSessionRef.current = null;
    compensationCandidatePreviewPrimeRef.current = null;
    compensationManagerRef.current!.cancelPreview(reason);
  }, []);
  const compensationSweepManagersRef = useRef<CompensationManager[]>([]);
  const cancelCompensationSweepManagers = useCallback((reason: string) => {
    const managers = compensationSweepManagersRef.current;
    compensationSweepManagersRef.current = [];
    for (const manager of managers) {
      manager.cancelPreview(reason);
      manager.dispose();
    }
  }, []);
  const suspendCompensationBackgroundWork = useCallback(() => {
    cancelCompensationSweepManagers("The Compensation tab was hidden.");
    cancelCompensationCandidatePreview("The Compensation tab was hidden.");
  }, [cancelCompensationCandidatePreview, cancelCompensationSweepManagers]);
  const compensationApplyGuardRef = useRef(false);
  const hostCompensationAbortRef = useRef<AbortController | null>(null);
  const compensationRestoreCancelledRef = useRef(false);
  const [compensationApplyStatus, setCompensationApplyStatus] =
    useState<CompensationApplyUiStatus | null>(null);
  const [scaleCacheEpoch, setScaleCacheEpoch] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [workspaceEditRevision, setWorkspaceEditRevision] = useState(0);
  const workspaceEditRevisionRef = useRef(0);
  const markWorkspaceDirty = useCallback(() => {
    setDirty(true);
    setWorkspaceEditRevision((current) => {
      const next = current + 1;
      workspaceEditRevisionRef.current = next;
      return next;
    });
  }, []);
  const [hostWorkspaceRevision, setHostWorkspaceRevision] = useState(0);
  const hostWorkspaceRevisionRef = useRef(0);
  const [hostWorkspaceStatus, setHostWorkspaceStatus] = useState<
    "loading" | "saved" | "saving" | "unsaved" | "error"
  >("loading");
  const [hostColDataBusy, setHostColDataBusy] = useState(false);
  const [hostAdapterWriteBusy, setHostAdapterWriteBusy] = useState(false);
  const [hostColDataColumns, setHostColDataColumns] = useState<readonly string[]>([]);
  const [hostDatasetDescriptor, setHostDatasetDescriptor] =
    useState<GateLabHostDatasetDescriptor | null>(null);
  const hostExistingCompensatedAssays = useMemo(
    () => (hostDatasetDescriptor?.assays ?? []).filter(
      (assay): assay is GateLabHostAssayDescriptor =>
        assay.coordinateSpace === "linear" &&
        !samples.some(({ hostSource }) => hostSource?.assayId === assay.id),
    ),
    [hostDatasetDescriptor, samples],
  );
  const hostSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastHostSavedEditRevisionRef = useRef(-1);
  const lastHostSaveResultRef = useRef<GateLabHostWorkspaceWriteResult | null>(null);
  const [xIdx, setXIdx] = useState(0);
  const [yIdx, setYIdx] = useState(1);
  const [mode, setMode] = useState<DisplayMode>("pseudocolor");
  const [busy, setBusy] = useState(false);
  const [sampleManagerOpen, setSampleManagerOpen] = useState(false);
  const [sampleManagerSelection, setSampleManagerSelection] = useState<string[]>([]);
  const [sampleImportProgress, setSampleImportProgress] = useState<SampleImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingNewGate | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>("navigate");
  const [scalesVersion, setScalesVersion] = useState(0);
  // Set when a workspace finishes loading; consumed once the sample, gates and automatic
  // ranges exist, which is later than the load handler itself.
  const pendingFitOnLoad = useRef(false);
  // Which global scales GateLab fitted itself, and under which display transform. A range the
  // user pinned in the Scales tab is absent here, which is what keeps it from being discarded.
  const autoFittedScales = useRef(new Map<string, string>());
  // Axis pairs already fitted, so a fit happens once per plot rather than on every click.
  const fittedAxisPairs = useRef(new Set<string>());
  const [panelVersion, setPanelVersion] = useState(0); // bumps when a channel display label changes
  const [crud, setCrud] = useState<CrudModal | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(INITIAL_LEFT_PANE_WIDTH);
  const [sideWidth, setSideWidth] = useState(INITIAL_RIGHT_PANE_WIDTH);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [yRange, setYRange] = useState<[number, number] | null>(null);
  const [maxEvents, setMaxEvents] = useState(50000); // 0 = all (no downsampling)
  const [activeTab, setActiveTab] = useState<TabId>("gating");
  const compensationTabStateKey = `${workspaceId}:${activeSampleId ?? "none"}`;
  const [mountedCompensationStateKey, setMountedCompensationStateKey] = useState<string | null>(null);
  useEffect(() => {
    if (activeTab === "compensation") {
      setMountedCompensationStateKey(compensationTabStateKey);
      return;
    }
    // A new workspace/sample has its own draft. Do not eagerly mount that large editor while the
    // user is working elsewhere; it mounts on the first visit to Compensation.
    setMountedCompensationStateKey((current) => current === compensationTabStateKey ? current : null);
  }, [activeTab, compensationTabStateKey]);
  const compensationTabMounted = activeTab === "compensation" ||
    mountedCompensationStateKey === compensationTabStateKey;
  const [pointAlpha, setPointAlpha] = useState(0.4); // main-plot point opacity (cytof point_alpha)
  const [pointSize, setPointSize] = useState(1.5); // main-plot mark radius in px (cytof point_size)
  const [densityColorPower, setDensityColorPower] = useState(DEFAULT_DENSITY_COLOR_POWER);
  const changeDensityColorPower = useCallback((value: number) => {
    setDensityColorPower(normalizeDensityColorPower(value));
  }, []);
  const [gatingFontSizes, setGatingFontSizes] = useState<GatingFontSizes>({ ...DEFAULT_GATING_FONT_SIZES });
  // Illustration-tab config, lifted to a ref so it survives the tab's unmount (persists across tab
  // switches) and can be saved to the workspace; plus named presets.
  const illustConfigRef = useRef<IllustrationConfig | null>(null);
  const strategyConfigRef = useRef<StrategyConfig | null>(null); // Strategy controls, survive tab switches
  const [illustrationPresets, setIllustrationPresets] = useState<IllustrationPreset[]>([]);
  const [illustVersion, setIllustVersion] = useState(0); // bump to remount IllustrationTab on workspace load
  const [fcsAssay, setFcsAssay] = useState<FcsExportAssay>("original");
  const [fcsScope, setFcsScope] = useState<"active" | "combined" | "split">("split");
  const [fcsMinimumEvents, setFcsMinimumEvents] = useState(0);
  const [fcsExportOpen, setFcsExportOpen] = useState(false);
  const [pendingGatingMlImport, setPendingGatingMlImport] = useState<PendingGatingMLImport | null>(null);
  // A workspace whose sample could not be resolved unambiguously; the user picks one.
  const [wspPicker, setWspPicker] = useState<
    { text: string; samples: FlowJoSampleSummary[]; reason: string } | null
  >(null);
  /** A sample holding more than one independent tree; GateLab can hold only one. */
  const [treePicker, setTreePicker] = useState<
    { text: string; sample: FlowJoSampleSummary; matchedOn: FlowJoSampleMatchKey | null } | null
  >(null);
  /**
   * Opening a .wsp directly. The workspace names the files it expects, so the FCS can be
   * gathered from what is already loaded plus whatever the user points at; samples whose file
   * never turns up are reported and skipped rather than blocking the rest.
   */
  const [flowJoOpen, setFlowJoOpen] = useState<
    {
      fileName: string;
      text: string;
      /** The .wsp's own handle, so the FCS picker opens in the folder it came from. */
      handle: FileSystemFileHandle | null;
      samples: FlowJoSampleSummary[];
      pending: { name: string; file: File }[];
      strategySample: number | null;
      strategyTree: number | null;
    } | null
  >(null);
  /** Held until the sample the strategy belongs to is the active one. */
  const [pendingFlowJoStrategy, setPendingFlowJoStrategy] = useState<
    { text: string; choice: FlowJoSampleSummary; treeIndex: number | null; targetNames: string[] } | null
  >(null);
  const wspFcsRef = useRef<HTMLInputElement>(null);
  const [gateEdgeMode, setGateEdgeMode] = useState<GateEdgeMode>(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("gatelab.gateEdgeMode") : null;
    return stored === "straight" || stored === "bowed" || stored === "straight-bow" ? stored : "straight-bow";
  });
  useEffect(() => {
    try {
      localStorage.setItem("gatelab.gateEdgeMode", gateEdgeMode);
    } catch {
      // A blocked localStorage is not a reason to fail; the choice just does not persist.
    }
  }, [gateEdgeMode]);
  // Dismissed for good once read: it answers a question, and a standing answer is clutter.
  const [gateEdgeNoteHidden, setGateEdgeNoteHiddenState] = useState<boolean>(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("gatelab.gateEdgeNoteHidden") === "1" : false),
  );
  const setGateEdgeNoteHidden = (hidden: boolean) => {
    setGateEdgeNoteHiddenState(hidden);
    try {
      localStorage.setItem("gatelab.gateEdgeNoteHidden", hidden ? "1" : "0");
    } catch {
      // A blocked localStorage only costs persistence; the note still hides for this session.
    }
  };
  const [gatingMlExportOpen, setGatingMlExportOpen] = useState(false);
  const [contourThreshold, setContourThreshold] = useState(5); // outer contour % of peak
  const [instrumentMode, setInstrumentMode] = useState<"auto" | "flow" | "cytof">("auto"); // active sample's instrument override
  // Colour-by-factor overlay on the main plot (population partition / division level).
  const [overlayBy, setOverlayBy] = useState<"none" | "population" | "division" | "sample">("none");
  // Scope the gates drawn on the plot to the displayed branch (default), or draw every gate
  // that shares the channel pair. The wide view is for comparing thresholds set on different
  // branches against each other, which the scoped view deliberately hides.
  const [branchGatesOnly, setBranchGatesOnly] = useState(true);
  const [overlayPalette, setOverlayPalette] = useState<PaletteName>("default");
  const activeDisplayContextKey = sample?.displayTransformContextKey ?? null;
  const activeWorkspaceScaleContextKey = sample?.workspaceScaleContextKey ?? null;
  // Fixed ranges are workspace-wide within an assay family. Selecting another blue FCS row must
  // not swap the scale map; Original and Compensated remain separate coordinate families.
  const { globalScales, setGlobalScales, preserveScalesForContext } =
    useContextualGlobalScales(activeWorkspaceScaleContextKey, scaleCacheEpoch);
  // Per-sample metadata (Metadata tab): keyed by SampleEntry.id → { field: value }; ordered columns.
  const [metadata, setMetadata] = useState<Record<string, Record<string, string>>>({});
  const [metadataColumns, setMetadataColumns] = useState<MetadataColumn[]>([]);
  // Per-population metadata (Metadata tab, 2nd table): keyed by population_id (rename-safe) → { field: value }.
  const [populationMetadata, setPopulationMetadata] = useState<Record<string, Record<string, string>>>({});
  const [populationMetaColumns, setPopulationMetaColumns] = useState<MetadataColumn[]>([]);
  // Per-sample division profiles (Division tab) → per-event Div0..DivN level, keyed by SampleEntry.id.
  const [divisionProfiles, setDivisionProfiles] = useState<Record<string, DivisionProfile>>({});
  const compatibleDivisionProfiles = useMemo(
    () => Object.fromEntries(Object.entries(divisionProfiles).filter(([sampleId, profile]) => {
      const entry = samples.find((candidate) => candidate.id === sampleId);
      if (!entry) return false;
      try {
        return profile.coordinateBindingKey === entry.sample.displayCoordinateBindingKey(profile.channelKey);
      } catch {
        return false;
      }
    })),
    [divisionProfiles, samples, sampleDataRevisionKey, scalesVersion, instrumentMode],
  );

  useEffect(() => {
    cancelCompensationSweepManagers("The workspace changed.");
    cancelCompensationCandidatePreview("The workspace changed.");
    compensationManagerRef.current!.resetWorkspace(workspaceId);
  }, [cancelCompensationCandidatePreview, cancelCompensationSweepManagers, workspaceId]);
  useEffect(() => () => {
    cancelCompensationSweepManagers("GateLab closed.");
    cancelCompensationCandidatePreview("GateLab closed.");
  }, [cancelCompensationCandidatePreview, cancelCompensationSweepManagers]);
  const bumpScales = () => setScalesVersion((v) => v + 1);
  const plotAreaRef = useRef<HTMLDivElement>(null);

  const pzRef = useRef({
    sample, xIdx, yIdx, xRange, yRange, drawMode, mode, globalScales,
    effectiveXRange: null as [number, number] | null,
    effectiveYRange: null as [number, number] | null,
  });
  pzRef.current = {
    sample, xIdx, yIdx, xRange, yRange, drawMode, mode, globalScales,
    effectiveXRange: null,
    effectiveYRange: null,
  };

  const activeXChannelKey = sample?.channels[xIdx]?.key ?? null;
  const activeYChannelKey = sample?.channels[yIdx]?.key ?? null;
  // Transient ranges are only meaningful within one channel/assay coordinate family. A blue-row
  // sample change that retains those channels deliberately does not clear the shared view.
  useEffect(
    () => setXRange(null),
    [activeWorkspaceScaleContextKey, activeXChannelKey, activeDataRevision],
  );
  useEffect(
    () => setYRange(null),
    [activeWorkspaceScaleContextKey, activeYChannelKey, activeDataRevision],
  );

  // Drawn vertices are display-space coordinates. Never convert them after the assay layer
  // changes, because that would store a gate in a different coordinate system than the user drew.
  useEffect(() => {
    let coordinatesMatch = false;
    if (pending && sample && pending.sampleId === activeSampleId) {
      try {
        coordinatesMatch =
          pending.coordinateBindingKeys[0] === sample.displayCoordinateBindingKey(pending.gate.x_channel) &&
          pending.coordinateBindingKeys[1] === sample.displayCoordinateBindingKey(pending.gate.y_channel);
      } catch {
        coordinatesMatch = false;
      }
    }
    if (
      pending &&
      (pending.sampleId !== activeSampleId ||
        pending.dataRevision !== activeDataRevision ||
        !sample ||
        !coordinatesMatch)
    ) {
      setPending(null);
      setError("The data layer or display transform changed while the gate dialog was open. Please draw the gate again.");
    }
  }, [pending, sample, activeSampleId, activeDataRevision, instrumentMode, scalesVersion]);
  const skipDirtyRef = useRef(true);

  // Navigate-mode plot interaction, writing straight into the X/Y ranges so the Min/Max
  // fields, axes, and plot stay in lockstep:
  //   • drag              → pan
  //   • shift/option-drag → "anchored stretch" (bottom-left/min fixed; grabbed point follows
  //                          the cursor, stretching the data — FACS Chorus style). Shift is the
  //                          primary modifier (Alt/Option can be intercepted by the OS on Win/Linux).
  // Range updates are coalesced to one requestAnimationFrame (smooth, no overshoot).
  useEffect(() => {
    const el = plotAreaRef.current;
    if (!el) return;

    const rect = () => {
      const ov = el.querySelector(".cytof-overlay"); // exact plot data area
      return (ov ?? el).getBoundingClientRect();
    };
    const ranges = () => {
      const p = pzRef.current;
      if (!p.sample) return null;
      const xKey = p.sample.channels[p.xIdx].key;
      const yKey = p.sample.channels[p.yIdx].key;
      return {
        xr: p.xRange ?? p.globalScales[xKey] ?? p.effectiveXRange ?? p.sample.displayRange(p.xIdx),
        yr: p.yRange ?? p.globalScales[yKey] ?? p.effectiveYRange ?? p.sample.displayRange(p.yIdx),
      };
    };
    const clampF = (f: number) => Math.min(0.98, Math.max(0.02, f));
    const valid = (r: [number, number]): boolean =>
      Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] - r[0] > 1e-6;

    // Coalesce range writes to one per frame.
    let pX: [number, number] | null = null;
    let pY: [number, number] | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pX) setXRange(pX);
      if (pY) setYRange(pY);
      pX = pY = null;
    };
    const queue = (nx: [number, number], ny: [number, number]) => {
      if (!valid(nx) || !valid(ny)) return; // never write a degenerate range
      pX = nx;
      pY = ny;
      // Contour rebuilds the KDE on every range change (~0.5s) — doing that per frame is
      // unusable. In contour mode, hold the pending range and apply it once on drag-end
      // (the view freezes during the drag, then reforms). Cheap modes pan live per frame.
      if (pzRef.current.mode === "contour") return;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const listen = (onMove: (ev: MouseEvent) => void) => {
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const fx = pX ?? pzRef.current.xRange; // pending (contour mode) else the last live-panned range
        const fy = pY ?? pzRef.current.yRange;
        flush(); // apply any deferred range (contour mode) once at drag-end
        // Commit the final panned/stretched view to the SHARED per-channel scale so the Gating plot
        // AND the Strategy / Illustration tabs inherit it (persisting per-channel, GateLabR-style);
        // then clear the transient per-view range so globalScales is the single source of truth.
        const p = pzRef.current;
        if (p.sample && fx && fy && valid(fx) && valid(fy)) {
          setGlobalScale(p.sample.channels[p.xIdx].key, fx);
          setGlobalScale(p.sample.channels[p.yIdx].key, fy);
          setXRange(null);
          setYRange(null);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (pzRef.current.drawMode !== "navigate") return;
      const t = e.target as Element;
      // Gate gestures and clickable axis labels belong to cytof_plot.js. Starting our
      // plot-wide pan listener on either can prevent or disturb the intended interaction.
      // Must match the renderer's own exclusion list. Gate labels are re-parented into a
      // top-level `gate-labels-layer` for z-order, so they are NOT inside `.saved-gate` and a
      // guard naming only that lets a label drag start this plot-wide pan as well. Both then run:
      // the label moves, and on mouseup the pan commits a range through setGlobalScale, which is
      // the scale snapping back after nothing more than moving a label.
      if (t.closest?.(CYTOF_OWNED_TARGETS)) return;
      const rr = ranges();
      if (!rr) return;
      const r = rect();
      const { xr, yr } = rr;
      e.preventDefault();

      if (e.altKey || e.shiftKey) {
        // Anchored stretch: min fixed; the data point grabbed at mousedown follows the
        // cursor, so the max end moves and the data stretches/compresses.
        const gx = xr[0] + clampF((e.clientX - r.left) / r.width) * (xr[1] - xr[0]);
        const gy = yr[1] - clampF((e.clientY - r.top) / r.height) * (yr[1] - yr[0]);
        listen((ev) => {
          const fx = clampF((ev.clientX - r.left) / r.width);
          const fy = clampF((ev.clientY - r.top) / r.height);
          const xMax = xr[0] + (gx - xr[0]) / fx; // x_min anchored
          const yMax = (gy - yr[0] * fy) / (1 - fy); // y_min anchored
          queue([xr[0], xMax], [yr[0], yMax]);
        });
      } else {
        // Pan: grab the data and move it with the cursor.
        const startX = e.clientX;
        const startY = e.clientY;
        const xSpan = xr[1] - xr[0];
        const ySpan = yr[1] - yr[0];
        listen((ev) => {
          const ddx = ((ev.clientX - startX) / r.width) * xSpan;
          const ddy = ((ev.clientY - startY) / r.height) * ySpan;
          queue([xr[0] - ddx, xr[1] - ddx], [yr[0] + ddy, yr[1] + ddy]);
        });
      }
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sample]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const w = window.innerWidth - ev.clientX;
      setSideWidth(Math.max(320, Math.min(w, 900)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const move = (ev: MouseEvent) => {
      setLeftWidth(Math.max(180, Math.min(ev.clientX - left, 480)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const [state, dispatch] = useReducer(coreReducer, undefined, initialCoreState);
  useEffect(() => {
    const onHistoryShortcut = (event: KeyboardEvent) => {
      const action = historyShortcutAction(event);
      if (!action) return;
      if (action === "undo" ? state.undo.length === 0 : state.redo.length === 0) return;
      event.preventDefault();
      dispatch({ type: action });
    };
    window.addEventListener("keydown", onHistoryShortcut);
    return () => window.removeEventListener("keydown", onHistoryShortcut);
  }, [state.undo.length, state.redo.length]);

  // Presentation-only population edits (rename / sibling reorder) must not invalidate
  // masks for every checked FCS file. Hold the last scientific gating graph until its
  // explicit revision changes; cosmetic gate-label moves and active selections are also
  // intentionally excluded.
  const gatingState = useMemo(
    () => state,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.gate_version, state.root_population_id],
  );

  // Mark the workspace dirty on any edit (skipped once per load/save, which set skipDirtyRef).
  useEffect(() => {
    if (skipDirtyRef.current) {
      skipDirtyRef.current = false;
      return;
    }
    markWorkspaceDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.gate_version, state.tree_version, scalesVersion, sampleDataRevisionKey, instrumentMode, globalScales, mode, maxEvents, contourThreshold, densityColorPower, xIdx, yIdx, gatingFontSizes, workspaceCompensation]);

  // Autosave lightweight reference workspaces only. Repacking every embedded FCS on each
  // edit would stall large bundled workspaces; bundles retain their format via manual Save.
  const buildWsRef = useRef<() => LiveWorkspaceFile | null>(() => null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const pendingCheckpointReasonRef = useRef<WorkspaceCheckpointReason | null>(null);

  const checkpointCurrentWorkspace = (reason: WorkspaceCheckpointReason): Promise<void> => {
    const ws = buildWsRef.current();
    const id = workspaceIdRef.current;
    if (!ws || !id) return Promise.resolve();
    return saveWorkspaceCheckpoint(id, ws, reason).then(() => undefined);
  };

  async function startNewWorkspace(): Promise<void> {
    setCrud(null);
    if (compensationApplyGuardRef.current || compensationManagerRef.current!.applyInProgress) {
      setError(t("Wait for the current compensation Apply to finish, or cancel it, before starting a new workspace."));
      return;
    }
    setBusy(true);
    let checkpointWarning: string | null = null;
    try {
      await checkpointCurrentWorkspace("before-new-workspace");
    } catch (cause) {
      checkpointWarning = `New workspace started, but its local recovery checkpoint could not be written: ${cause instanceof Error ? cause.message : String(cause)}`;
    }

    // Prevent the reset render from being mistaken for an edit to the new empty workspace.
    skipDirtyRef.current = true;
    pendingCheckpointReasonRef.current = null;
    clearPersistedTabState();

    const nextWorkspaceId = makeWorkspaceId();
    compensationManagerRef.current!.resetWorkspace(nextWorkspaceId);
    setSamples([]);
    setActiveSampleId(null);
    setExcludedSampleIds(new Set());
    setSampleManagerOpen(false);
    setSampleManagerSelection([]);
    setPendingFolderImport(null);
    setSampleImportProgress(null);
    setWorkspaceId(nextWorkspaceId);
    setWorkspaceCompensation(newEmptyWorkspaceCompensationState());
    compensationApplyGuardRef.current = false;
    setCompensationApplyStatus(null);
    setWsHandle(null);
    setWsName("");
    setWsStorage("reference");

    setXIdx(0);
    setYIdx(1);
    setXRange(null);
    setYRange(null);
    setMode("pseudocolor");
    setMaxEvents(50000);
    setContourThreshold(5);
    setPointAlpha(0.4);
    setDensityColorPower(DEFAULT_DENSITY_COLOR_POWER);
    setGatingFontSizes({ ...DEFAULT_GATING_FONT_SIZES });
    setDrawMode("navigate");
    setActiveTab("gating");

    setInstrumentMode("auto");
    setScaleCacheEpoch((epoch) => epoch + 1);
    setGlobalScales({});
    channelScales.clear();
    autoFittedScales.current.clear();
    fittedAxisPairs.current.clear();
    setScalesVersion((version) => version + 1);
    setPanelVersion((version) => version + 1);
    setOverlayBy("none");
    setOverlayPalette("default");

    illustConfigRef.current = null;
    strategyConfigRef.current = null;
    setIllustrationPresets([]);
    setIllustVersion((version) => version + 1);
    setMetadata({});
    setMetadataColumns([]);
    setPopulationMetadata({});
    setPopulationMetaColumns([]);
    setDivisionProfiles({});

    setPending(null);
    setPendingGatingMlImport(null);
    setFcsExportOpen(false);
    setGatingMlExportOpen(false);
    setFcsAssay("original");
    setFcsScope("active");
    setError(checkpointWarning);
    dispatch({ type: "newWorkspace" });
    setDirty(false);
    setImportMsg("New workspace ready · add an FCS file to begin.");
    setBusy(false);
  }

  // Check every two minutes. Automatic checkpoints de-duplicate unchanged workspace JSON, so
  // an idle app performs a small IndexedDB read but does not accumulate redundant snapshots.
  useEffect(() => {
    void requestPersistentWorkspaceHistory();
    const timer = window.setInterval(() => {
      void checkpointCurrentWorkspace("automatic");
    }, AUTO_CHECKPOINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // This function reads only refs, which are refreshed on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Major imports queue their post-change checkpoint for the first committed React render.
  useEffect(() => {
    const reason = pendingCheckpointReasonRef.current;
    if (!reason) return;
    pendingCheckpointReasonRef.current = null;
    void checkpointCurrentWorkspace(reason);
  });

  useEffect(() => {
    if (!dirty || !wsHandle || wsStorage === "bundle") return;
    const t = setTimeout(async () => {
      const ws = buildWsRef.current();
      if (!ws) return;
      try {
        await writeHandle(wsHandle, packReferenceWorkspace(ws) as BlobPart);
        setDirty(false);
        setImportMsg(`Autosaved · ${wsName}`);
      } catch {
        /* autosave is best-effort — a manual Save still works */
      }
    }, 15000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, wsHandle, wsName, wsStorage]);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const xmlRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<HTMLInputElement>(null);

  async function prepareGatingImport(file: File) {
    if (!sample || !activeSampleId) return;
    try {
      const text = await file.text();

      // A FlowJo workspace is rewritten into Gating-ML and then takes the ordinary path, so
      // channel resolution, validation, population building and merge/replace are unchanged.
      // FlowJo's own Gating-ML export omits gating:name, so importing a workspace is the only
      // way to get a NAMED hierarchy out of FlowJo without a separate recovery step.
      if (!isFlowJoWorkspace(text)) {
        await prepareGatingImportFromGatingML(text, "");
        return;
      }

      const samples = listFlowJoWorkspaceSamples(text);
      const usable = samples.filter((s) => s.gateCount > 0);
      if (!usable.length) throw new Error("This workspace contains no gates GateLab can read.");

      // A FACSDiva export names its samples by the acquisition's $FIL keyword rather than by the
      // file on disk, so the loaded file's own $FIL is offered as a second key.
      const fil = sample.fcs.keywords["$FIL"] ?? null;
      const { matches, matchedOn } = matchFlowJoSamples(usable, { fileName, fil });

      // Exactly one match keeps the ordinary flow a single click. Anything else is ambiguous
      // and gets a picker rather than a guess: FlowJo allows the same file to be added twice,
      // and quietly taking the first would import another sample's gates.
      if (matches.length === 1 && matchedOn !== null) {
        const only = matches[0];
        if (only.trees.length > 1) {
          // GateLab holds one strategy. Merging several would combine trees FlowJo kept apart.
          setTreePicker({ text, sample: only, matchedOn });
          return;
        }
        await importFlowJoSample(text, only, matchedOn, only.trees.length === 1 ? 0 : null);
        return;
      }
      setWspPicker({
        text,
        samples: usable,
        reason: matches.length > 1
          ? `${matches.length} samples in this workspace are named "${matches[0].name}". Choose which one to import.`
          : `No sample in this workspace matches the loaded file "${fileName}"` +
            `${fil ? ` or its $FIL keyword "${fil}"` : ""}. Choose which sample's gates to import.`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // A workspace's strategy can only be imported onto its own sample, and loading that sample is
  // asynchronous, so the strategy waits here until it is the active one. Matching on any of the
  // names the workspace records, because the file on disk may carry none of them but its own.
  useEffect(() => {
    const p = pendingFlowJoStrategy;
    if (!p || !sample || !activeSampleId) return;
    const stem = (n: string) => n.replace(/\.fcs$/i, "").trim().toLowerCase();
    if (!p.targetNames.some((n) => stem(n) === stem(fileName))) return;
    setPendingFlowJoStrategy(null);
    void importFlowJoSample(p.text, p.choice, null, p.treeIndex);
    // importFlowJoSample is recreated every render; depending on it would re-run this endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFlowJoStrategy, sample, activeSampleId, fileName]);

  /**
   * Gather FCS for an open workspace, starting in the folder the .wsp came from.
   *
   * A plain <input type="file"> cannot be told where to open -- the browser decides, and it
   * remembers wherever it was last, which for a workspace import is almost never the right place.
   * The File System Access picker takes `startIn`, and the workspace's own handle is exactly the
   * hint needed, since its FCS normally sit beside it. Falls back to the input where that API is
   * unavailable, which loses only the starting folder.
   */
  async function chooseFlowJoFcs(state: NonNullable<typeof flowJoOpen>) {
    if (!supportsFileSystemAccess()) {
      wspFcsRef.current?.click();
      return;
    }
    try {
      const picked = await pickFiles(
        FCS_FILE_ACCEPT,
        "FCS files",
        // Keyed separately from the sample importer so the two do not fight over a remembered
        // folder, and started at the workspace so the first open lands in the right place.
        { id: "gatelab-flowjo-workspace-fcs", ...(state.handle ? { startIn: state.handle } : {}) },
      );
      if (!picked?.length) return;
      setFlowJoOpen((cur) => cur && {
        ...cur,
        pending: [
          ...cur.pending,
          ...picked
            .filter((f) => !cur.pending.some((q) => q.name === f.name))
            .map((f) => ({ name: f.name, file: f.file })),
        ],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Load the files gathered for a .wsp, then hand its strategy to the ordinary import path. */
  async function completeFlowJoOpen(state: NonNullable<typeof flowJoOpen>) {
    const chosen = state.samples.find((x) => x.index === state.strategySample);
    if (!chosen) return;
    setFlowJoOpen(null);
    const loadedNames = samples.map((s0) => s0.name);
    const resolutions = resolveFlowJoWorkspaceFiles(
      state.samples,
      [...loadedNames, ...state.pending.map((f) => f.name)],
    );
    const target = resolutions.find((r) => r.sampleIndex === chosen.index);
    if (!target?.fileName) {
      setError(
        `The strategy belongs to "${chosen.name}", whose FCS was not among the files chosen. ` +
          `Expected one of: ${chosen.candidateFileNames.join(", ")}.`,
      );
      return;
    }
    const skipped = resolutions.filter((r) => r.fileName === null);
    if (skipped.length) {
      setImportMsg(
        `${skipped.length} of ${state.samples.length} sample(s) in ${state.fileName} had no matching FCS and were skipped.`,
      );
    }
    // A tree is only chosen when there is a choice; one tree needs no question.
    const treeIndex = state.strategyTree ?? (chosen.trees.length === 1 ? 0 : null);
    setPendingFlowJoStrategy({
      text: state.text,
      choice: chosen,
      treeIndex,
      targetNames: [target.fileName, ...chosen.candidateFileNames],
    });
    if (state.pending.length) {
      await importFcsCandidates(state.pending.map((f) => ({
        id: crypto.randomUUID(), name: f.name, file: f.file, handle: null,
      })));
    }
  }

  async function importFlowJoSample(
    text: string,
    choice: FlowJoSampleSummary,
    matchedOn: FlowJoSampleMatchKey | null = null,
    /** Which of the sample's independent trees; null merges them all, and says so. */
    treeIndex: number | null = null,
  ) {
    const converted = flowJoWorkspaceToGatingML(text, choice.index, treeIndex);
    if (converted.warnings.length) {
      // Skipped gates are surfaced, never dropped quietly: a hierarchy that silently loses a
      // branch looks like a successful import.
      setError(converted.warnings.join("\n"));
    }
    await prepareGatingImportFromGatingML(
      converted.gatingMl,
      ` from FlowJo workspace · ${converted.sampleName}` +
        (treeIndex !== null && choice.trees.length > 1
          ? ` · ${choice.trees[treeIndex]?.name ?? `tree ${treeIndex + 1}`}`
          : "") +
        // The sample name will not look like the loaded file when $FIL was the matching key, so
        // say why this sample was chosen rather than leaving it looking like the wrong one.
        (matchedOn === "fil" ? ` (matched on $FIL)` : "") +
        (converted.warnings.length ? ` · ${converted.warnings.length} skipped` : ""),
      converted.spillover,
    );
  }

  async function prepareGatingImportFromGatingML(
    text: string,
    wspNote: string,
    workspaceSpillover: FlowJoSpillover | null = null,
  ) {
    if (!sample || !activeSampleId) return;
    try {
      const pnnMap: Record<string, string> = {};
      for (const c of sample.channels) pnnMap[c.pnn] = c.key;

      // The workspace's matrix takes precedence over one embedded in the file, because it is the
      // record of what the gates were actually drawn under. A FACSDiva export writes the
      // ACQUISITION matrix into the FCS while the operator's later adjustment lives only in the
      // workspace, and the two are not the same. The preview does not touch the sample.
      const external =
        workspaceSpillover && sample.instrument === "flow"
          ? sample.externalSpilloverPreview(workspaceSpillover.matrix)
          : null;
      const embeddedDelta =
        external?.display != null && sample.spillover !== null
          ? maxCoefficientDelta(sample.spillover, external.display)
          : null;
      const externalSpillover =
        external?.display != null
          ? {
              matrix: workspaceSpillover!.matrix,
              label: workspaceSpillover!.name || "the FlowJo workspace",
              dropped: external.dropped,
              replacesEmbedded: sample.spillover !== null,
              // Coefficients agreeing to this much are the same matrix round-tripped through a
              // text keyword; beyond it the two are genuinely different compensations.
              differsFromEmbedded: embeddedDelta !== null && embeddedDelta > 1e-6,
              maxDelta: embeddedDelta,
            }
          : null;
      // The instrument decides whether an arcsinh vertex is inverted: flow stores gates in
      // raw space, CyTOF in arcsinh space.
      const res = importGatingML(
        text, sample.channels.map((c) => c.key), pnnMap, sample.instrument);
      const comp = resolveGatingMLCompensation(
        res.compensation,
        res.compensation_refs,
        sample.instrument === "flow",
        external?.display ?? sample.spillover ?? null,
      );
      const existingStrategy = state.root_population_id !== null && hasGatingStrategy({
        gates: state.gates,
        populations: state.populations,
        root_population_id: state.root_population_id,
      });
      const mergeBlockedReason = gatingMergeSpaceConflict({
        hasExistingStrategy: existingStrategy,
        isFlow: sample.instrument === "flow",
        currentCompensation: sample.compensationEnabled,
        importedCompensationTarget: comp.target,
        currentCytofCofactor: sample.arcsinhCofactor,
        importedCytofCofactor: res.cytof_cofactor,
      });
      let compensationNote: string | null = null;
      if (comp.target !== null) {
        if (comp.source === "embedded") {
          if (comp.target) {
            compensationNote = sample.compensationEnabled
              ? "The embedded spillover matrix exactly matches the loaded FCS; compensation is already enabled."
              : "This strategy was gated with FCS compensation enabled. Its exact matrix matches the loaded FCS, so importing will enable compensation.";
          } else {
            compensationNote = sample.compensationEnabled
              ? "This strategy was gated without compensation, so importing will disable the current compensation setting."
              : "This strategy was gated without compensation; the current data are already uncompensated.";
          }
        } else if (comp.target && externalSpillover?.differsFromEmbedded) {
          // The most dangerous case, and the reason any of this exists: both matrices are real
          // and they disagree, so compensating with the file's would move every fluorescence
          // gate while looking completely healthy.
          compensationNote =
            `This FCS and the FlowJo workspace each carry a spillover matrix, and they are not ` +
            `the same: coefficients differ by up to ${externalSpillover.maxDelta!.toFixed(4)}. ` +
            `The file's is typically the matrix recorded at acquisition; the workspace's is the ` +
            `compensation in force when these gates were drawn. Compensation will be enabled ` +
            `either way, and which matrix is used changes where every fluorescence gate falls.`;
        } else if (comp.target && externalSpillover) {
          // The loaded FCS has no matrix of its own, so this is the only thing that can place the
          // gates. It changes every fluorescence value, so it is stated plainly rather than
          // applied as a detail of the gate import.
          compensationNote =
            `These gates were drawn on compensated data, and this FCS carries no spillover ` +
            `matrix. Importing will apply the matrix "${externalSpillover.label}" from the ` +
            `FlowJo workspace to ${externalSpillover.matrix.channels.length - externalSpillover.dropped.length} ` +
            `channel(s) and enable compensation.` +
            (externalSpillover.dropped.length
              ? ` ${externalSpillover.dropped.length} of its parameter(s) are not in this file ` +
                `(${externalSpillover.dropped.join(", ")}) and were left out, which changes the ` +
                `result for the channels they spill into.`
              : "");
        } else if (comp.target) {
          compensationNote =
            "This file declares FCS compensation but does not contain GateLab's exact matrix record. " +
            "Import will use the spillover matrix embedded in the loaded FCS. Continue only if compensation was enabled when these gates were drawn.";
        } else if (sample.compensationEnabled) {
          compensationNote = "This file declares uncompensated dimensions, so importing will disable the current compensation setting.";
        }
      }
      setPendingGatingMlImport({
        result: res,
        compensation: comp,
        sampleId: activeSampleId,
        mergeBlockedReason,
        compensationNote,
        sourceNote: wspNote,
        externalSpillover,
        // Defaulting to the workspace's, because that is the compensation the gates were drawn
        // under -- but it is offered as a choice, not asserted as the correct answer.
        matrixChoice: "workspace",
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyGatingImport(mode: GatingImportMode) {
    const pendingImport = pendingGatingMlImport;
    if (!sample || !pendingImport || pendingImport.sampleId !== activeSampleId) {
      setPendingGatingMlImport(null);
      setError("The active sample changed before Gating-ML import could be applied. Please import the file again.");
      return;
    }
    try {
      const res = pendingImport.result;
      const comp = pendingImport.compensation;
      const displayContextBeforeImport = sample.workspaceScaleContextKey;
      const existingStrategy = state.root_population_id !== null && hasGatingStrategy({
        gates: state.gates,
        populations: state.populations,
        root_population_id: state.root_population_id,
      });
      const mergeBlockedReason = gatingMergeSpaceConflict({
        hasExistingStrategy: existingStrategy,
        isFlow: sample.instrument === "flow",
        currentCompensation: sample.compensationEnabled,
        importedCompensationTarget: comp.target,
        currentCytofCofactor: sample.arcsinhCofactor,
        importedCytofCofactor: res.cytof_cofactor,
      });
      if (mode === "merge" && mergeBlockedReason) throw new Error(mergeBlockedReason);
      if (mode === "replace") {
        // Replacing the hierarchy is destructive; merge mode retains the current strategy.
        await checkpointCurrentWorkspace("before-gatingml-replace");
      }
      // Installed only now that the import is going ahead. It rewrites every fluorescence value,
      // so it must not happen while the confirmation dialog can still be dismissed.
      if (
        comp.target === true &&
        pendingImport.externalSpillover &&
        // Declining the workspace's matrix leaves the file's in place, which needs no install.
        !(pendingImport.externalSpillover.differsFromEmbedded && pendingImport.matrixChoice === "file")
      ) {
        sample.installExternalSpillover(
          pendingImport.externalSpillover.matrix,
          pendingImport.externalSpillover.label,
          { replaceEmbedded: pendingImport.externalSpillover.replacesEmbedded },
        );
      }

      const compensationChanged = comp.target !== null && sample.compensationEnabled !== comp.target;
      if (comp.target !== null) {
        sample.setCompensation(comp.target);
        if (sample.compensationEnabled !== comp.target) {
          throw new Error("The FCS spillover matrix could not be applied, so the gating strategy was not imported.");
        }
        setXRange(null);
        setYRange(null);
      }
      // v3 scale metadata carries axis endpoints in compensated linear space. Restore transforms
      // first, then map those endpoints into GateLab's own display coordinates. Legacy lo/hi are
      // deliberately not applied because GateLabR/flowCore uses a different logicle display scale.
      const restoredScales = restoreGatingMLScaleState(sample, res.scales, res.cytof_cofactor);
      const restoredRanges = Object.keys(restoredScales.ranges).length;
      if (restoredRanges) {
        const targetContext = sample.workspaceScaleContextKey;
        const contextChanged = targetContext !== displayContextBeforeImport;
        if (contextChanged) preserveScalesForContext(targetContext);
        setGlobalScales((current) => contextChanged
          ? { ...restoredScales.ranges }
          : { ...current, ...restoredScales.ranges });
      }
      if (restoredScales.transformsChanged || restoredRanges) {
        setXRange(null);
        setYRange(null);
        bumpScales();
      }
      pendingCheckpointReasonRef.current = "after-gatingml-import";
      dispatch({
        type: "importGating",
        gates: res.gates,
        gate_order: res.gate_order,
        populations: res.populations,
        root_population_id: res.root_population_id,
        mode,
        clearHistory: compensationChanged || restoredScales.transformsChanged,
      });
      setPendingGatingMlImport(null);
      setError(null);
      setImportMsg(
        `${mode === "merge" ? "Merged" : "Imported"} ${res.n_gates_imported} gates, ${res.n_pops_imported} populations` +
          (mode === "merge" ? " · existing strategy retained" : " · current strategy replaced") +
          (comp.target === true ? " · FCS compensation enabled" : "") +
          (comp.target === false ? " · compensation disabled" : "") +
          (res.skipped_channels.length
            ? ` · skipped channels: ${res.skipped_channels.join(", ")}`
            : "") +
          pendingImport.sourceNote,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function exportGating(format: GatingMLFormat) {
    if (!sample || !state.root_population_id) return;
    try {
      const xml = exportGatingML({
        gates: state.gates,
        gate_order: state.gate_order,
        populations: state.populations,
        root_population_id: state.root_population_id,
        sample,
        globalScales,
        format,
        allowQuadrantOmission: true, // the export modal explicitly reports the omitted branches
      });
      const base = sanitizeFilePart((fileName || "gates").replace(/\.[^.]+$/, ""));
      downloadText(`${base}_gatingml_${format}.xml`, xml, "application/xml");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function exportFcs(
    assay: FcsExportAssay,
    scope: "active" | "combined" | "split",
    popIds: string[],
    minimumEvents: number,
  ): boolean {
    if (!sample || !activeEntry) return false;
    try {
      // popIds come from the export dialog. R exports N checkbox-selected populations; one → a
      // bare .fcs, many → a zip.
      if (popIds.length === 0) {
        setError("No population selected to export.");
        return false;
      }
      const scopedEntries = scope === "active" ? [activeEntry] : includedSamples;
      if (scopedEntries.length === 0) {
        setError("No checked FCS files are available for this export scope.");
        return false;
      }
      const splitThreshold = Math.max(0, Math.floor(minimumEvents));
      const exportDerived = new Map<string, Derived>();
      for (const entry of scopedEntries) {
        exportDerived.set(
          entry.id,
          entry.id === activeSampleId ? derived : recompute(entry.sample, state),
        );
      }
      const popMaskFor = (entry: SampleEntry, popId: string): Uint8Array => {
        const mask = exportDerived.get(entry.id)?.masks[popId];
        if (!mask) {
          throw new Error(
            `Cannot export ${state.populations[popId]?.name ?? popId}: no population mask is available for ${entry.name}.`,
          );
        }
        return mask;
      };
      const popNameOf = (popId: string) => sanitizeFilePart(state.populations[popId]?.name ?? "population");

      // The file(s) produced for ONE population under the current sample scope.
      const filesForPop = (popId: string): Record<string, Uint8Array> => {
        const popName = popNameOf(popId);
        const out: Record<string, Uint8Array> = {};
        if (scope === "combined") {
          const items = scopedEntries.map((e) => ({
            sample: e.sample,
            name: e.name,
            mask: popMaskFor(e, popId),
          }));
          out[`combined_${popName}.fcs`] = exportPopulationFcsCombined(items, assay);
        } else if (scope === "split") {
          for (const e of scopedEntries) {
            const eventCount = exportDerived.get(e.id)?.stats.event_count[popId];
            if (!passesPopulationFcsExportThreshold(eventCount, splitThreshold)) continue;
            out[sanitizeFcsName(null, e.name, popName, null)] =
              exportPopulationFcs(e.sample, popMaskFor(e, popId), assay);
          }
        } else {
          const base = sanitizeFilePart((activeEntry.name || "sample").replace(/\.[^.]+$/, ""));
          out[`${base}_${popName}.fcs`] =
            exportPopulationFcs(activeEntry.sample, popMaskFor(activeEntry, popId), assay);
        }
        return out;
      };

      if (popIds.length === 1) {
        const files = filesForPop(popIds[0]);
        const names = Object.keys(files);
        if (names.length === 0) {
          setError(
            `No population × FCS combination contained more than ${splitThreshold.toLocaleString()} events.`,
          );
          return false;
        }
        // One output → bare .fcs. Multiple checked files stay separate inside one zip.
        if (names.length === 1) {
          downloadBlob(names[0], new Blob([files[names[0]] as BlobPart], { type: "application/octet-stream" }));
        } else {
          downloadBlob(`${popNameOf(popIds[0])}_by_sample.zip`, new Blob([zipSync(files) as BlobPart], { type: "application/zip" }));
        }
      } else {
        // Several populations → one zip, each population's file(s) inside.
        const files: Record<string, Uint8Array> = {};
        for (const popId of popIds) mergeExportFiles(files, filesForPop(popId));
        if (Object.keys(files).length === 0) {
          setError(
            `No population × FCS combination contained more than ${splitThreshold.toLocaleString()} events.`,
          );
          return false;
        }
        downloadBlob(`populations_${popIds.length}.zip`, new Blob([zipSync(files) as BlobPart], { type: "application/zip" }));
      }
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  const combinedFcsCompatibility = useMemo(
    () => inspectCombinedFcsCompatibility(
      includedSamples.map((entry) => ({ sample: entry.sample, name: entry.name })),
    ),
    [includedSamples, sampleDataRevisionKey, panelVersion],
  );

  function toggleCompensation(on: boolean): boolean {
    if (!sample) return false;
    const previousLayer = sample.activeLayer;
    try {
      // saveWorkspaceCheckpoint clones the workspace synchronously, so this captures the
      // pre-switch assay binding even though IndexedDB persistence finishes asynchronously.
      void checkpointCurrentWorkspace("before-active-layer-change");
      const installed = sample.compensatedLayerStatus();
      if (installed.state !== "missing" && installed.metadata.runtimeIdentity === "profile") {
        sample.setActiveLayer(on ? "compensated" : "original");
      } else {
        sample.setCompensation(on);
      }
      const applied = sample.compensationEnabled === on;
      if (!applied) {
        setError(t("The requested compensation layer could not be activated for this sample."));
        return false;
      }
      if (sample.activeLayer !== previousLayer) {
        setXRange(null); // assay values changed → re-auto-range
        setYRange(null);
        markWorkspaceDirty();
      }
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function applyCompensationProfile(
    profile: CompensationProfileRecord,
    onProgress?: (progress: CompensationApplyProgress) => void,
    existingHostAssay?: Readonly<{
      id: string;
      label: string;
      revision: number;
    }>,
  ): Promise<void> {
    if (!sample) throw new Error(t("No active sample is available for compensation."));
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      const message = t("Compensation is already running. Follow or cancel the current job in the status bar before starting another Apply.");
      setError(message);
      throw new Error(message);
    }
    cancelCompensationSweepManagers("A full compensation Apply started.");
    cancelCompensationCandidatePreview("A full compensation Apply started.");
    if (profile.recordType === "revision") {
      const lineage = workspaceCompensation.lineages.find(
        ({ baselineProfileId }) => baselineProfileId === profile.baselineProfileId,
      );
      if (!lineage || !lineage.records.some(({ profileId }) => profileId === profile.parentProfileId)) {
        throw new Error(t("The compensation revision cannot be applied because its parent profile is missing from this workspace."));
      }
    }
    const targetEntries = profile.scientific.kind === "cytof-spillover"
      ? includedSamples
      : activeEntry
        ? [activeEntry]
        : [];
    if (targetEntries.length === 0) {
      const message = t("Check at least one FCS file in Samples before applying CyTOF compensation.");
      setError(message);
      throw new Error(message);
    }
    if (profile.scientific.kind === "cytof-spillover") {
      const incompatible = targetEntries.flatMap((entry) => {
        if (entry.sample.instrument !== "cytof") {
          return [t("{name}: not a CyTOF file", { name: entry.name })];
        }
        const compatibility = reportMatrixCompatibility({
          kind: "cytof-spillover",
          matrix: profile.scientific.matrix,
          includedChannels: profile.scientific.includedChannels,
          sampleChannels: entry.sample.channels,
        });
        return compatibility.canApply
          ? []
          : [t("{name}: {reason}", {
              name: entry.name,
              reason: compatibility.blockers.map(({ message }) => message).join(" "),
            })];
      });
      if (incompatible.length > 0) {
        const message = t(
          "Compensation was not applied. Every checked FCS file must be compatible with the CyTOF matrix: {files}",
          { files: incompatible.join("; ") },
        );
        setError(message);
        throw new Error(message);
      }
    }
    const targetTotalEvents = targetEntries.reduce(
      (total, entry) => total + entry.sample.fcs.nEvents,
      0,
    );
    compensationApplyGuardRef.current = true;
    setCompensationApplyStatus({
      phase: "preparing",
      operation: "apply",
      profileName: profile.name,
      fraction: 0,
      processedEvents: 0,
      totalEvents: targetTotalEvents,
      targetFileCount: targetEntries.length,
    });
    try {
      await checkpointCurrentWorkspace("before-compensation-apply");
      const progressHandler = (progress: CompensationApplyProgress) => {
        const progressEntry = targetEntries[progress.sampleIndex];
        setCompensationApplyStatus({
          phase: "applying",
          operation: "apply",
          profileName: profile.name,
          fraction: progress.fraction,
          processedEvents: progress.processedEvents,
          totalEvents: progress.totalEvents,
          targetFileIndex: progress.sampleIndex + 1,
          targetFileCount: progress.sampleCount,
          ...(progressEntry ? { targetFileName: progressEntry.name } : {}),
        });
        setImportMsg(progress.sampleCount > 1 && progressEntry
          ? t("Compensation · file {current} of {count}: {name} · {percent}% · {processed} / {total} events", {
              current: progress.sampleIndex + 1,
              count: progress.sampleCount,
              name: progressEntry.name,
              percent: Math.round(progress.fraction * 100),
              processed: progress.processedEvents.toLocaleString(),
              total: progress.totalEvents.toLocaleString(),
            })
          : t("Compensation · {percent}% · {processed} / {total} events", {
              percent: Math.round(progress.fraction * 100),
              processed: progress.processedEvents.toLocaleString(),
              total: progress.totalEvents.toLocaleString(),
            }));
        onProgress?.(progress);
      };

      let result: Awaited<ReturnType<CompensationManager["apply"]>>;
      if (isSceHost && host.compensation) {
        const authoritativeProfile = existingHostAssay
          ? await adoptedRProfile(profile)
          : await authoritativeRProfile(profile);
        const targetBindings = await Promise.all(targetEntries.map(
          ({ sample: targetSample }) =>
            manager.prepareExternalApplyBinding(
              authoritativeProfile,
              targetSample,
            ),
        ));
        const datasetId = targetEntries[0].hostSource?.datasetId;
        if (
          !datasetId ||
          targetEntries.some(({ hostSource }) =>
            !hostSource || hostSource.datasetId !== datasetId
          )
        ) {
          throw new Error(
            "The selected samples are not mapped to one SCE dataset.",
          );
        }
        setCompensationApplyStatus({
          phase: "applying",
          operation: "apply",
          profileName: authoritativeProfile.name,
          fraction: 0,
          processedEvents: 0,
          totalEvents: targetTotalEvents,
          targetFileCount: targetEntries.length,
        });
        setImportMsg(
          existingHostAssay
            ? t("Adopting existing SCE assay {assay} · no values will be recomputed", {
                assay: existingHostAssay.label,
              })
            : `Applying ${authoritativeProfile.name} in R · ` +
              `${targetTotalEvents.toLocaleString()} full SCE events`,
        );
        const targets = targetEntries.map((entry) => ({
          sampleId: entry.hostSource!.sampleId,
          sourceAssayId: entry.hostSource!.assayId,
          expectedAssayRevision: entry.hostSource!.assayRevision,
          activeLayer: "compensated" as const,
        }));
        const hosted = existingHostAssay
          ? await host.compensation.adoptExistingAssay({
              contractVersion:
                GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
              datasetId,
              profile: authoritativeProfile,
              outputAssayId: existingHostAssay.id,
              expectedOutputAssayRevision: existingHostAssay.revision,
              targets,
            })
          : await (() => {
              const controller = new AbortController();
              hostCompensationAbortRef.current = controller;
              return host.compensation!.applyProfile({
                contractVersion:
                  GATELAB_HOST_COMPENSATION_CONTRACT_VERSION,
                datasetId,
                profile: authoritativeProfile,
                targets,
                workerCount: compensationWorkerCount,
              }, controller.signal, progressHandler);
            })();
        if (
          hosted.application.profile.profileId !==
            authoritativeProfile.profileId ||
          hosted.application.profile.profileHash !==
            authoritativeProfile.profileHash
        ) {
          throw new Error(
            "The R host returned a different compensation profile identity.",
          );
        }
        if (
          existingHostAssay &&
          (
            hosted.application.execution !== "adopted-existing-assay" ||
            hosted.application.outputAssay.id !== existingHostAssay.id
          )
        ) {
          throw new Error(
            "The R host did not adopt the selected existing assay.",
          );
        }
        const payloadBySample = new Map(
          hosted.targets.map((target) => [target.sampleId, target]),
        );
        const prepared = targetEntries.map((entry, index) => {
          const target = payloadBySample.get(entry.hostSource!.sampleId);
          if (!target || target.eventCount !== entry.sample.fcs.nEvents) {
            throw new Error(
              `The R host returned an incomplete assay for '${entry.name}'.`,
            );
          }
          const columns = decodeChannelMajorFloat32(
            target.assayPayload,
            entry.sample.channels.length,
            target.eventCount,
          );
          const binding = targetBindings[index].binding;
          return entry.sample.prepareCompensatedLayer({
            metadata: binding,
            columns: binding.channelBindings
              .filter(({ included }) => included)
              .map(({ pnn, fcsColumnIndex }) => ({
                pnn,
                fcsColumnIndex,
                values: columns[fcsColumnIndex],
              })),
          }, { activeLayer: "compensated" });
        });
        Sample.commitPreparedCompensatedLayers(prepared);
        result = {
          jobId: `r-host:${hosted.application.outputAssay.revision}`,
          profile: hosted.application.profile,
          targets: targetEntries.map((entry, index) => ({
            sample: entry.sample,
            binding: targetBindings[index].binding,
          })),
        };
        progressHandler({
          jobId: result.jobId,
          sampleIndex: Math.max(0, targetEntries.length - 1),
          sampleCount: targetEntries.length,
          sampleProcessedEvents: targetEntries.at(-1)?.sample.fcs.nEvents ?? 0,
          sampleTotalEvents: targetEntries.at(-1)?.sample.fcs.nEvents ?? 0,
          processedEvents: targetTotalEvents,
          totalEvents: targetTotalEvents,
          fraction: 1,
        });
      } else {
        result = await manager.apply({
          profile,
          targets: targetEntries.map(({ sample: targetSample }) => ({
            sample: targetSample,
            activeLayer: "compensated",
          })),
          onProgress: progressHandler,
        });
      }
      // Best-effort local acceleration for every committed target. Cache sequentially so a
      // many-file Apply cannot create a burst of large digest/IndexedDB jobs after completion.
      void (async () => {
        for (const applied of result.targets) {
          const targetEntry = targetEntries.find(({ sample: candidate }) => candidate === applied.sample);
          if (!targetEntry) continue;
          try {
            if (!targetEntry.bytes) continue;
            const fcsDigest = await digestFcsBytes(targetEntry.bytes);
            await writeCachedCompensatedAssay(fcsDigest, applied.sample, applied.binding);
          } catch {
            // The profile remains the scientific source of truth when the local cache is
            // unavailable or the derived assay exceeds its size cap.
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      })();
      const appliedProfile = result.profile;
      setWorkspaceCompensation((current) => {
        const exists = current.lineages.some(({ records }) =>
          records.some(({ profileId }) => profileId === appliedProfile.profileId)
        );
        if (exists) return current;
        const lineageIndex = current.lineages.findIndex(
          ({ baselineProfileId }) =>
            baselineProfileId === appliedProfile.baselineProfileId,
        );
        if (lineageIndex >= 0) {
          return {
            ...current,
            lineages: current.lineages.map((lineage, index) => index === lineageIndex
              ? { ...lineage, records: [...lineage.records, appliedProfile] }
              : lineage),
          };
        }
        return {
          ...current,
          lineages: [
            ...current.lineages,
            {
              baselineProfileId: appliedProfile.baselineProfileId,
              records: [appliedProfile],
            },
          ],
        };
      });
      setXRange(null);
      setYRange(null);
      setError(null);
      const appliedChannelCount =
        appliedProfile.scientific.kind === "flow-spillover"
          ? appliedProfile.scientific.matrix.receiverChannels.length
          : appliedProfile.scientific.includedChannels.length;
      setImportMsg(appliedProfile.scientific.kind === "cytof-spillover"
        ? existingHostAssay
          ? t("Using existing SCE assay {assay} for {files} checked samples · no recomputation", {
              assay: existingHostAssay.label,
              files: targetEntries.length,
            })
          : t("Compensated {files} checked FCS files with {name} · {count} channels", {
              files: targetEntries.length,
              name: appliedProfile.name,
              count: appliedChannelCount,
            })
        : t("Compensated with {name} · {count} channels", {
            name: appliedProfile.name,
            count: appliedChannelCount,
          }));
      pendingCheckpointReasonRef.current = "after-compensation-apply";
    } catch (cause) {
      if (cause instanceof CompensationCancelledError) {
        setError(null);
        setImportMsg(t("Compensation cancelled · previous assay unchanged"));
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    } finally {
      hostCompensationAbortRef.current = null;
      compensationApplyGuardRef.current = false;
      setCompensationApplyStatus(null);
    }
  }

  async function adoptExistingCompensationAssay(
    profile: CompensationProfileRecord,
    assay: Readonly<{ id: string; label: string; revision: number }>,
    onProgress?: (progress: CompensationApplyProgress) => void,
  ): Promise<void> {
    if (!isSceHost || !host.compensation) {
      throw new Error(
        t("Existing-assay adoption is available only for a hosted SingleCellExperiment."),
      );
    }
    return applyCompensationProfile(
      profile,
      onProgress,
      assay,
    );
  }

  function cancelCompensationApply(): void {
    if (compensationApplyStatus?.operation === "restore") {
      compensationRestoreCancelledRef.current = true;
    }
    setCompensationApplyStatus((current) => current
      ? { ...current, phase: "cancelling" }
      : current);
    hostCompensationAbortRef.current?.abort();
    compensationManagerRef.current!.cancelApply("Cancelled by the user.");
  }

  function changeCompensationWorkerCount(requested: number): void {
    const next = Math.max(1, Math.min(compensationWorkerLimit, Math.round(requested)));
    try {
      compensationManagerRef.current!.setApplyWorkerPoolSize(next);
      setCompensationWorkerCount(next);
      try {
        globalThis.localStorage?.setItem(COMPENSATION_WORKER_STORAGE_KEY, String(next));
      } catch {
        // The in-memory choice still works when browser storage is unavailable.
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const previewCompensationCandidate = useCallback<CompensationCandidatePreviewSolver>(async (
    profile,
    fixedEventIndices,
    candidateMatrix,
  ) => {
    const targetSample = sample;
    if (!targetSample) throw new Error("No active sample is available for a compensation preview.");
    const manager = compensationManagerRef.current!;
    if (manager.applyInProgress || compensationApplyGuardRef.current) {
      throw new Error("Wait for the current compensation Apply to finish before previewing an edit.");
    }
    let eventChecksum = 2166136261;
    for (const event of fixedEventIndices) {
      eventChecksum ^= event;
      eventChecksum = Math.imul(eventChecksum, 16777619) >>> 0;
    }
    const key = [
      profile.profileHash,
      targetSample.dataRevision,
      targetSample.layerRevision,
      targetSample.displayTransformContextKey,
      fixedEventIndices.length,
      fixedEventIndices[0] ?? "empty",
      fixedEventIndices[fixedEventIndices.length - 1] ?? "empty",
      eventChecksum.toString(16),
    ].join(":");

    let session = compensationCandidatePreviewSessionRef.current;
    if (session?.key !== key) {
      let pending = compensationCandidatePreviewPrimeRef.current;
      if (pending?.key !== key) {
        cancelCompensationCandidatePreview("The flow compensation preview context changed.");
        pending = Object.freeze({
          key,
          promise: manager.primePreview({
            profile,
            sample: targetSample,
            fixedEventIndices,
          }),
        });
        compensationCandidatePreviewPrimeRef.current = pending;
      }
      try {
        const primed = await pending.promise;
        if (compensationCandidatePreviewPrimeRef.current !== pending) {
          throw new CompensationCancelledError("A newer flow compensation preview was requested.");
        }
        session = Object.freeze({ key, sessionId: primed.sessionId });
        compensationCandidatePreviewSessionRef.current = session;
        compensationCandidatePreviewPrimeRef.current = null;
      } catch (cause) {
        if (compensationCandidatePreviewPrimeRef.current === pending) {
          compensationCandidatePreviewPrimeRef.current = null;
        }
        throw cause;
      }
    }
    if (!session || session.key !== key) {
      throw new CompensationCancelledError("The flow compensation preview session is no longer current.");
    }
    return manager.solvePreview(session.sessionId, candidateMatrix);
  }, [cancelCompensationCandidatePreview, sample]);

  const solveCompensationSweep = useCallback<CompensationSweepSolver>(async (
    profile,
    fixedEventIndices,
    candidateMatrices,
    onProgress,
    requestedWorkerCount = 1,
  ) => {
    const targetSample = sample;
    if (!targetSample) throw new Error("No active sample is available for a compensation sweep.");
    if (compensationManagerRef.current!.applyInProgress || compensationApplyGuardRef.current) {
      throw new Error("Wait for the current compensation Apply to finish before starting a sweep.");
    }
    cancelCompensationSweepManagers("A newer coefficient sweep started.");
    if (candidateMatrices.length === 0) return Object.freeze([]);
    const workerCount = Math.max(1, Math.min(4, candidateMatrices.length, Math.round(requestedWorkerCount) || 1));
    const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const managers = Array.from({ length: workerCount }, (_, index) => new CompensationManager({
      workspaceKey: `${workspaceIdRef.current}:sweep:${runId}:${index}`,
    }));
    compensationSweepManagersRef.current = managers;
    const solved = new Array<Awaited<ReturnType<CompensationManager["solvePreview"]>>>(candidateMatrices.length);
    let completed = 0;
    try {
      onProgress?.(0, candidateMatrices.length);
      const primed = await Promise.all(managers.map((manager) => manager.primePreview({
        profile,
        sample: targetSample,
        fixedEventIndices,
      })));
      await Promise.all(managers.map(async (manager, lane) => {
        for (let index = lane; index < candidateMatrices.length; index += workerCount) {
          solved[index] = await manager.solvePreview(primed[lane].sessionId, candidateMatrices[index]);
          completed++;
          onProgress?.(completed, candidateMatrices.length);
        }
      }));
      return Object.freeze(solved);
    } finally {
      if (compensationSweepManagersRef.current === managers) {
        compensationSweepManagersRef.current = [];
      }
      for (const manager of managers) manager.dispose();
    }
  }, [cancelCompensationSweepManagers, sample]);

  const cancelCompensationSweep = useCallback(() => {
    cancelCompensationSweepManagers("Cancelled by the user.");
  }, [cancelCompensationSweepManagers]);

  // Force the active sample's instrument mode (recovery for a mis-detect). Rebuilds the
  // display/gating transforms, so ranges + the derived masks re-derive (instrumentMode is a
  // dep of both the recompute and the payload memo below).
  function changeInstrumentMode(mode: "auto" | "flow" | "cytof") {
    if (!sample) return;
    sample.setInstrumentMode(mode);
    setInstrumentMode(mode);
    setXRange(null);
    setYRange(null);
  }

  const saveIllustrationPreset = (name: string) => {
    const config = illustConfigRef.current;
    if (!config) return;
    setIllustrationPresets((prev) => [...prev.filter((p) => p.name !== name), { name, config }]);
    markWorkspaceDirty();
  };
  const deleteIllustrationPreset = (name: string) => {
    setIllustrationPresets((prev) => prev.filter((p) => p.name !== name));
    markWorkspaceDirty();
  };
  // Display scales are owned by the workspace, never by one file. Sample reads its logicle W
  // and scatter scale from here, so every file drawn together shares one transform per channel
  // -- including files loaded after the setting was made, which no fan-out over the existing
  // samples could reach. It also unifies the AUTO estimate: each file estimates W from its own
  // data (0.500 vs 1.143 on one real channel), so a pooled workspace used to open already split
  // before the user touched a control.
  const channelScales = useRef(new ChannelScales()).current;
  const attachedScales = useRef(new Map<Sample, () => void>());

  useEffect(() => channelScales.onChange(() => setScalesVersion((version) => version + 1)),
    [channelScales]);

  // Attach only what is new and detach only what is gone: registering churns the roster
  // generation, which every sample folds into its display-transform identity.
  useEffect(() => {
    const live = new Set(samples.map((entry) => entry.sample));
    for (const [sample, detach] of attachedScales.current) {
      if (!live.has(sample)) {
        detach();
        attachedScales.current.delete(sample);
      }
    }
    for (const sample of live) {
      if (!attachedScales.current.has(sample)) {
        attachedScales.current.set(sample, sample.attachChannelScales(channelScales));
      }
    }
  }, [samples, channelScales]);

  // The W slider is continuous, and one commit re-transforms every event of every file drawn.
  // Measured on a real four-file workspace (104,515 events) that costs ~14ms, inside a 60fps
  // frame, so the drag can follow the pointer -- a fixed debounce made it lurch for no reason.
  //
  // Commits coalesce onto an animation frame, which self-throttles: the browser will not
  // schedule the next frame until this one's work is done, so a workspace large enough to
  // exceed the budget simply commits less often instead of queueing up behind the pointer.
  // Only the latest value matters, so intermediate ticks are dropped rather than replayed.
  const [pendingLogicleW, setPendingLogicleW] = useState<Record<string, number>>({});
  const logicleWJob = useRef<{ idx: number; w: number; key: string } | null>(null);
  const logicleWFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (logicleWFrame.current !== null) cancelAnimationFrame(logicleWFrame.current);
  }, []);

  const commitLogicleW = (idx: number, w: number) => {
    const key = sample?.channels[idx]?.key;
    if (!key) return;
    logicleWJob.current = { idx, w, key };
    setPendingLogicleW((prev) => ({ ...prev, [key]: w })); // echo the drag immediately
    if (logicleWFrame.current !== null) return;
    logicleWFrame.current = requestAnimationFrame(() => {
      logicleWFrame.current = null;
      const job = logicleWJob.current;
      logicleWJob.current = null;
      if (!job || !sample) return;
      sample.setLogicleW(job.idx, job.w);
      bumpScales();
      setPendingLogicleW((prev) => {
        const next = { ...prev };
        delete next[job.key];
        return next;
      });
    });
  };

  const setGlobalScale = (key: string, range: [number, number] | null) => {
    setGlobalScales((prev) => {
      const next = { ...prev };
      if (range) next[key] = range;
      else delete next[key];
      return next;
    });
  };

  // Panel tab: rename a channel's display label. Applies to every loaded sample that has the
  // channel (matched by identity `key`) so the shared gate tree stays consistent. Labels are
  // cosmetic — gates/masks/workspace key off `key`, never the label — so this can't break a gate.
  const renameChannels = (changes: readonly { key: string; label: string }[]) => {
    let changed = false;
    for (const e of samples) {
      for (const { key, label } of changes) {
        const i = e.sample.index(key);
        if (i !== undefined) {
          const before = e.sample.channelLabel(i);
          e.sample.setChannelLabel(i, label);
          if (e.sample.channelLabel(i) !== before) changed = true;
        }
      }
    }
    if (changed) {
      setPanelVersion((v) => v + 1);
      markWorkspaceDirty();
    }
  };
  const renameChannel = (key: string, label: string) => renameChannels([{ key, label }]);
  const resetAllLabels = () => {
    let changed = false;
    for (const e of samples) {
      e.sample.channels.forEach((c, i) => {
        if (c.label) {
          e.sample.setChannelLabel(i, "");
          changed = true;
        }
      });
    }
    if (changed) {
      setPanelVersion((v) => v + 1);
      markWorkspaceDirty();
    }
  };

  async function writeHostedPanel(): Promise<void> {
    if (!isSceHost || !host.rowData || !hostDatasetDescriptor || !sample) {
      setError("This host cannot write panel labels into SCE rowData.");
      return;
    }
    setHostAdapterWriteBusy(true);
    setError(null);
    try {
      const result = await host.rowData.writeChannelLabels({
        contractVersion: GATELAB_HOST_ROWDATA_CONTRACT_VERSION,
        datasetId: hostDatasetDescriptor.id,
        expectedRevision: hostDatasetDescriptor.rowDataRevision ?? 0,
        changes: sample.channels.map((channel, index) => {
          const descriptor = hostDatasetDescriptor.channels.find(
            ({ id }) => id === channel.key,
          );
          const current = sample.channelLabel(index);
          const defaultLabel = descriptor?.pns?.trim() ||
            descriptor?.label.trim() ||
            channel.key;
          return {
            channelId: channel.key,
            label: current === channel.key ||
                (current === defaultLabel && !descriptor?.displayLabel)
              ? ""
              : current,
          };
        }),
      });
      setHostDatasetDescriptor((current) => current
        ? { ...current, rowDataRevision: result.revision }
        : current);
      setImportMsg(
        `Saved ${result.changedChannelIds.length} panel label` +
          `${result.changedChannelIds.length === 1 ? "" : "s"} to SCE rowData.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHostAdapterWriteBusy(false);
    }
  }

  // ── Metadata (Metadata tab) ──────────────────────────────────────────────────
  const setMetadataCell = (sampleId: string, field: string, value: string) => {
    setMetadata((m) => ({ ...m, [sampleId]: { ...(m[sampleId] ?? {}), [field]: value } }));
    markWorkspaceDirty();
  };
  const addMetadataColumn = (name: string) => {
    setMetadataColumns((cols) => {
      let n = name.trim() || "field";
      const taken = new Set(cols.map((c) => c.name));
      if (taken.has(n)) { let i = 2; while (taken.has(`${n}${i}`)) i++; n = `${n}${i}`; }
      return [...cols, { name: n }];
    });
    markWorkspaceDirty();
  };
  const renameMetadataColumn = (oldName: string, newName: string) => {
    const nn = newName.trim();
    if (!nn || metadataColumns.some((c) => c.name === nn)) return;
    setMetadataColumns((cols) => cols.map((c) => (c.name === oldName ? { ...c, name: nn } : c)));
    setMetadata((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [sid, row] of Object.entries(m)) {
        const { [oldName]: v, ...rest } = row;
        out[sid] = v !== undefined ? { ...rest, [nn]: v } : rest;
      }
      return out;
    });
    markWorkspaceDirty();
  };
  const deleteMetadataColumn = (name: string) => {
    setMetadataColumns((cols) => cols.filter((c) => c.name !== name));
    setMetadata((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [sid, row] of Object.entries(m)) {
        const { [name]: _drop, ...rest } = row;
        out[sid] = rest;
      }
      return out;
    });
    markWorkspaceDirty();
  };
  const importMetadata = async (file: File) => {
    try {
      const parsed = parseMetadataTable(await file.text());
      const nextMeta: Record<string, Record<string, string>> = { ...metadata };
      let matched = 0;
      const unmatched: string[] = [];
      for (const e of samples) {
        const row = lookupMetadataRow(parsed, e.name);
        if (row) { nextMeta[e.id] = { ...(nextMeta[e.id] ?? {}), ...row }; matched++; }
      }
      for (const fn of Object.keys(parsed.byFileName)) {
        if (!samples.some((e) => lookupMetadataRow({ ...parsed, byFileName: { [fn]: parsed.byFileName[fn] } }, e.name))) unmatched.push(fn);
      }
      // Union the imported columns into the ordered column list.
      setMetadataColumns((cols) => {
        const have = new Set(cols.map((c) => c.name));
        return [...cols, ...parsed.columns.filter((c) => !have.has(c)).map((name) => ({ name }))];
      });
      pendingCheckpointReasonRef.current = "after-metadata-import";
      setMetadata(nextMeta);
      markWorkspaceDirty();
      setImportMsg(
        `Metadata: ${matched}/${samples.length} sample${samples.length === 1 ? "" : "s"} matched` +
          (unmatched.length ? ` · unmatched rows: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "…" : ""}` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Population metadata handlers (2nd Metadata table) — mirror the sample ones but keyed by population_id.
  const setPopMetaCell = (popId: string, field: string, value: string) => {
    setPopulationMetadata((m) => ({ ...m, [popId]: { ...(m[popId] ?? {}), [field]: value } }));
    markWorkspaceDirty();
  };
  const addPopMetaColumn = (name: string) => {
    setPopulationMetaColumns((cols) => {
      let n = name.trim() || "field";
      const taken = new Set(cols.map((c) => c.name));
      if (taken.has(n)) { let i = 2; while (taken.has(`${n}${i}`)) i++; n = `${n}${i}`; }
      return [...cols, { name: n }];
    });
    markWorkspaceDirty();
  };
  const renamePopMetaColumn = (oldName: string, newName: string) => {
    const nn = newName.trim();
    if (!nn || populationMetaColumns.some((c) => c.name === nn)) return;
    setPopulationMetaColumns((cols) => cols.map((c) => (c.name === oldName ? { ...c, name: nn } : c)));
    setPopulationMetadata((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [pid, row] of Object.entries(m)) {
        const { [oldName]: v, ...rest } = row;
        out[pid] = v !== undefined ? { ...rest, [nn]: v } : rest;
      }
      return out;
    });
    markWorkspaceDirty();
  };
  const deletePopMetaColumn = (name: string) => {
    setPopulationMetaColumns((cols) => cols.filter((c) => c.name !== name));
    setPopulationMetadata((m) => {
      const out: Record<string, Record<string, string>> = {};
      for (const [pid, row] of Object.entries(m)) {
        const { [name]: _drop, ...rest } = row;
        out[pid] = rest;
      }
      return out;
    });
    markWorkspaceDirty();
  };

  const applyDivision = (profile: DivisionProfile) => {
    if (!activeSampleId) return;
    setDivisionProfiles((m) => ({ ...m, [activeSampleId]: profile }));
    markWorkspaceDirty();
    setImportMsg(`Division applied to ${fileName}: ${profile.n} boundaries on ${profile.channelKey} → ${profile.colName}`);
  };

  async function writeHostedDivisions(profile: DivisionProfile): Promise<void> {
    if (!isSceHost || !host.colData || !activeSampleId) {
      setError("This host cannot write division calls into SCE colData.");
      return;
    }
    const datasetId = samples[0]?.hostSource?.datasetId;
    if (!datasetId) {
      setError("The SCE dataset identity is unavailable.");
      return;
    }
    const columnName = profile.colName.trim() || "div";
    const collision = hostColDataColumns.includes(columnName);
    if (collision && !window.confirm(
      `SCE colData already contains '${columnName}'. Replace that column with the current division calls?`,
    )) return;

    const profiles = { ...divisionProfiles, [activeSampleId]: profile };
    const eligibleProfiles = samples.map((entry) => {
      const candidate = profiles[entry.id];
      if (!candidate || candidate.colName !== columnName) return null;
      try {
        return candidate.coordinateBindingKey ===
            entry.sample.displayCoordinateBindingKey(candidate.channelKey)
          ? candidate
          : null;
      } catch {
        return null;
      }
    });
    const maximumDivision = Math.max(
      profile.n,
      ...eligibleProfiles.flatMap((candidate) => candidate ? [candidate.n] : []),
    );
    if (maximumDivision >= 255) {
      setError("Division annotations cannot contain more than 254 levels.");
      return;
    }

    setHostAdapterWriteBusy(true);
    setError(null);
    try {
      applyDivision(profile);
      const levels = Array.from(
        { length: maximumDivision + 1 },
        (_, index) => `Div${index}`,
      );
      const sampleValues = samples.map((entry, sampleIndex) => {
        const source = entry.hostSource;
        if (!source || source.datasetId !== datasetId) {
          throw new Error(`Sample '${entry.name}' is not mapped to this SCE.`);
        }
        const candidate = eligibleProfiles[sampleIndex];
        if (!candidate) {
          return {
            sampleId: source.sampleId,
            eventCount: source.eventIndex.length,
            constantCode: 255,
          };
        }
        const channelIndex = entry.sample.index(candidate.channelKey);
        if (channelIndex === undefined) {
          throw new Error(
            `Division channel '${candidate.channelKey}' is unavailable in '${entry.name}'.`,
          );
        }
        const values = entry.sample.displayColumn(channelIndex);
        const codes = new Uint8Array(values.length);
        for (let index = 0; index < values.length; index += 1) {
          codes[index] = assignDivisionLevel(values[index], candidate.boundaries);
        }
        return {
          sampleId: source.sampleId,
          eventCount: codes.length,
          codesBase64: encodeUint8Base64(codes),
        };
      });
      const result = await host.colData.writeCategoricalColumns({
        contractVersion: GATELAB_HOST_COLDATA_CONTRACT_VERSION,
        datasetId,
        overwrite: collision,
        columns: [{ columnName, levels, sampleValues }],
      });
      setHostColDataColumns((current) => [...new Set([...current, columnName])]);
      const written = result.columns[0];
      setImportMsg(
        `Wrote division calls to SCE colData '${columnName}'` +
          (written?.missingCount
            ? ` · ${written.missingCount.toLocaleString()} events had no compatible profile`
            : ""),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHostAdapterWriteBusy(false);
    }
  }

  async function writeHostedSampleMetadata(): Promise<void> {
    if (!isSceHost || !host.colData) {
      setError("This host cannot write sample metadata into SCE colData.");
      return;
    }
    const datasetId = samples[0]?.hostSource?.datasetId;
    if (!datasetId || metadataColumns.length === 0) return;
    const columnNames = metadataColumns.map(({ name }) => name);
    const collisions = columnNames.filter((name) => hostColDataColumns.includes(name));
    if (collisions.length > 0 && !window.confirm(
      `Replace ${collisions.length} existing SCE colData column` +
        `${collisions.length === 1 ? "" : "s"}: ${collisions.join(", ")}?`,
    )) return;

    setHostAdapterWriteBusy(true);
    setError(null);
    try {
      const columns: GateLabHostCategoricalColumn[] = metadataColumns.map(({ name }) => {
        const values = samples.map((entry) => metadata[entry.id]?.[name] ?? "");
        const levels = [...new Set(values.filter((value) => value.length > 0))];
        if (levels.length >= 255) {
          throw new Error(`Metadata column '${name}' has more than 254 levels.`);
        }
        return {
          columnName: name,
          levels,
          sampleValues: samples.map((entry, index) => {
            const source = entry.hostSource;
            if (!source || source.datasetId !== datasetId) {
              throw new Error(`Sample '${entry.name}' is not mapped to this SCE.`);
            }
            const value = values[index];
            return {
              sampleId: source.sampleId,
              eventCount: source.eventIndex.length,
              constantCode: value.length > 0 ? levels.indexOf(value) : 255,
            };
          }),
        };
      });
      const result = await host.colData.writeCategoricalColumns({
        contractVersion: GATELAB_HOST_COLDATA_CONTRACT_VERSION,
        datasetId,
        overwrite: collisions.length > 0,
        columns,
      });
      setHostColDataColumns((current) => [
        ...new Set([...current, ...result.columns.map(({ columnName }) => columnName)]),
      ]);
      setImportMsg(
        `Wrote ${result.columns.length} sample metadata column` +
          `${result.columns.length === 1 ? "" : "s"} to SCE colData.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHostAdapterWriteBusy(false);
    }
  }

  // Preferred channel indices for a sample — keep the current channels (by key) if it has them.
  function channelsFor(s: Sample): [number, number] {
    const [dx, dy] = s.defaultChannelIndices();
    const cx = sample?.channels[xIdx]?.key;
    const cy = sample?.channels[yIdx]?.key;
    return [(cx !== undefined ? s.index(cx) : undefined) ?? dx, (cy !== undefined ? s.index(cy) : undefined) ?? dy];
  }

  function createEntry(
    bytes: Uint8Array,
    name: string,
    handle: FileSystemFileHandle | null,
    sourcePath?: string,
    persistedId?: string,
  ): SampleEntry {
    // Workspace/FCS readers normally return an exact-owned ArrayBuffer. parseFcs is read-only, so
    // reuse it instead of briefly duplicating a potentially multi-GB source file during import.
    const ab = bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    return {
      id: persistedId ?? crypto.randomUUID(),
      name,
      sample: new Sample(parseFcs(ab)),
      bytes,
      handle,
      ...(sourcePath ? { sourcePath } : {}),
    };
  }

  // Append a parsed batch atomically. This avoids treating every member of a multi-file
  // import as a separate first sample while React state updates are still queued.
  function addSampleEntries(entries: readonly SampleEntry[]): void {
    if (entries.length === 0) return;
    if (samples.length === 0) {
      setWorkspaceId(makeWorkspaceId());
      setScaleCacheEpoch((epoch) => epoch + 1);
      setGlobalScales({});
      channelScales.clear();
      autoFittedScales.current.clear();
      fittedAxisPairs.current.clear();
      setWsHandle(null);
      setWsName("");
      setWsStorage("reference");
    }
    pendingCheckpointReasonRef.current = "after-fcs-import";
    skipDirtyRef.current = true;
    const activeEntry = entries[entries.length - 1];
    const [nx, ny] = channelsFor(activeEntry.sample);
    setSamples((prev) => [...prev, ...entries]);
    setActiveSampleId(activeEntry.id);
    setXIdx(nx);
    setYIdx(ny);
    setXRange(null);
    setYRange(null);
    setInstrumentMode(activeEntry.sample.instrumentMode); // fresh sample → "auto"
    if (state.root_population_id === null) {
      dispatch({ type: "loadSample", nEvents: entries[0].sample.fcs.nEvents });
    }
    for (const entry of entries) {
      if (entry.handle) void rememberHandle("fcs:" + entry.name, entry.handle);
    }
    // Warn if an existing gate references a channel this sample lacks: getGateMask returns
    // an all-false mask (zero events) for such a gate, which would otherwise be a silent
    // zero on this sample — mirror R's validate_workspace_channels skip-and-warn.
    const warnings = entries.flatMap((entry) => {
      const chKeys = new Set(entry.sample.channelNames());
      const skipped = Object.values(state.gates)
        .filter((g) => !chKeys.has(g.x_channel) || !chKeys.has(g.y_channel))
        .map((g) => g.name);
      return skipped.length > 0 ? [`${entry.name}: ${skipped.join(", ")}`] : [];
    });
    if (warnings.length > 0) {
      setError(
        `${warnings.length} imported sample${warnings.length === 1 ? " is" : "s are"} missing channels used by existing gates: ` +
          `${warnings.join("; ")}. Those gates match no events in the affected samples.`,
      );
    }
  }

  const hostedDatasetLoadStartedRef = useRef(false);
  useEffect(() => {
    if (
      host.kind !== "r-sce" ||
      !host.datasets ||
      hostedDatasetLoadStartedRef.current
    ) return;
    hostedDatasetLoadStartedRef.current = true;
    const controller = new AbortController();
    setBusy(true);
    setImportMsg("Connecting to the SingleCellExperiment host…");

    void (async () => {
      try {
        const datasets = await host.datasets!.listDatasets();
        if (datasets.length === 0) {
          throw new Error("GateLabR did not provide a SingleCellExperiment dataset.");
        }
        const dataset = datasets[0];
        setHostDatasetDescriptor(dataset);
        const hostedSamples = await loadHostedDataset(
          host.datasets!,
          dataset,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (hostedSamples.length === 0) {
          throw new Error(`SingleCellExperiment '${dataset.label}' has no samples.`);
        }
        setHostColDataColumns(dataset.colDataColumns ?? []);
        setWorkspaceEditRevision(0);
        workspaceEditRevisionRef.current = 0;
        lastHostSavedEditRevisionRef.current = -1;
        const entries = hostedSamples.map((hosted): SampleEntry => ({
          id: `${hosted.datasetId}:${hosted.sampleId}`,
          name: hosted.name,
          sample: hosted.sample,
          bytes: null,
          handle: null,
          sourcePath: `SingleCellExperiment/${hosted.name}`,
          hostSource: {
            datasetId: hosted.datasetId,
            sampleId: hosted.sampleId,
            assayId: hosted.assayId,
            assayRevision: hosted.assayRevision,
            eventIndex: hosted.eventIndex,
          },
        }));
        addSampleEntries(entries);

        const hostedMetadata = Object.fromEntries(hostedSamples.map(
          (hosted: GateLabHostedSample, index) => [
            entries[index].id,
            Object.fromEntries(
              Object.entries(hosted.metadata)
                .filter(([, value]) => value !== null)
                .map(([field, value]) => [field, String(value)]),
            ),
          ],
        ));
        const metadataNames = [...new Set(
          hostedSamples.flatMap((hosted) => Object.keys(hosted.metadata)),
        )];
        setMetadata(hostedMetadata);
        setMetadataColumns(metadataNames.map((name) => ({ name })));
        let hostedStatus =
          `Loaded ${dataset.label} · ${hostedSamples.length} sample` +
          `${hostedSamples.length === 1 ? "" : "s"} · ` +
          `${dataset.eventCount.toLocaleString()} events from R`;

        const workspaceEnvelope = await host.workspaces?.readWorkspace(dataset.id) ?? null;
        const initialHostRevision = workspaceEnvelope?.revision ?? 0;
        setHostWorkspaceRevision(initialHostRevision);
        hostWorkspaceRevisionRef.current = initialHostRevision;
        setHostWorkspaceStatus(workspaceEnvelope ? "saved" : "unsaved");
        if (workspaceEnvelope) lastHostSavedEditRevisionRef.current = 0;
        if (workspaceEnvelope && !controller.signal.aborted) {
          try {
            const restored = await readHostedWorkspace(
              workspaceEnvelope,
              dataset,
              entries.map(({ sample: hostedSample }) => hostedSample),
            );
            const workspace = convertHostedGateSpace(
              restored.workspace,
              entries[0].sample,
              restored.sourceGateSpace,
            );
            const activeIdx = Math.min(
              Math.max(0, workspace.activeSample),
              entries.length - 1,
            );
            const active = entries[activeIdx].sample;
            const nextWorkspaceId = workspace.workspaceId ?? makeWorkspaceId();
            compensationManagerRef.current!.resetWorkspace(nextWorkspaceId);
            pendingCheckpointReasonRef.current = "after-workspace-open";
            skipDirtyRef.current = true;
            if (workspace.version === WORKSPACE_VERSION_3) {
              await restoreSavedWorkspaceCompensation(workspace, entries);
              setWorkspaceCompensation(workspace.compensation);
            } else {
              setWorkspaceCompensation(newEmptyWorkspaceCompensationState());
            }
            setActiveSampleId(entries[activeIdx].id);
            setPopulationMetadata(workspace.populationMetadata ?? {});
            setPopulationMetaColumns(workspace.populationMetaColumns ?? []);
            illustConfigRef.current = workspace.illustration ?? null;
            setIllustrationPresets(workspace.illustrationPresets ?? []);
            setIllustVersion((version) => version + 1);
            clearPersistedTabState();
            setScaleCacheEpoch((epoch) => epoch + 1);
            setGlobalScales(workspace.scales.globalScales ?? {});
            setInstrumentMode(active.instrumentMode);
            setMode(workspace.display.mode);
            setMaxEvents(workspace.display.maxEvents);
            setContourThreshold(workspace.display.contourThreshold);
            setDensityColorPower(
              normalizeDensityColorPower(workspace.display.densityColorPower),
            );
            setBranchGatesOnly(
              (workspace.display as { branchGatesOnly?: boolean }).branchGatesOnly !== false);
            setPointAlpha(restoredPointAlpha(workspace.display.pointAlpha));
            setPointSize(restoredPointSize(workspace.display.pointSize));
            setGatingFontSizes({
              ...DEFAULT_GATING_FONT_SIZES,
              ...workspace.display.fontSizes,
            });
            const [defaultX, defaultY] = active.defaultChannelIndices();
            pendingFitOnLoad.current = true;
            setXIdx(active.index(workspace.display.xChannel) ?? defaultX);
            setYIdx(active.index(workspace.display.yChannel) ?? defaultY);
            setXRange(null);
            setYRange(null);
            setWsHandle(null);
            setWsName(dataset.label);
            setWsStorage("reference");
            setWorkspaceId(nextWorkspaceId);
            setDirty(false);
            dispatch({
              type: "loadWorkspace",
              gates: workspace.gating.gates,
              gate_order: workspace.gating.gate_order,
              populations: workspace.gating.populations,
              root_population_id: workspace.gating.root_population_id,
              active_population_id: workspace.gating.active_population_id,
              selected_gate_id: workspace.gating.selected_gate_id,
            });
            hostedStatus =
              `Restored ${workspace.gating.gate_order.length} gate` +
              `${workspace.gating.gate_order.length === 1 ? "" : "s"} and ` +
              `${Object.keys(workspace.gating.populations).length} population` +
              `${Object.keys(workspace.gating.populations).length === 1 ? "" : "s"} ` +
              `from ${restored.sourceFormat === "gatelabr-legacy" ? "GateLabR" : "GateLab"} SCE metadata`;
          } catch (cause) {
            setError(
              "The SingleCellExperiment data loaded, but its saved GateLab workspace " +
                `could not be restored: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
          }
        }
        setImportMsg(hostedStatus);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setImportMsg(null);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    })();

    return () => controller.abort();
    // The host adapter is immutable for one mount; addSampleEntries intentionally
    // captures the empty initial workspace exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  function selectSample(id: string) {
    const entry = samples.find((s) => s.id === id);
    if (!entry || id === activeSampleId) return;
    skipDirtyRef.current = true;
    const [nx, ny] = channelsFor(entry.sample);
    setActiveSampleId(id);
    setXIdx(nx);
    setYIdx(ny);
    setInstrumentMode(entry.sample.instrumentMode);
  }

  function setSampleIncluded(id: string, included: boolean): void {
    setExcludedSampleIds((previous) => {
      const next = new Set(previous);
      if (included) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function includeAllSamples(): void {
    setExcludedSampleIds(new Set());
  }

  function includeNoSamples(): void {
    setExcludedSampleIds(new Set(samples.map((entry) => entry.id)));
  }

  function invertIncludedSamples(): void {
    setExcludedSampleIds((previous) => new Set(
      samples.filter((entry) => !previous.has(entry.id)).map((entry) => entry.id),
    ));
  }

  async function removeSamples(ids: readonly string[]) {
    if (ids.length === 0) return;
    const manager = compensationManagerRef.current!;
    const applyIsRunning = () => compensationApplyGuardRef.current || manager.applyInProgress;
    if (applyIsRunning()) {
      setError(t("Wait for the current compensation Apply to finish, or cancel it, before removing samples."));
      return;
    }
    await checkpointCurrentWorkspace("before-sample-remove");
    // Check again after the asynchronous checkpoint. An Apply may have been started while
    // IndexedDB was writing; sample membership must remain stable for its aggregate snapshot.
    if (applyIsRunning()) {
      setError(t("Wait for the current compensation Apply to finish, or cancel it, before removing samples."));
      return;
    }
    const removed = new Set(ids);
    for (const entry of samples) {
      if (removed.has(entry.id)) manager.invalidateSample(entry.sample);
    }
    const next = samples.filter((entry) => !removed.has(entry.id));
    const curX = sample?.channels[xIdx]?.key;
    const curY = sample?.channels[yIdx]?.key;
    setSamples(next);
    setExcludedSampleIds((previous) => new Set([...previous].filter((id) => !removed.has(id))));
    setMetadata((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))));
    setDivisionProfiles((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !removed.has(id))));
    if (activeSampleId !== null && removed.has(activeSampleId)) {
      skipDirtyRef.current = true;
      const na = next[0] ?? null;
      setActiveSampleId(na?.id ?? null);
      setInstrumentMode(na?.sample.instrumentMode ?? "auto");
      if (na) {
        const [dx, dy] = na.sample.defaultChannelIndices();
        setXIdx((curX !== undefined ? na.sample.index(curX) : undefined) ?? dx);
        setYIdx((curY !== undefined ? na.sample.index(curY) : undefined) ?? dy);
        setXRange(null);
        setYRange(null);
      }
    }
    setImportMsg(`Removed ${ids.length} sample${ids.length === 1 ? "" : "s"} from the workspace.`);
  }

  async function importFcsCandidates(candidates: readonly FcsImportCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    setBusy(true);
    setError(null);
    const entries: SampleEntry[] = [];
    const failures: string[] = [];
    try {
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        setSampleImportProgress({ current: index + 1, total: candidates.length, name: candidate.name });
        try {
          const bytes = new Uint8Array((await candidate.file.arrayBuffer()).slice(0));
          entries.push(createEntry(bytes, candidate.name, candidate.handle, candidate.sourcePath));
        } catch (cause) {
          failures.push(`${candidate.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        // Let progress paint and keep the browser responsive between synchronous FCS parses.
        if (index < candidates.length - 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      addSampleEntries(entries);
      if (entries.length > 0) {
        setImportMsg(`Added ${entries.length} FCS file${entries.length === 1 ? "" : "s"} to the workspace.`);
      }
      if (failures.length > 0) {
        setError(`${failures.length} FCS file${failures.length === 1 ? "" : "s"} could not be loaded: ${failures.join("; ")}`);
      }
    } finally {
      setSampleImportProgress(null);
      setBusy(false);
    }
  }

  // Open (add) one or more FCS files — native handles where supported, input fallback elsewhere.
  async function openFcs() {
    if (!supportsFileSystemAccess()) {
      fileRef.current?.click();
      return;
    }
    try {
      const picked = await pickFiles(FCS_FILE_ACCEPT, "FCS files", { id: "gatelab-open-fcs" });
      if (!picked || picked.length === 0) return;
      await importFcsCandidates(picked.map((source) => ({
        id: crypto.randomUUID(),
        name: source.name,
        file: source.file,
        handle: source.handle,
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function stageFolderImport(folderName: string, candidates: FcsImportCandidate[]): void {
    if (candidates.length === 0) {
      setError(`No .fcs files were found in ${folderName}.`);
      return;
    }
    setPendingFolderImport({ folderName, candidates });
  }

  async function openFcsFolder(): Promise<void> {
    if (!supportsDirectoryAccess()) {
      folderRef.current?.click();
      return;
    }
    setError(null);
    try {
      const picked = await pickDirectoryFiles([".fcs"], { id: "gatelab-open-fcs-folder" });
      if (!picked) return;
      stageFolderImport(picked.name, picked.files.map((source) => ({
        id: crypto.randomUUID(),
        name: source.name,
        file: source.file,
        handle: source.handle,
        sourcePath: `${picked.name}/${source.relativePath}`,
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const sampleDataPath = (name: string, i: number) =>
    `data/${i}_${(name || "sample.fcs").replace(/[^A-Za-z0-9._-]/g, "_")}`;

  function buildWorkspaceFile(): LiveWorkspaceFile | null {
    if (samples.length === 0 || !sample) return null;
    const legacy: WorkspaceFile = {
      format: "gatelab-workspace",
      version: 2,
      workspaceId,
      savedAt: new Date().toISOString(),
      app: "GateLab",
      samples: samples.map((e, i) => ({
        sampleId: e.id,
        fileName: e.name,
        dataPath: sampleDataPath(e.name, i),
        logicleW: e.sample.logicleWOverrides(),
        scatterCofactor: e.sample.scatterCofactorOverrides(),
        scatterLinear: e.sample.scatterLinearKeys(),
        cytofCofactor: e.sample.arcsinhCofactor,
        compensationOn: e.sample.compensationEnabled,
        instrumentMode: e.sample.instrumentMode,
        labels: e.sample.labelOverrides(),
        metadata: metadata[e.id] ?? {},
        division: divisionProfiles[e.id],
      })),
      activeSample: Math.max(0, samples.findIndex((e) => e.id === activeSampleId)),
      gating: {
        gates: state.gates,
        gate_order: state.gate_order,
        populations: state.populations,
        root_population_id: state.root_population_id,
        active_population_id: state.active_population_id,
        selected_gate_id: state.selected_gate_id,
      },
      scales: { globalScales },
      display: {
        pointAlpha,
        pointSize,
        xChannel: sample.channels[xIdx].key,
        yChannel: sample.channels[yIdx].key,
        mode,
        maxEvents,
        contourThreshold,
        densityColorPower,
        fontSizes: gatingFontSizes,
        branchGatesOnly,
      },
      illustration: illustConfigRef.current ?? undefined,
      illustrationPresets,
      metadataColumns,
      populationMetadata,
      populationMetaColumns,
    };
    const needsV3 = workspaceCompensation.lineages.length > 0 || samples.some(({ sample: candidate }) => {
      const status = candidate.compensatedLayerStatus();
      return status.state !== "missing" && status.metadata.runtimeIdentity === "profile";
    });
    if (!needsV3) return legacy;

    const knownProfiles = new Set(
      workspaceCompensation.lineages.flatMap(({ records }) => records.map(({ profileId }) => profileId)),
    );
    const samplesV3 = legacy.samples.map((legacySample, index) => {
      const runtimeSample = samples[index].sample;
      const status = runtimeSample.compensatedLayerStatus();
      let assay: SampleAssayBinding;
      if (status.state === "missing") {
        assay = {
          schema: SAMPLE_ASSAY_BINDING_SCHEMA,
          activeLayer: "original",
          compensatedLayer: null,
        };
      } else if (status.metadata.runtimeIdentity !== "profile") {
        throw new Error(
          "This workspace mixes an imported compensation profile with legacy embedded-FCS compensation. Switch the embedded layer to Original before saving.",
        );
      } else {
        if (status.state !== "ready") {
          throw new Error("A stale compensation profile cannot be saved as an available assay layer.");
        }
        if (!knownProfiles.has(status.metadata.profileId)) {
          throw new Error(`Compensation profile '${status.metadata.profileId}' is not stored in this workspace.`);
        }
        const { runtimeIdentity: _runtimeIdentity, ...persistedBinding } = status.metadata;
        assay = {
          schema: SAMPLE_ASSAY_BINDING_SCHEMA,
          activeLayer: runtimeSample.activeLayer,
          compensatedLayer: persistedBinding,
        };
      }
      const { compensationOn: _legacyCompensationOn, ...common } = legacySample;
      return { ...common, assay };
    });
    const { version: _legacyVersion, samples: _legacySamples, ...common } = legacy;
    return {
      ...common,
      version: WORKSPACE_VERSION_3,
      samples: samplesV3,
      compensation: workspaceCompensation,
    };
  }
  buildWsRef.current = buildWorkspaceFile; // keep the autosave builder fresh each render

  function saveHostedWorkspace(
    reason: "autosave" | "explicit",
    clientRevision = workspaceEditRevisionRef.current,
  ): Promise<GateLabHostWorkspaceWriteResult> {
    const run = hostSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isSceHost || !host.workspaces) {
          throw new Error("This GateLab host cannot save changes into an SCE.");
        }
        if (
          reason === "autosave" &&
          lastHostSavedEditRevisionRef.current >= clientRevision &&
          lastHostSaveResultRef.current
        ) {
          return lastHostSaveResultRef.current;
        }
        const ws = buildWsRef.current();
        const datasetId = samples[0]?.hostSource?.datasetId;
        if (!ws || !datasetId) {
          throw new Error("The hosted SCE workspace is not ready to save.");
        }
        setHostWorkspaceStatus("saving");
        const result = await host.workspaces.writeWorkspace({
          datasetId,
          expectedRevision: hostWorkspaceRevisionRef.current,
          clientRevision,
          reason,
          workspaceJson: JSON.stringify(ws),
        });
        hostWorkspaceRevisionRef.current = result.revision;
        setHostWorkspaceRevision(result.revision);
        lastHostSavedEditRevisionRef.current = Math.max(
          lastHostSavedEditRevisionRef.current,
          result.clientRevision,
        );
        lastHostSaveResultRef.current = result;
        if (workspaceEditRevisionRef.current === clientRevision) {
          setDirty(false);
          setHostWorkspaceStatus("saved");
        } else {
          setHostWorkspaceStatus("unsaved");
        }
        return result;
      })
      .catch((cause) => {
        setHostWorkspaceStatus("error");
        throw cause;
      });
    hostSaveChainRef.current = run.catch(() => undefined);
    return run;
  }

  useEffect(() => {
    if (!isSceHost || !dirty || !sample || !host.workspaces) return;
    setHostWorkspaceStatus("unsaved");
    const clientRevision = workspaceEditRevision;
    const timer = window.setTimeout(() => {
      void saveHostedWorkspace("autosave", clientRevision).catch((cause) => {
        setError(
          `SCE autosave failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      });
    }, 1200);
    return () => window.clearTimeout(timer);
    // The queued writer reads the current workspace builder and serializes writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, host.workspaces, isSceHost, sample, workspaceEditRevision]);

  const rememberAllHandles = async () => {
    await Promise.all(samples.flatMap((e) => e.handle ? [rememberHandle("fcs:" + e.name, e.handle)] : []));
  };
  function requireFcsBytes(entry: SampleEntry): Uint8Array {
    if (!entry.bytes) {
      throw new Error(
        `'${entry.name}' is owned by the R SingleCellExperiment host and has no source FCS bytes. ` +
        "Save changes back to the R object instead.",
      );
    }
    return entry.bytes;
  }
  function currentFcsByPath(ws: LiveWorkspaceFile): Record<string, Uint8Array> {
    return Object.fromEntries(ws.samples.map((wss, i) => {
      const entry = samples[i];
      if (!entry) throw new Error(`The loaded data for ${wss.fileName} is unavailable.`);
      return [wss.dataPath, requireFcsBytes(entry)];
    }));
  }
  function currentPortableSources(ws: WorkspaceFileV3) {
    return ws.samples.map((workspaceSample, index) => {
      const entry = samples[index];
      if (!entry) throw new Error(`The loaded data for ${workspaceSample.fileName} is unavailable.`);
      return Object.freeze({
        dataPath: workspaceSample.dataPath,
        fcsBytes: requireFcsBytes(entry),
        sample: entry.sample,
      });
    });
  }
  function packReferenceWorkspace(ws: LiveWorkspaceFile): Uint8Array {
    return ws.version === WORKSPACE_VERSION_3
      ? packWorkspaceV3Reference(ws)
      : packWorkspaceReference(ws);
  }
  function bundleGatingML(): string | undefined {
    if (!sample || !state.root_population_id || Object.keys(state.gates).length === 0) return undefined;
    try {
      return exportGatingML({
        gates: state.gates,
        gate_order: state.gate_order,
        populations: state.populations,
        root_population_id: state.root_population_id,
        sample,
        globalScales,
        format: "standard",
        allowQuadrantOmission: true, // the bundled workspace itself still preserves quadrants in full
      });
    } catch {
      return undefined;
    }
  }
  async function preparePortableBundle(ws: WorkspaceFileV3) {
    setImportMsg("Preparing portable workspace · hashing source data");
    return createPortableWorkspaceV3ArchivePlan(
      ws,
      currentPortableSources(ws),
      bundleGatingML(),
      {
        onProgress: ({ phase, processedBytes, totalBytes }) => {
          const percent = totalBytes === 0 ? 100 : Math.round(processedBytes / totalBytes * 100);
          setImportMsg(
            `Preparing portable workspace · ${phase === "hashing-fcs" ? "source FCS" : "compensated assay"} · ${percent}%`,
          );
        },
      },
    );
  }

  // Save in place without changing the current workspace's bundle/reference storage mode.
  // If no writable workspace handle exists, fall back to Save As.
  async function saveWorkspace() {
    const ws = buildWorkspaceFile();
    if (!ws) return;
    setBusy(true);
    try {
      if (supportsFileSystemAccess() && wsHandle) {
        if (wsStorage === "bundle" && ws.version === WORKSPACE_VERSION_3) {
          const plan = await preparePortableBundle(ws);
          await writeHandleStream(wsHandle, async (write) => {
            await writePortableWorkspaceV3Archive(plan, write, {
              onProgress: ({ writtenPayloadBytes, totalPayloadBytes }) => {
                const percent = totalPayloadBytes === 0
                  ? 100
                  : Math.round(writtenPayloadBytes / totalPayloadBytes * 100);
                setImportMsg(`Saving portable workspace · ${percent}%`);
              },
            });
          });
        } else {
          const data = ws.version === WORKSPACE_VERSION_3
            ? packWorkspaceV3Reference(ws)
            : packWorkspaceForStorage(ws, currentFcsByPath(ws), wsStorage, bundleGatingML());
          await writeHandle(wsHandle, data as BlobPart);
        }
        await rememberAllHandles();
        setDirty(false);
        setImportMsg(`Saved ${wsStorage === "bundle" ? "bundle" : "workspace"} · ${wsName}`);
      } else {
        await saveWorkspaceAs();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkspaceAs() {
    const ws = buildWorkspaceFile();
    if (!ws) return;
    const base = sanitizeFilePart((fileName || "workspace").replace(/\.[^.]+$/, ""));
    try {
      const data = packReferenceWorkspace(ws);
      if (supportsFileSystemAccess()) {
        const h = await saveAsHandle(
          `${base}.${WORKSPACE_EXT}`,
          { "application/octet-stream": [`.${WORKSPACE_EXT}`] },
          "GateLab workspace",
          data as BlobPart,
        );
        if (h) {
          const f = await h.getFile();
          setWsHandle(h);
          setWsName(f.name);
          setWsStorage("reference");
          await rememberAllHandles();
          setDirty(false);
          setImportMsg(`Saved · ${f.name}`);
        }
      } else {
        downloadBlob(`${base}.${WORKSPACE_EXT}`, new Blob([data as BlobPart], { type: "application/json" }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Self-contained copy (zip with every sample's FCS bundled) — for sharing / archiving.
  async function saveBundledCopy() {
    const ws = buildWorkspaceFile();
    if (!ws) return;
    const base = sanitizeFilePart((fileName || "workspace").replace(/\.[^.]+$/, ""));
    setBusy(true);
    try {
      if (ws.version === WORKSPACE_VERSION_3) {
        const plan = await preparePortableBundle(ws);
        const progress = ({ writtenPayloadBytes, totalPayloadBytes }: {
          writtenPayloadBytes: number;
          totalPayloadBytes: number;
        }) => {
          const percent = totalPayloadBytes === 0
            ? 100
            : Math.round(writtenPayloadBytes / totalPayloadBytes * 100);
          setImportMsg(`Saving portable workspace · ${percent}%`);
        };
        if (supportsFileSystemAccess()) {
          const handle = await saveAsHandleStream(
            `${base}-bundle.${WORKSPACE_EXT}`,
            { "application/zip": [`.${WORKSPACE_EXT}`] },
            "GateLab workspace (self-contained)",
            async (write) => writePortableWorkspaceV3Archive(plan, write, { onProgress: progress }),
          );
          if (!handle) return;
        } else {
          const parts: BlobPart[] = [];
          await writePortableWorkspaceV3Archive(plan, async (chunk) => {
            parts.push(chunk as BlobPart);
          }, { onProgress: progress });
          downloadBlob(
            `${base}-bundle.${WORKSPACE_EXT}`,
            new Blob(parts, { type: "application/zip" }),
          );
        }
      } else {
        const zip = packWorkspace(ws, currentFcsByPath(ws), bundleGatingML());
        if (supportsFileSystemAccess()) {
          const handle = await saveAsHandle(
            `${base}-bundle.${WORKSPACE_EXT}`,
            { "application/zip": [`.${WORKSPACE_EXT}`] },
            "GateLab workspace (self-contained)",
            zip as BlobPart,
          );
          if (!handle) return;
        } else {
          downloadBlob(`${base}-bundle.${WORKSPACE_EXT}`, new Blob([zip as BlobPart], { type: "application/zip" }));
        }
      }
      setImportMsg(
        `Saved portable bundle · ${base}-bundle.${WORKSPACE_EXT}` +
          (ws.version === WORKSPACE_VERSION_3 && ws.samples.some(({ assay }) => assay.compensatedLayer !== null)
            ? " · compensated assays embedded"
            : ""),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Open workspace — FS picker (keeps a handle for in-place Save), or the input fallback.
  async function openWorkspace() {
    if (!supportsFileSystemAccess()) {
      wsRef.current?.click();
      return;
    }
    try {
      // A .gatelab file can contain either JSON or ZIP data. macOS has no registered
      // content type for the custom extension, and assigning it both MIME types makes
      // Chromium's native filter intermittently disable valid files on first open.
      // Leave this picker unfiltered and let the streaming workspace parser validate it.
      const picked = await pickFileSource(null, "GateLab workspace", { id: "gatelab-open-workspace" });
      if (picked) await openWorkspaceFromFile(picked.file, picked.handle, picked.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Resolve a reference-workspace sample without prompting: an already-open sample of the
  // same name → a remembered handle. All unresolved names are handled together below.
  async function resolveKnownReferenceFcs(fileName: string): Promise<ResolvedReferenceFcs | null> {
    const existing = samples.find((e) => e.name === fileName);
    if (existing?.bytes) {
      return {
        bytes: existing.bytes,
        handle: existing.handle,
        ...(existing.sourcePath ? { sourcePath: existing.sourcePath } : {}),
      };
    }
    const h = await recallHandle("fcs:" + fileName);
    const read = h ? await readFromHandleIfPermitted(h) : null;
    if (
      read &&
      read.name.normalize("NFC").toLocaleLowerCase() ===
        fileName.normalize("NFC").toLocaleLowerCase()
    ) {
      return { bytes: read.bytes, handle: h };
    }
    return null;
  }

  async function resolveReferenceFcsFolder(
    requirements: readonly WorkspaceFcsRequirement[],
    workspaceHandle: FileSystemFileHandle | null,
  ): Promise<ReadonlyMap<string, ResolvedReferenceFcs> | null> {
    if (requirements.length === 0) return new Map();

    setImportMsg(
      `Linked FCS files unavailable · choose the folder containing all ${requirements.length} required file` +
        `${requirements.length === 1 ? "" : "s"}`,
    );

    let sourceName: string;
    let sources: PickedFileSource[];
    if (supportsDirectoryAccess()) {
      const picked = await pickDirectoryFiles([".fcs"], {
        id: "gatelab-relink-fcs-folder",
        ...(workspaceHandle ? { startIn: workspaceHandle } : {}),
      });
      if (!picked) return null;
      sourceName = picked.name;
      sources = picked.files;
    } else if (supportsFileSystemAccess()) {
      setImportMsg(
        `Select all ${requirements.length} required FCS file${requirements.length === 1 ? "" : "s"} together`,
      );
      const picked = await pickFiles(
        FCS_FILE_ACCEPT,
        "FCS files required by this workspace",
        { id: "gatelab-relink-fcs-batch" },
      );
      if (!picked) return null;
      sourceName = "selected files";
      sources = picked;
    } else {
      throw new Error(
        "This browser cannot select a folder for linked FCS recovery. Open GateLab in a Chromium-based browser or use a portable workspace.",
      );
    }

    const plan = planWorkspaceFcsRelink(requirements, sources);
    if (plan.missing.length > 0 || plan.ambiguous.length > 0) {
      const details: string[] = [];
      if (plan.missing.length > 0) {
        details.push(`Missing: ${plan.missing.map(({ fileName }) => fileName).join(", ")}`);
      }
      if (plan.ambiguous.length > 0) {
        details.push(
          "Ambiguous: " +
            plan.ambiguous.map(({ requirement, candidates }) =>
              `${requirement.fileName} (${candidates.length > 0
                ? candidates.map(({ relativePath }) => relativePath).join(" | ")
                : "duplicate workspace filename"})`
            ).join("; "),
        );
      }
      throw new Error(
        `The selected folder "${sourceName}" could not uniquely match every FCS file required by this workspace. ` +
          `${details.join(". ")}. No workspace data were changed.`,
      );
    }

    const resolved = new Map<string, ResolvedReferenceFcs>();
    for (let index = 0; index < requirements.length; index++) {
      const requirement = requirements[index];
      const source = plan.matches.get(requirement.dataPath)!;
      setImportMsg(
        `Relinking from ${sourceName} · ${index + 1} / ${requirements.length} · ${requirement.fileName}`,
      );
      const bytes = new Uint8Array(await source.file.arrayBuffer());
      resolved.set(requirement.dataPath, {
        bytes,
        handle: source.handle,
        sourcePath: sourceName === "selected files"
          ? source.relativePath
          : `${sourceName}/${source.relativePath}`,
      });
    }
    return resolved;
  }

  function requestReferenceFcsFolder(
    requirements: readonly WorkspaceFcsRequirement[],
    workspaceHandle: FileSystemFileHandle | null,
  ): Promise<ReadonlyMap<string, ResolvedReferenceFcs> | null> {
    if (workspaceRelinkResolverRef.current) {
      return Promise.reject(new Error("Another workspace relink request is already open."));
    }
    setImportMsg(
      `Linked FCS files unavailable · choose one folder for all ${requirements.length} required file` +
        `${requirements.length === 1 ? "" : "s"}`,
    );
    setWorkspaceRelinkError(null);
    setWorkspaceRelinkScanning(false);
    setPendingWorkspaceRelink({
      requirements: [...requirements],
      workspaceHandle,
    });
    return new Promise((resolve) => {
      workspaceRelinkResolverRef.current = resolve;
    });
  }

  function cancelPendingWorkspaceRelink(): void {
    const resolve = workspaceRelinkResolverRef.current;
    workspaceRelinkResolverRef.current = null;
    setPendingWorkspaceRelink(null);
    setWorkspaceRelinkError(null);
    setWorkspaceRelinkScanning(false);
    resolve?.(null);
  }

  async function choosePendingWorkspaceRelinkFolder(): Promise<void> {
    const pendingRelink = pendingWorkspaceRelink;
    if (!pendingRelink || workspaceRelinkScanning) return;
    setWorkspaceRelinkScanning(true);
    setWorkspaceRelinkError(null);
    try {
      // This call must begin directly inside the button gesture. Browsers reject a picker
      // launched later from the asynchronous workspace parser.
      const resolved = await resolveReferenceFcsFolder(
        pendingRelink.requirements,
        pendingRelink.workspaceHandle,
      );
      if (!resolved) return;
      const resolve = workspaceRelinkResolverRef.current;
      workspaceRelinkResolverRef.current = null;
      setPendingWorkspaceRelink(null);
      resolve?.(resolved);
    } catch (cause) {
      setWorkspaceRelinkError(cause instanceof Error ? cause.message : String(cause));
      setImportMsg("Selected FCS location was incomplete · choose another folder");
    } finally {
      setWorkspaceRelinkScanning(false);
    }
  }

  async function restoreSavedWorkspaceCompensation(
    ws: WorkspaceFileV3,
    entries: readonly SampleEntry[],
  ): Promise<void> {
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      throw new Error(t("Another compensation job is already running."));
    }
    const profiles = ws.compensation.lineages.flatMap(({ records }) => records);
    const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const tasks = ws.samples.flatMap((workspaceSample, index) => {
      const binding = workspaceSample.assay.compensatedLayer;
      if (binding === null) return [];
      const profile = profileById.get(binding.profileId);
      if (!profile) {
        throw new Error(t("Workspace compensation profile '{profile}' is missing.", { profile: binding.profileId }));
      }
      return [{ entry: entries[index], assay: workspaceSample.assay, binding, profile }];
    });
    if (tasks.length === 0) return;

    const totalEvents = tasks.reduce((sum, task) => sum + task.entry.sample.fcs.nEvents, 0);
    const profileNames = Array.from(new Set(tasks.map(({ profile }) => profile.name)));
    const statusName = profileNames.length === 1
      ? profileNames[0]
      : t("{count} saved compensated assays", { count: tasks.length });
    const setRestoreStatus = (
      phase: CompensationApplyUiStatus["phase"],
      processedEvents: number,
    ) => setCompensationApplyStatus({
      phase,
      operation: "restore",
      profileName: statusName,
      fraction: totalEvents === 0 ? 1 : processedEvents / totalEvents,
      processedEvents,
      totalEvents,
    });
    const assertNotCancelled = () => {
      if (compensationRestoreCancelledRef.current) {
        throw new CompensationCancelledError(t("Workspace compensation restore cancelled."));
      }
    };

    compensationApplyGuardRef.current = true;
    compensationRestoreCancelledRef.current = false;
    setRestoreStatus("preparing", 0);
    let completedEvents = 0;
    const cacheMisses: Array<{
      task: (typeof tasks)[number];
      fcsDigest: Awaited<ReturnType<typeof digestFcsBytes>> | null;
    }> = [];
    try {
      if (isSceHost) {
        if (!host.compensation) {
          throw new Error(
            "This GateLabR host cannot restore persisted SCE compensation.",
          );
        }
        const datasetId = tasks[0].entry.hostSource?.datasetId;
        if (!datasetId) {
          throw new Error(
            "The hosted compensation state has no SCE dataset identity.",
          );
        }
        const prepared = [];
        const tasksByProfile = new Map<string, typeof tasks>();
        for (const task of tasks) {
          const group = tasksByProfile.get(task.profile.profileId) ?? [];
          group.push(task);
          tasksByProfile.set(task.profile.profileId, group);
        }
        for (const [profileId, profileTasks] of tasksByProfile) {
          assertNotCancelled();
          const stored = await host.compensation.readStoredApplication(
            datasetId,
            profileId,
          );
          if (!stored) {
            throw new Error(
              `The SCE no longer contains the compensated assay for '${profileTasks[0].profile.name}'.`,
            );
          }
          const payloadBySample = new Map(
            stored.targets.map((target) => [target.sampleId, target]),
          );
          for (const task of profileTasks) {
            assertNotCancelled();
            const source = task.entry.hostSource;
            const target = source
              ? payloadBySample.get(source.sampleId)
              : undefined;
            if (!source || !target) {
              throw new Error(
                `The SCE compensated assay is unavailable for '${task.entry.name}'.`,
              );
            }
            const external = await manager.prepareExternalApplyBinding(
              stored.application.profile,
              task.entry.sample,
            );
            if (
              external.profile.profileId !== task.binding.profileId ||
              external.profile.profileHash !== task.binding.profileHash ||
              JSON.stringify(external.binding) !== JSON.stringify(task.binding)
            ) {
              throw new Error(
                `Saved compensation identity changed for '${task.entry.name}'.`,
              );
            }
            const columns = decodeChannelMajorFloat32(
              target.assayPayload,
              task.entry.sample.channels.length,
              target.eventCount,
            );
            prepared.push(task.entry.sample.prepareCompensatedLayer({
              metadata: external.binding,
              columns: external.binding.channelBindings
                .filter(({ included }) => included)
                .map(({ pnn, fcsColumnIndex }) => ({
                  pnn,
                  fcsColumnIndex,
                  values: columns[fcsColumnIndex],
                })),
            }, { activeLayer: task.assay.activeLayer }));
            completedEvents += task.entry.sample.fcs.nEvents;
            setRestoreStatus("preparing", completedEvents);
          }
        }
        Sample.commitPreparedCompensatedLayers(prepared);
        setImportMsg(
          `Restored ${tasks.length} compensated SCE assay` +
            `${tasks.length === 1 ? "" : "s"} without recomputation`,
        );
        return;
      }

      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        assertNotCancelled();
        setImportMsg(t("Restoring saved compensation · checking local cache {current} of {total}", {
          current: index + 1,
          total: tasks.length,
        }));
        let fcsDigest: Awaited<ReturnType<typeof digestFcsBytes>> | null = null;
        try {
          if (task.entry.bytes) {
            fcsDigest = await digestFcsBytes(task.entry.bytes);
          }
        } catch {
          // Web Crypto/local storage is an acceleration only. Fall through to exact recomputation.
        }
        assertNotCancelled();
        const cached = fcsDigest
          ? await readCachedCompensatedAssay(
              fcsDigest,
              task.binding,
              task.entry.sample.fcs.nEvents,
            )
          : null;
        assertNotCancelled();
        if (
          cached &&
          installCachedCompensatedAssay(
            task.entry.sample,
            cached,
            task.binding,
            task.assay.activeLayer,
          )
        ) {
          completedEvents += task.entry.sample.fcs.nEvents;
          setRestoreStatus("preparing", completedEvents);
        } else {
          cacheMisses.push({ task, fcsDigest });
        }
      }

      const missesByProfile = new Map<string, typeof cacheMisses>();
      for (const miss of cacheMisses) {
        const group = missesByProfile.get(miss.task.profile.profileId) ?? [];
        group.push(miss);
        missesByProfile.set(miss.task.profile.profileId, group);
      }

      for (const misses of missesByProfile.values()) {
        assertNotCancelled();
        const groupStart = completedEvents;
        const profile = misses[0].task.profile;
        setImportMsg(t("Restoring saved compensation · recomputing {name}", { name: profile.name }));
        const result = await manager.apply({
          profile,
          targets: misses.map(({ task }) => ({
            sample: task.entry.sample,
            activeLayer: task.assay.activeLayer,
          })),
          onProgress: (progress) => {
            const restoredEvents = groupStart + progress.processedEvents;
            setRestoreStatus("applying", restoredEvents);
            setImportMsg(t("Restoring saved compensation · {percent}% · {processed} / {total} events", {
              percent: Math.round(restoredEvents / totalEvents * 100),
              processed: restoredEvents.toLocaleString(),
              total: totalEvents.toLocaleString(),
            }));
          },
        });
        completedEvents = groupStart + misses.reduce(
          (sum, { task }) => sum + task.entry.sample.fcs.nEvents,
          0,
        );
        setRestoreStatus("applying", completedEvents);

        for (const restored of result.targets) {
          const miss = misses.find(({ task }) => task.entry.sample === restored.sample);
          if (!miss?.fcsDigest) continue;
          void writeCachedCompensatedAssay(
            miss.fcsDigest,
            restored.sample,
            restored.binding,
          ).catch(() => "unavailable");
        }
      }
    } finally {
      compensationApplyGuardRef.current = false;
      compensationRestoreCancelledRef.current = false;
      setCompensationApplyStatus(null);
    }
  }

  async function openWorkspaceFromFile(
    file: File,
    wsH: FileSystemFileHandle | null,
    wsFileName: string,
  ) {
    setBusy(true);
    setError(null);
    setImportMsg(`Opening ${wsFileName} · reading workspace`);
    try {
      // "Workspace" means two different things now: a .gatelab bundle, and a FlowJo .wsp that
      // carries gates only. Point at the right control rather than failing on the zip header.
      // A .wsp holds gates and the names of the files they were drawn on, but no data. Opening
      // one therefore means gathering its FCS first -- from what is already loaded, plus
      // whatever the user can point at -- rather than refusing until a file happens to be open.
      if (/\.wsp$/i.test(wsFileName)) {
        const text = await file.text();
        if (!isFlowJoWorkspace(text)) {
          throw new Error(`"${wsFileName}" is not a FlowJo workspace GateLab can read.`);
        }
        const wsSamples = listFlowJoWorkspaceSamples(text).filter((x) => x.gateCount > 0);
        if (!wsSamples.length) throw new Error("This workspace contains no gates GateLab can read.");
        setFlowJoOpen({
          fileName: wsFileName,
          text,
          handle: wsH,
          samples: wsSamples,
          pending: [],
          // Pre-select the sample carrying the most gates: with one sample it is the only
          // answer, and with several it is the likeliest strategy of record.
          strategySample: wsSamples.reduce((best, x) => (x.gateCount > best.gateCount ? x : best)).index,
          strategyTree: null,
        });
        setImportMsg(null);
        return;
      }
      const envelope = await readWorkspaceEnvelopeFromFile(file);
      await openWorkspaceFromEnvelope(envelope, wsH, wsFileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openWorkspaceFromEnvelope(
    envelope: WorkspaceEnvelope,
    wsH: FileSystemFileHandle | null,
    wsFileName: string,
  ) {
    setBusy(true);
    setError(null);
    let compensationWorkspaceReset = false;
    try {
      const raw = envelope.raw;
      const rawVersion = raw != null && typeof raw === "object"
        ? (raw as { version?: unknown }).version
        : undefined;
      let ws: LiveWorkspaceFile;
      if (rawVersion === WORKSPACE_VERSION_3) {
        const provisional = raw as Partial<WorkspaceFileV3>;
        if (!Array.isArray(provisional.samples) || provisional.samples.length === 0) {
          throw new Error("Invalid GateLab workspace v3: sample declarations are missing.");
        }
        ws = provisional as WorkspaceFileV3;
      } else {
        ws = migrateWorkspaceToV2(raw);
        validateWorkspace(ws);
      }
      const { fcsByPath, storage } = envelope;

      // Resolve every external FCS before parsing or changing the current workspace. Missing
      // handles are recovered from one user-selected folder, not one picker per sample.
      const referenceRequirements: WorkspaceFcsRequirement[] = [];
      for (const wss of ws.samples) {
        if (typeof wss.fileName !== "string" || typeof wss.dataPath !== "string") {
          throw new Error("Invalid GateLab workspace: a sample declaration is malformed.");
        }
        if (!fcsByPath?.[wss.dataPath]) {
          referenceRequirements.push({
            dataPath: wss.dataPath,
            fileName: wss.fileName,
          });
        }
      }

      const duplicateReferenceNames = new Set<string>();
      const seenReferenceNames = new Set<string>();
      for (const { fileName } of referenceRequirements) {
        const normalized = fileName.normalize("NFC").toLocaleLowerCase();
        if (seenReferenceNames.has(normalized)) duplicateReferenceNames.add(fileName);
        seenReferenceNames.add(normalized);
      }
      if (duplicateReferenceNames.size > 0) {
        throw new Error(
          "This linked workspace contains multiple FCS files with the same filename " +
            `(${[...duplicateReferenceNames].join(", ")}), so GateLab cannot safely distinguish them by folder matching. ` +
            "Open the original files and save a portable workspace instead.",
        );
      }

      const resolvedReferenceFcs = new Map<string, ResolvedReferenceFcs>();
      const unresolvedRequirements: WorkspaceFcsRequirement[] = [];
      for (const requirement of referenceRequirements) {
        const known = await resolveKnownReferenceFcs(requirement.fileName);
        if (known) {
          resolvedReferenceFcs.set(requirement.dataPath, known);
        } else {
          unresolvedRequirements.push(requirement);
        }
      }
      if (unresolvedRequirements.length > 0) {
        const recovered = await requestReferenceFcsFolder(unresolvedRequirements, wsH);
        if (!recovered) {
          setImportMsg("Workspace open cancelled · current workspace unchanged");
          return;
        }
        for (const [dataPath, resolved] of recovered) {
          resolvedReferenceFcs.set(dataPath, resolved);
        }
      }

      // Build an entry for every sample only after all linked files have been resolved.
      const entries: SampleEntry[] = [];
      const nextMetadata: Record<string, Record<string, string>> = {};
      const nextDivision: Record<string, DivisionProfile> = {};
      for (const wss of ws.samples) {
        let fcsB = fcsByPath?.[wss.dataPath] ?? null;
        let fcsH: FileSystemFileHandle | null = null;
        let sourcePath: string | undefined;
        if (!fcsB) {
          const resolved = resolvedReferenceFcs.get(wss.dataPath);
          if (!resolved) {
            throw new Error(
              `GateLab could not resolve ${wss.fileName}. The current workspace was not changed.`,
            );
          }
          fcsB = resolved.bytes;
          fcsH = resolved.handle;
          sourcePath = resolved.sourcePath;
        }
        let entry: SampleEntry;
        try {
          entry = createEntry(fcsB, wss.fileName, fcsH, sourcePath, wss.sampleId);
        } catch (cause) {
          throw new Error(
            `Could not read ${wss.fileName}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
              "The current workspace was not changed.",
          );
        }
        if (wss.instrumentMode === "flow" || wss.instrumentMode === "cytof") {
          entry.sample.setInstrumentMode(wss.instrumentMode);
        }
        if (Number.isFinite(wss.cytofCofactor) && (wss.cytofCofactor ?? 0) > 0) {
          entry.sample.setCytofCofactor(wss.cytofCofactor!);
        }
        entry.handle = fcsH;
        if (fcsH) void rememberHandle("fcs:" + wss.fileName, fcsH);
        entries.push(entry);
      }

      if (rawVersion === WORKSPACE_VERSION_3) {
        const contexts: WorkspaceV3SampleRestoreContexts = Object.freeze(
          Object.fromEntries(ws.samples.map((wss, index) => [
            wss.dataPath,
            Object.freeze({
              sampleChannels: entries[index].sample.channels,
              instrumentKind: entries[index].sample.instrument,
            }),
          ])),
        );
        ws = await validateWorkspaceV3(raw, contexts);
      }

      for (let index = 0; index < ws.samples.length; index++) {
        const wss = ws.samples[index];
        const entry = entries[index];
        for (const [key, w] of Object.entries(wss.logicleW ?? {})) {
          const idx = entry.sample.index(key);
          if (idx !== undefined && Number.isFinite(w)) entry.sample.setLogicleW(idx, w);
        }
        for (const [key, cofactor] of Object.entries(wss.scatterCofactor ?? {})) {
          const idx = entry.sample.index(key);
          if (idx !== undefined && Number.isFinite(cofactor) && cofactor > 0) {
            entry.sample.setScatterCofactor(idx, cofactor);
          }
        }
        entry.sample.applyScatterLinearKeys(wss.scatterLinear ?? []);
        entry.sample.applyLabelOverrides(wss.labels ?? {});
        if (wss.metadata && Object.keys(wss.metadata).length) nextMetadata[entry.id] = wss.metadata;
        if (wss.division) {
          const restoredCoordinateBinding = wss.division.coordinateBindingKey ??
            (entry.sample.index(wss.division.channelKey) === undefined
              ? `unavailable:${wss.division.channelKey}`
              : entry.sample.displayCoordinateBindingKey(wss.division.channelKey));
          nextDivision[entry.id] = {
            ...wss.division,
            coordinateBindingKey: restoredCoordinateBinding,
          };
        }
        if (ws.version === 2 && "compensationOn" in wss && wss.compensationOn) {
          entry.sample.setCompensation(true);
        }
      }

      await checkpointCurrentWorkspace("before-workspace-open");
      const nextWorkspaceId = ws.workspaceId ?? makeWorkspaceId();
      compensationManagerRef.current!.resetWorkspace(nextWorkspaceId);
      compensationWorkspaceReset = true;
      if (ws.version === WORKSPACE_VERSION_3) {
        if (envelope.portableAssays) {
          const totalCompensatedEvents = ws.samples.reduce(
            (total, workspaceSample, index) => total +
              (workspaceSample.assay.compensatedLayer === null ? 0 : entries[index].sample.fcs.nEvents),
            0,
          );
          const hasEmbeddedCompensation = totalCompensatedEvents > 0;
          compensationApplyGuardRef.current = true;
          compensationRestoreCancelledRef.current = false;
          try {
            const restored = await restorePortableAssayLayers(
              envelope.portableAssays,
              ws,
              ws.samples.map((workspaceSample, index) => Object.freeze({
                dataPath: workspaceSample.dataPath,
                fcsBytes: requireFcsBytes(entries[index]),
                sample: entries[index].sample,
              })),
              {
                checkCancelled: () => {
                  if (compensationRestoreCancelledRef.current) {
                    throw new CompensationCancelledError("Workspace compensation restore cancelled.");
                  }
                },
                onProgress: ({ processedBytes, totalBytes }) => {
                  const fraction = totalBytes === 0 ? 1 : processedBytes / totalBytes;
                  if (hasEmbeddedCompensation) {
                    setCompensationApplyStatus({
                      phase: "preparing",
                      operation: "restore",
                      profileName: "embedded compensated assays",
                      fraction,
                      processedEvents: Math.round(totalCompensatedEvents * fraction),
                      totalEvents: totalCompensatedEvents,
                    });
                  }
                  setImportMsg(
                    `${hasEmbeddedCompensation ? "Restoring embedded compensation" : "Checking portable workspace data"}` +
                      ` · ${Math.round(fraction * 100)}%`,
                  );
                },
              },
            );
            for (let index = 0; index < ws.samples.length; index++) {
              const binding = ws.samples[index].assay.compensatedLayer;
              const fcsDigest = restored.sourceDigests[ws.samples[index].dataPath];
              if (!binding || !fcsDigest) continue;
              void writeCachedCompensatedAssay(
                fcsDigest,
                entries[index].sample,
                binding,
              ).catch(() => "unavailable");
            }
          } finally {
            compensationApplyGuardRef.current = false;
            compensationRestoreCancelledRef.current = false;
            setCompensationApplyStatus(null);
          }
        } else {
          await restoreSavedWorkspaceCompensation(ws, entries);
        }
      }
      pendingCheckpointReasonRef.current = "after-workspace-open";
      skipDirtyRef.current = true;
      const activeIdx = Math.min(Math.max(0, ws.activeSample), entries.length - 1);
      const active = entries[activeIdx].sample;
      const targetDisplayContext = active.workspaceScaleContextKey;
      preserveScalesForContext(targetDisplayContext);
      setSamples(entries);
      setWorkspaceCompensation(
        ws.version === WORKSPACE_VERSION_3
          ? ws.compensation
          : newEmptyWorkspaceCompensationState(),
      );
      setActiveSampleId(entries[activeIdx].id);
      setMetadata(nextMetadata);
      setMetadataColumns(ws.metadataColumns ?? []);
      setPopulationMetadata(ws.populationMetadata ?? {});
      setPopulationMetaColumns(ws.populationMetaColumns ?? []);
      illustConfigRef.current = ws.illustration ?? null;
      setIllustrationPresets(ws.illustrationPresets ?? []);
      setIllustVersion((v) => v + 1); // remount IllustrationTab so it re-reads the restored config
      clearPersistedTabState(); // drop old selections so a new workspace's tabs start clean
      setDivisionProfiles(nextDivision);
      setScaleCacheEpoch((epoch) => epoch + 1);
      setGlobalScales(ws.scales.globalScales ?? {});
      setInstrumentMode(active.instrumentMode);
      setMode(ws.display?.mode ?? "pseudocolor");
      setMaxEvents(ws.display?.maxEvents ?? 50000);
      setContourThreshold(ws.display?.contourThreshold ?? 5);
      setDensityColorPower(normalizeDensityColorPower(ws.display?.densityColorPower));
      setBranchGatesOnly(
        (ws.display as { branchGatesOnly?: boolean } | undefined)?.branchGatesOnly !== false);
      setPointAlpha(restoredPointAlpha(ws.display?.pointAlpha));
      setPointSize(restoredPointSize(ws.display?.pointSize));
      setGatingFontSizes({ ...DEFAULT_GATING_FONT_SIZES, ...ws.display?.fontSizes });
      const [dx, dy] = active.defaultChannelIndices();
      pendingFitOnLoad.current = true;
      setXIdx(active.index(ws.display?.xChannel ?? "") ?? dx);
      setYIdx(active.index(ws.display?.yChannel ?? "") ?? dy);
      setXRange(null);
      setYRange(null);
      setWsHandle(wsH);
      setWsName(wsFileName);
      setWsStorage(storage);
      setWorkspaceId(nextWorkspaceId);
      setDirty(false);
      dispatch({
        type: "loadWorkspace",
        gates: ws.gating.gates,
        gate_order: ws.gating.gate_order,
        populations: ws.gating.populations,
        root_population_id: ws.gating.root_population_id,
        active_population_id: ws.gating.active_population_id,
        selected_gate_id: ws.gating.selected_gate_id,
      });
      const nS = entries.length;
      setImportMsg(
        `Opened ${wsFileName || "workspace"} · ${nS} sample${nS > 1 ? "s" : ""}` +
          ` · ${storage === "bundle" ? "self-contained bundle" : "linked FCS"}` +
          ` · saved ${new Date(ws.savedAt).toLocaleString()}`,
      );
    } catch (e) {
      if (compensationWorkspaceReset) compensationManagerRef.current!.resetWorkspace(workspaceId);
      if (e instanceof CompensationCancelledError) {
        setError(null);
        setImportMsg("Workspace open cancelled · current workspace unchanged");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  // Gate geometry and population membership are expensive over large FCS files, but neither
  // depends on which population is currently selected. Keep that stable work cached across
  // population clicks; only invalidate when the sample/gating inputs themselves change.
  const gatingDerived = useMemo(
    () => recomputeGating(sample, gatingState),
    // Sample is mutable by design, so its explicit revision must invalidate gate geometry.
    // instrumentMode remains separate because transform-only changes do not always revise data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, gatingState, activeDataRevision, instrumentMode],
  );

  const checkedDisplayNeedsGating = useMemo(() => {
    const rootId = state.root_population_id;
    if (!rootId) return false;
    if (overlayBy === "population") return true;
    const activePopulationId = state.active_population_id ?? rootId;
    if (activePopulationId !== rootId) return true;
    return (state.selected_pop_ids ?? []).some((id) => id !== rootId);
  }, [
    overlayBy,
    state.active_population_id,
    state.root_population_id,
    state.selected_pop_ids,
  ]);

  // Keep inactive checked files out of the synchronous render path. Their full gating
  // masks are updated one file at a time between browser paints, and only while a view
  // that needs cross-file population counts is visible. This preserves the active-file
  // interaction latency when a workspace contains many large FCS files.
  const inactiveGatingCacheRef = useRef<Map<string, CachedSampleGating>>(new Map());
  const inactiveGatingGenerationRef = useRef(0);
  const [inactiveGatingCacheVersion, setInactiveGatingCacheVersion] = useState(0);
  const [pendingIncludedGatingIds, setPendingIncludedGatingIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!activeEntry || !sample) return;
    inactiveGatingCacheRef.current.set(activeEntry.id, {
      sample,
      dataRevision: sample.dataRevision,
      gateVersion: state.gate_version,
      gating: gatingDerived,
    });
  }, [activeEntry, sample, activeDataRevision, state.gate_version, gatingDerived]);

  useEffect(() => {
    const generation = ++inactiveGatingGenerationRef.current;
    let timer: number | null = null;
    const loadedIds = new Set(samples.map((entry) => entry.id));
    for (const id of inactiveGatingCacheRef.current.keys()) {
      if (!loadedIds.has(id)) inactiveGatingCacheRef.current.delete(id);
    }

    // The Gating plot can draw All Events without these masks, but its Population tree still
    // needs pooled counts for every checked FCS. Keep that secondary work scheduled rather than
    // putting it back into the synchronous gate-editing path.
    const inactiveGatingNeeded =
      activeTab === "illustration" ||
      activeTab === "gating" ||
      fcsExportOpen;
    if (!inactiveGatingNeeded || !sample) {
      setPendingIncludedGatingIds(new Set());
      return () => {
        if (timer !== null) window.clearTimeout(timer);
      };
    }

    const targets = includedSamples.filter((entry) => {
      if (entry.id === activeSampleId) return false;
      const cached = inactiveGatingCacheRef.current.get(entry.id);
      return !cached ||
        cached.sample !== entry.sample ||
        cached.dataRevision !== entry.sample.dataRevision ||
        cached.gateVersion !== state.gate_version;
    });
    setPendingIncludedGatingIds(new Set(targets.map((entry) => entry.id)));

    let targetIndex = 0;
    const processNext = () => {
      if (generation !== inactiveGatingGenerationRef.current) return;
      if (targetIndex >= targets.length) {
        setPendingIncludedGatingIds(new Set());
        return;
      }
      const entry = targets[targetIndex++];
      timer = window.setTimeout(() => {
        timer = null;
        if (generation !== inactiveGatingGenerationRef.current) return;
        try {
          const gating = recomputeGating(entry.sample, gatingState);
          if (generation !== inactiveGatingGenerationRef.current) return;
          inactiveGatingCacheRef.current.set(entry.id, {
            sample: entry.sample,
            dataRevision: entry.sample.dataRevision,
            gateVersion: state.gate_version,
            gating,
          });
          setInactiveGatingCacheVersion((version) => version + 1);
          setPendingIncludedGatingIds((previous) => {
            const next = new Set(previous);
            next.delete(entry.id);
            return next;
          });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        processNext();
      }, 0);
    };
    processNext();

    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
    // Gate/data identities are explicit; active/checked population selection is cheap
    // and deliberately does not invalidate these full gating masks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    fcsExportOpen,
    sample,
    activeSampleId,
    includedSamples,
    samples,
    sampleDataRevisionKey,
    state.gate_version,
    gatingState,
  ]);

  const derived = useMemo(
    () => derivePopulationView(sample, state, gatingDerived),
    // `gatingDerived` changes whenever gates/populations change; active/checked ids only select
    // among its cached masks and never need to rerun gate geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, gatingDerived, state.active_population_id, state.selected_pop_ids],
  );

  const includedGatingResults = useMemo<readonly GatingDerived[] | null>(() => {
    const results: GatingDerived[] = [];
    for (const entry of includedSamples) {
      if (entry.id === activeSampleId) {
        results.push(gatingDerived);
        continue;
      }
      const cached = inactiveGatingCacheRef.current.get(entry.id);
      if (
        !cached ||
        cached.sample !== entry.sample ||
        cached.dataRevision !== entry.sample.dataRevision ||
        cached.gateVersion !== state.gate_version
      ) return null;
      results.push(cached.gating);
    }
    return results;
  }, [
    includedSamples,
    activeSampleId,
    gatingDerived,
    inactiveGatingCacheVersion,
    state.gate_version,
  ]);

  const exportPopulationCountsBySample = useMemo(() => {
    const counts = new Map<string, Readonly<Record<string, number | null>>>();
    for (const entry of samples) {
      if (entry.id === activeSampleId) {
        counts.set(entry.id, gatingDerived.stats.event_count);
        continue;
      }
      const cached = inactiveGatingCacheRef.current.get(entry.id);
      if (
        cached &&
        cached.sample === entry.sample &&
        cached.dataRevision === entry.sample.dataRevision &&
        cached.gateVersion === state.gate_version
      ) {
        counts.set(entry.id, cached.gating.stats.event_count);
      }
    }
    return counts;
  }, [
    samples,
    activeSampleId,
    gatingDerived,
    inactiveGatingCacheVersion,
    state.gate_version,
  ]);

  async function exportHostedPopulationColumns(
    specs: readonly ScePopulationColumnSpec[],
    overwrite: boolean,
  ): Promise<void> {
    if (!isSceHost || !host.colData) {
      setError("This host cannot write population memberships into colData.");
      return;
    }
    const datasetId = samples[0]?.hostSource?.datasetId;
    if (!datasetId) {
      setError("The SCE dataset identity is unavailable.");
      return;
    }
    setHostColDataBusy(true);
    setError(null);
    try {
      const saved = await saveHostedWorkspace(
        "autosave",
        workspaceEditRevisionRef.current,
      );
      const columns: GateLabHostPopulationColumn[] = specs.map((spec) => {
        const sampleMasks = samples.map((entry) => {
          const source = entry.hostSource;
          if (!source || source.datasetId !== datasetId) {
            throw new Error(`Sample '${entry.name}' is not mapped to this SCE.`);
          }
          let gating: GatingDerived;
          if (entry.id === activeSampleId) {
            gating = gatingDerived;
          } else {
            const cached = inactiveGatingCacheRef.current.get(entry.id);
            gating = cached &&
              cached.sample === entry.sample &&
              cached.dataRevision === entry.sample.dataRevision &&
              cached.gateVersion === state.gate_version
              ? cached.gating
              : recomputeGating(entry.sample, gatingState);
          }
          const mask = gating.masks[spec.populationId];
          if (!mask || mask.length !== source.eventIndex.length) {
            throw new Error(
              `Population '${spec.populationName}' could not be evaluated for sample '${entry.name}'.`,
            );
          }
          return {
            sampleId: source.sampleId,
            eventCount: mask.length,
            membershipBitsBase64: encodeUint8Base64(packMembershipBits(mask)),
          };
        });
        return {
          ...spec,
          sampleMasks,
        };
      });
      const result = await host.colData.writeColumns({
        contractVersion: GATELAB_HOST_COLDATA_CONTRACT_VERSION,
        datasetId,
        workspaceRevision: saved.revision,
        overwrite,
        columns,
      });
      setHostColDataColumns((current) => [
        ...new Set([...current, ...result.columns.map(({ columnName }) => columnName)]),
      ]);
      setImportMsg(
        `Wrote ${result.columns.length} population membership column` +
          `${result.columns.length === 1 ? "" : "s"} to the SCE · ` +
          result.columns
            .map(({ columnName, memberCount }) =>
              `${columnName}: ${memberCount.toLocaleString()}`,
            )
            .join(" · "),
      );
      setCrud(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHostColDataBusy(false);
    }
  }

  const pooledPopulationStats = useMemo(
    () => includedGatingResults === null
      ? null
      : aggregatePopulationTreeStats(
          state.populations,
          state.root_population_id,
          includedGatingResults.map((result) => result.stats),
        ),
    [
      includedGatingResults,
      state.populations,
      state.root_population_id,
    ],
  );
  const populationTreeDerived = useMemo<Derived>(
    () => pooledPopulationStats ? { ...derived, stats: pooledPopulationStats } : derived,
    [derived, pooledPopulationStats],
  );
  const populationStatsPending =
    includedSamples.length > 0 && includedGatingResults === null;

  const includedDisplaySelections = useMemo<IncludedDisplaySelection[]>(
    () => includedSamples.flatMap((entry): IncludedDisplaySelection[] => {
    if (!checkedDisplayNeedsGating) {
      return [{
        entry,
        gating: entry.id === activeSampleId ? gatingDerived : null,
        selection: {
          activeMask: null,
          displayMask: null,
          displayPopCount: 0,
        },
      }];
    }
    const gating = entry.id === activeSampleId
      ? gatingDerived
      : inactiveGatingCacheRef.current.get(entry.id)?.gating;
    const cached = entry.id === activeSampleId
      ? null
      : inactiveGatingCacheRef.current.get(entry.id);
    if (
      !gating ||
      (cached && (
        cached.sample !== entry.sample ||
        cached.dataRevision !== entry.sample.dataRevision ||
        cached.gateVersion !== state.gate_version
      ))
    ) return [];
    return [{
      entry,
      gating,
      selection: derivePopulationDisplaySelection(entry.sample, state, gating),
    }];
    }),
    [
      includedSamples,
      activeSampleId,
      gatingDerived,
      checkedDisplayNeedsGating,
      inactiveGatingCacheVersion,
      state.active_population_id,
      state.selected_pop_ids,
      state.root_population_id,
      state.gate_version,
    ],
  );

  const illustrationSampleViews = useMemo(() => includedSamples.flatMap((entry) => {
    if (entry.id === activeSampleId) {
      return [{ id: entry.id, name: entry.name, sample: entry.sample, derived }];
    }
    const cached = inactiveGatingCacheRef.current.get(entry.id);
    if (
      !cached ||
      cached.sample !== entry.sample ||
      cached.dataRevision !== entry.sample.dataRevision ||
      cached.gateVersion !== state.gate_version
    ) return [];
    return [{
      id: entry.id,
      name: entry.name,
      sample: entry.sample,
      derived: derivePopulationView(entry.sample, state, cached.gating),
    }];
  }), [
    includedSamples,
    activeSampleId,
    derived,
    inactiveGatingCacheVersion,
    state.active_population_id,
    state.selected_pop_ids,
    state.root_population_id,
    state.gate_version,
  ]);

  // Rows for the Population metadata table (Metadata tab): every gated population (root excluded),
  // with read-only derived Parent / Count / % Parent (from the active sample's stats).
  const populationRows = useMemo<MetaRow[]>(() => {
    const rootId = state.root_population_id ?? "";
    return populationTreeOrder(state.populations, rootId)
      .filter(({ popId }) => popId !== rootId)
      .map(({ popId }) => {
        const p = state.populations[popId];
        const parentName = p?.parent_id ? state.populations[p.parent_id]?.name ?? "" : "";
        const count = derived.stats.event_count[popId];
        const pct = derived.stats.percent_of_parent[popId];
        return {
          id: popId,
          name: p?.name ?? popId,
          fixed: [parentName, count != null ? count.toLocaleString() : "—", pct != null ? `${pct}%` : "—"],
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.populations, state.root_population_id, state.gate_version, derived]);
  const compensationReviewPopulations = useMemo(() => {
    const rootId = state.root_population_id ?? "";
    return populationTreeOrder(state.populations, rootId)
      .filter(({ popId }) => popId !== rootId)
      .map(({ popId, depth }) => ({
        id: popId,
        name: state.populations[popId]?.name ?? popId,
        depth: Math.max(0, depth - 1),
        eventCount: derived.stats.event_count[popId] ?? 0,
      }));
  }, [derived.stats.event_count, state.populations, state.root_population_id]);

  // gate_list_click also switches the plot axes to the gate's channels (app.R:5030).
  const uiDispatch = (a: Action) => {
    if (a.type === "selectGate" && a.gateId && sample) {
      const g = state.gates[a.gateId];
      if (g) {
        const gx = sample.index(g.x_channel);
        const gy = sample.index(g.y_channel);
        if (gx !== undefined && gy !== undefined && (gx !== xIdx || gy !== yIdx)) {
          setXIdx(gx);
          setYIdx(gy);
        }
      }
    }
    dispatch(a);
  };

  // Per-event colour index for the "Colour by" overlay (population Partition or division level).
  const overlaySpec = useMemo<OverlaySpec | null>(() => {
    if (!sample || overlayBy === "none") return null;
    const n = sample.fcs.nEvents;
    if (overlayBy === "sample") {
      return {
        colors: new Uint8Array(n),
        palette: paletteColors(overlayPalette, 1),
        labels: [fileName],
      };
    }
    if (overlayBy === "population") {
      const rootId = state.root_population_id ?? "";
      const allPops = populationTreeOrder(state.populations, rootId).map((o) => o.popId);
      const levels = resolvePartitionLevels(state.populations, rootId, allPops);
      if (levels.length === 0) return null;
      const assign = partitionAssign(derived.masks, levels, n);
      const ungated = levels.length;
      const colors = new Uint8Array(n);
      for (let e = 0; e < n; e++) colors[e] = assign[e] < 0 ? ungated : assign[e];
      // Colour each population by its STABLE slot (frozen — adding/removing a population never
      // reshuffles the others); the ungated remainder gets the fixed grey, not a moving palette slot.
      const palette = [...levels.map((l) => populationColor(overlayPalette, state.populations[l.popId]?.colorSlot)), UNGATED_COLOR];
      return { colors, palette, labels: [...levels.map((l) => l.name), "ungated"] };
    }
    // division level (needs a profile on the active sample)
    const prof = activeSampleId ? compatibleDivisionProfiles[activeSampleId] : undefined;
    const idx = prof ? sample.index(prof.channelKey) : undefined;
    if (!prof || idx === undefined) return null;
    const dye = sample.displayColumn(idx);
    const nLevels = prof.boundaries.length + 1;
    const colors = new Uint8Array(n);
    for (let e = 0; e < n; e++) colors[e] = assignDivisionLevel(dye[e], prof.boundaries);
    return { colors, palette: divisionPalette(nLevels), labels: Array.from({ length: nLevels }, (_, i) => `Div${i}`) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, activeDataRevision, overlayBy, overlayPalette, fileName, state.populations, state.root_population_id, state.gate_version, derived, activeSampleId, compatibleDivisionProfiles]);

  // Hierarchy-scoped gate visibility; see branchScopedGateOrder for the rule.
  //
  // Ticking a gate in the Gates list also forces it onto the plot whenever it is drawn on the
  // current axes, whether or not it defines anything in the displayed branch. Without that a gate
  // belonging to no population -- a trial gate, or one being compared against another -- cannot be
  // shown at all, because branch scoping has nothing to place it under. The axes still decide:
  // a ticked gate on other channels stays hidden, since drawing it here would put it in a space
  // it was never defined in.
  const branchGateOrder = useMemo(
    () => {
      const scoped = !branchGatesOnly
        ? (state.gate_order.length ? state.gate_order : Object.keys(state.gates))
        : branchScopedGateOrder(
          state.populations,
          state.gates,
          state.gate_order,
          state.active_population_id,
          state.root_population_id,
          state.selected_gate_id,
        );
      if (!state.selected_gate_ids?.length) return scoped;
      const shown = new Set(scoped);
      const order = state.gate_order.length ? state.gate_order : Object.keys(state.gates);
      // Keep the canonical order rather than appending, so ticking a gate does not reorder the
      // ones already drawn.
      return order.filter((id) => shown.has(id) || state.selected_gate_ids.includes(id));
    },
    [
      state.populations, state.gates, state.gate_order,
      state.active_population_id, state.root_population_id, state.selected_gate_id,
      state.selected_gate_ids, branchGatesOnly,
    ],
  );

  const mainPlotGates = useMemo(() => {
    if (!sample) return [];
    return buildPlotGates(
      sample,
      state.gates,
      branchGateOrder,
      derived.gateCounts,
      sample.channels[xIdx].key,
      sample.channels[yIdx].key,
    );
    // activeDisplayContextKey and scalesVersion are load-bearing: buildPlotGates converts
    // each gate out of raw space with the CURRENT transform, so without them the gate keeps
    // display coordinates computed under the previous scatter cofactor or scale while the
    // event cloud and the axis both move to the new one. The gate then appears to slide off
    // its own events even though membership, evaluated in raw space, never changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, state.gates, branchGateOrder, derived.gateCounts, xIdx, yIdx, activeDisplayContextKey, scalesVersion]);

  const workspaceAutomaticRanges = useMemo(() => {
    if (
      !sample ||
      !activeXChannelKey ||
      !activeYChannelKey ||
      !activeWorkspaceScaleContextKey
    ) return null;
    const inputs = samples.flatMap((entry): CombinedSamplePlotInput[] => {
      if (entry.sample.workspaceScaleContextKey !== activeWorkspaceScaleContextKey) return [];
      const xIndex = entry.sample.index(activeXChannelKey);
      const yIndex = entry.sample.index(activeYChannelKey);
      if (xIndex === undefined || yIndex === undefined) return [];
      return [{
        id: entry.id,
        name: entry.name,
        sample: entry.sample,
        xIndex,
        yIndex,
        mask: null,
      }];
    });
    return buildWorkspaceAxisRanges(inputs);
  }, [
    samples,
    sampleDataRevisionKey,
    activeXChannelKey,
    activeYChannelKey,
    activeWorkspaceScaleContextKey,
    scalesVersion,
    instrumentMode,
  ]);

  const payload = useMemo(() => {
    if (!sample) return null;
    const xName = sample.channels[xIdx].key;
    const yName = sample.channels[yIdx].key;
    const effectiveXRange =
      xRange ?? globalScales[xName] ?? workspaceAutomaticRanges?.xRange ?? null;
    const effectiveYRange =
      yRange ?? globalScales[yName] ?? workspaceAutomaticRanges?.yRange ?? null;
    const base = sample.plotPayload(
      xIdx,
      yIdx,
      mode,
      mainPlotGates,
      derived.displayMask ?? derived.activeMask, // union of checked pops, else active
      state.selected_gate_id,
      effectiveXRange, // per-view → explicit workspace scale → automatic workspace scale
      effectiveYRange,
      maxEvents <= 0 ? Infinity : maxEvents,
      contourThreshold,
      overlaySpec,
    );

    const activeOnly =
      includedDisplaySelections.length === 1 &&
      includedDisplaySelections[0].entry.id === activeSampleId &&
      pendingIncludedGatingIds.size === 0;
    if (activeOnly) {
      return {
        ...base,
        sample_scope_count: 1,
        sample_contributor_count: base.n_events > 0 ? 1 : 0,
        sample_contributor_names: base.n_events > 0 ? [fileName] : [],
      };
    }

    // Checked files are the authoritative plotted sample set. The active (blue) row still
    // supplies channels, axes and editable gates; compatible checked files contribute their
    // selected-population events under one shared point cap.
    const compatible = includedDisplaySelections.flatMap(({ entry, gating, selection }) => {
      const xIndex = entry.sample.index(xName);
      const yIndex = entry.sample.index(yName);
      // Same scale context as the axis frame requires (see workspaceAutomaticRanges). A file on
      // the other assay layer, or under a different instrument mode, has display coordinates
      // that are not interchangeable with these -- pooling them draws one cloud from two
      // coordinate spaces, and drew it inside a frame computed from only one of them. The
      // contributor count in the header reports what this drops.
      if (entry.sample.workspaceScaleContextKey !== activeWorkspaceScaleContextKey) return [];
      return xIndex === undefined || yIndex === undefined
        ? []
        : [{ entry, gating, selection, xIndex, yIndex }];
    });

    let colorPalette: string[] | undefined;
    let colorLabels: string[] | undefined;
    const inputs: CombinedSamplePlotInput[] = compatible.map(
      ({ entry, selection, xIndex, yIndex }) => ({
        id: entry.id,
        name: entry.name,
        sample: entry.sample,
        xIndex,
        yIndex,
        mask: selection.displayMask,
      }),
    );

    if (overlayBy === "sample") {
      colorPalette = paletteColors(overlayPalette, compatible.length);
      colorLabels = compatible.map(({ entry }) => entry.name);
      inputs.forEach((input, index) => {
        input.colorIndex = index;
      });
    } else if (overlayBy === "population") {
      const rootId = state.root_population_id ?? "";
      const allPopulations = populationTreeOrder(state.populations, rootId).map(({ popId }) => popId);
      const levels = resolvePartitionLevels(state.populations, rootId, allPopulations);
      const ungated = levels.length;
      colorPalette = [
        ...levels.map((level) =>
          populationColor(overlayPalette, state.populations[level.popId]?.colorSlot)),
        UNGATED_COLOR,
      ];
      colorLabels = [...levels.map(({ name }) => name), "ungated"];
      compatible.forEach(({ gating }, index) => {
        if (!gating) {
          inputs[index].colorIndex = ungated;
          return;
        }
        const masks = levels.map(({ popId }) => gating.masks[popId] ?? null);
        inputs[index].colorAt = (eventIndex) => {
          let best = -1;
          let bestDepth = -1;
          for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
            if (masks[levelIndex]?.[eventIndex] && levels[levelIndex].depth > bestDepth) {
              best = levelIndex;
              bestDepth = levels[levelIndex].depth;
            }
          }
          return best < 0 ? ungated : best;
        };
      });
    } else if (overlayBy === "division") {
      const profiles = compatible.map(({ entry }) => {
        const profile = compatibleDivisionProfiles[entry.id];
        const channelIndex = profile ? entry.sample.index(profile.channelKey) : undefined;
        return profile && channelIndex !== undefined
          ? { profile, channelIndex }
          : null;
      });
      const levelCount = Math.max(
        1,
        ...profiles.map((profile) => profile ? profile.profile.boundaries.length + 1 : 0),
      );
      const unassigned = levelCount;
      colorPalette = [...divisionPalette(levelCount), UNGATED_COLOR];
      colorLabels = [
        ...Array.from({ length: levelCount }, (_, index) => `Div${index}`),
        "unassigned",
      ];
      profiles.forEach((profile, index) => {
        if (!profile) {
          inputs[index].colorIndex = unassigned;
          return;
        }
        const values = compatible[index].entry.sample.displayColumn(profile.channelIndex);
        inputs[index].colorAt = (eventIndex) =>
          assignDivisionLevel(values[eventIndex], profile.profile.boundaries);
      });
    }

    const cloud = buildCombinedSamplePointCloud(
      inputs,
      maxEvents <= 0 ? Infinity : maxEvents,
    );
    const contributors = cloud.sampleEventCounts.filter(({ eventCount }) => eventCount > 0);
    return {
      ...base,
      x_b64: encodeFloat32Base64(cloud.x),
      y_b64: encodeFloat32Base64(cloud.y),
      n_events: cloud.eventCount,
      sample_scope_count: cloud.sampleEventCounts.length,
      sample_contributor_count: contributors.length,
      sample_contributor_names: contributors.map(({ name }) => name),
      overlay_mode: cloud.colors !== null,
      color_b64: cloud.colors ? encodeUint8Base64(cloud.colors) : undefined,
      color_palette: cloud.colors ? colorPalette : undefined,
      color_labels: cloud.colors ? colorLabels : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sample,
    activeDataRevision,
    xIdx,
    yIdx,
    mode,
    mainPlotGates,
    state.selected_gate_id,
    derived,
    scalesVersion,
    xRange,
    yRange,
    maxEvents,
    contourThreshold,
    instrumentMode,
    globalScales,
    workspaceAutomaticRanges,
    overlaySpec,
    overlayBy,
    overlayPalette,
    includedDisplaySelections,
    pendingIncludedGatingIds,
    activeSampleId,
    state.root_population_id,
    state.populations,
    compatibleDivisionProfiles,
    fileName,
  ]);

  const contributingSampleCount = payload?.sample_contributor_count ?? 0;
  const contributingSampleNames = payload?.sample_contributor_names ?? [];

  // Pointer navigation reads this mutable ref after render. Use the exact fitted payload range so
  // the first drag cannot jump from a gate-aware auto range back to the data-only range.
  pzRef.current = {
    sample, xIdx, yIdx, xRange, yRange, drawMode, mode, globalScales,
    effectiveXRange: payload?.x_range ?? null,
    effectiveYRange: payload?.y_range ?? null,
  };

  // Swap channel identity keys → Panel display labels for what cytof_plot.js SHOWS (axis labels,
  // the axis-label picker, and each gate's channel match). The store keeps identity keys; incoming
  // gate/axis events are translated back to keys (onNewGate / onAxisLabelClick).
  // Fit data + gates the FIRST time each axis pair is shown. A gate drawn out near the edge
  // otherwise lands outside the robust auto range and opens off-screen, and fitting only on
  // workspace open left every later plot unfitted. Refitting on every visit would be worse
  // than not fitting at all, so each pair is fitted once and then left alone.
  //
  // A range the user pinned in the Scales tab is never touched: only scales recorded in
  // autoFittedScales are refitted or discarded. The Scales tab describes a pinned range as
  // fixed whenever that channel is plotted, and that promise is kept.
  //
  // An auto-fit is also tied to the display transform it was computed under. Logicle W and the
  // scatter cofactor change a channel's display coordinates, so a range fitted under the old
  // transform no longer describes the data. Holding it would pin the axis to a stale frame
  // while the events move underneath — which is exactly what made the W slider look dead.
  useEffect(() => {
    if (!sample || !workspaceAutomaticRanges) return;
    const bindingKeyFor = (key: string): string | null => {
      try {
        return sample.displayCoordinateBindingKey(key);
      } catch {
        return null;
      }
    };

    // Discard auto-fits whose channel has since been re-transformed, and allow their pairs to
    // fit again at the new transform.
    const stale: string[] = [];
    for (const [key, fittedUnder] of autoFittedScales.current) {
      const current = bindingKeyFor(key);
      if (current !== null && current !== fittedUnder) stale.push(key);
    }
    if (stale.length) {
      for (const key of stale) autoFittedScales.current.delete(key);
      for (const pair of [...fittedAxisPairs.current]) {
        if (stale.some((key) => pair.includes(key))) fittedAxisPairs.current.delete(pair);
      }
      setGlobalScales((prev) => {
        const next = { ...prev };
        for (const key of stale) delete next[key];
        return next;
      });
      return; // refit on the next pass, once the cleared map has committed
    }

    const xKey = sample.channels[xIdx]?.key;
    const yKey = sample.channels[yIdx]?.key;
    if (!xKey || !yKey) return;
    const pairKey = JSON.stringify([activeWorkspaceScaleContextKey, xKey, yKey]);
    if (fittedAxisPairs.current.has(pairKey)) return;
    // Marked fitted on first sight even when the plot has no gates yet, so that later drawing
    // or editing a gate cannot trigger a fit: the viewport invariant is that gate edits never
    // rescale. Fitting belongs to arriving at a plot, not to changing what is on one.
    fittedAxisPairs.current.add(pairKey);
    pendingFitOnLoad.current = false;

    const axes = [
      { key: xKey, idx: xIdx, auto: workspaceAutomaticRanges.xRange, axis: "x" as const },
      { key: yKey, idx: yIdx, auto: workspaceAutomaticRanges.yRange, axis: "y" as const },
    ];
    for (const { key, idx, auto, axis } of axes) {
      if (globalScales[key] && !autoFittedScales.current.has(key)) continue; // user-pinned
      const binding = bindingKeyFor(key);
      if (binding) autoFittedScales.current.set(key, binding);
      setGlobalScale(key, includePlotGatesInAxisRange(auto ?? sample.displayRange(idx), mainPlotGates, axis));
    }
  }, [
    sample, workspaceAutomaticRanges, mainPlotGates, xIdx, yIdx, globalScales,
    activeWorkspaceScaleContextKey, scalesVersion,
  ]);

  /**
   * The last payload sent, so a gates-only change can be recognised.
   *
   * cytof has a fast path that updates gate overlays without touching the canvas, and GateLab
   * never used it: every gate edit, label move and selection sent a full payload, which re-decodes
   * the event arrays and repaints every cell. That repaint is the flicker seen when dragging a
   * gate. The events are provably unchanged when their encoded bytes are, so that is what decides
   * it rather than a guess at which inputs matter.
   */
  const lastSentPayload = useRef<{ x: string; y: string; sig: string } | null>(null);

  const displayed = useMemo(() => {
    if (!payload || !sample) return payload;
    const lbl = (k: string) => sample.labelForKey(k);
    // Everything that changes what is drawn on the canvas, as opposed to over it.
    const sig = JSON.stringify([
      payload.x_label, payload.y_label, payload.x_range, payload.y_range,
      payload.display_mode, payload.n_events, payload.contour_threshold,
      payload.x_binding ?? null, payload.y_binding ?? null,
      pointAlpha, pointSize, densityColorPower,
    ]);
    const prev = lastSentPayload.current;
    const gatesOnly =
      prev !== null && prev.sig === sig &&
      prev.x === payload.x_b64 && prev.y === payload.y_b64;
    lastSentPayload.current = { x: payload.x_b64, y: payload.y_b64, sig };
    return {
      ...(gatesOnly ? { gates_only: true } : {}),
      gate_edge_mode: gateEdgeMode,
      ...payload,
      point_alpha: pointAlpha, // user-adjustable opacity (was frozen at the payload's 0.4)
      point_size: pointSize, // mark radius only; density colouring is computed on a fixed grid
      density_color_power: densityColorPower,
      color_labels: undefined, // suppress cytof's in-canvas legend — we render it below the plot
      x_label: lbl(payload.x_label),
      y_label: lbl(payload.y_label),
      channels: payload.channels.map(lbl),
      gates: (payload.gates as PlotGate[]).map((g) => ({
        ...g,
        x_channel: lbl(g.x_channel),
        y_channel: lbl(g.y_channel),
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, sample, panelVersion, pointAlpha, pointSize, densityColorPower, gateEdgeMode]);

  // Colour-by overlay legend (population / division / sample) rendered OUTSIDE the plot.
  const overlayLegend = useMemo(() => {
    const p = payload as { color_labels?: string[]; color_palette?: string[] } | null;
    if (!p?.color_labels?.length || !p.color_palette) return null;
    return p.color_labels.map((label, i) => ({ label, color: p.color_palette![i] ?? "#888888" }));
  }, [payload]);

  const plotInteractionToken = useMemo(
    () => plotInteractionTokenFor(
      sample,
      activeSampleId,
      xIdx,
      yIdx,
      state.gate_version,
      state.active_population_id,
      panelVersion,
    ),
    // The explicit context/revision dependencies cover Sample's intentional mutability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, activeSampleId, activeDataRevision, activeDisplayContextKey, xIdx, yIdx, state.gate_version, state.active_population_id, panelVersion, scalesVersion],
  );
  const plotInteractionIsCurrent = () =>
    plotInteractionToken !== null && plotInteractionToken === plotInteractionTokenFor(
      sample,
      activeSampleId,
      xIdx,
      yIdx,
      state.gate_version,
      state.active_population_id,
      panelVersion,
    );

  return (
    <div className="gl-app">
      <header className="gl-header">
        <strong>{isSceHost ? "GateLabR" : "GateLab"}</strong>
        {sample && (
          <span className="gl-meta">
            {fileName} — {t("{count} events", { count: sample.fcs.nEvents.toLocaleString() })} ·{" "}
            {sample.channels.length < sample.fcs.channels.length
              ? t("{shown} of {total} channels", {
                  shown: sample.channels.length,
                  total: sample.fcs.channels.length,
                })
              : t("{count} channels", { count: sample.channels.length })} ·{" "}
            <select
              title="Instrument mode — Auto uses channel-name detection; override if a file is mis-detected. Switch before gating (the gating space flips with it)."
              value={instrumentMode}
              onChange={(e) => changeInstrumentMode(e.target.value as "auto" | "flow" | "cytof")}
              style={{ fontSize: "inherit", padding: "0 2px", background: "transparent", border: "1px solid var(--gl-border, #ccc)", borderRadius: 3 }}
            >
              <option value="auto">{t("auto ({instrument})", { instrument: sample.detectedInstrument })}</option>
              <option value="cytof">CyTOF</option>
              <option value="flow">{t("flow")}</option>
            </select>
          </span>
        )}
        {sample && (
          <label
            className="gl-header-assay"
            title={t("Active assay layer for every GateLab tab. Switching layers keeps gates but recomputes their memberships in the selected coordinate system.")}
          >
            <span>{t("Assay")}</span>
            <select
              aria-label={t("Active assay layer for all tabs")}
              value={compensationOn ? "compensated" : "original"}
              disabled={compensationApplyStatus !== null}
              onChange={(event) => toggleCompensation(event.currentTarget.value === "compensated")}
            >
              <option value="original">{t("Original")}</option>
              <option value="compensated" disabled={!canUseCompensatedAssay}>
                {activeCompensatedStatus?.state === "stale" ? t("Compensated (unavailable)") : t("Compensated")}
              </option>
            </select>
          </label>
        )}
        {error && <span className="gl-error">⚠ {t(error)}</span>}
        <span
          className="gl-header-meta"
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}
          title={
            isSceHost
              ? "GateLabR — SingleCellExperiment host using the shared GateLab React core."
              : "GateLab — MIT-licensed, © 2026 David G. Priest."
          }
        >
          {isSceHost ? `GateLab core v${pkg.version}` : `GateLab v${pkg.version} · MIT`} ·{" "}
          {t("Questions or bugs?")}{" "}
          {/* Link straight to the issue tracker rather than the repo root: the
              point is to invite feedback, so land people where they can file it. */}
          <a
            href={isSceHost
              ? "https://github.com/david-priest/GateLabR/issues"
              : "https://github.com/david-priest/GateLab/issues"}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            {t("please leave an issue at the repo")}
          </a>
        </span>
        <label className="gl-header-language">
          <span>{t("Language")}</span>
          <select
            aria-label={t("Language")}
            value={language}
            onChange={(event) => setLanguage(event.currentTarget.value as UiLanguage)}
          >
            {UI_LANGUAGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </header>

      {compensationApplyStatus && (
        <div className="gl-comp-apply-status-bar" role="status" aria-live="polite">
          <div className="gl-comp-apply-status-copy">
            <strong>
              {t(compensationApplyStatus.operation === "restore"
                ? compensationApplyStatus.phase === "cancelling"
                  ? "Cancelling workspace compensation restore"
                  : compensationApplyStatus.phase === "preparing"
                    ? "Checking saved compensation"
                    : "Restoring saved compensation"
                : compensationApplyStatus.phase === "cancelling"
                  ? "Cancelling CyTOF compensation"
                  : compensationApplyStatus.phase === "preparing"
                    ? "Preparing CyTOF compensation"
                    : "Applying CyTOF compensation")}
            </strong>
            <span title={compensationApplyStatus.targetFileName ?? compensationApplyStatus.profileName}>
              {compensationApplyStatus.profileName}
              {compensationApplyStatus.targetFileName
                ? ` · ${compensationApplyStatus.targetFileName}`
                : ""}
            </span>
          </div>
          <progress
            aria-label={t(compensationApplyStatus.operation === "restore"
              ? "Saved compensation restore progress"
              : "CyTOF compensation progress")}
            max={1}
            value={compensationApplyStatus.fraction}
          />
          <span className="gl-comp-apply-status-count">
            {compensationApplyStatus.targetFileCount && compensationApplyStatus.targetFileCount > 1
              ? `${t("File {current} / {total}", {
                  current: compensationApplyStatus.targetFileIndex ?? 1,
                  total: compensationApplyStatus.targetFileCount,
                })} · `
              : ""}
            {t("{percent}% · {processed} / {total} events", {
              percent: Math.round(compensationApplyStatus.fraction * 100),
              processed: compensationApplyStatus.processedEvents.toLocaleString(),
              total: compensationApplyStatus.totalEvents.toLocaleString(),
            })}
          </span>
          {compensationApplyStatus.operation !== "restore" && activeTab !== "compensation" && (
            <button type="button" className="gl-mini-btn" onClick={() => setActiveTab("compensation")}>
              {t("View Compensation")}
            </button>
          )}
          {!isSceHost && (
            <button
              type="button"
              className="gl-mini-btn"
              disabled={compensationApplyStatus.phase === "cancelling"}
              onClick={cancelCompensationApply}
            >
              {compensationApplyStatus.phase === "cancelling" ? t("Cancelling…") : t("Cancel")}
            </button>
          )}
        </div>
      )}

      <div className="gl-body">
        <aside className="gl-left" style={{ width: leftWidth }} aria-label="Samples and workspace">
          <div className="gl-left-resize" onMouseDown={startLeftResize} title="Drag to resize samples panel" />
          <SampleNavigator
            items={sampleListItems}
            activeId={activeSampleId}
            excludedIds={excludedSampleIds}
            busy={busy}
            importProgress={sampleImportProgress}
            sourceLabel={isSceHost ? "SingleCellExperiment samples" : "FCS samples"}
            showImportActions={!isSceHost}
            showManageActions={!isSceHost}
            onOpenFiles={() => void openFcs()}
            onOpenFolder={() => void openFcsFolder()}
            onManage={() => {
              setSampleManagerSelection([]);
              setSampleManagerOpen(true);
            }}
            onManageSample={(id) => {
              setSampleManagerSelection([id]);
              setSampleManagerOpen(true);
            }}
            onActivate={selectSample}
            onToggleIncluded={setSampleIncluded}
            onIncludeAll={includeAllSamples}
            onIncludeNone={includeNoSamples}
            onInvertIncluded={invertIncludedSamples}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".fcs"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) {
                void importFcsCandidates(files.map((file) => ({
                  id: crypto.randomUUID(),
                  name: file.name,
                  file,
                  handle: null,
                })));
              }
              e.target.value = "";
            }}
          />
          <input
            ref={(node) => {
              folderRef.current = node;
              if (node) node.setAttribute("webkitdirectory", "");
            }}
            type="file"
            accept=".fcs"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) {
                const rawRoot = files[0].webkitRelativePath.split("/")[0] || "Selected folder";
                stageFolderImport(rawRoot, files.map((file) => {
                  const pathParts = file.webkitRelativePath.split("/").filter(Boolean);
                  const relativePath = pathParts.length > 1 ? pathParts.slice(1).join("/") : file.name;
                  return {
                    id: crypto.randomUUID(),
                    name: file.name,
                    file,
                    handle: null,
                    sourcePath: `${rawRoot}/${relativePath}`,
                  };
                }));
              }
              event.target.value = "";
            }}
          />
          <input
            ref={wspFcsRef}
            type="file"
            accept=".fcs"
            data-role="flowjo-workspace-fcs"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!picked.length) return;
              // Held rather than loaded: the dialog resolves them by name first, so the user can
              // see what matched before anything is added to the workspace.
              setFlowJoOpen((cur) => cur && {
                ...cur,
                pending: [
                  ...cur.pending,
                  ...picked
                    .filter((f) => !cur.pending.some((q) => q.name === f.name))
                    .map((f) => ({ name: f.name, file: f })),
                ],
              });
            }}
          />

          <div className="gl-side-title" style={{ marginTop: 10 }}>
            {isSceHost ? "R host" : t("Workspace")}
          </div>
          {isSceHost ? (
            <>
              <div className="gl-hint">
                SingleCellExperiment · workspace revision {hostWorkspaceRevision}
                {hostWorkspaceStatus === "saving"
                  ? " · saving…"
                  : hostWorkspaceStatus === "saved"
                    ? " · saved"
                    : hostWorkspaceStatus === "error"
                      ? " · save failed"
                      : " · unsaved"}
              </div>
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={!sample || !host.workspaces || hostWorkspaceStatus === "saving"}
                title="Save gates, populations, scales, and display settings into the R SingleCellExperiment"
                onClick={() => {
                  void saveHostedWorkspace(
                    "explicit",
                    workspaceEditRevisionRef.current,
                  )
                    .then(({ revision }) => {
                      setImportMsg(`Saved GateLab workspace to SCE · revision ${revision}`);
                    })
                    .catch((cause) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    });
                }}
              >
                Save to SCE{dirty ? " ●" : ""}
              </button>
              {host.capabilities.dataModel.writeBackColumns && host.colData && (
                <button
                  className="gl-btn-ghost gl-btn-block"
                  disabled={
                    !sample ||
                    hostColDataBusy ||
                    Object.keys(state.populations).length <= 1
                  }
                  title="Write exact full-data population memberships into SingleCellExperiment colData"
                  onClick={() => setCrud({ kind: "exportSceColData" })}
                >
                  Export populations to colData…
                </button>
              )}
            </>
          ) : (
            <>
              {wsName && (
                <div className="gl-hint" title={wsName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dirty ? "● " : ""}
                  {wsName}
                  {dirty ? ` (${t("unsaved")})` : ""}
                </div>
              )}
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={busy || !sample || compensationApplyStatus !== null}
                title="Close the current data, gates, and workspace settings and begin an empty workspace"
                onClick={() => setCrud({ kind: "confirmNewWorkspace" })}
              >
                {t("New Workspace…")}
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={busy || compensationApplyStatus !== null}
                title="Open a saved .gatelab workspace, or a FlowJo .wsp — a workspace holds gates rather than data, so GateLab will ask for the FCS files it refers to"
                onClick={openWorkspace}
              >
                {t("Open Workspace…")}
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={!sample}
                title={
                  wsHandle
                    ? wsStorage === "bundle"
                      ? "Save changes in place while preserving the embedded FCS data"
                      : "Save gates/populations/scales/compensation back to the linked workspace file (in place)"
                    : "Choose a location and save the workspace"
                }
                onClick={saveWorkspace}
              >
                {wsHandle ? `${t("Save")}${dirty ? " ●" : ""}` : t("Save Workspace…")}
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={!sample}
                title="Save a lightweight reference workspace. Source FCS and compensated values are not embedded; use Save Portable Copy for a self-contained archive."
                onClick={saveWorkspaceAs}
              >
                {t("Save As…")}
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={!sample}
                title="Save a self-contained .gatelab with the exact source FCS and any computed compensated assay, so it can reopen without rerunning compensation."
                onClick={saveBundledCopy}
              >
                {t("Save Portable Copy…")}
              </button>
            </>
          )}
          <input
            ref={wsRef}
            type="file"
            accept={`.${WORKSPACE_EXT},.wsp`}
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await openWorkspaceFromFile(f, null, f.name);
            }}
          />
          {!sample && importMsg && <div className="gl-hint">{t(importMsg)}</div>}

          {sample && (
            <>
              <div className="gl-side-title" style={{ marginTop: 10 }}>
                {t("Gating")}
              </div>
              <button
                className="gl-btn-ghost gl-btn-block"
                title="Import Gating-ML 2.0 (.xml) or a FlowJo workspace (.wsp), then choose whether to merge into the current hierarchy or replace the current strategy. A workspace also carries population names, which FlowJo's own Gating-ML export omits."
                onClick={() => xmlRef.current?.click()}
              >
                {t("Import gating (GatingML / FlowJo)…")}
              </button>
              <input
                ref={xmlRef}
                type="file"
                accept=".xml,.wsp"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) prepareGatingImport(f);
                  e.target.value = "";
                }}
              />
              {importMsg && <div className="gl-hint">{t(importMsg)}</div>}
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={Object.keys(state.gates).length === 0}
                title="Open the GatingML export dialog: choose standard GateLab/GateLabR or Cytobank-compatible format and review fidelity warnings."
                onClick={() => setGatingMlExportOpen(true)}
              >
                {t("Export GatingML…")}
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                style={{ marginTop: 4 }}
                title="Open the FCS export dialog: choose populations, original/compensated/transformed values, and sample scope."
                onClick={() => setFcsExportOpen(true)}
              >
                {t("Export FCS…")}
              </button>

              <div className="gl-side-title" style={{ marginTop: 10 }}>
                {t("Display")}
              </div>
              <label className="gl-field" title="Downsample the points drawn on the plot. Empty or 0 = plot all events (no downsampling). Counts/percentages always use every event.">
                <span>{t("Max events to plot")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="gl-field-input"
                  placeholder="all"
                  value={maxEvents === 0 ? "" : String(maxEvents)}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/[^0-9]/g, "");
                    setMaxEvents(digits === "" ? 0 : parseInt(digits, 10));
                  }}
                />
              </label>
              <div className="gl-hint">{t("empty = all events (no downsampling)")}</div>
            </>
          )}
        </aside>

        {sample ? (
          <div className="gl-center" role="main" aria-label={t("Plot and analysis tabs")}>
            <div className="gl-tabs" role="tablist">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={"gl-tab" + (activeTab === tab.id ? " active" : "")}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {t(tab.label)}
                </button>
              ))}
            </div>
            {/* Gating tab stays mounted (hidden) so the plot + pan/zoom listeners survive
                tab switches without a re-decode. A render error here is contained to the
                gating view rather than white-screening the whole app. */}
            <ErrorBoundary label="gating">
            <div
              className="gl-gating-tab"
              style={{ display: activeTab === "gating" ? "flex" : "none" }}
            >
            <div className="gl-controls">
              {/* X and Y travel together: on a narrow screen the strip wraps, and
                  splitting the axis pair across two rows reads as unrelated controls. */}
              <div className="gl-axis-pickers">
                <label>
                  X
                  <select value={xIdx} onChange={(e) => setXIdx(+e.target.value)}>
                    {sample.channels.map((_, i) => (
                      <option key={i} value={i}>
                        {sample.channelLabel(i)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Y
                  <select value={yIdx} onChange={(e) => setYIdx(+e.target.value)}>
                    {sample.channels.map((_, i) => (
                      <option key={i} value={i}>
                        {sample.channelLabel(i)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="gl-alpha" title={t("Point opacity")} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                α
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={pointAlpha}
                  onChange={(e) => setPointAlpha(+e.target.value)}
                  style={{ width: 72 }}
                />
              </label>
              <label className="gl-alpha" title={t("Point size")} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                ◦
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  aria-label={t("Point size")}
                  value={pointSize}
                  onChange={(e) => setPointSize(+e.target.value)}
                  style={{ width: 72 }}
                />
              </label>
              {mode === "pseudocolor" && (
                <DensityColourControl value={densityColorPower} onChange={changeDensityColorPower} />
              )}
              <div className="gl-draw-tools">
                {DRAW_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    className={"gl-icon-chip" + (drawMode === tool.id ? " active" : "")}
                    title={t(tool.title)}
                    aria-label={t(tool.title)}
                    onClick={() => setDrawMode(tool.id)}
                  >
                    <tool.Icon />
                  </button>
                ))}
              </div>
              <div className="gl-modes">
                {mode === "contour" && (
                  <label className="gl-contour-outer" title="Outer contour = this % of the peak density">
                    {t("Outer")}
                    <select
                      value={contourThreshold}
                      onChange={(e) => setContourThreshold(+e.target.value)}
                    >
                      {[1, 2, 5, 10, 20, 30].map((v) => (
                        <option key={v} value={v}>
                          {v}%
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={"gl-chip" + (mode === m.id ? " active" : "")}
                    onClick={() => setMode(m.id)}
                  >
                    {t(m.label)}
                  </button>
                ))}
                <span className="gl-ctl-sep" />
                <label className="gl-field-inline" title={GATE_EDGE_MODES.find((m) => m.id === gateEdgeMode)?.hint}>
                  {t("Gate edges")}
                  <select
                    value={gateEdgeMode}
                    onChange={(e) => setGateEdgeMode(e.target.value as GateEdgeMode)}
                  >
                    {GATE_EDGE_MODES.map((m) => (
                      <option key={m.id} value={m.id}>{t(m.label)}</option>
                    ))}
                  </select>
                </label>
                <span className="gl-ctl-sep" />
                <label className="gl-field-inline">
                  {t("Colour by")}
                  <select value={overlayBy} onChange={(e) => setOverlayBy(e.target.value as typeof overlayBy)}>
                    <option value="none">{t("None")}</option>
                    {samples.length > 1 && <option value="sample">{t("Sample")}</option>}
                    <option value="population">{t("Population")}</option>
                    {activeSampleId && compatibleDivisionProfiles[activeSampleId] && <option value="division">{t("Division")}</option>}
                  </select>
                </label>
                {overlayBy !== "none" && (
                  <label className="gl-field-inline">
                    {t("Palette")}
                    <select value={overlayPalette} onChange={(e) => setOverlayPalette(e.target.value as PaletteName)}>
                      {OVERLAY_PALETTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                )}
                <span
                  className={`gl-sample-scope-badge${pendingIncludedGatingIds.size > 0 ? " is-pending" : ""}`}
                  title={[
                    t("Checked files are plotted together; the blue row supplies channels, axes, and editable gates."),
                    ...includedSamples.map((entry) => entry.name),
                    ...(pendingIncludedGatingIds.size === 0
                      ? [
                          t("Selected display contributors: {files}", {
                            files: contributingSampleNames.length
                              ? contributingSampleNames.join(", ")
                              : t("None"),
                          }),
                        ]
                      : []),
                  ].join("\n")}
                >
                  <strong>
                    {includedSamples.length > 1
                      ? t("Pooled display")
                      : includedSamples.length === 1
                        ? t("Single-file display")
                        : t("No checked files")}
                  </strong>
                  {includedSamples.length > 0 &&
                    ` · ${t("{count} checked FCS", { count: includedSamples.length })}`}
                  {pendingIncludedGatingIds.size > 0
                    ? ` · ${t("preparing {count} population masks…", {
                        count: pendingIncludedGatingIds.size,
                      })}`
                    : payload
                      ? ` · ${t("{count} events", {
                          count: payload.n_events.toLocaleString(),
                        })}${includedSamples.length > 1
                          ? ` · ${t("{contributing} of {checked} files contribute", {
                              contributing: contributingSampleCount,
                              checked: includedSamples.length,
                            })}`
                          : ""}`
                      : ""}
                </span>
                <span
                  className="gl-active-sample-key"
                  title={t("Clicking a row makes it active without changing which checked files are pooled.")}
                >
                  {t("Blue: {name}", { name: fileName })}
                </span>
              </div>
            </div>
            <div className="gl-scales gl-ranges">
              <span className="gl-scales-label">{t("Range")}</span>
              {(() => {
                const r3 = (n: number) => Math.round(n * 1000) / 1000;
                const xName = sample.channels[xIdx].key;
                const yName = sample.channels[yIdx].key;
                const effX = xRange ?? globalScales[xName] ??
                  workspaceAutomaticRanges?.xRange ?? payload?.x_range ?? sample.displayRange(xIdx);
                const effY = yRange ?? globalScales[yName] ??
                  workspaceAutomaticRanges?.yRange ?? payload?.y_range ?? sample.displayRange(yIdx);
                return (
                  <>
                    {/* Editing a Range sets the SHARED per-channel scale (globalScales), which the
                        gating plot honours AND the Strategy / Illustration tabs inherit — a
                        transient pan (xRange) is cleared so the typed scale takes effect. */}
                    <div className="gl-range-row">
                      <span className="gl-scale-axis">X</span>
                      <input type="number" step={0.1} value={r3(effX[0])}
                        onChange={(e) => { setGlobalScale(xName, [+e.target.value, effX[1]]); setXRange(null); }} />
                      <span className="gl-range-dash">–</span>
                      <input type="number" step={0.1} value={r3(effX[1])}
                        onChange={(e) => { setGlobalScale(xName, [effX[0], +e.target.value]); setXRange(null); }} />
                    </div>
                    <div className="gl-range-row">
                      <span className="gl-scale-axis">Y</span>
                      <input type="number" step={0.1} value={r3(effY[0])}
                        onChange={(e) => { setGlobalScale(yName, [+e.target.value, effY[1]]); setYRange(null); }} />
                      <span className="gl-range-dash">–</span>
                      <input type="number" step={0.1} value={r3(effY[1])}
                        onChange={(e) => { setGlobalScale(yName, [effY[0], +e.target.value]); setYRange(null); }} />
                    </div>
                  </>
                );
              })()}
              <button
                type="button"
                className="gl-mini-btn"
                title="Fit the current view to the robust event distribution and every gate on these axes"
                onClick={() => {
                  const fitX = includePlotGatesInAxisRange(
                    workspaceAutomaticRanges?.xRange ?? sample.displayRange(xIdx),
                    mainPlotGates,
                    "x",
                  );
                  const fitY = includePlotGatesInAxisRange(
                    workspaceAutomaticRanges?.yRange ?? sample.displayRange(yIdx),
                    mainPlotGates,
                    "y",
                  );
                  setGlobalScale(sample.channels[xIdx].key, fitX);
                  setGlobalScale(sample.channels[yIdx].key, fitY);
                  setXRange(null);
                  setYRange(null);
                }}
              >
                {t("Fit data + gates")}
              </button>
              <button className="gl-tool" title="Reset X/Y to auto range (also clears the shared per-channel scale)"
                aria-label={t("Reset X and Y ranges to auto")}
                onClick={() => {
                  setXRange(null);
                  setYRange(null);
                  setGlobalScale(sample.channels[xIdx].key, null);
                  setGlobalScale(sample.channels[yIdx].key, null);
                }}>⟲</button>
              <span
                className="gl-workspace-scale-badge"
                title={t("Automatic and edited ranges are shared across compatible FCS files in this workspace.")}
              >
                {t("Workspace scales")}
              </span>
              {derived.displayPopCount > 1 && (
                <span className="gl-display-pops-banner">
                  {t("Displaying {count} populations (union)", { count: derived.displayPopCount })}
                </span>
              )}
              <span className="gl-hint" style={{ marginLeft: "auto" }}>
                {t("drag to pan · shift-drag to stretch")}
              </span>
            </div>
            {/* Shown only when a gate on this plot actually curves, and only in the modes where that
                is visible — and dismissible, because it answers a question once. The full explanation
                stays on the control's tooltip, available on demand rather than occupying the plot for
                everyone who already knows. */}
            {!gateEdgeNoteHidden && gateEdgeMode !== "straight"
              && mainPlotGates.some((g) => g.outline) && (
              <div className="gl-hint" style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 6px" }}>
                <span>{t("Straight edges can look curved here \u2014 gates are stored in raw values, so the curve is where the gate really falls. Gating is unchanged.")}</span>
                <button
                  className="gl-chip"
                  style={{ padding: "0 5px", lineHeight: 1.3 }}
                  title={t("Hide this note")}
                  aria-label={t("Hide this note")}
                  onClick={() => setGateEdgeNoteHidden(true)}
                >
                  ×
                </button>
              </div>
            )}
            <div className="gl-scales gl-gating-fonts" aria-label="Gating plot font sizes">
              <span className="gl-scales-label">{t("Fonts")}</span>
              {([
                ["Tick", "tick", 6, 24],
                ["Axis", "axis", 6, 28],
                ["Title", "title", 6, 28],
                ["Gate", "gate", 6, 28],
              ] as const).map(([label, key, min, max]) => (
                <label key={key} className="gl-field-inline">
                  {t(label)}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    value={gatingFontSizes[key]}
                    onChange={(e) => {
                      const requested = Number.parseInt(e.target.value, 10);
                      const next = Number.isFinite(requested)
                        ? Math.max(min, Math.min(max, requested))
                        : DEFAULT_GATING_FONT_SIZES[key];
                      setGatingFontSizes((current) => ({ ...current, [key]: next }));
                    }}
                  />
                </label>
              ))}
              {(sample.isScatterAxis(xIdx) || sample.isScatterAxis(yIdx)) && (
                <div className="gl-scatter-inline">
                  <span className="gl-scales-label">{t("Scatter")}</span>
                  {([
                  ["X", xIdx],
                  ["Y", yIdx],
                ] as const).map(([axis, idx]) => {
                  if (!sample.isScatterAxis(idx)) return null;
                  const isLinear = sample.scatterScale(idx) === "linear";
                  return (
                    <div className="gl-scale-row" key={axis}>
                      <span className="gl-scale-axis">
                        {axis} · {sample.channelLabel(idx)}
                      </span>
                      <select
                        className="gl-scatter-scale"
                        aria-label={`${axis} scatter scale`}
                        title={t("Arcsinh (cofactor 150) renders near-zero and negative scatter that a linear axis cannot. Linear matches how FlowJo and Cytobank display scatter.")}
                        value={isLinear ? "linear" : "arcsinh"}
                        onChange={(e) => {
                          sample.setScatterScale(idx, e.target.value === "linear" ? "linear" : "arcsinh");
                          bumpScales();
                        }}
                      >
                        <option value="arcsinh">{t("Arcsinh")}</option>
                        <option value="linear">{t("Linear")}</option>
                      </select>
                    </div>
                  );
                })}
                </div>
              )}
            </div>
            {(sample.isLogicleChannel(xIdx) || sample.isLogicleChannel(yIdx)) && (
              <div className="gl-scales">
                <span className="gl-scales-label">{t("Logicle W")}</span>
                {([
                  ["X", xIdx],
                  ["Y", yIdx],
                ] as const).map(([axis, idx]) =>
                  sample.isLogicleChannel(idx) ? (
                    <div className="gl-scale-row" key={axis}>
                      <span className="gl-scale-axis">
                        {axis} · {sample.channelLabel(idx)}
                      </span>
                      <input
                        type="range"
                        min={0.1}
                        max={2.0}
                        step={0.05}
                        value={pendingLogicleW[sample.channels[idx].key] ?? sample.currentLogicleW(idx)}
                        onChange={(e) => commitLogicleW(idx, +e.target.value)}
                      />
                      <span className="gl-scale-val">
                        {(pendingLogicleW[sample.channels[idx].key] ?? sample.currentLogicleW(idx)).toFixed(2)}
                      </span>
                      <button
                        className="gl-tool"
                        title={t("Reset to auto-estimated W")}
                        aria-label={`Reset ${axis} logicle W to auto`}
                        onClick={() => {
                          sample.resetLogicleW(idx);
                          bumpScales();
                        }}
                      >
                        A
                      </button>
                    </div>
                  ) : null,
                )}
              </div>
            )}
            {/* Scatter scale — same shape and placement as Logicle W, and shown only for
                flow scatter axes. CyTOF is excluded deliberately: arcsinh cofactor 5 is the
                field convention and is not offered as a choice. Gates live in raw space for
                flow, so nothing here moves a gate; it only changes what the axis looks like. */}
            <div
              className="gl-plot-area"
              ref={plotAreaRef}
              style={{ cursor: drawMode === "navigate" ? "grab" : "crosshair" }}
            >
              <GatingPlot
                payload={displayed}
                mode={drawMode}
                visible={activeTab === "gating"}
                interactionToken={plotInteractionToken ?? undefined}
                fontSizes={gatingFontSizes}
                onNewGate={(g) => {
                  if (!plotInteractionIsCurrent()) return;
                  // cytof reports the drawn gate's channels as DISPLAY labels — translate back to
                  // identity keys so the gate stores/masks in identity space.
                  const gg = g as NewGate;
                  gg.x_channel = sample.keyForLabel(gg.x_channel);
                  gg.y_channel = sample.keyForLabel(gg.y_channel);
                  if (!activeSampleId) return;
                  setPending({
                    gate: gg,
                    sampleId: activeSampleId,
                    dataRevision: sample.dataRevision,
                    coordinateBindingKeys: [
                      sample.displayCoordinateBindingKey(gg.x_channel),
                      sample.displayCoordinateBindingKey(gg.y_channel),
                    ],
                  });
                  setDrawMode("navigate"); // drawing done → back to navigate (like GateLabR)
                }}
                onGateEdit={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  // Dragged poly/rect vertices come back in DISPLAY space on the current axes;
                  // convert to gating space via the gate's stored channel keys, then persist.
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type === "quadrant") return;
                  const verts = e.vertices.map(
                    ([vx, vy]) =>
                      [sample.displayToGating(g.x_channel, vx), sample.displayToGating(g.y_channel, vy)] as [number, number],
                  );
                  dispatch({ type: "editGate", gateId: e.gate_id, vertices: verts });
                }}
                onQuadrantMove={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type !== "quadrant") return;
                  dispatch({
                    type: "moveQuadrantCenter",
                    gateId: e.gate_id,
                    center: [sample.displayToGating(g.x_channel, e.center[0]), sample.displayToGating(g.y_channel, e.center[1])],
                  });
                }}
                onGateSelect={(id) => {
                  if (!plotInteractionIsCurrent()) return;
                  uiDispatch({ type: "selectGate", gateId: id });
                }}
                onAxisLabelClick={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const idx = sample.index(sample.keyForLabel(e.selected));
                  if (idx === undefined) return;
                  if (e.axis === "x") setXIdx(idx);
                  else setYIdx(idx);
                }}
                onRangeChange={(e) => {
                  // The renderer panned or stretched itself and is telling us where it ended up. Commit
                  // it exactly as GateLab's own pan does, or the next payload -- a gate edit, a label
                  // move, even switching how edges are drawn -- carries the old range and snaps the view
                  // back to it, with the contours left at a geometry nothing else agrees with.
                  if (!plotInteractionIsCurrent() || !sample) return;
                  const ok = (r: [number, number]) => r?.length === 2 && r.every(Number.isFinite) && r[0] !== r[1];
                  if (!ok(e.x_range) || !ok(e.y_range)) return;
                  setGlobalScale(sample.channels[xIdx].key, e.x_range);
                  setGlobalScale(sample.channels[yIdx].key, e.y_range);
                  setXRange(null);
                  setYRange(null);
                }}
                onGateLabelMove={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  dispatch({ type: "moveGateLabel", gateId: e.gate_id, labelOffset: e.label_offset });
                }}
              />
            </div>
            {overlayLegend && (
              <div
                className="gl-overlay-legend"
                style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: "6px 10px 2px", fontSize: 11, alignItems: "center" }}
              >
                {overlayLegend.map((e, i) => (
                  <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 11, height: 11, borderRadius: 2, background: e.color, display: "inline-block", flex: "0 0 auto" }} />
                    {e.label}
                  </span>
                ))}
              </div>
            )}
            </div>
            </ErrorBoundary>
            {/* One boundary for the conditionally-mounted data tabs, keyed by activeTab so a
                crashed tab clears itself when you switch away (Shiny-like per-panel isolation). */}
            <ErrorBoundary key={activeTab} label={activeTab}>
            {activeTab === "statistics" && (
              <StatsTab
                samples={includedSamples}
                activeSampleId={activeSampleId}
                state={state}
                derived={derived}
                defaultChannels={[sample.channels[xIdx].key, sample.channels[yIdx].key]}
                dataRevisionKey={sampleDataRevisionKey}
              />
            )}
            {activeTab === "proportions" && (
              <ProportionsTab
                samples={includedSamples}
                activeSampleId={activeSampleId}
                state={state}
                derived={derived}
                metadata={metadata}
                metadataColumns={metadataColumns}
                divisionProfiles={compatibleDivisionProfiles}
                dataRevisionKey={sampleDataRevisionKey}
              />
            )}
            {activeTab === "division" && (
              <DivisionTab
                key={activeSampleId ?? "none"}
                sample={sample}
                sampleName={fileName}
                derived={derived}
                savedProfile={activeSampleId ? compatibleDivisionProfiles[activeSampleId] ?? null : null}
                profileStale={!!activeSampleId && !!divisionProfiles[activeSampleId] && !compatibleDivisionProfiles[activeSampleId]}
                onApply={applyDivision}
                onWriteToHost={isSceHost && host.colData ? writeHostedDivisions : undefined}
                hostWriteBusy={hostAdapterWriteBusy}
                dataRevision={activeDataRevision}
              />
            )}
            {activeTab === "metadata" && (
              <MetadataTab
                samples={samples}
                metadata={metadata}
                columns={metadataColumns}
                onSetCell={setMetadataCell}
                onAddColumn={addMetadataColumn}
                onRenameColumn={renameMetadataColumn}
                onDeleteColumn={deleteMetadataColumn}
                onImport={importMetadata}
                populationRows={populationRows}
                populationMetadata={populationMetadata}
                populationColumns={populationMetaColumns}
                onSetPopCell={setPopMetaCell}
                onAddPopColumn={addPopMetaColumn}
                onRenamePopColumn={renamePopMetaColumn}
                onDeletePopColumn={deletePopMetaColumn}
                onWriteSampleMetadataToHost={
                  isSceHost && host.colData ? writeHostedSampleMetadata : undefined
                }
                hostWriteBusy={hostAdapterWriteBusy}
              />
            )}
            {activeTab === "panel" && (
              <PanelTab
                key={panelVersion}
                sample={sample}
                onRename={renameChannel}
                onRenameMany={renameChannels}
                onResetAll={resetAllLabels}
                onWriteToHost={
                  isSceHost && host.rowData ? writeHostedPanel : undefined
                }
                hostWriteBusy={hostAdapterWriteBusy}
              />
            )}
            {activeTab === "scales" && (
              <ScalesTab
                sample={sample}
                globalScales={globalScales}
                onSetGlobalScale={setGlobalScale}
              />
            )}
            {activeTab === "strategy" && (
              <StrategyTab
                sample={sample}
                state={state}
                derived={derived}
                globalScales={globalScales}
                configRef={strategyConfigRef}
                dataRevision={activeDataRevision}
                densityColorPower={densityColorPower}
                onDensityColorPowerChange={changeDensityColorPower}
              />
            )}
            {activeTab === "illustration" && (
              <IllustrationTab
                key={illustVersion}
                sample={sample}
                sampleViews={illustrationSampleViews}
                activeSampleId={activeSampleId}
                checkedSampleCount={includedSamples.length}
                pendingSampleCount={pendingIncludedGatingIds.size}
                state={state}
                derived={derived}
                globalScales={globalScales}
                defaultX={sample.channels[xIdx].key}
                defaultY={sample.channels[yIdx].key}
                configRef={illustConfigRef}
                presets={illustrationPresets}
                onSavePreset={saveIllustrationPreset}
                onDeletePreset={deleteIllustrationPreset}
                onConfigChange={markWorkspaceDirty}
                dataRevision={activeDataRevision}
                densityColorPower={densityColorPower}
                onDensityColorPowerChange={changeDensityColorPower}
              />
            )}
            </ErrorBoundary>
            {/* Mount on first visit, then retain only CompensationTab's lightweight state keeper
                off-tab. The matrix/gallery/canvas subtree is removed while gating stays active. */}
            {compensationTabMounted && <ErrorBoundary label="compensation">
              <Suspense fallback={<div className="gl-empty">{t("Loading compensation tools…")}</div>}>
                <CompensationTab
                  key={compensationTabStateKey}
                  sample={sample}
                  sampleName={fileName}
                  hostedCompensationMatrix={hostDatasetDescriptor?.compensationMatrix}
                  compensationOn={compensationOn}
                  onApplyProfile={applyCompensationProfile}
                  existingHostAssays={hostExistingCompensatedAssays}
                  onAdoptExistingAssay={
                    isSceHost && host.compensation
                      ? adoptExistingCompensationAssay
                      : undefined
                  }
                  onCancelApply={cancelCompensationApply}
                  hasExistingGates={Object.keys(state.gates).length > 0}
                  applyStatus={compensationApplyStatus}
                  installedProfile={activeCompensationProfile}
                  applyTargetCount={sample.instrument === "cytof" ? includedSamples.length : 1}
                  applyTargetEventCount={sample.instrument === "cytof"
                    ? includedSamples.reduce((total, entry) => total + entry.sample.fcs.nEvents, 0)
                    : sample.fcs.nEvents}
                  applyWorkerCount={compensationWorkerCount}
                  applyWorkerLimit={compensationWorkerLimit}
                  onApplyWorkerCountChange={changeCompensationWorkerCount}
                  installedBaselineProfile={activeCompensationBaseline}
                  reviewPopulations={compensationReviewPopulations}
                  reviewPopulationMasks={derived.masks}
                  onPreviewCompensationCandidate={previewCompensationCandidate}
                  onSolveCompensationSweep={solveCompensationSweep}
                  onCancelCompensationSweep={cancelCompensationSweep}
                  onSuspendBackgroundWork={suspendCompensationBackgroundWork}
                  visible={activeTab === "compensation"}
                  stateKey={compensationTabStateKey}
                  densityColorPower={densityColorPower}
                  onDensityColorPowerChange={changeDensityColorPower}
                />
              </Suspense>
            </ErrorBoundary>}
          </div>
        ) : (
          <div className="gl-center gl-empty" role="main" aria-label={t("Plot and analysis tabs")}>
            <p>{t("Open an FCS file to begin.")}</p>
          </div>
        )}

        <aside
          className="gl-side"
          style={{ width: sideWidth, display: activeTab === "compensation" ? "none" : undefined }}
          aria-label={t("Gates and populations")}
        >
          <div className="gl-side-resize" onMouseDown={startResize} title="Drag to resize" />
          <div className="gl-side-section">
            <div className="gl-side-head">
              <div className="gl-side-title">{t("Gates")}</div>
              <GateToolbar
                state={state}
                dispatch={dispatch}
                onRename={() => {
                  const g = state.selected_gate_id && state.gates[state.selected_gate_id];
                  if (g) setCrud({ kind: "renameGate", id: g.gate_id, initial: g.name });
                }}
                onDelete={(ids) => ids.length && setCrud({ kind: "confirmDelete", what: "gates", ids })}
              />
            </div>
            <GateList state={state} derived={derived} dispatch={uiDispatch} labelForKey={(k) => sample?.labelForKey(k) ?? k} />
          </div>
          <div className="gl-side-section gl-side-grow">
            <div className="gl-side-head">
              <div className="gl-side-title">{t("Populations")}</div>
              <label
                className="gl-branch-gates-toggle"
                title={t("Draw only the gates belonging to the displayed branch — the gates on the current population and its descendants, or, once a gate is selected, that gate's own sub-branch. Unchecked draws every gate sharing the plot's channels, which is how thresholds set on different branches are compared.")}
              >
                <input
                  type="checkbox"
                  checked={branchGatesOnly}
                  onChange={(e) => setBranchGatesOnly(e.target.checked)}
                />
                {t("Branch gates")}
              </label>
              <PopToolbar
                state={state}
                dispatch={dispatch}
                onAdd={() => setCrud({ kind: "createPop" })}
                onRename={() => {
                  const p = state.active_population_id && state.populations[state.active_population_id];
                  if (p) setCrud({ kind: "editPop", id: p.population_id });
                }}
                onDelete={(ids) => ids.length && setCrud({ kind: "confirmDelete", what: "pops", ids })}
                onDuplicate={(ids) => ids.length && dispatch({ type: "duplicateSelectedPopulations", popIds: ids })}
                onMove={(ids) => ids.length && setCrud({ kind: "movePops", ids })}
                onBulkRename={() => setCrud({ kind: "bulkRename" })}
              />
            </div>
            <div
              id="population_tree_container"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                e.preventDefault();
                const order = populationTreeOrder(state.populations, state.root_population_id).map((o) => o.popId);
                if (order.length === 0) return;
                const cur = Math.max(0, order.indexOf(state.active_population_id ?? order[0]));
                const next = e.key === "ArrowDown" ? Math.min(order.length - 1, cur + 1) : Math.max(0, cur - 1);
                if (next !== cur) {
                  dispatch({ type: "setActivePopulation", popId: order[next] });
                  requestAnimationFrame(() =>
                    document.querySelector(`.pop-row[data-pop-id="${order[next]}"]`)?.scrollIntoView({ block: "nearest" }),
                  );
                }
              }}
            >
              <PopulationTree
                state={state}
                derived={populationTreeDerived}
                dispatch={uiDispatch}
                statsPending={populationStatsPending}
                statsSampleCount={includedSamples.length}
                displayContributorCount={
                  pendingIncludedGatingIds.size === 0 ? contributingSampleCount : undefined
                }
                displayContributorNames={
                  pendingIncludedGatingIds.size === 0 ? contributingSampleNames : undefined
                }
              />
            </div>
          </div>
        </aside>
      </div>

      {pendingWorkspaceRelink && (
        <WorkspaceRelinkModal
          requirements={pendingWorkspaceRelink.requirements}
          folderSelectionAvailable={supportsDirectoryAccess()}
          scanning={workspaceRelinkScanning}
          error={workspaceRelinkError}
          onChoose={() => void choosePendingWorkspaceRelinkFolder()}
          onCancel={cancelPendingWorkspaceRelink}
        />
      )}

      {sampleManagerOpen && (
        <SampleManagerModal
          items={sampleListItems}
          activeId={activeSampleId}
          excludedIds={excludedSampleIds}
          initialSelectedIds={sampleManagerSelection}
          onClose={() => {
            setSampleManagerOpen(false);
            setSampleManagerSelection([]);
          }}
          onActivate={selectSample}
          onToggleIncluded={setSampleIncluded}
          onIncludeAll={includeAllSamples}
          onIncludeNone={includeNoSamples}
          onInvertIncluded={invertIncludedSamples}
          onRemove={async (ids) => {
            await removeSamples(ids);
            setSampleManagerSelection([]);
          }}
        />
      )}

      {pendingFolderImport && (
        <FolderImportModal
          folderName={pendingFolderImport.folderName}
          items={folderImportItems}
          onCancel={() => setPendingFolderImport(null)}
          onImport={(ids) => {
            const selected = new Set(ids);
            const candidates = pendingFolderImport.candidates.filter((candidate) => selected.has(candidate.id));
            setPendingFolderImport(null);
            void importFcsCandidates(candidates);
          }}
        />
      )}

      {pending && sample && state.root_population_id && (
        <GateModals
          pending={pending.gate}
          sample={sample}
          populations={state.populations}
          activePopId={state.active_population_id}
          rootPopId={state.root_population_id}
          nGates={Object.keys(state.gates).length}
          onCancel={() => setPending(null)}
          onConfirm={(a) => {
            if (
              pending.sampleId !== activeSampleId ||
              pending.dataRevision !== sample.dataRevision ||
              pending.coordinateBindingKeys[0] !== sample.displayCoordinateBindingKey(pending.gate.x_channel) ||
              pending.coordinateBindingKeys[1] !== sample.displayCoordinateBindingKey(pending.gate.y_channel)
            ) {
              setPending(null);
              setError("The data layer or display transform changed while the gate dialog was open. Please draw the gate again.");
              return;
            }
            uiDispatch(a);
            setPending(null);
          }}
        />
      )}

      {crud?.kind === "createPop" && (
        <CreatePopModal
          state={state}
          onCancel={() => setCrud(null)}
          onConfirm={(a) => {
            dispatch(a);
            setCrud(null);
          }}
        />
      )}
      {crud?.kind === "renameGate" && (
        <RenameModal
          title="Rename Gate"
          initial={crud.initial}
          onCancel={() => setCrud(null)}
          onConfirm={(name) => {
            dispatch({ type: "renameGate", gateId: crud.id, name });
            setCrud(null);
          }}
        />
      )}
      {crud?.kind === "editPop" && (
        <EditPopModal
          state={state}
          popId={crud.id}
          onCancel={() => setCrud(null)}
          onConfirm={(a) => {
            dispatch(a);
            setCrud(null);
          }}
        />
      )}
      {crud?.kind === "confirmNewWorkspace" && (
        <ConfirmModal
          title="Start a new workspace?"
          message={
            dirty || !wsHandle
              ? "This closes the current samples, gates, populations, and settings. Unsaved work will no longer be in the current view; GateLab will keep a local recovery checkpoint. Save first if you want a normal workspace file."
              : `Close ${wsName || "the current workspace"} and begin with an empty workspace? The saved file will not be changed.`
          }
          confirmLabel="Start New Workspace"
          onCancel={() => setCrud(null)}
          onConfirm={() => void startNewWorkspace()}
        />
      )}
      {crud?.kind === "confirmDelete" && (
        <ConfirmModal
          title={crud.what === "gates" ? "Delete gates?" : "Delete populations?"}
          message={
            crud.what === "gates"
              ? `Delete ${crud.ids.length} gate${crud.ids.length === 1 ? "" : "s"}? Populations that use only these gates are removed too. This can be undone.`
              : `Delete ${crud.ids.length} population${crud.ids.length === 1 ? "" : "s"}? Their children are reparented upward; gates are kept. This can be undone.`
          }
          onCancel={() => setCrud(null)}
          onConfirm={async () => {
            await checkpointCurrentWorkspace(
              crud.what === "gates" ? "before-gate-delete" : "before-population-delete",
            );
            dispatch(crud.what === "gates" ? { type: "deleteGates", gateIds: crud.ids } : { type: "deletePopulations", popIds: crud.ids });
            setCrud(null);
          }}
        />
      )}
      {crud?.kind === "movePops" && (
        <MovePopsModal
          state={state}
          ids={crud.ids}
          onCancel={() => setCrud(null)}
          onConfirm={(parentId) => {
            dispatch({ type: "moveSelectedPopulations", popIds: crud.ids, parentId });
            setCrud(null);
          }}
        />
      )}
      {crud?.kind === "bulkRename" && (
        <BulkRenameModal
          state={state}
          onCancel={() => setCrud(null)}
          onConfirm={(updates) => {
            dispatch({ type: "bulkEditPopulations", updates });
            setCrud(null);
          }}
        />
      )}
      {treePicker && (
        <div className="gl-modal-backdrop" onClick={() => setTreePicker(null)}>
          <div
            className="gl-modal gl-wsp-picker"
            role="dialog"
            aria-label="Choose a gating tree"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gl-modal-title">{t("Choose a gating strategy")}</div>
            <div className="gl-modal-note">
              {t("This sample holds several independent strategies. GateLab holds one at a time, so importing them together would merge trees FlowJo kept apart.")}
            </div>
            <div className="gl-wsp-list">
              {treePicker.sample.trees.map((tree) => (
                <button
                  key={tree.index}
                  className="gl-wsp-row"
                  onClick={() => {
                    const picked = treePicker;
                    setTreePicker(null);
                    void importFlowJoSample(picked.text, picked.sample, picked.matchedOn, tree.index);
                  }}
                >
                  <span className="gl-wsp-name">{tree.name || `(unnamed tree ${tree.index + 1})`}</span>
                  <span className="gl-wsp-meta">
                    {tree.gateCount} {t("gates")}
                    {tree.rootCount !== null ? ` · ${tree.rootCount.toLocaleString()} ${t("events")}` : ""}
                    {tree.unsupportedCount > 0 ? ` · ${tree.unsupportedCount} ${t("skipped")}` : ""}
                    {tree.populations.length ? ` · ${tree.populations.slice(0, 4).join(", ")}${tree.populations.length > 4 ? "…" : ""}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <div className="gl-modal-actions">
              <button onClick={() => setTreePicker(null)}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {flowJoOpen && (() => {
        // Resolve against everything available right now: the samples already open plus the
        // files chosen in this dialog. Recomputed on render so adding files updates the list.
        const resolutions = resolveFlowJoWorkspaceFiles(
          flowJoOpen.samples,
          [...samples.map((s0) => s0.name), ...flowJoOpen.pending.map((f) => f.name)],
        );
        const found = resolutions.filter((r) => r.fileName !== null).length;
        const chosen = flowJoOpen.samples.find((x) => x.index === flowJoOpen.strategySample);
        const chosenResolved = resolutions.find((r) => r.sampleIndex === flowJoOpen.strategySample)?.fileName;
        return (
          <div className="gl-modal-backdrop" onClick={() => setFlowJoOpen(null)}>
            <div
              className="gl-modal gl-wsp-picker"
              role="dialog"
              aria-label="Open a FlowJo workspace"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="gl-modal-title">{t("Open FlowJo workspace")} · {flowJoOpen.fileName}</div>
              <div className="gl-modal-note">
                {t("A workspace holds gates, not data. Choose the FCS files it refers to; any it cannot find are skipped.")}
                {" "}
                <strong>{found}/{flowJoOpen.samples.length}</strong> {t("found")}
              </div>

              <div className="gl-wsp-list">
                {flowJoOpen.samples.map((x) => {
                  const r = resolutions.find((q) => q.sampleIndex === x.index);
                  const isStrategy = x.index === flowJoOpen.strategySample;
                  return (
                    <button
                      key={x.index}
                      className="gl-wsp-row"
                      aria-pressed={isStrategy}
                      style={isStrategy ? { outline: "2px solid var(--gl-accent, #2563eb)" } : undefined}
                      onClick={() => setFlowJoOpen({ ...flowJoOpen, strategySample: x.index, strategyTree: null })}
                    >
                      <span className="gl-wsp-name">
                        {x.name || `(unnamed sample ${x.index + 1})`}
                        {x.duplicateName && <span className="gl-wsp-dupe">{t("position")} {x.index + 1}</span>}
                      </span>
                      <span className="gl-wsp-meta">
                        {r?.fileName
                          ? `${t("found")}: ${r.fileName}`
                          : `${t("not found")} — ${x.candidateFileNames.join(" / ")}`}
                        {` · ${x.gateCount} ${t("gates")}`}
                        {x.rootCount > 1 ? ` · ${x.rootCount} ${t("trees")}` : ""}
                        {isStrategy ? ` · ${t("strategy to import")}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>

              {chosen && chosen.trees.length > 1 && (
                <div className="gl-modal-note">
                  {t("This sample holds several strategies; choose one")}:{" "}
                  <select
                    value={flowJoOpen.strategyTree ?? ""}
                    onChange={(e) => setFlowJoOpen({
                      ...flowJoOpen,
                      strategyTree: e.target.value === "" ? null : Number(e.target.value),
                    })}
                  >
                    <option value="">{t("Choose…")}</option>
                    {chosen.trees.map((tree) => (
                      <option key={tree.index} value={tree.index}>
                        {tree.name} — {tree.gateCount} {t("gates")}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="gl-modal-actions">
                <button onClick={() => void chooseFlowJoFcs(flowJoOpen)}>{t("Choose FCS files…")}</button>
                <button onClick={() => setFlowJoOpen(null)}>{t("Cancel")}</button>
                <button
                  disabled={!chosenResolved || (!!chosen && chosen.trees.length > 1 && flowJoOpen.strategyTree === null)}
                  title={chosenResolved ? undefined : t("The FCS for the selected strategy has not been found yet")}
                  onClick={() => void completeFlowJoOpen(flowJoOpen)}
                >
                  {t("Import")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {wspPicker && (
        <div className="gl-modal-backdrop" onClick={() => setWspPicker(null)}>
          <div
            className="gl-modal gl-wsp-picker"
            role="dialog"
            aria-label="Choose a FlowJo sample"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gl-modal-title">{t("Choose a sample from the workspace")}</div>
            <div className="gl-modal-note">{wspPicker.reason}</div>
            <div className="gl-wsp-list">
              {wspPicker.samples.map((s) => (
                <button
                  key={s.index}
                  className="gl-wsp-row"
                  onClick={() => {
                    const chosen = s;
                    setWspPicker(null);
                    void importFlowJoSample(wspPicker.text, chosen);
                  }}
                >
                  <span className="gl-wsp-name">
                    {s.name || `(unnamed sample ${s.index + 1})`}
                    {/* Position disambiguates two entries that share a name — the case that
                        previously resolved to whichever came first. */}
                    {s.duplicateName && (
                      <span className="gl-wsp-dupe">{t("position")} {s.index + 1}</span>
                    )}
                  </span>
                  <span className="gl-wsp-meta">
                    {s.gateCount} {t("gates")}
                    {s.eventCount !== null ? ` · ${s.eventCount.toLocaleString()} ${t("events")}` : ""}
                    {s.owningGroup ? ` · ${s.owningGroup}` : ""}
                    {s.rootCount > 1 ? ` · ${s.rootCount} ${t("trees")}` : ""}
                    {s.unsupportedCount > 0
                      ? ` · ${s.unsupportedCount} ${t("unreadable")}`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
            <div className="gl-modal-actions">
              <button className="gl-tool" onClick={() => setWspPicker(null)}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {pendingGatingMlImport && (
        <GatingMlImportModal
          nGates={pendingGatingMlImport.result.n_gates_imported}
          nPopulations={pendingGatingMlImport.result.n_pops_imported}
          sourceLabel={
            pendingGatingMlImport.result.source === "gatelabr"
              ? "a GateLab / GateLabR export"
              : pendingGatingMlImport.result.source === "cytobank"
                ? "a Cytobank Gating-ML file"
                : "a Gating-ML file"
          }
          currentRootName={
            state.root_population_id
              ? state.populations[state.root_population_id]?.name ?? "the current root"
              : "the current root"
          }
          hasExistingStrategy={
            state.root_population_id !== null && hasGatingStrategy({
              gates: state.gates,
              populations: state.populations,
              root_population_id: state.root_population_id,
            })
          }
          mergeBlockedReason={pendingGatingMlImport.mergeBlockedReason}
          compensationNote={pendingGatingMlImport.compensationNote}
          matrixChoice={
            pendingGatingMlImport.externalSpillover?.differsFromEmbedded
              ? {
                  workspaceLabel: pendingGatingMlImport.externalSpillover.label,
                  maxDelta: pendingGatingMlImport.externalSpillover.maxDelta ?? 0,
                  value: pendingGatingMlImport.matrixChoice,
                }
              : null
          }
          onMatrixChoice={(value) =>
            setPendingGatingMlImport((cur) => cur && { ...cur, matrixChoice: value })
          }
          compensationNeedsConfirmation={pendingGatingMlImport.compensation.requiresConfirmation}
          onCancel={() => {
            setPendingGatingMlImport(null);
            setImportMsg("Gating-ML import cancelled; the current strategy was not changed.");
          }}
          onImport={applyGatingImport}
        />
      )}
      {crud?.kind === "exportSceColData" && isSceHost && (
        <SceColDataExportModal
          state={state}
          existingColumns={hostColDataColumns}
          initialPopulationIds={
            state.selected_pop_ids.length > 0
              ? state.selected_pop_ids
              : state.active_population_id
                ? [state.active_population_id]
                : []
          }
          busy={hostColDataBusy}
          onCancel={() => {
            if (!hostColDataBusy) setCrud(null);
          }}
          onExport={(columns, overwrite) => {
            void exportHostedPopulationColumns(columns, overwrite);
          }}
        />
      )}
      {fcsExportOpen && sample && (
        <FcsExportModal
          state={state}
          samples={samples.map((entry) => ({
            id: entry.id,
            name: entry.name,
            eventCount: entry.sample.fcs.nEvents,
            active: entry.id === activeSampleId,
            checked: !excludedSampleIds.has(entry.id),
            populationEventCounts: exportPopulationCountsBySample.get(entry.id) ?? null,
          }))}
          combinedCompatibility={combinedFcsCompatibility}
          initialPopIds={
            state.selected_pop_ids.length > 0
              ? state.selected_pop_ids
              : state.active_population_id
                ? [state.active_population_id]
                : []
          }
          initialAssay={fcsAssay}
          initialScope={fcsScope}
          initialMinimumEvents={fcsMinimumEvents}
          onCancel={() => setFcsExportOpen(false)}
          onExport={(popIds, assay, scope, minimumEvents) => {
            setFcsAssay(assay);
            setFcsScope(scope);
            setFcsMinimumEvents(minimumEvents);
            if (exportFcs(assay, scope, popIds, minimumEvents)) {
              setFcsExportOpen(false);
            }
          }}
        />
      )}
      {gatingMlExportOpen && sample && (
        <GatingMlExportModal
          state={state}
          onCancel={() => setGatingMlExportOpen(false)}
          onExport={(format) => {
            exportGating(format);
            setGatingMlExportOpen(false);
          }}
        />
      )}
    </div>
  );
}
