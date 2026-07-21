// App.tsx — Step 3: FCS → gate drawing → gate list + population tree (reproduced from
// GateLabR) with live counts. Drawing a gate opens the name/population modal; the plot
// shows the active population's events plus its gates (display space).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import pkg from "../package.json";
import { clearPersistedTabState } from "./ui/tabState";
import { DEFAULT_GATING_FONT_SIZES, GatingPlot, type NewGate } from "./plots/GatingPlot";
import { buildPlotGates, type PlotGate } from "./plots/gatePayload";
import { includePlotGatesInAxisRange } from "./engine/axisRange";
import { parseFcs } from "./engine/fcs";
import { Sample, type DisplayMode, type OverlaySpec } from "./engine/sample";
import { populationTreeOrder } from "./engine/populations";
import { resolvePartitionLevels, partitionAssign } from "./engine/factors";
import { paletteColors, populationColor, UNGATED_COLOR, OVERLAY_PALETTES, type PaletteName } from "./engine/palettes";
import { assignDivisionLevel, divisionPalette } from "./engine/division";
import { encodeFloat32Base64, encodeUint8Base64 } from "./engine/encode";
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
import { exportPopulationFcs, exportPopulationFcsCombined, sanitizeFcsName, sanitizeFilePart, type FcsExportAssay } from "./engine/fcsExport";
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
  pickFile,
  pickFileSource,
  pickFiles,
  pickDirectoryFiles,
  writeHandle,
  writeHandleStream,
  saveAsHandle,
  saveAsHandleStream,
  readFromHandle,
  rememberHandle,
  recallHandle,
} from "./engine/fsAccess";
import {
  AUTO_CHECKPOINT_INTERVAL_MS,
  requestPersistentWorkspaceHistory,
  saveWorkspaceCheckpoint,
  type WorkspaceCheckpointReason,
} from "./engine/workspaceHistory";
import {
  coreReducer,
  initialCoreState,
  derivePopulationView,
  recompute,
  recomputeGating,
  type Action,
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
import {
  CompensationTab,
  type CompensationApplyUiStatus,
  type CompensationCandidatePreviewSolver,
  type CompensationSweepSolver,
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
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { NavigateIcon, RectIcon, PolyIcon, QuadIcon } from "./ui/icons";
import { useSampleDataRevisionKey } from "./ui/useSampleDataRevisions";
import { useContextualGlobalScales } from "./ui/useContextualGlobalScales";
import {
  DEFAULT_DENSITY_COLOR_POWER,
  normalizeDensityColorPower,
} from "./engine/pseudocolor";
import { DensityColourControl } from "./ui/DensityColourControl";

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
  | { kind: "bulkRename" };

type DrawMode = "navigate" | "draw-rect" | "draw-poly" | "draw-quadrant";
type LiveWorkspaceFile = WorkspaceFile | WorkspaceFileV3;

interface PendingGatingMLImport {
  result: GatingMLResult;
  compensation: GatingMLCompensationResolution;
  sampleId: string;
  mergeBlockedReason: string | null;
  compensationNote: string | null;
}

interface PendingNewGate {
  gate: NewGate;
  sampleId: string;
  dataRevision: number;
  coordinateBindingKeys: readonly [string, string];
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
  bytes: Uint8Array; // original FCS bytes (workspace bundling / re-parse)
  handle: FileSystemFileHandle | null; // File System Access handle (reference workspaces)
  sourcePath?: string; // display-only path below a folder selected during this session
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

export default function App() {
  // Multiple samples share ONE gating tree (FlowJo-style): add/remove freely, one is active.
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const sampleDataRevisionKey = useSampleDataRevisionKey(samples);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [pendingFolderImport, setPendingFolderImport] = useState<PendingFolderImport | null>(null);
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
  const compensationApplyGuardRef = useRef(false);
  const compensationRestoreCancelledRef = useRef(false);
  const [compensationApplyStatus, setCompensationApplyStatus] =
    useState<CompensationApplyUiStatus | null>(null);
  const [scaleCacheEpoch, setScaleCacheEpoch] = useState(0);
  const [dirty, setDirty] = useState(false);
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
  const [panelVersion, setPanelVersion] = useState(0); // bumps when a channel display label changes
  const [crud, setCrud] = useState<CrudModal | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(INITIAL_LEFT_PANE_WIDTH);
  const [sideWidth, setSideWidth] = useState(INITIAL_RIGHT_PANE_WIDTH);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [yRange, setYRange] = useState<[number, number] | null>(null);
  const [maxEvents, setMaxEvents] = useState(50000); // 0 = all (no downsampling)
  const [activeTab, setActiveTab] = useState<TabId>("gating");
  const [pointAlpha, setPointAlpha] = useState(0.4); // main-plot point opacity (cytof point_alpha)
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
  const [fcsScope, setFcsScope] = useState<"active" | "combined" | "split">("active");
  const [fcsExportOpen, setFcsExportOpen] = useState(false);
  const [pendingGatingMlImport, setPendingGatingMlImport] = useState<PendingGatingMLImport | null>(null);
  const [gatingMlExportOpen, setGatingMlExportOpen] = useState(false);
  const [contourThreshold, setContourThreshold] = useState(5); // outer contour % of peak
  const [instrumentMode, setInstrumentMode] = useState<"auto" | "flow" | "cytof">("auto"); // active sample's instrument override
  // Colour-by-factor overlay on the main plot (population partition / division level).
  const [overlayBy, setOverlayBy] = useState<"none" | "population" | "division">("none");
  const [overlayPalette, setOverlayPalette] = useState<PaletteName>("default");
  const [overlaySamples, setOverlaySamples] = useState(false); // overlay all loaded samples on the plot
  const activeDisplayContextKey = sample?.displayTransformContextKey ?? null;
  // Fixed ranges are retained per exact assay/transform context rather than destroyed or reused
  // in incompatible coordinates when the active layer changes.
  const { globalScales, setGlobalScales, preserveScalesForContext } =
    useContextualGlobalScales(activeDisplayContextKey, scaleCacheEpoch);
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

  // Reset the view range when the sample or displayed channel changes (→ auto range).
  useEffect(() => setXRange(null), [sample, xIdx, activeDataRevision]);
  useEffect(() => setYRange(null), [sample, yIdx, activeDataRevision]);

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
      if (t.closest?.(".saved-gate, .cytof-xlabel, .cytof-ylabel")) return;
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

  // Mark the workspace dirty on any edit (skipped once per load/save, which set skipDirtyRef).
  useEffect(() => {
    if (skipDirtyRef.current) {
      skipDirtyRef.current = false;
      return;
    }
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.gate_version, scalesVersion, sampleDataRevisionKey, instrumentMode, globalScales, mode, maxEvents, contourThreshold, densityColorPower, xIdx, yIdx, gatingFontSizes, workspaceCompensation]);

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
      setError("Wait for the current compensation Apply to finish, or cancel it, before starting a new workspace.");
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
    setScalesVersion((version) => version + 1);
    setPanelVersion((version) => version + 1);
    setOverlayBy("none");
    setOverlayPalette("default");
    setOverlaySamples(false);

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
      const pnnMap: Record<string, string> = {};
      for (const c of sample.channels) pnnMap[c.pnn] = c.key;
      const res = importGatingML(text, sample.channels.map((c) => c.key), pnnMap);
      const comp = resolveGatingMLCompensation(
        res.compensation,
        res.compensation_refs,
        sample.instrument === "flow",
        sample.spillover,
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
      const displayContextBeforeImport = sample.displayTransformContextKey;
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
        const targetContext = sample.displayTransformContextKey;
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
            : ""),
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

  function exportFcs(assay: FcsExportAssay, scope: "active" | "combined" | "split", popIds: string[]) {
    if (!sample) return;
    try {
      // popIds come from the export dialog. R exports N checkbox-selected populations; one → a
      // bare .fcs, many → a zip.
      if (popIds.length === 0) {
        setError("No population selected to export.");
        return;
      }
      const popMaskFor = (s: Sample, popId: string): Uint8Array | null =>
        (s === sample ? derived : recompute(s, state)).masks[popId] ?? null;
      const popNameOf = (popId: string) => sanitizeFilePart(state.populations[popId]?.name ?? "population");
      const multiSample = samples.length > 1;

      // The file(s) produced for ONE population under the current sample scope.
      const filesForPop = (popId: string): Record<string, Uint8Array> => {
        const popName = popNameOf(popId);
        const out: Record<string, Uint8Array> = {};
        if (scope === "combined" && multiSample) {
          const items = samples.map((e) => ({
            sample: e.sample,
            name: e.name,
            mask: popMaskFor(e.sample, popId) ?? new Uint8Array(e.sample.fcs.nEvents),
          }));
          out[`combined_${popName}.fcs`] = exportPopulationFcsCombined(items, assay);
        } else if (scope === "split" && multiSample) {
          for (const e of samples) {
            const mask = popMaskFor(e.sample, popId);
            if (!mask) continue;
            out[sanitizeFcsName(null, e.name, popName, null)] = exportPopulationFcs(e.sample, mask, assay);
          }
        } else {
          const base = sanitizeFilePart((fileName || "sample").replace(/\.[^.]+$/, ""));
          out[`${base}_${popName}.fcs`] = exportPopulationFcs(sample, popMaskFor(sample, popId), assay);
        }
        return out;
      };

      if (popIds.length === 1) {
        const files = filesForPop(popIds[0]);
        const names = Object.keys(files);
        // One file (single sample, or combined) → bare .fcs; split-across-samples → zip.
        if (names.length === 1 && !(scope === "split" && multiSample)) {
          downloadBlob(names[0], new Blob([files[names[0]] as BlobPart], { type: "application/octet-stream" }));
        } else {
          downloadBlob(`${popNameOf(popIds[0])}_by_sample.zip`, new Blob([zipSync(files) as BlobPart], { type: "application/zip" }));
        }
      } else {
        // Several populations → one zip, each population's file(s) inside.
        const files: Record<string, Uint8Array> = {};
        for (const popId of popIds) Object.assign(files, filesForPop(popId));
        downloadBlob(`populations_${popIds.length}.zip`, new Blob([zipSync(files) as BlobPart], { type: "application/zip" }));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
        setError("The requested compensation layer could not be activated for this sample.");
        return false;
      }
      if (sample.activeLayer !== previousLayer) {
        setXRange(null); // assay values changed → re-auto-range
        setYRange(null);
        setDirty(true);
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
  ): Promise<void> {
    if (!sample) throw new Error("No active sample is available for compensation.");
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      const message = "Compensation is already running. Follow or cancel the current job in the status bar before starting another Apply.";
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
        throw new Error("The compensation revision cannot be applied because its parent profile is missing from this workspace.");
      }
    }
    const targetSample = sample;
    compensationApplyGuardRef.current = true;
    setCompensationApplyStatus({
      phase: "preparing",
      operation: "apply",
      profileName: profile.name,
      fraction: 0,
      processedEvents: 0,
      totalEvents: targetSample.fcs.nEvents,
    });
    try {
      await checkpointCurrentWorkspace("before-compensation-apply");
      const result = await manager.apply({
        profile,
        targets: [{ sample: targetSample, activeLayer: "compensated" }],
        onProgress: (progress) => {
          setCompensationApplyStatus({
            phase: "applying",
            operation: "apply",
            profileName: profile.name,
            fraction: progress.fraction,
            processedEvents: progress.processedEvents,
            totalEvents: progress.totalEvents,
          });
          setImportMsg(
            `Compensation · ${Math.round(progress.fraction * 100)}% · ${progress.processedEvents.toLocaleString()} / ${progress.totalEvents.toLocaleString()} events`,
          );
          onProgress?.(progress);
        },
      });
      const targetEntry = samples.find(({ sample: candidate }) => candidate === targetSample);
      const appliedBinding = result.targets[0]?.binding;
      if (targetEntry && appliedBinding) {
        // Best-effort local acceleration. The saved profile remains the scientific source of
        // truth when storage is unavailable or the derived assay exceeds the cache size cap.
        void digestFcsBytes(targetEntry.bytes)
          .then((fcsDigest) => writeCachedCompensatedAssay(fcsDigest, targetSample, appliedBinding))
          .catch(() => undefined);
      }
      setWorkspaceCompensation((current) => {
        const exists = current.lineages.some(({ records }) =>
          records.some(({ profileId }) => profileId === profile.profileId)
        );
        if (exists) return current;
        const lineageIndex = current.lineages.findIndex(
          ({ baselineProfileId }) => baselineProfileId === profile.baselineProfileId,
        );
        if (lineageIndex >= 0) {
          return {
            ...current,
            lineages: current.lineages.map((lineage, index) => index === lineageIndex
              ? { ...lineage, records: [...lineage.records, profile] }
              : lineage),
          };
        }
        return {
          ...current,
          lineages: [
            ...current.lineages,
            { baselineProfileId: profile.baselineProfileId, records: [profile] },
          ],
        };
      });
      setXRange(null);
      setYRange(null);
      setError(null);
      const appliedChannelCount = profile.scientific.kind === "flow-spillover"
        ? profile.scientific.matrix.receiverChannels.length
        : profile.scientific.includedChannels.length;
      setImportMsg(`Compensated with ${profile.name} · ${appliedChannelCount} channels`);
      pendingCheckpointReasonRef.current = "after-compensation-apply";
    } catch (cause) {
      if (cause instanceof CompensationCancelledError) {
        setError(null);
        setImportMsg("Compensation cancelled · previous assay unchanged");
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    } finally {
      compensationApplyGuardRef.current = false;
      setCompensationApplyStatus(null);
    }
  }

  function cancelCompensationApply(): void {
    if (compensationApplyStatus?.operation === "restore") {
      compensationRestoreCancelledRef.current = true;
    }
    setCompensationApplyStatus((current) => current
      ? { ...current, phase: "cancelling" }
      : current);
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
  };
  const deleteIllustrationPreset = (name: string) => {
    setIllustrationPresets((prev) => prev.filter((p) => p.name !== name));
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
  const renameChannel = (key: string, label: string) => {
    let changed = false;
    for (const e of samples) {
      const i = e.sample.index(key);
      if (i !== undefined) {
        e.sample.setChannelLabel(i, label);
        changed = true;
      }
    }
    if (changed) {
      setPanelVersion((v) => v + 1);
      setDirty(true);
    }
  };
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
      setDirty(true);
    }
  };

  // ── Metadata (Metadata tab) ──────────────────────────────────────────────────
  const setMetadataCell = (sampleId: string, field: string, value: string) => {
    setMetadata((m) => ({ ...m, [sampleId]: { ...(m[sampleId] ?? {}), [field]: value } }));
    setDirty(true);
  };
  const addMetadataColumn = (name: string) => {
    setMetadataColumns((cols) => {
      let n = name.trim() || "field";
      const taken = new Set(cols.map((c) => c.name));
      if (taken.has(n)) { let i = 2; while (taken.has(`${n}${i}`)) i++; n = `${n}${i}`; }
      return [...cols, { name: n }];
    });
    setDirty(true);
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
    setDirty(true);
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
    setDirty(true);
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
      setDirty(true);
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
    setDirty(true);
  };
  const addPopMetaColumn = (name: string) => {
    setPopulationMetaColumns((cols) => {
      let n = name.trim() || "field";
      const taken = new Set(cols.map((c) => c.name));
      if (taken.has(n)) { let i = 2; while (taken.has(`${n}${i}`)) i++; n = `${n}${i}`; }
      return [...cols, { name: n }];
    });
    setDirty(true);
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
    setDirty(true);
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
    setDirty(true);
  };

  const applyDivision = (profile: DivisionProfile) => {
    if (!activeSampleId) return;
    setDivisionProfiles((m) => ({ ...m, [activeSampleId]: profile }));
    setDirty(true);
    setImportMsg(`Division applied to ${fileName}: ${profile.n} boundaries on ${profile.channelKey} → ${profile.colName}`);
  };

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
  ): SampleEntry {
    // Workspace/FCS readers normally return an exact-owned ArrayBuffer. parseFcs is read-only, so
    // reuse it instead of briefly duplicating a potentially multi-GB source file during import.
    const ab = bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    return {
      id: crypto.randomUUID(),
      name,
      sample: new Sample(parseFcs(ab)),
      bytes,
      handle,
      ...(sourcePath ? { sourcePath } : {}),
    };
  }

  function makeEntry(
    bytes: Uint8Array,
    name: string,
    handle: FileSystemFileHandle | null,
    sourcePath?: string,
  ): SampleEntry | null {
    try {
      return createEntry(bytes, name, handle, sourcePath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // Append a parsed batch atomically. This avoids treating every member of a multi-file
  // import as a separate first sample while React state updates are still queued.
  function addSampleEntries(entries: readonly SampleEntry[]): void {
    if (entries.length === 0) return;
    if (samples.length === 0) {
      setWorkspaceId(makeWorkspaceId());
      setScaleCacheEpoch((epoch) => epoch + 1);
      setGlobalScales({});
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

  function selectSample(id: string) {
    const entry = samples.find((s) => s.id === id);
    if (!entry || id === activeSampleId) return;
    skipDirtyRef.current = true;
    const [nx, ny] = channelsFor(entry.sample);
    setActiveSampleId(id);
    setXIdx(nx);
    setYIdx(ny);
    setXRange(null);
    setYRange(null);
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
    await checkpointCurrentWorkspace("before-sample-remove");
    const removed = new Set(ids);
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
        fileName: e.name,
        dataPath: sampleDataPath(e.name, i),
        logicleW: e.sample.logicleWOverrides(),
        scatterCofactor: e.sample.scatterCofactorOverrides(),
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
        xChannel: sample.channels[xIdx].key,
        yChannel: sample.channels[yIdx].key,
        mode,
        maxEvents,
        contourThreshold,
        densityColorPower,
        fontSizes: gatingFontSizes,
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
  const rememberAllHandles = async () => {
    await Promise.all(samples.flatMap((e) => e.handle ? [rememberHandle("fcs:" + e.name, e.handle)] : []));
  };
  function currentFcsByPath(ws: LiveWorkspaceFile): Record<string, Uint8Array> {
    return Object.fromEntries(ws.samples.map((wss, i) => {
      const entry = samples[i];
      if (!entry) throw new Error(`The loaded data for ${wss.fileName} is unavailable.`);
      return [wss.dataPath, entry.bytes];
    }));
  }
  function currentPortableSources(ws: WorkspaceFileV3) {
    return ws.samples.map((workspaceSample, index) => {
      const entry = samples[index];
      if (!entry) throw new Error(`The loaded data for ${workspaceSample.fileName} is unavailable.`);
      return Object.freeze({
        dataPath: workspaceSample.dataPath,
        fcsBytes: entry.bytes,
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

  // Resolve one reference-workspace sample's FCS bytes: an already-open sample of the same name →
  // a remembered handle → a "locate the file" prompt. Returns null if it can't be found.
  async function resolveReferenceFcs(fileName: string): Promise<{ bytes: Uint8Array; handle: FileSystemFileHandle | null } | null> {
    const existing = samples.find((e) => e.name === fileName);
    if (existing) return { bytes: existing.bytes, handle: existing.handle };
    const h = await recallHandle("fcs:" + fileName);
    const read = h ? await readFromHandle(h) : null;
    if (read) return { bytes: read.bytes, handle: h };
    if (supportsFileSystemAccess()) {
      setImportMsg(`Locate the data file: ${fileName}`);
      const picked = await pickFile(FCS_FILE_ACCEPT, `Locate ${fileName}`, { id: "gatelab-relink-fcs" });
      if (picked) return { bytes: picked.bytes, handle: picked.handle };
    }
    return null;
  }

  async function restoreSavedWorkspaceCompensation(
    ws: WorkspaceFileV3,
    entries: readonly SampleEntry[],
  ): Promise<void> {
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      throw new Error("Another compensation job is already running.");
    }
    const profiles = ws.compensation.lineages.flatMap(({ records }) => records);
    const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const tasks = ws.samples.flatMap((workspaceSample, index) => {
      const binding = workspaceSample.assay.compensatedLayer;
      if (binding === null) return [];
      const profile = profileById.get(binding.profileId);
      if (!profile) {
        throw new Error(`Workspace compensation profile '${binding.profileId}' is missing.`);
      }
      return [{ entry: entries[index], assay: workspaceSample.assay, binding, profile }];
    });
    if (tasks.length === 0) return;

    const totalEvents = tasks.reduce((sum, task) => sum + task.entry.sample.fcs.nEvents, 0);
    const profileNames = Array.from(new Set(tasks.map(({ profile }) => profile.name)));
    const statusName = profileNames.length === 1
      ? profileNames[0]
      : `${tasks.length} saved compensated assays`;
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
        throw new CompensationCancelledError("Workspace compensation restore cancelled.");
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
      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        assertNotCancelled();
        setImportMsg(`Restoring saved compensation · checking local cache ${index + 1} of ${tasks.length}`);
        let fcsDigest: Awaited<ReturnType<typeof digestFcsBytes>> | null = null;
        try {
          fcsDigest = await digestFcsBytes(task.entry.bytes);
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
        setImportMsg(`Restoring saved compensation · recomputing ${profile.name}`);
        const result = await manager.apply({
          profile,
          targets: misses.map(({ task }) => ({
            sample: task.entry.sample,
            activeLayer: task.assay.activeLayer,
          })),
          onProgress: (progress) => {
            const restoredEvents = groupStart + progress.processedEvents;
            setRestoreStatus("applying", restoredEvents);
            setImportMsg(
              `Restoring saved compensation · ${Math.round(restoredEvents / totalEvents * 100)}%` +
                ` · ${restoredEvents.toLocaleString()} / ${totalEvents.toLocaleString()} events`,
            );
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

      // Build an entry for every sample (bundled bytes, else re-linked from disk).
      const entries: SampleEntry[] = [];
      const nextMetadata: Record<string, Record<string, string>> = {};
      const nextDivision: Record<string, DivisionProfile> = {};
      const missing: string[] = [];
      for (const wss of ws.samples) {
        if (typeof wss.fileName !== "string" || typeof wss.dataPath !== "string") {
          throw new Error("Invalid GateLab workspace: a sample declaration is malformed.");
        }
        let fcsB = fcsByPath?.[wss.dataPath] ?? null;
        let fcsH: FileSystemFileHandle | null = null;
        if (!fcsB) {
          const resolved = await resolveReferenceFcs(wss.fileName);
          if (!resolved) {
            missing.push(wss.fileName);
            continue;
          }
          fcsB = resolved.bytes;
          fcsH = resolved.handle;
        }
        const entry = makeEntry(fcsB, wss.fileName, fcsH);
        if (!entry) continue;
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

      if (entries.length !== ws.samples.length) {
        const failed = missing.length ? ` Missing: ${missing.join(", ")}.` : "";
        setError(`Could not load every data file declared by this workspace.${failed} The workspace was not opened.`);
        setBusy(false);
        return;
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
                fcsBytes: entries[index].bytes,
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
      const targetDisplayContext = active.displayTransformContextKey;
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
      setGatingFontSizes({ ...DEFAULT_GATING_FONT_SIZES, ...ws.display?.fontSizes });
      const [dx, dy] = active.defaultChannelIndices();
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
          (missing.length ? ` · missing: ${missing.join(", ")}` : "") +
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
    () => recomputeGating(sample, state),
    // Sample is mutable by design, so its explicit revision must invalidate gate geometry.
    // instrumentMode remains separate because transform-only changes do not always revise data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, state.gates, state.populations, state.root_population_id, state.gate_version, activeDataRevision, instrumentMode],
  );

  const derived = useMemo(
    () => derivePopulationView(sample, state, gatingDerived),
    // `gatingDerived` changes whenever gates/populations change; active/checked ids only select
    // among its cached masks and never need to rerun gate geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, gatingDerived, state.active_population_id, state.selected_pop_ids],
  );

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
  }, [sample, activeDataRevision, overlayBy, overlayPalette, state.populations, state.root_population_id, state.gate_version, derived, activeSampleId, compatibleDivisionProfiles]);

  const overlaySampleRevisionKey = overlaySamples ? sampleDataRevisionKey : "";

  const mainPlotGates = useMemo(() => {
    if (!sample) return [];
    return buildPlotGates(
      sample,
      state.gates,
      state.gate_order,
      derived.gateCounts,
      sample.channels[xIdx].key,
      sample.channels[yIdx].key,
    );
  }, [sample, state.gates, state.gate_order, derived.gateCounts, xIdx, yIdx]);

  const payload = useMemo(() => {
    if (!sample) return null;
    const xName = sample.channels[xIdx].key;
    const yName = sample.channels[yIdx].key;
    const base = sample.plotPayload(
      xIdx,
      yIdx,
      mode,
      mainPlotGates,
      derived.displayMask ?? derived.activeMask, // union of checked pops, else active
      state.selected_gate_id,
      xRange ?? globalScales[xName] ?? null, // per-view → global channel scale → auto
      yRange ?? globalScales[yName] ?? null,
      maxEvents <= 0 ? Infinity : maxEvents,
      contourThreshold,
      overlaySpec,
    );

    // Multi-sample overlay: reuse the active sample's axes/ticks/gates, but replace the point cloud
    // with every loaded sample's events on the current channels, coloured by sample.
    if (overlaySamples && samples.length > 1) {
      const capPer = Math.max(500, Math.floor((maxEvents > 0 ? maxEvents : 50000) / samples.length));
      const xs: number[] = [];
      const ys: number[] = [];
      const cols: number[] = [];
      const palette = paletteColors(overlayPalette, samples.length);
      const labels: string[] = [];
      let used = 0;
      samples.forEach((e) => {
        const xi = e.sample.index(xName);
        const yi = e.sample.index(yName);
        if (xi === undefined || yi === undefined) return;
        const xc = e.sample.displayColumn(xi);
        const yc = e.sample.displayColumn(yi);
        const n = xc.length;
        const cap = Math.min(capPer, n);
        const denom = cap > 1 ? cap - 1 : 1;
        for (let k = 0; k < cap; k++) {
          const j = Math.round((k * (n - 1)) / denom);
          xs.push(xc[j]); ys.push(yc[j]); cols.push(used);
        }
        labels.push(e.name);
        used++;
      });
      return {
        ...base,
        x_b64: encodeFloat32Base64(Float32Array.from(xs)),
        y_b64: encodeFloat32Base64(Float32Array.from(ys)),
        n_events: xs.length,
        overlay_mode: true,
        color_b64: encodeUint8Base64(Uint8Array.from(cols)),
        color_palette: palette.slice(0, used),
        color_labels: labels,
      };
    }
    return base;
    // Active revision updates the current assay; the aggregate key is included only while
    // plotting other samples so an inactive sample change does not rebuild the normal plot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, activeDataRevision, xIdx, yIdx, mode, mainPlotGates, state.selected_gate_id, derived, scalesVersion, xRange, yRange, maxEvents, contourThreshold, instrumentMode, globalScales, overlaySpec, overlaySamples, overlaySampleRevisionKey, samples, overlayPalette]);

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
  const displayed = useMemo(() => {
    if (!payload || !sample) return payload;
    const lbl = (k: string) => sample.labelForKey(k);
    return {
      ...payload,
      point_alpha: pointAlpha, // user-adjustable opacity (was frozen at the payload's 0.4)
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
  }, [payload, sample, panelVersion, pointAlpha, densityColorPower]);

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
        <strong>GateLab</strong>
        {sample && (
          <span className="gl-meta">
            {fileName} — {sample.fcs.nEvents.toLocaleString()} events ·{" "}
            {sample.channels.length}
            {sample.channels.length < sample.fcs.channels.length
              ? ` of ${sample.fcs.channels.length}`
              : ""}{" "}
            ch ·{" "}
            <select
              title="Instrument mode — Auto uses channel-name detection; override if a file is mis-detected. Switch before gating (the gating space flips with it)."
              value={instrumentMode}
              onChange={(e) => changeInstrumentMode(e.target.value as "auto" | "flow" | "cytof")}
              style={{ fontSize: "inherit", padding: "0 2px", background: "transparent", border: "1px solid var(--gl-border, #ccc)", borderRadius: 3 }}
            >
              <option value="auto">auto ({sample.detectedInstrument})</option>
              <option value="cytof">CyTOF</option>
              <option value="flow">flow</option>
            </select>
          </span>
        )}
        {sample && (
          <label
            className="gl-header-assay"
            title="Active assay layer for every GateLab tab. Switching layers keeps gates but recomputes their memberships in the selected coordinate system."
          >
            <span>Assay</span>
            <select
              aria-label="Active assay layer for all tabs"
              value={compensationOn ? "compensated" : "original"}
              disabled={compensationApplyStatus !== null}
              onChange={(event) => toggleCompensation(event.currentTarget.value === "compensated")}
            >
              <option value="original">Original</option>
              <option value="compensated" disabled={!canUseCompensatedAssay}>
                {activeCompensatedStatus?.state === "stale" ? "Compensated (unavailable)" : "Compensated"}
              </option>
            </select>
          </label>
        )}
        {error && <span className="gl-error">⚠ {error}</span>}
        <span
          className="gl-header-meta"
          style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)", whiteSpace: "nowrap" }}
          title="GateLab — MIT-licensed, © 2026 David G. Priest. A TypeScript reimplementation reusing GateLabR's D3 engine."
        >
          GateLab v{pkg.version} · MIT ·{" "}
          <a
            href="https://github.com/david-priest/GateLab"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            repo
          </a>
        </span>
      </header>

      {compensationApplyStatus && (
        <div className="gl-comp-apply-status-bar" role="status" aria-live="polite">
          <div className="gl-comp-apply-status-copy">
            <strong>
              {compensationApplyStatus.operation === "restore"
                ? compensationApplyStatus.phase === "cancelling"
                  ? "Cancelling workspace compensation restore"
                  : compensationApplyStatus.phase === "preparing"
                    ? "Checking saved compensation"
                    : "Restoring saved compensation"
                : compensationApplyStatus.phase === "cancelling"
                  ? "Cancelling CyTOF compensation"
                  : compensationApplyStatus.phase === "preparing"
                    ? "Preparing CyTOF compensation"
                    : "Applying CyTOF compensation"}
            </strong>
            <span title={compensationApplyStatus.profileName}>{compensationApplyStatus.profileName}</span>
          </div>
          <progress
            aria-label={compensationApplyStatus.operation === "restore"
              ? "Saved compensation restore progress"
              : "CyTOF compensation progress"}
            max={1}
            value={compensationApplyStatus.fraction}
          />
          <span className="gl-comp-apply-status-count">
            {Math.round(compensationApplyStatus.fraction * 100)}% · {compensationApplyStatus.processedEvents.toLocaleString()} / {compensationApplyStatus.totalEvents.toLocaleString()} events
          </span>
          {compensationApplyStatus.operation !== "restore" && activeTab !== "compensation" && (
            <button type="button" className="gl-mini-btn" onClick={() => setActiveTab("compensation")}>
              View Compensation
            </button>
          )}
          <button
            type="button"
            className="gl-mini-btn"
            disabled={compensationApplyStatus.phase === "cancelling"}
            onClick={cancelCompensationApply}
          >
            {compensationApplyStatus.phase === "cancelling" ? "Cancelling…" : "Cancel"}
          </button>
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

          <div className="gl-side-title" style={{ marginTop: 10 }}>
            Workspace
          </div>
          {wsName && (
            <div className="gl-hint" title={wsName} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {dirty ? "● " : ""}
              {wsName}
              {dirty ? " (unsaved)" : ""}
            </div>
          )}
          <button
            className="gl-btn-ghost gl-btn-block"
            disabled={busy || !sample || compensationApplyStatus !== null}
            title="Close the current data, gates, and workspace settings and begin an empty workspace"
            onClick={() => setCrud({ kind: "confirmNewWorkspace" })}
          >
            New Workspace…
          </button>
          <button
            className="gl-btn-ghost gl-btn-block"
            disabled={busy || compensationApplyStatus !== null}
            title="Open a saved .gatelab workspace (gates, populations, scales, compensation)"
            onClick={openWorkspace}
          >
            Open Workspace…
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
            {wsHandle ? `Save${dirty ? " ●" : ""}` : "Save Workspace…"}
          </button>
          <button
            className="gl-btn-ghost gl-btn-block"
            disabled={!sample}
            title="Save a lightweight reference workspace. Source FCS and compensated values are not embedded; use Save Portable Copy for a self-contained archive."
            onClick={saveWorkspaceAs}
          >
            Save As…
          </button>
          <button
            className="gl-btn-ghost gl-btn-block"
            disabled={!sample}
            title="Save a self-contained .gatelab with the exact source FCS and any computed compensated assay, so it can reopen without rerunning compensation."
            onClick={saveBundledCopy}
          >
            Save Portable Copy…
          </button>
          <input
            ref={wsRef}
            type="file"
            accept={`.${WORKSPACE_EXT}`}
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await openWorkspaceFromFile(f, null, f.name);
            }}
          />
          {!sample && importMsg && <div className="gl-hint">{importMsg}</div>}

          {sample && (
            <>
              <div className="gl-side-title" style={{ marginTop: 10 }}>
                Gating
              </div>
              <button
                className="gl-btn-ghost gl-btn-block"
                title="Import Gating-ML 2.0 gates and positive AND populations, then choose whether to merge them into the current hierarchy or replace the current strategy"
                onClick={() => xmlRef.current?.click()}
              >
                Import GatingML…
              </button>
              <input
                ref={xmlRef}
                type="file"
                accept=".xml"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) prepareGatingImport(f);
                  e.target.value = "";
                }}
              />
              {importMsg && <div className="gl-hint">{importMsg}</div>}
              <button
                className="gl-btn-ghost gl-btn-block"
                disabled={Object.keys(state.gates).length === 0}
                title="Open the GatingML export dialog: choose standard GateLab/GateLabR or Cytobank-compatible format and review fidelity warnings."
                onClick={() => setGatingMlExportOpen(true)}
              >
                Export GatingML…
              </button>
              <button
                className="gl-btn-ghost gl-btn-block"
                style={{ marginTop: 4 }}
                title="Open the FCS export dialog: choose populations, original/compensated/transformed values, and sample scope."
                onClick={() => setFcsExportOpen(true)}
              >
                Export FCS…
              </button>

              <div className="gl-side-title" style={{ marginTop: 10 }}>
                Display
              </div>
              <label className="gl-field" title="Downsample the points drawn on the plot. Empty or 0 = plot all events (no downsampling). Counts/percentages always use every event.">
                <span>Max events to plot</span>
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
              <div className="gl-hint">empty = all events (no downsampling)</div>
            </>
          )}
        </aside>

        {sample ? (
          <div className="gl-center" role="main" aria-label="Plot and analysis tabs">
            <div className="gl-tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={"gl-tab" + (activeTab === t.id ? " active" : "")}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
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
              <label className="gl-alpha" title="Point opacity" style={{ display: "flex", alignItems: "center", gap: 4 }}>
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
              {mode === "pseudocolor" && (
                <DensityColourControl value={densityColorPower} onChange={changeDensityColorPower} />
              )}
              <div className="gl-draw-tools">
                {DRAW_TOOLS.map((t) => (
                  <button
                    key={t.id}
                    className={"gl-icon-chip" + (drawMode === t.id ? " active" : "")}
                    title={t.title}
                    aria-label={t.title}
                    onClick={() => setDrawMode(t.id)}
                  >
                    <t.Icon />
                  </button>
                ))}
              </div>
              <div className="gl-modes">
                {mode === "contour" && (
                  <label className="gl-contour-outer" title="Outer contour = this % of the peak density">
                    Outer
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
                    {m.label}
                  </button>
                ))}
                <span className="gl-ctl-sep" />
                <label className="gl-field-inline">
                  Colour by
                  <select value={overlayBy} onChange={(e) => setOverlayBy(e.target.value as typeof overlayBy)}>
                    <option value="none">None</option>
                    <option value="population">Population</option>
                    {activeSampleId && compatibleDivisionProfiles[activeSampleId] && <option value="division">Division</option>}
                  </select>
                </label>
                {(overlayBy !== "none" || overlaySamples) && (
                  <label className="gl-field-inline">
                    Palette
                    <select value={overlayPalette} onChange={(e) => setOverlayPalette(e.target.value as PaletteName)}>
                      {OVERLAY_PALETTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                )}
                {samples.length > 1 && (
                  <label className="gl-check" title="Plot all loaded samples together, coloured by sample">
                    <input type="checkbox" checked={overlaySamples} onChange={(e) => setOverlaySamples(e.target.checked)} />
                    Overlay samples
                  </label>
                )}
              </div>
            </div>
            <div className="gl-scales gl-ranges">
              <span className="gl-scales-label">Range</span>
              {(() => {
                const r3 = (n: number) => Math.round(n * 1000) / 1000;
                const xName = sample.channels[xIdx].key;
                const yName = sample.channels[yIdx].key;
                const effX = xRange ?? globalScales[xName] ?? payload?.x_range ?? sample.displayRange(xIdx);
                const effY = yRange ?? globalScales[yName] ?? payload?.y_range ?? sample.displayRange(yIdx);
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
                  setXRange(includePlotGatesInAxisRange(sample.displayRange(xIdx), mainPlotGates, "x"));
                  setYRange(includePlotGatesInAxisRange(sample.displayRange(yIdx), mainPlotGates, "y"));
                }}
              >
                Fit data + gates
              </button>
              <button className="gl-tool" title="Reset X/Y to auto range (also clears the shared per-channel scale)"
                aria-label="Reset X and Y ranges to auto"
                onClick={() => {
                  setXRange(null);
                  setYRange(null);
                  setGlobalScale(sample.channels[xIdx].key, null);
                  setGlobalScale(sample.channels[yIdx].key, null);
                }}>⟲</button>
              {derived.displayPopCount > 1 && (
                <span className="gl-display-pops-banner">
                  Displaying {derived.displayPopCount} populations (union)
                </span>
              )}
              <span className="gl-hint" style={{ marginLeft: "auto" }}>
                drag to pan · shift-drag to stretch
              </span>
            </div>
            <div className="gl-scales gl-gating-fonts" aria-label="Gating plot font sizes">
              <span className="gl-scales-label">Fonts</span>
              {([
                ["Tick", "tick", 6, 24],
                ["Axis", "axis", 6, 28],
                ["Title", "title", 6, 28],
                ["Gate", "gate", 6, 28],
              ] as const).map(([label, key, min, max]) => (
                <label key={key} className="gl-field-inline">
                  {label}
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
            </div>
            {(sample.isLogicleChannel(xIdx) || sample.isLogicleChannel(yIdx)) && (
              <div className="gl-scales">
                <span className="gl-scales-label">Logicle W</span>
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
                        value={sample.currentLogicleW(idx)}
                        onChange={(e) => {
                          sample.setLogicleW(idx, +e.target.value);
                          bumpScales();
                        }}
                      />
                      <span className="gl-scale-val">{sample.currentLogicleW(idx).toFixed(2)}</span>
                      <button
                        className="gl-tool"
                        title="Reset to auto-estimated W"
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
              />
            )}
            {activeTab === "panel" && (
              <PanelTab key={panelVersion} sample={sample} onRename={renameChannel} onResetAll={resetAllLabels} />
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
                state={state}
                derived={derived}
                globalScales={globalScales}
                defaultX={sample.channels[xIdx].key}
                defaultY={sample.channels[yIdx].key}
                configRef={illustConfigRef}
                presets={illustrationPresets}
                onSavePreset={saveIllustrationPreset}
                onDeletePreset={deleteIllustrationPreset}
                dataRevision={activeDataRevision}
                densityColorPower={densityColorPower}
                onDensityColorPowerChange={changeDensityColorPower}
              />
            )}
            </ErrorBoundary>
            {/* Matrix import and Apply are long-lived workflows. Keep this tab mounted while
                hidden so switching tabs cannot discard its draft while its manager job runs. */}
            <ErrorBoundary label="compensation">
              <CompensationTab
                key={`${workspaceId}:${activeSampleId ?? "none"}`}
                sample={sample}
                sampleName={fileName}
                compensationOn={compensationOn}
                onApplyProfile={applyCompensationProfile}
                onCancelApply={cancelCompensationApply}
                hasExistingGates={Object.keys(state.gates).length > 0}
                applyStatus={compensationApplyStatus}
                installedProfile={activeCompensationProfile}
                applyWorkerCount={compensationWorkerCount}
                applyWorkerLimit={compensationWorkerLimit}
                onApplyWorkerCountChange={changeCompensationWorkerCount}
                installedBaselineProfile={activeCompensationBaseline}
                reviewPopulations={compensationReviewPopulations}
                reviewPopulationMasks={derived.masks}
                onPreviewCompensationCandidate={previewCompensationCandidate}
                onSolveCompensationSweep={solveCompensationSweep}
                onCancelCompensationSweep={cancelCompensationSweep}
                visible={activeTab === "compensation"}
                stateKey={`${workspaceId}:${activeSampleId ?? "none"}`}
                densityColorPower={densityColorPower}
                onDensityColorPowerChange={changeDensityColorPower}
              />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="gl-center gl-empty" role="main" aria-label="Plot and analysis tabs">
            <p>Open an FCS file to begin.</p>
          </div>
        )}

        <aside
          className="gl-side"
          style={{ width: sideWidth, display: activeTab === "compensation" ? "none" : undefined }}
          aria-label="Gates and populations"
        >
          <div className="gl-side-resize" onMouseDown={startResize} title="Drag to resize" />
          <div className="gl-side-section">
            <div className="gl-side-head">
              <div className="gl-side-title">Gates</div>
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
              <div className="gl-side-title">Populations</div>
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
              <PopulationTree state={state} derived={derived} dispatch={uiDispatch} />
            </div>
          </div>
        </aside>
      </div>

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
          onConfirm={(mapping) => {
            dispatch({ type: "bulkRenamePopulations", mapping });
            setCrud(null);
          }}
        />
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
          compensationNeedsConfirmation={pendingGatingMlImport.compensation.requiresConfirmation}
          onCancel={() => {
            setPendingGatingMlImport(null);
            setImportMsg("Gating-ML import cancelled; the current strategy was not changed.");
          }}
          onImport={applyGatingImport}
        />
      )}
      {fcsExportOpen && sample && (
        <FcsExportModal
          state={state}
          samplesCount={samples.length}
          initialPopIds={
            state.selected_pop_ids.length > 0
              ? state.selected_pop_ids
              : state.active_population_id
                ? [state.active_population_id]
                : []
          }
          initialAssay={fcsAssay}
          initialScope={fcsScope}
          onCancel={() => setFcsExportOpen(false)}
          onExport={(popIds, assay, scope) => {
            setFcsAssay(assay);
            setFcsScope(scope);
            exportFcs(assay, samples.length > 1 ? scope : "active", popIds);
            setFcsExportOpen(false);
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
