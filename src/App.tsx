// App.tsx — Step 3: FCS → gate drawing → gate list + population tree (reproduced from
// GateLabR) with live counts. Drawing a gate opens the name/population modal; the plot
// shows the active population's events plus its gates (display space).

import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePopoverDismissal } from "./ui/usePopoverDismissal";
import { figureBlockFrame } from "./ui/LayoutFigure";
import { proportionsBlockFrame } from "./ui/LayoutProportions";
import { buildProportionsModel, defaultProportionsSettings, type ProportionsSettings } from "./engine/proportionsModel";
import pkg from "../package.json";
import brandMark from "./assets/brand/gatelab-mark.png";
import brandWordmark from "./assets/brand/gatelab-wordmark.png";
import brandLogo from "./assets/brand/gatelab-logo.jpg";
import brandWordmarkR from "./assets/brand/gatelabr-wordmark.png";
import brandLogoR from "./assets/brand/gatelabr-logo.jpg";
import { clearPersistedTabState, readPersistedTabValues, readProportionsSettings, restorePlottingState, savedPlottingState, writeProportionsSettings } from "./ui/tabState";
import { historyShortcutAction } from "./ui/historyShortcuts";
import { DEFAULT_GATING_FONT_SIZES, GatingPlot, type GatingPlotActions, type NewGate } from "./plots/GatingPlot";
import { startPanSession } from "./plots/panGesture";
import { buildPlotGates, type PlotGate } from "./plots/gatePayload";
import { FIT_GATE_DEFAULTS, clampFitSettings, fitGateToEvents, type FitGateResult, type FitGateSettings } from "./engine/fitGate";
import { FitGatePanel } from "./ui/FitGatePanel";
import { branchScopedGateOrder } from "./engine/branchGates";
import {
  isFlowJoWorkspace,
  listFlowJoWorkspaceSamples,
  flowJoWorkspaceToGatingML,
  matchFlowJoSamples,
  pairFlowJoWorkspaceFiles,
  ungatedWorkspaceFiles,
  type FlowJoSampleSummary,
  type FlowJoTreeSummary,
  type FlowJoWorkspaceFile,
  type FlowJoSampleMatchKey,
  type FlowJoWorkspacePairing,
  type FlowJoSpillover,
} from "./engine/flowjoWorkspace";
import { isDivaWorkspace, listDivaGateTrees, listDivaTubes, pairDivaTube, divaToGatingML, type DivaGateTreeSummary, type DivaTubeSummary } from "./engine/divaWorkspace";
import { isChorusExperimentFile, readChorusExperiment, listChorusTrees, chorusToGatingML, chorusRecordingToGatingML, hasChorusRecording, readChorusRecording, treeSignature, type ChorusExperiment, type ChorusTreeSummary } from "./engine/chorusExperiment";
import { exportChorusExperiment } from "./engine/chorusExport";
import { buildChorusTimeline, isRecordingOfExperiment, treesRecordedUnder, type LoadedChorusRecording } from "./engine/chorusTimeline";
import { ChorusTimelineModal } from "./ui/ChorusTimelineModal";
import { compareChorusStatistics, parseChorusStatistics, type ChorusImportRecord, type ChorusStatistics, type FileCounts } from "./engine/chorusStatistics";
import { ChorusStatisticsModal } from "./ui/ChorusStatisticsModal";
import { checkAgainstFlowJo, flowJoCountCheckCsv, type FlowJoCountCheck, type FlowJoReference } from "./engine/flowjoCountCheck";
import { FlowJoCountCheckModal } from "./ui/FlowJoCountCheckModal";
import { EmptyState } from "./ui/EmptyState";
import { MenuButton, type MenuEntry } from "./ui/MenuButton";
import { ContextMenu, type ContextMenuState } from "./ui/ContextMenu";
import { snapGatesToBorders } from "./engine/borderSnap";
import { quadrantPopulationNames, shortChannelLabel, type QuadrantNaming } from "./engine/quadrantNames";
import { covarianceFromAxes, ellipseBoundary } from "./engine/ellipse";
import { ChannelScales } from "./engine/channelScales";
import { restoreChannelScales } from "./engine/restoreChannelScales";
import { fitChannelAxisRange, includePlotGatesInAxisRange } from "./engine/axisRange";
import {
  extractFcsDataSet,
  extractNamedFcsDataSet,
  fcsDataSetFileName,
  FcsMultipleDataSetsError,
  parseFcs,
  parseFcsDataSetFileName,
  readFcsFileKeywords,
  readFcsKeywords,
  type SpilloverMatrix,
} from "./engine/fcs";
import { gatingMlGains } from "./engine/gatingmlGain";
import { gatingMLWriterOf } from "./engine/gatingmlWriter";
import { Sample, maxCoefficientDelta, type DisplayMode, type OverlaySpec } from "./engine/sample";
import type { DisplaySpillover } from "./engine/compensation";
import { parseCompensationMatrixTable } from "./engine/compensationMatrixImport";
import { populationTreeOrder } from "./engine/populations";
import { resolvePartitionLevels, partitionAssign } from "./engine/factors";
import { paletteColors, populationColor, UNGATED_COLOR, OVERLAY_PALETTES, MARKER_PALETTES, DEFAULT_MARKER_PALETTE, type PaletteName } from "./engine/palettes";
import {
  DEFAULT_MARKER_COLOR_POWER,
  MARKER_MISSING_LEVEL,
  markerColourFraction,
  markerColourLevel,
  markerColourLevels,
  markerColourPalette,
  markerColourScale,
  type MarkerColourScale,
} from "./engine/markerColour";
import { assignDivisionLevel, divisionPalette } from "./engine/division";
import { decodeUint8Base64, encodeFloat32Base64, encodeUint8Base64 } from "./engine/encode";
import {
  aggregateGateCounts,
  aggregatePopulationTreeStats,
  buildCombinedSamplePointCloud,
  buildWorkspaceAxisRanges,
  type CombinedSamplePlotInput,
  type PooledGateCountInput,
} from "./engine/multiSamplePlot";
import {
  cytobankDocumentForFile,
  cytobankTailoredFiles,
  fcsDeclaresCompensation,
  gatingMLImportOptionsFor,
  importGatingML,
  resolveGatingMLCompensation,
  restoreGatingMLScaleState,
  type GatingMLCompensationResolution,
  type GatingMLResult,
} from "./engine/gatingml";
import { exportGatingML, type GatingMLFormat } from "./engine/gatingmlExport";
import { exportFlowJoWorkspace, flowJoWorkspaceBytesAtMost, planFlowJoExport, type FlowJoExportSample } from "./engine/flowjoExport";
import { formatByteSize, planFlowJoFolder, previewFlowJoFolder, writableName, writeFlowJoFolder, writeFlowJoZip } from "./engine/flowjoExportFolder";
import {
  gatingMergeSpaceConflict,
  hasGatingStrategy,
  type GatingImportMode,
  type GatingImportTarget,
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
  type WorkspaceStoredHierarchy,
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
  barcodeSchemeTemplateCsv,
  buildBarcodeGating,
  exportBarcodeScheme,
  exportHierarchyCsv,
  parseBarcodeTable,
  previewQcChainFor,
  resolveBarcodeScheme,
  resolveQcChannel,
} from "./engine/barcodeScheme";
import {
  DEFAULT_BARCODE_TEMPLATE,
  isBarcodeTemplate,
  learnBarcodeTemplate,
  normalizeBarcodeTemplate,
  type LearnedBarcodeTemplate,
} from "./engine/barcodeTemplate";
import { BarcodeSchemeImportModal, type BarcodeImportDraft } from "./ui/BarcodeSchemeImportModal";
import { BarcodeSaveModal, type BarcodeSaveChoice, type BarcodeSaveSummary } from "./ui/BarcodeSaveModal";
import { HierarchyModal, type HierarchyModalMode } from "./ui/HierarchyModal";
import type { GroupAction } from "./ui/SampleManager";
import { cloneHierarchyTree, correspondingHierarchyId, fileHierarchyId, newHierarchyId, referencedGateIds, storeHierarchy, uniqueHierarchyName, hierarchyColour } from "./engine/hierarchies";
import { gateChannelKeys, gatesMissingChannels, planChannelKeyRemap, remapGateChannels, savedFileTreeGates } from "./engine/workspaceChannelKeys";
import { briefReason, describeUnpaired, distinctFileNames, filesToHold, isPaired, namesInBrief, openTreeIndex, plannedFlowJoOpen, reasonWasCut, tiedDataSetsNote, workspaceFilesInFolder, type ChosenTree, type SkippedFile } from "./engine/flowjoOpen";
import { compareIdentity, describeAgreement, describeContradiction, identityKeywords, sameFileName } from "./engine/fileIdentity";
import { templateNameFromOrigin, type TailoredFile } from "./engine/tailoredImport";
import { describeDiffering, planOneTreeImport, sameStructure, tailorFilesToTree } from "./engine/oneTreeImport";
import { groupsOf, templateOf } from "./engine/groups";
import { copyOnOwnChannels, gateGeometryEquals, tailoredGateIds } from "./engine/templateSync";
import type { HierarchyRef, StoredHierarchy } from "./engine/hierarchies";
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
  lastGrantedDirectory,
  pickFilesOrInput,
  pickWritableDirectory,
  rememberPickerLocation,
  writeHandle,
  writeHandleStream,
  saveAsHandle,
  saveAsHandleStream,
  ensurePermission,
  readFromHandleIfPermitted,
  rememberHandle,
  recallHandle,
  type PickedFileSource,
} from "./engine/fsAccess";
import {
  describeRequirement,
  indistinguishableDuplicateNames,
  planWorkspaceFcsRelink,
  type WorkspaceFcsRequirement,
} from "./engine/workspaceRelink";
import {
  AUTO_CHECKPOINT_INTERVAL_MS,
  CHECKPOINT_REASON_LABELS,
  checkpointAge,
  listWorkspaceCheckpoints,
  requestPersistentWorkspaceHistory,
  saveWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointReason,
} from "./engine/workspaceHistory";
import { WorkspaceHistoryModal } from "./ui/WorkspaceHistoryModal";
import {
  coreReducer,
  initialCoreState,
  type CoreState,
  derivePopulationDisplaySelection,
  derivePopulationView,
  recompute,
  recomputeGating,
  recomputeOwnTreeGating,
  gatingKeyedByLiveTree,
  promoteRefusal,
  type Action,
  type Derived,
  type GatingDerived,
  type PopulationDisplaySelection,
} from "./store";
import { GateList } from "./ui/GateList";
import { GATE_EDGE_MODES, type GateEdgeMode } from "./ui/gateEdgeModes";
import { resolveFlowJoTarget } from "./engine/flowjoWorkspace";
import { isUnbounded, type GateSpace, type Gate } from "./engine/models";
import type { ChannelLabelMode } from "./engine/sample";
import { gateSpaceBadge } from "./engine/gateSpaceBadge";
import { isFlowJoGridGate } from "./engine/flowjoGrid";
import { HierarchyControls, PopulationTree, type EditTarget, type TreeControlsProps } from "./ui/PopulationTree";
import { GateModals } from "./ui/GateModals";
import { GateToolbar, PopToolbar } from "./ui/Toolbars";
import { FlowJoGridOption } from "./ui/FlowJoGridOption";
import { stampHostedWorkspace } from "./engine/workspaceFeatures";
import { RenameModal, CreatePopModal, EditPopModal, ConfirmModal, BulkRenameModal, FcsExportModal, GatingMlImportModal, GatingMlExportModal, FlowJoExportModal, GroupsFromMetadataModal, type FlowJoExportScope, type MetadataGroupsPreview } from "./ui/CrudModals";
import { StatsTab } from "./ui/StatsTab";
import { PanelTab } from "./ui/PanelTab";
import { MetadataTab } from "./ui/MetadataTab";
import type { MetaRow } from "./ui/EditableMetaTable";
import { ProportionsTab } from "./ui/ProportionsTab";
import { DivisionTab, type DivisionProfile } from "./ui/DivisionTab";
import { parseMetadataTable, lookupMetadataRow, sampleDisplayId, SAMPLE_ID_FIELD, type MetadataColumn } from "./engine/metadata";
import { ScalesTab } from "./ui/ScalesTab";
import type {
  CompensationApplyUiStatus,
  CompensationCandidatePreviewSolver,
  CompensationSweepSolver,
} from "./ui/CompensationTab";
import { StrategyTab, type StrategyConfig } from "./ui/StrategyTab";
import { FigureWorkspace } from "./ui/FigureWorkspace";
import {
  allowedByLocks,
  checkedValues,
  columnCoverage,
  facetColumns,
  restrictFacets,
  toggleGroupChecked,
  type FacetLocks,
} from "./engine/sampleFacets";
import {
  compareSampleNames,
  FolderImportModal,
  SampleManagerModal,
  SampleNavigator,
  type FolderImportItem,
  type SampleImportProgress,
  type SampleListItem,
} from "./ui/SampleManager";
import { WorkspaceRelinkModal } from "./ui/WorkspaceRelinkModal";
import { forgetRecentWorkspace, listRecentWorkspaces, rememberRecentWorkspace, type RecentWorkspace } from "./engine/recentWorkspaces";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { NavigateIcon, RectIcon, PolyIcon, EllipseIcon, QuadIcon } from "./ui/icons";
import { useSampleDataRevisionKey } from "./ui/useSampleDataRevisions";
import { useContextualGlobalScales, type GlobalScales } from "./ui/useContextualGlobalScales";
import {
  DEFAULT_DENSITY_COLOR_POWER,
  normalizeDensityColorPower,
} from "./engine/pseudocolor";
import { createDefaultLayoutWorkspace, effectiveLayoutStyle, layoutGridFrames, normalizeLayoutWorkspace, type LayoutGridCell, type LayoutPlotRecipe, type LayoutPlotStyle, type LayoutStrategyRecipe, type LayoutWorkspace, cloneLayoutWorkspace, nextLayoutItemPosition, type LayoutGridHeading, type LayoutGridHeadings } from "./engine/layout";
import { DensityColourControl } from "./ui/DensityColourControl";
import { MarkerColourBar, type MarkerColourBarTick } from "./ui/MarkerColourBar";
import { MarkerColourControl } from "./ui/MarkerColourControl";
import { SearchableSelect, type SearchableOption } from "./ui/SearchableSelect";
import type { GatingImportSourceKind } from "./ui/CrudModals";
import { UI_LANGUAGE_OPTIONS, useI18n, type UiLanguage } from "./ui/i18n";
import { useTour } from "./tour/useTour";
import { resolveTourTarget, TourOverlay } from "./tour/TourOverlay";
import { TourMenu } from "./tour/TourMenu";
import { DEMO_WORKSPACE_CITATION, DEMO_WORKSPACE_FILE, DEMO_WORKSPACE_PATH } from "./tour/tourScript";
import type { TourContext, TourNeeds } from "./tour/tourTypes";
import { useOptionalGateLabHost } from "./host/HostContext";
import { createBrowserHost } from "./host/browserHost";
import {
  HostedAssayNotArcsinhError,
  chooseHostedAssay,
  drawableHostedAssay,
  hasLinearHostedAssay,
  linearHostedAssay,
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
  hostedAssayIdOf,
} from "./host/hostedWorkspace";
import {
  buildHostedMemberships,
  gatingStateForTree,
  hostedMembershipReader,
  hostedSampleMask,
  notEvaluatedNotes,
  workspaceHierarchyTrees,
  type HierarchyTree,
  type HostedMembershipSample,
} from "./host/hostedMemberships";
import { AgentLink, parseAgentUrl, type AgentLinkStatus } from "./agent/agentLink";
import { createAgentHandler, type AgentAdapter, type AgentSampleView } from "./agent/handler";
import { AgentMenu } from "./agent/AgentMenu";
import { renderPlotPng } from "./agent/renderPlot";
import type { AgentView as AgentViewState, AgentViewParams } from "./agent/protocol";
import {
  GATELAB_HOST_COLDATA_CONTRACT_VERSION,
  type GateLabHostCategoricalColumn,
  type GateLabHostPopulationColumn,
} from "./host/colDataContract";
import { GATELAB_HOST_ROWDATA_CONTRACT_VERSION } from "./host/rowDataContract";
import {
  GateLabWorkspaceConflictError,
  type GateLabHostWorkspaceWriteResult,
} from "./host/workspaceContract";
import { lazyChunk } from "./ui/lazyChunk";
import {
  SceColDataExportModal,
  type ScePopulationColumnSpec,
} from "./ui/SceColDataExportModal";

const CompensationTab = lazy(lazyChunk("CompensationTab", async () => {
  const module = await import("./ui/CompensationTab");
  return { default: module.CompensationTab };
}));
const LayoutTab = lazy(lazyChunk("LayoutTab", async () => {
  const module = await import("./ui/LayoutTab");
  return { default: module.LayoutTab };
}));

const FCS_FILE_ACCEPT = { "application/octet-stream": [".fcs"] };
/** Picker types for the tables and workspaces the sidebar imports through pickFilesOrInput. */
const GATING_IMPORT_ACCEPT = { "application/xml": [".xml", ".wsp"], "application/zip": [".cef"] };
const TABLE_FILE_ACCEPT = { "text/csv": [".csv", ".tsv", ".txt"] };


/**
 * Arcsinh-cofactor slider bounds, as log10 of the cofactor.
 *
 * 1 to 100,000: the low end covers 10-bit data on the original 0-1023 scale, the high end
 * covers spectral data reaching 10M, where a cofactor in the thousands is what makes the axis
 * differ from a log scale at all. Rounded to three significant figures so the readout under
 * the slider is exactly the value in force.
 */
const COFACTOR_LOG_MIN = 0;
const COFACTOR_LOG_MAX = 5;
const cofactorFromSlider = (log10Value: number): number => {
  const raw = Math.pow(10, log10Value);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 2);
  return Math.max(1, Math.round(raw / magnitude) * magnitude);
};
const fmtCofactor = (cofactor: number): string =>
  cofactor >= 10000 ? `${(cofactor / 1000).toFixed(0)}K`
  : cofactor >= 1000 ? `${(cofactor / 1000).toFixed(1)}K`
  : `${Math.round(cofactor)}`;
const INITIAL_LEFT_PANE_WIDTH = 330;
const INITIAL_RIGHT_PANE_WIDTH = 672;
/**
 * How long the background gating of the files not on the plot runs before it yields for a
 * paint. Below one 60 Hz frame, so gate editing stays responsive while it runs.
 */
const INACTIVE_GATING_SLICE_MS = 12;

type CrudModal =
  | { kind: "createPop" }
  | { kind: "renameGate"; id: string; initial: string }
  | { kind: "editPop"; id: string }
  | { kind: "confirmNewWorkspace" }
  | { kind: "confirmDelete"; what: "gates" | "pops"; ids: string[] }
  | { kind: "bulkRename" }
  | { kind: "exportSceColData" };

type DrawMode = "navigate" | "draw-rect" | "draw-poly" | "draw-ellipse" | "draw-quadrant";
type LiveWorkspaceFile = WorkspaceFile | WorkspaceFileV3;

/**
 * Does this import need the user to decide anything?
 *
 * Three things can need a choice, and none of them is guaranteed:
 *   • an existing strategy, so merge-vs-replace is a real fork;
 *   • a compensation change the user must confirm before it rewrites every value;
 *   • two different spillover matrices, where both are legitimate answers.
 *
 * With none of them present -- a Gating-ML file or FlowJo workspace opened into a fresh
 * workspace -- the dialog offered a choice between two identical outcomes, so it is skipped and
 * the strategy simply loads.
 */
/**
 * A parked hierarchy as the store wants it, from a workspace file.
 *
 * Hierarchies own their gates. A workspace written before they did has none of its own and its
 * populations reference the shared table, so the gates it actually uses are lifted out of that
 * table -- giving the old file the same meaning it had, under the new arrangement.
 */
export function restoreStoredHierarchy(
  stored: WorkspaceStoredHierarchy,
  sharedGates: Record<string, Gate>,
): StoredHierarchy {
  if (stored.gates) {
    return {
      ...stored,
      gates: stored.gates,
      gate_order: stored.gate_order ?? Object.keys(stored.gates),
      selected_pop_ids: [],
    } as StoredHierarchy;
  }
  const used = referencedGateIds(stored.populations);
  const gates: Record<string, Gate> = {};
  for (const id of used) if (sharedGates[id]) gates[id] = sharedGates[id];
  return {
    ...stored,
    gates,
    gate_order: Object.keys(gates),
    selected_pop_ids: [],
  } as StoredHierarchy;
}

export function gatingImportNeedsDecision(
  pending: PendingGatingMLImport,
  state: Pick<CoreState, "gates" | "populations" | "root_population_id">,
  /** How many files are loaded: with more than one, the tree needs a target, so the dialog shows. */
  fileCount = 1,
): boolean {
  if (fileCount > 1) return true;
  // "Evaluate gates as FlowJo does" has not been asked yet: the dialog is where it is asked.
  if (pending.flowJoGridChoice) return true;
  // Compensation rewrites every fluorescence value, so it is never applied unasked. A FlowJo
  // workspace opened through its own dialog has been asked: that dialog states the matrix the gates
  // were drawn under -- or asks which, when the file's differs -- before anything changes, and
  // matrixAnswered is set only on that path. Confirming it again afterwards was the second dialog.
  // Every other route to an import (one click onto a loaded file, the sample and tree pickers)
  // states nothing, so it still asks.
  if (pending.compensation.requiresConfirmation && !(pending.externalSpillover && pending.matrixAnswered)) return true;
  if (pending.externalSpillover?.differsFromEmbedded && !pending.matrixAnswered) return true;
  // Another file of a per-file import whose own matrix differs from its sample's: the open
  // dialog compared the primary's alone, so this is asked here whatever it answered.
  if (pending.siblingTrees?.some((tree) => tree.externalSpillover?.differsFromEmbedded)) return true;
  if (state.root_population_id === null) return false;
  return hasGatingStrategy({ ...state, root_population_id: state.root_population_id });
}

/**
 * A result line's " · N note(s)" raised by notes made after it was written; added when absent.
 */
export function withMoreNotes(line: string, more: number): string {
  if (!more) return line;
  const m = / · (\d+) note\(s\)$/.exec(line);
  return m ? `${line.slice(0, m.index)} · ${Number(m[1]) + more} note(s)` : `${line} · ${more} note(s)`;
}

/**
 * The matrix an import's gates are evaluated with, for an answer to the matrix question, as
 * applyGatingImport installs it: the external one (a FlowJo workspace's, as
 * Sample.externalSpilloverPreview maps it), unless it differs from the sample's own and the file's
 * is kept. Null: the sample's own. Which gates the import can hold depends on it
 * (gatingMLImportOptionsFor).
 */
export function appliedImportMatrix(
  sample: Sample,
  external: DisplaySpillover | null,
  choice: "workspace" | "file",
): DisplaySpillover | null {
  if (!external) return null;
  const differs = sample.spillover !== null && maxCoefficientDelta(sample.spillover, external) > 1e-6;
  return differs && choice === "file" ? null : external;
}

/**
 * Parse one further tree of a FlowJo import, against the file it belongs to.
 *
 * Under a per-file import the tree names the FCS it was drawn on. When that file is loaded and
 * is not the primary, the tree is parsed with THAT sample's channels and instrument and carries
 * its own compensation decision, made from the matrix the workspace holds for that sample and
 * the matrix the file embeds -- the same decision the primary gets, per file. Parsed against the
 * primary instead, a gate on a channel the primary lacked was dropped as "skipped", and the file
 * itself was never compensated: its whole hierarchy evaluated fluorescence gates on
 * uncompensated values while the result line said "compensation enabled" once for the lot.
 */
export function resolveSiblingImport(
  tree: Readonly<{ name: string; gatingMl: string; fileName?: string; entryId?: string | null; spillover?: FlowJoSpillover | null; origin?: string; sampleLabel?: string }>,
  primary: Sample,
  entries: readonly Readonly<{ id: string; name: string; sample: Sample }>[],
  activeSampleId: string | null,
  /** The answer to the matrix question, which every tree's install follows (applyGatingImport). */
  matrixChoice: "workspace" | "file" = "workspace",
  /** The matrix the primary is evaluated with (appliedImportMatrix): a tree on no other file's. */
  primaryMatrix: DisplaySpillover | null = null,
): NonNullable<PendingGatingMLImport["siblingTrees"]>[number] {
  // The loaded file the open paired this tree's sample with, by id. Found by name, it was the
  // first loaded file of that name -- another experiment's, where two share one.
  const entry = tree.entryId ? entries.find((e) => e.id === tree.entryId) ?? null : null;
  const own = entry && entry.id !== activeSampleId ? entry : null;
  const target = own ? own.sample : primary;
  const pnn: Record<string, string> = {};
  for (const c of target.channels) pnn[c.pnn] = c.key;
  const external = tree.spillover && target.instrument === "flow"
    ? target.externalSpilloverPreview(tree.spillover.matrix)
    : null;
  // Parsed against the matrix its sample will be evaluated with: its own workspace matrix as the
  // choice installs it, or, for a tree imported onto the primary, the primary's.
  const result = importGatingML(
    tree.gatingMl, target.channels.map((c) => c.key), pnn, target.instrument,
    gatingMLImportOptionsFor(target, own ? appliedImportMatrix(target, external?.display ?? null, matrixChoice) : primaryMatrix));
  if (!own) {
    return {
      name: tree.name,
      ...(tree.fileName ? { fileName: tree.fileName } : {}),
      ...(tree.entryId ? { entryId: tree.entryId } : {}),
      ...(tree.origin ? { origin: tree.origin } : {}),
      ...(tree.sampleLabel ? { sampleLabel: tree.sampleLabel } : {}),
      result,
    };
  }
  const delta = external?.display != null && target.spillover !== null
    ? maxCoefficientDelta(target.spillover, external.display)
    : null;
  return {
    name: tree.name,
    fileName: tree.fileName,
    entryId: own.id,
    ...(tree.origin ? { origin: tree.origin } : {}),
    ...(tree.sampleLabel ? { sampleLabel: tree.sampleLabel } : {}),
    result,
    sampleId: own.id,
    compensation: resolveGatingMLCompensation(
      result.compensation, result.compensation_refs, target.instrument === "flow",
      external?.display ?? target.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(target.fcs) }),
    externalSpillover: external?.display != null
      ? {
          matrix: tree.spillover!.matrix,
          label: tree.spillover!.name || "the FlowJo workspace",
          replacesEmbedded: target.spillover !== null,
          differsFromEmbedded: delta !== null && delta > 1e-6,
          maxDelta: delta,
        }
      : null,
  };
}

interface PendingGatingMLImport {
  result: GatingMLResult;
  /** What the Gating-ML was made from, for the dialog's title: a FlowJo workspace is not "a Gating-ML file" to the user. */
  sourceKind?: GatingImportSourceKind;
  compensation: GatingMLCompensationResolution;
  sampleId: string;
  /**
   * Under a per-file FlowJo import, every other found file's strategy: each file follows the
   * primary's tree or tailors its gate coordinates. They are one decision, not several -- same
   * workspace, same matrix choice -- so they are parsed with the primary and applied together,
   * rather than asking the same questions once per file. Empty for every other import.
   */
  siblingTrees?: readonly Readonly<{
    name: string;
    result: GatingMLResult;
    /** The FCS this tree was drawn on, when each file is to get its own hierarchy. */
    fileName?: string;
    /** That FCS's loaded entry, by id. */
    entryId?: string | null;
    /** Where the strategy came from (a FlowJo group), to name the template it shares. */
    origin?: string;
    /** Which sample of the workspace it is ("sample 14"), to tell two files of one name apart. */
    sampleLabel?: string;
    /**
     * A tree drawn on ANOTHER loaded file is parsed against that file's channels and carries its
     * own compensation decision, applied to that sample when the import goes ahead. A hierarchy
     * applied to a file left on its original layer evaluated every fluorescence gate on
     * uncompensated values, while the result line said "compensation enabled" once for the lot.
     */
    sampleId?: string;
    compensation?: GatingMLCompensationResolution;
    externalSpillover?: {
      matrix: SpilloverMatrix;
      label: string;
      replacesEmbedded: boolean;
      differsFromEmbedded: boolean;
      maxDelta?: number | null;
    } | null;
  }>[];
  /** The FCS the PRIMARY tree was drawn on, under per-file import. */
  primaryFileName?: string;
  /** Which sample of the workspace the primary file is ("sample 11"). */
  primarySampleLabel?: string;
  /**
   * Whose tree the primary file gets by the user's choice, when it is not that file's own: the
   * dialog said every file "gets its own sample's tree" of a file given another's.
   */
  primaryByChoice?: string;
  /** That FCS's loaded entry, by id: the file the dialog paired, not the first of its name. */
  primaryEntryId?: string;
  /** The primary strategy's origin (a FlowJo group), for naming its template. */
  primaryOrigin?: string;
  /** The matrix question was already put in the workspace-open dialog; do not ask again. */
  matrixAnswered?: boolean;
  /** Files the workspace open loaded for this import; cancelling it removes them again. */
  openedSampleIds?: readonly string[];
  /** What the conversion skipped or could not read; shown beside the result, not cleared by it. */
  notes?: readonly string[];
  /**
   * Under a per-file import, the found files whose own strategy could not be converted or
   * parsed. They follow the imported tree without tailoring, and the result counts them.
   */
  unreadFiles?: readonly Readonly<{
    name: string; entryId: string | null;
    /** Its strategy could not be read, or it was read and could not be applied to this file. */
    reason?: "unreadable" | "unapplied";
  }>[];
  /** Files the open loaded that no workspace sample is: they follow the tree, and are counted. */
  followFiles?: readonly Readonly<{ name: string; entryId: string }>[];
  /**
   * A Cytobank file's per-file tailoring: each loaded file Cytobank tailored gates for, with the
   * tree it used for that file, parsed against that file. Applied as that file's tailoring.
   */
  cytobankTailoring?: readonly Readonly<{ fileName: string; entryId: string; result: GatingMLResult }>[];
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
    /**
     * Where the matrix came from: a FlowJo workspace, the Gating-ML file itself, or a file the
     * user supplied for a compensation the Gating-ML file names and does not carry.
     */
    source: "workspace" | "gatingml" | "supplied";
  } | null;
  /** Which matrix to evaluate the gates with, when the two disagree. */
  matrixChoice: "workspace" | "file";
  /**
   * The import prepared for each answer, while the dialog asks which matrix: the gates GateLab can
   * hold depend on the matrix installed (gatingMLImportOptionsFor), so choosing one swaps in what
   * was prepared for it. Absent when the answer changes nothing the import holds.
   */
  byMatrixChoice?: Record<"workspace" | "file", Pick<PendingGatingMLImport,
    "result" | "siblingTrees" | "compensation" | "mergeBlockedReason" | "compensationNote">>;
  /**
   * Gates drawn under a compensation the file names and does not carry
   * (GatingMLResult.missing_compensation): the import waits for the user to supply that matrix
   * or to choose the FCS file's own knowingly.
   */
  missingMatrix?: { supplied: string | null; useFcs: boolean; error: string | null };
  /**
   * "Evaluate gates as FlowJo does", for a FlowJo workspace imported onto the loaded files from
   * the Import menu, which no earlier dialog asked: the import dialog offers it, and `redo` reads
   * the workspace again with the other answer, staging the import afresh. Absent where the dialog
   * that opened the workspace asked it.
   */
  flowJoGridChoice?: { value: boolean; redo: (value: boolean) => Promise<void> };
  /**
   * FlowJo's recorded count of every population of each sample whose strategy this import brings,
   * kept so the applied result can be checked against them (engine/flowjoCountCheck.ts).
   */
  flowJoReferences?: readonly FlowJoReference[];
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

/** The workspace cannot be written as it stands; the message says what has to change first. */
class WorkspaceUnwritableError extends Error {}

const DRAW_TOOLS: { id: DrawMode; Icon: () => React.ReactElement; title: string }[] = [
  { id: "navigate", Icon: NavigateIcon, title: "Navigate (pan / zoom)" },
  { id: "draw-rect", Icon: RectIcon, title: "Rectangle gate — drag a box" },
  { id: "draw-poly", Icon: PolyIcon, title: "Polygon gate — click vertices, double-click to close" },
  { id: "draw-ellipse", Icon: EllipseIcon, title: "Ellipse gate — drag from the centre outward" },
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

/**
 * Elements whose gestures belong to cytof_plot.js, so GateLab's pan must not also start on them.
 *
 * Kept identical to the renderer's own list; a cross-check test compares the two, because the
 * copies drifting apart is exactly how gate labels came to start a pan.
 */
export const CYTOF_OWNED_TARGETS = ".saved-gate, .gate-label, .cytof-xlabel, .cytof-ylabel";

/** What to do instead of merging a sample's trees, under a per-file import onto loaded files. */
const MERGED_TREES_ADVICE_LOADED = "To import one of them alone, import the workspace onto the viewed file again and choose that tree.";

const MODES: { id: DisplayMode; label: string }[] = [
  { id: "pseudocolor", label: "Pseudocolor" },
  { id: "dots", label: "Dots" },
  { id: "contour", label: "Contour" },
];

// Center-column tabs, mirroring GateLabR's tabsetPanel. The left (samples/import/export)
// and right (gates/populations) panels are
// shared across tabs — only the center switches, exactly as in GateLabR.
type TabId = "gating" | "strategy" | "illustration" | "layout" | "statistics" | "panel" | "compensation" | "scales" | "metadata" | "proportions" | "division";
// The Layout tab needs more work before it is offered; its code stays and the flag brings it
// back. While it is hidden nothing sends plots there.
// The Layout tab is shown while it is being finished only when the page is opened with ?layout,
// so it can be tried on a test server without reaching users.
// The Layout tab is shown; "?nolayout" hides it, for a demonstration that should not offer it.
const LAYOUT_TAB_AVAILABLE = typeof location === "undefined" || !new URLSearchParams(location.search).has("nolayout");
const TABS: { id: TabId; label: string }[] = [
  { id: "gating", label: "Gating" },
  { id: "strategy", label: "Strategy" },
  { id: "illustration", label: "Illustration" },
  { id: "layout", label: "Layout" },
  { id: "proportions", label: "Plotting" },
  { id: "division", label: "Division" },
  { id: "statistics", label: "Statistics" },
  { id: "metadata", label: "Metadata" },
  { id: "panel", label: "Panel" },
  // Scales before Compensation: how a channel is shown comes before how it is corrected, and
  // Compensation, the tab used least often once a matrix is settled, sits at the end.
  { id: "scales", label: "Scales" },
  { id: "compensation", label: "Compensation" },
];

/** The tabs' names for the tutorial's "This step is on the … tab". */
const TOUR_TAB_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TABS.map((tab) => [tab.id, tab.label]));

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

/**
 * The end of a Save to SCE or colData message when a population was sent as not evaluated (NA)
 * for some file, because the tree that file is gated under has no such population: the first
 * notes in full, so the user sees which file and population, and a count of the rest.
 */
function notEvaluatedSummary(notes: readonly string[] | undefined): string {
  if (!notes?.length) return "";
  const shown = notes.slice(0, 3).join(" ");
  const rest = notes.length - 3;
  return ` · NA where not evaluated: ${shown}${rest > 0 ? ` And ${rest} more.` : ""}`;
}

function invertIdMap(sourceToCopy: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceToCopy).map(([sourceId, copyId]) => [copyId, sourceId]));
}

function buildPerFileHierarchyCopies(
  sourceRef: HierarchyRef,
  source: StoredHierarchy,
  targets: readonly SampleEntry[],
  existing: readonly HierarchyRef[],
): {
  copies: StoredHierarchy[];
  assignments: Record<string, string>;
  populationIdMaps: Array<Record<string, string>>;
} {
  if (!source.root_population_id || !source.populations[source.root_population_id]) {
    return { copies: [], assignments: {}, populationIdMaps: [] };
  }
  const taken = [...existing];
  const copies: StoredHierarchy[] = [];
  const assignments: Record<string, string> = {};
  const populationIdMaps: Array<Record<string, string>> = [];
  for (const entry of targets) {
    const copy = cloneHierarchyTree(
      source.populations,
      source.root_population_id,
      source.gates,
      source.gate_order,
    );
    const id = newHierarchyId();
    const baseName = sourceRef.source_hierarchy_id
      ? `${entry.name} · copy of ${sourceRef.name}`
      : `${entry.name} · ${sourceRef.name}`;
    const name = uniqueHierarchyName(baseName, taken);
    taken.push({ id, name });
    copies.push({
      id,
      name,
      owner_sample_id: entry.id,
      structure_locked: true,
      source_hierarchy_id: sourceRef.id,
      source_gate_ids: invertIdMap(copy.gateIdMap),
      source_population_ids: invertIdMap(copy.idMap),
      gates: copy.gates,
      gate_order: copy.gate_order,
      populations: copy.populations,
      root_population_id: copy.root_population_id,
      active_population_id: copy.root_population_id,
      selected_pop_ids: [],
    });
    assignments[entry.id] = id;
    populationIdMaps.push(copy.idMap);
  }
  return { copies, assignments, populationIdMaps };
}

/** Axis ranges can be parked per file without splitting the shared display-transform registry. */
function axisScaleContextKey(
  sampleId: string | null,
  workspaceScaleContextKey: string | null,
  lockedScaleContextKey: string | null,
  lockBetweenFiles: boolean,
): string | null {
  // Locked, one frame serves every file and both the original and the compensated view of each;
  // unlocked, each file's view keeps its own.
  if (lockBetweenFiles) return lockedScaleContextKey ? JSON.stringify(["locked", lockedScaleContextKey]) : null;
  if (!workspaceScaleContextKey || !sampleId) return null;
  return JSON.stringify(["sample", sampleId, workspaceScaleContextKey]);
}

function autoFittedScaleKey(contextKey: string, channelKey: string): string {
  return JSON.stringify([contextKey, channelKey]);
}

function sameGlobalScales(left: GlobalScales, right: GlobalScales): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return !!b && a[0] === b[0] && a[1] === b[1];
  });
}

function restoredAxisScaleMaps(
  scales: WorkspaceFile["scales"],
  entries: readonly SampleEntry[],
  activeIndex: number,
  lockBetweenFiles: boolean,
): ReadonlyMap<string, GlobalScales> {
  const restored = new Map<string, GlobalScales>();
  for (const entry of entries) {
    const key = axisScaleContextKey(entry.id, entry.sample.workspaceScaleContextKey, entry.sample.lockedScaleContextKey, false);
    const ranges = scales.perSampleGlobalScales?.[entry.id];
    if (key && ranges) restored.set(key, ranges);
  }
  const active = entries[activeIndex];
  if (!active) return restored;
  const activeKey = axisScaleContextKey(
    active.id,
    active.sample.workspaceScaleContextKey,
    active.sample.lockedScaleContextKey,
    lockBetweenFiles,
  );
  if (activeKey && !restored.has(activeKey)) restored.set(activeKey, scales.globalScales ?? {});
  return restored;
}

interface ResolvedReferenceFcs {
  bytes: Uint8Array;
  handle: FileSystemFileHandle | null;
  sourcePath?: string;
  /** The open sample it was taken from, when it was. */
  openId?: string;
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
  /**
   * Files matched by the folders or files chosen so far, by the requirement's data path: the
   * files of a workspace can sit in several folders, chosen one after another.
   */
  found: ReadonlyMap<string, RelinkedSource>;
}

/** A file chosen for a workspace entry, with where it was chosen from, for the path it is reported at. */
interface RelinkedSource {
  source: PickedFileSource;
  sourceName: string;
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

/** A categorical colData column as fetched from the host: level names and per-sample codes. */
interface HostCategoricalValues {
  levels: string[];
  /** Fixed by the host (metadata(sce)$gatelab_palettes); overrides the palette choice. */
  colors?: string[];
  /** Per SCE sample id: one code per event, or one code for the whole sample. 255 is missing. */
  bySample: Record<string, Uint8Array | number>;
}

function categoricalPalette(column: HostCategoricalValues, palette: PaletteName): string[] {
  return column.colors ?? paletteColors(palette, column.levels.length);
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
  /**
   * After a folder scan whose only problem is same-named files that record other acquisitions:
   * the files it would take, if the user explicitly chooses them anyway. Never taken unasked.
   */
  const [workspaceRelinkOverride, setWorkspaceRelinkOverride] = useState<{
    take: readonly { requirement: WorkspaceFcsRequirement; source: PickedFileSource; sourceName: string }[];
    byChoice: readonly { fileName: string; path: string }[];
  } | null>(null);
  /** What the last choice of folder or files found, and what is still to find; shown in the dialog. */
  const [workspaceRelinkNote, setWorkspaceRelinkNote] = useState<string | null>(null);
  /** Files relinked by that choice, named in the open's result. */
  /**
   * Samples a workspace was saved with compensation on for, whose matrix is not available now (a
   * matrix taken from a FlowJo workspace or a Gating-ML file, saved before workspaces kept it, for a
   * file that carries none). Saved with compensation still on while they have no matrix, so opening
   * such a workspace does not write compensation off into it at the next autosave.
   */
  const compensationPendingRef = useRef<ReadonlySet<string>>(new Set());
  const relinkedByChoiceRef = useRef<readonly { fileName: string; path: string }[]>([]);
  /**
   * Files relinked over other files of their name, in any case, that the identity they were saved
   * with does not confirm (it agrees on $TOT or $DATE only, or their keywords could not be read):
   * said with the result, which said nothing when the exact-named file was another acquisition.
   */
  const relinkedUnconfirmedRef = useRef<readonly { fileName: string; path: string; agree: readonly string[]; setAside: readonly string[] }[]>([]);
  const workspaceRelinkResolverRef = useRef<
    ((resolved: ReadonlyMap<string, ResolvedReferenceFcs> | null) => void) | null
  >(null);
  // Global sample filter (R's rv$sample_mask): samples excluded from the multi-sample analysis
  // tabs (Statistics / Proportions). New samples are included by default; default = all included.
  const [excludedSampleIds, setExcludedSampleIds] = useState<Set<string>>(new Set());
  // The plot shows one file, or, pooled, the selected files. A pool follows the selection as it
  // changes and edits the tree; the samples of a mass cytometry SCE open pooled. Row selection is
  // otherwise for actions, and the viewed file is chosen with Enter or a plain click.
  const [poolSelection, setPoolSelection] = useState(false);
  // Groups: each file is gated under the tree it is assigned to, its own copy or a group's
  // template (an unassigned file, or one whose tree was deleted, under the first). A template
  // draws its whole group, a copy its file. `includedSamples` and the sample list are derived
  // below the core state.
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
  /** The workspaces opened or saved lately, for the Workspace menu; read from the browser's store on load and after each open or save. */
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const refreshRecentWorkspaces = useCallback(() => {
    if (!supportsFileSystemAccess()) return;
    void listRecentWorkspaces().then(setRecentWorkspaces).catch(() => undefined);
  }, []);
  useEffect(() => { refreshRecentWorkspaces(); }, [refreshRecentWorkspaces]);
  const noteRecentWorkspace = useCallback((handle: FileSystemFileHandle | null, name: string) => {
    if (!handle || !supportsFileSystemAccess()) return;
    void rememberRecentWorkspace(handle, name).then(refreshRecentWorkspaces).catch(() => undefined);
  }, [refreshRecentWorkspaces]);
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
  // Not while an assay is drawn as stored: a compensated layer is linear values beside counts.
  const canUseCompensatedAssay = sample !== null && sample.hostedAssaySpace !== "display" && (
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
  const [lockScalesBetweenFiles, setLockScalesBetweenFiles] = useState(false);
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
  // Categorical colData columns the host offers for "Colour by", and the ones fetched so far.
  // Values arrive per sample as one code per event, exactly the form the categorical export sends
  // the other way, and are fetched only when a column is chosen: a large SCE can carry many
  // annotation columns, and none of them belongs in the dataset payload.
  const [hostCategoricalColumns, setHostCategoricalColumns] =
    useState<readonly Readonly<{ name: string; levelCount: number }>[]>([]);
  const [hostCategoricalValues, setHostCategoricalValues] =
    useState<Record<string, HostCategoricalValues>>({});
  const hostCategoricalLoadingRef = useRef<Set<string>>(new Set());
  const [overlayColDataColumn, setOverlayColDataColumn] = useState<string | null>(null);
  const [hostDatasetDescriptor, setHostDatasetDescriptor] =
    useState<GateLabHostDatasetDescriptor | null>(null);
  /** The SCE assay the samples are drawn from (the header's choice); null until the SCE is loaded. */
  const [hostDrawnAssayId, setHostDrawnAssayId] = useState<string | null>(null);
  /**
   * Saved compensation bindings of samples drawn from a display assay: a compensated layer holds
   * linear values, so it is not installed while that assay is drawn, and the binding is carried
   * in every save until a linear assay is drawn again and the layer installed.
   */
  const hostedCompensationBindingsRef = useRef<Map<string, SampleAssayBinding>>(new Map());
  // Linear assays other than the counts the samples compensate from: candidates to adopt as a
  // compensated layer. The drawn assay is left out as before; counts too, since it is the source
  // whichever assay is drawn.
  const hostExistingCompensatedAssays = useMemo(
    () => (hostDatasetDescriptor?.assays ?? []).filter(
      (assay): assay is GateLabHostAssayDescriptor =>
        assay.coordinateSpace === "linear" &&
        assay.role !== "counts" &&
        assay.id !== hostDrawnAssayId &&
        !samples.some(({ hostSource }) => hostSource?.assayId === assay.id),
    ),
    [hostDatasetDescriptor, hostDrawnAssayId, samples],
  );
  const hostSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastHostSavedEditRevisionRef = useRef(-1);
  const lastHostSaveResultRef = useRef<GateLabHostWorkspaceWriteResult | null>(null);
  // Identifies this browser session in the SCE's workspace record, so a write whose reply was
  // lost can be recognised as ours and resynced from rather than dead-ending every later save.
  const hostWriterIdRef = useRef<string | null>(null);
  if (hostWriterIdRef.current === null) hostWriterIdRef.current = crypto.randomUUID();
  const [xIdx, setXIdx] = useState(0);
  const [yIdx, setYIdx] = useState(1);
  const [mode, setMode] = useState<DisplayMode>("pseudocolor");
  // While a pan or stretch is under way in contour mode the plot is drawn as dots: the contours
  // rebuild their density on every range change, and holding the range until release froze the
  // view instead, so the drag could not be judged. Cleared when the drag commits.
  const [dragPreview, setDragPreview] = useState<DisplayMode | null>(null);
  const plotMode: DisplayMode = dragPreview ?? mode;
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
  const pendingFitOnLoad = useRef<Readonly<{
    contextKey: string;
    ranges: GlobalScales;
  }> | null>(null);
  // Which global scales GateLab fitted itself, and under which display transform. A range the
  // user pinned in the Scales tab is absent here, which is what keeps it from being discarded.
  const autoFittedScales = useRef(new Map<string, string>());
  // Axis pairs already fitted, so a fit happens once per plot rather than on every click.
  const fittedAxisPairs = useRef(new Set<string>());
  const [panelVersion, setPanelVersion] = useState(0); // bumps when a channel display label changes
  const [crud, setCrud] = useState<CrudModal | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  /** The menu a right-click on a polygon's vertex or edge opens: remove that vertex, or add one there. */
  const [plotMenu, setPlotMenu] = useState<ContextMenuState | null>(null);
  /**
   * A gate being fitted to its events from its menu: the settings, where the panel opens, and the
   * fit at those settings, which the plot draws in the gate's place until Apply or Cancel. The
   * fit reads the active file's events of the plotted population, so the file and the population
   * are pinned: a change to either, or any other edit of the gates, closes the panel.
   */
  const [fitGate, setFitGate] = useState<{
    gateId: string;
    at: [number, number];
    box?: [number, number, number, number];
    settings: FitGateSettings;
    result: FitGateResult | null;
    sampleId: string;
    populationId: string | null;
    gateVersion: number;
  } | null>(null);
  const [leftWidth, setLeftWidth] = useState(INITIAL_LEFT_PANE_WIDTH);
  const [sideWidth, setSideWidth] = useState(INITIAL_RIGHT_PANE_WIDTH);
  usePopoverDismissal();
  const [autoSizePopulations, setAutoSizePopulations] = useState(true);
  /** Bumped by the resize handle's double-click: the one fit that may narrow the pane. */
  const [sideFitTick, setSideFitTick] = useState(0);
  const sideFitApplied = useRef(0);
  const [xRange, setXRange] = useState<[number, number] | null>(null);
  const [yRange, setYRange] = useState<[number, number] | null>(null);
  const [maxEvents, setMaxEvents] = useState(50000); // 0 = all (no downsampling)
  /** The cap "All events" goes back to when switched off: the last one set above zero. */
  const lastMaxEvents = useRef(50000);
  useEffect(() => {
    if (maxEvents > 0) lastMaxEvents.current = maxEvents;
  }, [maxEvents]);
  const [activeTab, setActiveTab] = useState<TabId>("gating");
  // The walkthrough tutorial: it reads the app through readTourContext (declared below, called
  // only after a render) and moves on when a step's check says the user has done it.
  const tour = useTour(readTourContext, arriveForTour);
  /** Things done that leave no other trace the tutorial could read: exports and saves, counted. */
  const tourSignals = useRef({ layoutExports: 0, statsDownloads: 0, workspaceSaves: 0 });
  // The tutorial opens the demo for a step that needs a workspace.
  const tourOpeningDemo = useRef<"idle" | "opening" | "failed">("idle");
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
  const [layoutWorkspace, setLayoutWorkspace] = useState<LayoutWorkspace>(
    () => createDefaultLayoutWorkspace(),
  );
  const [fcsAssay, setFcsAssay] = useState<FcsExportAssay>("original");
  const [fcsScope, setFcsScope] = useState<"active" | "combined" | "split">("split");
  const [fcsMinimumEvents, setFcsMinimumEvents] = useState(0);
  const [fcsExportOpen, setFcsExportOpen] = useState(false);
  const [hierarchyModal, setHierarchyModal] = useState<HierarchyModalMode | null>(null);
  /** Revert workspace…: the checkpoints kept for this workspace, while they are read and once listed. */
  const [historyPicker, setHistoryPicker] = useState<{ checkpoints: WorkspaceCheckpoint[]; loading: boolean } | null>(null);
  const [promoteConfirmOpen, setPromoteConfirmOpen] = useState(false);
  const [clearGatingConfirmOpen, setClearGatingConfirmOpen] = useState(false);
  const [hierarchyCopyDraft, setHierarchyCopyDraft] = useState<{ sourceId: string; fileIds: string[]; revert?: boolean } | null>(null);
  const [hierarchyActionMessage, setHierarchyActionMessage] = useState<string | null>(null);
  /** Where edits go, chosen by the user and held until they choose again: the tree, the viewed file's group, or the file alone. */
  const [editMode, setEditMode] = useState<EditTarget>("tree");
  /** The group dialog: naming a new group of the selected files, renaming or deleting one. */
  const [groupModal, setGroupModal] = useState<{ mode: "new" | "rename" | "delete" | "fromMetadata"; groupId?: string } | null>(null);
  const [pendingGatingMlImport, setPendingGatingMlImport] = useState<PendingGatingMLImport | null>(null);
  // One import at a time. The confirmation's Import button stayed live while the import ran, so a
  // double-click applied it twice and every hierarchy of a per-file workspace appeared doubled.
  const gatingImportBusyRef = useRef(false);
  const [gatingImportBusy, setGatingImportBusy] = useState(false);
  /** "Evaluate gates as FlowJo does" was changed in the import dialog; the workspace is being read again. */
  const [flowJoGridRedoing, setFlowJoGridRedoing] = useState(false);
  const [barcodeImport, setBarcodeImport] = useState<BarcodeImportDraft | null>(null);
  const [barcodeSave, setBarcodeSave] = useState<{
    learned: LearnedBarcodeTemplate | null;
    csv: string;
    summary: BarcodeSaveSummary;
  } | null>(null);
  const barcodeRef = useRef<HTMLInputElement>(null);
  // A workspace whose sample could not be resolved unambiguously; the user picks one.
  const [wspPicker, setWspPicker] = useState<
    {
      text: string; samples: FlowJoSampleSummary[]; reason: string;
      /** The loaded file the chosen sample's tree will be applied to; every row says so. */
      fileName: string;
      /** The loaded file's keywords, for showing what each sample records against them. */
      keywords: Record<string, string>;
      /** Every sample of the workspace, for pairing the other loaded files once one is chosen. */
      wsSamples: FlowJoSampleSummary[];
      /** The samples the file could be, where the keywords cannot tell; choosing one says which it is. */
      couldBe: number[];
      /** Asked by a workspace open: the choices it made, carried into the import of the sample picked. */
      fromOpen?: {
        strategyIndex: number; treeIndex: number | null;
        matrixChoice: "workspace" | "file" | null; openedSampleIds: readonly string[];
        flowJoGrid?: boolean;
      };
    } | null
  >(null);
  /**
   * A .wsp imported onto the viewed file, where several other loaded files could each be one
   * sample and nothing tells which: the user says, before the import. They used to follow the
   * viewed file's sample's tree, and the result said "none was chosen" of a choice never offered.
   */
  const [loadedContest, setLoadedContest] = useState<
    {
      text: string; wsSamples: readonly FlowJoSampleSummary[]; choice: FlowJoSampleSummary;
      matchedOn: FlowJoSampleMatchKey | null; crossTo: string | null; pairingNote: string | null;
      contested: FlowJoWorkspacePairing["contested"];
      /** Sample index -> the loaded file's id chosen for it, or "" for none. */
      answers: Record<number, string>;
      /**
       * Loaded files several samples could each be -- two samples recording one acquisition -- and
       * nothing tells which. They followed the viewed file's tree, and the result said "none was
       * chosen" of a choice never offered.
       */
      undecided: FlowJoWorkspacePairing["ambiguous"];
      /** Loaded file id -> the sample index chosen for it, or "" for none. */
      fileAnswers: Record<string, string>;
    } | null
  >(null);
  /** A sample holding more than one independent tree; GateLab can hold only one. */
  const [treePicker, setTreePicker] = useState<
    {
      text: string; sample: FlowJoSampleSummary; matchedOn: FlowJoSampleMatchKey | null;
      /** Set when the sample is not the file its tree is applied to, and the user chose so. */
      crossTo?: string | null;
      /** Answered in the open dialog, and carried to whichever tree is imported instead. */
      matrixChoice?: "workspace" | "file" | null;
      /** The files the workspace open loaded; cancelling the picker unloads them again. */
      openedSampleIds?: readonly string[];
      /** The trees chosen that could not be imported, and why, the latest last; the picker offers the rest. */
      failed?: readonly { index: number; why: string }[];
      /** Files the result names as following the tree, carried to whichever tree is imported. */
      unpaired?: readonly Readonly<{ name: string; entryId: string | null; why: string }>[];
      byChoice?: readonly Readonly<{ name: string; sample: string }>[];
      pairingNote?: string | null;
      loadNotes?: readonly string[];
      /** "Evaluate gates as FlowJo does", as the open chose it; the tree imported instead keeps it. */
      flowJoGrid?: boolean;
      /** Not asked yet: the import dialog asks it (a workspace imported onto the loaded files). */
      flowJoGridInDialog?: boolean;
      /**
       * Other loaded files that are gated samples of the workspace, the viewed file's first: the
       * picker then also offers every tree of each file, each file its own sample's (one hierarchy
       * per file). Choosing one tree instead imports it alone, and those files follow it by choice.
       */
      perFileOption?: readonly Readonly<{ sample: FlowJoSampleSummary; fileName: string; entryId: string | null }>[];
    } | null
  >(null);
  /**
   * A Cytobank file whose per-file tailoring names a file that several loaded files are named
   * like. Cytobank records a file by name alone, so which of them it is is the user's to say;
   * the tailoring used to be applied to neither, without asking.
   */
  const [cytobankAsk, setCytobankAsk] = useState<{
    text: string;
    pairs: { fileName: string; entryId: string; gatingMl: string }[];
    notes: string[];
    ambiguous: { fileName: string; gates: number; entryIds: string[] }[];
    /** The answer per ambiguous name: the loaded file's id, or null for none of them. */
    answers: Record<string, string | null>;
  } | null>(null);
  /**
   * A FACSDiva experiment whose tree for the loaded file is not decided: its tube is not in the
   * experiment, or several trees could apply. The user chooses, and every row says what it
   * imports onto which file.
   */
  const [divaPicker, setDivaPicker] = useState<{
    text: string;
    trees: DivaGateTreeSummary[];
    tubes: DivaTubeSummary[];
    reason: string;
    fileName: string;
    keywords: Record<string, string>;
    /** The tube the loaded file IS, when one is, for a worksheet tree's compensation. */
    tubeHint: number | null;
  } | null>(null);
  /** A FACSChorus experiment: the gates as they are now, and a snapshot per sort; pick one. */
  const [chorusPicker, setChorusPicker] = useState<
    { experiment: ChorusExperiment | null; trees: ChorusTreeSummary[] } | null
  >(null);
  // Every loaded FCS the S8 exported carries the recording it is and the gates it was made
  // under (BDCHORUSDATARECORD); read once per file, since the keyword is half a megabyte.
  const loadedChorusRecordings = useMemo<LoadedChorusRecording[]>(() => {
    const out: LoadedChorusRecording[] = [];
    for (const entry of samples) {
      if (!hasChorusRecording(entry.sample.fcs.keywords)) continue;
      try {
        const recording = readChorusRecording(entry.sample.fcs.keywords);
        if (recording) out.push({ fileId: entry.id, fileName: entry.name, recording });
      } catch {
        // An unreadable record is reported when the user tries to import it, not on load.
      }
    }
    return out;
  }, [samples]);
  const chorusTimeline = useMemo(
    () => (chorusPicker ? buildChorusTimeline(chorusPicker.experiment, loadedChorusRecordings) : null),
    [chorusPicker, loadedChorusRecordings],
  );
  /** A .cef opened before its event data: load the chosen FCS, then apply this tree to it. */
  const [pendingChorusImport, setPendingChorusImport] = useState<{
    experiment: ChorusExperiment;
    treeIndex: number;
    targetSampleId: string | null;
  } | null>(null);
  // The last FACSChorus tree converted for import: which gates it held and what was done with
  // each, so a Chorus statistics export can be set beside GateLab's counts with reasons.
  const [chorusImport, setChorusImport] = useState<ChorusImportRecord | null>(null);
  /** The .cef last opened, kept so the tree can be written back into it (Export FACSChorus experiment). */
  const [chorusSource, setChorusSource] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [chorusStats, setChorusStats] = useState<ChorusStatistics | null>(null);
  /** FlowJo's recorded counts for the files of the last FlowJo import, for the check against them. */
  const [flowJoReferences, setFlowJoReferences] = useState<readonly FlowJoReference[]>([]);
  /** That check as it stood once the import was applied; the dialog counts again when opened. */
  const [flowJoCheckAtImport, setFlowJoCheckAtImport] = useState<FlowJoCountCheck | null>(null);
  const [flowJoCheckOpen, setFlowJoCheckOpen] = useState(false);
  /** This render's per-file counts, for the check made just after an import is applied. */
  const fileCountsRef = useRef<() => FileCounts[]>(() => []);
  useEffect(() => {
    if (!flowJoReferences.length) { setFlowJoCheckAtImport(null); return; }
    // After the render that holds the imported tree, so the counts are that tree's.
    const timer = window.setTimeout(() => setFlowJoCheckAtImport(checkAgainstFlowJo(flowJoReferences, fileCountsRef.current())), 60);
    return () => window.clearTimeout(timer);
  }, [flowJoReferences]);
  const chorusStatsRef = useRef<HTMLInputElement | null>(null);
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
      /**
       * Samples the workspace names but gates nothing on -- compensation controls, typically. They
       * carry no strategy, but their files are data the workspace belongs with, so they are found
       * and loaded beside the gated ones rather than dropped from the dialog.
       */
      dataSamples: FlowJoSampleSummary[];
      /**
       * Files chosen for the open, with their TEXT keywords, which pair them with their samples,
       * and where they were chosen from, when that is known.
       */
      pending: { name: string; file: File; keywords: Record<string, string> | null; path?: string }[];
      /**
       * Files chosen that were not held, because a file of their name is already open or chosen
       * and nothing says they are another acquisition. Named in the dialog and the result: they
       * were dropped without a word.
       */
      notHeld?: { name: string; path?: string; sameAs: string; open: boolean; confirmed: boolean }[];
      strategySample: number | null;
      /**
       * Whether the user chose the row. Until then the selection is the sample the viewed file
       * (or the first file chosen) IS, and follows the files as they are found.
       */
      strategyTouched: boolean;
      /**
       * Which of the strategy sample's top-level trees to import, bound to that sample; null is its
       * first. A workspace holds one tree, so a sample holding several imports the one chosen here
       * and names the rest. A position chosen on one sample is never applied to another's trees.
       */
      strategyTree: ChosenTree | null;
      /** Which sample a file is, where several could be and the keywords cannot tell: file key -> sample. */
      fileChoices: Record<string, number>;
      /** The user's explicit choice to apply the selected sample's tree to a file that is not it. */
      crossFile: { sampleIndex: number; fileKey: string } | null;
      /** Give every resolved FCS its own hierarchy, drawn from its own sample. */
      perFileTrees: boolean;
      /** Which spillover matrix to gate under, answered here rather than in a second dialog. */
      matrixChoice: "workspace" | "file";
      /**
       * "Evaluate gates as FlowJo does": polygons on FlowJo's 256-channel grid and rectangles under
       * FlowJo's axis rules (flowjoWorkspace.ts, FlowJoImportOptions). It holds for the whole open:
       * every file of a per-file import, and a tree chosen again after one failed.
       */
      flowJoGrid: boolean;
    } | null
  >(null);
  /**
   * Resolve a freshly opened workspace's FCS from a folder the user has already granted.
   *
   * A file handle gives no route to its parent, so GateLab cannot look beside a .wsp by itself
   * -- that is the API's security boundary, not an oversight, and no amount of trying gets round
   * it. What it CAN do is remember a folder once granted and read it again without asking, so
   * only the first workspace from a folder needs the button.
   */
  useEffect(() => {
    const st = flowJoOpen;
    if (!st || st.pending.length) return;
    const directory = lastGrantedDirectory();
    if (!directory) return;
    let cancelled = false;
    void (async () => {
      try {
        // Every file the workspace names, or whose $FIL it names. One already in the workspace
        // counts as found and is not loaded again -- unless its keywords say it is another
        // acquisition of the same name, which filesToHold below tells apart.
        const inFolder: { name: string; file: File }[] = [];
        // A remembered folder is trusted only for a workspace it holds itself. The last folder
        // granted may be unrelated, and files there that happen to share a name with the ones
        // this workspace gates are not its files.
        let holdsWorkspace = false;
        for await (const entry of (directory as unknown as {
          values(): AsyncIterable<FileSystemHandle>;
        }).values()) {
          if (entry.kind !== "file") continue;
          if (entry.name.toLowerCase() === st.fileName.toLowerCase()) holdsWorkspace = true;
          if (!/\.fcs$/i.test(entry.name)) continue;
          inFolder.push({ name: entry.name, file: await (entry as FileSystemFileHandle).getFile() });
        }
        if (cancelled || !holdsWorkspace) return;
        const found = await workspaceFilesInFolder([...st.samples, ...st.dataSamples], inFolder, readFcsFileKeywords);
        if (cancelled) return;
        const skipped: SkippedFile<(typeof found)[number]>[] = [];
        const held = filesToHold([], samples.map((s0) => ({ name: s0.name, keywords: s0.sample.fcs.keywords })), found, skipped);
        if (!held.length) return;
        setFlowJoOpen((cur) => cur && cur.fileName === st.fileName && !cur.pending.length
          ? { ...cur, pending: held, notHeld: [...(cur.notHeld ?? []), ...notHeldOf(skipped)] }
          : cur);
      } catch {
        // Permission lapsed, or the folder moved. The button is still there.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowJoOpen?.fileName]);

  /** The files the open dialog can pair with the workspace's samples: those loaded, then those chosen. */
  const flowJoOpenFiles = (st: NonNullable<typeof flowJoOpen>): FlowJoWorkspaceFile[] => [
    ...samples.map((entry) => ({
      key: `loaded:${entry.id}`, name: entry.name, keywords: entry.sample.fcs.keywords,
      path: entry.sourcePath ?? null, events: entry.sample.fcs.nEvents,
    })),
    // By position: two chosen files may share a name when their keywords say they are two acquisitions.
    ...st.pending.map((f, i) => ({ key: `pending:${i}`, name: f.name, keywords: f.keywords, path: f.path ?? null })),
  ];
  /**
   * The loaded files' names as a result should say them, by entry id: a name two loaded files
   * share carries where each is, its event count and when it was recorded. "X (X is sample 14)"
   * said nothing about which X.
   */
  const loadedFileNames = (): Map<string, string> => distinctFileNames(samples.map((entry) => ({
    key: entry.id, name: entry.name, path: entry.sourcePath ?? null, keywords: entry.sample.fcs.keywords, events: entry.sample.fcs.nEvents,
  })));
  /** A loaded file as a message names it: told from another loaded file of its name, else its name. */
  const calledLoaded = (name: string, entryId: string | null | undefined): string =>
    (entryId ? loadedFileNames().get(entryId) : undefined) ?? name;
  /**
   * Whether a staged per-file import lists a file name more than once: among the files that get
   * their own sample's tree, or there and among the files that follow the tree.
   */
  const stagedNameListedTwice = (pending: PendingGatingMLImport) => {
    const nameOf = (f: { name: string; entryId?: string | null }) =>
      (f.entryId ? samples.find((entry) => entry.id === f.entryId)?.name : undefined) ?? f.name;
    const names = [
      ...(pending.primaryFileName ? [nameOf({ name: pending.primaryFileName, entryId: pending.primaryEntryId })] : []),
      ...(pending.siblingTrees ?? []).flatMap((tree) => (tree.fileName ? [nameOf({ name: tree.fileName, entryId: tree.entryId })] : [])),
      ...[...(pending.unreadFiles ?? []), ...(pending.followFiles ?? [])].map(nameOf),
    ];
    return (name: string) => names.filter((n) => sameFileName(n, name)).length > 1;
  };
  /** What the open dialog and its result say of a file it did not hold. */
  const notHeldOf = (skipped: readonly SkippedFile<{ name: string; path?: string }>[]) => skipped.map((k) => ({
    name: k.file.name, ...(k.file.path ? { path: k.file.path } : {}),
    sameAs: k.sameAs.name, open: k.open, confirmed: k.confirmed,
  }));
  /**
   * Every sample of an open paired with the file that IS it, gated and ungated together, and
   * what the dialog will import from that. One computation for the dialog's list, its tree
   * choice, its compensation note and the import itself, so the four cannot disagree.
   */
  /**
   * How the open dialog pairs a multi-data-set file: by the event counts of the files open, and a
   * chosen file not yet read, which may hold one data set per well, for every sample recorded
   * under it. Once read, its data sets are paired one by one (completeFlowJoOpen).
   */
  const flowJoOpenPairingOptions = () => ({
    events: new Map(samples.map((s0) => [s0.name, s0.sample.fcs.nEvents] as const)),
    shareAcrossWells: true,
  });
  const flowJoOpenPlanOf = (st: NonNullable<typeof flowJoOpen>) => {
    const files = flowJoOpenFiles(st);
    const all = [...st.samples, ...st.dataSamples].sort((a, b) => a.index - b.index);
    const pairing = pairFlowJoWorkspaceFiles(all, files, st.fileChoices, flowJoOpenPairingOptions());
    const preferred = [
      ...(activeSampleId ? [`loaded:${activeSampleId}`] : []),
      ...st.pending.map((_, i) => `pending:${i}`),
      ...samples.map((entry) => `loaded:${entry.id}`),
    ];
    const plan = plannedFlowJoOpen(st, pairing.resolutions, files, preferred);
    return { files, pairing, plan };
  };
  /**
   * Whether the workspace's spillover matrix and the chosen FCS's own differ, worked out while
   * the open dialog is still up.
   *
   * This question used to arrive in a SECOND dialog after the first was dismissed, because the
   * comparison needs the FCS parsed and that happened only once the import was under way. The
   * file is right there in the dialog, so it is parsed here instead and the question is asked
   * once, in the step that is already asking about files.
   */
  const [wspMatrixConflict, setWspMatrixConflict] =
    useState<{ label: string; delta: number } | null>(null);
  /**
   * What the open dialog says about compensation when there is nothing to ask: the workspace
   * carries the matrix its gates were drawn under, and it either matches the file's or is the only
   * one there is. Saying so here, before anything changes, is what lets the import go ahead without
   * a second dialog confirming it.
   */
  const [wspMatrixNote, setWspMatrixNote] =
    useState<{ kind: "identical" | "workspace-only"; label: string; channels: number } | null>(null);
  /** True while the comparison below is still running; Import waits for it. */
  const [wspMatrixPending, setWspMatrixPending] = useState(false);
  /**
   * Whether the comparison ran for the tree to be imported. It cannot for a tree the converter
   * cannot read, and then the dialog neither asked nor said anything, so its default answer is
   * not an answer: the import must ask. Carried as one, a tree chosen instead after that tree
   * failed took the workspace's matrix without the question ever being put.
   */
  const [wspMatrixCompared, setWspMatrixCompared] = useState(false);
  useEffect(() => {
    const st = flowJoOpen;
    const settle = (
      conflict: { label: string; delta: number } | null,
      note: { kind: "identical" | "workspace-only"; label: string; channels: number } | null,
      compared = true,
    ) => {
      setWspMatrixConflict(conflict);
      setWspMatrixNote(note);
      setWspMatrixCompared(compared);
      setWspMatrixPending(false);
    };
    // The sample whose tree will be imported, and the file it goes on: the same plan the dialog
    // lists and the import follows. This note used to be worked out for the radio row's sample
    // while the import took another's.
    const planned = st ? flowJoOpenPlanOf(st).plan : null;
    if (!st || !planned?.sample) { settle(null, null); return; }
    // The answer defaults to the workspace's matrix, so an Import clicked before the two matrices
    // had been compared applied it without the question ever being shown.
    setWspMatrixPending(true);
    let cancelled = false;
    void (async () => {
      try {
        const chosen = planned.sample!;
        // The tree that will be imported, so the note speaks of its gates and not another tree's.
        const conversion = flowJoWorkspaceToGatingML(st.text, chosen.index, planned.treeIndex, undefined, { flowJoGrid: st.flowJoGrid, translate: t });
        const workspaceSpillover = conversion.spillover;
        if (!workspaceSpillover) { if (!cancelled) settle(null, null); return; }
        // The file this sample's tree goes onto: the one paired with it, or the one chosen for it.
        const key = planned.target?.fileKey ?? null;
        const loaded = key?.startsWith("loaded:") ? samples.find((entry) => `loaded:${entry.id}` === key) : undefined;
        let target: Sample | null = loaded?.sample ?? null;
        if (!target && key?.startsWith("pending:")) {
          // Not loaded yet: parse the file the user just chose. It is about to be imported
          // anyway, so this reads nothing that was not going to be read.
          const pendingFile = st.pending[Number(key.slice("pending:".length))];
          if (pendingFile) target = new Sample(parseFcs(await pendingFile.file.arrayBuffer()));
        }
        if (cancelled) return;
        if (!target || target.instrument !== "flow") { settle(null, null); return; }
        const preview = target.externalSpilloverPreview(workspaceSpillover.matrix);
        if (preview?.display == null) { settle(null, null); return; }
        const label = workspaceSpillover.name || "the FlowJo workspace";
        // Only gates drawn on compensated channels are affected. A workspace can carry a matrix its
        // strategy never uses, and then there is nothing to say.
        const usesCompensation = conversion.gatingMl.includes('compensation-ref="FCS"');
        const channels = workspaceSpillover.matrix.channels.length - preview.dropped.length;
        if (target.spillover === null) {
          settle(null, usesCompensation ? { kind: "workspace-only", label, channels } : null);
          return;
        }
        const delta = maxCoefficientDelta(target.spillover, preview.display);
        if (delta > 1e-6) settle({ label, delta }, null);
        else settle(null, usesCompensation ? { kind: "identical", label, channels } : null);
      } catch {
        // A file that cannot be parsed, or a tree that cannot be converted, is the import's problem
        // to report, not this preview's. Nothing was compared, so nothing was answered.
        if (!cancelled) settle(null, null, false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowJoOpen?.text, flowJoOpen?.strategySample, flowJoOpen?.strategyTouched, flowJoOpen?.strategyTree, flowJoOpen?.perFileTrees,
      flowJoOpen?.pending, flowJoOpen?.fileChoices, flowJoOpen?.crossFile, samples, activeSampleId]);

  /** Held until the sample the strategy belongs to is the active one. */
  const [pendingFlowJoStrategy, setPendingFlowJoStrategy] = useState<
    {
      text: string; choice: FlowJoSampleSummary;
      treeIndex: number | null;
      /** The loaded file the strategy goes on, by id, and its name for saying so while it waits. */
      target: { entryId: string | null; names: string[] };
      /** Resolved sample -> FCS, when each file is to get its own hierarchy. */
      perFile?: readonly Readonly<{ sample: FlowJoSampleSummary; fileName: string; entryId: string | null }>[];
      /** Set when the user chose to apply this sample's tree to a file that is not this sample. */
      crossTo?: string | null;
      /** Files this open loaded that no sample is, and why; they follow the tree, and are named. */
      unpaired?: readonly Readonly<{ name: string; entryId: string | null; why: string }>[];
      /** Files that are other gated samples and follow this tree because the user chose one shared tree. */
      byChoice?: readonly Readonly<{ name: string; sample: string }>[];
      /** Files chosen for the open that could not be loaded, said with the import's notes. */
      loadNotes?: readonly string[];
      /** Answered in the open dialog, so the import never asks a second time. */
      matrixChoice?: "workspace" | "file";
      /** The files this open loaded, removed again if the strategy question is cancelled. */
      openedSampleIds?: readonly string[];
      /** "Evaluate gates as FlowJo does", as the open dialog left it. */
      flowJoGrid?: boolean;
      /** Not asked yet: the import dialog asks it (a workspace imported onto the loaded files). */
      flowJoGridInDialog?: boolean;
      /**
       * Under a per-file import, the samples already tried as the primary whose strategy could
       * not be read: the next file whose strategy reads becomes the primary instead.
       */
      triedPrimaries?: readonly number[];
      /** Said with the result: how the viewed file was paired with its sample. */
      pairingNote?: string | null;
      mergedTreesAdvice?: string;
      /**
       * Nothing says which data set the strategy's sample is: once the first it could be is
       * active, the sample picker asks which sample that data set is, instead of importing.
       */
      ask?: { samples: FlowJoSampleSummary[]; reason: string; wsSamples: FlowJoSampleSummary[] };
    } | null
  >(null);
  const wspFcsRef = useRef<HTMLInputElement>(null);
  // Space NEW gates are drawn in. A preference about how you work, not a property of the data —
  // the gates themselves carry the truth — so it lives beside gateEdgeMode rather than in the
  // workspace. It never touches a gate that already exists: see the design doc, §2.3.
  const [newGateSpace, setNewGateSpace] = useState<GateSpace>(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("gatelab.newGateSpace") : null;
    return stored === "display" ? "display" : "raw";
  });
  useEffect(() => {
    try {
      localStorage.setItem("gatelab.newGateSpace", newGateSpace);
    } catch {
      /* private mode */
    }
  }, [newGateSpace]);

  // A dragged or drawn vertex snaps to another gate's vertex or edge, so adjacent gates meet
  // without a gap or an overlap; a preference of the machine. Alt held while dragging skips it.
  const [snapToGates, setSnapToGates] = useState(() => {
    try { return localStorage.getItem("gatelab.snapToGates") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("gatelab.snapToGates", snapToGates ? "1" : "0"); } catch { /* private mode */ }
  }, [snapToGates]);
  const gatingPlotActions = useRef<GatingPlotActions | null>(null);
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
  const [flowJoExportOpen, setFlowJoExportOpen] = useState(false);
  const [contourThreshold, setContourThreshold] = useState(5); // outer contour % of peak
  const [contourLevels, setContourLevels] = useState(10);
  const [instrumentMode, setInstrumentMode] = useState<"auto" | "flow" | "cytof">("auto"); // active sample's instrument override
  // Colour-by-factor overlay on the main plot (population partition / division level).
  const [overlayBy, setOverlayBy] = useState<"none" | "population" | "division" | "sample" | "coldata" | "channel">("none");
  /**
   * Which marker the "Colour by → Channel" overlay reads, held as the channel KEY rather than an
   * index. An index means a different marker in the next file, and the pooled display draws
   * several files at once; the key re-resolves per sample the way a division profile's does.
   */
  const [overlayChannelKey, setOverlayChannelKey] = useState<string | null>(null);
  // Scope the gates drawn on the plot to the displayed branch (default), or draw every gate
  // that shares the channel pair. The wide view is for comparing thresholds set on different
  // branches against each other, which the scoped view deliberately hides.
  const [branchGatesOnly, setBranchGatesOnly] = useState(true);
  // The gate list folds away to give the population tree the side panel; remembered per browser.
  const [gatesCollapsed, setGatesCollapsed] = useState(() => {
    try { return localStorage.getItem("gatelab.gatesCollapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("gatelab.gatesCollapsed", gatesCollapsed ? "1" : "0"); } catch { /* private mode */ }
  }, [gatesCollapsed]);
  // Gates owned by no population belong to no branch, so branch scoping can only hide them by
  // accident. On (the default) they stay visible regardless of the displayed branch.
  const [showUnownedGates, setShowUnownedGates] = useState(true);
  // The population list's gate badges in one column after the longest name, or each after its own
  // name. A preference of the machine, kept across workspaces.
  const [alignPopulationGates, setAlignPopulationGates] = useState(() => {
    try { return localStorage.getItem("gatelab.alignPopulationGates") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("gatelab.alignPopulationGates", alignPopulationGates ? "1" : "0"); } catch { /* private mode */ }
  }, [alignPopulationGates]);
  const [overlayPalette, setOverlayPalette] = useState<PaletteName>("default");
  /**
   * Kept apart from `overlayPalette` because the two choices are not interchangeable: the
   * categorical overlays want hues that cycle, a marker wants a ramp that orders. Sharing one
   * setting meant switching from Population to Channel carried Tableau across and painted the
   * colour bar in a sequence that reads as unordered.
   */
  const [overlayMarkerPalette, setOverlayMarkerPalette] = useState<PaletteName>(DEFAULT_MARKER_PALETTE);
  /** Marker contrast, the pseudocolour density slider's counterpart for a marker ramp. */
  const [markerColorPower, setMarkerColorPower] = useState(DEFAULT_MARKER_COLOR_POWER);
  const activeDisplayContextKey = sample?.displayTransformContextKey ?? null;
  const activeWorkspaceScaleContextKey = sample?.workspaceScaleContextKey ?? null;
  const activeLockedScaleContextKey = sample?.lockedScaleContextKey ?? null;
  const activeAxisScaleContextKey = axisScaleContextKey(
    activeSampleId,
    activeWorkspaceScaleContextKey,
    activeLockedScaleContextKey,
    lockScalesBetweenFiles,
  );
  // Transform settings stay workspace-wide. Only these display ranges switch between a file's
  // own map and a deliberately frozen comparison map.
  const {
    globalScales,
    setGlobalScales,
    preserveScalesForContext,
    scalesForContext,
    replaceScalesForNextNamespace,
  } = useContextualGlobalScales(activeAxisScaleContextKey, scaleCacheEpoch);
  // Per-sample metadata (Metadata tab): keyed by SampleEntry.id → { field: value }; ordered columns.
  const [metadata, setMetadata] = useState<Record<string, Record<string, string>>>({});
  const [metadataColumns, setMetadataColumns] = useState<MetadataColumn[]>([]);
  // Which metadata columns show as chip rows; undefined leaves the automatic choice standing.
  // There is no separate chip selection to hold: a chip's state is read from the checked set.
  const [facetColumnChoice, setFacetColumnChoice] = useState<readonly string[] | undefined>(undefined);
  const [facetLocks, setFacetLocks] = useState<FacetLocks>({});
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

  // The gates are filled in by the later assignment, once the store state exists in this render.
  const pzRef = useRef({
    sample, xIdx, yIdx, xRange, yRange, drawMode, mode, globalScales,
    effectiveXRange: null as [number, number] | null,
    effectiveYRange: null as [number, number] | null,
    gates: {} as Record<string, Gate>, snapToGates,
  });
  pzRef.current = {
    sample, xIdx, yIdx, xRange, yRange, drawMode, mode, globalScales,
    effectiveXRange: null,
    effectiveYRange: null,
    gates: pzRef.current.gates, snapToGates,
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
      // unusable. In contour mode the drag is drawn as dots, which pan live per frame like the
      // cheap modes, and the contours reform once when the drag commits.
      if (pzRef.current.mode === "contour") setDragPreview("dots");
      if (!raf) raf = requestAnimationFrame(flush);
    };
    /** Commit the drag's final view to the shared per-channel scale. */
    const commitDrag = () => {
      const fx = pX ?? pzRef.current.xRange; // queued for the next frame, else the last live-panned range
      const fy = pY ?? pzRef.current.yRange;
      flush(); // apply a range still queued for the next frame
      setDragPreview(null); // back to contours, rebuilt once at the final range
      // Commit to the SHARED per-channel scale so the Gating plot AND the Strategy / Illustration
      // tabs inherit it (persisting per-channel, GateLabR-style); then clear the transient
      // per-view range so globalScales is the single source of truth.
      const p = pzRef.current;
      if (p.sample && fx && fy && valid(fx) && valid(fy)) {
        setGlobalScale(p.sample.channels[p.xIdx].key, fx);
        setGlobalScale(p.sample.channels[p.yIdx].key, fy);
        setXRange(null);
        setYRange(null);
        // With "Snap to other gates" on, a gate side the drag left within the snap distance of a
        // plot border lands on it: one edit for every such gate, one Undo step. Snap, not glue: a
        // side further away stays where the view put it.
        if (p.snapToGates) {
          const r = rect();
          const edits = snapGatesToBorders(p.gates, p.sample, {
            xKey: p.sample.channels[p.xIdx].key, yKey: p.sample.channels[p.yIdx].key,
            xRange: fx, yRange: fy, widthPx: r.width, heightPx: r.height,
          });
          if (edits.length) dispatch({ type: "editGates", edits });
        }
      }
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
      // The plot's own floating controls (the fit panel, a menu) sit inside the plot area: a
      // press on a slider there is not a pan, and preventDefault here would stop the slider.
      if (t.closest?.(".gl-fit-panel, .gl-menu-popover")) return;
      const rr = ranges();
      if (!rr) return;
      const r = rect();
      const { xr, yr } = rr;
      e.preventDefault();

      // Shift/Option is read LIVE, from mouse moves AND key presses -- see panGesture.ts.
      startPanSession(
        { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey },
        r, xr, yr,
        {
          // The range this drag has already produced, preferred over ranges(): the writes are
          // coalesced to a frame, so ranges() lags and rebasing off it is a visible jump.
          liveRanges: () => {
            const live = ranges();
            return { xr: pX ?? live?.xr ?? xr, yr: pY ?? live?.yr ?? yr };
          },
          onRanges: queue,
          onEnd: commitDrag,
        },
        window,
      );
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sample]);

  const [state, dispatch] = useReducer(coreReducer, undefined, initialCoreState);
  /** Which tree each file is gated under; in the store so Undo restores it with the copies. */
  const fileHierarchies = state.file_hierarchies;
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    setAutoSizePopulations(false);
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
  useEffect(() => {
    if (!autoSizePopulations || activeTab !== "gating") return;
    const fit = (exact: boolean) => {
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      context.font = "12px Arial";
      const rows = populationTreeOrder(state.populations, state.root_population_id ?? "");
      const wanted = Math.max(INITIAL_RIGHT_PANE_WIDTH, ...rows.map(({ popId, depth }) => {
        const population = state.populations[popId];
        const gateWidth = Math.max(0, ...population.gate_refs.map(ref => context.measureText(state.gates[ref.gate_id]?.name ?? "").width + 28));
        return Math.ceil(context.measureText(population.name).width + gateWidth + depth * 16 + 205);
      }));
      const target = Math.max(320, Math.min(wanted, 900, window.innerWidth - leftWidth - 420));
      // Rounded up to a step, and never narrower than it is: a longer name may widen the pane
      // once, but drawing, renaming and reordering do not move it back and forth. The handle's
      // double-click and a window resize fit it exactly.
      const stepped = Math.min(900, Math.ceil(target / 40) * 40);
      setSideWidth((current) => (exact || stepped > current ? stepped : current));
    };
    fit(sideFitTick !== sideFitApplied.current);
    sideFitApplied.current = sideFitTick;
    const onResize = () => fit(true);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // Geometry and event counts do not change the text width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSizePopulations, activeTab, sideFitTick, JSON.stringify([Object.values(state.populations).map(pop => [pop.name, pop.parent_id, pop.gate_refs]), Object.values(state.gates).map(gate => [gate.gate_id, gate.name])]), state.root_population_id, leftWidth]);
  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    const move = (ev: MouseEvent) => {
      // No upper bound: a workspace with several metadata columns wants a wider panel than any
      // cap chosen here would allow, and the plot beside it simply takes what is left.
      setLeftWidth(Math.max(180, ev.clientX - left));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const hierarchyOfFile = useCallback(
    (id: string) => fileHierarchyId(fileHierarchies[id], state.hierarchies),
    [fileHierarchies, state.hierarchies],
  );
  /** The checked files, before hierarchy narrowing: what Copy to selected acts on. */
  const checkedSamples = useMemo(
    () => samples.filter((s) => !excludedSampleIds.has(s.id)),
    [samples, excludedSampleIds, sampleDataRevisionKey],
  );
  /**
   * Panel identity: the ordered channel keys with their markers.
   *
   * Ordered, because two panels that use the same channels in a different order are different
   * acquisitions; and keyed on the marker as well as the detector, because the same detector
   * carries a different stain between panels — which is exactly the case that must not pool.
   */
  const panelKeyOf = useCallback((s: Sample): string =>
    JSON.stringify(s.channels.map((c) => [c.key, c.pnn])), []);
  // Pooled, the plot draws the selected files under the tree of the viewed one, which supplies the
  // axes and the editable gates, on its panel and its assay layer. A selected file under another
  // tree, on another panel or on another layer is left out of the pool, and so of the cloud, the
  // counts and the background gating, and is named above the plot. The pool exists whenever the
  // mode is on, with nothing selected too, so the guards that keep its tree live hold. When the
  // viewed file is not selected, the next viewed file is one under the pool's tree, so the pool
  // does not change tree because of the order of the list.
  const plotPool = useMemo(() => {
    if (!poolSelection) return null;
    const liveTemplate = templateOf(state.active_hierarchy_id, state.hierarchies);
    const viewed = checkedSamples.find(entry => entry.id === activeSampleId)
      ?? checkedSamples.find(entry => templateOf(hierarchyOfFile(entry.id), state.hierarchies)?.id === liveTemplate?.id)
      ?? checkedSamples[0]
      ?? samples.find(entry => entry.id === activeSampleId);
    const template = viewed ? templateOf(hierarchyOfFile(viewed.id), state.hierarchies) : liveTemplate;
    const pool = {
      ids: [] as string[],
      hierarchyId: template?.id ?? state.active_hierarchy_id,
      otherTree: [] as string[],
      otherPanel: [] as string[],
      otherLayer: [] as string[],
    };
    if (!viewed || !template) return pool;
    const panel = panelKeyOf(viewed.sample);
    const layer = viewed.sample.workspaceScaleContextKey;
    for (const entry of checkedSamples) {
      if (templateOf(hierarchyOfFile(entry.id), state.hierarchies)?.id !== template.id) pool.otherTree.push(entry.name);
      else if (panelKeyOf(entry.sample) !== panel) pool.otherPanel.push(entry.name);
      else if (entry.sample.workspaceScaleContextKey !== layer) pool.otherLayer.push(entry.name);
      else pool.ids.push(entry.id);
    }
    return pool;
    // panelVersion and scalesVersion say when a sample's channels or assay layer changed in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolSelection, checkedSamples, samples, activeSampleId, hierarchyOfFile, state.hierarchies, state.active_hierarchy_id, panelKeyOf, panelVersion, scalesVersion]);
  const includedSamples = useMemo(() => {
    if (poolSelection) {
      const ids = new Set(plotPool?.ids ?? []);
      return samples.filter(entry => ids.has(entry.id));
    }
    return samples.filter(entry => entry.id === activeSampleId);
  }, [samples, poolSelection, plotPool, activeSampleId, sampleDataRevisionKey]);
  /** Why selected files are not in the pool, for the tooltip on the count above the plot. */
  const poolLeftOutNote = plotPool
    ? [
        plotPool.otherTree.length ? t("Not pooled, under another tree: {files}", { files: plotPool.otherTree.join(", ") }) : null,
        plotPool.otherPanel.length ? t("Not pooled, different panel: {files}", { files: plotPool.otherPanel.join(", ") }) : null,
        plotPool.otherLayer.length ? t("Not pooled, different assay layer: {files}", { files: plotPool.otherLayer.join(", ") }) : null,
      ].filter((note): note is string => note !== null).join(" · ")
    : "";
  /**
   * Whether a file's tree is the active tree or descends from it: every file under the
   * workspace tree; a group's files under the group's copy; one file under its own copy. The
   * earlier test walked a file's tree up to the workspace tree and so never matched a group's
   * copy, which emptied the Statistics tab in group mode.
   */
  const fileUnderActiveTree = useCallback((fileId: string): boolean => {
    const byId = new Map(state.hierarchies.map((h) => [h.id, h]));
    const seen = new Set<string>();
    let cur = byId.get(hierarchyOfFile(fileId));
    while (cur && !seen.has(cur.id)) {
      if (cur.id === state.active_hierarchy_id) return true;
      seen.add(cur.id);
      cur = cur.source_hierarchy_id ? byId.get(cur.source_hierarchy_id) : undefined;
    }
    return false;
  }, [state.hierarchies, state.active_hierarchy_id, hierarchyOfFile]);
  // Existing tree-scoped analysis/export actions still use the action selection, not the pool.
  const analysisSamples = useMemo(
    () => checkedSamples.filter((entry) => fileUnderActiveTree(entry.id)),
    [checkedSamples, fileUnderActiveTree],
  );
  /** The Statistics tab tabulates the viewed file whether or not it is checked, and compares the checked ones. */
  const statsSamples = useMemo(() => {
    const active = activeSampleId ? samples.find((entry) => entry.id === activeSampleId) : undefined;
    const listed = !active || analysisSamples.some((entry) => entry.id === active.id) || !fileUnderActiveTree(active.id)
      ? analysisSamples
      : [active, ...analysisSamples];
    // Each file is tabulated under the tree it is gated under, not the live one.
    return listed.map((entry) => ({ ...entry, hierarchyId: hierarchyOfFile(entry.id) }));
  }, [samples, activeSampleId, analysisSamples, fileUnderActiveTree, hierarchyOfFile]);
  /** A hierarchy's tree, live or parked, for reading only. */
  const treeOf = useCallback((id: string) => {
    if (id === state.active_hierarchy_id) {
      return state.root_population_id
        ? { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id }
        : null;
    }
    const h = state.stored_hierarchies[id];
    return h && h.root_population_id
      ? { gates: h.gates, gate_order: h.gate_order, populations: h.populations, root_population_id: h.root_population_id }
      : null;
  }, [state.active_hierarchy_id, state.gates, state.gate_order, state.populations, state.root_population_id, state.stored_hierarchies]);
  /** The live copy's gates whose coordinates differ from its template's: shown as tailored. */
  const activeTailoredGateIds = useMemo<ReadonlySet<string>>(() => {
    const live = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
    if (!live?.owner_sample_id || !live.source_hierarchy_id || !state.root_population_id) return new Set();
    return tailoredGateIds(
      { ...live, gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id, active_population_id: state.active_population_id, selected_pop_ids: state.selected_pop_ids },
      treeOf(live.source_hierarchy_id),
    );
  }, [state.hierarchies, state.active_hierarchy_id, state.gates, state.gate_order, state.populations, state.root_population_id, state.active_population_id, state.selected_pop_ids, treeOf]);
  /** Each file's tailored gates, by name: the badge on its row, and what Revert all acts on. */
  const tailoredGatesOfFile = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const ref of state.hierarchies) {
      if (!ref.owner_sample_id || !ref.source_hierarchy_id) continue;
      const copy = storedTreeOf(ref.id);
      if (!copy) continue;
      const names = [...tailoredGateIds(copy, treeOf(ref.source_hierarchy_id))].map((id) => copy.gates[id]?.name ?? id);
      if (names.length) out.set(ref.owner_sample_id, names);
    }
    return out;
    // storedTreeOf reads the store directly; its inputs are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hierarchies, state.active_hierarchy_id, state.gates, state.gate_order, state.populations, state.root_population_id, state.stored_hierarchies, treeOf]);
  const sampleListItems = useMemo<SampleListItem[]>(() => samples.map((entry) => ({
    id: entry.id,
    name: entry.name,
    eventCount: entry.sample.fcs.nEvents,
    channelCount: entry.sample.channels.length,
    ...(entry.sourcePath ? { sourcePath: entry.sourcePath } : {}),
    ...(tailoredGatesOfFile.has(entry.id) ? { tailored: tailoredGatesOfFile.get(entry.id) } : {}),
    ...(state.file_groups[entry.id] ? (() => {
      const index = state.groups.findIndex((g) => g.id === state.file_groups[entry.id]);
      return index >= 0 ? { group: state.groups[index].name, groupColour: hierarchyColour(index) } : {};
    })() : {}),
    ...(metadata[entry.id] ? { metadata: metadata[entry.id] } : {}),
  })), [samples, sampleDataRevisionKey, tailoredGatesOfFile, metadata, state.file_groups, state.groups]);
  /** The files under the tree, tailored ones marked, for the summary line. */
  const hierarchyGroups = useMemo(
    () => groupsOf(state.hierarchies, samples.map((s0) => ({ id: s0.id, name: s0.name })), fileHierarchies, (copy) => {
      if (!copy.source_hierarchy_id) return null;
      const own = copy.id === state.active_hierarchy_id
        ? (state.root_population_id ? { ...copy, gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id, active_population_id: state.active_population_id, selected_pop_ids: state.selected_pop_ids } : null)
        : state.stored_hierarchies[copy.id] ?? null;
      if (!own) return null;
      return tailoredGateIds(own, treeOf(copy.source_hierarchy_id)).size > 0;
    }),
    [state.hierarchies, samples, fileHierarchies, state.active_hierarchy_id, state.gates, state.gate_order, state.populations, state.root_population_id, state.active_population_id, state.selected_pop_ids, state.stored_hierarchies, treeOf],
  );
  /** The live group in one line: how many files, and whether they follow the template or not. */
  const groupSummary = useMemo(() => {
    const templateId = templateOf(state.active_hierarchy_id, state.hierarchies)?.id;
    const group = hierarchyGroups.find((g) => g.template.id === templateId);
    if (!group || !group.members.length) return "";
    const count = group.members.length;
    const tailored = group.members.filter((m) => m.tailored).length;
    // One file: "1 files · all following" said it of a crowd.
    if (count === 1) return tailored ? t("1 file · tailored") : t("1 file · following");
    if (!tailored) return t("{count} files · all following", { count });
    // Every file on a copy, every copy tailored, and every copy the same as the first: the case
    // after copying one file's gates to the rest, when the template is the odd one out.
    const copies = group.members.map((m) => (m.copy ? storedTreeOf(m.copy.id) : null));
    if (tailored === count && copies.every((c) => c)) {
      const first = copies[0]!;
      const alike = copies.every((c) => {
        const bySource = (tree: StoredHierarchy) => Object.fromEntries(Object.entries(tree.source_gate_ids ?? {}).map(([own, src]) => [src, tree.gates[own]]));
        const x = bySource(first), y = bySource(c!);
        const keys = Object.keys(x);
        return keys.length === Object.keys(y).length && keys.every((k) => x[k] && y[k] && gateGeometryEquals(x[k], y[k]));
      });
      if (alike) return t("{count} files · all identical, none following the tree", { count });
    }
    return t("{count} files · {tailored} tailored", { count, tailored });
    // storedTreeOf reads the store directly; its inputs are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hierarchyGroups, state.active_hierarchy_id, state.hierarchies, state.stored_hierarchies, state.gates, t]);
  /** On the tree: which files have tailored each of its gates, by the tree's gate id. */
  const templateTailoredInFiles = useMemo(() => {
    const out = new Map<string, string[]>();
    const live = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
    if (!live || live.owner_sample_id || !state.root_population_id) return out;
    const template = { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id };
    for (const ref of state.hierarchies) {
      if (ref.source_hierarchy_id !== live.id || !(ref.owner_sample_id || ref.owner_group_id)) continue;
      const copy = storedTreeOf(ref.id);
      if (!copy) continue;
      const name = ref.owner_group_id
        ? (state.groups.find((g) => g.id === ref.owner_group_id)?.name ?? ref.name)
        : samples.find((entry) => entry.id === ref.owner_sample_id)?.name ?? ref.name;
      for (const own of tailoredGateIds(copy, template)) {
        const source = copy.source_gate_ids?.[own];
        if (!source) continue;
        out.set(source, [...(out.get(source) ?? []), name]);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hierarchies, state.active_hierarchy_id, state.gates, state.gate_order, state.populations, state.root_population_id, state.stored_hierarchies, samples]);
  // The chip rows the samples panel offers, and the full column list behind its columns control.
  const sampleFacets = useMemo(
    () => facetColumns(metadata, metadataColumns, facetColumnChoice),
    [metadata, metadataColumns, facetColumnChoice],
  );
  const metadataColumnNames = useMemo(() => metadataColumns.map((column) => column.name), [metadataColumns]);
  /** The level order of the columns that have one, for the Layout tab's metadata iteration. */
  const metadataLevels = useMemo(
    () => Object.fromEntries(metadataColumns.filter((column) => column.levels?.length).map((column) => [column.name, column.levels!])),
    [metadataColumns],
  );
  // Marked rather than hidden: a column with holes is usually a gate saved into colData, which is
  // per-event and so describes only the samples that happened to be uniform. Pinning one is still
  // allowed -- the mark is there so its counts are not read as a property of the samples.
  const partialMetadataColumns = useMemo(() => {
    const sampleCount = Object.keys(metadata).length;
    if (sampleCount === 0) return [];
    return metadataColumnNames.filter((name) => columnCoverage(metadata, name) < sampleCount);
  }, [metadata, metadataColumnNames]);

  const facetLockScope = useMemo(
    () => allowedByLocks(metadata, facetLocks, metadataColumnNames),
    [metadata, facetLocks, metadataColumnNames],
  );
  // What the chips actually offer. Held apart from `sampleFacets` because locking a row has to
  // read the whole column, not the part its own lock has already narrowed.
  const shownFacets = useMemo(
    () => restrictFacets(sampleFacets, facetLockScope),
    [sampleFacets, facetLockScope],
  );

  // A lock bounds the chips but not All / None / Invert or the individual checkboxes, which stay
  // global. Those can therefore leave a sample checked that no chip counts -- exactly the
  // checked-but-hidden file that would feed pooled Statistics unnoticed -- so the board says how
  // many rather than quietly disagreeing with its own tally.
  const facetLockOutside = useMemo(() => {
    if (!facetLockScope) return 0;
    return samples.filter(
      (entry) => !excludedSampleIds.has(entry.id) && !facetLockScope.has(entry.id)).length;
  }, [samples, excludedSampleIds, facetLockScope]);

  /**
   * Click a chip: check every sample carrying that value, or uncheck them all if they already are.
   *
   * Set arithmetic, not a query. Checking a stimulation and then clicking a cell type drops those
   * files from the selection, which is what someone reading the list means by that second click;
   * a query would have narrowed to the intersection instead.
   *
   * A locked row bounds the group to the samples it holds fixed -- the same samples the chip is
   * displaying a count for, so the click does exactly what the chip says.
   */
  function toggleSampleFacet(column: string, value: string): void {
    const group = samples
      .filter((entry) => metadata[entry.id]?.[column] === value)
      .filter((entry) => !facetLockScope || facetLockScope.has(entry.id))
      .map((entry) => entry.id);
    if (group.length === 0) return;
    setExcludedSampleIds((previous) => toggleGroupChecked(group, previous));
  }

  /**
   * Lock a row on what is checked in it, or release it.
   *
   * The frozen values are captured once, at the click, rather than tracked as "whatever is checked
   * here now" -- otherwise unchecking the last CTL sample would silently release the lock and the
   * following click would go workspace-wide.
   */
  function toggleSampleFacetLock(column: string): void {
    setFacetLocks((previous) => {
      const next = { ...previous };
      if (next[column]) {
        delete next[column];
        return next;
      }
      const facet = sampleFacets.find((entry) => entry.name === column);
      const values = facet ? checkedValues(facet, excludedSampleIds) : [];
      if (values.length === 0) return previous;
      next[column] = values;
      return next;
    });
  }

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
  }, [state.gate_version, state.tree_version, scalesVersion, sampleDataRevisionKey, instrumentMode, globalScales, mode, maxEvents, contourThreshold, contourLevels, densityColorPower, xIdx, yIdx, gatingFontSizes, workspaceCompensation, layoutWorkspace]);

  // Autosave lightweight reference workspaces only. Repacking every embedded FCS on each
  // edit would stall large bundled workspaces; bundles retain their format via manual Save.
  const buildWsRef = useRef<() => LiveWorkspaceFile | null>(() => null);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  // A checkpoint a major change asks for once it has landed. Held as state, not a ref, so it is
  // taken on the render that carries the change: a sample mutation (compensation or a transform,
  // which useSampleDataRevisions subscribes to) forces a higher-priority render that commits
  // before the gating dispatch, and a ref read on the first commit snapshotted the state before.
  const [checkpointRequest, setCheckpointRequest] = useState<{ reason: WorkspaceCheckpointReason; token: number } | null>(null);
  const checkpointTokenRef = useRef(0);
  const queueCheckpoint = (reason: WorkspaceCheckpointReason) => setCheckpointRequest({ reason, token: ++checkpointTokenRef.current });

  const checkpointCurrentWorkspace = (reason: WorkspaceCheckpointReason): Promise<void> => {
    // A workspace that cannot be written as it stands (buildWorkspaceFile says why) has no
    // checkpoint to take. That is a rejection, never a throw: this is called from effects and a
    // timer, where a throw is uncaught and React takes the whole app down (it did, when matrix
    // editing was enabled for one file while others drew from their embedded matrices).
    let ws: ReturnType<typeof buildWsRef.current>;
    try {
      ws = buildWsRef.current();
    } catch (error) {
      return Promise.reject(new WorkspaceUnwritableError(error instanceof Error ? error.message : String(error)));
    }
    const id = workspaceIdRef.current;
    if (!ws || !id) return Promise.resolve();
    return saveWorkspaceCheckpoint(id, ws, reason).then(() => undefined);
  };
  /**
   * For a checkpoint nobody awaits: a workspace that could not be written says why in the
   * header, where the user can act on it; a storage failure stays as quiet as it was.
   */
  const reportCheckpointRefusal = (error: unknown) => {
    if (error instanceof WorkspaceUnwritableError) setError(error.message);
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
    setCheckpointRequest(null);
    clearPersistedTabState();

    const nextWorkspaceId = makeWorkspaceId();
    compensationManagerRef.current!.resetWorkspace(nextWorkspaceId);
    setSamples([]);
    setActiveSampleId(null);
    setExcludedSampleIds(new Set());
    setPoolSelection(false);
    setEditMode("tree");
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
    pendingFitOnLoad.current = null;
    setLockScalesBetweenFiles(false);
    setScaleCacheEpoch((epoch) => epoch + 1);
    setGlobalScales({});
    channelScales.clear();
    autoFittedScales.current.clear();
    fittedAxisPairs.current.clear();
    setScalesVersion((version) => version + 1);
    setPanelVersion((version) => version + 1);
    setOverlayBy("none");
    setOverlayChannelKey(null);
    setOverlayPalette("default");

    illustConfigRef.current = null;
    strategyConfigRef.current = null;
    setIllustrationPresets([]);
    setIllustVersion((version) => version + 1);
    setLayoutWorkspace(createDefaultLayoutWorkspace());
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
      void checkpointCurrentWorkspace("automatic").catch(reportCheckpointRefusal);
    }, AUTO_CHECKPOINT_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // This function reads only refs, which are refreshed on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Major imports queue their post-change checkpoint; it is taken on the render that carries it.
  useEffect(() => {
    if (!checkpointRequest) return;
    void checkpointCurrentWorkspace(checkpointRequest.reason).catch(reportCheckpointRefusal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpointRequest]);

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

  // ---- Hierarchies: each owns the gate table and population tree shown in the sidebar ----------
  const activeHierarchy = state.hierarchies.find((h) => h.id === state.active_hierarchy_id) ?? state.hierarchies[0];
  const activeHierarchyIndex = Math.max(0, state.hierarchies.findIndex((h) => h.id === state.active_hierarchy_id)) + 1;
  const activeStructureLocked = activeHierarchy?.structure_locked === true;
  // A locked copy that follows a template takes additions: a gate drawn on it goes into the
  // template for every file (store.ts routeAdditionToTemplate), so the draw tools stay on.
  const additionsRouted = activeStructureLocked && !!activeHierarchy?.source_hierarchy_id;
  const drawingBlocked = activeStructureLocked && !additionsRouted;
  /** Where a routed addition went, for the message after it: the group or file that was being edited. */
  const routedAdditionMessage = (what: string): string => {
    const target = activeHierarchy?.owner_group_id
      ? state.groups.find((g) => g.id === activeHierarchy.owner_group_id)?.name ?? "the group"
      : samples.find((entry) => entry.id === activeHierarchy?.owner_sample_id)?.name ?? "this file";
    return t("{what} was added to the tree, for every file. Move it here to tailor it for {target}.", { what, target });
  };
  /** The tree row above the gate list: the one tree, where edits go, and the ways back. */
  const viewedGroup = activeSampleId ? state.groups.find((g) => g.id === state.file_groups[activeSampleId]) ?? null : null;
  const viewedGroupCopy = viewedGroup ? state.hierarchies.find((h) => h.owner_group_id === viewedGroup.id) ?? null : null;
  const viewedGroupTailored = !!viewedGroupCopy && viewedGroupCopy.source_hierarchy_id !== undefined
    && (() => { const own = storedTreeOf(viewedGroupCopy.id); return !!own && tailoredGateIds(own, treeOf(viewedGroupCopy.source_hierarchy_id!)).size > 0; })();
  /** Names every quadrant gate's four populations by the scheme, as the Create quadrant gate dialog would. */
  const nameQuadrantPopulations = (scheme: QuadrantNaming) => {
    if (!sample) return;
    const labelOf = (key: string) => {
      const idx = sample.index(key);
      return shortChannelLabel(idx === undefined ? undefined : sample.channels[idx], key);
    };
    const names: Record<string, string> = {};
    for (const gate of Object.values(state.gates)) {
      if (gate.gate_type !== "quadrant") continue;
      const four = quadrantPopulationNames(scheme, labelOf(gate.x_channel), labelOf(gate.y_channel));
      for (const pop of Object.values(state.populations)) {
        if (pop.gate_refs.length !== 1) continue;
        const ref = pop.gate_refs[0];
        if (ref.gate_id !== gate.gate_id || !ref.include || !ref.quadrant) continue;
        names[pop.population_id] = four[ref.quadrant - 1];
      }
    }
    if (Object.keys(names).length) dispatch({ type: "renamePopulations", names });
  };

  const treeControls: TreeControlsProps = {
    fileName: fileName || null,
    // A pool edits the tree it draws; the mode held for one file returns with it.
    editMode: plotPool ? "tree" : viewedGroup ? editMode : editMode === "group" ? "tree" : editMode,
    groupName: viewedGroup?.name ?? null,
    groupColour: viewedGroup ? hierarchyColour(state.groups.findIndex((g) => g.id === viewedGroup.id)) : null,
    groupFiles: viewedGroup ? Object.values(state.file_groups).filter((gid) => gid === viewedGroup.id).length : 0,
    groupTailored: viewedGroupTailored,
    sourceLabel: viewedGroup?.name ?? t("the tree"),
    fileTailored: activeSampleId !== null && tailoredGatesOfFile.has(activeSampleId),
    onEditTarget: setEditTarget,
    onRename: () => setHierarchyModal("rename"),
    onNameQuadrants: nameQuadrantPopulations,
    onSwitchTree: switchHierarchyForFile,
    onDeleteTree: () => setHierarchyModal("delete"),
    checkedCount: checkedSamples.length,
    tailoredFiles: tailoredGatesOfFile.size,
    onRevertFile: revertViewedFile,
    onRevertGroup: revertViewedGroup,
    onRevertChecked: revertCheckedFilesToActiveGroup,
    onRevertAll: revertAllFiles,
    onPromote: promoteActiveCopyToGroup,
    summary: groupSummary,
    message: hierarchyActionMessage,
  };

  useEffect(() => {
    if (drawingBlocked && drawMode !== "navigate") setDrawMode("navigate");
  }, [drawingBlocked, drawMode]);

  /** The hierarchy menu selects which owned gate table and population tree are being edited. */
  function switchHierarchyForFile(id: string) {
    setPoolSelection(false);
    const member = samples.find(entry => hierarchyOfFile(entry.id) === id)
      ?? samples.find(entry => templateOf(hierarchyOfFile(entry.id), state.hierarchies)?.id === id);
    if (member) selectSample(member.id, { keepTree: true });
    dispatch({ type: "switchHierarchy", id });
  }

  function poolSelectedFiles() {
    if (checkedSamples.length < 2) return;
    setPoolSelection(true);
    setError(null);
  }

  function inspectSample(id: string) {
    setPoolSelection(false);
    selectSample(id);
    // The live tree follows: the effect below puts the right one live for the edit mode.
  }

  // A pool draws and edits its tree, so that tree is live while the selection is pooled, and the
  // viewed file, which supplies the axes, is one of the pooled files.
  useEffect(() => {
    if (!plotPool) return;
    if (plotPool.hierarchyId !== state.active_hierarchy_id) {
      dispatch({ type: "switchHierarchy", id: plotPool.hierarchyId, silent: true });
    }
    if (plotPool.ids.length > 0 && !plotPool.ids.includes(activeSampleId ?? "")) {
      selectSample(plotPool.ids[0], { keepTree: true });
    }
    // selectSample is recreated every render; the guards above are what stop this re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotPool, state.active_hierarchy_id, activeSampleId]);

  /** Save gates, populations, scales and display settings into the R SingleCellExperiment. */
  function saveToSce() {
                  void saveHostedWorkspace(
                    "explicit",
                    workspaceEditRevisionRef.current,
                  )
                    .then(({ revision, memberships, notEvaluated }) => {
                      setImportMsg(
                        `Saved GateLab workspace to SCE · revision ${revision}` +
                          (memberships
                            ? ` · memberships for ${memberships.populations} population` +
                              `${memberships.populations === 1 ? "" : "s"} in ` +
                              `${memberships.hierarchies} hierarch` +
                              `${memberships.hierarchies === 1 ? "y" : "ies"}` +
                              notEvaluatedSummary(notEvaluated)
                            // The core sent them; an R side that predates them stores nothing and
                            // says nothing, so say it here rather than let the user find out later.
                            : " · no memberships stored: this GateLabR predates them, reload it"),
                      );
                    })
                    .catch((cause) => {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    });
  }

  /** Drop every gate, population and hierarchy and keep the files, scales and metadata. */
  function clearGating() {
    setClearGatingConfirmOpen(false);
    if (!sample) return;
    dispatch({ type: "clearGating", nEvents: sample.fcs.nEvents });
    setPopulationMetadata({});
    setHierarchyActionMessage(null);
    setChorusImport(null);
    markWorkspaceDirty();
    setImportMsg("Gates, populations and hierarchies cleared; the files, scales and metadata are kept. Undo brings them back.");
  }

  /** The tree a viewed file shows: its own copy while it has tailored gates, else the tree itself. */
  /** A file's copy with nothing tailored in it goes, and the file follows the tree; not an undo entry. */
  function dropCopyIfUntailored(fileId: string) {
    const ref = state.hierarchies.find((h) => h.id === hierarchyOfFile(fileId));
    if (!ref?.owner_sample_id || ref.owner_sample_id !== fileId || tailoredGatesOfFile.has(fileId)) return;
    const source = sourceOfFile(fileId);
    if (!source || source.id === ref.id) return;
    dispatch({ type: "assignFileHierarchies", assignments: { [fileId]: source.id }, silent: true });
  }

  /** What a file follows: its group's tree when it is in a group, else the tree itself. */
  function sourceOfFile(fileId: string): HierarchyRef | null {
    const groupId = state.file_groups[fileId];
    const groupCopy = groupId ? state.hierarchies.find((h) => h.owner_group_id === groupId) : undefined;
    return groupCopy ?? templateOf(hierarchyOfFile(fileId), state.hierarchies);
  }

  /** The Groups menu in the file list: everything acts on the selected files, or names a group. */
  function runGroupAction(action: GroupAction) {
    setHierarchyActionMessage(null);
    const fileIds = checkedSamples.map((entry) => entry.id);
    if (action.kind === "new") { setGroupModal({ mode: "new" }); return; }
    if (action.kind === "fromMetadata") { setGroupModal({ mode: "fromMetadata" }); return; }
    if (action.kind === "rename" || action.kind === "delete") { setGroupModal({ mode: action.kind, groupId: action.groupId }); return; }
    if (!fileIds.length) return;
    dispatch({ type: "setFileGroup", fileIds, groupId: action.kind === "assign" ? action.groupId : null });
    markWorkspaceDirty();
    const group = action.kind === "assign" ? state.groups.find((g) => g.id === action.groupId) : null;
    setHierarchyActionMessage(group
      ? `${fileIds.length} file${fileIds.length === 1 ? "" : "s"} now in "${group.name}". Undo is available.`
      : `${fileIds.length} file${fileIds.length === 1 ? "" : "s"} out of their group; they follow the tree. Undo is available.`);
  }

  /** What "Groups from a metadata column" would make of a column: one group per value, over every file. */
  function metadataGroupsPreview(column: string): MetadataGroupsPreview {
    const byValue = new Map<string, string[]>();
    let unassigned = 0;
    for (const entry of samples) {
      const value = metadata[entry.id]?.[column]?.trim();
      if (!value) { unassigned += 1; continue; }
      byValue.set(value, [...(byValue.get(value) ?? []), entry.id]);
    }
    const groups = [...byValue.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([value, ids]) => ({ value, count: ids.length, existing: state.groups.some((g) => g.name === value) }));
    return { groups, unassigned };
  }

  /** One group per value of the column; a group already named as a value takes its files. */
  function applyGroupsFromMetadata(column: string) {
    setGroupModal(null);
    const preview = metadataGroupsPreview(column);
    if (!preview.groups.length) return;
    let made = 0;
    for (const { value } of preview.groups) {
      const fileIds = samples.filter((entry) => metadata[entry.id]?.[column]?.trim() === value).map((entry) => entry.id);
      const existing = state.groups.find((g) => g.name === value);
      if (existing) dispatch({ type: "setFileGroup", fileIds, groupId: existing.id });
      else { dispatch({ type: "addGroup", id: newHierarchyId(), name: value, fileIds }); made += 1; }
    }
    markWorkspaceDirty();
    const names = preview.groups.map((g) => `${g.value} (${g.count})`).join(", ");
    setHierarchyActionMessage(`${preview.groups.length} group${preview.groups.length === 1 ? "" : "s"} from "${column}": ${names}${made < preview.groups.length ? "; groups already named took their files" : ""}. Undo is available, one step per group.`);
  }

  function applyGroupModal(name: string) {
    if (!groupModal) return;
    const modal = groupModal;
    setGroupModal(null);
    if (modal.mode === "new") {
      const fileIds = checkedSamples.map((entry) => entry.id);
      const id = newHierarchyId();
      dispatch({ type: "addGroup", id, name, fileIds });
      markWorkspaceDirty();
      setHierarchyActionMessage(`Group "${name}" made with ${fileIds.length} file${fileIds.length === 1 ? "" : "s"}. Choose it as the edit target to tailor gates for the group.`);
    } else if (modal.mode === "rename" && modal.groupId) {
      dispatch({ type: "renameGroup", id: modal.groupId, name });
      markWorkspaceDirty();
    } else if (modal.mode === "delete" && modal.groupId) {
      const group = state.groups.find((g) => g.id === modal.groupId);
      dispatch({ type: "deleteGroup", id: modal.groupId });
      markWorkspaceDirty();
      if (editMode === "group") setEditMode("tree");
      setHierarchyActionMessage(`Group "${group?.name ?? ""}" deleted; its files follow the tree. Undo is available.`);
    }
  }

  /** The viewed file's group follows the tree again on every gate. */
  function revertViewedGroup() {
    if (!viewedGroupCopy) return;
    dispatch({ type: "revertCopyToSource", id: viewedGroupCopy.id });
    markWorkspaceDirty();
    setHierarchyActionMessage(`"${viewedGroup?.name ?? ""}" follows the tree again; its tailoring is dropped. Undo is available.`);
  }

  /** Where edits go: the tree, for every file, or the viewed file alone. Held until chosen again. */
  function setEditTarget(target: EditTarget) {
    // A file or a group is edited on its own, so choosing either leaves a pool for the viewed file.
    if (target !== "tree") setPoolSelection(false);
    setEditMode(target);
  }

  // The mode holds whatever the viewed file, an undo or an import did to the live tree. This
  // puts the right tree live again: in "this file only" mode the viewed file's own copy, made
  // now, quietly, if it has none; otherwise the tree itself. A copy left behind with nothing
  // tailored in it goes. None of this is an undo entry: it is navigation, not an edit. A pooled
  // view is left alone, since it edits the tree by construction.
  useEffect(() => {
    if (!activeSampleId || plotPool) return;
    const live = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
    if (editMode === "file") {
      if (live?.owner_sample_id === activeSampleId) return;
      if (live?.owner_sample_id && !tailoredGatesOfFile.has(live.owner_sample_id)) {
        dropCopyIfUntailored(live.owner_sample_id); // the source goes live; this runs again for the new copy
        return;
      }
      const copyId = ensureCopyForFile(activeSampleId, { silent: true });
      if (copyId && copyId !== state.active_hierarchy_id) dispatch({ type: "switchHierarchy", id: copyId, silent: true });
      return;
    }
    // The tree, or the viewed file's group when it is in one and the group is chosen.
    const groupId = state.file_groups[activeSampleId];
    const groupCopy = editMode === "group" && groupId ? state.hierarchies.find((h) => h.owner_group_id === groupId) : undefined;
    const wanted = groupCopy ?? (live ? templateOf(live.id, state.hierarchies) : null);
    if (!wanted || wanted.id === state.active_hierarchy_id) return;
    if (live?.owner_sample_id && !tailoredGatesOfFile.has(live.owner_sample_id)) {
      dropCopyIfUntailored(live.owner_sample_id); // its source goes live; this runs again if that is not the one wanted
      return;
    }
    dispatch({ type: "switchHierarchy", id: wanted.id, silent: true });
    // ensureCopyForFile and dropCopyIfUntailored read the store directly; their inputs are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, activeSampleId, plotPool, state.active_hierarchy_id, state.hierarchies, state.file_hierarchies, tailoredGatesOfFile]);

  /** Ask before the viewed file's coordinates become the tree's; the reducer's promoteCopyToTemplate does the rest. */
  function promoteActiveCopyToGroup() {
    if (!activeHierarchy || !(activeHierarchy.owner_sample_id || activeHierarchy.owner_group_id) || !activeHierarchy.source_hierarchy_id) return;
    setPromoteConfirmOpen(true);
  }

  function confirmPromote() {
    setPromoteConfirmOpen(false);
    if (!activeHierarchy || !(activeHierarchy.owner_sample_id || activeHierarchy.owner_group_id)) return;
    const source = state.hierarchies.find((h) => h.id === activeHierarchy.source_hierarchy_id);
    const target = source?.owner_group_id ? `The group "${source.name}"` : `The tree "${source?.name ?? ""}"`;
    const from = activeHierarchy.owner_group_id ? `"${activeHierarchy.name}"` : samples.find((entry) => entry.id === activeHierarchy.owner_sample_id)?.name ?? "this file";
    // Said as the reducer decides it: the success line used to follow a promotion that changed nothing.
    const refusal = promoteRefusal(state, activeHierarchy.id);
    if (refusal) {
      setHierarchyActionMessage(refusal === "other-structure"
        ? `${target} was left as it is: ${from} draws a gate as another kind or holds other populations, so its tree is not the same tree. Apply to the tree takes its gates one at a time.`
        : `${target} was left as it is: ${from}'s tree does not follow it directly.`);
      return;
    }
    // Files that cannot be gated under it keep a copy of their own, with its coordinates.
    const ownChannels = source ? samples.filter((entry) => followsOnOwnChannels(entry.id, source.id)).map((entry) => entry.name) : [];
    dispatch({ type: "promoteCopyToTemplate", copyId: activeHierarchy.id });
    markWorkspaceDirty();
    const tree = source?.owner_group_id ? `the group "${source.name}"` : "the tree";
    setHierarchyActionMessage(`${target} now has ${from}'s gate coordinates, and every file following it follows again.${ownChannelsNote(ownChannels, tree)} Undo is available.`);
  }

  /**
   * Whether the file's own copy follows `sourceId` on channels of its own (copyOnOwnChannels): the
   * file labels a detector differently from the tree's file, and following again keeps the copy.
   */
  function followsOnOwnChannels(fileId: string, sourceId: string): boolean {
    const ref = state.hierarchies.find((h) => h.id === hierarchyOfFile(fileId));
    if (ref?.owner_sample_id !== fileId || ref.source_hierarchy_id !== sourceId) return false;
    const copy = storedTreeOf(ref.id);
    const source = treeOf(sourceId);
    return !!copy && !!source && copyOnOwnChannels(copy, source);
  }

  /** What following again does for files on channels of their own, as a sentence, or nothing. */
  function ownChannelsNote(names: readonly string[], tree: string): string {
    if (!names.length) return "";
    const one = names.length === 1;
    return ` ${names.join(", ")} ${one ? "labels" : "label"} a detector differently from the tree's file, so ${one ? "it keeps a copy of its own" : "each keeps a copy of its own"}, ` +
      `with ${tree}'s coordinates on ${one ? "its" : "their"} own channels; edits to ${tree} do not reach ${one ? "that file" : "those files"}.`;
  }

  /** A hierarchy's stored form, live or parked, for copying from. */
  function storedTreeOf(id: string): StoredHierarchy | null {
    const ref = state.hierarchies.find((h) => h.id === id);
    if (!ref) return null;
    if (id === state.active_hierarchy_id) {
      return {
        ...ref,
        gates: state.gates, gate_order: state.gate_order, populations: state.populations,
        root_population_id: state.root_population_id, active_population_id: state.active_population_id, selected_pop_ids: state.selected_pop_ids,
      };
    }
    return state.stored_hierarchies[id] ?? null;
  }

  /**
   * The file's own copy, made the first time it is wanted: a locked copy of the tree the file is
   * gated under, which then follows its template until the file tailors a gate. Returns the
   * copy's id, existing or new, and makes a new one the live tree.
   */
  function ensureCopyForFile(fileId: string, options?: { silent?: boolean }): string | null {
    const currentId = hierarchyOfFile(fileId);
    const ref = state.hierarchies.find((h) => h.id === currentId);
    const entry = samples.find((s0) => s0.id === fileId);
    if (!ref || !entry) return null;
    if (ref.owner_sample_id === fileId) return ref.id;
    const source = storedTreeOf(currentId);
    if (!source || !source.root_population_id) return null;
    const built = buildPerFileHierarchyCopies(ref, source, [entry], state.hierarchies);
    if (!built.copies.length) return null;
    dispatch({ type: "addHierarchyCopies", copies: built.copies, activeHierarchyId: built.assignments[fileId], keepBrowsingPosition: true, assignments: built.assignments, ...(options?.silent ? { silent: true } : {}) });
    setPopulationMetadata((current) => {
      const next = { ...current };
      for (const idMap of built.populationIdMaps) {
        for (const [oldId, newId] of Object.entries(idMap)) if (current[oldId]) next[newId] = { ...current[oldId] };
      }
      return next;
    });
    markWorkspaceDirty();
    return built.assignments[fileId];
  }

  function revertCheckedFilesToActiveGroup() {
    if (!activeHierarchy || !checkedSamples.length) return;
    const template = templateOf(activeHierarchy.id, state.hierarchies) ?? activeHierarchy;
    // Files with nothing tailored already follow the tree; the confirmation names only files that change.
    const fileIds = checkedSamples.filter((entry) => tailoredGatesOfFile.has(entry.id)).map((entry) => entry.id);
    if (!fileIds.length) {
      setHierarchyActionMessage("Every selected file already follows the tree. Nothing to revert.");
      return;
    }
    setHierarchyActionMessage(null);
    setHierarchyCopyDraft({ sourceId: template.id, fileIds, revert: true });
  }

  /** Every tailored file follows the tree again, after confirmation. */
  function revertAllFiles() {
    if (!activeHierarchy) return;
    const template = templateOf(activeHierarchy.id, state.hierarchies) ?? activeHierarchy;
    const fileIds = samples.filter((entry) => tailoredGatesOfFile.has(entry.id)).map((entry) => entry.id);
    if (!fileIds.length) return;
    setHierarchyActionMessage(null);
    setHierarchyCopyDraft({ sourceId: template.id, fileIds, revert: true });
  }

  function applyHierarchyCopy() {
    if (!hierarchyCopyDraft) return;
    // Reverting is pointing the files back at the tree, as Revert does for one file: their copies
    // go with the move, and one Undo restores every tree and link. A file on channels of its own
    // keeps its copy, which takes the tree's coordinates (followSourceAgain).
    const assignments: Record<string, string> = {};
    const targets = new Set<string>();
    for (const id of hierarchyCopyDraft.fileIds) {
      const source = sourceOfFile(id);
      if (!source) continue;
      assignments[id] = source.id;
      targets.add(source.owner_group_id ? `"${source.name}"` : "the tree");
    }
    if (!Object.keys(assignments).length) { setError("The tree is no longer available."); return; }
    const ownChannels = Object.entries(assignments).filter(([id, sourceId]) => followsOnOwnChannels(id, sourceId))
      .map(([id]) => samples.find((entry) => entry.id === id)?.name ?? id);
    dispatch({ type: "followSourceAgain", assignments });
    setHierarchyCopyDraft(null);
    markWorkspaceDirty();
    const n = hierarchyCopyDraft.fileIds.length;
    const target = targets.size === 1 ? [...targets][0] : "their groups";
    setHierarchyActionMessage(`${n === 1 ? "1 file follows" : `${n} files follow`} ${target} again; ${n === 1 ? "its" : "their"} tailoring is dropped.${ownChannelsNote(ownChannels, target)} Undo is available.`);
  }

  /**
   * The viewed file follows the tree again: its copy, and every tailored gate in it, goes. A file
   * that labels a detector differently from the tree's file keeps its copy, which takes the tree's
   * coordinates on the file's own channels: on the tree itself every gate on that detector held
   * no event, since the tree's gates name a channel the file does not have.
   */
  function revertViewedFile() {
    if (!activeSampleId) return;
    const ref = state.hierarchies.find((h) => h.id === hierarchyOfFile(activeSampleId));
    const source = sourceOfFile(activeSampleId);
    if (!ref?.owner_sample_id || !source || source.id === ref.id) return;
    const target = source.owner_group_id ? `"${source.name}"` : "the tree";
    const ownChannels = followsOnOwnChannels(activeSampleId, source.id);
    // Pointing the file back at what it follows drops the copy and makes that live, as one undo entry.
    dispatch({ type: "followSourceAgain", assignments: { [activeSampleId]: source.id } });
    markWorkspaceDirty();
    setHierarchyActionMessage(ownChannels
      ? `${fileName} takes ${target === "the tree" ? "the tree's" : `${target}'s`} gate coordinates again.${ownChannelsNote([fileName], target)} Undo is available.`
      : `${fileName} follows ${target} again; its tailoring is dropped. Undo is available.`);
  }

  function applyHierarchyAction(mode: HierarchyModalMode, name: string) {
    setHierarchyModal(null);
    const tree = templateOf(state.active_hierarchy_id, state.hierarchies) ?? activeHierarchy;
    if (!tree) return;
    if (mode === "rename") {
      dispatch({ type: "renameHierarchy", id: tree.id, name });
    } else if (mode === "delete") {
      // Only a workspace saved with several trees offers this. The files under the deleted tree
      // follow the tree that is left; their copies go with the move.
      const remaining = state.hierarchies.find((h) => !h.owner_sample_id && h.id !== tree.id);
      if (!remaining) return;
      const assignments = Object.fromEntries(
        samples.filter((entry) => templateOf(hierarchyOfFile(entry.id), state.hierarchies)?.id === tree.id).map((entry) => [entry.id, remaining.id]),
      );
      if (Object.keys(assignments).length) dispatch({ type: "assignFileHierarchies", assignments });
      dispatch({ type: "deleteHierarchy", id: tree.id });
      setImportMsg(`Deleted the tree "${tree.name}" with its gates; its files follow "${remaining.name}".`);
    }
  }

  // ---- Barcode scheme: a sample table becomes debarcoding gates and populations ----------------
  // The table carries one 0/1 per barcode channel per sample; the plane layout (which channels
  // are drawn together) is proposed from column order, declared in the file, or edited in the
  // dialog; the gate shapes come from a template. See src/engine/barcodeScheme.ts.

  async function prepareBarcodeImport(file: File) {
    if (!sample || !activeSampleId) return;
    const text = await file.text();
    const table = parseBarcodeTable(text);
    const parentId =
      state.active_population_id && state.populations[state.active_population_id]
        ? state.active_population_id
        : state.root_population_id ?? "";
    setBarcodeImport({
      fileName: file.name,
      table,
      planes: null,
      template: DEFAULT_BARCODE_TEMPLATE,
      templateLabel: "GateLab default",
      parentId,
      sampleId: activeSampleId,
      // The QC chain belongs directly under the root; attaching under an existing population
      // means the workspace already has one.
      qc: parentId === (state.root_population_id ?? ""),
      reuse: true,
    });
    setError(null);
  }



  const barcodeScheme = useMemo(() => {
    if (!barcodeImport || !sample) return null;
    return resolveBarcodeScheme(barcodeImport.table, sample.channels, barcodeImport.planes ?? undefined);
  }, [barcodeImport, sample]);

  const barcodeQcPreview = useMemo(() => {
    if (!barcodeImport || !barcodeScheme || !sample) return null;
    const preview = previewQcChainFor(barcodeScheme, barcodeImport.template, sample.channels);
    return preview.source === "none" ? null : preview;
  }, [barcodeImport, barcodeScheme, sample]);

  const learnedBarcodeTemplate = useMemo(() => {
    if (!barcodeImport || !sample) return null;
    return learnBarcodeTemplate(Object.values(state.gates), sample.arcsinhCofactor, "learned from the current workspace", state.populations, state.root_population_id, sample);
  }, [barcodeImport, sample, state.gates, state.populations, state.root_population_id]);

  /** A dry build, to tell the dialog how many gates would be reused and created. */
  const barcodeReusePreview = useMemo(() => {
    if (!barcodeImport || !barcodeScheme || !sample || barcodeScheme.problems.length) return null;
    try {
      const r = buildBarcodeGating(barcodeScheme, barcodeImport.template, sample.arcsinhCofactor, {
        qc: barcodeImport.qc,
        channels: sample.channels,
        existingGates: Object.values(state.gates),
        reuse: barcodeImport.reuse,
      });
      return { reused: r.reusedGateIds.length, created: r.nGates };
    } catch {
      return null;
    }
  }, [barcodeImport, barcodeScheme, sample, state.gates]);

  async function loadBarcodeTemplateFile(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isBarcodeTemplate(parsed)) throw new Error("not a GateLab barcode template");
      const template = normalizeBarcodeTemplate(parsed);
      setBarcodeImport((d) => (d ? { ...d, template, templateLabel: file.name } : d));
    } catch (cause) {
      setError(`Could not read ${file.name} as a barcode template: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /** Learn the strategy and open the dialog offering the scheme table and the gate template. */
  function openBarcodeSave() {
    if (!sample) return;
    const sourceName = samples.find((e) => e.id === activeSampleId)?.name ?? "this workspace";
    const learned = learnBarcodeTemplate(
      Object.values(state.gates),
      sample.arcsinhCofactor,
      `learned from ${sourceName}`,
      state.populations,
      state.root_population_id,
      sample,
    );
    if (!learned) {
      // No barcode plane: the file holds the plain hierarchy, every gate and population.
      const out = exportHierarchyCsv(Object.values(state.gates), state.populations, state.root_population_id, sourceName, { context: sample, cofactor: sample.arcsinhCofactor });
      setBarcodeSave({
        learned: null,
        csv: out.csv,
        summary: { mode: "hierarchy", planeLabels: [], qcNames: [], nSamples: 0, nGates: out.nGates, nPopulations: out.nPopulations, hasTemplate: false, notes: out.notes },
      });
      setError(null);
      return;
    }
    const exported = exportBarcodeScheme(Object.values(state.gates), state.populations, state.root_population_id, learned, populationMetadata, sourceName, sample);
    setBarcodeSave({
      learned,
      csv: exported.csv,
      summary: {
        mode: "scheme",
        planeLabels: exported.planeLabels,
        qcNames: learned.qcNames,
        nSamples: exported.nSamples,
        nGates: 0,
        nPopulations: 0,
        hasTemplate: true,
        notes: [...exported.notes, ...learned.notes],
      },
    });
    setError(null);
  }

  function applyBarcodeSave(choice: BarcodeSaveChoice) {
    const saved = barcodeSave;
    setBarcodeSave(null);
    if (!saved) return;
    const written: string[] = [];
    if (choice.scheme) {
      const name = saved.summary.mode === "hierarchy" ? "hierarchy.csv" : "barcode-scheme.csv";
      downloadBlob(name, new Blob([saved.csv], { type: "text/csv;charset=utf-8" }));
      written.push(
        saved.summary.mode === "hierarchy"
          ? `hierarchy.csv (${saved.summary.nGates} gate(s), ${saved.summary.nPopulations} population(s))`
          : `barcode-scheme.csv (${saved.summary.nSamples} sample(s), ${saved.summary.planeLabels.length} plane(s))`,
      );
    }
    if (choice.template && saved.learned) {
      downloadBlob("barcode-template.json", new Blob([JSON.stringify(saved.learned.template, null, 2)], { type: "application/json" }));
      written.push(
        `barcode-template.json (${saved.learned.planes.length} plane(s)` +
          (saved.learned.qcNames.length ? `, QC chain ${saved.learned.qcNames.join(" → ")})` : ", no QC chain)"),
      );
    }
    const notes = saved.summary.notes;
    setImportMsg(`Saved ${written.join(" and ")}.${notes.length ? ` ${notes.join(" ")}` : ""}`);
  }

  function applyBarcodeImport() {
    const draft = barcodeImport;
    const scheme = barcodeScheme;
    if (!draft || !scheme || !sample || draft.sampleId !== activeSampleId) {
      setBarcodeImport(null);
      setError("The active sample changed before the barcode scheme could be imported. Please import the file again.");
      return;
    }
    try {
      // Gates drawn against Time span the sample's own Time range.
      const ranges: Record<string, [number, number]> = {};
      if (draft.qc) {
        for (const g of draft.template.qc.flatMap((p) => p.gates)) {
          if (!g.xFull) continue;
          const key = resolveQcChannel(g.x, sample.channels);
          const ch = key ? sample.channels.find((c) => c.key === key) : undefined;
          if (!ch || ranges[ch.key]) continue;
          const col = sample.fcs.columns[ch.columnIndex];
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < col.length; i++) {
            const v = col[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (Number.isFinite(lo) && Number.isFinite(hi)) ranges[ch.key] = [lo, hi];
        }
      }
      const result = buildBarcodeGating(scheme, draft.template, sample.arcsinhCofactor, {
        qc: draft.qc,
        channels: sample.channels,
        ranges,
        existingGates: Object.values(state.gates),
        reuse: draft.reuse,
      });
      const hasStrategy = state.root_population_id !== null && state.populations[state.root_population_id] !== undefined;
      if (activeStructureLocked) {
        throw new Error("Edits are set to this file only, so a strategy cannot be added here. Choose \"the tree\" as the edit target first; the strategy then goes into the tree for every file.");
      }
      queueCheckpoint("after-barcode-import");
      const attachTo: string | undefined = hasStrategy ? draft.parentId : undefined;
      const strategy = result;
      dispatch({
        type: "importGating",
        gates: strategy.gates,
        gate_order: strategy.gate_order,
        populations: strategy.populations,
        root_population_id: strategy.root_population_id,
        mode: hasStrategy ? "merge" : "replace",
        attachTo,
      });
      // Imported ids are fresh UUIDs, which the merge keeps, so the metadata keys are final.
      setPopulationMetadata((m) => ({ ...m, ...result.populationMetadata }));
      setPopulationMetaColumns((cols) => [
        ...cols,
        ...result.metadataColumns.filter((name) => !cols.some((c) => c.name === name)).map((name) => ({ name })),
      ]);
      setBarcodeImport(null);
      // A "# gate:" line nothing used means the file drew a gate the strategy does not hold: a
      // barcode gate falls back to the template's generic shape when no declaration carries the
      // name the plane generates, which is silent and leaves a strategy that looks complete while
      // holding boxes nobody drew. Reported as an error, not a note, because every population
      // below such a gate is wrong.
      setError(result.unusedDeclarations.length
        ? `${result.unusedDeclarations.length} gate line(s) in the file were not used, so those gates took ` +
          `the template's generic shape instead: ${result.unusedDeclarations.join(", ")}. A barcode gate ` +
          `takes a declared shape only when the "# gate:" name matches the name the plane generates ` +
          `(for a 115In x 113In plane: 113+115-, 113+115+, 113-115-, 113-115+). Rename those lines and import again.`
        : null);
      setImportMsg(
        (scheme.hierarchyOnly ? "Hierarchy: " : "Barcode scheme: ") +
          `${result.nGates} new gate${result.nGates === 1 ? "" : "s"}` +
          (result.reusedGateIds.length ? ` and ${result.reusedGateIds.length} reused` : "") +
          (scheme.hierarchyOnly ? `, ${result.qc.populations.length} population(s)` : ` on ${scheme.planes.length} plane(s), ${result.nPopulations} sample population(s)`) +
          (result.qc.populations.length
            ? ` under ${result.qc.populations.some((p) => p.parent)
              ? result.qc.populations.map((p) => `${p.name}${p.parent ? ` (under ${p.parent})` : ""}`).join(", ")
              : result.qc.populations.map((p) => p.name).join(" → ")}`
            : "") +
          (hasStrategy ? ` in ${state.populations[draft.parentId]?.name ?? "the current root"}` : "") +
          ". Tweak the gates; the populations follow." +
          (result.qc.skipped.length ? ` Left out: ${result.qc.skipped.join(" ")}` : ""),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** The trees of this experiment the viewed file was recorded under, when it is a recording of it. */
  function chorusTreesOfViewedFile(experiment: ChorusExperiment): ReturnType<typeof treesRecordedUnder> {
    if (!sample) return null;
    try {
      return treesRecordedUnder(experiment, readChorusRecording(sample.fcs.keywords));
    } catch {
      return null;
    }
  }

  /**
   * Why applying this tree of the experiment to the viewed file is the user's choice rather than
   * the file's own gating, or null when it is the file's own: the file is not a recording of the
   * experiment, or it is one made under another tree (a snapshot of another sort, or gates changed
   * since). A recording made during Sort 1 given Sort 2's snapshot was imported with nothing said.
   */
  function chorusCrossReason(experiment: ChorusExperiment, treeIndex: number): string | null {
    if (!sample) return null;
    if (isRecordingOfExperiment(experiment, sample.fcs.keywords) !== true) return "it is not a recording of this experiment";
    const own = chorusTreesOfViewedFile(experiment);
    if (!own || own.treeIndices.includes(treeIndex)) return null;
    return `it was recorded under another tree${own.duringSort ? `, during ${own.duringSort}` : ""}` +
      (own.labels.length ? ` (the same as ${own.labels.join(", ")})` : "");
  }

  /**
   * One tree of a FACSChorus experiment, rewritten as Gating-ML and taken through the ordinary path.
   * `cross` names the file, and why, when the tree is not the one the file was recorded under and
   * the user chose to apply it anyway; the result says so.
   */
  async function importChorusTree(experiment: ChorusExperiment, index: number, cross: { file: string; why: string } | null = null) {
    try {
      const conv = chorusToGatingML(experiment, index, { keywords: sample?.fcs.keywords ?? null });
      setChorusImport(conv.record);
      // Every other loaded file that is a recording of this experiment gets the tree it was
      // recorded under -- its own, read from the file -- as a FlowJo workspace's files get their
      // own sample's. They used to follow the chosen tree under "applied to all N files", a
      // recording made during Sort 2 given Sort 1's snapshot, and a file with no record at all,
      // with nothing said. Files that are no recording of the experiment follow it and are named.
      const siblings: { name: string; gatingMl: string; fileName: string; entryId: string; sampleLabel: string; warnings?: readonly string[]; unreadable?: string }[] = [];
      const unpaired: { name: string; entryId: string; why: string }[] = [];
      const currentGates = experiment.panels[0]?.gates ?? null;
      for (const entry of samples) {
        if (entry.id === activeSampleId) continue;
        const ofExperiment = isRecordingOfExperiment(experiment, entry.sample.fcs.keywords);
        if (ofExperiment !== true) {
          unpaired.push({
            name: entry.name, entryId: entry.id,
            why: hasChorusRecording(entry.sample.fcs.keywords)
              ? ofExperiment === false ? "it is a recording of another experiment" : "its FACSChorus record cannot be read"
              : "it carries no FACSChorus record",
          });
          continue;
        }
        try {
          const recording = readChorusRecording(entry.sample.fcs.keywords)!;
          const own = chorusRecordingToGatingML(recording, { currentGates, keywords: entry.sample.fcs.keywords });
          const under = treesRecordedUnder(experiment, recording);
          siblings.push({
            name: entry.name, gatingMl: own.gatingMl, fileName: entry.name, entryId: entry.id,
            sampleLabel: under?.labels.length ? `recorded under ${under.labels.join(", ")}` : `recording "${recording.name}"`,
            ...(own.warnings.length ? { warnings: own.warnings } : {}),
          });
        } catch (e) {
          siblings.push({ name: entry.name, gatingMl: "", fileName: entry.name, entryId: entry.id, sampleLabel: "its recording", unreadable: e instanceof Error ? e.message : String(e) });
        }
      }
      const perFile = siblings.length > 0;
      const notes = perFile && conv.warnings.length ? [`${calledLoaded(fileName, activeSampleId)}: ${conv.warnings.join(" ")}`] : conv.warnings;
      const noteCount = conv.warnings.length + siblings.reduce((n, s0) => n + (s0.warnings?.length ?? 0) + (s0.unreadable !== undefined ? 1 : 0), 0);
      // The notes travel with the import and are shown beside its result: set as the error here,
      // they were cleared again as soon as the import was staged.
      await prepareGatingImportFromGatingML(
        conv.gatingMl,
        ` from FACSChorus experiment · ${conv.label}` +
          (perFile ? " · one tree per file: each other recording gets the tree it was recorded under" : "") +
          (cross ? ` · applied to ${cross.file} by choice: ${cross.why}` : "") +
          (unpaired.length
            ? ` · following the tree without a tree of their own: ${unpaired.map((u) => `${u.name} (${u.why})`).join("; ")}`
            : "") +
          (noteCount ? ` · ${noteCount} note(s)` : ""),
        null,
        siblings,
        perFile ? fileName : null,
        null, [], null,
        notes,
        perFile ? activeSampleId : null,
        unpaired,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Finish an open-first .cef import after the user chooses the FCS carrying its events. */
  async function loadFcsForChorus(
    pending: NonNullable<typeof pendingChorusImport>,
    files: readonly File[],
  ) {
    const file = files[0];
    if (!file) return;
    const entries = await importFcsCandidates([{
      id: crypto.randomUUID(),
      name: file.name,
      file,
      handle: null,
    }]);
    const target = entries[entries.length - 1];
    if (!target) {
      setPendingChorusImport(null);
      return;
    }
    setPendingChorusImport({ ...pending, targetSampleId: target.id });
  }

  /** Select a Chorus tree now; when no sample exists, ask for its event data first. */
  async function chooseChorusTree(experiment: ChorusExperiment, treeIndex: number) {
    setChorusPicker(null);
    if (sample && activeSampleId) {
      // The picker's button said whose gates go onto which file when they are not the file's own
      // tree; pressing it is that choice, and the result repeats it.
      const why = chorusCrossReason(experiment, treeIndex);
      await importChorusTree(experiment, treeIndex, why ? { file: fileName, why } : null);
      return;
    }
    const pending = { experiment, treeIndex, targetSampleId: null };
    setPendingChorusImport(pending);
    setImportMsg("FACSChorus gates selected · choose the FCS file they belong to");
    const usesNativePicker = supportsFileSystemAccess();
    try {
      const files = await pickFilesOrInput(
        wspFcsRef.current,
        FCS_FILE_ACCEPT,
        "FCS file for FACSChorus gates",
      );
      if (files?.length) {
        await loadFcsForChorus(pending, files);
      } else if (usesNativePicker) {
        setPendingChorusImport(null);
        setImportMsg("FACSChorus import cancelled · no FCS file was opened");
      }
    } catch (cause) {
      setPendingChorusImport(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // addSampleEntries commits the newly loaded sample through React state. Apply the saved Chorus
  // tree only after that exact sample is active, so parsing and channel matching see its data.
  useEffect(() => {
    if (
      !pendingChorusImport?.targetSampleId ||
      pendingChorusImport.targetSampleId !== activeSampleId ||
      !sample
    ) return;
    const pending = pendingChorusImport;
    setPendingChorusImport(null);
    // The user chose this file for the tree. Whether it is the tree the file was recorded under is said.
    const why = chorusCrossReason(pending.experiment, pending.treeIndex);
    void importChorusTree(pending.experiment, pending.treeIndex, why ? { file: fileName, why } : null);
    // importChorusTree is a declaration whose inputs are captured above; re-running this effect
    // after unrelated renders would apply the same tree twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSampleId, pendingChorusImport, sample]);

  /**
   * Import the tree each chosen file was recorded under, from the file itself. Files carrying
   * identical gates share one hierarchy; every hierarchy is assigned to its files, so a sorted
   * sample is gated under the gates it was sorted under without a picker or a clock. The active
   * file's tree takes the active hierarchy while that is still empty; an existing strategy is
   * left alone and every tree gets a new hierarchy.
   */
  function importChorusRecordings(fileIds: readonly string[]) {
    setChorusPicker(null);
    try {
      const chosen = loadedChorusRecordings.filter((r) => fileIds.includes(r.fileId));
      if (!chosen.length) throw new Error("None of the chosen files carries a FACSChorus recording.");
      const existing = state.root_population_id !== null && hasGatingStrategy({
        gates: state.gates, populations: state.populations, root_population_id: state.root_population_id,
      });
      // Every recording's tree, converted against its own file. The experiment's current gates,
      // when a .cef is open, let the comparison later name a gate that moved since.
      const currentGates = chorusPicker?.experiment?.panels[0]?.gates ?? null;
      const treeLabels = chorusPicker?.experiment
        ? listChorusTrees(chorusPicker.experiment).map((t) => ({ label: t.kind === "sort" ? t.label.replace(/ · .*$/, "") : t.label, sig: t.kind === "current"
            ? treeSignature(chorusPicker.experiment!.panels[0].gates)
            : treeSignature(chorusPicker.experiment!.sorts.find((so) => so.startedAt === t.sortedAt && t.label.startsWith(so.name))?.gates ?? []) }))
        : [];
      const warnings: string[] = [];
      const files: TailoredFile[] = [];
      let record: ChorusImportRecord | null = null;
      for (const r of chosen) {
        const entry = samples.find((e) => e.id === r.fileId);
        if (!entry) continue;
        const conv = chorusRecordingToGatingML(r.recording, { currentGates, keywords: entry.sample.fcs.keywords });
        for (const w of conv.warnings) if (!warnings.includes(w)) warnings.push(w);
        const pnn: Record<string, string> = {};
        for (const c of entry.sample.channels) pnn[c.pnn] = c.key;
        const res = importGatingML(conv.gatingMl, entry.sample.channels.map((c) => c.key), pnn, entry.sample.instrument,
          gatingMLImportOptionsFor(entry.sample));
        for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(w);
        const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, entry.sample.instrument === "flow",
          entry.sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(entry.sample.fcs) });
        if (comp.target !== null && entry.sample.compensationEnabled !== comp.target) entry.sample.setCompensation(comp.target);
        // Named after the sort whose snapshot the tree is, when a .cef says so, else the recording.
        const sig = treeSignature(r.recording.panel.gates);
        const origin = treeLabels.find((tl) => tl.sig === sig)?.label ?? null;
        files.push({ fileId: r.fileId, fileName: r.fileName, tree: res, origin });
        if (r.fileId === activeSampleId || !record) record = conv.record;
      }
      if (!files.length) throw new Error("None of the chosen files is loaded.");
      // One tree for the workspace: the viewed file's recording, or the largest group of files
      // recorded alike, and every other file tailored on the gates it shares with it. A file
      // whose recording differs in structure is reported: what was dropped, what follows.
      const templateId = templateOf(state.active_hierarchy_id, state.hierarchies)?.id ?? state.active_hierarchy_id;
      const plan = planOneTreeImport(files, {
        templateId, name: (lead) => lead.origin ?? lead.fileName.replace(/\.fcs$/i, ""), leadFileId: activeSampleId, existing: state.hierarchies,
      });
      const name = plan.template.name;
      if (templateId !== state.active_hierarchy_id) dispatch({ type: "switchHierarchy", id: templateId, silent: true });
      dispatch({
        type: "importGating",
        gates: plan.template.tree.gates, gate_order: plan.template.tree.gate_order,
        populations: plan.template.tree.populations, root_population_id: plan.template.tree.root_population_id,
        mode: "replace",
      });
      dispatch({ type: "renameHierarchy", id: templateId, name });
      if (plan.copies.length) dispatch({ type: "addHierarchyCopies", copies: plan.copies, activeHierarchyId: templateId, assignments: plan.assignments });
      else dispatch({ type: "assignFileHierarchies", assignments: plan.assignments });
      const n = files.length;
      setImportMsg(
        `Imported one tree, "${name}", from ${plan.lead.fileName} for ${n} file${n === 1 ? "" : "s"}: ` +
          `${plan.following} ${plan.following === 1 ? "follows" : "follow"} it as recorded, ${plan.copies.length} tailored.` +
          (plan.differing.length
            ? ` ${plan.differing.length} file${plan.differing.length === 1 ? "" : "s"} recorded a different tree: ${describeDiffering(plan.differing)}.`
            : "") +
          (existing ? " The previous gating is replaced; Undo brings it back." : ""),
      );
      setChorusImport(record);
      setError(warnings.length ? warnings.join("\n") : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * A FACSChorus statistics export (`<experiment>_Statistics.csv`): Chorus's own population
   * counts per recording, under the gates current when it was exported. Opened beside GateLab's
   * counts on the loaded file of each recording's name; the comparison itself is computed when
   * the dialog renders, from whatever the trees are then.
   */
  async function openChorusStatistics(file: File) {
    try {
      const text = await file.text();
      setChorusStats(parseChorusStatistics(text));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * The gating state of the tree a file follows: the live tree when the file is on it, else the
   * stored copy (a group's, or the file's own tailoring). Null when that copy is missing.
   */
  function treeStateForFile(fileId: string): { treeState: CoreState; live: boolean } | null {
    const hid = hierarchyOfFile(fileId);
    const live = hid === state.active_hierarchy_id;
    const stored = live ? null : state.stored_hierarchies[hid];
    if (!live && !stored) return null;
    const treeState: CoreState = live ? state : {
      ...state,
      gates: stored!.gates, gate_order: stored!.gate_order, populations: stored!.populations,
      root_population_id: stored!.root_population_id, active_population_id: stored!.active_population_id,
      selected_pop_ids: stored!.selected_pop_ids,
    };
    return { treeState, live };
  }

  /**
   * The id a live-tree population has in the tree a file follows: itself on the live tree; on a
   * stored copy, the population its provenance links to, or null when the copy has none.
   */
  function populationIdInFileTree(fileId: string, popId: string): string | null {
    const hid = hierarchyOfFile(fileId);
    if (hid === state.active_hierarchy_id) return popId;
    const copy = state.stored_hierarchies[hid];
    const active = state.hierarchies.find((h) => h.id === state.active_hierarchy_id);
    if (!copy || !active) return null;
    const live = storeHierarchy(active, state);
    return correspondingHierarchyId(live, popId, copy, { ...state.stored_hierarchies, [live.id]: live }, "population");
  }

  /** Every loaded file with GateLab's counts under the hierarchy it is gated under. */
  function chorusFileCounts(): FileCounts[] {
    const out: FileCounts[] = [];
    for (const entry of samples) {
      const tree = treeStateForFile(entry.id);
      if (!tree) continue;
      const { treeState, live } = tree;
      const d = live && entry.id === activeSampleId ? derived : recompute(entry.sample, treeState);
      const rootId = treeState.root_population_id;
      const populations = rootId
        ? populationTreeOrder(d.populations, rootId).filter(({ popId }) => popId !== rootId).map(({ popId, depth }) => {
            const pop = d.populations[popId];
            const parent = pop.parent_id && pop.parent_id !== rootId ? d.populations[pop.parent_id] : null;
            return { name: pop.name, depth, parentName: parent?.name ?? null, events: pop.event_count ?? 0, percentParent: pop.percent_of_parent };
          })
        : [];
      out.push({
        entryId: entry.id,
        fileName: entry.name,
        hierarchyName: state.hierarchies.find((h) => h.id === hierarchyOfFile(entry.id))?.name ?? "",
        events: entry.sample.fcs.nEvents,
        populations,
      });
    }
    return out;
  }
  fileCountsRef.current = chorusFileCounts;

  /**
   * One tree of a FACSDiva experiment, rewritten as Gating-ML and taken through the ordinary path.
   * `crossTo` is set when the user chose to import it onto a file that is not its tube, and the
   * result says so.
   */
  async function importDivaTree(
    text: string,
    tree: DivaGateTreeSummary,
    tubeHint: number | null,
    extraNotes: readonly string[],
    crossTo: string | null,
  ) {
    try {
      const conv = divaToGatingML(text, tree.index, tubeHint);
      // Every other loaded file gets its own tube's tree, as a FlowJo workspace's files get their
      // own sample's: they used to follow the chosen tube's tree under "applied to all N files",
      // unpaired and unnamed, although the experiment held a tube for each. A tube's tree only: a
      // global worksheet belongs to no tube, and every file follows it as it is.
      const siblings: { name: string; gatingMl: string; fileName: string; entryId: string; spillover?: FlowJoSpillover | null; sampleLabel: string; warnings?: readonly string[]; unreadable?: string }[] = [];
      const unpaired: { name: string; entryId: string; why: string }[] = [];
      const others = samples.filter((entry) => entry.id !== activeSampleId);
      if (others.length && tree.kind === "tube") {
        const trees = listDivaGateTrees(text).filter((t0) => t0.gateCount > 0);
        const tubes = listDivaTubes(text);
        const label = (t0: DivaTubeSummary) => `tube "${t0.name}"${t0.dataFilename ? ` (${t0.dataFilename})` : ""}`;
        for (const entry of others) {
          const { pairing } = pairDivaTube(tubes, { name: entry.name, keywords: entry.sample.fcs.keywords });
          if (pairing.kind !== "own") {
            unpaired.push({
              name: entry.name, entryId: entry.id,
              why: pairing.kind === "contradicted"
                ? pairing.candidates.map((c) => describeContradiction(label(c.sample), c.comparison.differ, "the file")).join("; ")
                : pairing.kind === "ambiguous"
                  ? `${pairing.candidates.length} tubes could be it, and their recorded times cannot tell which`
                  : "no tube of this experiment is named like it or records its acquisition times",
            });
            continue;
          }
          const ownTree = trees.find((t0) => t0.tubeIndex === pairing.sample.index);
          if (!ownTree) {
            unpaired.push({ name: entry.name, entryId: entry.id, why: `it is ${label(pairing.sample)}, which carries no gates` });
            continue;
          }
          try {
            const own = divaToGatingML(text, ownTree.index, pairing.sample.index);
            siblings.push({
              name: entry.name, gatingMl: own.gatingMl, fileName: entry.name, entryId: entry.id, spillover: own.spillover,
              sampleLabel: label(pairing.sample), ...(own.warnings.length ? { warnings: own.warnings } : {}),
            });
          } catch (e) {
            siblings.push({ name: entry.name, gatingMl: "", fileName: entry.name, entryId: entry.id, sampleLabel: label(pairing.sample), unreadable: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      const perFile = siblings.length > 0;
      const ownNotes = [...extraNotes, ...conv.warnings];
      // Under a per-file import each file's notes are shown under its name, the viewed file's first.
      const notes = perFile && ownNotes.length ? [`${calledLoaded(fileName, activeSampleId)}: ${ownNotes.join(" ")}`] : ownNotes;
      const noteCount = ownNotes.length + siblings.reduce((n, s0) => n + (s0.warnings?.length ?? 0) + (s0.unreadable !== undefined ? 1 : 0), 0);
      // The notes travel with the import and are shown beside its result: set as the error
      // here, they were cleared again as soon as the import was staged.
      await prepareGatingImportFromGatingML(
        conv.gatingMl,
        ` from FACSDiva experiment · ${conv.label}` +
          (perFile ? " · one tree per file, each its own tube's" : "") +
          (crossTo ? ` · ${tree.kind === "tube" ? "tube" : "worksheet"} "${tree.label}" applied to ${crossTo} by choice` : "") +
          // Files with no tube tree of their own follow the tree; they are named, with why.
          (unpaired.length
            ? ` · following the tree without a tree of their own: ${unpaired.map((u) => `${u.name} (${u.why})`).join("; ")}`
            : "") +
          // Every note shown is counted: the pairing note too, not only the converter's.
          (noteCount ? ` · ${noteCount} note(s)` : ""),
        conv.spillover,
        siblings,
        perFile ? fileName : null,
        null, [], null,
        notes,
        perFile ? activeSampleId : null,
        unpaired,
        [],
        perFile && tubeHint !== null ? { primarySampleLabel: `tube "${tree.label}"` } : {},
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function prepareGatingImport(file: File) {
    if (!sample || !activeSampleId) return;
    // Every open sample, by name, events and $FIL, before `samples` below names the workspace's.
    const openSamples = samples.map((s0) => ({
      name: s0.name, events: s0.sample.fcs.nEvents, fil: s0.sample.fcs.keywords["$FIL"] ?? null,
    }));
    try {
      // A FACSChorus experiment file is a zip rather than text. It holds the gates as they are
      // now and a snapshot of them at the start of every sort — the gating a sorted sample was
      // sorted under — so the user chooses which, unless there is only one.
      if (isChorusExperimentFile(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const experiment = readChorusExperiment(bytes);
        const trees = listChorusTrees(experiment).filter((t) => t.gateCount > 0);
        if (!trees.length) throw new Error("This FACSChorus experiment contains no gates GateLab can read.");
        setChorusSource({ name: file.name, bytes });
        // The timeline, which also offers each loaded recording's own tree. The .cef holds no
        // recordings, so nothing in it says the loaded file is its data: applying its one tree
        // straight away put one experiment's gates on any file that happened to be viewed. The
        // timeline names the file and whether it is a recording of this experiment, and applies
        // nothing until a tree is chosen.
        setChorusPicker({ experiment, trees });
        return;
      }

      const text = await file.text();

      // A BD FACSDiva experiment export is rewritten into Gating-ML the same way a FlowJo
      // workspace is, so the ordinary import path handles both. Diva is the record BEFORE
      // FlowJo: raw-linear scatter vertices, explicit hierarchy, per-gate event counts, and the
      // compensation actually applied (including hand adjustments that exist nowhere else).
      if (isDivaWorkspace(text)) {
        const trees = listDivaGateTrees(text).filter((t) => t.gateCount > 0);
        if (!trees.length) throw new Error("This Diva experiment contains no gates GateLab can read.");
        // Which tube IS the loaded file: named like it and recording its acquisition times, or,
        // for a renamed file, the one tube whose times are its own. Diva names its files
        // Specimen_001_Tube_001.fcs in every experiment, so the name alone imported another
        // experiment's tube tree without a check.
        const tubes = listDivaTubes(text);
        const { pairing, byTimes } = pairDivaTube(tubes, { name: fileName, keywords: sample.fcs.keywords });
        const own = pairing.kind === "own" ? pairing.sample : null;
        const ownTree = own ? trees.find((t) => t.tubeIndex === own.index) : undefined;
        const tubeTrees = trees.filter((t) => t.kind === "tube");
        const worksheets = trees.filter((t) => t.kind === "worksheet");
        const label = (t: DivaTubeSummary) => `tube "${t.name}"${t.dataFilename ? ` (${t.dataFilename})` : ""}`;
        const why = pairing.kind === "contradicted"
          ? `no tube of this experiment is "${fileName}": ` +
            pairing.candidates.map((c) => describeContradiction(label(c.sample), c.comparison.differ)).join("; ")
          : pairing.kind === "ambiguous"
            ? `${pairing.candidates.length} tubes of this experiment could be "${fileName}", and their recorded times cannot tell which`
            : pairing.kind === "none"
              ? `no tube of this experiment is named "${fileName}" or records its acquisition times`
              : null;
        const found = own && byTimes
          ? `"${fileName}" is ${label(own)}: its acquisition times are the tube's.`
          : null;
        // The file's own tube's tree; or the one global worksheet, which belongs to no tube and
        // applies to any. Anything else is a choice: taking the largest tree, as this used to
        // with only a note, imported another tube's gates without asking.
        const pick = ownTree ?? (tubeTrees.length === 0 && worksheets.length === 1 ? worksheets[0] : undefined);
        if (!pick) {
          setDivaPicker({
            text, trees, tubes, fileName, keywords: sample.fcs.keywords, tubeHint: own?.index ?? null,
            reason: (why ? `${why[0].toUpperCase()}${why.slice(1)}. ` : found ? `${found} ` : "") +
              (own && !ownTree
                ? `The experiment holds ${trees.length} gate trees and none is that tube's. Choose the one to import onto "${fileName}".`
                : `Choose the tree to import onto "${fileName}", or cancel.`),
          });
          return;
        }
        await importDivaTree(text, pick, own?.index ?? null,
          [...(found ? [found] : []), ...(why && pick.kind === "worksheet" ? [`The worksheet's gates apply to any tube, but ${why}.`] : [])],
          null);
        return;
      }

      // A FlowJo workspace is rewritten into Gating-ML and then takes the ordinary path, so
      // channel resolution, validation, population building and merge/replace are unchanged.
      // FlowJo's own Gating-ML export omits gating:name, so importing a workspace is the only
      // way to get a NAMED hierarchy out of FlowJo without a separate recovery step.
      if (!isFlowJoWorkspace(text)) {
        // A Cytobank file can carry gates tailored per FCS file. Each goes onto the loaded file it
        // was tailored for, and none into the tree: they used to be imported as extra gates of the
        // same name onto whatever file was loaded. Cytobank records a file by name alone, so a
        // name two loaded files share is applied to neither.
        const tailored = cytobankTailoredFiles(text);
        if (!tailored.length) {
          await prepareGatingImportFromGatingML(text, "");
          return;
        }
        const notes: string[] = [];
        const pairs: { fileName: string; entryId: string; gatingMl: string }[] = [];
        const ambiguous: { fileName: string; gates: number; entryIds: string[] }[] = [];
        for (const f of tailored) {
          const hits = samples.filter((e) => sameFileName(e.name, f.fileName));
          if (hits.length === 1) {
            pairs.push({ fileName: f.fileName, entryId: hits[0].id, gatingMl: cytobankDocumentForFile(text, f.fileName) });
          } else if (hits.length > 1) {
            ambiguous.push({ fileName: f.fileName, gates: f.gates, entryIds: hits.map((e) => e.id) });
          } else {
            notes.push(`Cytobank tailored ${f.gates} gate(s) for "${f.fileName}", which is not loaded; they were not imported.`);
          }
        }
        // Several loaded files carry a name Cytobank tailored gates for: the user says which it is.
        if (ambiguous.length) {
          setCytobankAsk({ text, pairs, notes, ambiguous, answers: Object.fromEntries(ambiguous.map((a) => [a.fileName, null])) });
          return;
        }
        await prepareGatingImportFromGatingML(cytobankDocumentForFile(text, null), "", null, [], null, null, [], null, notes, null, [], pairs);
        return;
      }

      const wsSamples = listFlowJoWorkspaceSamples(text, t);
      const usable = wsSamples.filter((s) => s.gateCount > 0);
      if (!usable.length) throw new Error("This workspace contains no gates GateLab can read.");

      // Which sample IS the loaded file. Names nominate -- the path FlowJo read, the node name,
      // $FIL, and the file's own $FIL -- and the identity keywords FlowJo recorded for each sample
      // decide. Every sample is considered, gated or not: a file whose own sample carries no gates
      // is not given a same-named gated sample's tree.
      const fil = sample.fcs.keywords["$FIL"] ?? null;
      // One data set of a multi-data-set file is told apart from the file's other data sets by its
      // well label, else its event count (matchFlowJoSamples), against the other samples open.
      const { matchedOn, pairing, tiedWith, tiedOn, tiedUngated, tiedUnopened } = matchFlowJoSamples(wsSamples, {
        fileName, fil, keywords: sample.fcs.keywords, events: sample.fcs.nEvents, open: openSamples,
      });
      const label = (x: FlowJoSampleSummary) => `sample ${x.index + 1} "${x.name}"`;

      // The file's own sample, with gates: one click, as before.
      if (pairing.kind === "own" && pairing.sample.gateCount > 0) {
        const only = pairing.sample;
        // Found by the $FIL the file carries after the sample of its own name recorded another
        // acquisition: a renamed or swapped file. Said, so the import does not look like the
        // wrong sample's.
        // A same-named sample that records nothing confirming the file gave way to the sample the
        // file's $FIL names and its keywords confirm; said too, for the same reason.
        const passedOver = pairing.passedOver ?? [];
        const pairingNote = matchedOn === "fil" && (pairing.rejected.length || passedOver.length)
          ? [
              ...(pairing.rejected.length
                ? [`${pairing.rejected.map((r) => label(r.sample)).join(" and ")}, named like the file, ` +
                    `${pairing.rejected.length === 1 ? "records" : "record"} another acquisition`]
                : []),
              ...(passedOver.length
                ? [`${passedOver.map((r) => label(r.sample)).join(" and ")}, named like the file, ` +
                    `${passedOver.length === 1 ? "records" : "record"} nothing that confirms it is the file`]
                : []),
            ].join("; ") + `; the file's $FIL and keywords are ${label(only)}'s`
          : null;
        await importOntoLoadedFiles(text, wsSamples, only, matchedOn, null, pairingNote);
        return;
      }
      // Anything else is a choice, never a guess, and every row says whose tree goes onto which
      // file. Taking a same-named sample whose record contradicts the file imported another
      // acquisition's gates without a word; taking the first of several imported another sample's.
      let offered = usable;
      let reason: string;
      /** The samples the file could be, where the keywords cannot tell: choosing one is not a cross. */
      let couldBe: number[] = [];
      if (pairing.kind === "own") {
        reason = `"${fileName}" is ${label(pairing.sample)} of this workspace, which carries no gates. ` +
          "Choose another sample only if its tree should be applied to this file.";
      } else if (pairing.kind === "contradicted") {
        reason = `No sample in this workspace is "${fileName}": ` +
          pairing.candidates.map((c) => describeContradiction(label(c.sample), c.comparison.differ)).join("; ") +
          ". Its gates were not imported. Choose a sample only if its tree should be applied to this file anyway.";
      } else if (pairing.kind === "ambiguous") {
        const gated = pairing.candidates.map((c) => c.sample).filter((x) => x.gateCount > 0);
        if (gated.length) offered = gated;
        couldBe = pairing.candidates.map((c) => c.sample.index);
        const dataSet = parseFcsDataSetFileName(fileName);
        const others = (n: number) => (n === 1 ? "a sample" : `${n} samples`);
        const n = pairing.candidates.length;
        reason = dataSet && tiedOn
          // One data set of a multi-data-set file, which the workspace records under the file:
          // matched on an event count or a $FIL another sample or data set shares, nothing says
          // which it is.
          ? `${n === 1 ? "1 sample" : `${n} samples`} in this workspace could be ${fileName}: ` +
            (tiedOn === "count"
              ? `recorded under ${dataSet.fileName} with its ${sample.fcs.nEvents.toLocaleString("en-US")} events` +
                (tiedWith?.length ? `, as ${tiedWith.join(" and ")} ${tiedWith.length === 1 ? "has" : "have"}` : "")
              : `recorded under its $FIL "${fil}"` +
                (tiedWith?.length ? `, which ${tiedWith.join(" and ")} ${tiedWith.length === 1 ? "carries" : "carry"} too` : "")) +
            (tiedUngated ? `; ${others(tiedUngated)} without gates could be it too` : "") +
            (tiedUnopened
              ? `; ${tiedUnopened === 1 ? "another data set" : `${tiedUnopened} other data sets`} of ${dataSet.fileName}, ` +
                "not open, could be it too"
              : "") +
            ", and no $WELLID or $SMNO says which. Choose which one to import."
          : `${n} samples in this workspace could be "${fileName}", and the keywords they ` +
            "record cannot tell which it is. Choose the one it is.";
      } else {
        reason = `No sample in this workspace matches the loaded file "${fileName}"` +
          `${fil ? ` or its $FIL keyword "${fil}"` : ""}. Choose a sample only if its tree should be applied to this file.`;
      }
      setWspPicker({ text, samples: offered, reason, fileName, keywords: sample.fcs.keywords, wsSamples, couldBe });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // A workspace's strategy can only be imported onto the file the open paired it with, and
  // loading that file is asynchronous, so the strategy waits here until it is the active one. The
  // file is the one the dialog decided on, by id: re-deriving it from names put the strategy on
  // the first loaded file of that name, which with two of one name was another experiment's.
  useEffect(() => {
    const p = pendingFlowJoStrategy;
    if (!p || !sample || !activeSampleId) return;
    const where = resolveFlowJoTarget(p.target, activeSampleId, samples);

    if (where.kind === "apply") {
      setPendingFlowJoStrategy(null);
      if (p.ask) {
        // Nothing said which data set the strategy's sample was drawn on: the data set it could be
        // is now viewed, and the user says which sample it is.
        setWspPicker({
          text: p.text,
          samples: p.ask.samples,
          reason: p.ask.reason,
          fileName,
          keywords: sample.fcs.keywords,
          wsSamples: p.ask.wsSamples,
          couldBe: p.ask.samples.map((x) => x.index),
          fromOpen: {
            strategyIndex: p.choice.index, treeIndex: p.treeIndex,
            matrixChoice: p.matrixChoice ?? null, openedSampleIds: p.openedSampleIds ?? [],
            flowJoGrid: p.flowJoGrid,
          },
        });
        return;
      }
      void importFlowJoSample(p.text, p.choice, null, p.treeIndex, p.perFile ?? [], p.matrixChoice ?? null, p.openedSampleIds ?? [], [],
        { crossTo: p.crossTo ?? null, unpaired: p.unpaired ?? [], byChoice: p.byChoice ?? [], loadNotes: p.loadNotes ?? [], flowJoGrid: p.flowJoGrid, flowJoGridInDialog: p.flowJoGridInDialog,
          ...(p.triedPrimaries ? { triedPrimaries: p.triedPrimaries } : {}),
          ...(p.pairingNote ? { pairingNote: p.pairingNote } : {}),
          ...(p.mergedTreesAdvice ? { mergedTreesAdvice: p.mergedTreesAdvice } : {}) });
      return;
    }
    if (where.kind === "switch") {
      // Loaded, but not the ACTIVE sample. Activate it and let this effect run again.
      setSampleIncluded(where.id, true);
      selectSample(where.id);
      return;
    }
    // Nothing loaded carries a name this workspace knows. The strategy is still held — the user
    // may yet load the right file — but the wait is now visible instead of looking like the gates
    // were simply forgotten.
    setImportMsg(
      `Waiting for the FCS this workspace gates: ${where.wanted.slice(0, 3).join(", ")}` +
        (where.wanted.length > 3 ? `, and ${where.wanted.length - 3} more` : "") +
        ". It is not among the loaded files.",
    );
    // importFlowJoSample is recreated every render; depending on it would re-run this endlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFlowJoStrategy, sample, activeSampleId, fileName, samples]);

  /**
   * Hold FCS for the open dialog, once each: a file already in the workspace is not loaded a
   * second time (the dialog counts it as found), and a file already held is not held twice.
   * Loading a file twice pooled a duplicate of it into the first hierarchy.
   */
  async function holdFlowJoFiles(files: readonly { name: string; file: File; path?: string }[]) {
    // Each file's TEXT keywords are read first: they are what pairs it with its sample, and what
    // tells a same-named file of another acquisition from one already loaded.
    const read = await Promise.all(files.map(async (f) => ({ ...f, keywords: await readFcsFileKeywords(f.file) })));
    const loaded = samples.map((s0) => ({ name: s0.name, keywords: s0.sample.fcs.keywords }));
    setFlowJoOpen((cur) => {
      if (!cur) return cur;
      const skipped: SkippedFile<(typeof read)[number]>[] = [];
      const held = filesToHold(cur.pending, loaded, read, skipped);
      return { ...cur, pending: [...cur.pending, ...held], notHeld: [...(cur.notHeld ?? []), ...notHeldOf(skipped)] };
    });
  }

  /**
   * Gather FCS for an open workspace, starting in the folder the .wsp came from.
   *
   * A plain <input type="file"> cannot be told where to open -- the browser decides, and it
   * remembers wherever it was last, which for a workspace import is almost never the right place.
   * The File System Access picker takes `startIn`, and the workspace's own handle is exactly the
   * hint needed, since its FCS normally sit beside it. Falls back to the input where that API is
   * unavailable, which loses only the starting folder.
   */
  /**
   * Resolve a workspace's FCS from the folder it sits in, in one action.
   *
   * A .wsp names its files but the File System Access API hands back only the file the user
   * picked -- there is no route from a file handle to its parent -- so GateLab cannot look
   * beside the workspace on its own, however obvious that looks in Finder. Asking for the
   * FOLDER is the one gesture that grants it, and from there every sample the workspace names
   * can be matched without the user picking files one by one.
   *
   * Only files the workspace actually asks for are taken, so pointing this at a large folder
   * does not drag its whole contents into the import.
   */
  async function chooseFlowJoFolder(state: NonNullable<typeof flowJoOpen>) {
    if (!supportsDirectoryAccess()) {
      setError("This browser cannot open a folder; choose the FCS files instead.");
      return;
    }
    try {
      const picked = await pickDirectoryFiles(
        [".fcs"],
        state.handle ? { startIn: state.handle } : {},
      );
      if (!picked) return;
      // Every file the workspace names, gated or not, and every file whose $FIL it names: a file
      // renamed on disk is still its sample's, and choosing it by hand already paired it. The
      // folder button is how a workspace is usually opened, and it kept its own gated-only list:
      // the dialog had learned to show a workspace's compensation controls, and this button still
      // dropped them.
      const named = [...state.samples, ...state.dataSamples];
      const matches = await workspaceFilesInFolder(named, picked.files, readFcsFileKeywords);
      if (!matches.length) {
        setError(
          `No FCS in "${picked.name}" matches the ${named.length} file name(s) ` +
          `"${state.fileName}" refers to, by its name or its $FIL.`,
        );
        return;
      }
      await holdFlowJoFiles(matches.map((f) => ({ name: f.name, file: f.file, path: `${picked.name}/${f.relativePath}` })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
        state.handle ? { startIn: state.handle } : {},
      );
      if (!picked?.length) return;
      await holdFlowJoFiles(picked.map((f) => ({ name: f.name, file: f.file })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Load the files gathered for a .wsp, then hand its strategy to the ordinary import path. */
  /**
   * Close the workspace sample picker. Raised by a workspace open, it is that open's question, so
   * cancelling it cancels the open: the files it loaded go too, as cancelling its strategy question
   * does (completeFlowJoOpen), rather than staying as a workspace with its gates left out.
   */
  function cancelWspPicker(): void {
    const opened = wspPicker?.fromOpen?.openedSampleIds ?? [];
    setWspPicker(null);
    if (!opened.length) return;
    void removeSamples(opened).then(() => setImportMsg(
      `Workspace open cancelled; the ${opened.length === 1 ? "file it loaded was" : `${opened.length} files it loaded were`} ` +
      "removed again and the current strategy was not changed.",
    ));
  }

  async function completeFlowJoOpen(state: NonNullable<typeof flowJoOpen>) {
    // The same plan the dialog showed: the sample whose trees it listed, the file that sample IS
    // (or the one the user chose to apply its tree to), and under a per-file import every other
    // file with the sample it is. Nothing here re-derives a pairing from names.
    const first = flowJoOpenPlanOf(state);
    const chosen = first.plan.sample;
    if (!chosen) return;
    const expected = (x: FlowJoSampleSummary) =>
      `Expected one of: ${x.candidateFileNames.join(", ")}` +
      (x.dataSetLabel ? `, the data set of well ${x.dataSetLabel}` : "") + ".";
    // A sample that could be one of several data sets already open, where nothing says which, is
    // imported too: the open then asks which sample the first of them is (below).
    if (!first.plan.target && !first.plan.resolution?.tiedWith?.length) {
      setError(`The strategy belongs to "${chosen.name}", whose FCS was not among the files chosen. ${expected(chosen)}`);
      return;
    }
    setFlowJoOpen(null);
    const gatedIndex = new Set(state.samples.map((x) => x.index));
    const everySample = [...state.samples, ...state.dataSamples].sort((a, b) => a.index - b.index);
    // Every file the dialog paired is known by its key; the loaded ones already have an id, and
    // the chosen ones get theirs as they load. The strategy then goes on that id, not on whichever
    // loaded file carries the name.
    const idOfKey = new Map<string, string>(samples.map((entry) => [`loaded:${entry.id}`, entry.id]));
    // Files already in the workspace are not loaded a second time: the dialog counted them as
    // found, and loading them again pooled a duplicate into the first hierarchy.
    const toLoad = filesToHold([], samples.map((s0) => ({ name: s0.name, keywords: s0.sample.fcs.keywords })), state.pending);
    let openedSampleIds: string[] = [];
    // A file chosen that was not held, as a file already open or chosen, is named with the notes:
    // it was dropped without a word, neither loaded nor named.
    const loadNotes: string[] = (state.notHeld ?? []).map((k) =>
      `${k.path ?? k.name} was not loaded: it has the name of ${k.sameAs}, ${k.open ? "already open" : "also chosen"}, and ` +
      (k.confirmed ? "its keywords say it is the same acquisition" : "nothing says it is another acquisition"));
    let added: SampleEntry[] = [];
    if (toLoad.length) {
      // Each chosen file is bound to the entry it became by the candidate it was loaded as. Bound
      // by name, in order, a file that failed to load handed its sample to the next file of the
      // same name: that file got the failed file's sample's tree, and its own was dropped.
      const candidates = toLoad.map((f) => ({ id: crypto.randomUUID(), name: f.name, file: f.file, handle: null, ...(f.path ? { sourcePath: f.path } : {}) }));
      const became = new Map<string, SampleEntry>();
      const failedToLoad = new Map<string, string>();
      added = await importFcsCandidates(candidates, became, failedToLoad);
      openedSampleIds = added.map((e) => e.id);
      for (const e of added) idOfKey.set(`loaded:${e.id}`, e.id);
      toLoad.forEach((f, i) => {
        const entry = became.get(candidates[i].id);
        if (entry) idOfKey.set(`pending:${state.pending.indexOf(f)}`, entry.id);
        const why = failedToLoad.get(candidates[i].id);
        // Said with the import's notes: the load error was cleared as soon as the import was staged,
        // and a file chosen for the open vanished without a word.
        if (why !== undefined) loadNotes.push(`${f.name} could not be loaded, so no tree was imported onto it: ${why}`);
      });
    }
    const entryOf = (key: string): string | null => idOfKey.get(key) ?? null;
    // A file holding several data sets opened as one sample per data set ("plate (data set 2 of 4,
    // A02).fcs"), and each workspace sample recorded under that file is the data set of its own
    // well, not the file, which no sample is named after. So the pairing is made again against the
    // samples now open, as the dialog made it where they were open already; the answers the dialog
    // took go with it, by the entry each file became. Until 2026-09 the strategy then waited for a
    // "plate.fcs" that would never be loaded.
    const nowOpen = [...samples, ...added];
    const openEvents = new Map(nowOpen.map((e) => [e.name, e.sample.fcs.nEvents] as const));
    const splitOnLoad = added.some((e) => parseFcsDataSetFileName(e.name) !== null);
    let pairing = first.pairing;
    let plan = first.plan;
    let openFiles: readonly FlowJoWorkspaceFile[] = flowJoOpenFiles(state);
    let fileChoices = state.fileChoices;
    if (splitOnLoad) {
      const loadedKey = (key: string) => {
        const id = idOfKey.get(key);
        return id ? `loaded:${id}` : null;
      };
      openFiles = nowOpen.map((entry) => ({
        key: `loaded:${entry.id}`, name: entry.name, keywords: entry.sample.fcs.keywords,
        path: entry.sourcePath ?? null, events: entry.sample.fcs.nEvents,
      }));
      fileChoices = Object.fromEntries(Object.entries(state.fileChoices).flatMap(([key, index]) => {
        const k = loadedKey(key);
        return k ? [[k, index] as const] : [];
      }));
      const crossKey = state.crossFile ? loadedKey(state.crossFile.fileKey) : null;
      pairing = pairFlowJoWorkspaceFiles(everySample, openFiles, fileChoices, { events: openEvents });
      const planFor = (index: number) => plannedFlowJoOpen(
        {
          ...state,
          strategySample: index,
          strategyTouched: true,
          crossFile: state.crossFile && crossKey ? { sampleIndex: state.crossFile.sampleIndex, fileKey: crossKey } : null,
        },
        pairing.resolutions,
        openFiles,
        [],
      );
      plan = planFor(chosen.index);
      // Under one hierarchy per file the lead is any gated sample paired with an FCS, as in the
      // dialog; a lead that could be several data sets gives way to one that is paired.
      if (!plan.target && state.perFileTrees) {
        const paired = state.samples.find((x) => isPaired(pairing.resolutions.find((r) => r.sampleIndex === x.index)));
        if (paired) plan = planFor(paired.index);
      }
    }
    // Files named as the dialog named them: one sharing a name with another says which it is. Named
    // from the files the pairing was made against, the data sets a plate opened as included.
    const called = distinctFileNames(openFiles);
    const calledAs = (key: string, name: string) => called.get(key) ?? name;
    // Files whose samples carry no gates -- compensation controls, typically -- load unchecked.
    // They are there to be used, but pooling them under a strategy drawn on another file would add
    // their events to every population.
    if (added.length) {
      const data = ungatedWorkspaceFiles(state.samples, state.dataSamples, openFiles, fileChoices, { events: openEvents });
      const dataIds = [...data].map((key) => idOfKey.get(key)).filter((id): id is string => !!id && openedSampleIds.includes(id));
      if (dataIds.length) setExcludedSampleIds((prev) => new Set([...prev, ...dataIds]));
    }
    const lead = plan.sample ?? chosen;
    const leadResolution = pairing.resolutions.find((r) => r.sampleIndex === lead.index);
    if (!plan.target && leadResolution?.tiedWith?.length) {
      // Nothing says which data set the strategy's sample was drawn on. Rather than import nothing,
      // or take one of them on a guess, view the first it could be and ask which sample that data
      // set is, with the sample picker Import gating uses.
      const firstTied = leadResolution.tiedWith[0];
      const candidates = state.samples.filter((x) =>
        pairing.resolutions.find((r) => r.sampleIndex === x.index)?.tiedWith?.includes(firstTied));
      const could = leadResolution.tiedWith.length === 1
        ? `${firstTied}, which holds`
        : `${leadResolution.tiedWith.slice(0, -1).join(", ")} or ${leadResolution.tiedWith[leadResolution.tiedWith.length - 1]}, each holding`;
      const firstFile = openFiles.find((f) => f.name === firstTied);
      setPendingFlowJoStrategy({
        text: state.text,
        choice: lead,
        treeIndex: openTreeIndex(lead, state.strategyTree, false),
        target: { entryId: firstFile ? entryOf(firstFile.key) : null, names: [firstTied] },
        ...(loadNotes.length ? { loadNotes } : {}),
        ...(wspMatrixCompared ? { matrixChoice: state.matrixChoice } : {}),
        openedSampleIds,
        flowJoGrid: state.flowJoGrid,
        ask: {
          samples: candidates.length ? candidates : [lead],
          wsSamples: everySample,
          reason:
            `Nothing says which data set "${lead.name}", the strategy's sample, was drawn on: it could be ${could} ` +
            `${(openEvents.get(firstTied) ?? 0).toLocaleString("en-US")} events, a count another data set or ` +
            `sample of ${state.fileName} shares or may share, and no $WELLID or $SMNO says which. ` +
            `Choose which sample ${firstTied} is; its gates are imported as the tree every file follows.`,
        },
      });
      return;
    }
    if (!plan.target) {
      setError(`The strategy belongs to "${lead.name}", and no FCS opened matches it. ${expected(lead)}`);
      return;
    }
    const target = plan.target;
    const skipped = pairing.resolutions.filter((r) => gatedIndex.has(r.sampleIndex) && !isPaired(r));
    const missing = skipped.filter((r) => !r.tiedWith?.length);
    // Data sets only a shared event count could pair with a gated sample: named, and they follow the
    // tree as drawn.
    const tied = tiedDataSetsNote(skipped, openEvents);
    if (missing.length || tied) {
      setImportMsg([
        missing.length
          ? `${missing.length} of ${state.samples.length} sample(s) in ${state.fileName} had no matching FCS and were skipped.`
          : "",
        tied ?? "",
      ].filter(Boolean).join(" "));
    }
    // Files no sample is: named in the result, with why, and they follow the tree. That includes
    // a file loaded before this open and named like no sample: it was left out as none of this
    // workspace's business, and still followed the imported tree -- another sample's geometry --
    // with the result counting the files around it.
    const label = (index: number) => {
      const x = everySample.find((y) => y.index === index);
      return x ? `sample ${index + 1} "${x.name}"` : `sample ${index + 1}`;
    };
    const unpaired = pairing.unpaired
      .filter((u) => u.fileKey !== target.fileKey && !plan.pairs.some((p0) => p0.fileKey === u.fileKey))
      .map((u) => ({ name: calledAs(u.fileKey, u.fileName), entryId: entryOf(u.fileKey), why: describeUnpaired(u, label, calledAs) }));
    // A file whose own sample carries no gates -- a compensation control the folder brought in --
    // follows the tree too. It was neither counted nor named ("for 3 files" with 4 following), as
    // the import onto a loaded file names it.
    const ungatedIndex = new Set(state.dataSamples.map((x) => x.index));
    for (const r of pairing.resolutions) {
      if (!isPaired(r) || !ungatedIndex.has(r.sampleIndex)) continue;
      for (const f of [{ fileKey: r.fileKey, fileName: r.fileName }, ...(r.copies ?? [])]) {
        if (f.fileKey === target.fileKey || plan.pairs.some((p0) => p0.fileKey === f.fileKey)) continue;
        unpaired.push({ name: calledAs(f.fileKey, f.fileName), entryId: entryOf(f.fileKey), why: `it is ${label(r.sampleIndex)}, which carries no gates` });
      }
    }
    // With "One hierarchy per file" cleared, a file that IS another gated sample follows the
    // chosen sample's tree. The user chose a shared tree, but the result used to say only
    // "applied to all 2 files"; each such file is now named with the sample it is.
    const byChoice = plan.perFile ? [] : pairing.resolutions
      .filter((r) => isPaired(r) && gatedIndex.has(r.sampleIndex) && r.sampleIndex !== lead.index)
      .flatMap((r) => [{ fileKey: r.fileKey!, fileName: r.fileName! }, ...(r.copies ?? [])]
        .filter((f) => f.fileKey !== target.fileKey && entryOf(f.fileKey) !== null)
        .map((f) => ({ name: calledAs(f.fileKey, f.fileName), sample: label(r.sampleIndex) })));
    // Under a per-file import, a file that could not be loaded takes no tree, and when it was the
    // primary's, the next file that did load is the primary: its sample's tree is the one it IS.
    let primary: { sample: FlowJoSampleSummary; fileKey: string; fileName: string; cross: boolean } =
      { sample: lead, fileKey: target.fileKey, fileName: target.fileName, cross: target.cross };
    let pairs = plan.perFile ? plan.pairs.filter((p0) => entryOf(p0.fileKey) !== null) : [];
    if (plan.perFile && entryOf(target.fileKey) === null && pairs.length) {
      primary = { ...pairs[0], cross: false };
    }
    if (pairs.length < 2) pairs = [];
    // Set once the files are in, so the record can name what this open loaded: cancelling the
    // strategy question then undoes the open rather than leaving the files without their gates.
    setPendingFlowJoStrategy({
      text: state.text,
      choice: primary.sample,
      treeIndex: primary.sample === lead ? plan.treeIndex : openTreeIndex(primary.sample, state.strategyTree, pairs.length > 0),
      target: { entryId: entryOf(primary.fileKey), names: [primary.fileName] },
      ...(pairs.length
        ? { perFile: pairs.map((p0) => ({ sample: p0.sample, fileName: p0.fileName, entryId: entryOf(p0.fileKey) })) }
        : {}),
      crossTo: primary.cross ? primary.fileName : null,
      unpaired,
      ...(byChoice.length ? { byChoice } : {}),
      ...(loadNotes.length ? { loadNotes } : {}),
      // The dialog's answer stands only where it compared the matrices; otherwise the import asks.
      ...(wspMatrixCompared ? { matrixChoice: state.matrixChoice } : {}),
      openedSampleIds,
      flowJoGrid: state.flowJoGrid,
    });
  }

  /**
   * A .wsp imported onto the viewed file: `choice`'s tree onto it, and every OTHER loaded file
   * that is a gated sample of this workspace gets its own sample's tree, one tree tailored per
   * file, as the open dialog does. They used to follow the viewed file's sample's tree under
   * "All N files" without a word, although the workspace held a confirmed sample for each.
   * Loaded files with no tree of their own follow the tree and are named, with why.
   * `crossTo` is set when `choice` is not the viewed file's sample and the user chose it.
   */
  async function importOntoLoadedFiles(
    text: string,
    wsSamples: readonly FlowJoSampleSummary[],
    choice: FlowJoSampleSummary,
    matchedOn: FlowJoSampleMatchKey | null,
    crossTo: string | null,
    pairingNote: string | null,
    /**
     * Which loaded file the user said each sample several could be is (file id -> sample), once
     * asked; null until then, when such a sample is asked about before anything is imported.
     */
    fileChoices: Readonly<Record<string, number>> | null = null,
  ) {
    const others = samples.filter((entry) => entry.id !== activeSampleId);
    const viewed = samples.find((entry) => entry.id === activeSampleId);
    const ordered = [...wsSamples].sort((a, b) => a.index - b.index);
    const label = (index: number) => {
      const x = ordered.find((y) => y.index === index);
      return x ? `sample ${index + 1} "${x.name}"` : `sample ${index + 1}`;
    };
    const perFile: { sample: FlowJoSampleSummary; fileName: string; entryId: string }[] = [];
    /**
     * Other loaded files that are the viewed file's own sample too: a copy of it. Under a per-file
     * import each gets that sample's tree as its own; it followed the tree uncounted ("for 2 files"
     * with 3 loaded) and uncompensated. Alone, they make nothing per file: the tree is theirs.
     */
    const ownCopies: { sample: FlowJoSampleSummary; fileName: string; entryId: string }[] = [];
    const unpaired: { name: string; entryId: string | null; why: string }[] = [];
    if (others.length) {
      // The viewed file is paired too, as the chosen sample's file, unless its tree goes onto it by
      // choice: another loaded file is then that sample's only as a confirmed copy of the viewed
      // file. Any other file named like it was taken for a copy without its keywords being
      // compared, and got the sample's tree as its own though it may be another acquisition.
      const asViewed = !crossTo && viewed
        ? [{ key: viewed.id, name: viewed.name, keywords: viewed.sample.fcs.keywords }]
        : [];
      const pairing = pairFlowJoWorkspaceFiles(
        ordered,
        [
          ...asViewed,
          ...others.map((entry) => ({ key: entry.id, name: entry.name, keywords: entry.sample.fcs.keywords })),
        ],
        { ...(fileChoices ?? {}), ...(asViewed.length ? { [asViewed[0].key]: choice.index } : {}) },
        {
          events: new Map(samples.map((entry) => [entry.name, entry.sample.fcs.nEvents] as const)),
          // The viewed file is open too, paired or not: a data set of its file is not one that
          // "might be" unopened.
          alsoOpen: sample && !asViewed.length ? [{ name: fileName, events: sample.fcs.nEvents }] : [],
        },
      );
      // Other loaded files several could be one sample, or a loaded file several samples could
      // be, and nothing tells which: asked, once.
      const undecided = pairing.ambiguous.filter((a) => a.fileKey !== activeSampleId && a.candidates.length > 1);
      if (fileChoices === null && (pairing.contested.length || undecided.length)) {
        setLoadedContest({
          text, wsSamples, choice, matchedOn, crossTo, pairingNote, contested: pairing.contested,
          answers: Object.fromEntries(pairing.contested.map((c) => [c.sampleIndex, ""])),
          undecided,
          fileAnswers: Object.fromEntries(undecided.map((a) => [a.fileKey, ""])),
        });
        return;
      }
      for (const r of pairing.resolutions) {
        if (!isPaired(r)) continue;
        // The chosen sample's own file is the viewed file -- or, when its tree goes onto the viewed
        // file by choice, a further file that gets the same sample's tree as its own.
        if (r.sampleIndex === choice.index && !crossTo) {
          for (const f of [{ fileKey: r.fileKey, fileName: r.fileName }, ...(r.copies ?? [])]) {
            if (f.fileKey !== activeSampleId) ownCopies.push({ sample: choice, fileName: f.fileName, entryId: f.fileKey });
          }
          continue;
        }
        const own = ordered.find((x) => x.index === r.sampleIndex)!;
        // A sample's file and any copy of it (one acquisition loaded twice) are each that sample.
        for (const f of [{ fileKey: r.fileKey, fileName: r.fileName }, ...(r.copies ?? [])]) {
          if (own.gateCount > 0) perFile.push({ sample: own, fileName: f.fileName, entryId: f.fileKey });
          else unpaired.push({ name: f.fileName, entryId: f.fileKey, why: `it is ${label(own.index)}, which carries no gates` });
        }
      }
      // A loaded file named like no sample follows the tree like any other, so it is named too:
      // it was skipped as none of this workspace's business, and took another sample's geometry
      // without a word while the result counted the files around it. A name two loaded files
      // share says which file it is.
      const called = loadedFileNames();
      const calledAs = (key: string, name: string) => called.get(key) ?? name;
      for (const u of pairing.unpaired) {
        if (u.fileKey === activeSampleId) continue;
        unpaired.push({ name: calledAs(u.fileKey, u.fileName), entryId: u.fileKey, why: describeUnpaired(u, label, calledAs) });
      }
    }
    // No dialog has asked "Evaluate gates as FlowJo does" yet: the import dialog asks it, on as in
    // the dialog that opens a workspace, and changing it there reads the workspace again. A tree
    // chosen by hand, or chosen again, comes to the same dialog.
    const flowJoGrid = true;
    const extra = { crossTo, unpaired, pairingNote, flowJoGrid, flowJoGridInDialog: true };
    const perFileAll = [{ sample: choice, fileName, entryId: activeSampleId }, ...ownCopies, ...perFile];
    // GateLab holds one strategy. Merging a sample's several trees would combine what FlowJo kept
    // apart, so the viewed file's sample having several is a question -- asked before the other
    // files' own trees were considered, which took every tree of every file with no way to choose
    // one. The picker offers each tree alone, and, where other loaded files are samples of their
    // own, every tree of each file, one hierarchy per file.
    if (choice.trees.length > 1) {
      setTreePicker({ text, sample: choice, matchedOn, crossTo, unpaired, pairingNote, flowJoGrid, flowJoGridInDialog: true, ...(perFile.length ? { perFileOption: perFileAll } : {}) });
      return;
    }
    if (perFile.length) {
      await importFlowJoSample(text, choice, matchedOn, null, perFileAll, null, [], [],
        { ...extra, mergedTreesAdvice: MERGED_TREES_ADVICE_LOADED });
      return;
    }
    await importFlowJoSample(text, choice, matchedOn, choice.trees.length === 1 ? 0 : null, [], null, [], [], extra);
  }

  async function importFlowJoSample(
    text: string,
    choice: FlowJoSampleSummary,
    matchedOn: FlowJoSampleMatchKey | null = null,
    /**
     * Which of the sample's top-level trees to import. A workspace holds one tree, so the others
     * are named in the result and not imported. Null takes every tree of the sample together, as
     * one tree: what a sample with a single tree, and each file of a per-file import, amounts to.
     */
    treeIndex: number | null = null,
    /**
     * One hierarchy per FCS: every OTHER resolved sample's strategy is imported too, each into
     * its own hierarchy, and each file is bound to the hierarchy drawn on it.
     *
     * Gate geometry stays shared, which is what makes this safe to do in one pass — samples of
     * a workspace that genuinely share a strategy converge on the same gates by name and
     * channel rather than duplicating them, and only samples whose gates differ add new ones.
     */
    perFile: readonly Readonly<{ sample: FlowJoSampleSummary; fileName: string; entryId?: string | null }>[] = [],
    /** Answered in the open dialog. Null means the import may still need to ask. */
    matrixChoice: "workspace" | "file" | null = null,
    /** The files the workspace open loaded, so cancelling the import can unload them again. */
    openedSampleIds: readonly string[] = [],
    /** Trees of this sample already chosen and found unimportable, so they are not offered again. */
    failedTrees: readonly { index: number; why: string }[] = [],
    extra: Readonly<{
      /**
       * The file this sample's tree is applied to when that file is NOT this sample: only ever the
       * user's explicit choice, and the result says so.
       */
      crossTo?: string | null;
      /** Files the open loaded that no sample is; they follow the tree, and are named. */
      unpaired?: readonly Readonly<{ name: string; entryId: string | null; why: string }>[];
      /** Files that are other gated samples, following this tree because one shared tree was chosen. */
      byChoice?: readonly Readonly<{ name: string; sample: string }>[];
      /** Said with the result: how the file was paired with this sample, where that needs saying. */
      pairingNote?: string | null;
      /** What to do instead of merging a sample's trees, under a per-file import from this path. */
      mergedTreesAdvice?: string;
      /** Files chosen for the open that could not be loaded, shown and counted with the notes. */
      loadNotes?: readonly string[];
      /**
       * "Evaluate gates as FlowJo does" for this import: the open dialog's answer, carried to
       * every file and to a tree chosen again; FlowJo's rule, the default, where none was given.
       */
      flowJoGrid?: boolean;
      /**
       * No earlier dialog asked it (a workspace imported onto the loaded files, from the Import
       * menu): the import dialog offers it, and changing it there reads the workspace again.
       */
      flowJoGridInDialog?: boolean;
      /** Carried to the tree picker when a chosen tree fails: see its perFileOption. */
      perFileOption?: readonly Readonly<{ sample: FlowJoSampleSummary; fileName: string; entryId: string | null }>[];
      /** Under a per-file import, the samples tried as the primary whose strategy could not be read. */
      triedPrimaries?: readonly number[];
    }> = {},
  ) {
    // Every caller but the .wsp-on-a-loaded-file path starts this without awaiting it -- from an
    // effect, or from a picker's click -- so an error thrown here was an unhandled rejection the
    // user never saw. It is caught and shown instead.
    try {
      // Per-file import overrides the tree question: each file contributes one hierarchy holding
      // all of its strategies, so there is no per-tree split to make.
      const perFileImport = perFile.length > 1;
      // The open dialog's answer; FlowJo's own rule, its default, where no dialog asked.
      const flowJoGrid = extra.flowJoGrid ?? true;
      const primaryIndex: number | null = perFileImport ? null : treeIndex;
      const primaryTree = primaryIndex === null ? undefined : choice.trees.find((tree) => tree.index === primaryIndex);
      // A chosen tree that cannot be imported leaves the choice open: the sample's other trees are
      // offered again, with why this one failed, rather than an error naming a list that had
      // already closed and a workspace left with nothing but All Events.
      const offerOtherTrees = (why: string): boolean => {
        if (!primaryTree || choice.trees.length < 2) return false;
        const failed = [...failedTrees.filter((f) => f.index !== primaryTree.index), { index: primaryTree.index, why }];
        // Trees with no readable gate are never offered, so they count as tried. Every tree, each
        // file its own sample's, is still a choice when other loaded files are samples: it was
        // dropped once every tree of this sample had failed alone, though it would have imported.
        const left = choice.trees.filter((tree) => tree.gateCount > 0 && !failed.some((f) => f.index === tree.index));
        const perFileLeft = (extra.perFileOption?.length ?? 0) > 1;
        if (!left.length && !perFileLeft) {
          // Nothing is left to choose, which leaves the open where cancelling it would: the files
          // it loaded go again, rather than staying with All Events only.
          const said = `The tree "${primaryTree.name}" could not be imported: ${why} None of the sample's ${choice.trees.length} trees could be imported`;
          if (openedSampleIds.length) {
            const n = openedSampleIds.length;
            void removeSamples(openedSampleIds).then(() => setError(
              `${said}, so the workspace open was cancelled: the ${n === 1 ? "file it loaded was" : `${n} files it loaded were`} removed again.`,
            ));
          } else {
            setError(`${said}.`);
          }
          return true;
        }
        // Everything the import carries goes with the tree chosen instead: what the open dialog
        // answered, the files it loaded, and the files the result names.
        setTreePicker({
          text, sample: choice, matchedOn, crossTo: extra.crossTo ?? null, matrixChoice, openedSampleIds, failed,
          unpaired: extra.unpaired ?? [], byChoice: extra.byChoice ?? [], pairingNote: extra.pairingNote ?? null,
          loadNotes: extra.loadNotes ?? [], flowJoGrid, flowJoGridInDialog: extra.flowJoGridInDialog,
          ...(extra.perFileOption ? { perFileOption: extra.perFileOption } : {}),
        });
        setError(`The tree "${primaryTree.name}" could not be imported: ${why} ` + (left.length
          ? `Choose another of the sample's ${choice.trees.length} trees.`
          : `None of the sample's ${choice.trees.length} trees can be imported alone; every tree, each file its own sample's, still can.`));
        return true;
      };
      // Under a per-file import a sample's trees go in together, and no tree can be chosen there;
      // the warning about that merge says what can be done instead.
      const mergedTreesAdvice = perFileImport
        ? extra.mergedTreesAdvice ?? 'To import one of them alone, open the workspace again with "One hierarchy per file" cleared and choose that tree.'
        : undefined;
      // Under a per-file import, a primary whose strategy cannot be read gives way to the next
      // file whose strategy reads: that file's tree is the tree, and this file follows it without
      // tailoring, named. The whole import used to stop, leaving the files the open loaded with
      // All Events only and the other files without the trees they could have had.
      const fallBackToAnotherPrimary = (why: string): boolean => {
        if (!perFileImport) return false;
        const tried = [...(extra.triedPrimaries ?? []), choice.index];
        const next = perFile.find((p0) => !tried.includes(p0.sample.index) && p0.entryId);
        const failedName = perFile.find((p0) => p0.sample.index === choice.index)?.fileName ?? choice.name;
        if (!next) {
          const said = `No file's strategy could be read; the last, ${failedName}'s: ${why}`;
          if (openedSampleIds.length) {
            const n = openedSampleIds.length;
            void removeSamples(openedSampleIds).then(() => setError(
              `${said} The workspace open was cancelled: the ${n === 1 ? "file it loaded was" : `${n} files it loaded were`} removed again.`,
            ));
          } else {
            setError(said);
          }
          return true;
        }
        setPendingFlowJoStrategy({
          text,
          choice: next.sample,
          treeIndex: null,
          target: { entryId: next.entryId ?? null, names: [next.fileName] },
          // Every file stays in: the one that failed is tried again as a further file, and named
          // there as following the tree because its strategy could not be read.
          perFile: perFile.map((p0) => ({ sample: p0.sample, fileName: p0.fileName, entryId: p0.entryId ?? null })),
          unpaired: extra.unpaired ?? [],
          ...(extra.byChoice?.length ? { byChoice: extra.byChoice } : {}),
          ...(extra.loadNotes?.length ? { loadNotes: extra.loadNotes } : {}),
          ...(extra.pairingNote ? { pairingNote: extra.pairingNote } : {}),
          ...(extra.mergedTreesAdvice ? { mergedTreesAdvice: extra.mergedTreesAdvice } : {}),
          // The dialog's matrix answer was about the file that failed; the new primary's is asked.
          openedSampleIds,
          triedPrimaries: tried,
          // "Evaluate gates as FlowJo does" was answered for the whole import, or is still asked.
          flowJoGrid,
          flowJoGridInDialog: extra.flowJoGridInDialog,
        });
        return true;
      };
      let converted: ReturnType<typeof flowJoWorkspaceToGatingML>;
      try {
        converted = flowJoWorkspaceToGatingML(text, choice.index, primaryIndex, mergedTreesAdvice, { flowJoGrid, translate: t });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (offerOtherTrees(why)) return;
        if (fallBackToAnotherPrimary(why)) return;
        throw new Error(why);
      }
      const primaryPair = perFile.length ? perFile.find((p0) => p0.sample.index === choice.index) : undefined;
      const primaryFileName = primaryPair?.fileName ?? null;
      // Skipped gates are surfaced, never dropped quietly: a hierarchy that silently loses a
      // branch looks like a successful import. They travel with the import and are shown beside
      // its result, since an error set here was cleared as soon as the import was staged. Under a
      // per-file import every file's notes are shown, each file's together under its name.
      const loadNotes = extra.loadNotes ?? [];
      const notes = [
        ...loadNotes,
        ...(perFileImport && primaryFileName && converted.warnings.length
          ? [`${calledLoaded(primaryFileName, primaryPair?.entryId)}: ${converted.warnings.join(" ")}`]
          : converted.warnings),
      ];
      let noteCount = loadNotes.length + converted.warnings.length;
      let siblingGridPolygons = 0;
      let siblingGateLabPolygons = 0;
      const siblingReferences: FlowJoReference[] = [];
      const siblings: { name: string; gatingMl: string; fileName?: string; entryId?: string | null; spillover?: FlowJoSpillover | null; origin?: string; sampleLabel?: string; warnings?: readonly string[]; unreadable?: string }[] = [];
      // Every other file's strategy, one hierarchy each, named after the file so the tree panel
      // and the sample badges read the same way. A file whose strategy cannot be read is named
      // and follows the tree, rather than failing the open of every other file.
      for (const other of perFile) {
        // The primary pair itself, not every file of the primary's sample: when the primary's tree
        // goes onto another file by choice, the file that IS that sample gets it as its own.
        if (other === primaryPair) continue;
        // ONE hierarchy per file, holding every tree that file carries. Splitting per tree as
        // well multiplied the two options together -- three files of three strategies produced
        // nine hierarchies -- when what "one hierarchy per file" says is one. A null tree index
        // takes all of the sample's top-level trees into a single strategy.
        let own: ReturnType<typeof flowJoWorkspaceToGatingML>;
        try {
          own = flowJoWorkspaceToGatingML(text, other.sample.index, null, mergedTreesAdvice, { flowJoGrid, translate: t });
        } catch (e) {
          siblings.push({ name: other.fileName, gatingMl: "", fileName: other.fileName, sampleLabel: `sample ${other.sample.index + 1}`, entryId: other.entryId ?? null, unreadable: e instanceof Error ? e.message : String(e) });
          // Its note is shown with the others, so it is counted with them.
          noteCount += 1;
          continue;
        }
        noteCount += own.warnings.length;
        siblingGridPolygons += own.gridPolygons;
        siblingGateLabPolygons += own.gateLabPolygons;
        siblingReferences.push({ entryId: other.entryId ?? null, fileName: other.fileName, sampleName: own.sampleName, events: other.sample.eventCount, counts: own.flowJoCounts });
        siblings.push({
          name: other.fileName,
          gatingMl: own.gatingMl,
          fileName: other.fileName,
          sampleLabel: `sample ${other.sample.index + 1}`,
          // The loaded file this sample IS, by id: two loaded files may share its name.
          entryId: other.entryId ?? null,
          // The matrix ITS gates were drawn under; a workspace can carry one per sample.
          spillover: own.spillover,
          ...(other.sample.owningGroup ? { origin: other.sample.owningGroup } : {}),
          ...(own.warnings.length ? { warnings: own.warnings } : {}),
        });
      }
      // FlowJo's own count of every population, kept beside the import so its result can be
      // checked against them. A tree put by choice onto a file that is not its sample has no
      // counts to answer to, so that file gets none.
      const flowJoReferences: FlowJoReference[] = [
        ...(extra.crossTo ? [] : [{
          entryId: primaryPair?.entryId ?? (perFile.length ? null : activeSampleId),
          fileName: primaryFileName ?? fileName,
          sampleName: converted.sampleName,
          events: choice.eventCount,
          counts: converted.flowJoCounts,
        }]),
        ...siblingReferences,
      ];
      const otherTrees = primaryTree ? choice.trees.filter((tree) => tree.index !== primaryTree.index) : [];
      const failedOtherTrees = otherTrees.filter((tree) => failedTrees.some((f) => f.index === tree.index));
      const notChosenTrees = otherTrees.filter((tree) => !failedTrees.some((f) => f.index === tree.index));
      const unpaired = extra.unpaired ?? [];
      const byChoice = extra.byChoice ?? [];
      const failed = await prepareGatingImportFromGatingML(
        converted.gatingMl,
        ` from FlowJo workspace · ${converted.sampleName}` +
          // The files are counted in the result; counted here as well, the two counts disagreed
          // whenever a file followed the tree with none of its own ("for 4 files" and "3 files").
          (perFileImport
            ? " · one hierarchy per file"
            : primaryTree && otherTrees.length
              ? ` · tree "${primaryTree.name}", ${choice.trees.indexOf(primaryTree) + 1} of ${choice.trees.length}; ` +
                // A sample can hold dozens of trees; the line names a few and counts the rest. A tree
                // tried and failed is said to have failed, not listed as one left out by the rule.
                [
                  notChosenTrees.length ? `not imported, one tree per workspace: ${namesInBrief(notChosenTrees.map((tree) => tree.name))}` : "",
                  failedOtherTrees.length ? `could not be imported: ${namesInBrief(failedOtherTrees.map((tree) => tree.name))}` : "",
                ].filter(Boolean).join("; ")
              : "") +
          // The sample name will not look like the loaded file when $FIL was the matching key, so
          // say why this sample was chosen rather than leaving it looking like the wrong one.
          (matchedOn === "fil" ? ` (matched on $FIL)` : "") +
          (extra.pairingNote ? ` · ${extra.pairingNote}` : "") +
          // Another sample's tree on this file happens only by the user's choice, and says so.
          (extra.crossTo
            ? ` · ${choice.name}'s tree${primaryTree ? ` "${primaryTree.name}"` : ""} applied to ${extra.crossTo} by choice`
            : "") +
          // Files with no tree of their own follow the tree; they are named, with why.
          (unpaired.length
            ? ` · following the tree without a tree of their own: ${unpaired.map((u) => `${u.name} (${u.why})`).join("; ")}`
            : "") +
          // Files that are other samples, following this tree because one shared tree was chosen.
          (byChoice.length
            ? ` · following this tree by choice, though each is its own sample: ${byChoice.map((b) => `${b.name} (${b.sample})`).join("; ")}`
            : "") +
          // Not every note is a skipped gate -- a qualified name or a stale copy is a note too.
          (noteCount ? ` · ${noteCount} note(s)` : "") +
          // How the gates are evaluated, as the dialog that opened the workspace or the import
          // dialog chose it: said with the result, which outlasts either dialog.
          (flowJoGrid
            ? ` · ${t("evaluated as FlowJo does ({count} polygon(s) on FlowJo's grid)", { count: converted.gridPolygons + siblingGridPolygons })}`
            : ` · ${t("evaluated continuously, not on FlowJo's grid")}`) +
          // Polygons GateLab wrote come back as it held them whichever way the option is set.
          (converted.gateLabPolygons + siblingGateLabPolygons
            ? ` · ${t("{count} polygon(s) GateLab wrote read as GateLab held them", { count: converted.gateLabPolygons + siblingGateLabPolygons })}`
            : ""),
        converted.spillover,
        siblings,
        primaryFileName,
        matrixChoice,
        openedSampleIds,
        choice.owningGroup || null,
        notes,
        primaryPair?.entryId ?? null,
        unpaired.flatMap((u) => (u.entryId ? [{ name: u.name, entryId: u.entryId }] : [])),
        [],
        {
          flowJoReferences,
          ...(primaryPair
            ? { primarySampleLabel: `sample ${choice.index + 1}`, ...(extra.crossTo ? { primaryByChoice: choice.name } : {}) }
            : {}),
          ...(extra.flowJoGridInDialog
            ? {
                flowJoGridChoice: {
                  value: flowJoGrid,
                  redo: (value: boolean) => importFlowJoSample(
                    text, choice, matchedOn, treeIndex, perFile, matrixChoice, openedSampleIds, failedTrees,
                    { ...extra, flowJoGrid: value },
                  ),
                },
              }
            : {}),
        },
      );
      // A tree the converter read but the import could not parse is as unusable as one it could
      // not read, and the other trees are offered the same way.
      if (failed && !offerOtherTrees(failed)) fallBackToAnotherPrimary(failed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * A spillover matrix the user supplies for gates drawn under a compensation their Gating-ML file
   * names and does not carry: a CSV or TSV table, as the Compensation tab reads one, square over the
   * same channels. Held on the pending import, and installed only when the import is applied.
   */
  async function supplyMissingMatrix(file: File) {
    const pending = pendingGatingMlImport;
    if (!sample || !pending?.missingMatrix) return;
    const fail = (message: string) => setPendingGatingMlImport((cur) => cur && cur.missingMatrix
      ? { ...cur, missingMatrix: { ...cur.missingMatrix, error: `${file.name}: ${message}` } }
      : cur);
    try {
      const { input } = parseCompensationMatrixTable(await file.text());
      const channels = [...input.sourceChannels];
      if (channels.length !== input.receiverChannels.length ||
          channels.some((ch, i) => ch !== input.receiverChannels[i])) {
        fail("its rows and columns name different channels; a spillover matrix is square over one set.");
        return;
      }
      const matrix = { channels, matrix: input.matrix.map((row) => [...row]) };
      const preview = sample.externalSpilloverPreview(matrix);
      if (!preview.display) {
        fail("fewer than two of its channels are fluorescence channels of the loaded file.");
        return;
      }
      const delta = sample.spillover !== null ? maxCoefficientDelta(sample.spillover, preview.display) : null;
      setPendingGatingMlImport((cur) => cur && cur.missingMatrix ? {
        ...cur,
        externalSpillover: {
          matrix,
          label: file.name,
          dropped: preview.dropped,
          replacesEmbedded: sample.spillover !== null,
          differsFromEmbedded: delta !== null && delta > 1e-6,
          maxDelta: delta,
          source: "supplied",
        },
        matrixChoice: "workspace",
        missingMatrix: { supplied: file.name, useFcs: false, error: null },
      } : cur);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  async function prepareGatingImportFromGatingML(
    text: string,
    wspNote: string,
    workspaceSpillover: FlowJoSpillover | null = null,
    /** Further top-level trees, each destined for its own hierarchy. Under a per-file import
     *  these come from OTHER samples too, and each carries the FCS it belongs to, the notes its
     *  conversion made, and -- when its strategy could not be converted -- why. */
    siblingTrees: readonly Readonly<{ name: string; gatingMl: string; fileName?: string; entryId?: string | null; spillover?: FlowJoSpillover | null; origin?: string; sampleLabel?: string; warnings?: readonly string[]; unreadable?: string }>[] = [],
    /** The FCS the primary tree belongs to, when importing one hierarchy per file. */
    primaryFileName: string | null = null,
    /**
     * The matrix already chosen in the workspace-open dialog. When set, the import applies it
     * without asking again -- the question was put where the files were being chosen, which is
     * the step that already has the context to answer it.
     */
    answeredMatrixChoice: "workspace" | "file" | null = null,
    /** The files a workspace open loaded for this import; cancelling the import unloads them. */
    openedSampleIds: readonly string[] = [],
    /** The primary strategy's origin (a FlowJo group), for naming the template it shares. */
    primaryOrigin: string | null = null,
    /** What the conversion skipped or could not read, shown with the import rather than lost. */
    notes: readonly string[] = [],
    /** The loaded entry the primary tree belongs to under a per-file import, by id. */
    primaryEntryId: string | null = null,
    /** Files the open loaded that no workspace sample is; they follow the tree. */
    followFiles: readonly Readonly<{ name: string; entryId: string }>[] = [],
    /** A Cytobank file's tree as tailored for each loaded file it names, by that file's id. */
    cytobankTailoring: readonly Readonly<{ fileName: string; entryId: string; gatingMl: string }>[] = [],
    /** Further fields of the staged import, set as given. */
    more: Readonly<Pick<PendingGatingMLImport, "primarySampleLabel" | "primaryByChoice" | "flowJoGridChoice" | "flowJoReferences">> = {},
  ): Promise<string | null> {
    // Resolves to why the import could not be staged, or null; the error is shown either way.
    if (!sample || !activeSampleId) return null;
    // The note names the format the Gating-ML was rewritten from; the dialog is titled after it.
    const sourceKind: GatingImportSourceKind = wspNote.startsWith(" from FlowJo workspace")
      ? "flowjo"
      : wspNote.startsWith(" from FACSChorus")
        ? "chorus"
        : wspNote.startsWith(" from FACSDiva")
          ? "diva"
          : "gatingml";
    try {
      const pnnMap: Record<string, string> = {};
      for (const c of sample.channels) pnnMap[c.pnn] = c.key;

      // The instrument decides whether an arcsinh vertex is inverted: flow stores gates in
      // raw space, CyTOF in arcsinh space.
      // The workspace's matrix, when it brings one. Which gates the import can hold depends on the
      // matrix it installs (appliedImportMatrix): the workspace's unless the file's is kept.
      const workspaceMatrix = workspaceSpillover && sample.instrument === "flow"
        ? sample.externalSpilloverPreview(workspaceSpillover.matrix).display
        : null;
      // A standard Gating-ML file states coordinates on FCS scale values, stored value / $PnG, and
      // GateLab gates the stored values, as FlowJo does: the importer restates them (options.gains),
      // before GateLab's own record of a rectangle is checked. A converted FlowJo, FACSChorus or
      // FACSDiva strategy is already on stored values and is not touched (gatingmlGain.ts).
      const gains = sourceKind === "gatingml" ? gatingMlGains(sample) : null;
      const parseFor = (choice: "workspace" | "file") => importGatingML(
        text, sample.channels.map((c) => c.key), pnnMap, sample.instrument,
        { ...gatingMLImportOptionsFor(sample, appliedImportMatrix(sample, workspaceMatrix, choice)), ...(gains?.size ? { gains } : {}) });
      const res = parseFor(answeredMatrixChoice ?? "workspace");
      // A Gating-ML file can carry the matrix its gates were compensated with (a spectrumMatrix
      // its dimensions reference), and then it plays the part a FlowJo workspace's matrix does.
      const fileMatrix: FlowJoSpillover | null = !workspaceSpillover && res.spectrum_matrix
        ? {
            // The matrix's own name, which a later export writes back as it is.
            name: res.spectrum_matrix.name,
            prefix: "",
            suffix: "",
            matrix: { channels: res.spectrum_matrix.channels, matrix: res.spectrum_matrix.matrix },
          }
        : null;
      const gatesMatrix = workspaceSpillover ?? fileMatrix;
      // The workspace's matrix takes precedence over one embedded in the file, because it is the
      // record of what the gates were actually drawn under. A FACSDiva export writes the
      // ACQUISITION matrix into the FCS while the operator's later adjustment lives only in the
      // workspace, and the two are not the same. The preview does not touch the sample.
      const external =
        gatesMatrix && sample.instrument === "flow"
          ? sample.externalSpilloverPreview(gatesMatrix.matrix)
          : null;
      // Where that matrix comes from, in the notes below.
      const matrixSource = fileMatrix ? "the Gating-ML file" : "the FlowJo workspace";
      const embeddedDelta =
        external?.display != null && sample.spillover !== null
          ? maxCoefficientDelta(sample.spillover, external.display)
          : null;
      const externalSpillover =
        external?.display != null
          ? {
              matrix: gatesMatrix!.matrix,
              label: gatesMatrix!.name || matrixSource,
              dropped: external.dropped,
              replacesEmbedded: sample.spillover !== null,
              // Coefficients agreeing to this much are the same matrix round-tripped through a
              // text keyword; beyond it the two are genuinely different compensations.
              differsFromEmbedded: embeddedDelta !== null && embeddedDelta > 1e-6,
              maxDelta: embeddedDelta,
              source: fileMatrix ? "gatingml" as const : "workspace" as const,
            }
          : null;
      // What the importer restated by $PnG, said with the result.
      let gainNote = "";
      if (gains?.size && res.gain) {
        const restated = res.gain;
        if (restated.converted.length) {
          const channels = [...gains].map(([key, g]) => `${key} ×${g}`).join(", ");
          const differing = samples.filter((entry) => entry.id !== activeSampleId && [...gains].some(([key, g]) => {
            const own = gatingMlGains(entry.sample).get(key) ?? 1;
            return entry.sample.index(key) !== undefined && own !== g;
          })).map((entry) => entry.name);
          gainNote =
            ` · ${restated.converted.length} gate(s) converted from Gating-ML scale values by $PnG (${channels})` +
            (differing.length ? `; ${differing.join(", ")} state a different gain, so these gates fit ${fileName} only` : "");
        }
        if (restated.unconverted.length) {
          gainNote += ` · not converted by $PnG: ${restated.unconverted.join(", ")}`;
        }
      } else if (sourceKind === "gatingml") {
        // FlowJo, flowUtils and CytoML files are read on stored values by default (gatingmlWriter.ts,
        // writerGainConvention), which differs from the standard only where a gated channel has a
        // gain; say so there.
        const writer = gatingMLWriterOf(text);
        const by = { flowjo: "FlowJo", flowutils: "flowUtils", cytoml: "CytoML" } as const;
        const onGain = writer === "flowjo" || writer === "flowutils" || writer === "cytoml"
          ? [...(gains ?? [])].filter(([key]) => Object.values(res.gates).some((g) => g.x_channel === key || g.y_channel === key))
          : [];
        if (onGain.length && (writer === "flowjo" || writer === "flowutils" || writer === "cytoml")) {
          gainNote = ` · read on stored values, as ${by[writer]} writes Gating-ML; ` +
            `$PnG not applied (${onGain.map(([key, g]) => `${key} ×${g}`).join(", ")})`;
        }
      }
      // Parsed now, so a tree that cannot be read stops the import before anything is applied
      // rather than half-way through. A tree drawn on ANOTHER loaded file is parsed against that
      // file's channels and instrument, and gets its own compensation decision: parsed against
      // the primary, a gate on a channel the primary lacks was dropped as "skipped", and the
      // other file was never compensated at all.
      // A further file's tree that cannot be converted or parsed is named, and that file follows
      // the tree, rather than failing the import of every other file. Each file's notes are
      // shown together, under its name, after the primary's.
      // One line per note in the header, which breaks the notes at newlines: a reason written over
      // several lines -- a Gating-ML refusal lists a gate per line -- became lines naming no file.
      const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
      const allNotes = notes.map(oneLine);
      // Notes made here, after the caller counted its own: a further file whose tree cannot be
      // parsed, or a Cytobank tailoring that cannot be read. The count in the note line covers them.
      let laterNotes = 0;
      const unreadFiles: { name: string; entryId: string | null; reason: "unreadable" | "unapplied" }[] = [];
      // Each tree is parsed against the matrix the answer to the matrix question installs
      // (appliedImportMatrix); its notes are said once, for the answer the import is prepared with.
      const siblingsFor = (choice: "workspace" | "file", say: boolean) => siblingTrees.flatMap((tree) => {
        const said = tree.warnings?.length ? ` ${oneLine(tree.warnings.join(" "))}` : "";
        // Each file's notes are headed by its name, told from another loaded file of that name.
        const heading = tree.fileName ? calledLoaded(tree.fileName, tree.entryId) : tree.name;
        if (tree.unreadable !== undefined) {
          if (!say) return [];
          allNotes.push(`${heading}: its strategy could not be read, so it follows the imported tree without tailoring. ${oneLine(tree.unreadable)}`);
          if (tree.fileName) unreadFiles.push({ name: tree.fileName, entryId: tree.entryId ?? null, reason: "unreadable" });
          return [];
        }
        try {
          const resolved = resolveSiblingImport(tree, sample, samples, activeSampleId, choice, appliedImportMatrix(sample, workspaceMatrix, choice));
          if (said && say) allNotes.push(`${heading}:${said}`);
          return [resolved];
        } catch (e) {
          // Its tree was read, and could not be applied to this file -- a channel it lacks, say. What
          // the conversion said about that tree is not said of this file, onto which nothing went.
          if (!say) return [];
          laterNotes += 1;
          allNotes.push(`${heading}: its tree could not be applied to it, so it follows the imported tree without tailoring. ${oneLine(e instanceof Error ? e.message : String(e))}`);
          if (tree.fileName) unreadFiles.push({ name: tree.fileName, entryId: tree.entryId ?? null, reason: "unapplied" });
          return [];
        }
      });
      const siblings = siblingsFor(answeredMatrixChoice ?? "workspace", true);
      const compensationFor = (r: GatingMLResult) => resolveGatingMLCompensation(
        r.compensation,
        r.compensation_refs,
        sample.instrument === "flow",
        external?.display ?? sample.spillover ?? null,
        { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) },
      );
      // Each file Cytobank tailored gates for, its tree parsed against that file's channels.
      const cytobank = cytobankTailoring.flatMap((c) => {
        const entry = samples.find((e) => e.id === c.entryId);
        if (!entry) return [];
        const pnn: Record<string, string> = {};
        for (const ch of entry.sample.channels) pnn[ch.pnn] = ch.key;
        try {
          return [{ fileName: c.fileName, entryId: c.entryId, result: importGatingML(c.gatingMl, entry.sample.channels.map((ch) => ch.key), pnn, entry.sample.instrument) }];
        } catch (e) {
          allNotes.push(`${calledLoaded(c.fileName, c.entryId)}: Cytobank's gates tailored for it could not be read, so it follows the tree. ${e instanceof Error ? e.message : String(e)}`);
          laterNotes += 1;
          return [];
        }
      });
      const comp = compensationFor(res);
      const existingStrategy = state.root_population_id !== null && hasGatingStrategy({
        gates: state.gates,
        populations: state.populations,
        root_population_id: state.root_population_id,
      });
      const mergeBlockedFor = (c: GatingMLCompensationResolution) => gatingMergeSpaceConflict({
        hasExistingStrategy: existingStrategy,
        isFlow: sample.instrument === "flow",
        currentCompensation: sample.compensationEnabled,
        importedCompensationTarget: c.target,
        currentCytofCofactor: sample.arcsinhCofactor,
        importedCytofCofactor: res.cytof_cofactor,
      });
      const mergeBlockedReason = mergeBlockedFor(comp);
      const missing = sample.instrument === "flow" ? res.missing_compensation : null;
      const noteFor = (comp: GatingMLCompensationResolution): string | null => {
        // Said in the interface's language (the dialog showed these in English in Japanese), each
        // sentence a template with its values, the English as before.
        let compensationNote: string | null = null;
        const source = t(matrixSource);
        if (missing) {
          // Never the FCS file's matrix unasked: the gates name a different one.
          const gates = missing.gates.map((n) => `"${n}"`).join(", ");
          compensationNote = t(missing.gates.length === 1
            ? "The gate ({gates}) was drawn under Cytobank compensation {id}, which this file names but does not carry. To import them as drawn, load that matrix below. Evaluating them with this FCS file's own matrix instead places them on differently compensated data; choose it only knowing that."
            : "{count} gates ({gates}) were drawn under Cytobank compensation {id}, which this file names but does not carry. To import them as drawn, load that matrix below. Evaluating them with this FCS file's own matrix instead places them on differently compensated data; choose it only knowing that.",
          { count: missing.gates.length, gates, id: missing.id });
        } else if (comp.target !== null) {
          if (comp.source === "embedded" && comp.target && fileMatrix && externalSpillover) {
            // A GateLab file recording that its gates were drawn under a matrix other than the
            // FCS file's own, and carrying that matrix.
            const values = {
              label: externalSpillover.label,
              count: externalSpillover.matrix.channels.length - externalSpillover.dropped.length,
              delta: externalSpillover.differsFromEmbedded ? externalSpillover.maxDelta!.toFixed(4) : "",
            };
            compensationNote = externalSpillover.differsFromEmbedded
              ? t("This strategy was gated with the spillover matrix \"{label}\", which the file carries. Importing will apply it to {count} channel(s) and enable compensation; this FCS carries a different matrix of its own (coefficients differ by up to {delta}), which changes where every fluorescence gate falls.", values)
              : t("This strategy was gated with the spillover matrix \"{label}\", which the file carries. Importing will apply it to {count} channel(s) and enable compensation.", values);
          } else if (comp.source === "embedded") {
            if (comp.target) {
              compensationNote = sample.compensationEnabled
                ? t("The embedded spillover matrix exactly matches the loaded FCS; compensation is already enabled.")
                : t("This strategy was gated with FCS compensation enabled. Its exact matrix matches the loaded FCS, so importing will enable compensation.");
            } else {
              compensationNote = sample.compensationEnabled
                ? t("This strategy was gated without compensation, so importing will disable the current compensation setting.")
                : t("This strategy was gated without compensation; the current data are already uncompensated.");
            }
          } else if (comp.target && externalSpillover?.differsFromEmbedded) {
            // The most dangerous case, and the reason any of this exists: both matrices are real
            // and they disagree, so compensating with the file's would move every fluorescence
            // gate while looking completely healthy.
            compensationNote = t(
              "This FCS and {source} each carry a spillover matrix, and they are not the same: coefficients differ by up to {delta}. " +
              "The FCS's is typically the matrix recorded at acquisition; the one in {source} is the compensation in force when these gates were drawn. " +
              "Compensation will be enabled either way, and which matrix is used changes where every fluorescence gate falls.",
              { source, delta: externalSpillover.maxDelta!.toFixed(4) },
            );
          } else if (comp.target && externalSpillover?.replacesEmbedded) {
            // Both carry a matrix and they agree -- the differing case is handled above -- so this
            // is the file's own compensation under the workspace's name. This branch used to be
            // reached here too, and told the user a file that carries a matrix "carries none".
            compensationNote = t(
              "The spillover matrix \"{label}\" from {source} matches the one in this FCS; importing will enable compensation with it.",
              { label: externalSpillover.label, source },
            );
          } else if (comp.target && externalSpillover) {
            // The loaded FCS has no matrix of its own, so this is the only thing that can place the
            // gates. It changes every fluorescence value, so it is stated plainly rather than
            // applied as a detail of the gate import.
            compensationNote = t(
              "These gates were drawn on compensated data, and this FCS carries no spillover matrix. Importing will apply the matrix \"{label}\" from {source} to {count} channel(s) and enable compensation.",
              { label: externalSpillover.label, source, count: externalSpillover.matrix.channels.length - externalSpillover.dropped.length },
            ) +
              (externalSpillover.dropped.length
                ? " " + t(
                  "{count} of its parameter(s) are not in this file ({names}) and were left out, which changes the result for the channels they spill into.",
                  { count: externalSpillover.dropped.length, names: externalSpillover.dropped.join(", ") },
                )
                : "");
          } else if (comp.note) {
            compensationNote = comp.note +
              (comp.target === false && sample.compensationEnabled ? " " + t("Importing will disable the current compensation setting.") : "");
          } else if (comp.target) {
            compensationNote = t(
              "This file declares FCS compensation but does not contain GateLab's exact matrix record. " +
              "Import will use the spillover matrix embedded in the loaded FCS. Continue only if compensation was enabled when these gates were drawn.",
            );
          } else if (sample.compensationEnabled) {
            compensationNote = t("This file declares uncompensated dimensions, so importing will disable the current compensation setting.");
          }
        }
        return compensationNote;
      };
      const compensationNote = noteFor(comp);
      // While the dialog still asks which matrix, the import is prepared with the file's own too,
      // and choosing it there swaps that in: installed instead of the workspace's, it compensates
      // other detectors, and a gate drawn uncompensated on one of them is left out, by name.
      // Under a per-file import the dialog asks for other files' matrices too (matrixChoice below), and
      // one answer applies to every file, so the file's-own preparation covers them as well.
      const asksMatrix = !answeredMatrixChoice && (
        (workspaceMatrix !== null && externalSpillover?.differsFromEmbedded === true) ||
        siblings.some((tree) => tree.externalSpillover?.differsFromEmbedded));
      const fileChoice = asksMatrix ? parseFor("file") : null;
      const fileCompensation = fileChoice ? compensationFor(fileChoice) : null;
      const byMatrixChoice: PendingGatingMLImport["byMatrixChoice"] = fileChoice && fileCompensation
        ? {
            workspace: { result: res, siblingTrees: siblings, compensation: comp, mergeBlockedReason, compensationNote },
            file: {
              result: fileChoice,
              siblingTrees: siblingsFor("file", false),
              compensation: fileCompensation,
              mergeBlockedReason: mergeBlockedFor(fileCompensation),
              compensationNote: noteFor(fileCompensation),
            },
          }
        : undefined;
      setPendingGatingMlImport({
        result: res,
        sourceKind,
        compensation: comp,
        sampleId: activeSampleId,
        siblingTrees: siblings,
        ...(primaryFileName ? { primaryFileName } : {}),
        ...(primaryEntryId ? { primaryEntryId } : {}),
        ...(primaryOrigin ? { primaryOrigin } : {}),
        mergeBlockedReason,
        compensationNote,
        sourceNote: withMoreNotes(wspNote, laterNotes) + gainNote,
        externalSpillover,
        // Defaulting to the workspace's, because that is the compensation the gates were drawn
        // under -- but it is offered as a choice, not asserted as the correct answer.
        matrixChoice: answeredMatrixChoice ?? "workspace",
        ...(answeredMatrixChoice ? { matrixAnswered: true } : {}),
        ...(openedSampleIds.length ? { openedSampleIds } : {}),
        ...(missing ? { missingMatrix: { supplied: null, useFcs: false, error: null } } : {}),
        ...(allNotes.length ? { notes: allNotes } : {}),
        ...(unreadFiles.length ? { unreadFiles } : {}),
        ...(followFiles.length ? { followFiles } : {}),
        ...(cytobank.length ? { cytobankTailoring: cytobank } : {}),
        ...more,
        ...(byMatrixChoice ? { byMatrixChoice } : {}),
      });
      // Populations the import leaves out are named before anything is applied, never dropped
      // quietly: a tree that silently loses a branch looks like a successful import. The
      // converter's and the further files' notes are said with them.
      const said = [...res.warnings, ...allNotes];
      setError(said.length ? said.join("\n") : null);
      return null;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(why);
      return why;
    }
  }

  // Importing into an EMPTY workspace has nothing to ask about: with no strategy to replace,
  // "merge" and "replace" produce the same result, so the dialog was asking the user to choose
  // between two identical outcomes. It still appears whenever a real decision exists -- an
  // existing strategy, a compensation warning, or two different spillover matrices.
  useEffect(() => {
    if (!pendingGatingMlImport) return;
    if (gatingImportNeedsDecision(pendingGatingMlImport, state, samples.length)) return;
    void applyGatingImport("replace", "all");
    // applyGatingImport is recreated every render and re-running on `state` would re-apply the
    // import; the pending record is what identifies one import, so it alone drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGatingMlImport]);

  async function applyGatingImport(mode: GatingImportMode, target: GatingImportTarget = "all") {
    const pendingImport = pendingGatingMlImport;
    if (!sample || !pendingImport || pendingImport.sampleId !== activeSampleId) {
      setPendingGatingMlImport(null);
      setError("The active sample changed before Gating-ML import could be applied. Please import the file again.");
      return;
    }
    // A compensation the file names and does not carry is supplied, or the FCS file's own is
    // chosen for it, before anything is applied; the dialog holds Import until then.
    const missingMatrix = pendingImport.missingMatrix;
    if (missingMatrix && missingMatrix.supplied === null && !missingMatrix.useFcs) return;
    // A tree lands on a group's template, never on a file's copy: the reducer drops a structural
    // change to a locked copy without a word, and a plain click on a file makes its copy the live
    // tree. So the live tree's template becomes live first, and everything below lands there.
    const activeId = templateOf(state.active_hierarchy_id, state.hierarchies)?.id ?? state.active_hierarchy_id;
    if (activeId !== state.active_hierarchy_id) dispatch({ type: "switchHierarchy", id: activeId });
    if (gatingImportBusyRef.current) return;
    gatingImportBusyRef.current = true;
    setGatingImportBusy(true);
    // Every sample whose spillover this import touches, with its state before. A failure after
    // a matrix had been installed used to leave that matrix in place with no strategy to go
    // with it; until the strategy is committed, a failure puts every sample back.
    const touched: { sample: Sample; snapshot: ReturnType<Sample["spilloverSnapshot"]> }[] = [];
    let committed = false;
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
      // Every tree drawn on another loaded file gets the same decision applied to ITS sample,
      // and first: a file whose hierarchy was imported while it stayed on its original layer
      // evaluated every fluorescence gate on uncompensated values. Done before the primary is
      // touched, so a file whose matrix cannot be applied aborts the import with nothing changed.
      for (const tree of pendingImport.siblingTrees ?? []) {
        if (!tree.sampleId || !tree.compensation) continue;
        const entry = samples.find((e) => e.id === tree.sampleId);
        if (!entry) continue;
        const target = entry.sample;
        const own = tree.compensation;
        touched.push({ sample: target, snapshot: target.spilloverSnapshot() });
        if (
          own.target === true &&
          tree.externalSpillover &&
          !(tree.externalSpillover.differsFromEmbedded && pendingImport.matrixChoice === "file")
        ) {
          target.installExternalSpillover(
            tree.externalSpillover.matrix,
            tree.externalSpillover.label,
            { replaceEmbedded: tree.externalSpillover.replacesEmbedded },
          );
        }
        if (own.target !== null) {
          target.setCompensation(own.target);
          if (target.compensationEnabled !== own.target) {
            throw new Error(
              `The spillover matrix could not be applied to ${entry.name}, so the gating strategy was not imported.`,
            );
          }
        }
      }
      // A loaded file that is the viewed file's own acquisition under another name (its identity
      // keywords confirmed, its events as many) and has no tree of its own in this import follows
      // the viewed file's tree, and takes its compensation too: the matrix it is installed with
      // and the layer. It stayed on its original layer, its fluorescence gates evaluated on
      // uncompensated values, while the result said "applied to all 2 files · FCS compensation
      // enabled" (#343's round-4 verifier, FR-FCM-Z2V4 F_022 and a copy: 863 against 770 and
      // FlowJo's 771), on every route that imports one tree: onto a loaded file with only its copy
      // beside it, the open dialog with a file and its copy, and "One hierarchy per file" cleared.
      const ownTree = new Set<string>([
        ...(activeSampleId ? [activeSampleId] : []),
        ...(pendingImport.siblingTrees ?? []).flatMap((tree) => [tree.sampleId, tree.entryId]).filter((id): id is string => !!id),
      ]);
      const viewedIdentity = identityKeywords(sample.fcs.keywords);
      const copiesOfViewed = samples.filter((entry) =>
        !ownTree.has(entry.id) &&
        entry.sample.instrument === sample.instrument &&
        entry.sample.fcs.nEvents === sample.fcs.nEvents &&
        compareIdentity(viewedIdentity, identityKeywords(entry.sample.fcs.keywords)).verdict === "confirmed");
      for (const entry of copiesOfViewed) {
        const target = entry.sample;
        touched.push({ sample: target, snapshot: target.spilloverSnapshot() });
        if (
          comp.target === true &&
          pendingImport.externalSpillover &&
          !(pendingImport.externalSpillover.differsFromEmbedded && pendingImport.matrixChoice === "file")
        ) {
          target.installExternalSpillover(
            pendingImport.externalSpillover.matrix,
            pendingImport.externalSpillover.label,
            { replaceEmbedded: target.spillover !== null },
          );
        }
        if (comp.target !== null) {
          target.setCompensation(comp.target);
          if (target.compensationEnabled !== comp.target) {
            throw new Error(
              `The spillover matrix could not be applied to ${calledLoaded(entry.name, entry.id)}, a copy of the viewed file, so the gating strategy was not imported.`,
            );
          }
        }
      }
      // Installed only now that the import is going ahead. It rewrites every fluorescence value,
      // so it must not happen while the confirmation dialog can still be dismissed.
      touched.push({ sample, snapshot: sample.spilloverSnapshot() });
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
      committed = true;
      queueCheckpoint("after-gatingml-import");
      const siblings = pendingImport.siblingTrees ?? [];
      // Which hierarchy each FCS belongs to, when the workspace was imported one hierarchy per
      // file. Collected as the hierarchies are created, because the id is only known here.
      const assignments: Record<string, string> = {};
      // Each tree goes on the loaded entry the open paired it with, by id; a file name can be
      // carried by two loaded files, and the first of them was not necessarily the one.
      const loadedId = (id: string | null | undefined): string | null =>
        id && samples.some((entry) => entry.id === id) ? id : null;
      // Per-file import, the way FlowJo means it: files whose strategies share a STRUCTURE
      // (populations and gate identities, geometry aside) share one template hierarchy, and
      // every file gets a file-owned, structure-locked copy of it carrying its own tailored
      // coordinates, with provenance back to the template's gates. A file whose structure
      // differs starts a template of its own. Each sample as its own unlinked hierarchy plus a
      // copy on top doubled the hierarchies and lost the fact that they were one tree.
      const perFileFiles: TailoredFile[] = [];
      const primaryId = pendingImport.primaryFileName ? loadedId(pendingImport.primaryEntryId) : null;
      // Each file's channels by the detector ($PnN) they read, so its gates are matched with the
      // tree's by detector: two samples of one workspace can label a detector differently, and a
      // file whose labels differed from the tree's file lost its own gates on them.
      const detectorsOf = (id: string): Record<string, string> | undefined => {
        const entry = samples.find((e) => e.id === id);
        return entry ? Object.fromEntries(entry.sample.channels.map((c) => [c.key, c.pnn])) : undefined;
      };
      if (pendingImport.primaryFileName && primaryId) {
        perFileFiles.push({ fileId: primaryId, fileName: pendingImport.primaryFileName, tree: res, origin: pendingImport.primaryOrigin ?? null, detectors: detectorsOf(primaryId) });
      }
      if (pendingImport.primaryFileName) {
        for (const tree of siblings) {
          const id = tree.fileName ? loadedId(tree.entryId) : null;
          if (id && tree.fileName) perFileFiles.push({ fileId: id, fileName: tree.fileName, tree: tree.result, origin: tree.origin ?? null, detectors: detectorsOf(id) });
        }
      }
      // Found files whose own strategy could not be read, and files no sample is: they follow
      // the tree, and are counted.
      const unreadIds = (pendingImport.unreadFiles ?? []).flatMap(({ name, entryId, reason }) => {
        const id = loadedId(entryId);
        return id && !perFileFiles.some((f) => f.fileId === id) ? [{ id, name, reason: reason ?? "unreadable" }] : [];
      });
      const followIds = (pendingImport.followFiles ?? []).flatMap(({ name, entryId }) => {
        const id = loadedId(entryId);
        return id && !perFileFiles.some((f) => f.fileId === id) && !unreadIds.some((u) => u.id === id) ? [{ id, name }] : [];
      });
      let perFileSummary: string | null = null;
      let tailoredCount: number | null = null;
      /** Files a merge left on their own tailored copy of the tree. */
      let tailoringKept = 0;
      let cytobankSummary = "";
      const notImported = siblings.filter((tree) => !tree.fileName || !loadedId(tree.entryId)).map((tree) => tree.name);
      // A per-file import is laid out as one: also when one file is left to give the tree, the
      // others' strategies unreadable -- they are then named as following it, not lost under
      // "applied to all N files".
      if (pendingImport.primaryFileName && perFileFiles.length > 0 && (perFileFiles.length > 1 || unreadIds.length > 0) && mode === "replace") {
        // One tree, tailored per file: the primary's strategy is the tree, and every other file
        // gets it with its own coordinates on the gates they share. Files whose strategy differs
        // in structure are reported by name with what was dropped and what follows the tree.
        const plan = planOneTreeImport(perFileFiles, {
          templateId: activeId, leadFileId: primaryId, existing: state.hierarchies,
          name: (lead) => templateNameFromOrigin({ key: "", lead, files: perFileFiles }, "Imported strategy"),
        });
        const name = plan.template.name;
        // Files whose own gates stay on channels the tree's file labels otherwise, or are drawn as
        // another kind: matched with the tree by detector, they keep their own, and so their copy
        // is out of step with the tree -- edits to it do not reach them -- which is said, not left
        // to be found.
        const ownLabels = plan.copies.filter((copy) => Object.entries(copy.source_gate_ids ?? {}).some(([own, source]) => {
          const a = copy.gates[own], b = plan.template.tree.gates[source];
          return !!a && !!b && (a.x_channel !== b.x_channel || a.y_channel !== b.y_channel || a.gate_type !== b.gate_type);
        })).map((copy) => {
          const f = perFileFiles.find((x) => x.fileId === copy.owner_sample_id);
          return f ? calledLoaded(f.fileName, f.fileId) : "";
        }).filter(Boolean);
        // Other files whose own matrix differs from their sample's: settled by the dialog's answer.
        const matrixFiles = siblings.filter((tree) => tree.sampleId && tree.externalSpillover?.differsFromEmbedded && tree.compensation?.target === true)
          .map((tree) => calledLoaded(tree.fileName ?? tree.name, tree.entryId));
        // Files named as the other messages name them: told from another loaded file of their name.
        const leadName = calledLoaded(plan.lead.fileName, plan.lead.fileId);
        const differing = plan.differing.map((d) => ({ ...d, fileName: calledLoaded(d.fileName, d.fileId) }));
        dispatch({
          type: "importGating",
          gates: plan.template.tree.gates,
          gate_order: plan.template.tree.gate_order,
          populations: plan.template.tree.populations,
          root_population_id: plan.template.tree.root_population_id,
          mode: "replace",
          clearHistory: compensationChanged || restoredScales.transformsChanged,
        });
        dispatch({ type: "renameHierarchy", id: activeId, name });
        // A file whose strategy could not be read follows the tree, whatever it followed before,
        // and is counted with the files that follow it: the line used to count only the files
        // it could read, and disagreed with the tree's own summary.
        // So does a file the open loaded that no sample in the workspace is: it has no strategy of
        // its own to tailor, and the result names it (the source note says why).
        const assignments = {
          ...plan.assignments,
          ...Object.fromEntries([...unreadIds, ...followIds].map((u) => [u.id, activeId])),
        };
        if (plan.copies.length) dispatch({ type: "addHierarchyCopies", copies: plan.copies, activeHierarchyId: activeId, assignments });
        else dispatch({ type: "assignFileHierarchies", assignments });
        const unread = unreadIds.length;
        const follow = followIds.length;
        // A FACSDiva or FACSChorus experiment is not a workspace.
        const asInSource = pendingImport.sourceKind === "flowjo" ? " as in the workspace"
          : pendingImport.sourceKind === "diva" || pendingImport.sourceKind === "chorus" ? " as in the experiment" : "";
        const unreadOf = (reason: "unreadable" | "unapplied") => unreadIds.filter((u) => u.reason === reason);
        const said = (list: readonly { id: string; name: string }[], why: (one: boolean) => string) => list.length
          ? ` ${list.map((u) => calledLoaded(u.name, u.id)).join(", ")} ${list.length === 1 ? "follows" : "follow"} it without tailoring: ${why(list.length === 1)}.`
          : "";
        // The files that follow with no tree of their own are counted here and named once, with
        // why, in the source note: named here too, with another reason, they read as two claims.
        perFileSummary =
          `Imported one tree, "${name}", from ${leadName} for ${perFileFiles.length + unread + follow} files: ` +
          `${plan.following + unread + follow} ${plan.following + unread + follow === 1 ? "follows" : "follow"} it${unread || follow ? "" : asInSource}, ${plan.copies.length} tailored.` +
          said(unreadOf("unreadable"), (one) => `${one ? "its strategy" : "their strategies"} could not be read`) +
          said(unreadOf("unapplied"), (one) => `${one ? "its tree" : "their trees"} could not be applied to ${one ? "it" : "them"}`) +
          (differing.length
            ? ` ${differing.length} file${differing.length === 1 ? "" : "s"} carried a different tree: ${describeDiffering(differing)}.`
            : "") +
          (ownLabels.length
            ? ` ${ownLabels.join(", ")} ${ownLabels.length === 1 ? "labels" : "label"} a detector differently from ${leadName}, ` +
              `or ${ownLabels.length === 1 ? "draws" : "draw"} a gate as another kind, and ${ownLabels.length === 1 ? "keeps its own" : "keep their own"} there; ` +
              `edits to the tree do not reach ${ownLabels.length === 1 ? "that file" : "those files"}.`
            : "") +
          (matrixFiles.length
            ? ` ${matrixFiles.join(", ")} ${matrixFiles.length === 1 ? "carries" : "carry"} a matrix that differs from ${matrixFiles.length === 1 ? "its" : "their"} sample's in the workspace; ` +
              `${pendingImport.matrixChoice === "file" ? "the file's own" : "the workspace's"} was used, as chosen.`
            : "");
      } else if (target !== "all" && samples.length > 1 && state.root_population_id) {
        // The selected files, or the viewed file, take the imported coordinates as tailoring of
        // the tree they already follow. That needs the tree's structure; the dialog only offers
        // it then, and this is the same check.
        const current = { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id };
        if (!sameStructure(current, res)) {
          throw new Error("The imported tree differs in structure from this workspace's tree, so it cannot tailor files. Import it for all files to replace the tree, or open it in a new workspace.");
        }
        const targetIds = target === "viewed" ? (activeSampleId ? [activeSampleId] : []) : checkedSamples.map((entry) => entry.id);
        const files: TailoredFile[] = targetIds.flatMap((id) => {
          const entry = samples.find((candidate) => candidate.id === id);
          return entry ? [{ fileId: id, fileName: entry.name, tree: res }] : [];
        });
        const tailoring = tailorFilesToTree({ id: activeId, name: activeHierarchy?.name ?? "", tree: current }, files, state.hierarchies, new Set(targetIds));
        const viewedCopy = activeSampleId ? tailoring.copies.find((copy) => copy.owner_sample_id === activeSampleId)?.id : undefined;
        if (viewedCopy) setEditMode("file"); // the user asked for this file's tailoring: show it
        if (tailoring.copies.length) dispatch({ type: "addHierarchyCopies", copies: tailoring.copies, activeHierarchyId: viewedCopy ?? activeId, assignments: tailoring.assignments });
        else if (Object.keys(tailoring.assignments).length) dispatch({ type: "assignFileHierarchies", assignments: tailoring.assignments });
        tailoredCount = tailoring.copies.length;
      } else {
        dispatch({
          type: "importGating",
          gates: res.gates,
          gate_order: res.gate_order,
          populations: res.populations,
          root_population_id: res.root_population_id,
          mode,
          clearHistory: compensationChanged || restoredScales.transformsChanged,
        });
        // Every file follows the tree; a copy a file had is dropped with the move, as the dialog
        // said -- when the tree is replaced. A merge keeps the tree, so a file already tailored to
        // it keeps its copy, which the merge's new gates reach like any edit to the tree: moving
        // it back onto the tree threw away the per-file geometry an earlier import had given it,
        // and it drifted to another sample's.
        const followsTree = (fileId: string): boolean => {
          let id: string | undefined = hierarchyOfFile(fileId);
          const seen = new Set<string>();
          while (id && !seen.has(id)) {
            if (id === activeId) return true;
            seen.add(id);
            id = state.hierarchies.find((h) => h.id === id)?.source_hierarchy_id ?? undefined;
          }
          return false;
        };
        for (const entry of samples) {
          if (mode === "merge" && followsTree(entry.id)) {
            if (hierarchyOfFile(entry.id) !== activeId) tailoringKept += 1;
            continue;
          }
          assignments[entry.id] = activeId;
        }
        // ...except that a file Cytobank tailored gates for takes them, as its own tailoring of the
        // tree, and no other file does.
        const cytobankFiles: TailoredFile[] = mode === "replace"
          ? (pendingImport.cytobankTailoring ?? []).flatMap((c) => loadedId(c.entryId) ? [{ fileId: c.entryId, fileName: c.fileName, tree: c.result }] : [])
          : [];
        const cytobankPlan = cytobankFiles.length
          ? tailorFilesToTree(
              { id: activeId, name: activeHierarchy?.name ?? "", tree: { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id } },
              cytobankFiles, state.hierarchies, new Set(cytobankFiles.filter((f) => sameStructure(f.tree, res)).map((f) => f.fileId)))
          : null;
        if (cytobankPlan) {
          Object.assign(assignments, cytobankPlan.assignments);
          const tailoredNames = cytobankPlan.copies.map((c) => samples.find((e) => e.id === c.owner_sample_id)?.name ?? "").filter(Boolean);
          cytobankSummary = tailoredNames.length
            ? ` · Cytobank's tailored gates applied to ${tailoredNames.length === 1 ? "the file" : `the ${tailoredNames.length} files`} they were tailored for: ${tailoredNames.join(", ")}`
            : "";
        } else if ((pendingImport.cytobankTailoring ?? []).length && mode !== "replace") {
          cytobankSummary = " · Cytobank's per-file tailoring was not applied: it applies when the tree is replaced, not merged";
        }
        if (cytobankPlan?.copies.length) {
          dispatch({ type: "addHierarchyCopies", copies: cytobankPlan.copies, activeHierarchyId: activeId, assignments });
        } else if (Object.keys(assignments).length) {
          dispatch({ type: "assignFileHierarchies", assignments });
        }
      }
      setPendingGatingMlImport(null);
      const said = [...res.warnings, ...(pendingImport.notes ?? [])];
      setError(said.length ? said.join("\n") : null);
      // Where one tree is applied to every file, the files it is applied to whose compensation is
      // not what the import set on the viewed file: another sample following by choice, or a file
      // no sample is, keeps its own layer, and is named rather than covered by "FCS compensation
      // enabled" said once for them all.
      const layerDiffers = perFileSummary || tailoredCount !== null || samples.length < 2 || comp.target === null
        ? []
        : samples.filter((entry) => entry.sample.instrument === "flow" && entry.sample.compensationEnabled !== comp.target)
          .map((entry) => calledLoaded(entry.name, entry.id));
      const layerNote = layerDiffers.length
        ? (comp.target === true
            ? ` on ${samples.length - layerDiffers.length} of ${samples.length} files; ${layerDiffers.join(", ")} ${layerDiffers.length === 1 ? "is" : "are"} not compensated`
            : `; ${layerDiffers.join(", ")} ${layerDiffers.length === 1 ? "is" : "are"} still compensated`)
        : "";
      setImportMsg(perFileSummary
        ? perFileSummary +
          (comp.target === true ? " FCS compensation enabled." : "") +
          (comp.target === false ? " Compensation disabled." : "") +
          pendingImport.sourceNote
        :
        `${mode === "merge" ? "Merged" : "Imported"} ${res.n_gates_imported} gates, ${res.n_pops_imported} populations` +
          (tailoredCount !== null
            ? (target === "viewed"
                ? ` · as ${fileName}'s tailoring${tailoredCount ? "" : " (same coordinates as the tree, so nothing is tailored)"}`
                : ` · as tailoring for the ${checkedSamples.length} selected file${checkedSamples.length === 1 ? "" : "s"} (${tailoredCount} tailored)`)
            : samples.length > 1
              ? mode === "merge"
                ? ` · merged into the tree all ${samples.length} files follow` +
                  (tailoringKept ? `; ${tailoringKept === 1 ? "the file" : `the ${tailoringKept} files`} tailored to it keep${tailoringKept === 1 ? "s its" : " their"} tailoring` : "")
                : ` · applied to all ${samples.length} files`
              : "") +
          (tailoredCount !== null ? "" : mode === "merge" ? " · existing strategy retained" : " · current strategy replaced") +
          (comp.target === true
            ? (pendingImport.externalSpillover?.source === "supplied"
                ? ` · compensation enabled with the matrix from ${pendingImport.externalSpillover.label}`
                : pendingImport.missingMatrix?.useFcs
                  ? " · compensation enabled with this FCS file's own matrix, chosen in place of the one the gates were drawn under"
                  : " · FCS compensation enabled") + layerNote
            : "") +
          (comp.target === false ? ` · compensation disabled${layerNote}` : "") +
          (siblings.filter((tree) => tree.sampleId && tree.compensation?.target === true).length
            ? ` · compensation applied to ${siblings.filter((tree) => tree.sampleId && tree.compensation?.target === true).length} further file(s)`
            : "") +
          // Files, named as files: this sat under a tree heading, as though they were trees.
          (siblings.length && mode === "merge"
            ? ` · only ${pendingImport.primaryFileName ?? fileName}'s tree was merged; the trees of ${siblings.map((tree) => tree.fileName ?? tree.name).join(", ")} were not imported`
            : notImported.length
              ? ` · the trees of ${notImported.join(", ")} were not imported: ${notImported.length === 1 ? "that file is" : "those files are"} not loaded`
              : "") +
          (res.skipped_channels.length
            ? ` · skipped channels: ${res.skipped_channels.join(", ")}`
            : "") +
          (res.warnings.length ? ` · ${res.warnings.length} population${res.warnings.length === 1 ? "" : "s"} not imported, each named in the warning` : "") +
          cytobankSummary +
          pendingImport.sourceNote,
      );
      // What FlowJo counted, where this import came from a FlowJo workspace; none otherwise, so a
      // later import of another kind does not leave an earlier one's counts to be compared.
      setFlowJoReferences(pendingImport.flowJoReferences ?? []);
    } catch (e) {
      if (!committed) {
        for (const t0 of touched.reverse()) t0.sample.restoreSpillover(t0.snapshot);
        if (touched.length) {
          setXRange(null);
          setYRange(null);
        }
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      gatingImportBusyRef.current = false;
      setGatingImportBusy(false);
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

  /**
   * The files a FlowJo export writes, each with the tree it is gated under: the live tree for
   * files on the active hierarchy, the parked one for the rest. A file whose hierarchy has no
   * root yet is left out and named.
   */
  function flowJoExportSamples(scope: FlowJoExportScope): FlowJoExportSample[] {
    const entries = scope === "checked" ? checkedSamples : samples;
    const out: FlowJoExportSample[] = [];
    for (const entry of entries) {
      const hid = hierarchyOfFile(entry.id);
      const tree = hid === state.active_hierarchy_id
        ? { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id }
        : (() => {
            const h = state.stored_hierarchies[hid];
            return h ? { gates: h.gates, gate_order: h.gate_order, populations: h.populations, root_population_id: h.root_population_id } : null;
          })();
      if (!tree || !tree.root_population_id) {
        throw new Error(`${entry.name} is gated under a hierarchy that has no tree; nothing to write for it.`);
      }
      out.push({ sample: entry.sample, fileName: entry.name, ...tree, root_population_id: tree.root_population_id });
    }
    return out;
  }

  /** The name a FlowJo export of these files is written under, without ".wsp". */
  function flowJoExportStem(fileNames: readonly string[]): string {
    const base = sanitizeFilePart((fileNames.length === 1 ? fileNames[0] : (fileName || "gates")).replace(/\.[^.]+$/, ""));
    return fileNames.length === 1 ? base : `${base}_and_${fileNames.length - 1}_more`;
  }

  /**
   * Where each file of a FlowJo export goes when it is written as a folder, in the order
   * flowJoExportSamples lists them. The folder and the .wsp take the export's name as Chrome
   * writes it (writableName), as the files do.
   */
  function flowJoFolderPlan(scope: FlowJoExportScope) {
    const entries = scope === "checked" ? checkedSamples : samples;
    const stem = writableName(flowJoExportStem(entries.map((entry) => entry.name)));
    return { stem, plan: planFlowJoFolder(entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })), `${stem}.wsp`) };
  }

  /** GateLab's groups, as the FlowJo export writes them: each names its files by name. */
  function flowJoExportGroups(): { name: string; fileNames: string[] }[] {
    const nameOf = new Map(samples.map((entry) => [entry.id, entry.name]));
    return state.groups.map((group) => ({
      name: group.name,
      fileNames: Object.entries(state.file_groups).filter(([, gid]) => gid === group.id).map(([fileId]) => nameOf.get(fileId) ?? "").filter(Boolean),
    }));
  }

  async function exportFlowJo(scope: FlowJoExportScope, asFolder = false) {
    try {
      const wanted = flowJoExportSamples(scope);
      const groups = flowJoExportGroups();
      if (!asFolder) {
        const { xml } = exportFlowJoWorkspace({ samples: wanted, producer: "GateLab", groups });
        downloadText(`${flowJoExportStem(wanted.map((w) => w.fileName))}.wsp`, xml, "application/xml");
        setError(null);
        return;
      }
      await exportFlowJoFolder(scope, wanted, groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * The viewed file's tree written back into the FACSChorus experiment it came from (or one the
   * user picks), as a new .cef for Chorus to import as an experiment. The source is replaced only
   * in its live gates; the digest is copied, Chorus being the judge of it.
   */
  async function exportChorusFile(): Promise<void> {
    if (!sample || state.root_population_id === null) return;
    let source = chorusSource;
    if (!source) {
      const picked = await pickFiles({ "application/zip": [".cef"] }, "FACSChorus experiment");
      const file = picked?.[0];
      if (!file) return;
      source = { name: file.name, bytes: new Uint8Array(await file.file.arrayBuffer()) };
      setChorusSource(source);
    }
    setError(null);
    try {
      const result = exportChorusExperiment({
        source: source.bytes,
        channels: sample.channels.map((c) => ({ key: c.key, pnn: c.pnn })),
        keywords: sample.fcs.keywords,
        gates: state.gates,
        populations: state.populations,
        root_population_id: state.root_population_id,
      });
      const stem = source.name.replace(/\.cef$/i, "");
      const name = `${stem} (GateLab).cef`;
      downloadBlob(name, new Blob([result.bytes as BlobPart], { type: "application/zip" }));
      const left = result.skipped.length ? ` · ${result.skipped.length} population${result.skipped.length === 1 ? "" : "s"} left out` : "";
      setImportMsg(`Saved ${name}: ${result.written} gate${result.written === 1 ? "" : "s"} written into the experiment${left}. Import it in FACSChorus as an experiment.`);
      if (result.warnings.length) setError(result.warnings.join("\n"));
    } catch (cause) {
      setError(`FACSChorus export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /**
   * The workspace and the FCS files it names, as a self-contained folder: every file the bytes
   * GateLab loaded, under its own name beside the .wsp (or, where Chrome will not write that name,
   * the one the dialog listed), which names it by its path there (flowjoExportFolder.ts). Written
   * into a new folder where the browser can write one, one file at a time and the .wsp last;
   * otherwise downloaded as one stored .zip.
   */
  async function exportFlowJoFolder(
    scope: FlowJoExportScope,
    wanted: FlowJoExportSample[],
    groups: { name: string; fileNames: string[] }[],
  ): Promise<void> {
    const { stem, plan } = flowJoFolderPlan(scope);
    if (plan.files.length !== wanted.length) throw new Error("The files to export changed while the export was being prepared; export again.");
    // Asked for first, while the click still counts as the user's: evaluating every population
    // of every file below can outlast the time a browser allows a picker to open after a click.
    const directory = supportsDirectoryAccess();
    const parent = directory ? await pickWritableDirectory() : null;
    if (directory && !parent) return;
    setBusy(true);
    setError(null);
    try {
      setImportMsg(`Writing ${stem} · evaluating the workspace`);
      // Let the message paint before the evaluation holds the thread.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const { xml } = exportFlowJoWorkspace({
        samples: wanted.map((sample, i) => ({ ...sample, folderPath: plan.files[i].path })),
        producer: "GateLab",
        groups,
      });
      const missing = plan.files.filter((f) => !f.bytes).map((f) => f.name);
      const written = plan.files.length - missing.length;
      const renamed = plan.files.filter((f) => f.bytes && f.renamed.length).length;
      const notes =
        (renamed ? ` · ${renamed} written under another name, as the dialog listed` : "") +
        (missing.length ? ` · not in it, GateLab holding no bytes for ${missing.length === 1 ? "it" : "them"}: ${missing.join(", ")}` : "");
      if (parent) {
        const { folder } = await writeFlowJoFolder(parent, stem, plan, xml, {
          onProgress: (n, total, path) => setImportMsg(`Writing ${stem} · FCS file ${n} of ${total} · ${path}`),
        });
        // The next picker starts in the new folder, where the user last saved, as every picker
        // does. The folder the user granted for their data is left as it was: GateLab reads it
        // again without asking to find the FCS a .wsp from there names (lastGrantedDirectory).
        rememberPickerLocation(folder);
        setImportMsg(
          `Wrote ${folder.name} in ${parent.name}: ${plan.workspaceName} and ${written} FCS file${written === 1 ? "" : "s"}, ` +
            `${formatByteSize(plan.fcsBytes)}${notes}`,
        );
      } else {
        // Views of the bytes GateLab holds and fflate's headers: the Blob is the archive's one copy.
        const parts: Uint8Array[] = [];
        let size = 0;
        await writeFlowJoZip(stem, plan, xml, (chunk) => {
          parts.push(chunk);
          size += chunk.byteLength;
        }, ({ writtenPayloadBytes, totalPayloadBytes }) => {
          setImportMsg(`Writing ${stem}.zip · ${totalPayloadBytes === 0 ? 100 : Math.round(writtenPayloadBytes / totalPayloadBytes * 100)}%`);
        });
        downloadBlob(`${stem}.zip`, new Blob(parts as BlobPart[], { type: "application/zip" }));
        setImportMsg(
          `Saved ${stem}.zip, stored uncompressed: ${plan.workspaceName} and ${written} FCS file${written === 1 ? "" : "s"}, ` +
            `${formatByteSize(size)}${notes}`,
        );
      }
    } catch (e) {
      // The error says where it stopped; the progress line would say it was still writing.
      setImportMsg(null);
      throw e;
    } finally {
      setBusy(false);
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
      // Every checked file, whichever tree it follows: the dialog lists them all as sources, and
      // each is gated under its own tree below.
      const scopedEntries = scope === "active" ? [activeEntry] : checkedSamples;
      if (scopedEntries.length === 0) {
        setError("No checked FCS files are available for this export scope.");
        return false;
      }
      const splitThreshold = Math.max(0, Math.floor(minimumEvents));
      // Each file is gated under the tree it follows. A file tailored against the tree, or one
      // in a group, has its own copy with its own population ids, so the dialog's ids (the live
      // tree's) are mapped to the copy's by provenance before a mask or a count is read.
      const exportDerived = new Map<string, Derived>();
      for (const entry of scopedEntries) {
        const tree = treeStateForFile(entry.id);
        if (!tree) throw new Error(`Cannot export ${entry.name}: the tree it follows is missing.`);
        exportDerived.set(
          entry.id,
          tree.live && entry.id === activeSampleId ? derived : recompute(entry.sample, tree.treeState),
        );
      }
      const popCountFor = (entry: SampleEntry, popId: string): number | null | undefined => {
        const ownId = populationIdInFileTree(entry.id, popId);
        return ownId ? exportDerived.get(entry.id)?.stats.event_count[ownId] : undefined;
      };
      const popMaskFor = (entry: SampleEntry, popId: string): Uint8Array => {
        const ownId = populationIdInFileTree(entry.id, popId);
        const mask = ownId ? exportDerived.get(entry.id)?.masks[ownId] : undefined;
        if (!mask) {
          const name = state.populations[popId]?.name ?? popId;
          throw new Error(ownId
            ? `Cannot export ${name}: no population mask is available for ${entry.name}.`
            : `Cannot export ${name}: the tree ${entry.name} follows has no such population.`);
        }
        return mask;
      };
      const popNameOf = (popId: string) => sanitizeFilePart(state.populations[popId]?.name ?? "population");

      // The file(s) produced for ONE population under the current sample scope.
      const filesForPop = (popId: string): Record<string, Uint8Array> => {
        const popName = popNameOf(popId);
        const out: Record<string, Uint8Array> = {};
        // A population created from a barcode scheme carries the output file name the sheet
        // asked for; it names the export of the single-sample and combined scopes.
        const schemeFile = populationMetadata[popId]?.file_name?.trim();
        const schemeStem = schemeFile ? sanitizeFilePart(schemeFile.replace(/\.fcs$/i, "")) : null;
        if (scope === "combined") {
          const items = scopedEntries.map((e) => ({
            sample: e.sample,
            name: e.name,
            mask: popMaskFor(e, popId),
          }));
          out[schemeStem ? `${schemeStem}.fcs` : `combined_${popName}.fcs`] = exportPopulationFcsCombined(items, assay);
        } else if (scope === "split") {
          for (const e of scopedEntries) {
            if (!passesPopulationFcsExportThreshold(popCountFor(e, popId), splitThreshold)) continue;
            // Two checked files can share a name, or sanitise to the same one ("a b.fcs" and
            // "a_b.fcs"); assigned into the object, the later file silently replaced the earlier.
            // Named as the active file's export is: the file's name without its extension.
            mergeExportFiles(out, {
              [sanitizeFcsName(null, e.name.replace(/\.[^.]+$/, ""), popName, null)]:
                exportPopulationFcs(e.sample, popMaskFor(e, popId), assay),
            });
          }
        } else {
          const base = sanitizeFilePart((activeEntry.name || "sample").replace(/\.[^.]+$/, ""));
          out[schemeStem ? `${schemeStem}.fcs` : `${base}_${popName}.fcs`] =
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
      checkedSamples.map((entry) => ({ sample: entry.sample, name: entry.name })),
    ),
    [checkedSamples, sampleDataRevisionKey, panelVersion],
  );

  /**
   * Draw every hosted sample from another of the SCE's assays. The samples are rebuilt from that
   * assay's values and keep their ids, settings and instrument mode, so the tree, the gates and
   * the selection stay and the gates are evaluated on the new values; the axis ranges are fitted
   * again, since one assay's are not another's. Compensated layers are linear values beside
   * counts: drawing a display assay sets them aside with their bindings, and drawing a linear
   * assay again installs them from the object.
   */
  async function switchHostedAssay(assayId: string): Promise<void> {
    if (!isSceHost || !host.datasets || !hostDatasetDescriptor || assayId === hostDrawnAssayId) return;
    const assay = hostDatasetDescriptor.assays.find((candidate) => candidate.id === assayId);
    if (!assay) {
      setError(t("The SCE has no assay '{assay}'.", { assay: assayId }));
      return;
    }
    if (!drawableHostedAssay(assay)) {
      setError(t("{assay} cannot be drawn: it is in display space and the object states no arcsinh cofactor for it.", { assay: assay.id }));
      return;
    }
    setBusy(true);
    setImportMsg(t("Drawing {assay}…", { assay: assay.id }));
    try {
      await checkpointCurrentWorkspace("before-hosted-assay-change");
      const hostedSamples = await loadHostedDataset(host.datasets, hostDatasetDescriptor, undefined, assay.id);
      const byId = new Map(hostedSamples.map((hosted) => [`${hosted.datasetId}:${hosted.sampleId}`, hosted]));
      cancelCompensationSweepManagers(t("The drawn assay changed."));
      cancelCompensationCandidatePreview(t("The drawn assay changed."));
      const manager = compensationManagerRef.current!;
      const carried = hostedCompensationBindingsRef.current;
      const next = samples.map((entry) => {
        const hosted = byId.get(entry.id);
        if (!hosted || !entry.hostSource) return entry;
        const from = entry.sample;
        const to = hosted.sample;
        // The settings a sample holds, carried over: the instrument mode, the panel's labels,
        // the scatter and fluorescence scales; the cofactor too, where it is a setting and not
        // the drawn assay's own.
        to.setInstrumentMode(from.instrumentMode);
        to.applyLabelOverrides(from.labelOverrides());
        to.applyScatterLinearKeys(from.scatterLinearKeys());
        for (const [key, cofactor] of Object.entries(from.scatterCofactorOverrides())) {
          const index = to.index(key);
          if (index !== undefined) to.setScatterCofactor(index, cofactor);
        }
        if (to.hostedAssaySpace !== "display") {
          to.applyFluorArcsinhKeys(from.fluorArcsinhKeys());
          to.setCytofCofactor(from.arcsinhCofactor);
        }
        const status = from.compensatedLayerStatus();
        if (status.state !== "missing" && status.metadata.runtimeIdentity === "profile") {
          const { runtimeIdentity: _runtimeIdentity, ...persisted } = status.metadata;
          carried.set(entry.id, { schema: SAMPLE_ASSAY_BINDING_SCHEMA, activeLayer: from.activeLayer, compensatedLayer: persisted });
        }
        manager.invalidateSample(from);
        return {
          ...entry,
          sample: to,
          hostSource: { ...entry.hostSource, assayId: hosted.assayId, assayRevision: hosted.assayRevision },
        };
      });
      setSamples(next);
      setHostDrawnAssayId(assay.id);
      const viewed = next.find((entry) => entry.id === activeSampleId)?.sample;
      if (viewed) setInstrumentMode(viewed.instrumentMode);
      setXRange(null);
      setYRange(null);
      markWorkspaceDirty();
      setImportMsg(assay.coordinateSpace === "display"
        ? t("Drawing {assay} as stored", { assay: assay.id })
        : t("Drawing {assay}", { assay: assay.id }));
      if (assay.coordinateSpace !== "display" && carried.size > 0) {
        await restoreCompensationBindings(
          workspaceCompensation.lineages,
          next.map((entry) => carried.get(entry.id) ?? null),
          next,
        );
        hostedCompensationBindingsRef.current = new Map();
      }
    } catch (cause) {
      setImportMsg(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleCompensation(on: boolean): boolean {
    if (!sample) return false;
    if (on && sample.hostedAssaySpace === "display") {
      setError(t("Choose {linear} in the header to use a compensated layer: {assay} is drawn as stored.", {
        linear: hostDatasetDescriptor && hasLinearHostedAssay(hostDatasetDescriptor) ? linearHostedAssay(hostDatasetDescriptor).id : t("the linear assay"),
        assay: sample.hostedAssayId ?? "",
      }));
      return false;
    }
    const previousLayer = sample.activeLayer;
    try {
      // saveWorkspaceCheckpoint clones the workspace synchronously, so this captures the
      // pre-switch assay binding even though IndexedDB persistence finishes asynchronously.
      void checkpointCurrentWorkspace("before-active-layer-change").catch(reportCheckpointRefusal);
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

  /**
   * Uninstall the active sample's matrix. Every file carrying that profile's layer returns to
   * Original in one step, the profile's lineage leaves the workspace, and the axes re-fit: the
   * "return to no matrix" the tab offers next to the installed-profile pill.
   */
  async function removeCompensationProfile(): Promise<void> {
    if (!sample) throw new Error(t("No active sample is available for compensation."));
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      const message = t("Compensation is already running. Follow or cancel the current job in the status bar before starting another Apply.");
      setError(message);
      throw new Error(message);
    }
    const status = sample.compensatedLayerStatus();
    if (status.state === "missing" || status.metadata.runtimeIdentity !== "profile") return;
    const profileId = status.metadata.profileId;
    const record = findCompensationProfile(workspaceCompensation, profileId);
    cancelCompensationSweepManagers("The compensation matrix was removed.");
    cancelCompensationCandidatePreview("The compensation matrix was removed.");
    await checkpointCurrentWorkspace("before-compensation-remove");
    for (const entry of samples) {
      const entryStatus = entry.sample.compensatedLayerStatus();
      if (
        entryStatus.state !== "missing" &&
        entryStatus.metadata.runtimeIdentity === "profile" &&
        entryStatus.metadata.profileId === profileId
      ) entry.sample.removeCompensatedLayer();
    }
    manager.invalidateProfile(profileId);
    const baselineId = record?.baselineProfileId ?? profileId;
    setWorkspaceCompensation((current) => ({
      ...current,
      lineages: current.lineages.filter(({ baselineProfileId, records }) =>
        baselineProfileId !== baselineId && !records.some((candidate) => candidate.profileId === profileId)),
    }));
    setXRange(null);
    setYRange(null);
    setError(null);
    setImportMsg(t("Compensation matrix removed · original assay active"));
    markWorkspaceDirty();
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
    // The solver reads the linear counts, and a compensated layer belongs beside them: the linear
    // assay has to be drawn to compensate.
    if (isSceHost && sample.hostedAssaySpace === "display") {
      throw new Error(t("{assay} is drawn as stored, already transformed. Compensation applies to {linear}: choose it in the header first.", {
        assay: sample.hostedAssayId ?? "",
        linear: hostDatasetDescriptor ? linearHostedAssay(hostDatasetDescriptor).id : t("the linear assay"),
      }));
    }
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
      ? checkedSamples
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
      // A workspace keeps one kind of compensation: beside this profile, a file still drawing
      // from its FCS's embedded matrix cannot be written (buildWorkspaceFile refuses the mix).
      // Those files go back to Original here, by name, so installing a matrix never leaves a
      // workspace that cannot be saved or checkpointed.
      const returned = returnEmbeddedLayersToOriginal();
      if (returned.length > 0) {
        setError(t(
          "{files} drew from their own embedded matrix and returned to Original: a workspace keeps one kind of compensation. Their gates now read uncompensated values; to compensate one again, view it and enable matrix editing there.",
          { files: returned.join(", ") },
        ));
      }
      queueCheckpoint("after-compensation-apply");
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

  /** The files that draw from their FCS's embedded matrix rather than from an installed profile. */
  function embeddedLayerEntries() {
    return samples.filter((entry) => {
      const layer = entry.sample.compensatedLayerStatus();
      return layer.state !== "missing" && layer.metadata.runtimeIdentity !== "profile";
    });
  }

  /** Every such file goes back to Original; their names are returned, for the message. */
  function returnEmbeddedLayersToOriginal(): string[] {
    const entries = embeddedLayerEntries();
    for (const entry of entries) entry.sample.setCompensation(false);
    if (entries.length > 0) markWorkspaceDirty();
    return entries.map((entry) => entry.name);
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
  function restoreWorkspaceTransforms(entries: readonly SampleEntry[], workspace: LiveWorkspaceFile, activeIndex: number): void {
    // Commit only once loading/validation has succeeded. Do not render saved ranges under the
    // previous workspace's transforms, or let old samples contribute to the new auto scales.
    for (const detach of attachedScales.current.values()) detach();
    attachedScales.current.clear();
    restoreChannelScales(channelScales, entries.map(entry => entry.sample), workspace.samples, activeIndex);
    for (const { sample } of entries) {
      attachedScales.current.set(sample, sample.attachChannelScales(channelScales));
    }
  }

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
  /**
   * How channels are named on axes and pickers, app-wide.
   *
   * A file whose $PnS is "CD19" resolves to the identity key "CD19", so the detector never
   * appears even though $PnN still holds it. Purely cosmetic: identity, gates and compensation
   * all key off the channel key, so switching this cannot move an event.
   */
  const [channelLabelMode, setChannelLabelMode] = useState<ChannelLabelMode>(() => {
    try {
      return localStorage.getItem("gatelab.channelLabelMode") === "channel-marker"
        ? "channel-marker" : "marker";
    } catch { return "marker"; }
  });
  useEffect(() => {
    try { localStorage.setItem("gatelab.channelLabelMode", channelLabelMode); } catch { /* private mode */ }
    // Every loaded sample, not just the active one: the setting is app-wide and a file loaded
    // later must adopt it too (see the effect below).
    for (const entry of samples) entry.sample.setChannelLabelMode(channelLabelMode);
    setPanelVersion((v) => v + 1);
  }, [channelLabelMode, samples]);

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

  // Arcsinh cofactor, committed the same way and for the same reason as the logicle W above.
  //
  // The slider runs over LOG10 of the cofactor: it is useful from single digits (old 10-bit
  // data) to tens of thousands (spectral data reaching 10M), and a linear slider over that
  // span would put every value a cytometrist actually wants inside its first pixel. Values are
  // rounded to three significant figures so the number under the slider is exactly the number
  // in force, not a rounded view of a longer one.
  const [pendingFluorCofactor, setPendingFluorCofactor] = useState<Record<string, number>>({});
  const fluorCofactorJob = useRef<{ idx: number; cofactor: number; key: string } | null>(null);
  const fluorCofactorFrame = useRef<number | null>(null);

  useEffect(() => () => {
    if (fluorCofactorFrame.current !== null) cancelAnimationFrame(fluorCofactorFrame.current);
  }, []);

  const commitFluorCofactor = (idx: number, cofactor: number) => {
    const key = sample?.channels[idx]?.key;
    if (!key) return;
    fluorCofactorJob.current = { idx, cofactor, key };
    setPendingFluorCofactor((prev) => ({ ...prev, [key]: cofactor })); // echo the drag immediately
    if (fluorCofactorFrame.current !== null) return;
    fluorCofactorFrame.current = requestAnimationFrame(() => {
      fluorCofactorFrame.current = null;
      const job = fluorCofactorJob.current;
      fluorCofactorJob.current = null;
      if (!job || !sample) return;
      sample.setFluorCofactor(job.idx, job.cofactor);
      // The visible range is in asinh display units, which move with the cofactor: without a
      // refit the data walks off the axis as the slider is dragged.
      pendingScaleRefit.current = true;
      bumpScales();
      setPendingFluorCofactor((prev) => {
        const next = { ...prev };
        delete next[job.key];
        return next;
      });
    });
  };

  const setGlobalScale = useCallback((key: string, range: [number, number] | null) => {
    if (activeAxisScaleContextKey) {
      // An edit in the range strip or Scales tab pins this channel in the current scope. The old
      // channel-only marker made a manual edit look auto-fitted after switching files.
      autoFittedScales.current.delete(autoFittedScaleKey(activeAxisScaleContextKey, key));
      // Clearing a range means "fit this channel again", so its plots are unmarked and the fit
      // effect refits them from the active file into the current scope. Left marked, nothing
      // refitted and the view fell back to each file's own automatic range: under the lock the
      // files stopped sharing a frame the moment one channel was reset.
      if (range === null) {
        for (const pair of [...fittedAxisPairs.current]) {
          try {
            const [context, pairX, pairY] = JSON.parse(pair) as [string, string, string];
            if (context === activeAxisScaleContextKey && (pairX === key || pairY === key)) fittedAxisPairs.current.delete(pair);
          } catch {
            fittedAxisPairs.current.delete(pair);
          }
        }
      }
    }
    setGlobalScales((prev) => {
      const next = { ...prev };
      if (range) next[key] = range;
      else delete next[key];
      return next;
    });
  }, [activeAxisScaleContextKey, setGlobalScales]);

  const toggleScaleLock = useCallback(() => {
    const nextLocked = !lockScalesBetweenFiles;
    if (nextLocked) {
      const lockedContext = axisScaleContextKey(
        activeSampleId,
        activeWorkspaceScaleContextKey,
        activeLockedScaleContextKey,
        true,
      );
      // Entering comparison mode freezes exactly the frame on screen. A prior comparison frame
      // is deliberately replaced; the button means "lock these scales now".
      if (lockedContext) preserveScalesForContext(lockedContext);
    }
    setLockScalesBetweenFiles(nextLocked);
    setXRange(null);
    setYRange(null);
    markWorkspaceDirty();
  }, [
    lockScalesBetweenFiles,
    activeSampleId,
    activeWorkspaceScaleContextKey,
    activeLockedScaleContextKey,
    preserveScalesForContext,
    markWorkspaceDirty,
  ]);

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
      queueCheckpoint("after-metadata-import");
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
      noteHostCategoricalColumn(columnName, levels.length);
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
      for (const { columnName } of result.columns) {
        noteHostCategoricalColumn(
          columnName,
          columns.find((column) => column.columnName === columnName)?.levels.length ?? 0,
        );
      }
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
    /** For a file holding several data sets: which one this sample is. */
    dataSet?: number,
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
      sample: new Sample(dataSet === undefined ? parseFcs(ab) : parseFcs(ab, { dataSet })),
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
      pendingFitOnLoad.current = null;
      setLockScalesBetweenFiles(false);
      setScaleCacheEpoch((epoch) => epoch + 1);
      setGlobalScales({});
      channelScales.clear();
      autoFittedScales.current.clear();
      fittedAxisPairs.current.clear();
      setWsHandle(null);
      setWsName("");
      setWsStorage("reference");
    }
    queueCheckpoint("after-fcs-import");
    skipDirtyRef.current = true;
    const activeEntry = entries[entries.length - 1];
    const [nx, ny] = channelsFor(activeEntry.sample);
    setSamples((prev) => [...prev, ...entries]);
    if (!poolSelection) {
      setActiveSampleId(activeEntry.id);
      setXIdx(nx);
      setYIdx(ny);
      setXRange(null);
      setYRange(null);
      setInstrumentMode(activeEntry.sample.instrumentMode); // fresh sample → "auto"
    }
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
        // The assay to draw: the one the saved workspace was drawn from, so its gates and ranges
        // meet the values they were made on; a hosted workspace saved before an assay could be
        // chosen was drawn from the linear assay; with no workspace, the host's default.
        const workspaceEnvelope = await host.workspaces?.readWorkspace(dataset.id) ?? null;
        const savedAssayId = workspaceEnvelope ? hostedAssayIdOf(workspaceEnvelope.workspaceJson) : undefined;
        const savedAssay = savedAssayId ? dataset.assays.find(({ id }) => id === savedAssayId) : undefined;
        const linear = hasLinearHostedAssay(dataset) ? linearHostedAssay(dataset) : null;
        // A GateLab workspace saved before an assay could be chosen was drawn from the linear
        // assay; a workspace of the legacy GateLabR format was gated in R, on exprs.
        const fromLinear = workspaceEnvelope !== null && workspaceEnvelope.sourceFormat !== "gatelabr-legacy" && linear !== null;
        let drawnAssay = (savedAssay && drawableHostedAssay(savedAssay) ? savedAssay : undefined)
          ?? (fromLinear ? linear! : chooseHostedAssay(dataset));
        let drawnAssayNote = savedAssayId && drawnAssay.id !== savedAssayId
          ? ` · ${t("the saved workspace was drawn from {assay}, which the SCE no longer has or cannot be drawn; drawing {drawn}", { assay: savedAssayId, drawn: drawnAssay.id })}`
          : "";
        let hostedSamples: GateLabHostedSample[];
        try {
          hostedSamples = await loadHostedDataset(host.datasets!, dataset, controller.signal, drawnAssay.id);
        } catch (cause) {
          // Declared display-space by its name but holding no arcsinh: drawn from the linear
          // assay instead, and the message says what to declare.
          if (!(cause instanceof HostedAssayNotArcsinhError) || !linear || linear.id === drawnAssay.id) throw cause;
          drawnAssayNote += ` · ${cause.message}`;
          drawnAssay = linear;
          hostedSamples = await loadHostedDataset(host.datasets!, dataset, controller.signal, linear.id);
        }
        if (controller.signal.aborted) return;
        setHostDrawnAssayId(drawnAssay.id);
        if (hostedSamples.length === 0) {
          throw new Error(`SingleCellExperiment '${dataset.label}' has no samples.`);
        }
        setHostColDataColumns(dataset.colDataColumns ?? []);
        setHostCategoricalColumns(dataset.colDataCategorical ?? []);
        setHostCategoricalValues({});
        hostCategoricalLoadingRef.current.clear();
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
        // Mass cytometry is gated on the pooled samples, so an SCE of it opens pooled.
        setPoolSelection(dataset.instrument === "cytof");

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
          `${dataset.eventCount.toLocaleString()} events from R` +
          ` · ${drawnAssay.coordinateSpace === "display"
            ? t("drawing {assay} as stored", { assay: drawnAssay.id })
            : t("drawing {assay}", { assay: drawnAssay.id })}` +
          (drawnAssay.coordinateSpace === "display" && drawnAssay.displayCofactorStated === false
            ? ` (${t("arcsinh cofactor {cofactor} assumed: the object records none", { cofactor: drawnAssay.displayCofactor ?? 5 })})`
            : "") +
          drawnAssayNote;

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
            const restoredScaleLock = workspace.scales.lockBetweenFiles !== false;
            const restoredScaleMaps = restoredAxisScaleMaps(
              workspace.scales,
              entries,
              activeIdx,
              restoredScaleLock,
            );
            const restoredScaleContext = axisScaleContextKey(
              entries[activeIdx].id,
              active.workspaceScaleContextKey,
              active.lockedScaleContextKey,
              restoredScaleLock,
            );
            if (restoredScaleContext) {
              pendingFitOnLoad.current = {
                contextKey: restoredScaleContext,
                ranges: restoredScaleMaps.get(restoredScaleContext) ?? {},
              };
            }
            replaceScalesForNextNamespace(restoredScaleMaps);
            const nextWorkspaceId = workspace.workspaceId ?? makeWorkspaceId();
            compensationManagerRef.current!.resetWorkspace(nextWorkspaceId);
            queueCheckpoint("after-workspace-open");
            skipDirtyRef.current = true;
            if (workspace.version === WORKSPACE_VERSION_3) {
              // A compensated layer holds linear values beside counts: while an assay is drawn
              // as stored the layers are not installed, and their bindings are carried in every
              // save until a linear assay is drawn again.
              if (drawnAssay.coordinateSpace === "display") {
                hostedCompensationBindingsRef.current = new Map(workspace.samples.flatMap((workspaceSample, index) =>
                  workspaceSample.assay.compensatedLayer && entries[index]
                    ? [[entries[index].id, workspaceSample.assay] as const]
                    : []));
              } else {
                hostedCompensationBindingsRef.current = new Map();
                await restoreSavedWorkspaceCompensation(workspace, entries);
              }
              setWorkspaceCompensation(workspace.compensation);
            } else {
              setWorkspaceCompensation(newEmptyWorkspaceCompensationState());
            }
            restoreWorkspaceTransforms(entries, workspace, activeIdx);
            setActiveSampleId(entries[activeIdx].id);
            setPopulationMetadata(workspace.populationMetadata ?? {});
            setPopulationMetaColumns(workspace.populationMetaColumns ?? []);
            illustConfigRef.current = workspace.illustration ?? null;
            strategyConfigRef.current = workspace.strategy ?? null;
            setIllustrationPresets(workspace.illustrationPresets ?? []);
            setIllustVersion((version) => version + 1);
            clearPersistedTabState();
            restorePlottingState(workspace.plotting);
            setLockScalesBetweenFiles(restoredScaleLock);
            setScaleCacheEpoch((epoch) => epoch + 1);
            setInstrumentMode(active.instrumentMode);
            setMode(workspace.display.mode);
            setMaxEvents(workspace.display.maxEvents);
            setContourThreshold(workspace.display.contourThreshold);
            setContourLevels(workspace.display.contourLevels ?? 10);
            setDensityColorPower(
              normalizeDensityColorPower(workspace.display.densityColorPower),
            );
            setBranchGatesOnly(
              (workspace.display as { branchGatesOnly?: boolean }).branchGatesOnly !== false);
            setShowUnownedGates(
              (workspace.display as { showUnownedGates?: boolean }).showUnownedGates !== false);
            setPointAlpha(restoredPointAlpha(workspace.display.pointAlpha));
            setPointSize(restoredPointSize(workspace.display.pointSize));
            setGatingFontSizes({
              ...DEFAULT_GATING_FONT_SIZES,
              ...workspace.display.fontSizes,
            });
            const [defaultX, defaultY] = active.defaultChannelIndices();
            setXIdx(active.index(workspace.display.xChannel) ?? defaultX);
            setYIdx(active.index(workspace.display.yChannel) ?? defaultY);
            setXRange(null);
            setYRange(null);
            setWsHandle(null);
            setWsName(dataset.label);
            setWsStorage("reference");
            setWorkspaceId(nextWorkspaceId);
            setDirty(false);
            // The SCE's sample order is the workspace's; a count mismatch means the samples
            // changed under the workspace, and no assignment is safer than a shifted one.
            const hostedFileHierarchies = workspace.samples.length === entries.length
              ? Object.fromEntries(workspace.samples.flatMap((wss, i) => (wss.hierarchyId ? [[entries[i].id, wss.hierarchyId]] : [])))
              : {};
            const hostedFileGroups = workspace.samples.length === entries.length
              ? Object.fromEntries(workspace.samples.flatMap((wss, i) => (wss.groupId ? [[entries[i].id, wss.groupId]] : [])))
              : {};
            dispatch({
              type: "loadWorkspace",
              gates: workspace.gating.gates,
              gate_order: workspace.gating.gate_order,
              populations: workspace.gating.populations,
              root_population_id: workspace.gating.root_population_id,
              active_population_id: workspace.gating.active_population_id,
              selected_gate_id: workspace.gating.selected_gate_id,
              // The SCE holds the whole workspace file, parked hierarchies included; restoring
              // only the active tree would drop them on every reload in GateLabR.
              hierarchies: workspace.gating.hierarchies,
              active_hierarchy_id: workspace.gating.active_hierarchy_id,
              stored_hierarchies: workspace.gating.stored_hierarchies?.map(
                (h) => restoreStoredHierarchy(h, workspace.gating.gates)),
              // A workspace saved with per-file hierarchies off meant every file on the first tree.
              file_hierarchies: workspace.gating.perFileHierarchies === true ? hostedFileHierarchies : {},
              groups: workspace.gating.groups ?? [],
              file_groups: hostedFileGroups,
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

  /** A plain click replaces the selection; a pool follows it, and otherwise the file is viewed. */
  function selectOnlySample(id: string): void {
    if (!samples.some((s) => s.id === id)) return;
    setExcludedSampleIds(new Set(samples.filter((e) => e.id !== id).map((e) => e.id)));
    if (!poolSelection) inspectSample(id);
  }

  function selectSample(id: string, options?: { keepTree?: boolean }) {
    const entry = samples.find((s) => s.id === id);
    if (!entry || id === activeSampleId) return;
    const [nx, ny] = channelsFor(entry.sample);
    // The dirty-tracking effect consumes this flag when the axes or the instrument mode change.
    // Set when they would not, it lingered until the next real edit, which then went unmarked.
    if (nx !== xIdx || ny !== yIdx || entry.sample.instrumentMode !== instrumentMode) skipDirtyRef.current = true;
    setActiveSampleId(id);
    // The live tree follows the file according to the edit mode, in the effect beside
    // setEditTarget; keepTree is honoured there too, since a pooled view is left alone.
    void options;
    setXIdx(nx);
    setYIdx(ny);
    setInstrumentMode(entry.sample.instrumentMode);
  }

  // Removing a viewed file is the only selection-independent reason to choose another primary. A
  // pool carries on, viewed through one of its files where it has any (the effect beside
  // poolSelectedFiles).
  useEffect(() => {
    if (activeSampleId !== null && samples.some((e) => e.id === activeSampleId)) return;
    const first = samples[0]?.id ?? null;
    if (first === null) return;
    if (poolSelection) {
      if (!plotPool?.ids.length) selectSample(first, { keepTree: true });
      return;
    }
    inspectSample(first);
    // selectSample is recreated every render; the guard above is what stops this re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, activeSampleId, poolSelection, plotPool]);

  /** Plots from the Illustration tab, one Layout item each, on the current sheet. */
  /** The Gating plot as a Layout item: this file, this population, these channels, this display. */
  function addCurrentPlotToLayout(): void {
    if (!sample || !activeSampleId || !state.active_population_id) return;
    // The plot is drawn there as it is here: the display settings the sheet's style does not
    // already hold become the plot's own.
    const sheetStyle = effectiveLayoutStyle(layoutWorkspace.sheets.find((s0) => s0.id === layoutWorkspace.activeSheetId) ?? layoutWorkspace.sheets[0]);
    const own: Partial<LayoutPlotStyle> = {};
    // 0 is every event here and there alike.
    if (maxEvents !== sheetStyle.maxEvents) own.maxEvents = maxEvents;
    if (contourThreshold !== sheetStyle.contourThreshold) own.contourThreshold = contourThreshold;
    if (contourLevels !== sheetStyle.contourLevels) own.contourLevels = contourLevels;
    addPlotsToLayout([{
      kind: "biplot",
      sampleId: activeSampleId,
      populationId: state.active_population_id,
      xChannel: sample.channels[xIdx].key,
      yChannel: sample.channels[yIdx].key,
      displayMode: mode === "dots" ? "scatter" : mode,
      ...(Object.keys(own).length ? { style: own } : {}),
      // A pooled view goes as a pooled plot of the same files.
      ...(poolSelection && plotPool && plotPool.ids.length > 1 ? { pool: { sampleIds: [...plotPool.ids] } } : {}),
    }]);
    setActiveTab("layout");
  }

  /** A strategy strip, or one of its plots, from the Strategy tab as a Layout block, and the Layout tab shown. */
  function addStrategyToLayout(recipe: LayoutStrategyRecipe | LayoutPlotRecipe, size?: { width: number; height: number }): void {
    if (recipe.kind !== "strategy") {
      addPlotsToLayout([recipe]);
      setActiveTab("layout");
      return;
    }
    setLayoutWorkspace((current) => {
      const next = cloneLayoutWorkspace(current);
      const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
      if (!sheet) return current;
      // A multi-population grid is framed at the size it was drawn on the Strategy tab, so it
      // arrives as it was made; the sheet grows to show it, and its frame can be dragged smaller,
      // which scales the block as a whole.
      const frame = nextLayoutItemPosition(sheet, size?.width ?? 600, size?.height ?? 320);
      sheet.items.push({ id: crypto.randomUUID(), ...frame, recipe });
      sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
      sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
      return next;
    });
    markWorkspaceDirty();
    setActiveTab("layout");
  }

  /** A strategy step on the Gating tab: its population on its gate's channels. */
  function openStrategyStepInGating(populationId: string, xChannel: string, yChannel: string): void {
    if (!sample) return;
    if (state.populations[populationId]) dispatch({ type: "setActivePopulation", popId: populationId });
    const [fallbackX, fallbackY] = channelsFor(sample);
    setXIdx(sample.index(xChannel) ?? fallbackX);
    setYIdx(sample.index(yChannel) ?? fallbackY);
    setXRange(null);
    setYRange(null);
    setActiveTab("gating");
  }

  /** The Illustration tab's figure as one Layout block, and the Layout tab shown. */
  function addFigureToLayout(config: IllustrationConfig): void {
    setLayoutWorkspace((current) => {
      const next = cloneLayoutWorkspace(current);
      const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
      if (!sheet) return current;
      const files = samples.map(entry => ({ ...entry, fileName: entry.name, name: sampleDisplayId(entry.name, metadata[entry.id]), hierarchyId: hierarchyOfFile(entry.id), metadata: metadata[entry.id] }));
      const size = figureBlockFrame(config, files, state, sheet);
      const frame = nextLayoutItemPosition(sheet, size.width, size.height);
      sheet.items.push({ id: crypto.randomUUID(), ...frame, recipe: { kind: "figure", illustration: config, page: 0 } });
      sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
      sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
      return next;
    });
    markWorkspaceDirty();
    setActiveTab("layout");
  }

  /** The Plotting tab's chart as one Layout block, at its natural size, on the active sheet. */
  function addProportionsToLayout(settings: ProportionsSettings): void {
    const files = samples.map((entry) => ({ id: entry.id, name: entry.name, sample: entry.sample, hierarchyId: hierarchyOfFile(entry.id) }));
    const model = buildProportionsModel(settings, files, state, metadata, compatibleDivisionProfiles);
    setLayoutWorkspace((current) => {
      const next = cloneLayoutWorkspace(current);
      const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
      if (!sheet) return current;
      const size = proportionsBlockFrame(settings, model, sheet);
      const frame = nextLayoutItemPosition(sheet, size.width, size.height);
      sheet.items.push({ id: crypto.randomUUID(), ...frame, recipe: { kind: "proportions", settings } });
      sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
      sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
      return next;
    });
    markWorkspaceDirty();
    setActiveTab("layout");
  }

  /**
   * Plots on the Layout tab's current sheet. With `cells`, one per recipe, they keep the
   * arrangement they had where they came from, as a grid below what the sheet holds; without,
   * each takes the next free place on the page.
   */
  function addPlotsToLayout(recipes: LayoutPlotRecipe[], cells?: readonly LayoutGridCell[], headings?: LayoutGridHeadings): void {
    if (!recipes.length) return;
    setLayoutWorkspace((current) => {
      const next = cloneLayoutWorkspace(current);
      const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
      if (!sheet) return current;
      const frames = cells && cells.length === recipes.length ? layoutGridFrames(sheet, cells) : null;
      // Headings sit above the columns and left of the rows, so the grid moves down and right to
      // leave them room; each reads the first plot of its column or row.
      const headRoom = frames && headings?.columns.length ? 34 : 0;
      const sideRoom = frames && headings?.rows.length ? 150 : 0;
      if (frames) for (const frame of frames) { frame.y += headRoom; frame.x += sideRoom; }
      const ids: string[] = [];
      recipes.forEach((recipe, index) => {
        const frame = frames ? frames[index] : nextLayoutItemPosition(sheet);
        const id = crypto.randomUUID();
        ids.push(id);
        sheet.items.push({ id, ...frame, recipe });
        sheet.width = Math.max(sheet.width, frame.x + frame.width + 48);
        sheet.height = Math.max(sheet.height, frame.y + frame.height + 48);
      });
      if (frames && cells && headings) {
        let z = Math.max(0, ...sheet.items.map((item) => item.z));
        const firstIn = (pick: (cell: LayoutGridCell) => boolean, order: (cell: LayoutGridCell) => number): number => {
          let best = -1;
          cells.forEach((cell, index) => { if (pick(cell) && (best < 0 || order(cell) < order(cells[best]))) best = index; });
          return best;
        };
        const label = (heading: LayoutGridHeading, index: number, frame: { x: number; y: number; width: number; height: number }) => {
          sheet.items.push({
            id: crypto.randomUUID(), ...frame, z: ++z,
            recipe: { kind: "text", text: heading.template ?? heading.text, fontSize: 14, ...(heading.template ? { readsFrom: ids[index] } : {}) },
          });
        };
        headings.columns.forEach((heading, column) => {
          const index = firstIn((cell) => cell.column === column, (cell) => cell.row);
          if (index >= 0) label(heading, index, { x: frames[index].x, y: frames[index].y - headRoom, width: frames[index].width, height: 28 });
        });
        headings.rows.forEach((heading, row) => {
          const index = firstIn((cell) => cell.row === row, (cell) => cell.column);
          if (index >= 0) label(heading, index, { x: frames[index].x - sideRoom, y: frames[index].y, width: sideRoom - 12, height: 28 });
        });
      }
      return next;
    });
    markWorkspaceDirty();
    setActiveTab("layout");
    setImportMsg(`${recipes.length} plot${recipes.length === 1 ? "" : "s"} added to the Layout tab.`);
  }

  function openLayoutRecipeInGating(recipe: LayoutPlotRecipe | LayoutStrategyRecipe): void {
    const entry = samples.find(({ id }) => id === recipe.sampleId);
    if (!entry) {
      setPoolSelection(false);
      setError(t("The FCS file referenced by this layout item is not currently loaded."));
      return;
    }
    skipDirtyRef.current = true;
    // A pooled plot opens as the pooled view of its files: they are the checked files, and the
    // pool follows the selection, naming any under another tree or panel.
    const pool = recipe.kind !== "strategy" && recipe.pool && recipe.pool.sampleIds.length > 1 ? new Set(recipe.pool.sampleIds) : null;
    setPoolSelection(!!pool);
    setExcludedSampleIds((previous) => {
      if (pool) return new Set(samples.filter(({ id }) => !pool.has(id)).map(({ id }) => id));
      const next = new Set(previous);
      next.delete(entry.id);
      return next;
    });
    setActiveSampleId(entry.id);
    setInstrumentMode(entry.sample.instrumentMode);
    if (state.populations[recipe.populationId]) {
      dispatch({ type: "setActivePopulation", popId: recipe.populationId });
    }
    if (recipe.kind === "biplot") {
      setXIdx(entry.sample.index(recipe.xChannel) ?? channelsFor(entry.sample)[0]);
      setYIdx(entry.sample.index(recipe.yChannel ?? "") ?? channelsFor(entry.sample)[1]);
    } else if (recipe.kind === "histogram") {
      setXIdx(entry.sample.index(recipe.xChannel) ?? channelsFor(entry.sample)[0]);
    } else {
      const pop = state.populations[recipe.populationId];
      const gate = pop?.gate_refs
        .map(({ gate_id }) => state.gates[gate_id])
        .find(Boolean);
      const [fallbackX, fallbackY] = channelsFor(entry.sample);
      setXIdx(gate ? entry.sample.index(gate.x_channel) ?? fallbackX : fallbackX);
      setYIdx(gate ? entry.sample.index(gate.y_channel) ?? fallbackY : fallbackY);
    }
    setXRange(null);
    setYRange(null);
    setActiveTab("gating");
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

  /**
   * Reorder every loaded file by name.
   *
   * Files arrive in whichever order the picker produced, which after a batch import is rarely the
   * order anyone wants to read them in. This is the workspace's own sample order, so it drives the
   * samples panel, the manage table and anything that walks the list, and it is saved with the
   * workspace. Membership, the active file and the checked set are all keyed by id, so nothing but
   * the order moves.
   */
  const sortSamplesByName = useCallback((direction: "asc" | "desc") => {
    setSamples((previous) => {
      if (previous.length < 2) return previous;
      const sorted = [...previous].sort((a, b) => compareSampleNames(a.name, b.name));
      if (direction === "desc") sorted.reverse();
      return sorted;
    });
    markWorkspaceDirty();
  }, [markWorkspaceDirty]);

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
    // Bookkeeping, not an edit: no undo entry, and a removed file's copy stays as a record.
    dispatch({ type: "assignFileHierarchies", assignments: Object.fromEntries([...removed].map((id) => [id, null])), silent: true });
    if (next.length === 0) setPoolSelection(false);
    if (activeSampleId !== null && removed.has(activeSampleId)) {
      skipDirtyRef.current = true;
      // While pooled, the next viewed file is one still in the pool, so the pool keeps its tree.
      const na = (plotPool ? next.find((entry) => plotPool.ids.includes(entry.id)) : undefined) ?? next[0] ?? null;
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

  async function importFcsCandidates(
    candidates: readonly FcsImportCandidate[],
    /** Filled with the entry each candidate became, by the candidate's id; one that failed has none. */
    byCandidate?: Map<string, SampleEntry>,
    /** Filled with why each candidate that failed could not be loaded, by the candidate's id. */
    failedCandidates?: Map<string, string>,
  ): Promise<SampleEntry[]> {
    if (candidates.length === 0) return [];
    setBusy(true);
    setError(null);
    const entries: SampleEntry[] = [];
    const failures: string[] = [];
    const dataSetNotes: string[] = [];
    try {
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        setSampleImportProgress({ current: index + 1, total: candidates.length, name: candidate.name });
        try {
          const bytes = new Uint8Array((await candidate.file.arrayBuffer()).slice(0));
          try {
            const entry = createEntry(bytes, candidate.name, candidate.handle, candidate.sourcePath);
            entries.push(entry);
            byCandidate?.set(candidate.id, entry);
          } catch (cause) {
            if (!(cause instanceof FcsMultipleDataSetsError)) throw cause;
            // A file holding several data sets (a Guava plate writes one per well) opens as one
            // sample per data set, each carried as an FCS file of its own and named after the
            // file and its position, so none is dropped and each can be found again by name.
            // No one entry is the candidate, so `byCandidate` has none for it: a caller that
            // pairs such a file resolves it again against the data sets it opened as.
            const sets = cause.dataSets;
            entries.push(...sets.map((set) => createEntry(
              extractFcsDataSet(bytes.buffer, set.index),
              fcsDataSetFileName(candidate.name, set.index, sets.length, set.label),
              null,
              candidate.sourcePath,
            )));
            if (candidate.handle) void rememberHandle("fcs:" + candidate.name, candidate.handle);
            dataSetNotes.push(`${candidate.name} holds ${sets.length} data sets and opened as ${sets.length} samples`);
          }
        } catch (cause) {
          failures.push(`${candidate.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
          failedCandidates?.set(candidate.id, cause instanceof Error ? cause.message : String(cause));
        }
        // Let progress paint and keep the browser responsive between synchronous FCS parses.
        if (index < candidates.length - 1) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
      }
      addSampleEntries(entries);
      if (entries.length > 0) {
        setImportMsg(
          `Added ${entries.length} FCS ${dataSetNotes.length ? "sample" : "file"}${entries.length === 1 ? "" : "s"} to the workspace.` +
            (dataSetNotes.length ? ` ${dataSetNotes.join("; ")}.` : ""),
        );
      }
      if (failures.length > 0) {
        setError(`${failures.length} FCS file${failures.length === 1 ? "" : "s"} could not be loaded: ${failures.join("; ")}`);
      }
    } finally {
      setSampleImportProgress(null);
      setBusy(false);
    }
    return entries;
  }

  // Open (add) one or more FCS files — native handles where supported, input fallback elsewhere.
  async function openFcs() {
    if (!supportsFileSystemAccess()) {
      fileRef.current?.click();
      return;
    }
    try {
      const picked = await pickFiles(FCS_FILE_ACCEPT, "FCS files");
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
      const picked = await pickDirectoryFiles([".fcs"]);
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
    const perSampleGlobalScales = Object.fromEntries(samples.map((entry) => {
      const contextKey = axisScaleContextKey(
        entry.id,
        entry.sample.workspaceScaleContextKey,
        entry.sample.lockedScaleContextKey,
        false,
      );
      return [entry.id, contextKey ? scalesForContext(contextKey) : {}];
    }));
    const legacy: WorkspaceFile = {
      format: "gatelab-workspace",
      version: 2,
      workspaceId,
      savedAt: new Date().toISOString(),
      app: "GateLab",
      ...(isSceHost && hostDrawnAssayId ? { hostedAssayId: hostDrawnAssayId } : {}),
      samples: samples.map((e, i) => ({
        sampleId: e.id,
        fileName: e.name,
        dataPath: sampleDataPath(e.name, i),
        logicleW: e.sample.logicleWOverrides(),
        scatterCofactor: e.sample.scatterCofactorOverrides(),
        scatterLinear: e.sample.scatterLinearKeys(),
        fluorArcsinh: e.sample.fluorArcsinhKeys(),
        cytofCofactor: e.sample.arcsinhCofactor,
        compensationOn: e.sample.compensationEnabled ||
          (e.sample.spillover === null && compensationPendingRef.current.has(e.id)),
        instrumentMode: e.sample.instrumentMode,
        labels: e.sample.labelOverrides(),
        metadata: { ...metadata[e.id], [SAMPLE_ID_FIELD]: sampleDisplayId(e.name, metadata[e.id]) },
        division: divisionProfiles[e.id],
        ...(fileHierarchies[e.id] ? { hierarchyId: fileHierarchies[e.id] } : {}),
        ...(state.file_groups[e.id] ? { groupId: state.file_groups[e.id] } : {}),
        // What the file recorded about its acquisition, so relinking finds this file and not
        // another experiment's file of the same name.
        ...(Object.keys(identityKeywords(e.sample.fcs.keywords)).length
          ? { identity: identityKeywords(e.sample.fcs.keywords) }
          : {}),
        // A matrix that is not the file's own (a FlowJo workspace's) goes with the file, so the
        // reopened file is compensated with the matrix its gates were drawn under.
        ...(e.sample.externalSpillover ? { externalSpillover: e.sample.externalSpillover } : {}),
      })),
      activeSample: Math.max(0, samples.findIndex((e) => e.id === activeSampleId)),
      gating: {
        gates: state.gates,
        gate_order: state.gate_order,
        populations: state.populations,
        root_population_id: state.root_population_id,
        active_population_id: state.active_population_id,
        selected_gate_id: state.selected_gate_id && state.gates[state.selected_gate_id]
          ? state.selected_gate_id
          : null,
        hierarchies: state.hierarchies.map((h) => ({ ...h })),
        ...(state.groups.length ? { groups: state.groups.map((g) => ({ ...g })) } : {}),
        active_hierarchy_id: state.active_hierarchy_id,
        stored_hierarchies: Object.values(state.stored_hierarchies).map((h) => ({
          id: h.id,
          name: h.name,
          ...(h.owner_sample_id ? { owner_sample_id: h.owner_sample_id } : {}),
          ...(h.structure_locked !== undefined ? { structure_locked: h.structure_locked } : {}),
          ...(h.source_hierarchy_id ? { source_hierarchy_id: h.source_hierarchy_id } : {}),
          ...(h.source_gate_ids ? { source_gate_ids: h.source_gate_ids } : {}),
          ...(h.source_population_ids ? { source_population_ids: h.source_population_ids } : {}),
          // Its own geometry travels with it. Without this a parked hierarchy would come back
          // pointing at gates that belong to whichever hierarchy happened to be active.
          gates: h.gates,
          gate_order: h.gate_order,
          populations: h.populations,
          root_population_id: h.root_population_id,
          active_population_id: h.active_population_id,
        })),
        // Every file is in a group, so the assignments always mean what they say.
        perFileHierarchies: true,
      },
      scales: {
        globalScales,
        lockBetweenFiles: lockScalesBetweenFiles,
        perSampleGlobalScales,
      },
      display: {
        pointAlpha,
        pointSize,
        xChannel: sample.channels[xIdx].key,
        yChannel: sample.channels[yIdx].key,
        mode,
        maxEvents,
        contourThreshold,
        contourLevels,
        densityColorPower,
        fontSizes: gatingFontSizes,
        branchGatesOnly,
        showUnownedGates,
        paneWidths: { left: leftWidth, right: sideWidth },
      },
      illustration: illustConfigRef.current ?? undefined,
      illustrationPresets,
      strategy: strategyConfigRef.current ?? undefined,
      layout: layoutWorkspace,
      plotting: savedPlottingState(),
      metadataColumns: [{ name: SAMPLE_ID_FIELD }, ...metadataColumns.filter(column => column.name !== SAMPLE_ID_FIELD)],
      populationMetadata,
      populationMetaColumns,
    };
    const needsV3 = workspaceCompensation.lineages.length > 0 || hostedCompensationBindingsRef.current.size > 0 || samples.some(({ sample: candidate }) => {
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
        // A binding set aside while a display assay is drawn is saved as it was.
        assay = hostedCompensationBindingsRef.current.get(samples[index].id) ?? {
          schema: SAMPLE_ASSAY_BINDING_SCHEMA,
          activeLayer: "original",
          compensatedLayer: null,
        };
      } else if (status.metadata.runtimeIdentity !== "profile") {
        // Every file still on its FCS's own matrix is named, so the one message is enough to act on.
        const embedded = samples
          .filter((entry) => {
            const layer = entry.sample.compensatedLayerStatus();
            return layer.state !== "missing" && layer.metadata.runtimeIdentity !== "profile";
          })
          .map((entry) => entry.name);
        throw new Error(
          `This workspace mixes an imported compensation profile with legacy embedded-FCS compensation. Switch the embedded layer to Original before saving: ${embedded.join(", ")} (view each file and set Assay, in the header, to Original).`,
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

  /**
   * Every SCE sample, with the tree it is gated under, gated under any hierarchy on demand. The
   * active hierarchy reuses the gating already computed for the plot and the background cache; a
   * parked hierarchy is evaluated here with its own tree and gate table. Which tree a sample's
   * membership is read from is hostedMembershipReader's decision, not this one's.
   */
  function hostedMembershipSamples(datasetId: string): HostedMembershipSample[] {
    return samples.map((entry): HostedMembershipSample => {
      const source = entry.hostSource;
      if (!source || source.datasetId !== datasetId) {
        throw new Error(`Sample '${entry.name}' is not mapped to this SCE.`);
      }
      return {
        sampleId: source.sampleId,
        eventCount: source.eventIndex.length,
        name: entry.name,
        hierarchyId: hierarchyOfFile(entry.id),
        gatingFor: (tree: HierarchyTree) => {
          if (!tree.active) return recomputeGating(entry.sample, gatingStateForTree(gatingState, tree));
          if (entry.id === activeSampleId) return liveTreeGatingOfViewed();
          const cached = inactiveGatingCacheRef.current.get(entry.id);
          return cached &&
            cached.sample === entry.sample &&
            cached.dataRevision === entry.sample.dataRevision &&
            cached.gateVersion === state.gate_version
            ? cached.gating
            : recomputeGating(entry.sample, gatingState);
        },
      };
    });
  }

  function saveHostedWorkspace(
    reason: "autosave" | "explicit",
    clientRevision = workspaceEditRevisionRef.current,
  ): Promise<GateLabHostWorkspaceWriteResult & { notEvaluated?: string[] }> {
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
        // Stamped with what it needs of the GateLab that opens it, as a file is (workspaceFeatures.ts):
        // the SCE's copy is opened by whichever GateLab build the opening GateLabR embeds, and one
        // that predates a feature must refuse it rather than misread it.
        const workspaceJson = JSON.stringify(stampHostedWorkspace(ws));
        // An explicit save also hands R every population's membership, for every hierarchy and
        // sample, so the whole tree can be read back there. Autosaves carry geometry only.
        const memberships = reason === "explicit"
          ? buildHostedMemberships(state, hostedMembershipSamples(datasetId))
          : undefined;
        const writeAt = (expectedRevision: number) =>
          host.workspaces!.writeWorkspace({
            datasetId,
            expectedRevision,
            clientRevision,
            reason,
            workspaceJson,
            writerId: hostWriterIdRef.current!,
            ...(memberships ? { memberships } : {}),
          });
        let result: GateLabHostWorkspaceWriteResult;
        try {
          result = await writeAt(hostWorkspaceRevisionRef.current);
        } catch (cause) {
          // A write can land in the SCE while its reply never arrives -- a closing session, a
          // reconnect, a replaced tab -- leaving this browser a revision behind and every later
          // save failing the check. When the winning write carries our own writer id it is that
          // lost reply, so resync to it and retry once: the result is exactly the state we would
          // have reached had the reply arrived. A conflict from any other writer is a real second
          // session and must not be silently overwritten.
          if (
            !(cause instanceof GateLabWorkspaceConflictError) ||
            cause.conflict.writerId !== hostWriterIdRef.current
          ) throw cause;
          hostWorkspaceRevisionRef.current = cause.conflict.currentRevision;
          setHostWorkspaceRevision(cause.conflict.currentRevision);
          result = await writeAt(cause.conflict.currentRevision);
        }
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
        return memberships
          ? { ...result, notEvaluated: notEvaluatedNotes(memberships.populations.flatMap(({ sampleMasks }) => sampleMasks)) }
          : result;
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
        tourSignals.current.workspaceSaves++;
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
          noteRecentWorkspace(h, f.name);
          setImportMsg(`Saved · ${f.name}`);
          tourSignals.current.workspaceSaves++;
        }
      } else {
        downloadBlob(`${base}.${WORKSPACE_EXT}`, new Blob([data as BlobPart], { type: "application/json" }));
        tourSignals.current.workspaceSaves++;
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
      // The name the file was saved under: the one chosen in the save dialog, which need not be
      // the one suggested, or the suggested one for a download.
      let savedName = `${base}-bundle.${WORKSPACE_EXT}`;
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
          savedName = handle.name;
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
          savedName = handle.name;
        } else {
          downloadBlob(`${base}-bundle.${WORKSPACE_EXT}`, new Blob([zip as BlobPart], { type: "application/zip" }));
        }
      }
      tourSignals.current.workspaceSaves++;
      setImportMsg(
        `Saved portable bundle · ${savedName}` +
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

  // The demo workspace a copy of GateLab ships beside its page (demo/gatelab-demo.gatelab), for
  // the tutorial and for a first look. It is opened as a picked file would be; a copy without
  // it says so (a dev server answers an unknown path with the page itself).
  /** Opens the demo workspace kept beside the page; false when this copy has none or it does not open. */
  async function openDemoWorkspace(): Promise<boolean> {
    setError(null);
    try {
      const url = new URL(DEMO_WORKSPACE_PATH, document.baseURI).toString();
      const response = await fetch(url, { cache: "no-store" });
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || type.includes("text/html"))
        throw new Error(`This copy of GateLab has no demo workspace (none at ${DEMO_WORKSPACE_PATH} beside the page). Open any .gatelab workspace instead.`);
      const blob = await response.blob();
      await openWorkspaceFromFile(new File([blob], DEMO_WORKSPACE_FILE, { type: "application/octet-stream" }), null, DEMO_WORKSPACE_FILE);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // Open workspace — FS picker (keeps a handle for in-place Save), or the input fallback.
  /** Reopen a workspace from the menu's recent list: the browser asks once for the file again. */
  async function openRecentWorkspace(recent: RecentWorkspace) {
    try {
      if (!(await ensurePermission(recent.handle, "read"))) {
        setImportMsg(`${recent.name} · access not granted`);
        return;
      }
      const file = await recent.handle.getFile();
      await openWorkspaceFromFile(file, recent.handle, file.name);
    } catch (e) {
      // The file is gone or moved: out of the list, and said.
      await forgetRecentWorkspace(recent.name).catch(() => undefined);
      refreshRecentWorkspaces();
      setError(`${recent.name} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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
      const picked = await pickFileSource(null, "GateLab workspace");
      if (picked) await openWorkspaceFromFile(picked.file, picked.handle, picked.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Resolve a reference-workspace sample without prompting: an already-open sample of the
  // same name → a remembered handle. All unresolved names are handled together below. Either is
  // taken only when it is the acquisition the workspace was saved with: the handle is remembered
  // by file name, so it is the last file of that name opened anywhere, and an open sample of the
  // same name can be another experiment's.
  async function resolveKnownReferenceFcs(
    requirement: WorkspaceFcsRequirement,
    /** The workspace declares another file of this name: only a confirmed acquisition will do. */
    duplicate = false,
    /** Open samples already taken for another declaration. */
    taken: ReadonlySet<string> = new Set(),
  ): Promise<ResolvedReferenceFcs | null> {
    const { fileName } = requirement;
    const isIt = (keywords: Record<string, string> | null) => {
      if (duplicate) {
        return !!requirement.identity && !!keywords &&
          compareIdentity(requirement.identity, identityKeywords(keywords)).verdict === "confirmed";
      }
      return !requirement.identity || !keywords ||
        compareIdentity(requirement.identity, identityKeywords(keywords)).verdict !== "contradicted";
    };
    const existing = samples.find((e) => e.name === fileName && !taken.has(e.id) && isIt(e.sample.fcs.keywords));
    if (existing?.bytes) {
      return {
        bytes: existing.bytes,
        handle: existing.handle,
        ...(existing.sourcePath ? { sourcePath: existing.sourcePath } : {}),
        openId: existing.id,
      };
    }
    // One data set of a multi-data-set file is found through the file it came from.
    const dataSet = parseFcsDataSetFileName(fileName);
    const onDisk = dataSet?.fileName ?? fileName;
    const h = await recallHandle("fcs:" + onDisk);
    const read = h ? await readFromHandleIfPermitted(h) : null;
    if (
      read &&
      read.name.normalize("NFC").toLocaleLowerCase() ===
        onDisk.normalize("NFC").toLocaleLowerCase()
    ) {
      // The acquisition the workspace was saved with is the data set's own, so a data set is
      // compared once it is taken out of the file: the file's first HEADER is its first data set.
      const bytes = dataSet
        ? extractNamedFcsDataSet(read.bytes.slice().buffer, dataSet.index, dataSet.count)
        : read.bytes;
      if (!isIt(readFcsKeywords(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer))) return null;
      return dataSet ? { bytes, handle: null } : { bytes, handle: h };
    }
    return null;
  }

  /**
   * One choice of a folder (searched with its subfolders) or of files, matched against the
   * entries not yet found. Complete when every entry has its file; otherwise what was found is
   * kept, so the next choice need only bring the rest -- the files of a workspace can be spread
   * over several folders.
   */
  async function resolveReferenceFcsFolder(
    requirements: readonly WorkspaceFcsRequirement[],
    workspaceHandle: FileSystemFileHandle | null,
    mode: "folder" | "files",
    found: ReadonlyMap<string, RelinkedSource>,
  ): Promise<
    | { status: "complete"; resolved: ReadonlyMap<string, ResolvedReferenceFcs> }
    | { status: "partial"; found: ReadonlyMap<string, RelinkedSource>; note: string; error: string | null }
    | null
  > {
    const remaining = requirements.filter((requirement) => !found.has(requirement.dataPath));
    if (remaining.length === 0) {
      return { status: "complete", resolved: await readRelinkedFcs(requirements.map((requirement) => ({ requirement, ...found.get(requirement.dataPath)! }))) };
    }

    setImportMsg(
      `Linked FCS files unavailable · choose the folder containing the ${remaining.length} required file` +
        `${remaining.length === 1 ? "" : "s"}`,
    );

    let sourceName: string;
    let sources: PickedFileSource[];
    if (mode === "folder" && supportsDirectoryAccess()) {
      const picked = await pickDirectoryFiles([".fcs"], {
        ...(workspaceHandle ? { startIn: workspaceHandle } : {}),
      });
      if (!picked) return null;
      sourceName = picked.name;
      sources = picked.files;
    } else if (supportsFileSystemAccess()) {
      setImportMsg(
        `Select the ${remaining.length} required FCS file${remaining.length === 1 ? "" : "s"}`,
      );
      const picked = await pickFiles(
        FCS_FILE_ACCEPT,
        "FCS files required by this workspace",
        {},
      );
      if (!picked) return null;
      sourceName = "selected files";
      sources = picked;
    } else {
      throw new Error(
        "This browser cannot select a folder for linked FCS recovery. Open GateLab in a Chromium-based browser or use a portable workspace.",
      );
    }

    // The files named like a required one are read for their acquisition keywords, so a
    // same-named file of another experiment is never relinked in its place.
    const identities = new Map<PickedFileSource, ReturnType<typeof identityKeywords>>();
    const named = (name: string) => remaining.some((r) =>
      r.identity && r.fileName.normalize("NFC").toLocaleLowerCase() === name.normalize("NFC").toLocaleLowerCase());
    for (const source of sources) {
      if (!named(source.name)) continue;
      const keywords = await readFcsFileKeywords(source.file);
      if (keywords) identities.set(source, identityKeywords(keywords));
    }
    const plan = planWorkspaceFcsRelink(remaining, sources, (source) => identities.get(source) ?? null);
    setWorkspaceRelinkOverride(null);
    const pathOf = (source: PickedFileSource) =>
      sourceName === "selected files" ? source.relativePath : `${sourceName}/${source.relativePath}`;
    relinkedUnconfirmedRef.current = [
      ...relinkedUnconfirmedRef.current,
      ...plan.unconfirmed.map((u) => ({
        fileName: describeRequirement(u.requirement, requirements), path: pathOf(u.candidate),
        agree: u.agree, setAside: u.setAside.map(pathOf),
      })),
    ];
    const nextFound = new Map(found);
    for (const requirement of remaining) {
      const source = plan.matches.get(requirement.dataPath);
      if (source) nextFound.set(requirement.dataPath, { source, sourceName });
    }
    const taken = [...requirements.flatMap((requirement) => {
      const hit = nextFound.get(requirement.dataPath);
      return hit ? [{ requirement, ...hit }] : [];
    })];
    // Only same-named files of another acquisition stand in the way, one for each: offered, by
    // name, as an explicit choice. Nothing else is ever relinked to them.
    if (!plan.missing.length && !plan.ambiguous.length && plan.mismatched.length &&
        plan.mismatched.every((m) => m.candidates.length === 1)) {
      setWorkspaceRelinkOverride({
        take: [
          ...taken,
          ...plan.mismatched.map((m) => ({ requirement: m.requirement, source: m.candidates[0].candidate, sourceName })),
        ],
        // Named so two declarations of one file name read apart: they read identically.
        byChoice: plan.mismatched.map((m) => ({ fileName: describeRequirement(m.requirement, requirements), path: pathOf(m.candidates[0].candidate) })),
      });
    }
    if (plan.missing.length > 0 || plan.ambiguous.length > 0 || plan.mismatched.length > 0) {
      const details: string[] = [];
      if (plan.mismatched.length > 0) {
        details.push(
          "Another acquisition: " +
            plan.mismatched.map(({ requirement, candidates }) =>
              candidates.map(({ candidate, differ }) =>
                describeContradiction(`the workspace's ${describeRequirement(requirement, requirements)}`, differ, candidate.relativePath)).join("; "),
            ).join("; "),
        );
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
      const stillMissing = requirements.filter((requirement) => !nextFound.has(requirement.dataPath));
      const foundNow = plan.matches.size;
      const where = sourceName === "selected files" ? "the selected files" : `"${sourceName}"`;
      const note = foundNow > 0
        ? `${foundNow} of ${remaining.length} found in ${where}; ${stillMissing.length} still to find: ${stillMissing.map(({ fileName }) => fileName).join(", ")}. Choose another folder, or the files themselves.`
        : `Nothing required was found in ${where}. Still to find: ${stillMissing.map(({ fileName }) => fileName).join(", ")}.`;
      return {
        status: "partial",
        found: nextFound,
        note,
        error: details.length ? `${details.join(". ")}. No workspace data were changed.` : null,
      };
    }

    return { status: "complete", resolved: await readRelinkedFcs(taken) };
  }

  async function readRelinkedFcs(
    take: readonly { requirement: WorkspaceFcsRequirement; source: PickedFileSource; sourceName: string }[],
  ): Promise<ReadonlyMap<string, ResolvedReferenceFcs>> {
    const resolved = new Map<string, ResolvedReferenceFcs>();
    for (let index = 0; index < take.length; index++) {
      const { requirement, source, sourceName } = take[index];
      setImportMsg(
        `Relinking from ${sourceName} · ${index + 1} / ${take.length} · ${requirement.fileName}`,
      );
      const whole = new Uint8Array(await source.file.arrayBuffer());
      const dataSet = parseFcsDataSetFileName(requirement.fileName);
      const bytes = dataSet ? extractNamedFcsDataSet(whole.buffer, dataSet.index, dataSet.count) : whole;
      resolved.set(requirement.dataPath, {
        bytes,
        handle: dataSet ? null : source.handle,
        sourcePath: sourceName === "selected files"
          ? source.relativePath
          : `${sourceName}/${source.relativePath}`,
      });
    }
    return resolved;
  }

  /** Relink the files that record another acquisition, because the user chose them by name. */
  async function useWorkspaceRelinkOverride(): Promise<void> {
    const override = workspaceRelinkOverride;
    if (!override || workspaceRelinkScanning) return;
    setWorkspaceRelinkScanning(true);
    try {
      const resolved = await readRelinkedFcs(override.take);
      relinkedByChoiceRef.current = override.byChoice;
      const resolve = workspaceRelinkResolverRef.current;
      workspaceRelinkResolverRef.current = null;
      setPendingWorkspaceRelink(null);
      setWorkspaceRelinkOverride(null);
      setWorkspaceRelinkError(null);
      setWorkspaceRelinkNote(null);
      resolve?.(resolved);
    } catch (cause) {
      setWorkspaceRelinkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorkspaceRelinkScanning(false);
    }
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
    setWorkspaceRelinkNote(null);
    setWorkspaceRelinkScanning(false);
    relinkedUnconfirmedRef.current = [];
    setPendingWorkspaceRelink({
      requirements: [...requirements],
      workspaceHandle,
      found: new Map(),
    });
    return new Promise((resolve) => {
      workspaceRelinkResolverRef.current = resolve;
    });
  }

  function cancelPendingWorkspaceRelink(): void {
    const resolve = workspaceRelinkResolverRef.current;
    workspaceRelinkResolverRef.current = null;
    setPendingWorkspaceRelink(null);
    setWorkspaceRelinkOverride(null);
    setWorkspaceRelinkError(null);
    setWorkspaceRelinkNote(null);
    setWorkspaceRelinkScanning(false);
    resolve?.(null);
  }

  async function choosePendingWorkspaceRelinkFolder(mode: "folder" | "files" = "folder"): Promise<void> {
    const pendingRelink = pendingWorkspaceRelink;
    if (!pendingRelink || workspaceRelinkScanning) return;
    setWorkspaceRelinkScanning(true);
    setWorkspaceRelinkError(null);
    try {
      // This call must begin directly inside the button gesture. Browsers reject a picker
      // launched later from the asynchronous workspace parser.
      const outcome = await resolveReferenceFcsFolder(
        pendingRelink.requirements,
        pendingRelink.workspaceHandle,
        mode,
        pendingRelink.found,
      );
      if (!outcome) return;
      if (outcome.status === "partial") {
        // What this choice found is kept; the dialog says what is still to find.
        setPendingWorkspaceRelink({ ...pendingRelink, found: outcome.found });
        setWorkspaceRelinkNote(outcome.note);
        setWorkspaceRelinkError(outcome.error);
        setImportMsg("Selected FCS location was incomplete · choose another folder");
        return;
      }
      const resolve = workspaceRelinkResolverRef.current;
      workspaceRelinkResolverRef.current = null;
      setPendingWorkspaceRelink(null);
      setWorkspaceRelinkNote(null);
      resolve?.(outcome.resolved);
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
    await restoreCompensationBindings(
      ws.compensation.lineages,
      ws.samples.map((workspaceSample) => workspaceSample.assay),
      entries,
    );
  }

  /** Install on `entries[i]` the compensated layer `bindings[i]` names, from the host or the local cache. */
  async function restoreCompensationBindings(
    lineages: WorkspaceCompensationState["lineages"],
    bindings: readonly (SampleAssayBinding | null)[],
    entries: readonly SampleEntry[],
  ): Promise<void> {
    const manager = compensationManagerRef.current!;
    if (compensationApplyGuardRef.current || manager.applyInProgress) {
      throw new Error(t("Another compensation job is already running."));
    }
    const profiles = lineages.flatMap(({ records }) => records);
    const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const tasks = bindings.flatMap((assayBinding, index) => {
      const binding = assayBinding?.compensatedLayer ?? null;
      if (!assayBinding || binding === null) return [];
      const profile = profileById.get(binding.profileId);
      if (!profile) {
        throw new Error(t("Workspace compensation profile '{profile}' is missing.", { profile: binding.profileId }));
      }
      return [{ entry: entries[index], assay: assayBinding, binding, profile }];
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
    // The progress line is cleared on the way out unless something has replaced it: a workspace
    // refused here (a FlowJo 7 workspace, a file that is none) left "reading workspace" standing
    // beside its error.
    const reading = `Opening ${wsFileName} · reading workspace`;
    setImportMsg(reading);
    try {
      // "Workspace" includes a .gatelab bundle and gate-only FlowJo/FACSChorus files. Point at
      // the right control rather than failing on the zip header.
      // A .cef holds the gates as they are now plus a snapshot per sort, but no event data.
      // Choose its tree first, then request the FCS it belongs to just as a .wsp requests data.
      if (isChorusExperimentFile(wsFileName)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const experiment = readChorusExperiment(bytes);
        const trees = listChorusTrees(experiment).filter((tree) => tree.gateCount > 0);
        if (!trees.length) throw new Error("This FACSChorus experiment contains no gates GateLab can read.");
        setChorusSource({ name: wsFileName, bytes });
        // Always the timeline. Even one tree needs a button when no FCS is loaded: browsers only
        // allow the second file picker to open directly from a user gesture. With a file loaded,
        // nothing in the .cef says the file is its data, so the tree is applied only when chosen.
        setChorusPicker({ experiment, trees });
        setImportMsg(null);
        return;
      }
      // A .wsp holds gates and the names of the files they were drawn on, but no data. Opening
      // one therefore means gathering its FCS first -- from what is already loaded, plus
      // whatever the user can point at -- rather than refusing until a file happens to be open.
      if (/\.wsp$/i.test(wsFileName)) {
        const text = await file.text();
        if (!isFlowJoWorkspace(text)) {
          throw new Error(`"${wsFileName}" is not a FlowJo workspace GateLab can read.`);
        }
        const allSamples = listFlowJoWorkspaceSamples(text, t);
        const wsSamples = allSamples.filter((x) => x.gateCount > 0);
        if (!wsSamples.length) throw new Error("This workspace contains no gates GateLab can read.");
        setFlowJoOpen({
          fileName: wsFileName,
          text,
          handle: wsH,
          samples: wsSamples,
          // The workspace refers to these files too. Leaving them out made a workspace of thirteen
          // files report "1/1 found" and load one, with twelve compensation controls left behind.
          dataSamples: allSamples.filter((x) => x.gateCount === 0),
          pending: [],
          // Nothing chosen yet: until the user chooses a row, the selection is the sample the
          // viewed file IS, else the one the first file chosen for the open is (flowjoOpen.ts,
          // defaultStrategySample). The sample with the most gates, the old default, was often
          // not the loaded file's, and the dialog listed its trees for a file they would not go on.
          strategySample: null,
          strategyTouched: false,
          strategyTree: null,
          fileChoices: {},
          crossFile: null,
          // On by default when the workspace has several samples: a workspace that gates more
          // than one file is describing more than one file, and importing a single sample's
          // strategy silently discards the rest. Where the samples share a strategy this costs
          // nothing -- the gates converge by name and channel -- so the default is safe.
          perFileTrees: wsSamples.length > 1,
          // The workspace's, because that is the compensation the gates were drawn under. Only
          // offered when the two matrices actually differ -- see wspMatrixConflict.
          matrixChoice: "workspace",
          // FlowJo's own rule, at every open: turning it off is a choice made for one import,
          // and is not carried to the next, which would then read FlowJo's gates another way
          // without a word.
          flowJoGrid: true,
        });
        setImportMsg(null);
        return;
      }
      const envelope = await readWorkspaceEnvelopeFromFile(file);
      await openWorkspaceFromEnvelope(envelope, wsH, wsFileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportMsg((msg) => (msg === reading ? null : msg));
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
            ...(wss.identity ? { identity: wss.identity } : {}),
          });
        }
      }

      // A name declared twice is two files the keywords can tell apart when each declaration was
      // saved with its own acquisition identity; it is refused only where they cannot. It used to
      // be refused whatever the declarations recorded.
      const duplicateReferenceNames = indistinguishableDuplicateNames(referenceRequirements);
      if (duplicateReferenceNames.length > 0) {
        throw new Error(
          "This linked workspace contains multiple FCS files with the same filename " +
            `(${duplicateReferenceNames.join(", ")}), and nothing saved with them tells them apart, so GateLab cannot safely distinguish them by folder matching. ` +
            "Open the original files and save a portable workspace instead.",
        );
      }
      const declaredTwice = new Set(referenceRequirements
        .map((r) => r.fileName.normalize("NFC").toLocaleLowerCase())
        .filter((name, i, all) => all.indexOf(name) !== i));

      const resolvedReferenceFcs = new Map<string, ResolvedReferenceFcs>();
      const unresolvedRequirements: WorkspaceFcsRequirement[] = [];
      const takenOpen = new Set<string>();
      for (const requirement of referenceRequirements) {
        const known = await resolveKnownReferenceFcs(
          requirement, declaredTwice.has(requirement.fileName.normalize("NFC").toLocaleLowerCase()), takenOpen);
        if (known) {
          resolvedReferenceFcs.set(requirement.dataPath, known);
          if (known.openId) takenOpen.add(known.openId);
        } else {
          unresolvedRequirements.push(requirement);
        }
      }
      relinkedByChoiceRef.current = [];
      relinkedUnconfirmedRef.current = [];
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
      const dataSetNotes: string[] = [];
      const nextMetadata: Record<string, Record<string, string>> = {};
      const nextDivision: Record<string, DivisionProfile> = {};
      const nextFileHierarchies: Record<string, string> = {};
      const nextFileGroups: Record<string, string> = {};
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
          try {
            entry = createEntry(fcsB, wss.fileName, fcsH, sourcePath, wss.sampleId);
          } catch (cause) {
            if (!(cause instanceof FcsMultipleDataSetsError)) throw cause;
            // A workspace saved before GateLab read every data set holds such a file as one
            // sample, which was its first data set. It reopens as it was saved, and says so.
            entry = createEntry(fcsB, wss.fileName, fcsH, sourcePath, wss.sampleId, 0);
            dataSetNotes.push(
              `${wss.fileName} holds ${cause.dataSets.length} data sets and this workspace uses the first, ` +
                "as it was saved; open the file again to add the others",
            );
          }
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

      // A channel key the workspace was saved with that no file has now -- because the file is
      // read differently, as the MACSQuant FCS 3.1 export and UTF-8 labels are since 2026-09 -- is
      // restated as the key the same FCS parameter has now (workspaceChannelKeys.ts), in the
      // gates, the display channels and each file's channel settings. Axis ranges, divisions and
      // figure settings saved under an old key are not restated and fall back to their defaults.
      const savedChannelKeys = new Set<string>([
        ...gateChannelKeys(ws.gating.gates),
        ...(ws.gating.stored_hierarchies ?? []).flatMap((h) => [...gateChannelKeys(h.gates ?? {})]),
        ws.display?.xChannel ?? "",
        ws.display?.yChannel ?? "",
        ...ws.samples.flatMap((wss) => [
          ...Object.keys(wss.logicleW ?? {}),
          ...Object.keys(wss.scatterCofactor ?? {}),
          ...(wss.scatterLinear ?? []),
          ...(wss.fluorArcsinh ?? []),
          ...Object.keys(wss.labels ?? {}),
        ]),
      ]);
      const channelKeyRemap = planChannelKeyRemap(savedChannelKeys, entries.map((entry) => entry.sample.channels));
      const currentKey = (key: string): string => channelKeyRemap.get(key) ?? key;
      const currentKeys = <T,>(record: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(record).map(([key, value]) => [currentKey(key), value]));
      if (channelKeyRemap.size > 0) {
        ws = {
          ...ws,
          gating: {
            ...ws.gating,
            gates: remapGateChannels(ws.gating.gates, channelKeyRemap),
            stored_hierarchies: ws.gating.stored_hierarchies?.map((h) =>
              h.gates ? { ...h, gates: remapGateChannels(h.gates, channelKeyRemap) } : h),
          },
        } as LiveWorkspaceFile;
      }

      const pendingCompensation: (typeof entries)[number][] = [];
      for (let index = 0; index < ws.samples.length; index++) {
        const wss = ws.samples[index];
        const entry = entries[index];
        for (const [key, w] of Object.entries(currentKeys(wss.logicleW ?? {}))) {
          const idx = entry.sample.index(key);
          if (idx !== undefined && Number.isFinite(w)) entry.sample.setLogicleW(idx, w);
        }
        for (const [key, cofactor] of Object.entries(currentKeys(wss.scatterCofactor ?? {}))) {
          const idx = entry.sample.index(key);
          if (idx !== undefined && Number.isFinite(cofactor) && cofactor > 0) {
            entry.sample.setScatterCofactor(idx, cofactor);
          }
        }
        entry.sample.applyScatterLinearKeys((wss.scatterLinear ?? []).map(currentKey));
        // After the W overrides above, so a channel restored to arcsinh still carries the W the
        // user set for its logicle and switching back gives them the axis they saved.
        entry.sample.applyFluorArcsinhKeys((wss.fluorArcsinh ?? []).map(currentKey));
        entry.sample.applyLabelOverrides(currentKeys(wss.labels ?? {}));
        if (wss.metadata && Object.keys(wss.metadata).length) nextMetadata[entry.id] = wss.metadata;
        if (wss.hierarchyId) nextFileHierarchies[entry.id] = wss.hierarchyId;
        if (wss.groupId) nextFileGroups[entry.id] = wss.groupId;
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
        // The matrix the gates were drawn under, when it is not the file's own, before
        // compensation is turned on: the file's own would evaluate every fluorescence gate on
        // other values. One that no longer applies stops the open rather than falling back,
        // and so does one that would leave out other parameters of the file than it did.
        if (wss.externalSpillover) {
          const { label, channels, matrix, leftOut } = wss.externalSpillover;
          try {
            entry.sample.installExternalSpillover({ channels, matrix }, label, { replaceEmbedded: true, leftOut: leftOut ?? [] });
          } catch (cause) {
            throw new Error(
              `${wss.fileName} was compensated with the spillover matrix "${label}", saved with the workspace, ` +
                `which cannot be applied to it: ${cause instanceof Error ? cause.message : String(cause)} ` +
                "The current workspace was not changed.",
            );
          }
        }
        if (ws.version === 2 && "compensationOn" in wss && wss.compensationOn) {
          entry.sample.setCompensation(true);
          if (!entry.sample.compensationEnabled && entry.sample.spillover === null) pendingCompensation.push(entry);
        }
      }
      compensationPendingRef.current = new Set(pendingCompensation.map((entry) => entry.id));

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
      queueCheckpoint("after-workspace-open");
      skipDirtyRef.current = true;
      const activeIdx = Math.min(Math.max(0, ws.activeSample), entries.length - 1);
      const active = entries[activeIdx].sample;
      restoreWorkspaceTransforms(entries, ws, activeIdx);
      const restoredScaleLock = ws.scales.lockBetweenFiles !== false;
      const restoredScaleMaps = restoredAxisScaleMaps(
        ws.scales,
        entries,
        activeIdx,
        restoredScaleLock,
      );
      const restoredScaleContext = axisScaleContextKey(
        entries[activeIdx].id,
        active.workspaceScaleContextKey,
        active.lockedScaleContextKey,
        restoredScaleLock,
      );
      if (restoredScaleContext) {
        pendingFitOnLoad.current = {
          contextKey: restoredScaleContext,
          ranges: restoredScaleMaps.get(restoredScaleContext) ?? {},
        };
      }
      replaceScalesForNextNamespace(restoredScaleMaps);
      setSamples(entries);
      setPoolSelection(false);
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
      strategyConfigRef.current = ws.strategy ?? null;
      // An opened workspace's tree is not the one an earlier FlowJo import's counts describe.
      setFlowJoReferences([]);
      setIllustrationPresets(ws.illustrationPresets ?? []);
      setIllustVersion((v) => v + 1); // remount the Illustration and Strategy tabs so they re-read the restored configs
      setLayoutWorkspace(normalizeLayoutWorkspace(ws.layout));
      clearPersistedTabState(); // drop old selections so a new workspace's tabs start clean
      restorePlottingState(ws.plotting);
      setDivisionProfiles(nextDivision);
      setLockScalesBetweenFiles(restoredScaleLock);
      setScaleCacheEpoch((epoch) => epoch + 1);
      setInstrumentMode(active.instrumentMode);
      setMode(ws.display?.mode ?? "pseudocolor");
      setMaxEvents(ws.display?.maxEvents ?? 50000);
      setContourThreshold(ws.display?.contourThreshold ?? 5);
      setContourLevels(ws.display?.contourLevels ?? 10);
      setDensityColorPower(normalizeDensityColorPower(ws.display?.densityColorPower));
      setBranchGatesOnly(
        (ws.display as { branchGatesOnly?: boolean } | undefined)?.branchGatesOnly !== false);
      setShowUnownedGates(
        (ws.display as { showUnownedGates?: boolean } | undefined)?.showUnownedGates !== false);
      setPointAlpha(restoredPointAlpha(ws.display?.pointAlpha));
      setPointSize(restoredPointSize(ws.display?.pointSize));
      setGatingFontSizes({ ...DEFAULT_GATING_FONT_SIZES, ...ws.display?.fontSizes });
      // The panes as the user left them; a saved right width is theirs, so the auto-fit stands down.
      const panes = ws.display?.paneWidths;
      if (panes?.left && Number.isFinite(panes.left)) setLeftWidth(Math.max(200, Math.min(900, panes.left)));
      if (panes?.right && Number.isFinite(panes.right)) { setSideWidth(Math.max(320, Math.min(900, panes.right))); setAutoSizePopulations(false); }
      const [dx, dy] = active.defaultChannelIndices();
      setXIdx(active.index(currentKey(ws.display?.xChannel ?? "")) ?? dx);
      setYIdx(active.index(currentKey(ws.display?.yChannel ?? "")) ?? dy);
      setXRange(null);
      setYRange(null);
      setWsHandle(wsH);
      setWsName(wsFileName);
      setWsStorage(storage);
      setWorkspaceId(nextWorkspaceId);
      setDirty(false);
      noteRecentWorkspace(wsH, wsFileName);
      dispatch({
        type: "loadWorkspace",
        gates: ws.gating.gates,
        gate_order: ws.gating.gate_order,
        populations: ws.gating.populations,
        root_population_id: ws.gating.root_population_id,
        active_population_id: ws.gating.active_population_id,
        selected_gate_id: ws.gating.selected_gate_id,
        hierarchies: ws.gating.hierarchies,
        active_hierarchy_id: ws.gating.active_hierarchy_id,
        stored_hierarchies: ws.gating.stored_hierarchies?.map(
          (h) => restoreStoredHierarchy(h, ws.gating.gates)),
        // A workspace saved with per-file hierarchies off meant every file on the first tree.
        file_hierarchies: ws.gating.perFileHierarchies === true ? nextFileHierarchies : {},
        groups: ws.gating.groups ?? [],
        file_groups: nextFileGroups,
      });
      const nS = entries.length;
      const restated = [...channelKeyRemap].map(([from, to]) => `"${from}" is now "${to}"`);
      // A linked file declared without the acquisition keywords it was saved with -- a workspace
      // saved before GateLab recorded them -- was relinked by its name alone, and nothing confirms
      // it is that file: a same-named file of another experiment opened with only "Opened …".
      const unconfirmed = referenceRequirements
        .filter((r) => !r.identity || !Object.values(r.identity).some((v) => v?.trim()))
        .map((r) => r.fileName);
      setImportMsg(
        `Opened ${wsFileName || "workspace"} · ${nS} sample${nS > 1 ? "s" : ""}` +
          ` · ${storage === "bundle" ? "self-contained bundle" : "linked FCS"}` +
          ` · saved ${new Date(ws.savedAt).toLocaleString()}` +
          dataSetNotes.map((note) => ` · ${note}`).join("") +
          (restated.length
            ? ` · ${restated.length === 1 ? "a channel GateLab now names differently keeps its" : `${restated.length} channels GateLab now names differently keep their`}` +
              ` gates and settings, each the same FCS parameter: ${restated.join(", ")}`
            : "") +
          // Relinked to a file that records another acquisition only because the user chose so.
          (relinkedByChoiceRef.current.length
            ? ` · relinked by choice to files that record another acquisition: ${relinkedByChoiceRef.current
                .map((r) => `${r.path} as ${r.fileName}`).join(", ")}`
            : "") +
          (unconfirmed.length
            ? ` · relinked by name alone, unconfirmed: the workspace was saved without the acquisition keywords of ` +
              `${unconfirmed.length === 1 ? "this file" : `these ${unconfirmed.length} files`}, so nothing confirms ` +
              `${unconfirmed.length === 1 ? "it is the file" : "they are the files"} it was saved with: ${namesInBrief(unconfirmed)}`
            : "") +
          // Taken over another file of its name, which it fits better, but not confirmed by what it
          // was saved with.
          (relinkedUnconfirmedRef.current.length
            ? ` · relinked without confirmation: ${relinkedUnconfirmedRef.current.map((r) =>
                `${r.path} as ${r.fileName}, chosen over ${r.setAside.join(", ")}: ` +
                (r.agree.length
                  ? `it agrees with what it was saved with on ${r.agree.join(", ")} only, which does not confirm it`
                  : "its keywords could not be compared with what it was saved with")).join("; ")}`
            : ""),
      );
      relinkedByChoiceRef.current = [];
      relinkedUnconfirmedRef.current = [];
      // As when a file is added to the workspace (addSampleEntries): a gate on a channel a file
      // lacks matches no event in it, which would otherwise be a silent zero.
      const missing = ws.samples.flatMap((wss, index) => {
        const names = gatesMissingChannels(
          savedFileTreeGates(ws.gating, wss.hierarchyId),
          new Set(entries[index].sample.channelNames()),
        );
        return names.length > 0 ? [`${entries[index].name}: ${names.join(", ")}`] : [];
      });
      const problems: string[] = [];
      if (missing.length > 0) {
        problems.push(
          `${missing.length} sample${missing.length === 1 ? " is" : "s are"} missing channels used by existing gates: ` +
            `${missing.join("; ")}. Those gates match no events in the affected samples.`,
        );
      }
      if (pendingCompensation.length > 0) {
        const n = pendingCompensation.length;
        problems.push(
          `Compensation was on for ${n} sample${n === 1 ? "" : "s"} when the workspace was saved, but no spillover matrix ` +
            `is available for ${n === 1 ? "it" : "them"} now: ${pendingCompensation.map((entry) => entry.name).join(", ")}. ` +
            "The matrix came from a FlowJo workspace or a Gating-ML file, and workspaces saved by GateLab 0.8.3 and earlier did not keep it. " +
            "The counts are uncompensated until the matrix is supplied again (import the gating file's matrix, or apply one in " +
            "the Compensation tab); saving keeps compensation on for these files meanwhile.",
        );
      }
      if (problems.length > 0) setError(problems.join(" "));
      return true;
    } catch (e) {
      if (compensationWorkspaceReset) compensationManagerRef.current!.resetWorkspace(workspaceId);
      if (e instanceof CompensationCancelledError) {
        setError(null);
        setImportMsg("Workspace open cancelled · current workspace unchanged");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Revert workspace…: list the checkpoints kept for this workspace, newest first, to choose from. */
  async function openRevertDialog() {
    setHistoryPicker({ checkpoints: [], loading: true });
    const checkpoints = await listWorkspaceCheckpoints(workspaceIdRef.current);
    setHistoryPicker({ checkpoints, loading: false });
  }
  /**
   * Go back to a checkpoint. The current state is kept as a checkpoint first, then the
   * checkpoint is opened over the files already loaded, matched by name, and the linked file
   * is written over as an autosave would; a file the checkpoint names that is no longer loaded
   * is asked for as when a workspace is opened.
   */
  async function revertToCheckpoint(checkpoint: WorkspaceCheckpoint) {
    setHistoryPicker(null);
    await checkpointCurrentWorkspace("before-revert");
    const loadedByName = new Map(samples.map((entry) => [entry.name.normalize("NFC").toLocaleLowerCase(), entry] as const));
    const fcsByPath: Record<string, Uint8Array> = {};
    for (const declared of checkpoint.workspace.samples) {
      const entry = loadedByName.get(String(declared.fileName).normalize("NFC").toLocaleLowerCase());
      if (entry?.bytes) fcsByPath[declared.dataPath] = entry.bytes;
    }
    const storage = wsHandle ? wsStorage : "reference";
    const opened = await openWorkspaceFromEnvelope(
      { raw: structuredClone(checkpoint.workspace), fcsByPath, storage, portableAssays: null },
      wsHandle,
      wsName || "workspace",
    );
    if (!opened) return;
    const which = `${CHECKPOINT_REASON_LABELS[checkpoint.reason] ?? checkpoint.reason} · ${checkpointAge(checkpoint.createdAt)}`;
    if (wsHandle && storage !== "bundle") {
      setDirty(true);
      setImportMsg(`Reverted to ${which} · ${wsName} is written over at the next autosave`);
    } else {
      setImportMsg(`Reverted to ${which} · Save to keep it`);
    }
  }

  /**
   * The tree the viewed file is gated under, when it is not the live one but of its family: the
   * file's own copy (or its group's) while edits go to the tree or the group. A pooled view edits
   * the tree by construction and is left to it. The stored tree itself, so it changes only when
   * that tree does, not with every edit to the live one.
   */
  const viewedOwnTreeId = useMemo((): string | null => {
    if (!activeSampleId || plotPool) return null;
    const hid = hierarchyOfFile(activeSampleId);
    if (hid === state.active_hierarchy_id) return null;
    if (templateOf(hid, state.hierarchies)?.id !== templateOf(state.active_hierarchy_id, state.hierarchies)?.id) return null;
    return state.stored_hierarchies[hid]?.root_population_id ? hid : null;
  }, [activeSampleId, plotPool, hierarchyOfFile, state.active_hierarchy_id, state.hierarchies, state.stored_hierarchies]);
  const viewedOwnTree = viewedOwnTreeId ? state.stored_hierarchies[viewedOwnTreeId] ?? null : null;

  // Gate geometry and population membership are expensive over large FCS files, but neither
  // depends on which population is currently selected. Keep that stable work cached across
  // population clicks; only invalidate when the sample/gating inputs themselves change. While the
  // viewed file is shown under its own tree the live tree's gating of it is not drawn, and is
  // computed only where something asks for it (the R host's memberships, the colData export).
  const gatingDerived = useMemo(
    () => (viewedOwnTree ? null : recomputeGating(sample, gatingState)),
    // Sample is mutable by design, so its explicit revision must invalidate gate geometry.
    // instrumentMode remains separate because transform-only changes do not always revise data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, gatingState, activeDataRevision, instrumentMode, viewedOwnTree === null],
  );
  /** The live tree's gating of the viewed file, computed now when it was not. */
  const liveTreeGatingOfViewed = (): GatingDerived => gatingDerived ?? recomputeGating(sample, gatingState);

  // The viewed file's own tree's gating, kept while only the live tree changes: an edit to the tree
  // regates the file's own tree only when that tree follows it.
  const ownTreeGating = useMemo(
    () => (viewedOwnTree ? recomputeOwnTreeGating(sample, viewedOwnTree) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, viewedOwnTree, activeDataRevision, instrumentMode],
  );

  // The viewed file under its own gates, keyed by the live tree's populations: the plot, the
  // population tree and the gate counts show what the file's own tree selects while the tree's
  // gates are drawn and edited. With the live tree's gates instead, a tailored file viewed with
  // "the tree · all files" showed the tree's gating, and none on a channel it labels differently.
  const viewGating = useMemo(
    () => ownTreeGating && viewedOwnTree?.root_population_id && activeSampleId
      ? gatingKeyedByLiveTree(sample, gatingState, ownTreeGating, viewedOwnTree.root_population_id, (popId) => populationIdInFileTree(activeSampleId, popId))
      : gatingDerived ?? recomputeGating(sample, gatingState),
    // populationIdInFileTree reads the store; the trees it reads are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gatingDerived, ownTreeGating, viewedOwnTree, sample, gatingState, activeSampleId, activeDataRevision, instrumentMode],
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
  const backgroundGatingSamples = useMemo(() => fcsExportOpen
    ? [...new Set([...includedSamples, ...analysisSamples])]
    : includedSamples, [fcsExportOpen, includedSamples, analysisSamples]);

  useEffect(() => {
    // Not computed while the viewed file is shown under its own tree; the background gates it
    // again once it is no longer the viewed file.
    if (!activeEntry || !sample || !gatingDerived) return;
    inactiveGatingCacheRef.current.set(activeEntry.id, {
      sample,
      dataRevision: sample.dataRevision,
      gateVersion: state.gate_version,
      gating: gatingDerived,
    });
  }, [activeEntry, sample, activeDataRevision, state.gate_version, gatingDerived]);

  // ── A connected agent ──────────────────────────────────────────────────────────────────────
  // An agent on this computer reads the gating through a relay the user connected to (Agent
  // menu, or ?agent= on the URL) and proposes gates through the same reducer the user draws
  // with. The adapter below is what it reads and does; it closes over this render's values and is
  // re-made each render, so a request always sees the app as it is.
  const [agentStatus, setAgentStatus] = useState<AgentLinkStatus>({ state: "idle" });
  const agentSettledRef = useRef<(() => void)[]>([]);
  useEffect(() => {
    // After every commit: whoever dispatched and waits for the state to be readable can go on.
    const waiting = agentSettledRef.current;
    agentSettledRef.current = [];
    for (const resolve of waiting) resolve();
  });
  const agentAdapterRef = useRef<AgentAdapter>(null!);
  agentAdapterRef.current = {
    info: () => ({ app: isSceHost ? "GateLabR" : "GateLab", version: pkg.version, host: isSceHost ? "sce" : "browser", workspaceName: wsName || null }),
    state: () => state,
    samples: (): AgentSampleView[] => {
      const trees = workspaceHierarchyTrees(state);
      return samples.map((entry) => {
        const hierarchyId = hierarchyOfFile(entry.id);
        return {
          id: entry.id, name: entry.name, sample: entry.sample,
          viewed: entry.id === activeSampleId, checked: !excludedSampleIds.has(entry.id), hierarchyId,
          metadata: metadata[entry.id] ?? {},
          gating: () => {
            const tree = trees.find((candidate) => candidate.id === hierarchyId);
            if (tree && !tree.active) return recomputeGating(entry.sample, gatingStateForTree(gatingState, tree));
            if (entry.id === activeSampleId) return liveTreeGatingOfViewed();
            const cached = inactiveGatingCacheRef.current.get(entry.id);
            return cached && cached.sample === entry.sample && cached.dataRevision === entry.sample.dataRevision && cached.gateVersion === state.gate_version
              ? cached.gating
              : recomputeGating(entry.sample, gatingState);
          },
        };
      });
    },
    dispatch,
    settled: () => new Promise<void>((resolve) => { agentSettledRef.current.push(resolve); }),
    view: (): AgentViewState => {
      const xKey = sample?.channels[xIdx]?.key ?? null, yKey = sample?.channels[yIdx]?.key ?? null;
      // The ranges as the plot takes them: the pan, else the held scale, else the automatic one.
      const shown = (own: [number, number] | null, key: string | null, auto: [number, number] | undefined): [number, number] | null =>
        own ?? (key ? globalScales[key] ?? null : null) ?? auto ?? null;
      return {
        populationId: state.active_population_id, sampleId: activeSampleId, x: xKey, y: yKey, tab: activeTab,
        ranges: { x: shown(xRange, xKey, workspaceAutomaticRanges?.xRange), y: shown(yRange, yKey, workspaceAutomaticRanges?.yRange) },
      };
    },
    setView: async (params: AgentViewParams) => {
      if (params.sampleId !== undefined) setActiveSampleId(params.sampleId);
      if (params.populationId !== undefined) dispatch({ type: "setActivePopulation", popId: params.populationId });
      const target = (params.sampleId !== undefined ? samples.find((entry) => entry.id === params.sampleId)?.sample : null) ?? sample;
      if (target) {
        const xi = params.x === undefined ? undefined : target.index(params.x);
        const yi = params.y === undefined ? undefined : target.index(params.y);
        if (xi !== undefined) setXIdx(xi);
        if (yi !== undefined) setYIdx(yi);
      }
      setActiveTab("gating");
      await new Promise<void>((resolve) => { agentSettledRef.current.push(resolve); });
    },
    fit: () => fitDataAndGates(),
    setAxisRange: (channel, range) => setGlobalScale(channel, range),
    clearPan: () => { setXRange(null); setYRange(null); },
    reload: () => window.location.reload(),
    render: async (params) => {
      const area = plotAreaRef.current;
      if (!area) throw new Error("The Gating tab's plot is not on screen.");
      return renderPlotPng(area, params);
    },
    workspaceJson: () => {
      const ws = buildWorkspaceFile();
      return ws ? JSON.stringify(ws) : null;
    },
  };
  const agentLinkRef = useRef<AgentLink | null>(null);
  if (!agentLinkRef.current) {
    const handler = createAgentHandler({
      info: () => agentAdapterRef.current.info(),
      state: () => agentAdapterRef.current.state(),
      samples: () => agentAdapterRef.current.samples(),
      dispatch: (action) => agentAdapterRef.current.dispatch(action),
      settled: () => agentAdapterRef.current.settled(),
      view: () => agentAdapterRef.current.view(),
      setView: (params) => agentAdapterRef.current.setView(params),
      render: (params) => agentAdapterRef.current.render(params),
      workspaceJson: () => agentAdapterRef.current.workspaceJson(),
      fit: () => agentAdapterRef.current.fit(),
      setAxisRange: (channel, range) => agentAdapterRef.current.setAxisRange(channel, range),
      clearPan: () => agentAdapterRef.current.clearPan(),
      reload: () => agentAdapterRef.current.reload(),
    });
    agentLinkRef.current = new AgentLink({ handler, info: () => agentAdapterRef.current.info(), onStatus: setAgentStatus });
  }
  useEffect(() => {
    agentLinkRef.current?.notifyChanged();
  }, [state]);
  useEffect(() => {
    // A launcher can name the relay on the URL, so GateLabR opens connected.
    const fromUrl = new URLSearchParams(window.location.search).get("agent");
    if (fromUrl && parseAgentUrl(fromUrl)) agentLinkRef.current?.connect(parseAgentUrl(fromUrl)!.toString());
    return () => agentLinkRef.current?.disconnect("closed");
  }, []);

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

    const targets = backgroundGatingSamples.filter((entry) => {
      if (entry.id === activeSampleId) return false;
      const cached = inactiveGatingCacheRef.current.get(entry.id);
      return !cached ||
        cached.sample !== entry.sample ||
        cached.dataRevision !== entry.sample.dataRevision ||
        cached.gateVersion !== state.gate_version;
    });
    setPendingIncludedGatingIds(new Set(targets.map((entry) => entry.id)));

    // Files are gated in batches of up to INACTIVE_GATING_SLICE_MS between paints, with one state
    // update per batch. One file per timer tick re-rendered the whole app once per file, so an edit
    // over an SCE of 224 samples waited on 224 renders while the gating itself took milliseconds.
    let targetIndex = 0;
    const processNext = () => {
      if (generation !== inactiveGatingGenerationRef.current) return;
      if (targetIndex >= targets.length) {
        setPendingIncludedGatingIds(new Set());
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (generation !== inactiveGatingGenerationRef.current) return;
        const done: string[] = [];
        const started = performance.now();
        do {
          const entry = targets[targetIndex++];
          try {
            const gating = recomputeGating(entry.sample, gatingState);
            if (generation !== inactiveGatingGenerationRef.current) return;
            inactiveGatingCacheRef.current.set(entry.id, {
              sample: entry.sample,
              dataRevision: entry.sample.dataRevision,
              gateVersion: state.gate_version,
              gating,
            });
            done.push(entry.id);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        } while (targetIndex < targets.length && performance.now() - started < INACTIVE_GATING_SLICE_MS);
        if (done.length > 0) {
          setInactiveGatingCacheVersion((version) => version + 1);
          setPendingIncludedGatingIds((previous) => {
            const next = new Set(previous);
            for (const id of done) next.delete(id);
            return next;
          });
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
    backgroundGatingSamples,
    samples,
    sampleDataRevisionKey,
    state.gate_version,
    gatingState,
  ]);

  const derived = useMemo(
    () => derivePopulationView(sample, state, viewGating),
    // `viewGating` changes whenever gates/populations change; active/checked ids only select
    // among its cached masks and never need to rerun gate geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample, viewGating, state.active_population_id, state.selected_pop_ids],
  );

  const includedGatingResults = useMemo<readonly GatingDerived[] | null>(() => {
    const results: GatingDerived[] = [];
    for (const entry of includedSamples) {
      if (entry.id === activeSampleId) {
        results.push(viewGating);
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
    viewGating,
    inactiveGatingCacheVersion,
    state.gate_version,
  ]);

  const exportPopulationCountsBySample = useMemo(() => {
    const counts = new Map<string, Readonly<Record<string, number | null>>>();
    for (const entry of samples) {
      if (entry.id === activeSampleId) {
        // Under its own tree, as every other file is below.
        counts.set(entry.id, viewGating.stats.event_count);
        continue;
      }
      // A file that follows a tailored or group copy is counted under that copy, keyed by the
      // live tree's population ids the dialog lists. The background cache holds live-tree masks,
      // so the copy is gated here, and only while the dialog is open.
      const tree = treeStateForFile(entry.id);
      if (tree && !tree.live) {
        if (!fcsExportOpen) continue;
        const own = recompute(entry.sample, tree.treeState).stats.event_count;
        counts.set(entry.id, Object.fromEntries(Object.keys(state.populations).map((popId) => {
          const ownId = populationIdInFileTree(entry.id, popId);
          return [popId, ownId ? own[ownId] ?? null : null];
        })));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    samples,
    activeSampleId,
    viewGating,
    inactiveGatingCacheVersion,
    state.gate_version,
    fcsExportOpen,
    fileHierarchies,
  ]);

  /** A column the app just wrote is offered for colouring, and any values fetched before are dropped. */
  function noteHostCategoricalColumn(columnName: string, levelCount: number): void {
    setHostCategoricalColumns((current) => [
      ...current.filter((column) => column.name !== columnName),
      { name: columnName, levelCount },
    ]);
    setHostCategoricalValues((current) => {
      if (!(columnName in current)) return current;
      const next = { ...current };
      delete next[columnName];
      return next;
    });
  }

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
      // The dialog lists the live tree's populations. Each sample is read under the tree it is
      // gated under: a tailored file from its own copy, the others from the tree.
      const hostedSamples = hostedMembershipSamples(datasetId);
      const reader = hostedMembershipReader(state, hostedSamples);
      const live = reader.trees.find((tree) => tree.active);
      if (!live) throw new Error("The live hierarchy is missing.");
      const columns: GateLabHostPopulationColumn[] = specs.map((spec) => ({
        ...spec,
        sampleMasks: hostedSamples.map((_, index) =>
          hostedSampleMask(reader, hostedSamples, index, live, spec.populationId)),
      }));
      const notEvaluated = notEvaluatedNotes(columns.flatMap(({ sampleMasks }) => sampleMasks));
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
      for (const { columnName } of result.columns) noteHostCategoricalColumn(columnName, 2);
      setImportMsg(
        `Wrote ${result.columns.length} population membership column` +
          `${result.columns.length === 1 ? "" : "s"} to the SCE · ` +
          result.columns
            .map(({ columnName, memberCount }) =>
              `${columnName}: ${memberCount.toLocaleString()}`,
            )
            .join(" · ") +
          notEvaluatedSummary(notEvaluated),
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
        gating: entry.id === activeSampleId ? viewGating : null,
        selection: {
          activeMask: null,
          displayMask: null,
          displayPopCount: 0,
        },
      }];
    }
    const gating = entry.id === activeSampleId
      ? viewGating
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
      viewGating,
      checkedDisplayNeedsGating,
      inactiveGatingCacheVersion,
      state.active_population_id,
      state.selected_pop_ids,
      state.root_population_id,
      state.gate_version,
    ],
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

  // Fetch a categorical column the first time it is chosen; the values then stay for the session
  // unless the app itself rewrites that column.
  useEffect(() => {
    if (overlayBy !== "coldata" || !overlayColDataColumn) return;
    const columnName = overlayColDataColumn;
    if (hostCategoricalValues[columnName] || hostCategoricalLoadingRef.current.has(columnName)) return;
    const datasetId = samples[0]?.hostSource?.datasetId;
    const read = host.colData?.readCategoricalColumn;
    if (!isSceHost || !datasetId || !read) {
      setError("This host cannot supply colData values to colour by.");
      setOverlayBy("none");
      return;
    }
    hostCategoricalLoadingRef.current.add(columnName);
    void read.call(host.colData, {
      contractVersion: GATELAB_HOST_COLDATA_CONTRACT_VERSION,
      datasetId,
      columnName,
    }).then((result) => {
      const bySample: Record<string, Uint8Array | number> = {};
      for (const values of result.sampleValues) {
        bySample[values.sampleId] = typeof values.constantCode === "number"
          ? values.constantCode
          : decodeUint8Base64(values.codesBase64 ?? "");
      }
      setHostCategoricalValues((current) => ({
        ...current,
        [columnName]: {
          levels: [...result.levels],
          ...(result.colors && result.colors.length === result.levels.length
            ? { colors: [...result.colors] }
            : {}),
          bySample,
        },
      }));
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setOverlayBy("none");
    }).finally(() => {
      hostCategoricalLoadingRef.current.delete(columnName);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayBy, overlayColDataColumn, hostCategoricalValues, isSceHost, samples]);
  const overlayColDataValues =
    overlayBy === "coldata" && overlayColDataColumn
      ? hostCategoricalValues[overlayColDataColumn] ?? null
      : null;

  /**
   * The marker overlay's shared colour scale, and the palette it is drawn in.
   *
   * One memo rather than one per consumer, because three places need the SAME scale: the
   * single-file plot payload, the pooled one, and the colour bar beside the plot. A bar reporting
   * a range the events were not coloured against is worse than no bar at all.
   *
   * The scale pools every displayed file that carries the channel, so one colour means one marker
   * level across a pooled display. It is therefore recomputed when the checked set changes, which
   * is deliberate: the bar's numbers must describe the events actually on screen.
   */
  const markerOverlay = useMemo<{
    channelKey: string;
    label: string;
    scale: MarkerColourScale;
    palette: string[];
    power: number;
    ticks?: MarkerColourBarTick[];
  } | null>(() => {
    if (overlayBy !== "channel" || !overlayChannelKey || !sample) return null;
    // Every file that can be drawn beside this one, pooled into one scale. A file that lacks the
    // channel has a different panel identity and is already refused from the pooled display with
    // its own message, so it is skipped here rather than reported a second time.
    const columns: Float32Array[] = [];
    const seen = new Set<string>();
    // The active sample under its own id, so that when it is also among the checked files it is
    // pooled once: pooled twice, its quantiles weighed double in the scale every other file shared.
    for (const entry of [{ id: activeSampleId ?? "__active__", sample }, ...includedSamples]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const index = entry.sample.index(overlayChannelKey);
      if (index === undefined) continue;
      columns.push(entry.sample.displayColumn(index));
    }
    if (columns.length === 0) return null;
    const activeIndex = sample.index(overlayChannelKey);
    const scale = markerColourScale(columns);
    // The bar is labelled by the SAME tick machinery as an axis on this channel, positioned by
    // where each tick actually falls on the ramp. Reading "0.38" beside an axis reading "10K"
    // describes one marker in a language the other does not speak, and a logicle channel puts
    // its decades at uneven fractions, so evenly spaced labels would misplace every one of them.
    const axisTicks = activeIndex === undefined
      ? null
      : sample.channelTicks(activeIndex, [scale.lo, scale.hi]);
    // Positioned through markerColourFraction, the same function that decides an event's colour,
    // so moving the contrast slider moves the labels to where those values now sit on the ramp.
    const inRange = (position: number) => position >= scale.lo && position <= scale.hi;
    const ticks = axisTicks?.major_pos
      .map((position, i) => ({
        position,
        fraction: markerColourFraction(position, scale, markerColorPower),
        label: axisTicks.major_labels[i] ?? "",
      }))
      .filter(({ position, label }) => label !== "" && inRange(position))
      .map(({ fraction, label }) => ({ fraction, label }));
    return {
      channelKey: overlayChannelKey,
      label: activeIndex === undefined ? overlayChannelKey : sample.channelLabel(activeIndex),
      scale,
      palette: markerColourPalette(overlayMarkerPalette),
      power: markerColorPower,
      ...(ticks?.length ? { ticks } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayBy, overlayChannelKey, overlayMarkerPalette, markerColorPower, sample, activeDataRevision, includedSamples, scalesVersion]);

  /**
   * Everything "Colour by" can be set to, in one list so the picker can search across all of it.
   *
   * A spectral panel puts forty-odd channels in here, which is why it is searchable at all: the
   * plain menu that came before was a scroll to the bottom to find CD8. Typing filters on the
   * option's own name and on its group heading, so "channel" reaches every marker.
   */
  const overlayByOptions = useMemo<SearchableOption[]>(() => {
    const options: SearchableOption[] = [{ value: "none", label: t("None") }];
    if (samples.length > 1) options.push({ value: "sample", label: t("Sample") });
    options.push({ value: "population", label: t("Population") });
    if (activeSampleId && compatibleDivisionProfiles[activeSampleId]) {
      options.push({ value: "division", label: t("Division") });
    }
    if (sample) {
      for (const [i, channel] of sample.channels.entries()) {
        options.push({
          value: `channel:${channel.key}`,
          label: sample.channelLabel(i),
          group: t("Channel"),
        });
      }
    }
    if (isSceHost) {
      for (const column of hostCategoricalColumns) {
        options.push({
          value: `coldata:${column.name}`,
          label: `${column.name} (${column.levelCount})`,
          group: t("colData"),
        });
      }
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, samples.length, activeSampleId, compatibleDivisionProfiles, sample, panelVersion,
      isSceHost, hostCategoricalColumns]);

  /**
   * A channel the workspace no longer has is not a colouring, it is a stale pick. Clear it rather
   * than leaving "Colour by: CD4" selected over a plot drawn in one flat colour.
   */
  useEffect(() => {
    if (overlayBy !== "channel") return;
    if (!sample || !overlayChannelKey) return;
    if (sample.index(overlayChannelKey) === undefined) {
      setOverlayChannelKey(null);
      setOverlayBy("none");
    }
  }, [overlayBy, overlayChannelKey, sample]);

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
    if (overlayBy === "channel") {
      if (!markerOverlay) return null;
      const idx = sample.index(markerOverlay.channelKey);
      if (idx === undefined) return null;
      // No labels: 256 of them is not a key, it is a wall. The colour bar below the plot carries
      // the channel name and the ends of the scale instead.
      return {
        colors: markerColourLevels(sample.displayColumn(idx), markerOverlay.scale, markerOverlay.power),
        palette: markerOverlay.palette,
        labels: [],
      };
    }
    if (overlayBy === "coldata") {
      const sampleId = activeEntry?.hostSource?.sampleId;
      const codes = sampleId !== undefined ? overlayColDataValues?.bySample[sampleId] : undefined;
      if (!overlayColDataValues || codes === undefined) return null;
      const missing = overlayColDataValues.levels.length;
      const colors = new Uint8Array(n);
      for (let e = 0; e < n; e++) {
        const code = typeof codes === "number" ? codes : codes[e];
        colors[e] = code === 255 || code === undefined ? missing : code;
      }
      return {
        colors,
        palette: [...categoricalPalette(overlayColDataValues, overlayPalette), UNGATED_COLOR],
        labels: [...overlayColDataValues.levels, "missing"],
      };
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
  }, [sample, activeDataRevision, overlayBy, overlayPalette, fileName, state.populations, state.root_population_id, state.gate_version, derived, activeSampleId, compatibleDivisionProfiles, activeEntry, overlayColDataValues, markerOverlay]);

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
          showUnownedGates,
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
      state.selected_gate_ids, branchGatesOnly, showUnownedGates,
    ],
  );


  const workspaceAutomaticRanges = useMemo(() => {
    if (
      !sample ||
      !activeXChannelKey ||
      !activeYChannelKey ||
      !activeWorkspaceScaleContextKey
    ) return null;
    const xIndex = sample.index(activeXChannelKey);
    const yIndex = sample.index(activeYChannelKey);
    if (xIndex === undefined || yIndex === undefined) return null;
    // "Unlocked" means the blue file fits the plot area. In a pooled display that same blue file
    // supplies the axes, so its frame remains the deterministic reference until the user locks it.
    const inputs: CombinedSamplePlotInput[] = [{
      id: activeSampleId ?? "active",
      name: fileName,
      sample,
      xIndex,
      yIndex,
      mask: null,
    }];
    return buildWorkspaceAxisRanges(inputs);
  }, [
    sample,
    activeSampleId,
    fileName,
    sampleDataRevisionKey,
    activeXChannelKey,
    activeYChannelKey,
    activeWorkspaceScaleContextKey,
    scalesVersion,
    instrumentMode,
  ]);

  const primaryPanelKey = useMemo(
    () => (sample ? panelKeyOf(sample) : null),
    [sample, panelKeyOf],
  );

  /** Selected files left out of the pool because their panel, or their assay layer, differs from the viewed file's. */
  const panelMismatchNames = plotPool?.otherPanel ?? [];
  const layerMismatchNames = plotPool?.otherLayer ?? [];

  // The plot pools every compatible checked file, so the counts on its gate labels pool the
  // same files. A per-file count under the pooled cloud misleads: a blue file with no events in
  // a region reads 0% beneath a cloud drawn from the others. The contributor filter mirrors the
  // cloud's (scale context, panel, both axes present). Null keeps the blue file's own counts,
  // which are exact whenever that file is the only one drawn.
  const pooledGateCounts = useMemo(() => {
    // Pooled, the counts pool even over one file or none, so the labels, the gate list and the
    // tree agree with the plot; alone, the viewed file's own counts are exact.
    if (!sample || (!poolSelection && includedSamples.length < 2)) return null;
    const xName = sample.channels[xIdx].key;
    const yName = sample.channels[yIdx].key;
    const contributors = includedSamples.filter((entry) =>
      entry.sample.workspaceScaleContextKey === activeWorkspaceScaleContextKey &&
      panelKeyOf(entry.sample) === primaryPanelKey &&
      entry.sample.index(xName) !== undefined &&
      entry.sample.index(yName) !== undefined);
    if (contributors.length === 0) return poolSelection ? { counts: aggregateGateCounts(state.gates, []), fileCount: 0 } : null;
    if (contributors.length === 1 && contributors[0].id === activeSampleId) return null;
    const inputs: PooledGateCountInput[] = [];
    for (const entry of contributors) {
      let gating: GatingDerived | undefined;
      if (entry.id === activeSampleId) {
        gating = gatingDerived ?? undefined;
      } else {
        const cached = inactiveGatingCacheRef.current.get(entry.id);
        if (
          cached &&
          cached.sample === entry.sample &&
          cached.dataRevision === entry.sample.dataRevision &&
          cached.gateVersion === state.gate_version
        ) gating = cached.gating;
      }
      // Still being gated in the background: report the scope as the blue file until it lands.
      if (!gating) return { counts: null, fileCount: contributors.length };
      inputs.push({
        gateMasks: gating.gateMasks,
        activeMask: derivePopulationDisplaySelection(entry.sample, state, gating).activeMask,
        eventCount: entry.sample.fcs.nEvents,
      });
    }
    return { counts: aggregateGateCounts(state.gates, inputs), fileCount: contributors.length };
    // The inactive-file masks live in a ref; inactiveGatingCacheVersion is their change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sample, poolSelection, includedSamples, xIdx, yIdx, activeWorkspaceScaleContextKey, panelKeyOf,
    primaryPanelKey, activeSampleId, gatingDerived, inactiveGatingCacheVersion,
    state.gate_version, state.gates, state.active_population_id, state.selected_pop_ids,
    state.root_population_id,
  ]);
  const gateCountScope = useMemo(() => {
    if (!pooledGateCounts) return null;
    const count = pooledGateCounts.fileCount;
    return pooledGateCounts.counts
      ? {
          text: t("pooled"),
          hint: t("Pooled over {count} files: events inside the gate as a share of the active population, both summed across those files.", { count }),
          listText: t("pooled · {count} FCS", { count }),
        }
      : {
          text: t("blue file only"),
          hint: t("Counts from the axes file alone while the other pooled files are gated in the background; the plot pools {count} files.", { count }),
          listText: t("blue file only · pooling…"),
        };
  }, [pooledGateCounts, t]);
  const labelGateCounts = pooledGateCounts?.counts ?? derived.gateCounts;
  // While a gate is being fitted to its events, the plot draws the fit in its place, labelled
  // with the fit's own count; the stored gate is untouched until Apply.
  const plottedGates = useMemo(
    () => (fitGate?.result ? { ...state.gates, [fitGate.gateId]: fitGate.result.gate } : state.gates),
    [state.gates, fitGate],
  );
  const plottedGateCounts = useMemo(() => {
    if (!fitGate?.result) return labelGateCounts;
    const r = fitGate.result;
    return {
      ...labelGateCounts,
      [fitGate.gateId]: { event_count: r.held, percent_of_parent: r.population > 0 ? Math.round((10000 * r.held) / r.population) / 100 : null },
    };
  }, [labelGateCounts, fitGate]);
  const gateListDerived = useMemo<Derived>(
    () => pooledGateCounts?.counts ? { ...derived, gateCounts: pooledGateCounts.counts } : derived,
    [derived, pooledGateCounts],
  );

  const mainPlotGates = useMemo(() => {
    if (!sample) return [];
    const xKey = sample.channels[xIdx].key;
    const yKey = sample.channels[yIdx].key;
    return buildPlotGates(
      sample,
      plottedGates,
      branchGateOrder,
      plottedGateCounts,
      xKey,
      yKey,
      gateCountScope && { text: gateCountScope.text, hint: gateCountScope.hint },
      // The ranges the plot shows (per-view, explicit workspace scale, automatic frame), so a
      // curly quadrant's arms reach the edge of the plot rather than the edge of the data.
      [
        xRange ?? globalScales[xKey] ?? workspaceAutomaticRanges?.xRange ?? null,
        yRange ?? globalScales[yKey] ?? workspaceAutomaticRanges?.yRange ?? null,
      ],
    );
    // activeDisplayContextKey and scalesVersion are load-bearing: buildPlotGates converts
    // each gate out of raw space with the CURRENT transform, so without them the gate keeps
    // display coordinates computed under the previous scatter cofactor or scale while the
    // event cloud and the axis both move to the new one. The gate then appears to slide off
    // its own events even though membership, evaluated in raw space, never changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, plottedGates, branchGateOrder, plottedGateCounts, gateCountScope, xIdx, yIdx, activeDisplayContextKey, scalesVersion, xRange, yRange, globalScales, workspaceAutomaticRanges]);

  /**
   * The Gating tab's axis range for every channel of the viewed file: its explicit workspace
   * scale where one is set, else the automatic frame the Gating tab would fit for it. The
   * Illustration tab draws a channel on this under "As on the Gating tab", so it matches the
   * Gating tab whether or not the user has touched that channel's scale. Computed only while
   * the Illustration tab is open: it walks every channel's events.
   */
  // Kept across tab switches: the walk over every channel's events is repeated only when the
  // file, its data or the scales change, not each time the tab is shown.
  const figureGatingRangesCache = useRef<{ key: string; value: Record<string, [number, number]> } | null>(null);
  const figureGatingRanges = useMemo(() => {
    const out: Record<string, [number, number]> = {};
    if (!sample || (activeTab !== "illustration" && activeTab !== "layout")) return out;
    const key = JSON.stringify([activeSampleId, fileName, sampleDataRevisionKey, scalesVersion, instrumentMode, globalScales]);
    if (figureGatingRangesCache.current?.key === key) return figureGatingRangesCache.current.value;
    sample.channels.forEach((channel, idx) => {
      const explicit = globalScales[channel.key];
      if (explicit) { out[channel.key] = explicit; return; }
      const auto = buildWorkspaceAxisRanges([{ id: activeSampleId ?? "active", name: fileName, sample, xIndex: idx, yIndex: idx, mask: null }]);
      if (auto) out[channel.key] = auto.xRange;
    });
    figureGatingRangesCache.current = { key, value: out };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, activeSampleId, fileName, sampleDataRevisionKey, globalScales, scalesVersion, instrumentMode, activeTab]);

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
      plotMode,
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
      // Pooling files whose PANELS differ is refused outright, not silently narrowed to the
      // channels they happen to share. Two panels can carry the same channel name for different
      // markers, so a shared name is not evidence of a shared measurement — pooling on it draws
      // one cloud from two different stains, and gates drawn on it mean nothing in either. The
      // header's contributor count reports what this dropped.
      if (panelKeyOf(entry.sample) !== primaryPanelKey) return [];
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
    } else if (overlayBy === "channel" && markerOverlay) {
      // One scale for every file (markerOverlay pools them), so a colour means the same marker
      // level in each. A file that does not carry the channel contributes no colouring at all:
      // painting it at level 0 would read as "uniformly negative for this marker", which is a
      // claim about the data rather than about the panel.
      colorPalette = markerOverlay.palette;
      colorLabels = [];
      compatible.forEach(({ entry }, index) => {
        const channelIndex = entry.sample.index(markerOverlay.channelKey);
        if (channelIndex === undefined) {
          inputs[index].colorIndex = MARKER_MISSING_LEVEL;
          return;
        }
        const values = entry.sample.displayColumn(channelIndex);
        inputs[index].colorAt = (eventIndex) =>
          markerColourLevel(values[eventIndex], markerOverlay.scale, markerOverlay.power);
      });
    } else if (overlayBy === "coldata" && overlayColDataValues) {
      const column = overlayColDataValues;
      const missing = column.levels.length;
      colorPalette = [...categoricalPalette(column, overlayPalette), UNGATED_COLOR];
      colorLabels = [...column.levels, "missing"];
      compatible.forEach(({ entry }, index) => {
        const sampleId = entry.hostSource?.sampleId;
        const codes = sampleId !== undefined ? column.bySample[sampleId] : undefined;
        if (codes === undefined) {
          inputs[index].colorIndex = missing;
        } else if (typeof codes === "number") {
          inputs[index].colorIndex = codes === 255 ? missing : codes;
        } else {
          inputs[index].colorAt = (eventIndex) => {
            const code = codes[eventIndex];
            return code === 255 || code === undefined ? missing : code;
          };
        }
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
    plotMode,
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
    markerOverlay,
    includedDisplaySelections,
    pendingIncludedGatingIds,
    activeSampleId,
    state.root_population_id,
    state.populations,
    compatibleDivisionProfiles,
    overlayColDataValues,
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
    gates: state.gates, snapToGates,
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
    if (!sample || !workspaceAutomaticRanges || !activeAxisScaleContextKey) return;
    const pendingRestore = pendingFitOnLoad.current;
    if (pendingRestore) {
      // Workspace open and this passive fit race each other. Wait until the contextual cache has
      // actually put the saved map on screen; otherwise the old workspace's map (or an empty one)
      // can be fitted and written over the restored values in the same commit.
      if (
        pendingRestore.contextKey !== activeAxisScaleContextKey ||
        !sameGlobalScales(globalScales, pendingRestore.ranges)
      ) return;
      pendingFitOnLoad.current = null;
    }
    const bindingKeyFor = (key: string): string | null => {
      try {
        // Locked comparisons share coordinates even across file-specific compensation profiles.
        // Unlocked auto-fit must still notice a new assay result on the same file.
        return JSON.stringify([key, sample.transformSpec(key), lockScalesBetweenFiles ? null : sample.activeAssayBindingKey]);
      } catch {
        return null;
      }
    };
    const xKey = sample.channels[xIdx]?.key;
    const yKey = sample.channels[yIdx]?.key;
    if (!xKey || !yKey) return;

    // Discard auto-fits whose channel has since been re-transformed, and allow their pairs to
    // fit again at the new transform.
    const stale: string[] = [];
    for (const key of [xKey, yKey]) {
      const fittedUnder = autoFittedScales.current.get(
        autoFittedScaleKey(activeAxisScaleContextKey, key),
      );
      if (!fittedUnder) continue;
      const current = bindingKeyFor(key);
      if (current !== null && current !== fittedUnder) stale.push(key);
    }
    if (stale.length) {
      for (const key of stale) {
        autoFittedScales.current.delete(autoFittedScaleKey(activeAxisScaleContextKey, key));
      }
      for (const pair of [...fittedAxisPairs.current]) {
        try {
          const [context, pairX, pairY] = JSON.parse(pair) as [string, string, string];
          if (
            context === activeAxisScaleContextKey &&
            stale.some((key) => key === pairX || key === pairY)
          ) fittedAxisPairs.current.delete(pair);
        } catch {
          fittedAxisPairs.current.delete(pair);
        }
      }
      setGlobalScales((prev) => {
        const next = { ...prev };
        for (const key of stale) delete next[key];
        return next;
      });
      return; // refit on the next pass, once the cleared map has committed
    }

    const pairKey = JSON.stringify([activeAxisScaleContextKey, xKey, yKey]);
    if (fittedAxisPairs.current.has(pairKey)) return;
    // Marked fitted on first sight even when the plot has no gates yet, so that later drawing
    // or editing a gate cannot trigger a fit: the viewport invariant is that gate edits never
    // rescale. Fitting belongs to arriving at a plot, not to changing what is on one.
    fittedAxisPairs.current.add(pairKey);

    const axes = [
      { key: xKey, idx: xIdx, auto: workspaceAutomaticRanges.xRange, axis: "x" as const },
      { key: yKey, idx: yIdx, auto: workspaceAutomaticRanges.yRange, axis: "y" as const },
    ];
    for (const { key, idx, auto, axis } of axes) {
      const fittedKey = autoFittedScaleKey(activeAxisScaleContextKey, key);
      if (globalScales[key] && (lockScalesBetweenFiles || !autoFittedScales.current.has(fittedKey))) continue;
      const binding = bindingKeyFor(key);
      if (binding) autoFittedScales.current.set(fittedKey, binding);
      const range = includePlotGatesInAxisRange(
        auto ?? sample.displayRange(idx),
        mainPlotGates,
        axis,
      );
      setGlobalScales((previous) => ({ ...previous, [key]: range }));
    }
  }, [
    sample, workspaceAutomaticRanges, mainPlotGates, xIdx, yIdx, globalScales,
    activeAxisScaleContextKey, scalesVersion, setGlobalScales, lockScalesBetweenFiles,
  ]);

  /** Fit both axes to the robust event distribution plus every gate drawn on them. */
  /** Both axes back to their automatic range in the current scale mode. */
  const resetAxisRanges = useCallback(() => {
    if (!sample) return;
    setXRange(null);
    setYRange(null);
    setGlobalScale(sample.channels[xIdx].key, null);
    setGlobalScale(sample.channels[yIdx].key, null);
  }, [sample, xIdx, yIdx, setGlobalScale]);
  /**
   * The menu a right-click on the plot opens, away from a vertex or an edge, which the renderer
   * answers with its own: the plot's actions, otherwise spread over the toolbars above and
   * below it, at the pointer.
   */
  const plotContextItems = (): MenuEntry[] => [
    ...(LAYOUT_TAB_AVAILABLE
      ? [
          {
            label: t("Add to Layout"),
            title: t("Put this plot, of this file and population, on the Layout tab, where it can be drawn once per file or once per population"),
            disabled: !activeSampleId || !state.active_population_id,
            onClick: addCurrentPlotToLayout,
          },
          "separator" as const,
        ]
      : []),
    {
      label: t("Fit data + gates"),
      title: t("Fit the current view to the robust event distribution and every gate on these axes"),
      onClick: fitDataAndGates,
    },
    {
      label: t("Reset axis ranges"),
      title: t("Reset X/Y to auto range in the current scale mode"),
      onClick: resetAxisRanges,
    },
    {
      label: t("Swap X and Y"),
      title: t("Show the Y channel on X and the X channel on Y; the gates stay as they are"),
      disabled: xIdx === yIdx,
      onClick: () => { setXIdx(yIdx); setYIdx(xIdx); },
    },
    "separator",
    ...DRAW_TOOLS.filter((tool) => tool.id !== "navigate").map((tool) => ({
      label: t(tool.title.split(" — ")[0]),
      title: drawingBlocked ? t("This tree follows its group's template — add gates there, or unlink it from its group") : t(tool.title),
      disabled: drawingBlocked,
      className: drawMode === tool.id ? "is-active" : undefined,
      onClick: () => setDrawMode(tool.id),
    })),
  ];
  /** The fit of a gate at the given settings, on the active file's events of the plotted population. */
  const computeGateFit = useCallback((gateId: string, settings: FitGateSettings): FitGateResult | null => {
    const gate = state.gates[gateId];
    if (!sample || !gate) return null;
    return fitGateToEvents(gate, sample, derived.activeMask, settings);
  }, [sample, state.gates, derived.activeMask]);
  const openFitGate = (gateId: string, at: [number, number], box?: [number, number, number, number]) => {
    const gate = state.gates[gateId];
    if (!sample || !activeSampleId || !gate) return;
    // A polygon opens at its own vertex count, so the fit changes where the gate sits, not
    // what kind of shape it is; the slider is there for more or fewer.
    const settings = clampFitSettings({
      ...FIT_GATE_DEFAULTS,
      maxVertices: gate.gate_type === "polygon" ? gate.vertices.length : FIT_GATE_DEFAULTS.maxVertices,
    });
    setFitGate({
      gateId,
      at,
      box,
      settings,
      result: computeGateFit(gateId, settings),
      sampleId: activeSampleId,
      populationId: state.active_population_id,
      gateVersion: state.gate_version,
    });
  };
  // The slider moves at once; the fit, which walks every event of the gate, is recomputed at
  // most once per frame with the latest settings, so a drag redraws the gate as it goes
  // without queueing a fit for every pixel.
  const fitFrame = useRef<number | null>(null);
  const fitLatest = useRef<FitGateSettings | null>(null);
  const changeFitGate = (settings: FitGateSettings) => {
    fitLatest.current = settings;
    setFitGate((current) => (current ? { ...current, settings } : current));
    if (fitFrame.current !== null) return;
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = null;
      const latest = fitLatest.current;
      if (!latest) return;
      setFitGate((current) => (current ? { ...current, settings: latest, result: computeGateFit(current.gateId, latest) } : current));
    });
  };
  const applyFitGate = () => {
    const fitted = fitGate?.result?.gate;
    setFitGate(null);
    if (!fitted) return;
    // Through the edits a drag makes: one Undo step, membership recomputed, the label updated.
    if (fitted.gate_type === "ellipse") {
      dispatch({ type: "reshapeEllipse", gateId: fitted.gate_id, mean: fitted.mean, covariance: fitted.covariance });
    } else if (fitted.gate_type !== "quadrant") {
      dispatch({ type: "editGate", gateId: fitted.gate_id, vertices: fitted.vertices });
    }
  };
  // The fit is of one file's events within one population, at one state of the gates: a change
  // to any of them closes the panel rather than showing a fit of something else.
  useEffect(() => {
    if (fitGate && (fitGate.sampleId !== activeSampleId || fitGate.populationId !== state.active_population_id || fitGate.gateVersion !== state.gate_version)) {
      setFitGate(null);
    }
  }, [fitGate, activeSampleId, state.active_population_id, state.gate_version]);

  const fitDataAndGates = useCallback(() => {
    if (!sample) return;
    const xKey = sample.channels[xIdx]?.key;
    const yKey = sample.channels[yIdx]?.key;
    if (!xKey || !yKey) return;
    setGlobalScale(xKey, includePlotGatesInAxisRange(
      workspaceAutomaticRanges?.xRange ?? sample.displayRange(xIdx), mainPlotGates, "x"));
    setGlobalScale(yKey, includePlotGatesInAxisRange(
      workspaceAutomaticRanges?.yRange ?? sample.displayRange(yIdx), mainPlotGates, "y"));
    setXRange(null);
    setYRange(null);
  }, [sample, xIdx, yIdx, workspaceAutomaticRanges, mainPlotGates, setGlobalScale]);

  /**
   * Fit a set of CHANNELS to their data plus the gates drawn on them.
   *
   * The Gating tab's Fit fits the two axes on screen. The Strategy and Illustration grids show
   * many plots at once, and a channel can be the x of one panel and the y of another, so the fit
   * there is per channel and takes gates from both orientations.
   */
  const fitChannels = useCallback((keys: readonly string[]) => {
    if (!sample) return;
    // Only gates that are ON one of the plots being fitted. The button says "fit every plot
    // shown here to its data and the gates on it", and the Gating tab's fit means exactly that:
    // buildPlotGates gives it the gates for the two channels on screen and nothing else.
    //
    // This gathered every gate in the workspace that touched the channel, in either orientation.
    // A channel used by a plot that is NOT shown -- Time, or a scatter axis paired with something
    // else further down the strategy -- brought its gate's coordinates along, and because a fit
    // only ever expands a range, one gate sitting below the data stretched the axis down and
    // pressed the events into the top of the plot. Which is the opposite of fitting.
    const shown = new Set(keys);
    for (const key of shown) {           // the Set also dedupes a channel used by several plots
      const idx = sample.index(key);
      if (idx === undefined) continue;
      const coords: number[] = [];
      for (const gate of Object.values(state.gates)) {
        if (!shown.has(gate.x_channel) || !shown.has(gate.y_channel)) continue;
        for (const axis of ["x", "y"] as const) {
          const channel = axis === "x" ? gate.x_channel : gate.y_channel;
          if (channel !== key) continue;
          const points = gate.gate_type === "quadrant"
            ? [gate.center]
            : gate.gate_type === "ellipse"
              ? ellipseBoundary(gate, 16)
              : (gate.vertices as [number, number][]);
          for (const point of points) {
            if (!point) continue;
            const value = axis === "x" ? point[0] : point[1];
            // A rectangle side with no bound is drawn past every event; fitting to it would
            // press the data into a corner.
            if (isUnbounded(sample.gateToRaw(gate, key, value))) continue;
            // The gate's own transform, so raw-space and display-space gates on the same
            // channel both land where they are actually drawn.
            coords.push(sample.gateToDisplay(gate, key, value));
          }
        }
      }
      setGlobalScale(key, fitChannelAxisRange(sample.displayRange(idx), coords));
    }
  }, [sample, state.gates, setGlobalScale]);

  // Switching a scatter axis between arcsinh and linear rewrites that channel's display
  // coordinates wholesale -- events that sat at 8.6 now sit at 250000 -- so a range fitted under
  // the old transform describes nothing. The auto-fit effect above is supposed to notice via the
  // binding key, but it defers to any range already in globalScales, and a pan or stretch commits
  // one there; after the user has touched the view even once, the switch left the axis pinned to
  // the old frame with the data collapsed against one edge. Refit explicitly instead of relying
  // on that, and do it in an effect so the automatic ranges have recomputed at the new transform
  // first -- computing them in the change handler would fit to the scale being replaced.
  const pendingScaleRefit = useRef(false);
  useEffect(() => {
    if (!pendingScaleRefit.current) return;
    // Nothing to fit against -- no sample, or the channels are not both present. Clear the
    // intent rather than holding it: the flag also suppresses painting (see `displayed`), so a
    // request that can never be satisfied would freeze the plot instead of merely deferring it.
    if (!workspaceAutomaticRanges) {
      pendingScaleRefit.current = false;
      return;
    }
    pendingScaleRefit.current = false;
    fitDataAndGates();
  }, [scalesVersion, workspaceAutomaticRanges, fitDataAndGates]);

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

  /**
   * The last frame actually handed to the renderer, so a known-bad one can be skipped.
   *
   * Changing an axis transform rewrites that channel's display coordinates immediately, but the
   * axis range is refitted in an effect -- deliberately, because the automatic ranges have to
   * recompute at the new transform first. That leaves exactly one render in between whose data
   * and gates are in the NEW coordinates while its range is still the OLD frame, and it paints:
   * that is the flash of a wildly misshapen gate before the plot settles. The frame is known to
   * be wrong before it is drawn, so it is simply not drawn -- the previous frame stays up for
   * one tick and the refitted one replaces it.
   */
  const lastDisplayed = useRef<Record<string, unknown> | null>(null);
  const displayed = useMemo(() => {
    if (!payload || !sample) return payload;
    if (pendingScaleRefit.current && lastDisplayed.current) return lastDisplayed.current;
    const lbl = (k: string) => sample.labelForKey(k);
    // Everything that changes what is drawn on the canvas, as opposed to over it.
    const sig = JSON.stringify([
      payload.x_label, payload.y_label, payload.x_range, payload.y_range,
      payload.display_mode, payload.n_events, payload.contour_threshold,
      payload.x_binding ?? null, payload.y_binding ?? null,
      pointAlpha, pointSize, contourLevels, densityColorPower,
    ]);
    const prev = lastSentPayload.current;
    const gatesOnly =
      prev !== null && prev.sig === sig &&
      prev.x === payload.x_b64 && prev.y === payload.y_b64;
    lastSentPayload.current = { x: payload.x_b64, y: payload.y_b64, sig };
    const out = {
      ...(gatesOnly ? { gates_only: true } : {}),
      gate_edge_mode: gateEdgeMode,
      snap_to_gates: snapToGates,
      ...payload,
      point_alpha: pointAlpha, // user-adjustable opacity (was frozen at the payload's 0.4)
      point_size: pointSize, // mark radius only; density colouring is computed on a fixed grid
      contour_levels: contourLevels,
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
    lastDisplayed.current = out;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, sample, panelVersion, pointAlpha, pointSize, contourLevels, densityColorPower, gateEdgeMode, snapToGates]);

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
        {/* Hovering the name explains what the app is and, more usefully, the one design choice
            that makes its numbers differ from FlowJo's. That divergence is deliberate and worth
            stating where someone comparing two tools will actually find it. Focusable so it is
            reachable from the keyboard, not only on hover. */}
        <span className="gl-brand" tabIndex={0}>
          {/* The logo: the three plots as the mark, then the wordmark, both cut from the artwork.
              GateLabR has its own wordmark and logo, the same plots with an orange R. */}
          <img className="gl-brand-mark" src={brandMark} alt="" />
          {isSceHost
            ? <img className="gl-brand-wordmark" src={brandWordmarkR} alt="GateLabR" />
            : <img className="gl-brand-wordmark" src={brandWordmark} alt="GateLab" />}
          <span className="gl-brand-card" role="tooltip">
            <img className="gl-brand-card-logo" src={isSceHost ? brandLogoR : brandLogo} alt="" />
            <span className="gl-brand-card-head">
              {/* The version is the app's. Under the R host it is the embedded core's, and is said
                  to be: the package has a version of its own, which the host does not send. */}
              {isSceHost ? `GateLabR · GateLab core v${pkg.version}` : `GateLab v${pkg.version}`}
              <span className="gl-brand-card-by">{t("Developed by David Priest")}</span>
            </span>
            <p>
              {isSceHost
                ? t("Manual gating for a SingleCellExperiment, in the browser from an R session. The object's samples are the files; gates, populations and scales are saved back into it, and memberships can be written to colData.")
                : t("A browser-based gating tool for flow and mass cytometry. Files never leave the machine: every FCS is parsed, transformed and gated locally, and a workspace is saved as one self-contained .gatelab bundle.")}
            </p>
            <p>
              <b>{t("Gates live in raw channel values.")}</b>{" "}
              {t("A display scale is chosen per channel: linear or arcsinh for scatter, logicle or arcsinh for fluorescence, arcsinh at cofactor 5 for mass cytometry. Gates are stored and evaluated in raw values regardless, so nothing done to an axis can move an event in or out of a gate; a gate drawn straight in raw values looks bowed on a transformed axis, which the gate-edge control shows rather than hides. FlowJo and Gating-ML 2.0 take the other view, a polygon straight in the space the axis shows, and the exports write the gate as each of them expects it.")}
            </p>
            <p>
              <b>{t("One tree, tailored per file.")}</b>{" "}
              {t("A workspace holds one tree: its populations and gates apply to every file. An edit changes the tree for every file, or, with \"this file only\", tailors a gate's coordinates for the viewed file alone until it is reverted or applied back to the tree. The tree's structure is the same for every file; a different tree belongs in a different workspace.")}
            </p>
            <p>
              <b>{t("Beyond the Gating tab.")}</b>{" "}
              {t("Strategy draws the back-gated path to a population; Illustration composes figures over files, populations and channels, pooled or overlaid, with their gates; Layout places plots and text on a page and exports it; Plotting charts composition by file or metadata; Compensation takes an embedded or imported matrix; Metadata, Panel, Scales and Statistics hold the rest.")}
            </p>
            <p>
              <b>{t("Interchange.")}</b>{" "}
              {t("FlowJo workspaces (.wsp) and Gating-ML 2.0 import and export, checked against FlowJo, Cytobank and CytoML on real files; a FACSDiva or FACSChorus experiment imports, and a FACSChorus .cef exports with the tree written back for the sorter. Cytobank reads only linear, log and arcsinh scales, so a logicle gate is traced for it and the export dialog says what was traced. Check an exported file rather than trusting it, and please report anything that does not survive a round trip.")}
            </p>
            <p>
              <b>{t("Getting started.")}</b>{" "}
              {isSceHost
                // The R host has no tutorial and no demo workspace; its guide is the package's.
                ? t("The Getting started guide on the documentation site (david-priest.github.io/GateLabR) covers a first session, and an AI agent can draw gates through the MCP server (Agent in the header, or launchGatingApp(agent = TRUE)).")
                : t("Tutorial in the header walks through a demo workspace, and an AI agent can draw gates through the MCP server (Agent in the header).")}
            </p>
          </span>
        </span>
        <nav className="gl-header-menus" aria-label={t("Workspace, import and export")}>
          {isSceHost ? (
            <MenuButton
              label="R host"
              items={[
                {
                  label: `Save to SCE${dirty ? " ●" : ""}`,
                  title: "Save gates, populations, scales, and display settings into the R SingleCellExperiment",
                  disabled: !sample || !host.workspaces || hostWorkspaceStatus === "saving",
                  onClick: saveToSce,
                },
                ...(host.capabilities.dataModel.writeBackColumns && host.colData
                  ? [{
                      label: "Export populations to colData…",
                      title: "Write exact full-data population memberships into SingleCellExperiment colData",
                      disabled: !sample || hostColDataBusy || Object.keys(state.populations).length <= 1,
                      onClick: () => setCrud({ kind: "exportSceColData" }),
                    }]
                  : []),
              ]}
            />
          ) : (
            <MenuButton
              label={t("Workspace")}
              className="gl-tour-workspace-menu"
              items={[
                {
                  label: t("New Workspace…"),
                  title: "Close the current data, gates, and workspace settings and begin an empty workspace",
                  disabled: busy || !sample || compensationApplyStatus !== null,
                  onClick: () => setCrud({ kind: "confirmNewWorkspace" }),
                },
                {
                  label: t("Open Workspace…"),
                  title: "Open a saved .gatelab workspace, a FlowJo .wsp, or a FACSChorus .cef. FlowJo and FACSChorus files hold gates rather than event data, so GateLab will ask for the corresponding FCS.",
                  disabled: busy || compensationApplyStatus !== null,
                  onClick: openWorkspace,
                },
                // The workspaces opened or saved lately, from the browser's store of file handles;
                // the browser asks for the file again on reopening.
                ...recentWorkspaces.slice(0, 5).map((recent) => ({
                  label: t("Recent: {name}", { name: recent.name }),
                  title: t("Reopen {name}, last used {when}; the browser will ask to allow the file again", { name: recent.name, when: new Date(recent.at).toLocaleString() }),
                  className: "gl-menu-recent",
                  disabled: busy || compensationApplyStatus !== null,
                  onClick: () => void openRecentWorkspace(recent),
                })),
                {
                  label: t("Open the demo workspace"),
                  className: "gl-open-demo",
                  title: `Open the demo workspace this copy of GateLab ships with, the one the tutorial walks through. ${DEMO_WORKSPACE_CITATION.short}`,
                  disabled: busy || compensationApplyStatus !== null,
                  onClick: () => void openDemoWorkspace(),
                },
                {
                  label: wsHandle ? `${t("Save")}${dirty ? " ●" : ""}` : t("Save Workspace…"),
                  title: wsHandle
                    ? wsStorage === "bundle"
                      ? "Save changes in place while preserving the embedded FCS data"
                      : "Save gates/populations/scales/compensation back to the linked workspace file (in place)"
                    : "Choose a location and save the workspace",
                  disabled: !sample,
                  onClick: saveWorkspace,
                },
                {
                  label: t("Save As…"),
                  title: "Save a lightweight reference workspace. Source FCS and compensated values are not embedded; use Save Portable Copy for a self-contained archive.",
                  disabled: !sample,
                  onClick: saveWorkspaceAs,
                },
                {
                  label: t("Save Portable Copy…"),
                  title: "Save a self-contained .gatelab with the exact source FCS and any computed compensated assay, so it can reopen without rerunning compensation.",
                  disabled: !sample,
                  onClick: saveBundledCopy,
                },
                "separator",
                {
                  label: t("Revert workspace…"),
                  className: "gl-revert-workspace",
                  title: "Go back to an earlier state of this workspace: as it was opened, or any checkpoint GateLab kept in this browser. The current state is kept as a checkpoint first.",
                  disabled: !sample || busy || isSceHost,
                  onClick: () => void openRevertDialog(),
                },
                "separator",
                {
                  label: t("Clear gates and populations…"),
                  className: "gl-clear-gating",
                  title: "Remove every gate, population and hierarchy and start gating again on the same files. Scales, compensation and metadata are kept, and Undo brings the gating back.",
                  disabled: !sample || (Object.keys(state.gates).length === 0 && state.hierarchies.length < 2 && Object.keys(state.populations).length < 2),
                  onClick: () => setClearGatingConfirmOpen(true),
                },
              ]}
            />
          )}
          <MenuButton
            label={t("Import")}
            disabled={!sample}
            items={[
              {
                label: t("Import gating (GatingML / FlowJo / FACSChorus)…"),
                title: "Import Gating-ML 2.0 (.xml), a FlowJo workspace (.wsp) or a FACSChorus experiment (.cef), then choose whether to merge into the current hierarchy or replace the current strategy. A workspace carries population names, which FlowJo's own Gating-ML export omits; a Chorus experiment carries the gates as they are now and a snapshot per sort.",
                onClick: () => void pickFilesOrInput(xmlRef.current, GATING_IMPORT_ACCEPT, "Gating-ML or FlowJo workspace").then((files) => { if (files?.[0]) prepareGatingImport(files[0]); }),
              },
              {
                label: `${t("Import gates recorded in the loaded files…")}${loadedChorusRecordings.length ? ` (${loadedChorusRecordings.length})` : ""}`,
                title: "Every FCS the FACSDiscover S8 exports carries the gates it was recorded under. Lay the loaded recordings out in time and import each file's own tree, one hierarchy per distinct tree, assigned to its files.",
                disabled: !loadedChorusRecordings.length,
                onClick: () => setChorusPicker({ experiment: null, trees: [] }),
              },
              {
                label: t("Import hierarchy CSV…"),
                title: "Import a hierarchy from a CSV: gate lines, population lines naming their parents, and, for a CyTOF debarcoding scheme, a table with one row per sample and one 0/1 column per barcode channel. Gates come from the file or from a template, so you tweak them rather than draw them.",
                onClick: () => void pickFilesOrInput(barcodeRef.current, TABLE_FILE_ACCEPT, "Barcode scheme table").then((files) => { if (files?.[0]) void prepareBarcodeImport(files[0]); }),
              },
              "separator",
              {
                label: t("Compare with FACSChorus statistics…"),
                title: "Open the statistics FACSChorus exports beside an experiment (<experiment>_Statistics.csv): its event count for every population of every recording, set beside GateLab's count on the loaded file of the same name, with the reason for each difference.",
                onClick: () => void pickFilesOrInput(chorusStatsRef.current, TABLE_FILE_ACCEPT, "FACSChorus statistics export").then((files) => { if (files?.[0]) void openChorusStatistics(files[0]); }),
              },
              {
                label: t("Compare with FlowJo's counts…"),
                title: "After a FlowJo workspace has been imported: the event count FlowJo recorded for every population, set beside GateLab's count of the same population on the same file, with each difference classed as arising at its own gate or inherited from a population above it.",
                disabled: !flowJoReferences.length,
                onClick: () => setFlowJoCheckOpen(true),
              },
            ]}
          />
          <MenuButton
            label={t("Export")}
            disabled={!sample}
            items={[
              {
                label: t("Export GatingML…"),
                title: "Open the GatingML export dialog: choose standard GateLab/GateLabR or Cytobank-compatible format and review fidelity warnings.",
                disabled: Object.keys(state.gates).length === 0,
                onClick: () => setGatingMlExportOpen(true),
              },
              {
                label: t("Export FlowJo workspace…"),
                title: "Write the loaded files and their gating trees as a FlowJo workspace (.wsp), in the layout FlowJo 10.10 writes, which FlowJo opens and BD FACSChorus imports sort gates from.",
                disabled: Object.keys(state.gates).length === 0,
                onClick: () => setFlowJoExportOpen(true),
              },
              {
                label: t("Export FACSChorus experiment…"),
                title: "Write the viewed file's gating tree back into the FACSChorus experiment file (.cef) it was imported from, as a new .cef that FACSChorus imports as an experiment: its live gates replaced, everything else kept. Asks for the .cef when none was opened in this session.",
                disabled: Object.keys(state.gates).length === 0 || !sample,
                onClick: () => void exportChorusFile(),
              },
              {
                label: t("Save hierarchy CSV…"),
                title: "Write this workspace's gates and populations as a CSV the import reads back: for a debarcoding strategy, the sample table plus every gate and the QC populations, and a gate template (JSON); for any other workspace, every polygon and rectangle gate and every population.",
                disabled: Object.keys(state.gates).length === 0,
                onClick: openBarcodeSave,
              },
              "separator",
              {
                label: t("Export FCS…"),
                title: "Open the FCS export dialog: choose populations, original/compensated/transformed values, and sample scope.",
                onClick: () => setFcsExportOpen(true),
              },
            ]}
          />
        </nav>
        {sample && (
          <span className="gl-meta">
            {/* With several files checked the plot is pooled, so naming one of them and its own
                event count describes something that is not on screen. Say what is pooled, and
                name the active file as what it actually still decides: the axes and the gates. */}
            {poolSelection && includedSamples.length !== 1
              ? <>
                  {t("{count} files pooled", { count: includedSamples.length })} —{" "}
                  {t("{count} events", {
                    count: includedSamples
                      .reduce((total, entry) => total + entry.sample.fcs.nEvents, 0)
                      .toLocaleString(),
                  })} · {t("axes from {name}", { name: fileName })} ·{" "}
                </>
              : <>{fileName} — {t("{count} events", { count: sample.fcs.nEvents.toLocaleString() })} ·{" "}</>}
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
            {isSceHost && hostDatasetDescriptor ? (
              // The SCE's assays by name: the samples are drawn from the chosen one. A compensated
              // layer this session installed is a further choice, as in the browser app.
              <select
                aria-label={t("Active assay layer for all tabs")}
                value={compensationOn ? "compensated" : `assay:${hostDrawnAssayId ?? ""}`}
                disabled={compensationApplyStatus !== null || busy}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value === "compensated") {
                    toggleCompensation(true);
                    return;
                  }
                  if (compensationOn) toggleCompensation(false);
                  void switchHostedAssay(value.slice("assay:".length));
                }}
              >
                {hostDatasetDescriptor.assays.map((assay) => (
                  <option key={assay.id} value={`assay:${assay.id}`} disabled={!drawableHostedAssay(assay)}>
                    {assay.coordinateSpace !== "display"
                      ? assay.id
                      : drawableHostedAssay(assay)
                        ? t("{assay} · as stored", { assay: assay.id })
                        : t("{assay} · needs its arcsinh cofactor", { assay: assay.id })}
                  </option>
                ))}
                {canUseCompensatedAssay && (
                  <option value="compensated">{t("Compensated · this session")}</option>
                )}
              </select>
            ) : (
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
            )}
          </label>
        )}
        {error && (
          // One line per note, in a box that scrolls: a per-file import says every file's notes,
          // each group under its file's name, and joined into one run of text they read as a
          // single paragraph while the header grew with every file.
          <span className="gl-error">
            {error.split("\n").map((line, i) => (
              <span key={i} className="gl-error-line">{i === 0 ? "⚠ " : "\n"}{t(line)}</span>
            ))}
          </span>
        )}
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
            data-tour="issues-link"
          >
            {t("please leave an issue at the repo")}
          </a>
        </span>
        <AgentMenu status={agentStatus} onConnect={(url) => agentLinkRef.current?.connect(url)} onDisconnect={() => agentLinkRef.current?.disconnect()} />
        {!isSceHost && <TourMenu progress={tour.progress} onStart={tour.start} onResume={tour.resume} />}
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

      {/* The tab strip spans the whole window beneath the header, not the centre column: a tab
          decides which side panes exist, so the strip cannot live inside a column whose left edge
          moves with them. Its position is the same on every tab. */}
      {sample && (
        <div className="gl-tabs" role="tablist">
          {TABS.filter((tab) => tab.id !== "layout" || LAYOUT_TAB_AVAILABLE).map((tab) => (
            <button
              key={tab.id}
              role="tab"
              data-tour={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              className={"gl-tab" + (activeTab === tab.id ? " active" : "")}
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
      )}

      <div className="gl-body">
        <aside className="gl-left" style={{ width: leftWidth, display: ["illustration", "layout", "proportions", "statistics", "compensation"].includes(activeTab) ? "none" : undefined }} aria-label="Samples and workspace">
          <div className="gl-left-resize" onMouseDown={startLeftResize} title="Drag to resize samples panel" />
          <SampleNavigator
            items={sampleListItems}
            activeId={plotPool ? null : activeSampleId}
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
            onActivate={selectOnlySample}
            onInspect={inspectSample}
            onSelectIds={(ids) => {
              const selected = new Set(ids);
              setExcludedSampleIds(new Set(samples.filter(entry => !selected.has(entry.id)).map(entry => entry.id)));
            }}
            onToggleIncluded={setSampleIncluded}
            onIncludeAll={includeAllSamples}
            onIncludeNone={includeNoSamples}
            onInvertIncluded={invertIncludedSamples}
            facets={shownFacets}
            facetColumnNames={metadataColumnNames}
            facetPartialColumns={partialMetadataColumns}
            facetColumnChoice={facetColumnChoice}
            facetLocks={facetLocks}
            facetLockOutside={facetLockOutside}
            onToggleFacetLock={toggleSampleFacetLock}
            onToggleFacet={toggleSampleFacet}
            onSetFacetColumns={setFacetColumnChoice}
            groups={state.groups}
            onGroupAction={runGroupAction}
            onDropFiles={isSceHost ? undefined : (dropped, directoryCount) => {
              // Same ingestion as "+ Files…": the drop is only another way to pick the files.
              const files = dropped.filter((file) => file.name.toLowerCase().endsWith(".fcs"));
              if (files.length === 0) {
                setError(directoryCount > 0
                  ? "Folders are not read here — use “+ Folder…” to add a folder of FCS files."
                  : "Only .fcs files can be dropped here.");
                return;
              }
              void importFcsCandidates(files.map((file) => ({
                id: crypto.randomUUID(),
                name: file.name,
                file,
                handle: null,
              })));
            }}
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
              if (pendingChorusImport) {
                void loadFcsForChorus(pendingChorusImport, picked);
                return;
              }
              // Held rather than loaded: the dialog pairs them with their samples first, so the
              // user can see what matched before anything is added to the workspace.
              void holdFlowJoFiles(picked.map((f) => ({ name: f.name, file: f })));
            }}
          />

          {/* Workspace, import and export are the header menus; the sidebar keeps the file list,
              the hidden pickers those menus drive, and the workspace's name and status. */}
          <input
            ref={wsRef}
            type="file"
            accept={`.${WORKSPACE_EXT},.wsp,.cef`}
            style={{ display: "none" }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await openWorkspaceFromFile(f, null, f.name);
            }}
          />
              <input
                ref={xmlRef}
                type="file"
                accept=".xml,.wsp,.cef"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) prepareGatingImport(f);
                  e.target.value = "";
                }}
              />
              <input
                ref={chorusStatsRef}
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void openChorusStatistics(f);
                  e.target.value = "";
                }}
              />
              <input
                ref={barcodeRef}
                type="file"
                accept=".csv,.tsv,.txt"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void prepareBarcodeImport(f);
                  e.target.value = "";
                }}
              />
          <div className="gl-side-status">
            {isSceHost ? (
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
            ) : (
              <div className="gl-side-status-row">
                {wsName ? (
                  <div className="gl-hint" title={wsName}>
                    {dirty ? "● " : ""}
                    {wsName}
                    {dirty ? ` (${t("unsaved")})` : ""}
                  </div>
                ) : <div className="gl-hint">{t("No workspace file yet")}</div>}
                <button
                  type="button"
                  className="gl-mini-btn gl-side-save"
                  disabled={!sample}
                  title={wsHandle ? t("Save the workspace in place") : t("Choose a location and save the workspace")}
                  onClick={saveWorkspace}
                >
                  {wsHandle ? `${t("Save")}${dirty ? " ●" : ""}` : t("Save…")}
                </button>
              </div>
            )}
            {importMsg && <div className="gl-hint" title={t(importMsg)}>{t(importMsg)}</div>}
            {flowJoCheckAtImport && flowJoCheckAtImport.compared > 0 && (() => {
              const said = flowJoCheckAtImport.exact === flowJoCheckAtImport.compared
                ? t("At import, all {compared} populations compared counted exactly as FlowJo recorded.", { compared: flowJoCheckAtImport.compared })
                : t("At import, {exact} of {compared} populations compared counted exactly as FlowJo recorded.", { exact: flowJoCheckAtImport.exact, compared: flowJoCheckAtImport.compared });
              // The line is cut to the panel's width, as the import's own is; the button is not.
              return (
                <div className="gl-side-status-row gl-flowjo-check-line">
                  <div className="gl-hint" title={said}>{said}</div>
                  <button className="gl-mini-btn" title={t("The count FlowJo recorded for every population, beside GateLab's")} onClick={() => setFlowJoCheckOpen(true)}>{t("FlowJo counts…")}</button>
                </div>
              );
            })()}
          </div>
        </aside>

        {sample ? (
          <div className="gl-center" role="main" aria-label={t("Plot and analysis tabs")}>
            {/* Gating tab stays mounted (hidden) so the plot + pan/zoom listeners survive
                tab switches without a re-decode. A render error here is contained to the
                gating view rather than white-screening the whole app. */}
            <ErrorBoundary label="gating">
            <div
              className="gl-gating-tab"
              style={{ display: activeTab === "gating" ? "flex" : "none" }}
            >
            <div className="gl-pool-toolbar" aria-label={t("Plot file scope")}>
              {/* The toolbar is one row that trims its text (styles.css, stable chrome), so a file
                  left out of the pool shows in the count, and the tooltip names it. */}
              <strong title={poolLeftOutNote || undefined}>{!poolSelection
                ? t("Viewing: {name}", { name: fileName })
                : poolLeftOutNote
                  ? isSceHost
                    ? t("Pooled view · {count} of {selected} samples", { count: includedSamples.length, selected: checkedSamples.length })
                    : t("Pooled view · {count} of {selected} files", { count: includedSamples.length, selected: checkedSamples.length })
                  : isSceHost
                    ? includedSamples.length === 1
                      ? t("Pooled view · 1 sample")
                      : t("Pooled view · {count} samples", { count: includedSamples.length })
                    : includedSamples.length === 1
                      ? t("Pooled view · 1 file")
                      : t("Pooled view · {count} files", { count: includedSamples.length })}</strong>
              {poolSelection ? <>
                <button type="button" onClick={() => activeSampleId && inspectSample(activeSampleId)}>
                  {isSceHost ? t("Return to single sample") : t("Return to single file")}
                </button>
                <small>{t("Editing the tree · every file follows, tailored gates excepted")}. {t("The tree's gates apply to every pooled file; these are not per-file tailored counts.")}</small>
              </> : <>
                <button type="button" disabled={checkedSamples.length < 2} onClick={poolSelectedFiles}>
                  {isSceHost
                    ? t("Pool selected samples ({count})", { count: checkedSamples.length })
                    : t("Pool selected files ({count})", { count: checkedSamples.length })}
                </button>
                <small>{activeHierarchy?.owner_sample_id
                  ? t("Editing {name} only · its tailored gates", { name: fileName })
                  : activeHierarchy?.owner_group_id
                    ? t("Editing {name} · its files follow, tailored gates excepted", { name: activeHierarchy.name })
                    : t("Editing the tree · every file follows, tailored gates excepted")}</small>
              </>}
              <span className="gl-pool-toolbar-right">
                {/* Mounted always, hidden when there is nothing to say, so the buttons beside it stay put. */}
                <span className={"gl-display-pops-banner" + (derived.displayPopCount > 1 ? "" : " is-idle")} aria-hidden={derived.displayPopCount <= 1}>
                  {t("Displaying {count} populations (union)", { count: Math.max(2, derived.displayPopCount) })}
                </span>
                <button
                  type="button"
                  className="gl-mini-btn"
                  title={t("Fit the current view to the robust event distribution and every gate on these axes")}
                  onClick={fitDataAndGates}
                >
                  {t("Fit data + gates")}
                </button>

                <button className="gl-tool" title={t("Reset X/Y to auto range in the current scale mode")}
                  aria-label={t("Reset X and Y ranges to auto")}
                  onClick={resetAxisRanges}>⟲</button>
                <button
                  type="button"
                  className={`gl-scale-lock-button${lockScalesBetweenFiles ? " active" : ""}`}
                  aria-pressed={lockScalesBetweenFiles}
                  title={t(lockScalesBetweenFiles
                    ? "Scales locked: the current axis ranges stay fixed when you switch files. Click to let each file fit its own data."
                    : "Per-file scales: each file keeps its own fitted or edited ranges. Click to freeze the current ranges across files. Fixed ranges per channel are set in the Scales tab.")}
                  onClick={toggleScaleLock}
                >
                  {t("Lock scales between files")}
                </button>
                <span className="gl-hint">{t("drag the margin to pan · shift-drag it to stretch · click an axis label to change its channel · shift while dragging a vertex holds 45°")}</span>
              </span>
            </div>
            <div className="gl-controls">
              <div className="gl-draw-tools">
                {DRAW_TOOLS.map((tool) => {
                  const disabled = drawingBlocked && tool.id !== "navigate";
                  const title = disabled
                    ? t("This tree follows its group's template — add gates there, or unlink it from its group")
                    : additionsRouted && tool.id !== "navigate"
                      ? `${t(tool.title)} · ${t("Drawn here, the gate goes into the tree for every file; move it here afterwards to tailor it")}`
                      : t(tool.title);
                  return (
                  <button
                    key={tool.id}
                    className={"gl-icon-chip" + (drawMode === tool.id ? " active" : "")}
                    title={title}
                    aria-label={title}
                    data-tool={tool.id}
                    disabled={disabled}
                    onClick={() => setDrawMode(tool.id)}
                  >
                    <tool.Icon />
                  </button>
                  );
                })}
              </div>
              {/* Undo and redo beside the tools, for a vertex moved a little too far; ⌘Z does the same. */}
              <div className="gl-history-tools" role="group" aria-label={t("Undo and redo")}>
                <button
                  type="button"
                  className="gl-icon-chip"
                  title={t("Undo the last gating change (⌘Z)")}
                  aria-label={t("Undo")}
                  data-tour="undo"
                  disabled={state.undo.length === 0}
                  onClick={() => dispatch({ type: "undo" })}
                >
                  ↶
                </button>
                <button
                  type="button"
                  className="gl-icon-chip"
                  title={t("Redo the change undone (⇧⌘Z)")}
                  aria-label={t("Redo")}
                  disabled={state.redo.length === 0}
                  onClick={() => dispatch({ type: "redo" })}
                >
                  ↷
                </button>
              </div>
              {/* Set once per session, so they live behind one button that says what is set. */}
              <details className="gl-display-popover gl-popover">
                <summary title={t("Point opacity and size, density colour, how many events to draw, the plot mode, and the plot's font sizes")}>
                  {t("Display")} · <span className="gl-display-summary-mode">{t(MODES.find((m) => m.id === mode)?.label ?? mode)}</span> · <span className="gl-display-summary-events">{maxEvents ? t("{count} events", { count: maxEvents.toLocaleString() }) : t("all events")}</span>
                </summary>
                <div className="gl-display-popover-body">
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
              <DensityColourControl value={densityColorPower} onChange={changeDensityColorPower} disabled={mode !== "pseudocolor"} />
                <label className="gl-field-inline" title="Downsample the points drawn on the plot. Empty, 0 or All events = plot every event (no downsampling). Counts/percentages always use every event.">
                  {t("Max events")}
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label={t("Max events to plot")}
                    placeholder={t("all")}
                    style={{ width: 62 }}
                    value={maxEvents === 0 ? "" : String(maxEvents)}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, "");
                      setMaxEvents(digits === "" ? 0 : parseInt(digits, 10));
                    }}
                  />
                </label>
                {/* The same switch the Strategy, Layout and Division tabs have; the field above is its number. */}
                <label className="gl-check" title={t("Draw every event rather than a sample of them; a plot of a million points repaints slowly. Counts and percentages always use every event.")}>
                  <input
                    type="checkbox"
                    aria-label={t("All events on the plot")}
                    checked={maxEvents === 0}
                    onChange={(e) => setMaxEvents(e.target.checked ? 0 : lastMaxEvents.current)}
                  />
                  {t("All events")}
                </label>
                <label className="gl-field-inline">Contours<select disabled={mode !== "contour"} value={contourLevels} onChange={event => setContourLevels(+event.target.value)}>{[4, 6, 8, 10, 12, 18, 24, 30].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                  <label className="gl-contour-outer" title="Outer contour = this % of the peak density">
                    {t("Outer")}
                    <select
                      disabled={mode !== "contour"}
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
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={"gl-chip" + (mode === m.id ? " active" : "")}
                    onClick={() => setMode(m.id)}
                  >
                    {t(m.label)}
                  </button>
                ))}
                <div className="gl-display-popover-fonts" role="group" aria-label={t("Gating plot font sizes")}>
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
                </div>
                </div>
              </details>
              {LAYOUT_TAB_AVAILABLE && (
                <button
                  type="button"
                  className="gl-mini-btn"
                  title={t("Put this plot, of this file and population, on the Layout tab, where it can be drawn once per file or once per population")}
                  onClick={addCurrentPlotToLayout}
                >
                  {t("Add to Layout")}
                </button>
              )}
              <div className="gl-modes">
                {sample.instrument !== "cytof" && (
                  <label
                    className="gl-field-inline"
                    title={
                      newGateSpace === "raw"
                        ? "New gates are straight in RAW values. Their membership can never change when you move a display control, and their edges bow on a transformed axis."
                        : "New gates are straight in the CURRENT display space, and record the transform they were drawn under. Their edges stay straight as drawn, and their membership still cannot change later — unlike FlowJo, which re-reads whatever scale is on screen."
                    }
                  >
                    {t("New gates in")}
                    <select
                      value={newGateSpace}
                      onChange={(e) => setNewGateSpace(e.target.value as GateSpace)}
                    >
                      <option value="raw">{t("Raw space")}</option>
                      <option value="display">{t("Display space")}</option>
                    </select>
                  </label>
                )}
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
                <label
                  className="gl-field-inline gl-check"
                  title={t("A dragged or drawn vertex lands on another gate's vertex within 8 px, or on its edge or the plot's edge within 6 px; a moved gate's nearest vertex lands on a neighbour; and after a pan or stretch a gate side left within 6 px of a plot edge lands on it. Adjacent gates meet without a gap or an overlap; hold Alt while dragging to place a point freely, and Shift holds the vertex's angle instead of snapping")}
                >
                  <input
                    type="checkbox"
                    checked={snapToGates}
                    onChange={(e) => setSnapToGates(e.target.checked)}
                  />
                  {t("Snap to other gates")}
                </label>
                <button
                  type="button"
                  className="gl-mini-btn"
                  disabled={Object.values(state.gates).filter((g) => g.gate_type === "polygon" || g.gate_type === "rectangle").length < 2}
                  title={t("Move the facing edges of neighbouring gates onto one shared line, so they touch with no gap and no overlap. Acts on the checked gates when two or more are checked, else on every gate of the plot.")}
                  onClick={() => {
                    const ids = state.selected_gate_ids.length >= 2 ? state.selected_gate_ids : undefined;
                    if (!gatingPlotActions.current?.closeGateGaps(ids)) setImportMsg(t("No neighbouring gate edges were close enough to join."));
                  }}
                >
                  {t("Close gaps")}
                </button>
                <button
                  type="button"
                  className="gl-mini-btn"
                  disabled={!state.selected_gate_id || !["polygon", "rectangle"].includes(state.gates[state.selected_gate_id]?.gate_type ?? "")}
                  title={t("Each side of the selected gate moves outward until it meets another gate's edge, landing on it, or reaches the plot's edge where nothing is in the way, so nothing at the edges is missed")}
                  onClick={() => { if (!gatingPlotActions.current?.extendSelectedGateToEdges()) setImportMsg(t("The selected gate already touches its neighbours and the plot's edges.")); }}
                >
                  {t("Extend to edges")}
                </button>
                <span className="gl-ctl-sep" />
                <span className="gl-field-inline">
                  {t("Colour by")}
                  <SearchableSelect
                    label={t("Colour by")}
                    value={
                      overlayBy === "coldata"
                        ? `coldata:${overlayColDataColumn ?? ""}`
                        : overlayBy === "channel"
                          ? `channel:${overlayChannelKey ?? ""}`
                          : overlayBy
                    }
                    options={overlayByOptions}
                    onChange={(value) => {
                      if (value.startsWith("coldata:")) {
                        setOverlayColDataColumn(value.slice("coldata:".length));
                        setOverlayBy("coldata");
                      } else if (value.startsWith("channel:")) {
                        setOverlayChannelKey(value.slice("channel:".length));
                        setOverlayBy("channel");
                      } else {
                        setOverlayBy(value as Exclude<typeof overlayBy, "coldata" | "channel">);
                      }
                    }}
                  />
                </span>
                {overlayBy === "coldata" && overlayColDataColumn && !overlayColDataValues && (
                  <span className="gl-muted">{t("loading {column}…", { column: overlayColDataColumn })}</span>
                )}
                  <label
                    className="gl-field-inline gl-palette-field"
                    title={overlayColDataValues?.colors
                      ? t("Colours for this column are fixed in metadata(sce)$gatelab_palettes, so the palette does not apply.")
                      : undefined}
                  >
                    {t("Palette")}
                    {overlayBy === "channel" ? (
                      <select
                        value={overlayMarkerPalette}
                        onChange={(e) => setOverlayMarkerPalette(e.target.value as PaletteName)}
                      >
                        {MARKER_PALETTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    ) : (
                      <select value={overlayPalette} disabled={overlayBy === "none" || !!overlayColDataValues?.colors} onChange={(e) => setOverlayPalette(e.target.value as PaletteName)}>
                        {OVERLAY_PALETTES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </select>
                    )}
                  </label>
                <MarkerColourControl value={markerColorPower} onChange={setMarkerColorPower} disabled={overlayBy !== "channel"} />
                <span
                  className={`gl-sample-scope-badge${pendingIncludedGatingIds.size > 0 ? " is-pending" : ""}`}
                  title={[
                    t("The plot shows the viewed file, or the selected files when pooled."),
                    ...(activeHierarchy?.owner_sample_id ? [t("Editing {name} only", { name: fileName })] : []),
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
                        : t("No plotted files")}
                  </strong>
                  {activeHierarchy?.owner_sample_id && ` · ${t("{name} only", { name: fileName })}`}
                  {includedSamples.length > 0 &&
                    ` · ${t("{count} plotted files", { count: includedSamples.length })}`}
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
                  title={panelMismatchNames.length > 0
                    ? t("Files whose panel differs from {name} are not pooled with it: the same channel name can carry a different marker between panels, so a shared name is not a shared measurement. Uncheck them, or check them alone.", { name: fileName })
                    : layerMismatchNames.length > 0
                      ? t("Files on another assay layer than {name} are not pooled with it: their values are in another space. Put them on the same layer, or select them alone.", { name: fileName })
                      : t("The viewed file supplies the axes. Pooled, the plot follows the selection; Enter shows a file alone.")}
                >
                  {panelMismatchNames.length > 0
                    ? `⚠ ${t("{count} checked file(s) not pooled — different panel", {
                        count: panelMismatchNames.length,
                      })}`
                    : layerMismatchNames.length > 0
                      ? `⚠ ${t("{count} checked file(s) not pooled — different assay layer", {
                          count: layerMismatchNames.length,
                        })}`
                      : t("Axes from: {name}", { name: fileName })}
                </span>
              </div>
            </div>
            {/* Fluorescence scale — logicle (default) or arcsinh 150. Keyed on the channel's
                CLASS, not on what it currently shows, so the control stays put after switching
                to arcsinh; the Logicle W row below is what comes and goes. CyTOF is excluded:
                it is arcsinh throughout and the choice would be meaningless. */}
            {/* Transforms: one slot per axis, X then Y, whatever kind of channel each is, so the
                editors never move or change width when the axes change. A slot holds the axis
                label, the kind of transform, and a parameter area that is the same width whether
                it carries the logicle W slider, the arcsinh cofactor slider, or nothing. Keyed on
                the channel's CLASS, so the control stays put after switching to arcsinh. CyTOF is
                excluded: it is arcsinh throughout and the choice would be meaningless. */}
            {(sample.isFluorChannel(xIdx) || sample.isFluorChannel(yIdx) || sample.isScatterAxis(xIdx) || sample.isScatterAxis(yIdx) || sample.isImagingFeatureAxis(xIdx) || sample.isImagingFeatureAxis(yIdx)) && (
              <div className="gl-scales gl-transforms">
                <span className="gl-scales-label">{t("Transforms")}</span>
                {([
                  ["X", xIdx],
                  ["Y", yIdx],
                ] as const).map(([axis, idx]) => {
                  const kind = sample.isFluorChannel(idx) ? "fluor" : sample.isScatterAxis(idx) ? "scatter" : sample.isImagingFeatureAxis(idx) ? "imaging" : null;
                  return (
                    <div className="gl-scale-row gl-scale-slot" key={axis}>
                      <span className="gl-scale-axis" title={sample.channelLabel(idx)}>
                        {axis} · {sample.channelLabel(idx)}
                      </span>
                      {kind === "scatter" ? (
                        <select
                                                className="gl-scatter-scale"
                                                aria-label={`${axis} scatter scale`}
                                                title={t("Arcsinh (cofactor 150) renders near-zero and negative scatter that a linear axis cannot. Linear matches how FlowJo and Cytobank display scatter.")}
                                                value={sample.scatterScale(idx) === "linear" ? "linear" : "arcsinh"}
                                                onChange={(e) => {
                                                  sample.setScatterScale(idx, e.target.value === "linear" ? "linear" : "arcsinh");
                                                  pendingScaleRefit.current = true;
                                                  bumpScales();
                                                }}
                                              >
                                                <option value="linear">{t("Linear")}</option>
                                                <option value="arcsinh">{t("Arcsinh")}</option>
                                              </select>
                      ) : kind === "imaging" ? (
                        <select
                                                className="gl-scatter-scale"
                                                aria-label={`${axis} imaging scale`}
                                                title={t("A shape or position feature the instrument derived from the cell's image. Linear is how FACSChorus shows it; arcsinh (cofactor 150) spreads the values near zero. Gates live in raw space, so neither moves an event in or out of a gate.")}
                                                value={sample.featureScale(idx)}
                                                onChange={(e) => {
                                                  sample.setFeatureScale(idx, e.target.value === "arcsinh" ? "arcsinh" : "linear");
                                                  pendingScaleRefit.current = true;
                                                  bumpScales();
                                                }}
                                              >
                                                <option value="linear">{t("Linear")}</option>
                                                <option value="arcsinh">{t("Arcsinh")}</option>
                                              </select>
                      ) : kind === "fluor" ? (
                        <select
                                                className="gl-scatter-scale"
                                                aria-label={`${axis} signal scale`}
                                                title={t("Logicle is estimated per channel and shaped by W. Arcsinh is shaped by its cofactor, which sets where the linear region around zero gives way to log. Gates live in raw space, so neither moves an event in or out of a gate.")}
                                                value={sample.fluorScale(idx)}
                                                onChange={(e) => {
                                                  sample.setFluorScale(idx, e.target.value === "arcsinh" ? "arcsinh" : "logicle");
                                                  pendingScaleRefit.current = true;
                                                  bumpScales();
                                                }}
                                              >
                                                <option value="logicle">{t("Logicle")}</option>
                                                <option value="arcsinh">{t("Arcsinh")}</option>
                                              </select>
                      ) : (
                        <select className="gl-scatter-scale" aria-label={`${axis} scale`} disabled value="fixed" title={t("This axis has one scale.")}>
                          <option value="fixed">{t("Linear")}</option>
                        </select>
                      )}
                      <span className="gl-scale-params">
                        {kind === "fluor" && (sample.fluorScale(idx) === "logicle" ? (
                        <>
                          <input
                            type="range"
                            aria-label={`${axis} logicle W`}
                            title={t("Logicle W — how many decades of negative values the axis shows.")}
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
                        </>
                      ) : (
                        <>
                          <input
                            type="range"
                            aria-label={`${axis} arcsinh cofactor`}
                            title={t("Arcsinh cofactor — where the linear region around zero gives way to log. Raise it to pack the near-zero and negative noise into a tighter band; lower it to spread that noise out and make the axis behave like a log scale.")}
                            min={COFACTOR_LOG_MIN}
                            max={COFACTOR_LOG_MAX}
                            step={0.02}
                            value={Math.log10(
                              pendingFluorCofactor[sample.channels[idx].key] ??
                                sample.currentFluorCofactor(idx),
                            )}
                            onChange={(e) => commitFluorCofactor(idx, cofactorFromSlider(+e.target.value))}
                          />
                          <span className="gl-scale-val">
                            {fmtCofactor(
                              pendingFluorCofactor[sample.channels[idx].key] ??
                                sample.currentFluorCofactor(idx),
                            )}
                          </span>
                          <button
                            className="gl-tool"
                            title={t("Reset to the default cofactor (150)")}
                            aria-label={`Reset ${axis} arcsinh cofactor to default`}
                            onClick={() => {
                              sample.resetFluorCofactor(idx);
                              setPendingFluorCofactor((c) => {
                                const next = { ...c };
                                delete next[sample.channels[idx].key];
                                return next;
                              });
                              pendingScaleRefit.current = true;
                              bumpScales();
                            }}
                          >
                            A
                          </button>
                        </>
                      ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {/* The scatter scale control sits above, in the chrome block; it is shown only for
                flow scatter axes. CyTOF is excluded deliberately: arcsinh cofactor 5 is the
                field convention and is not offered as a choice. Gates live in raw space for
                flow, so nothing there moves a gate; it only changes what the axis looks like. */}
            <div
              className="gl-plot-area"
              ref={plotAreaRef}
              style={{ cursor: drawMode === "navigate" ? "grab" : "crosshair" }}
              onContextMenu={(event) => {
                // A vertex or an edge stops the event before it gets here, with its own menu.
                if (!sample) return;
                event.preventDefault();
                setPlotMenu({ x: event.clientX, y: event.clientY, label: t("Plot"), items: plotContextItems() });
              }}
            >
            {/* An overlay on the plot, so it never moves the plot. Shown only when a gate on this plot actually curves, and only in the modes where that
                is visible — and dismissible, because it answers a question once. The full explanation
                stays on the control's tooltip, available on demand rather than occupying the plot for
                everyone who already knows. */}
            {!gateEdgeNoteHidden && gateEdgeMode !== "straight"
              && mainPlotGates.some((g) => g.outline) && (
              <div className="gl-hint gl-plot-note">
                <span>
                  {t("Straight edges can look curved here \u2014 gates are stored in raw values, so the curve is where the gate really falls. Gating is unchanged.")}
                  {/* A gate on FlowJo's grid takes its events by channel, not by the curve: said here,
                      where the curve is first read as the selection. */}
                  {mainPlotGates.some((plotted) => {
                    const gate = state.gates[plotted.gate_id];
                    return !!gate && isFlowJoGridGate(gate);
                  }) && ` ${t("A gate on FlowJo's grid (F on its badge) is tested on that grid's channels, as FlowJo tests it, so the events it takes step along the curve by up to one channel.")}`}
                </span>
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
              <GatingPlot
                payload={displayed}
                actions={gatingPlotActions}
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
                  if (g.gate_type === "ellipse") {
                    // The plot presents an ellipse as its sampled boundary; a body drag is a
                    // uniform display-space translation of those points. Only the mean moves —
                    // the covariance is the gate's shape and never derives from dragged
                    // samples. The new mean is the translated display centroid mapped back
                    // into the gate's own space.
                    const cx = e.vertices.reduce((a, v) => a + v[0], 0) / e.vertices.length;
                    const cy = e.vertices.reduce((a, v) => a + v[1], 0) / e.vertices.length;
                    dispatch({
                      type: "moveEllipse",
                      gateId: e.gate_id,
                      mean: [sample.displayToGate(g, g.x_channel, cx), sample.displayToGate(g, g.y_channel, cy)],
                    });
                    return;
                  }
                  const verts = e.vertices.map(
                    ([vx, vy]) =>
                      [sample.displayToGate(g, g.x_channel, vx), sample.displayToGate(g, g.y_channel, vy)] as [number, number],
                  );
                  dispatch({ type: "editGate", gateId: e.gate_id, vertices: verts });
                }}
                onEllipseEdit={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type !== "ellipse") return;
                  // The handles worked in DISPLAY coordinates; the gate stores its covariance in
                  // its own space. Handles are only offered when the gate→display map is affine
                  // (the payload checks numerically), so the mean maps pointwise and the
                  // covariance maps as K·Σ·K with the per-axis slopes — computed here from the
                  // same displayToGate the mean uses, so the two can never disagree.
                  const mean: [number, number] = [
                    sample.displayToGate(g, g.x_channel, e.mean[0]),
                    sample.displayToGate(g, g.y_channel, e.mean[1]),
                  ];
                  const slope = (ch: string, at: number, span: number): number => {
                    const h = Math.max(Math.abs(span), 1e-6) * 0.01;
                    return (sample.displayToGate(g, ch, at + h) - sample.displayToGate(g, ch, at - h)) / (2 * h);
                  };
                  const kx = slope(g.x_channel, e.mean[0], e.major);
                  const ky = slope(g.y_channel, e.mean[1], e.major);
                  const covD = covarianceFromAxes(e.major, e.minor, e.angle, g.distance_square);
                  dispatch({
                    type: "reshapeEllipse",
                    gateId: e.gate_id,
                    mean,
                    covariance: [
                      [covD[0][0] * kx * kx, covD[0][1] * kx * ky],
                      [covD[1][0] * ky * kx, covD[1][1] * ky * ky],
                    ],
                  });
                }}
                onQuadrantMove={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type !== "quadrant") return;
                  dispatch({
                    type: "moveQuadrantCenter",
                    gateId: e.gate_id,
                    center: [sample.displayToGate(g, g.x_channel, e.center[0]), sample.displayToGate(g, g.y_channel, e.center[1])],
                  });
                }}
                onQuadrantCurl={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type !== "quadrant" || !g.curl) return;
                  // The handle sits at the end of the arm; where it was dropped, in the gate's
                  // own space, fixes that arm's coefficient: the bend there must equal k · d^p.
                  const at: [number, number] = [
                    sample.displayToGate(g, g.x_channel, e.at[0]),
                    sample.displayToGate(g, g.y_channel, e.at[1]),
                  ];
                  const [cx, cy] = g.center;
                  const p = g.curl.power;
                  const next = { ...g.curl };
                  if (e.arm === "h") {
                    const d = at[0] - cx;
                    if (!(d > 0)) return;
                    next.kx = (at[1] - cy) / Math.pow(d, p);
                  } else {
                    const d = at[1] - cy;
                    if (!(d > 0)) return;
                    next.ky = (at[0] - cx) / Math.pow(d, p);
                  }
                  if (!Number.isFinite(next.kx) || !Number.isFinite(next.ky)) return;
                  dispatch({ type: "setQuadrantCurl", gateId: e.gate_id, curl: next });
                }}
                onGateSelect={(id) => {
                  if (!plotInteractionIsCurrent()) return;
                  // Plain dispatch, NOT uiDispatch: the axis auto-switch belongs to the gate
                  // LIST click (app.R:5030), where the gate may be off-screen. A gate selected
                  // ON the plot is already visible on the current axes — and for a gate drawn
                  // flipped, uiDispatch would swap xIdx/yIdx, which are part of the plot
                  // interaction token. The engine defers repaints during a drag, so the token
                  // could not reconcile before mouseup, and the drag's own gate_edit was then
                  // discarded as stale — the gate visibly snapped back, and only a second
                  // attempt (tokens now settled) moved it. Selection must never change the
                  // interaction context of the drag that performs it.
                  dispatch({ type: "selectGate", gateId: id });
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
                  dispatch({ type: "moveGateLabel", gateId: e.gate_id, labelOffset: e.label_offset, ...(e.quadrant !== undefined ? { quadrant: e.quadrant } : {}) });
                }}
                onVertexMenu={(e) => {
                  if (!plotInteractionIsCurrent()) return;
                  const g = state.gates[e.gate_id];
                  if (!g || g.gate_type === "quadrant") return;
                  if (e.body) {
                    // The gate's own menu, with the plot's actions after it, since a large gate
                    // covers much of the plot.
                    setPlotMenu({
                      x: e.client[0],
                      y: e.client[1],
                      label: g.name,
                      items: [
                        {
                          label: t("Fit to its events\u2026"),
                          title: t("Redraw the gate around the events it holds on this file, as tight as you choose; the plot shows the fit while you set it"),
                          disabled: !activeSampleId,
                          onClick: () => openFitGate(g.gate_id, e.client, e.box),
                        },
                        "separator",
                        ...plotContextItems(),
                      ],
                    });
                    return;
                  }
                  if (g.gate_type !== "polygon") return;
                  // Both go through the edit a dragged vertex makes: one Undo step, membership
                  // recomputed, the label's percentage updated. A polygon keeps three vertices.
                  if (e.vertex !== undefined) {
                    const index = e.vertex;
                    setPlotMenu({
                      x: e.client[0],
                      y: e.client[1],
                      label: t("Vertex"),
                      items: [{
                        label: t("Delete vertex"),
                        disabled: g.vertices.length <= 3,
                        title: g.vertices.length <= 3 ? t("A polygon keeps at least three vertices") : t("Remove this vertex; the gate keeps its others"),
                        onClick: () => dispatch({ type: "editGate", gateId: g.gate_id, vertices: g.vertices.filter((_, i) => i !== index) }),
                      }],
                    });
                    return;
                  }
                  if (e.edge === undefined || !e.point) return;
                  const edge = e.edge, point = e.point;
                  setPlotMenu({
                    x: e.client[0],
                    y: e.client[1],
                    label: t("Edge"),
                    items: [{
                      label: t("Add vertex here"),
                      title: t("A new vertex on this edge, at the point clicked, between its two ends"),
                      onClick: () => {
                        const vertices = [...g.vertices];
                        vertices.splice(edge + 1, 0, [sample.displayToGate(g, g.x_channel, point[0]), sample.displayToGate(g, g.y_channel, point[1])]);
                        dispatch({ type: "editGate", gateId: g.gate_id, vertices });
                      },
                    }],
                  });
                }}
              />
              <ContextMenu menu={plotMenu} onClose={() => setPlotMenu(null)} />
              {fitGate && sample && state.gates[fitGate.gateId] && state.gates[fitGate.gateId].gate_type !== "quadrant" && (
                <FitGatePanel
                  at={fitGate.at}
                  avoid={fitGate.box}
                  gateName={state.gates[fitGate.gateId].name}
                  gateType={state.gates[fitGate.gateId].gate_type as "polygon" | "rectangle" | "ellipse"}
                  fileName={fileName}
                  settings={fitGate.settings}
                  result={fitGate.result}
                  onChange={changeFitGate}
                  onApply={applyFitGate}
                  onCancel={() => setFitGate(null)}
                />
              )}
            </div>
            {/* A slot of its own height, so a legend appearing or growing does not resize the plot. */}
            <div className="gl-plot-legend-slot">
            {markerOverlay && (
              <MarkerColourBar
                label={markerOverlay.label}
                scale={markerOverlay.scale}
                palette={markerOverlay.palette}
                ticks={markerOverlay.ticks}
                power={markerOverlay.power}
              />
            )}
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
            </div>
            </ErrorBoundary>
            {/* One boundary for the conditionally-mounted data tabs, keyed by activeTab so a
                crashed tab clears itself when you switch away (Shiny-like per-panel isolation). */}
            <ErrorBoundary key={activeTab} label={activeTab}>
            {activeTab === "statistics" && (
              <StatsTab
                samples={statsSamples}
                activeSampleId={activeSampleId}
                state={state}
                onDownload={() => { tourSignals.current.statsDownloads++; }}
                derived={derived}
                defaultChannels={[sample.channels[xIdx].key, sample.channels[yIdx].key]}
                dataRevisionKey={sampleDataRevisionKey}
                nominalLinearFrom={sample.hostedAssaySpace === "display" ? sample.hostedAssayId : null}
              />
            )}
            {activeTab === "proportions" && (
              <ProportionsTab
                samples={samples.map(entry => ({ ...entry, hierarchyId: hierarchyOfFile(entry.id) }))}
                activeSampleId={activeSampleId}
                state={state}
                derived={derived}
                metadata={metadata}
                metadataColumns={metadataColumns}
                divisionProfiles={compatibleDivisionProfiles}
                dataRevisionKey={sampleDataRevisionKey}
                onConfigChange={markWorkspaceDirty}
                onAddToLayout={LAYOUT_TAB_AVAILABLE ? addProportionsToLayout : undefined}
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
                labelMode={channelLabelMode}
                onLabelModeChange={setChannelLabelMode}
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
                lockedBetweenFiles={lockScalesBetweenFiles}
              />
            )}
            {activeTab === "strategy" && (
              <StrategyTab
                key={illustVersion}
                sampleName={samples.find(entry => entry.id === activeSampleId)?.name}
                onFitChannels={fitChannels}
                sample={sample}
                state={state}
                derived={derived}
                globalScales={globalScales}
                configRef={strategyConfigRef}
                dataRevision={activeDataRevision}
                densityColorPower={densityColorPower}
                onDensityColorPowerChange={changeDensityColorPower}
                files={samples.map(entry => ({ ...entry, fileName: entry.name, name: sampleDisplayId(entry.name, metadata[entry.id]), hierarchyId: hierarchyOfFile(entry.id), metadata: metadata[entry.id] }))}
                poolIds={poolSelection ? (plotPool?.ids ?? []) : null}
                poolNote={poolLeftOutNote || undefined}
                poolable={checkedSamples.length >= 2}
                isSceHost={isSceHost}
                onPoolChange={(pooled) => { if (pooled) poolSelectedFiles(); else if (activeSampleId) inspectSample(activeSampleId); }}
                activeSampleId={activeSampleId}
                onAddToLayout={LAYOUT_TAB_AVAILABLE ? addStrategyToLayout : undefined}
                onOpenStep={openStrategyStepInGating}
                onGateLabelMove={(hierarchyId, gateId, offset, quadrant) => {
                  dispatch({ type: "moveGateLabel", hierarchyId, gateId, labelOffset: offset, ...(quadrant !== undefined ? { quadrant } : {}) });
                }}
                onScaleChange={setGlobalScale}
              />
            )}
            {activeTab === "illustration" && (
              <FigureWorkspace
                key={illustVersion}
                populationMetadata={populationMetadata}
                samples={samples.map(entry => ({ ...entry, fileName: entry.name, name: sampleDisplayId(entry.name, metadata[entry.id]), hierarchyId: hierarchyOfFile(entry.id), metadata: metadata[entry.id] }))}
                checkedSampleIds={checkedSamples.map(entry => entry.id)}
                state={state}
                defaultX={sample.channels[xIdx].key}
                defaultY={sample.channels[yIdx].key}
                defaultComposition={poolSelection ? "pool" : "separate"}
                configRef={illustConfigRef}
                presets={illustrationPresets}
                onSavePreset={saveIllustrationPreset}
                onDeletePreset={deleteIllustrationPreset}
                onConfigChange={markWorkspaceDirty}
                dataRevision={sampleDataRevisionKey}
                onOpenGating={() => setActiveTab("gating")}
                globalScales={figureGatingRanges}
                onFitChannels={fitChannels}
                onAddToLayout={LAYOUT_TAB_AVAILABLE ? addPlotsToLayout : undefined}
                onAddFigureToLayout={LAYOUT_TAB_AVAILABLE ? addFigureToLayout : undefined}
                onOpenInGating={openLayoutRecipeInGating}
                onGateLabelMove={(hierarchyId, gateId, offset, quadrant) => {
                  dispatch({ type: "moveGateLabel", hierarchyId, gateId, labelOffset: offset, ...(quadrant !== undefined ? { quadrant } : {}) });
                }}
                onScaleChange={setGlobalScale}
              />
            )}
            {activeTab === "layout" && (
              <Suspense fallback={<div className="gl-empty">{t("Loading Layout editor…")}</div>}>
                <LayoutTab
                  workspace={layoutWorkspace}
                  onChange={setLayoutWorkspace}
                  samples={samples.map(entry => ({ ...entry, fileName: entry.name, name: sampleDisplayId(entry.name, metadata[entry.id]), hierarchyId: hierarchyOfFile(entry.id), metadata: metadata[entry.id] }))}
                  checkedSampleIds={samples.filter((entry) => !excludedSampleIds.has(entry.id)).map((entry) => entry.id)}
                  groups={state.groups}
                  fileGroups={state.file_groups}
                  metadataColumns={metadataColumnNames}
                  metadataLevels={metadataLevels}
                  populationMetadata={populationMetadata}
                  activeSampleId={activeSampleId}
                  activePopulationId={state.active_population_id}
                  state={state}
                  globalScales={figureGatingRanges}
                  defaultX={sample.channels[xIdx].key}
                  defaultY={sample.channels[yIdx].key}
                  illustrationConfig={illustConfigRef.current}
                  divisionProfiles={compatibleDivisionProfiles}
                  plottingSettings={() => readProportionsSettings(defaultProportionsSettings(samples, state, metadataColumns))}
                  onOpenInPlotting={(settings) => {
                    writeProportionsSettings(settings);
                    markWorkspaceDirty();
                    setActiveTab("proportions");
                  }}
                  onOpenInIllustration={(config) => {
                    illustConfigRef.current = config;
                    setIllustVersion((v) => v + 1);
                    markWorkspaceDirty();
                    setActiveTab("illustration");
                  }}
                  dataRevision={sampleDataRevisionKey}
                  onExported={() => { tourSignals.current.layoutExports++; }}
                  densityColorPower={densityColorPower}
                  onOpenInGating={openLayoutRecipeInGating}
                />
              </Suspense>
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
                  otherEmbeddedLayerFiles={embeddedLayerEntries().filter((entry) => entry.id !== activeSampleId).map((entry) => entry.name)}
                  onRemoveProfile={isSceHost ? undefined : removeCompensationProfile}
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
                  applyTargetCount={sample.instrument === "cytof" ? checkedSamples.length : 1}
                  applyTargetEventCount={sample.instrument === "cytof"
                    ? checkedSamples.reduce((total, entry) => total + entry.sample.fcs.nEvents, 0)
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
                  channelLabelMode={channelLabelMode}
                />
              </Suspense>
            </ErrorBoundary>}
          </div>
        ) : (
          <EmptyState brand={isSceHost ? "GateLabR" : "GateLab"} tutorial={isSceHost ? null : { paused: tour.progress?.status === "paused", onStart: tour.start, onResume: tour.resume }} />
        )}

        <aside
          className="gl-side"
          style={{ width: sideWidth, display: ["compensation", "illustration", "layout", "proportions", "statistics"].includes(activeTab) ? "none" : undefined }}
          aria-label={t("Gates and populations")}
        >
          <div className="gl-side-resize" onMouseDown={startResize} onDoubleClick={() => { setAutoSizePopulations(true); setSideFitTick((n) => n + 1); }} title="Drag to resize; double-click to fit content" />
          <div className="gl-side-section gl-hierarchy-section">
            <HierarchyControls state={state} perFile={treeControls} />
          </div>
          <div className={"gl-side-section" + (gatesCollapsed ? " gl-side-collapsed" : "")}>
            <div className="gl-side-head">
              <button
                type="button"
                className="gl-side-disclosure"
                aria-expanded={!gatesCollapsed}
                title={gatesCollapsed ? t("Show the gate list") : t("Hide the gate list, so the populations take the space")}
                onClick={() => setGatesCollapsed((collapsed) => !collapsed)}
              >
                <span className="gl-side-disclosure-mark" aria-hidden="true">{gatesCollapsed ? "▸" : "▾"}</span>
                <span className="gl-side-title">{t("Gates")}{gatesCollapsed ? ` · ${Object.keys(state.gates).length}` : ""}</span>
              </button>
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
            {!gatesCollapsed && (
              <GateList state={state} derived={gateListDerived} dispatch={uiDispatch}
                labelForKey={(k) => sample?.labelForKey(k) ?? k}
                badgeFor={(g) => (sample ? gateSpaceBadge(sample, g) : null)}
                countScope={gateCountScope?.listText ?? null}
                tailoredGateIds={activeTailoredGateIds}
                tailoredInFiles={templateTailoredInFiles} />
            )}
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
              <label
                className="gl-branch-gates-toggle"
                title={t("Always draw gates that belong to no population. Such a gate is in no branch, so branch scoping would otherwise hide it whenever it is not selected or ticked.")}
              >
                <input
                  type="checkbox"
                  disabled={!branchGatesOnly}
                  checked={showUnownedGates}
                  onChange={(e) => setShowUnownedGates(e.target.checked)}
                />
                {t("Unowned gates")}
              </label>
              <label
                className="gl-branch-gates-toggle"
                title={t("Line the gate badges up in one column after the longest population name. Unchecked, each row's badges follow its own name.")}
              >
                <input
                  type="checkbox"
                  checked={alignPopulationGates}
                  onChange={(e) => setAlignPopulationGates(e.target.checked)}
                />
                {t("Align gates")}
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
                tailoredGateIds={activeTailoredGateIds}
                showHierarchyControls={false}
                alignGates={alignPopulationGates}
                perFile={treeControls}
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
          found={new Map([...pendingWorkspaceRelink.found].map(([dataPath, hit]) => [
            dataPath,
            hit.sourceName === "selected files" ? hit.source.relativePath : `${hit.sourceName}/${hit.source.relativePath}`,
          ]))}
          folderSelectionAvailable={supportsDirectoryAccess()}
          fileSelectionAvailable={supportsFileSystemAccess()}
          scanning={workspaceRelinkScanning}
          note={workspaceRelinkNote}
          error={workspaceRelinkError}
          override={workspaceRelinkOverride?.byChoice ?? null}
          onOverride={() => void useWorkspaceRelinkOverride()}
          onChoose={(mode) => void choosePendingWorkspaceRelinkFolder(mode)}
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
          onActivate={inspectSample}
          onToggleIncluded={setSampleIncluded}
          onIncludeAll={includeAllSamples}
          onIncludeNone={includeNoSamples}
          onInvertIncluded={invertIncludedSamples}
          onRemove={async (ids) => {
            await removeSamples(ids);
            setSampleManagerSelection([]);
          }}
          onSort={isSceHost ? undefined : sortSamplesByName}
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
          // CyTOF keeps its legacy space for now; the distinction is a flow problem (every CyTOF
          // channel is arcsinh at cofactor 5, so both spaces would read the same badge forever).
          gateSpace={sample?.instrument === "cytof" ? null : newGateSpace}
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
            if (additionsRouted) setHierarchyActionMessage(routedAdditionMessage("name" in a && typeof a.name === "string" ? a.name : "The gate"));
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
            if (additionsRouted && a.type === "addPopulation") setHierarchyActionMessage(routedAdditionMessage(a.name));
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
      {clearGatingConfirmOpen && (
        <ConfirmModal
          title="Clear gates and populations?"
          message="Every gate, population and hierarchy of this workspace is removed; the files, their scales, compensation and metadata stay. Undo brings the gating back."
          confirmLabel="Clear"
          onCancel={() => setClearGatingConfirmOpen(false)}
          onConfirm={clearGating}
        />
      )}
      {historyPicker && (
        <WorkspaceHistoryModal
          checkpoints={historyPicker.checkpoints}
          loading={historyPicker.loading}
          onRevert={(checkpoint) => void revertToCheckpoint(checkpoint)}
          onCancel={() => setHistoryPicker(null)}
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
      {treePicker && (() => {
        // Cancelling the picker after a workspace open cancels the open, as cancelling its import
        // does: the files it loaded go too, rather than staying with no gates.
        const cancelTreePicker = () => {
          const opened = treePicker.openedSampleIds ?? [];
          setTreePicker(null);
          // The error that asked for another tree is answered by cancelling; left standing, it sat
          // beside "Workspace open cancelled" asking for a choice that was no longer on offer.
          if (treePicker.failed?.length) setError(null);
          if (opened.length) {
            void removeSamples(opened).then(() => setImportMsg(
              `Workspace open cancelled; the ${opened.length === 1 ? "file it loaded was" : `${opened.length} files it loaded were`} ` +
              "removed again and the current strategy was not changed.",
            ));
          }
        };
        const failed = treePicker.failed ?? [];
        const latest = failed.length ? failed[failed.length - 1] : undefined;
        const latestTree = latest ? treePicker.sample.trees.find((tree) => tree.index === latest.index) : undefined;
        const hasFailed = (index: number) => failed.some((f) => f.index === index);
        // A tree with no gate this importer can read is shown, and not offered: choosing it could
        // only fail, and it had to fail once before it was disabled.
        const unreadable = (tree: FlowJoTreeSummary) => tree.gateCount === 0;
        return (
        <div className="gl-modal-backdrop" onClick={cancelTreePicker}>
          <div
            className="gl-modal gl-wsp-picker"
            role="dialog"
            aria-label="Choose a gating tree"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gl-modal-title">{t("Choose a gating strategy")}</div>
            {latest ? (
              // Repeated in full -- a Gating-ML refusal lists every gate on a missing channel,
              // thousands of characters -- the reason pushed the trees and Cancel off screen, so the
              // picker says it briefly and offers the rest folded, bounded and scrolled. It pointed
              // to the header, which cannot be read while the picker is open, and clicking past
              // the picker cancels it and clears the header.
              <>
                <div className="gl-modal-note gl-modal-reason" title={latest.why}>
                  {t("The tree \"{name}\" could not be imported: {why}", { name: latestTree?.name ?? "", why: briefReason(latest.why) })}{" "}
                  {treePicker.sample.trees.some((tree) => !hasFailed(tree.index) && !unreadable(tree))
                    ? t("Choose another of this sample's trees.")
                    : t("None of this sample's trees can be imported alone; every tree, each file its own sample's, still can.")}
                </div>
                {reasonWasCut(latest.why) && (
                  <details className="gl-modal-reason-full">
                    <summary>{t("The full reason")}</summary>
                    <div className="gl-modal-reason-text">{latest.why}</div>
                  </details>
                )}
              </>
            ) : (
              <div className="gl-modal-note">
                {t("This sample holds several independent strategies. GateLab holds one at a time, so importing them together would merge trees FlowJo kept apart.")}
              </div>
            )}
            {treePicker.crossTo && (
              <div className="gl-modal-note">
                {t("Import {sample}'s tree onto {file}", { sample: treePicker.sample.name, file: treePicker.crossTo })}
              </div>
            )}
            {treePicker.perFileOption && treePicker.perFileOption.length > 1 && (
              <div className="gl-modal-note">
                {t("Other loaded files are samples of this workspace too: {files}. Import every tree, each file getting its own sample's, or one tree, which they then follow by this choice.",
                  { files: treePicker.perFileOption.slice(1).map((p0) => calledLoaded(p0.fileName, p0.entryId)).join(", ") })}
              </div>
            )}
            <div className="gl-wsp-list">
              {treePicker.perFileOption && treePicker.perFileOption.length > 1 && (
                <button
                  className="gl-wsp-row"
                  onClick={() => {
                    const picked = treePicker;
                    setTreePicker(null);
                    void importFlowJoSample(picked.text, picked.sample, picked.matchedOn, null, picked.perFileOption!,
                      picked.matrixChoice ?? null, picked.openedSampleIds ?? [], [],
                      { crossTo: picked.crossTo ?? null, unpaired: picked.unpaired ?? [], pairingNote: picked.pairingNote ?? null, loadNotes: picked.loadNotes ?? [], mergedTreesAdvice: MERGED_TREES_ADVICE_LOADED, flowJoGrid: picked.flowJoGrid, flowJoGridInDialog: picked.flowJoGridInDialog });
                  }}
                >
                  <span className="gl-wsp-name">{t("Every tree, each file its own sample's")}</span>
                  <span className="gl-wsp-meta">
                    {t("One hierarchy per file: {files}", { files: treePicker.perFileOption.map((p0) => calledLoaded(p0.fileName, p0.entryId)).join(", ") })}
                  </span>
                </button>
              )}
              {treePicker.sample.trees.map((tree) => (
                <button
                  key={tree.index}
                  className="gl-wsp-row"
                  disabled={hasFailed(tree.index) || unreadable(tree)}
                  onClick={() => {
                    const picked = treePicker;
                    setTreePicker(null);
                    // One tree alone: the other loaded files that are samples of their own follow it,
                    // by this choice, and the result names each with the sample it is.
                    const byChoice = picked.perFileOption
                      ? picked.perFileOption.slice(1).map((p0) => ({ name: p0.fileName, sample: `sample ${p0.sample.index + 1} "${p0.sample.name}"` }))
                      : picked.byChoice ?? [];
                    // What the open dialog answered, and the files it loaded, go with the tree
                    // chosen instead, as they would have with the first.
                    void importFlowJoSample(picked.text, picked.sample, picked.matchedOn, tree.index, [],
                      picked.matrixChoice ?? null, picked.openedSampleIds ?? [], picked.failed ?? [],
                      { crossTo: picked.crossTo ?? null, unpaired: picked.unpaired ?? [], byChoice, pairingNote: picked.pairingNote ?? null, loadNotes: picked.loadNotes ?? [], flowJoGrid: picked.flowJoGrid, flowJoGridInDialog: picked.flowJoGridInDialog,
                        ...(picked.perFileOption ? { perFileOption: picked.perFileOption } : {}) });
                  }}
                >
                  <span className="gl-wsp-name">{tree.name || `(unnamed tree ${tree.index + 1})`}</span>
                  <span className="gl-wsp-meta">
                    {hasFailed(tree.index) ? `${t("could not be imported")} · ` : unreadable(tree) ? `${t("no gate GateLab can read")} · ` : ""}
                    {tree.gateCount} {t("gates")}
                    {tree.rootCount !== null ? ` · ${tree.rootCount.toLocaleString()} ${t("events")}` : ""}
                    {tree.unsupportedCount > 0 ? ` · ${tree.unsupportedCount} ${t("skipped")}` : ""}
                    {tree.populations.length ? ` · ${tree.populations.slice(0, 4).join(", ")}${tree.populations.length > 4 ? "…" : ""}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <div className="gl-modal-actions">
              <button onClick={cancelTreePicker}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
        );
      })()}

      {chorusStats && (
        <ChorusStatisticsModal
          stats={chorusStats}
          comparison={compareChorusStatistics(chorusStats, chorusFileCounts(), chorusImport)}
          record={chorusImport}
          onClose={() => setChorusStats(null)}
        />
      )}

      {flowJoCheckOpen && (() => {
        const check = checkAgainstFlowJo(flowJoReferences, chorusFileCounts());
        return (
          <FlowJoCountCheckModal
            check={check}
            onExport={() => downloadText("flowjo_count_check.csv", flowJoCountCheckCsv(check), "text/csv;charset=utf-8")}
            onClose={() => setFlowJoCheckOpen(false)}
          />
        );
      })()}

      {chorusPicker && chorusTimeline && (
        <ChorusTimelineModal
          experimentName={chorusPicker.experiment?.name ?? null}
          timeline={chorusTimeline}
          hasSample={!!sample}
          target={sample && chorusPicker.experiment
            ? {
                name: fileName,
                same: isRecordingOfExperiment(chorusPicker.experiment, sample.fcs.keywords),
                own: chorusTreesOfViewedFile(chorusPicker.experiment),
              }
            : null}
          onImportTree={(treeIndex) => {
            const picked = chorusPicker;
            if (picked.experiment) void chooseChorusTree(picked.experiment, treeIndex);
          }}
          onImportRecordings={(fileIds) => importChorusRecordings(fileIds)}
          onAddFiles={() => void openFcs()}
          onCancel={() => setChorusPicker(null)}
        />
      )}

      {flowJoOpen && (() => {
        // Every sample paired with the file that IS it -- the files already open plus the ones
        // chosen in this dialog, gated and ungated together -- and what Import will do with that.
        // Recomputed on render, so adding files updates the list. The list, the tree choice, the
        // compensation note and the import all read this one plan.
        const { files: openFiles, pairing, plan } = flowJoOpenPlanOf(flowJoOpen);
        const resolutions = pairing.resolutions;
        const everySample = [...flowJoOpen.samples, ...flowJoOpen.dataSamples];
        // Which files several samples could be, and which samples several files could be, before
        // any choice: a row among the first answers it, and a choice of file the second.
        const unchosen = pairFlowJoWorkspaceFiles(
          [...everySample].sort((a, b) => a.index - b.index), openFiles, {}, flowJoOpenPairingOptions());
        const undecided = unchosen.ambiguous;
        const contested = unchosen.contested;
        // The file a row's choice answers, and the file its text names: one still undecided after
        // the choices made -- else one chosen as another sample, which choosing the row moves here.
        // Taken from before any choice, it was the file already chosen: with a file and its copy
        // each able to be either of two samples, the second row named the copy and moved the file.
        const answeredBy = (index: number) => {
          // A row already chosen for a file answers that file again.
          const r = resolutions.find((q) => q.sampleIndex === index);
          const kept = isPaired(r) && r.status === "chosen" ? undecided.find((a) => a.fileKey === r.fileKey) : undefined;
          return kept ?? pairing.ambiguous.find((a) => a.candidates.includes(index)) ?? undecided.find((a) => a.candidates.includes(index));
        };
        const found = resolutions.filter(isPaired).length;
        const total = everySample.length;
        const chosen = plan.sample;
        // A chosen sample that could be several open data sets can be imported too: the open then
        // asks which sample the first of them is.
        const canImport = !!plan.target || !!plan.resolution?.tiedWith?.length;
        // Data sets already open that only a shared event count could pair with a gated sample.
        const gatedIndex = new Set(flowJoOpen.samples.map((x) => x.index));
        const tiedNote = tiedDataSetsNote(resolutions.filter((r) => gatedIndex.has(r.sampleIndex)), flowJoOpenPairingOptions().events, t);
        // Two samples of one name are told apart by position, as their rows are.
        const nameOf = (index: number) => {
          const x = everySample.find((y) => y.index === index);
          if (!x) return `sample ${index + 1}`;
          return x.duplicateName ? `${x.name} (${t("position")} ${index + 1})` : x.name;
        };
        // A file as the dialog names it: a name another file shares carries where each is, its
        // event count and when it was recorded. "D1.fcs and D1.fcs could each be this sample",
        // and a choice between "D1.fcs (file 1)" and "D1.fcs (file 2)", said nothing about which.
        const fileNames = distinctFileNames(openFiles, {
          events: t("events"), recorded: (when) => t("recorded {when}", { when }), file: (n) => `${t("file")} ${n}`,
        });
        const called = (key: string, name: string) => fileNames.get(key) ?? name;
        // A file that could be a sample, with the copies of it that go with it: one acquisition.
        const withCopies = (f: { fileKey: string; fileName: string; copies?: readonly { fileKey: string; fileName: string }[] }) => f.copies?.length
          ? `${called(f.fileKey, f.fileName)} (${t("and {files}, the same acquisition", { files: f.copies.map((c) => called(c.fileKey, c.fileName)).join(", ") })})`
          : called(f.fileKey, f.fileName);
        const status = (x: FlowJoSampleSummary): string => {
          const r = resolutions.find((q) => q.sampleIndex === x.index);
          if (isPaired(r)) {
            const where = r.fileKey.startsWith("loaded:") ? t("already open") : t("found");
            const how = r.status === "chosen"
              ? ` · ${t("chosen as this sample")}`
              : r.comparison && (r.comparison.verdict === "confirmed" || r.comparison.verdict === "weak")
                ? ` · ${describeAgreement(r.comparison, t)}`
                : "";
            // Copies of the file (one acquisition twice) are this sample too, and get its tree.
            const copies = r.copies?.length
              ? ` · ${t("and {files}, the same acquisition", { files: r.copies.map((c) => called(c.fileKey, c.fileName)).join(", ") })}`
              : "";
            return `${where}: ${called(r.fileKey, r.fileName)}${how}${copies}`;
          }
          if (r?.near && r.status === "contradicted") {
            return t("{file} is named like it but is another acquisition ({why}), so it is not paired",
              { file: called(r.near.fileKey, r.near.fileName), why: describeContradiction("the sample", r.near.differ, "the file") });
          }
          if (r?.near?.rivals && r.status === "ambiguous") {
            return t("{files} could each be this sample, and the keywords cannot tell which: say which below",
              { files: r.near.rivals.map(withCopies).join(" and ") });
          }
          // Several files could each be this sample or another: each is named, and the row says
          // which of them choosing it answers. It named only the last file read.
          if (r?.near?.files && r.status === "ambiguous" && r.near.others.length) {
            const answers = answeredBy(x.index);
            return t("{files} could each be this sample or {others}, and the keywords cannot tell: choosing this row says {file} is this one",
              { files: r.near.files.map((f) => called(f.fileKey, f.fileName)).join(" and "), others: r.near.others.map(nameOf).join(", "),
                file: answers ? called(answers.fileKey, answers.fileName) : called(r.near.files[0].fileKey, r.near.files[0].fileName) });
          }
          if (r?.near && r.status === "ambiguous" && r.near.others.length) {
            const answers = answeredBy(x.index) ?? r.near;
            return t("{file} could be this sample or {others}, and the keywords cannot tell: choose this row if it is this one",
              { file: called(answers.fileKey, answers.fileName), others: r.near.others.map(nameOf).join(", ") });
          }
          if (r?.near?.chosenElsewhere !== undefined) {
            return t("not found — {file} was chosen as {other}", { file: called(r.near.fileKey, r.near.fileName), other: nameOf(r.near.chosenElsewhere) });
          }
          if (r?.tiedWith?.length) return `${t("could be")}: ${r.tiedWith.join(" / ")}`;
          if (r?.near?.outrankedBy !== undefined) {
            return t("not found — {file} is named like it, but records nothing confirming it is this sample; its $FIL and keywords are {other}'s",
              { file: called(r.near.fileKey, r.near.fileName), other: nameOf(r.near.outrankedBy) });
          }
          return `${t("not found")} — ${x.candidateFileNames.join(" / ")}`;
        };
        // Choosing a row chooses whose tree is imported. A row among several a file could be also
        // answers which of them that file is.
        const choose = (x: FlowJoSampleSummary) => {
          const undecidedFile = answeredBy(x.index);
          setFlowJoOpen({
            ...flowJoOpen,
            strategySample: x.index,
            strategyTouched: true,
            crossFile: null,
            fileChoices: undecidedFile ? { ...flowJoOpen.fileChoices, [undecidedFile.fileKey]: x.index } : flowJoOpen.fileChoices,
          });
        };
        // Data sets tied on a shared count are named in the note above.
        const unpairedShown = pairing.unpaired.filter((u) => !u.tied && (u.fileKey.startsWith("pending:") || u.why !== "none"));
        const rivalsOf = (u: (typeof unpairedShown)[number]) =>
          (u.rivals ?? []).map((name, i) => called(u.rivalKeys?.[i] ?? "", name)).join(", ");
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
                <strong>{found}/{total}</strong> {t("found")}
              </div>
              {tiedNote && <div className="gl-modal-note">{tiedNote}</div>}
              {/* The selected row was marked only by a blue outline, which said nothing about
                  what it meant. In shared-hierarchy mode GateLab imports one sample's strategy,
                  and this is where that sample is chosen. Say so, and use a radio, so the choice
                  reads as a choice. */}
              <div className="gl-modal-note">
                {flowJoOpen.perFileTrees
                  ? t("One tree is imported, the chosen sample's. Every other file found gets it with its own gate coordinates where the workspace tailors them; a sample whose tree differs is reported.")
                  : flowJoOpen.samples.length > 1
                    ? t("One shared hierarchy will be imported, so choose the sample whose strategy it should use.")
                    : t("The strategy below will be imported.")}
                {" "}
                {t("A file is paired with its sample by name, and the acquisition keywords FlowJo recorded for that sample ($TOT, $DATE, $BTIM, $ETIM, GUID) must agree with the file's.")}
              </div>

              <div className="gl-wsp-list">
                {flowJoOpen.samples.map((x) => {
                  const isStrategy = x.index === chosen?.index;
                  return (
                    <button
                      key={x.index}
                      className={"gl-wsp-row" + (isStrategy ? " is-strategy" : "")}
                      aria-pressed={isStrategy}
                      onClick={() => choose(x)}
                    >
                      <span className="gl-wsp-name">
                        <input
                          type="radio"
                          name="gatelab-wsp-strategy-sample"
                          checked={isStrategy}
                          readOnly
                          tabIndex={-1}
                          aria-label={t("Import this sample's strategy")}
                          style={{ marginRight: 7 }}
                        />
                        {x.name || `(unnamed sample ${x.index + 1})`}
                        {x.duplicateName && <span className="gl-wsp-dupe">{t("position")} {x.index + 1}</span>}
                      </span>
                      <span className="gl-wsp-meta">
                        {status(x)}
                        {` · ${x.gateCount} ${t("gates")}`}
                        {x.rootCount > 1 ? ` · ${x.rootCount} ${t("trees")}` : ""}
                        {x.owningGroup && x.duplicateName ? ` · ${x.owningGroup}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* A workspace holds one tree. A sample holding several imports the one chosen
                  here, next to the sample list (below the grid option's notes it went unseen), and
                  the result names the rest; the list used to offer "every strategy, one
                  hierarchy each" by default, and then imported only the first. Shown whenever the
                  chosen sample's tree is imported alone, which includes "One hierarchy per file"
                  with only one file found. The list is the trees of the sample that will be
                  imported, and a choice made here stays with that sample. */}
              {chosen && chosen.trees.length > 1 && !plan.perFile && (
                <div className="gl-modal-note">
                  {t("This sample holds {count} trees, and a workspace holds one. Import:", { count: String(chosen.trees.length) })}{" "}
                  <select
                    aria-label={t("Tree to import")}
                    value={plan.treeIndex ?? ""}
                    onChange={(e) => setFlowJoOpen({
                      ...flowJoOpen,
                      strategySample: chosen.index,
                      strategyTouched: true,
                      strategyTree: { sampleIndex: chosen.index, treeIndex: Number(e.target.value) },
                    })}
                  >
                    {/* A tree with no readable gate is shown and not offered, as in the retry picker:
                        it could only fail, and it was offered, and could be the default. */}
                    {chosen.trees.map((tree) => (
                      <option key={tree.index} value={tree.index} disabled={tree.gateCount === 0}>
                        {tree.name || `(unnamed tree ${tree.index + 1})`} — {tree.gateCount === 0 ? t("no gate GateLab can read") : `${tree.gateCount} ${t("gates")}`}
                      </option>
                    ))}
                  </select>
                  <br />
                  {t("The others are not imported; the result names them.")}
                </div>
              )}
              {chosen && chosen.trees.length > 1 && plan.perFile && (
                <div className="gl-modal-note">
                  {t("This sample holds {count} trees. With one hierarchy per file, each file's trees are imported together, as one tree; clear that option to import one tree alone.", { count: String(chosen.trees.length) })}
                </div>
              )}

              {flowJoOpen.dataSamples.length > 0 && (
                <div className="gl-wsp-list">
                  <div className="gl-modal-note">{t("Also in the workspace, with no gates: loaded unselected for actions. Pooling is an explicit action above the plot.")}</div>
                  {flowJoOpen.dataSamples.map((x) => (
                    <div key={x.index} className="gl-wsp-row">
                      <span className="gl-wsp-name">{x.name || `(unnamed sample ${x.index + 1})`}</span>
                      <span className="gl-wsp-meta">{status(x)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Several files could be one sample, and neither the keywords nor a copy's identity
                  tells which: asked once per sample, here, by file. */}
              {contested.map((c) => {
                const sampleName = nameOf(c.sampleIndex);
                const current = c.files.find((f) => flowJoOpen.fileChoices[f.fileKey] === c.sampleIndex)?.fileKey ?? "";
                return (
                  <div key={c.sampleIndex} className="gl-modal-note" data-role="flowjo-contested-sample">
                    <label>
                      {t("{files} could each be \"{sample}\", and the keywords cannot tell which. Which is it?",
                        { files: c.files.map(withCopies).join(" and "), sample: sampleName })}{" "}
                      <select
                        aria-label={t("Which file is this sample")}
                        value={current}
                        onChange={(e) => {
                          const next = Object.fromEntries(Object.entries(flowJoOpen.fileChoices)
                            .filter(([key, index]) => !(index === c.sampleIndex && c.files.some((f) => f.fileKey === key))));
                          if (e.target.value) next[e.target.value] = c.sampleIndex;
                          setFlowJoOpen({ ...flowJoOpen, fileChoices: next });
                        }}
                      >
                        <option value="">{t("not chosen")}</option>
                        {c.files.map((f) => <option key={f.fileKey} value={f.fileKey}>{withCopies(f)}</option>)}
                      </select>
                    </label>
                  </div>
                );
              })}

              {unpairedShown.length > 0 && (
                <div className="gl-modal-note" data-role="flowjo-unpaired-files">
                  {t("Paired with no sample, so they follow the imported tree without a tree of their own:")}{" "}
                  {unpairedShown.map((u) => `${called(u.fileKey, u.fileName)} (${
                    u.why === "contradicted"
                      ? (u.candidates.length === 1 && u.differ.length
                          ? describeContradiction(`sample ${u.candidates[0] + 1} "${nameOf(u.candidates[0])}"`, u.differ, "the file")
                          : t("every sample named like it records another acquisition"))
                      : u.why === "ambiguous"
                        ? (u.candidates.length > 1
                            ? t("{n} samples could be it; choose one above", { n: String(u.candidates.length) })
                            : u.pairedWith
                              ? t("{file} is \"{sample}\"", { file: called(u.pairedWithKey ?? "", u.pairedWith), sample: nameOf(u.candidates[0]) })
                              : u.copyOf
                                ? t("a copy of {file}, which it goes with; {file} and {files} could each be \"{sample}\"; say which above",
                                    { file: called(u.copyOfKey ?? "", u.copyOf), files: rivalsOf(u), sample: nameOf(u.candidates[0]) })
                                : t("it and {files} could each be \"{sample}\"; say which above",
                                    { files: rivalsOf(u), sample: nameOf(u.candidates[0]) }))
                        : t("no sample is named like it")
                  })`).join("; ")}
                </div>
              )}

              {/* A file chosen as a file already open or chosen is not held twice; it is named. */}
              {(flowJoOpen.notHeld ?? []).length > 0 && (
                <div className="gl-modal-note" data-role="flowjo-not-held">
                  {t("Not held, each having the name of a file already open or chosen:")}{" "}
                  {(flowJoOpen.notHeld ?? []).map((k) => `${k.path ?? k.name} (${
                    t(k.open ? "as {file}, already open; {why}" : "as {file}, also chosen; {why}", {
                      file: k.sameAs,
                      why: k.confirmed ? t("its keywords say it is the same acquisition") : t("nothing says it is another acquisition"),
                    })})`).join("; ")}
                </div>
              )}

              {/* Another sample's tree goes onto a file only when the user says so, here, and the
                  control says whose tree onto which file. */}
              {chosen && !isPaired(plan.resolution) && plan.resolution?.near?.rivals && (
                <div className="gl-modal-note" data-role="flowjo-cross-sample">
                  {t("Several files could be \"{sample}\": say which above, and its tree goes on that file.", { sample: chosen.name })}
                </div>
              )}
              {chosen && !isPaired(plan.resolution) && !plan.resolution?.near?.rivals && (
                <div className="gl-modal-note" data-role="flowjo-cross-sample">
                  {t("The FCS of \"{sample}\" is not among the files, so its tree has no file of its own to go on.", { sample: chosen.name })}
                  {openFiles.length > 0 && (
                    <>
                      {" "}
                      <label>
                        {t("Apply \"{sample}\"'s tree to:", { sample: chosen.name })}{" "}
                        <select
                          aria-label={t("Apply this sample's tree to another file")}
                          value={flowJoOpen.crossFile?.sampleIndex === chosen.index ? flowJoOpen.crossFile.fileKey : ""}
                          onChange={(e) => setFlowJoOpen({
                            ...flowJoOpen,
                            strategySample: chosen.index,
                            strategyTouched: true,
                            crossFile: e.target.value ? { sampleIndex: chosen.index, fileKey: e.target.value } : null,
                          })}
                        >
                          <option value="">{t("no file")}</option>
                          {openFiles.map((f) => <option key={f.key} value={f.key}>{called(f.key, f.name)}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  {plan.target?.cross && (
                    <>
                      <br />
                      {t("\"{sample}\"'s tree will be imported onto {file}, which is not that sample.", { sample: chosen.name, file: called(plan.target.fileKey, plan.target.fileName) })}
                    </>
                  )}
                </div>
              )}

              {wspMatrixConflict && (
                <div className="gl-modal-field">
                  <span>
                    {t("This FCS and the workspace each carry a spillover matrix, and they differ by up to {delta}. Which should the gates be evaluated with?",
                       { delta: wspMatrixConflict.delta.toFixed(4) })}
                  </span>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
                    <input
                      type="radio"
                      name="gatelab-wsp-matrix"
                      checked={flowJoOpen.matrixChoice === "workspace"}
                      onChange={() => setFlowJoOpen({ ...flowJoOpen, matrixChoice: "workspace" })}
                    />
                    <span>{t("The workspace's — {name}. This is the compensation in force when the gates were drawn.", { name: wspMatrixConflict.label })}</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
                    <input
                      type="radio"
                      name="gatelab-wsp-matrix"
                      checked={flowJoOpen.matrixChoice === "file"}
                      onChange={() => setFlowJoOpen({ ...flowJoOpen, matrixChoice: "file" })}
                    />
                    <span>{t("The file's — the matrix stored in the FCS, typically the one recorded at acquisition.")}</span>
                  </label>
                </div>
              )}

              {wspMatrixNote && !wspMatrixConflict && (
                <div className="gl-modal-note">
                  {wspMatrixNote.kind === "workspace-only"
                    ? t("These gates were drawn on compensated data and this file carries no spillover matrix, so the workspace's \"{name}\" will be applied to {n} channel(s).",
                        { name: wspMatrixNote.label, n: String(wspMatrixNote.channels) })
                    : t("The workspace's spillover matrix \"{name}\" matches the one in this file; compensation will be enabled with it.",
                        { name: wspMatrixNote.label })}
                </div>
              )}

              <FlowJoGridOption
                checked={flowJoOpen.flowJoGrid}
                onChange={(value) => setFlowJoOpen({ ...flowJoOpen, flowJoGrid: value })}
              />

              {flowJoOpen.samples.length > 1 && (
                <div className="gl-modal-note">
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                    <input
                      type="checkbox"
                      checked={flowJoOpen.perFileTrees}
                      onChange={(e) => setFlowJoOpen({ ...flowJoOpen, perFileTrees: e.target.checked })}
                    />
                    <span>
                      <strong>{t("One hierarchy per file")}</strong><br />
                      <span className="gl-modal-note">
                        {t("Give every found file its own sample's gates. The workspace keeps one tree: each file keeps its own gate coordinates, and a file whose tree differs in structure follows the tree where it differs, which the result names.")}
                      </span>
                    </span>
                  </label>
                </div>
              )}

              <div className="gl-modal-actions">
                <button onClick={() => void chooseFlowJoFolder(flowJoOpen)}>{t("Use the workspace's folder…")}</button>
                <button onClick={() => void chooseFlowJoFcs(flowJoOpen)}>{t("Choose FCS files…")}</button>
                <button onClick={() => setFlowJoOpen(null)}>{t("Cancel")}</button>
                <button
                  disabled={!canImport || wspMatrixPending}
                  title={
                    !canImport
                      ? (!chosen
                          ? t("Choose the sample whose strategy to import")
                          : t("The FCS for the selected strategy has not been found yet"))
                      : wspMatrixPending
                        ? t("Checking the workspace's compensation…")
                        : undefined
                  }
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
        <div className="gl-modal-backdrop" onClick={cancelWspPicker}>
          <div
            className="gl-modal gl-wsp-picker"
            role="dialog"
            aria-label="Choose a FlowJo sample"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gl-modal-title">{t("Choose a sample from the workspace")}</div>
            <div className="gl-modal-note">{wspPicker.reason}</div>
            <div className="gl-wsp-list">
              {wspPicker.samples.map((s) => {
                // What this sample records against the loaded file, so a row that is the file can
                // be told from one that is not; and every row says whose tree goes onto which file.
                const identity = compareIdentity(s.recorded ?? {}, identityKeywords(wspPicker.keywords));
                // A sample the file could be is the file's own once chosen: its tree is not
                // "applied by choice" to another sample's file. Every other row is that.
                const isIt = wspPicker.couldBe.includes(s.index);
                const rowLabel = isIt
                  ? t("{file} is {sample}: import its tree", { sample: s.name || `sample ${s.index + 1}`, file: wspPicker.fileName })
                  : t("Import {sample}'s tree onto {file}", { sample: s.name || `sample ${s.index + 1}`, file: wspPicker.fileName });
                return (
                <button
                  key={s.index}
                  className="gl-wsp-row"
                  aria-label={rowLabel}
                  onClick={() => {
                    const picked = wspPicker;
                    setWspPicker(null);
                    if (picked.fromOpen) {
                      // Asked by a workspace open that could not tell which sample a data set is:
                      // the chosen sample's tree, with the open's answers, as the tree every file
                      // follows.
                      const open = picked.fromOpen;
                      void importFlowJoSample(
                        picked.text, s, null,
                        s.index === open.strategyIndex ? open.treeIndex : openTreeIndex(s, null, false),
                        [], open.matrixChoice, open.openedSampleIds, [],
                        { pairingNote: `${picked.fileName} chosen as sample ${s.index + 1} "${s.name}"`, flowJoGrid: open.flowJoGrid });
                      return;
                    }
                    // Several trees are a choice, as they are for a sample matched by name: taken
                    // together they were merged into one strategy, with a warning to choose one
                    // that offered no way to.
                    void importOntoLoadedFiles(picked.text, picked.wsSamples, s, null, isIt ? null : picked.fileName,
                      isIt ? `${picked.fileName} chosen as sample ${s.index + 1} "${s.name}"` : null);
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
                  <span className="gl-wsp-meta">
                    {identity.verdict === "contradicted"
                      ? describeContradiction(t("It"), identity.differ, wspPicker.fileName)
                      : identity.verdict === "unconfirmed"
                        ? t("records nothing to compare with {file}", { file: wspPicker.fileName })
                        : identity.verdict === "weak"
                          ? t("agrees with {file} on {keys} only, which does not confirm it", { file: wspPicker.fileName, keys: identity.agree.join(", ") })
                          : t("{how} against {file}", { how: describeAgreement(identity, t), file: wspPicker.fileName })}
                    {" · "}
                    {rowLabel}
                  </span>
                </button>
                );
              })}
            </div>
            <div className="gl-modal-actions">
              <button className="gl-tool" onClick={cancelWspPicker}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {loadedContest && (() => {
        const ask = loadedContest;
        // Files named as the result will name them: a name two loaded files share says which.
        const called = loadedFileNames();
        const nameOfFile = (key: string, name: string) => called.get(key) ?? name;
        const sampleName = (index: number) => {
          const x = ask.wsSamples.find((y) => y.index === index);
          if (!x) return `sample ${index + 1}`;
          return x.duplicateName ? `${x.name} (${t("position")} ${index + 1})` : x.name;
        };
        const withCopies = (f: { fileKey: string; fileName: string; copies?: readonly { fileKey: string; fileName: string }[] }) => f.copies?.length
          ? `${nameOfFile(f.fileKey, f.fileName)} (${t("and {files}, the same acquisition", { files: f.copies.map((c) => nameOfFile(c.fileKey, c.fileName)).join(", ") })})`
          : nameOfFile(f.fileKey, f.fileName);
        const go = () => {
          setLoadedContest(null);
          const choices = Object.fromEntries([
            ...Object.entries(ask.answers).filter(([, key]) => key).map(([index, key]) => [key, Number(index)] as const),
            ...Object.entries(ask.fileAnswers).filter(([, index]) => index !== "").map(([key, index]) => [key, Number(index)] as const),
          ]);
          void importOntoLoadedFiles(ask.text, ask.wsSamples, ask.choice, ask.matchedOn, ask.crossTo, ask.pairingNote, choices);
        };
        return (
          <div className="gl-modal-backdrop" onClick={() => setLoadedContest(null)}>
            <div className="gl-modal gl-wsp-picker" role="dialog" aria-label="Which loaded file is each sample" onClick={(e) => e.stopPropagation()}>
              <div className="gl-modal-title">{t("Which loaded file is each sample?")}</div>
              {ask.contested.length > 0 && (
                <div className="gl-modal-note">
                  {t("Several loaded files could each be one sample of this workspace, and the keywords it records cannot tell which. The file chosen gets that sample's tree; the others follow the imported tree.")}
                </div>
              )}
              {ask.undecided.length > 0 && (
                <div className="gl-modal-note">
                  {t("A loaded file could be any of several samples of this workspace, which record one acquisition, and nothing tells which. It gets the tree of the sample chosen; left unchosen, it follows the imported tree.")}
                </div>
              )}
              {ask.contested.map((c) => (
                <label key={c.sampleIndex} className="gl-modal-field" data-role="flowjo-loaded-contested-sample">
                  <span>
                    {t("{files} could each be \"{sample}\", and the keywords cannot tell which. Which is it?",
                      { files: c.files.map(withCopies).join(" and "), sample: sampleName(c.sampleIndex) })}
                  </span>
                  <select
                    aria-label={t("Which file is this sample")}
                    value={ask.answers[c.sampleIndex] ?? ""}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setLoadedContest((cur) => cur && { ...cur, answers: { ...cur.answers, [c.sampleIndex]: value } });
                    }}
                  >
                    <option value="">{t("None of them: they follow the tree")}</option>
                    {c.files.map((f) => <option key={f.fileKey} value={f.fileKey}>{withCopies(f)}</option>)}
                  </select>
                </label>
              ))}
              {ask.undecided.map((a) => (
                <label key={a.fileKey} className="gl-modal-field" data-role="flowjo-loaded-undecided-file">
                  <span>
                    {t("{file} could be {samples}, and the keywords cannot tell which. Which is it?",
                      { file: nameOfFile(a.fileKey, a.fileName), samples: a.candidates.map((i) => `"${sampleName(i)}"`).join(` ${t("or")} `) })}
                  </span>
                  <select
                    aria-label={t("Which sample is this file")}
                    value={ask.fileAnswers[a.fileKey] ?? ""}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setLoadedContest((cur) => cur && { ...cur, fileAnswers: { ...cur.fileAnswers, [a.fileKey]: value } });
                    }}
                  >
                    <option value="">{t("None of them: it follows the tree")}</option>
                    {a.candidates.map((i) => <option key={i} value={String(i)}>{sampleName(i)}</option>)}
                  </select>
                </label>
              ))}
              <div className="gl-modal-actions">
                <button className="gl-tool" onClick={() => setLoadedContest(null)}>{t("Cancel")}</button>
                <button className="gl-tool" onClick={go}>{t("Continue")}</button>
              </div>
            </div>
          </div>
        );
      })()}
      {cytobankAsk && (() => {
        const ask = cytobankAsk;
        const describe = (id: string): string => {
          const entry = samples.find((e) => e.id === id);
          if (!entry) return id;
          const kw = entry.sample.fcs.keywords;
          const when = [kw["$DATE"], kw["$BTIM"]].filter((v) => v && v.trim()).join(" ");
          return `${entry.sourcePath ?? entry.name} · ${entry.sample.fcs.nEvents.toLocaleString()} ${t("events")}` +
            (when ? ` · ${t("recorded {when}", { when })}` : "");
        };
        const finish = () => {
          setCytobankAsk(null);
          const pairs = [...ask.pairs];
          const notes = [...ask.notes];
          for (const a of ask.ambiguous) {
            const id = ask.answers[a.fileName];
            // The loaded files' own spelling: Cytobank's ("c2.FCS") named files called C2.fcs.
            const loadedName = samples.find((e) => e.id === a.entryIds[0])?.name ?? a.fileName;
            const named = `${a.entryIds.length} loaded files are named "${loadedName}"` +
              (loadedName !== a.fileName ? ` (Cytobank's "${a.fileName}")` : "");
            if (id) {
              pairs.push({ fileName: a.fileName, entryId: id, gatingMl: cytobankDocumentForFile(ask.text, a.fileName) });
              notes.push(`${named}; Cytobank's ${a.gates} gate(s) tailored for it were applied to ${describe(id)}, as chosen.`);
            } else {
              notes.push(`${named}; Cytobank's ${a.gates} gate(s) tailored for it were applied to none of them, as chosen: they follow the tree.`);
            }
          }
          void prepareGatingImportFromGatingML(cytobankDocumentForFile(ask.text, null), "", null, [], null, null, [], null, notes, null, [], pairs);
        };
        return (
          <div className="gl-modal-backdrop" onClick={() => setCytobankAsk(null)}>
            <div className="gl-modal gl-wsp-picker" role="dialog" aria-label="Which file Cytobank tailored gates for" onClick={(e) => e.stopPropagation()}>
              <div className="gl-modal-title">{t("Which file are these gates tailored for?")}</div>
              <div className="gl-modal-note">
                {t("Cytobank records the file it tailored gates for by name alone, and several loaded files carry that name. Choose the one they were tailored for, or none: then they follow the tree.")}
              </div>
              {ask.ambiguous.map((a) => (
                <label key={a.fileName} className="gl-modal-field">
                  <span>{t("{count} gate(s) tailored for \"{file}\"", { count: a.gates, file: a.fileName })}</span>
                  <select
                    aria-label={t("File the gates tailored for \"{file}\" go onto", { file: a.fileName })}
                    value={ask.answers[a.fileName] ?? ""}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setCytobankAsk((cur) => cur && { ...cur, answers: { ...cur.answers, [a.fileName]: value || null } });
                    }}
                  >
                    <option value="">{t("None of them: they follow the tree")}</option>
                    {a.entryIds.map((id) => <option key={id} value={id}>{describe(id)}</option>)}
                  </select>
                </label>
              ))}
              <div className="gl-modal-actions">
                <button className="gl-btn-ghost" onClick={() => setCytobankAsk(null)}>{t("Cancel")}</button>
                <button className="gl-btn" onClick={finish}>{t("Continue")}</button>
              </div>
            </div>
          </div>
        );
      })()}
      {divaPicker && (
        <div className="gl-modal-backdrop" onClick={() => setDivaPicker(null)}>
          <div
            className="gl-modal gl-wsp-picker"
            role="dialog"
            aria-label="Choose a FACSDiva gate tree"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="gl-modal-title">{t("Choose a gate tree from the experiment")}</div>
            <div className="gl-modal-note">{divaPicker.reason}</div>
            <div className="gl-wsp-list">
              {divaPicker.trees.map((tree) => {
                const tube = tree.tubeIndex !== null ? divaPicker.tubes[tree.tubeIndex] : undefined;
                const identity = tube ? compareIdentity(tube.recorded, identityKeywords(divaPicker.keywords)) : null;
                // Diva names tubes Tube_001 in every specimen; rows of one name read identically.
                const label = tree.specimen && divaPicker.trees.filter((o) => o.label === tree.label).length > 1
                  ? `${tree.specimen} / ${tree.label}` : tree.label;
                const onto = t("Import {tree}'s gates onto {file}", { tree: label, file: divaPicker.fileName });
                return (
                  <button
                    key={tree.index}
                    className="gl-wsp-row"
                    aria-label={onto}
                    onClick={() => {
                      const picked = divaPicker;
                      setDivaPicker(null);
                      const own = tree.tubeIndex !== null && tree.tubeIndex === picked.tubeHint;
                      void importDivaTree(picked.text, tree, tree.tubeIndex ?? picked.tubeHint, [], own ? null : picked.fileName);
                    }}
                  >
                    <span className="gl-wsp-name">
                      {label}
                      <span className="gl-wsp-dupe">{tree.kind === "worksheet" ? t("worksheet") : t("tube")}</span>
                    </span>
                    <span className="gl-wsp-meta">
                      {tree.gateCount} {t("gates")}
                      {tree.dataFilename ? ` · ${tree.dataFilename}` : ""}
                      {identity?.verdict === "contradicted"
                        ? ` · ${describeContradiction(t("the tube"), identity.differ, divaPicker.fileName)}`
                        : identity?.verdict === "confirmed"
                          ? ` · ${t("{how} against {file}", { how: describeAgreement(identity, t), file: divaPicker.fileName })}`
                          : ""}
                    </span>
                    <span className="gl-wsp-meta">{onto}</span>
                  </button>
                );
              })}
            </div>
            <div className="gl-modal-actions">
              <button className="gl-tool" onClick={() => setDivaPicker(null)}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
      )}
      {barcodeImport && barcodeScheme && sample && (
        <BarcodeSchemeImportModal
          draft={barcodeImport}
          scheme={barcodeScheme}
          channels={sample.channels}
          state={state}
          canLearn={learnedBarcodeTemplate !== null}
          qcPreview={barcodeQcPreview}
          reusePreview={barcodeReusePreview}
          onPlanesChange={(planes) => setBarcodeImport((d) => (d ? { ...d, planes } : d))}
          onParentChange={(parentId) => setBarcodeImport((d) => (d ? { ...d, parentId } : d))}
          onQcChange={(qc) => setBarcodeImport((d) => (d ? { ...d, qc } : d))}
          onReuseChange={(reuse) => setBarcodeImport((d) => (d ? { ...d, reuse } : d))}
          onTemplateDefault={() => setBarcodeImport((d) => (d ? { ...d, template: DEFAULT_BARCODE_TEMPLATE, templateLabel: "GateLab default" } : d))}
          onTemplateLearn={() => {
            if (!learnedBarcodeTemplate) return;
            setBarcodeImport((d) => (d ? {
              ...d,
              template: learnedBarcodeTemplate.template,
              templateLabel: `learned from this workspace (${learnedBarcodeTemplate.planes.length} plane(s)${learnedBarcodeTemplate.qcNames.length ? `, QC chain ${learnedBarcodeTemplate.qcNames.join(" → ")}` : ", no QC chain"})`,
            } : d));
          }}
          onTemplateFile={(f) => void loadBarcodeTemplateFile(f)}
          onDownloadTemplateCsv={() => downloadBlob("barcode-scheme-template.csv", new Blob([barcodeSchemeTemplateCsv()], { type: "text/csv;charset=utf-8" }))}
          onCancel={() => setBarcodeImport(null)}
          onImport={applyBarcodeImport}
        />
      )}
      {groupModal?.mode === "fromMetadata" && (
        <GroupsFromMetadataModal
          columns={metadataColumnNames}
          preview={metadataGroupsPreview}
          onConfirm={applyGroupsFromMetadata}
          onCancel={() => setGroupModal(null)}
        />
      )}
      {groupModal && groupModal.mode !== "fromMetadata" && (
        <HierarchyModal
          mode={groupModal.mode}
          kind="group"
          currentName={state.groups.find((g) => g.id === groupModal.groupId)?.name ?? ""}
          initialName={groupModal.mode === "rename"
            ? state.groups.find((g) => g.id === groupModal.groupId)?.name ?? ""
            : groupModal.mode === "new" ? uniqueHierarchyName("Group", state.groups) : ""}
          takenNames={state.groups.map((g) => g.name)}
          onCancel={() => setGroupModal(null)}
          onConfirm={applyGroupModal}
        />
      )}
      {hierarchyModal && (
        <HierarchyModal
          mode={hierarchyModal}
          currentName={(templateOf(state.active_hierarchy_id, state.hierarchies) ?? activeHierarchy)?.name ?? ""}
          initialName={hierarchyModal === "rename" ? (templateOf(state.active_hierarchy_id, state.hierarchies) ?? activeHierarchy)?.name ?? "" : ""}
          takenNames={state.hierarchies.map((h) => h.name)}
          onCancel={() => setHierarchyModal(null)}
          onConfirm={(name) => applyHierarchyAction(hierarchyModal, name)}
        />
      )}
      {hierarchyCopyDraft && (
        <div className="gl-modal-backdrop" onClick={() => setHierarchyCopyDraft(null)}>
          <div className="gl-modal" role="dialog" aria-label={t("Revert files to the tree")} aria-modal="true" onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setHierarchyCopyDraft(null);
              if (event.key === "Tab") {
                const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
                const first = buttons[0], last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
              }
            }}>
            <div className="gl-modal-title">{t("Revert {count} files to the tree?", { count: hierarchyCopyDraft.fileIds.length })}</div>
            <p>{t("These files will follow the tree again: every tailored gate in them takes the tree's coordinates. Other files and the tree itself stay unchanged.")}</p>
            <ul style={{ maxHeight: 180, overflow: "auto" }}>{hierarchyCopyDraft.fileIds.map((id) => <li key={id}>{samples.find((file) => file.id === id)?.name}</li>)}</ul>
            <p>{t("Files with nothing tailored are not listed. One Undo brings every tailored gate back.")}</p>
            <div className="gl-modal-actions">
              <button type="button" className="gl-btn-ghost" autoFocus onClick={() => setHierarchyCopyDraft(null)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn" onClick={applyHierarchyCopy}>{t("Revert listed files")}</button>
            </div>
          </div>
        </div>
      )}
      {promoteConfirmOpen && activeHierarchy && (activeHierarchy.owner_sample_id || activeHierarchy.owner_group_id) && (
        <ConfirmModal
          title={activeHierarchy.owner_group_id ? "Use this group's gates for the tree?" : viewedGroup && activeHierarchy.source_hierarchy_id === viewedGroupCopy?.id ? `Use this file's gates for ${viewedGroup.name}?` : "Use this file's gates for the tree?"}
          message={`${activeHierarchy.owner_group_id ? "The tree" : viewedGroup && activeHierarchy.source_hierarchy_id === viewedGroupCopy?.id ? `The group "${viewedGroup.name}"` : "The tree"} takes ${activeHierarchy.owner_group_id ? `"${activeHierarchy.name}"` : samples.find((entry) => entry.id === activeHierarchy.owner_sample_id)?.name ?? "this file"}'s gate coordinates, and every file following it follows again; any tailoring they had is dropped. Populations and gate names are unchanged. Undo brings everything back.`}
          confirmLabel={activeHierarchy.owner_group_id ? "Use for the tree" : viewedGroup && activeHierarchy.source_hierarchy_id === viewedGroupCopy?.id ? `Use for ${viewedGroup.name}` : "Use for the tree"}
          onCancel={() => setPromoteConfirmOpen(false)}
          onConfirm={confirmPromote}
        />
      )}
      {barcodeSave && (
        <BarcodeSaveModal
          summary={barcodeSave.summary}
          onSave={applyBarcodeSave}
          onCancel={() => setBarcodeSave(null)}
        />
      )}
      {pendingGatingMlImport && gatingImportNeedsDecision(pendingGatingMlImport, state, samples.length) && (
        <GatingMlImportModal
          nGates={pendingGatingMlImport.result.n_gates_imported}
          nPopulations={pendingGatingMlImport.result.n_pops_imported}
          sourceKind={pendingGatingMlImport.sourceKind ?? "gatingml"}
          sourceLabel={
            pendingGatingMlImport.sourceKind === "flowjo"
              ? "a FlowJo workspace"
              : pendingGatingMlImport.sourceKind === "chorus"
                ? "a FACSChorus experiment"
                : pendingGatingMlImport.sourceKind === "diva"
                  ? "a FACSDiva experiment"
                  : pendingGatingMlImport.result.source === "gatelabr"
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
          structureMatches={
            state.root_population_id !== null && sameStructure(
              { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id },
              pendingGatingMlImport.result,
            )
          }
          compensationNote={pendingGatingMlImport.compensationNote}
          missingMatrix={pendingGatingMlImport.missingMatrix ?? null}
          onSupplyMatrix={(file) => { void supplyMissingMatrix(file); }}
          onUseFcsMatrix={(useFcs) =>
            setPendingGatingMlImport((cur) => cur && cur.missingMatrix
              ? { ...cur, missingMatrix: { ...cur.missingMatrix, useFcs } }
              : cur)
          }
          matrixChoice={(() => {
            // Every file whose own matrix differs from its sample's in the workspace: the primary,
            // and under a per-file import each other file. One answer applies to all of them. A
            // matrix the user supplied is the choice already made.
            const pending = pendingGatingMlImport;
            const primaryDiffers = !!pending.externalSpillover?.differsFromEmbedded
              && pending.externalSpillover.source !== "supplied";
            const others = (pending.siblingTrees ?? []).filter((tree) => tree.externalSpillover?.differsFromEmbedded);
            if (!primaryDiffers && !others.length) return null;
            const deltas = [
              ...(primaryDiffers ? [pending.externalSpillover!.maxDelta ?? 0] : []),
              ...others.map((tree) => tree.externalSpillover!.maxDelta ?? 0),
            ];
            return {
              workspaceLabel: (primaryDiffers ? pending.externalSpillover!.label : others[0].externalSpillover!.label),
              maxDelta: Math.max(...deltas),
              value: pending.matrixChoice,
              ...(primaryDiffers ? { source: pending.externalSpillover!.source === "gatingml" ? "gatingml" as const : "workspace" as const } : {}),
              ...(others.length
                ? {
                    files: [
                      ...(primaryDiffers ? [calledLoaded(pending.primaryFileName ?? fileName, pending.primaryEntryId ?? pending.sampleId)] : []),
                      ...others.map((tree) => calledLoaded(tree.fileName ?? tree.name, tree.entryId)),
                    ],
                  }
                : {}),
            };
          })()}
          onMatrixChoice={(value) => {
            // What the chosen matrix leaves out is named, as when the import was prepared.
            const prepared = pendingGatingMlImport.byMatrixChoice?.[value];
            if (prepared) {
              const said = [...prepared.result.warnings, ...(pendingGatingMlImport.notes ?? [])];
              setError(said.length ? said.join("\n") : null);
            }
            setPendingGatingMlImport((cur) => cur && { ...cur, matrixChoice: value, ...(cur.byMatrixChoice?.[value] ?? {}) });
          }}
          compensationNeedsConfirmation={pendingGatingMlImport.compensation.requiresConfirmation}
          perFileNames={(() => {
            const pending = pendingGatingMlImport;
            if (!pending.primaryFileName || !pending.siblingTrees?.length) return null;
            const listed = [
              { name: pending.primaryFileName, sample: pending.primarySampleLabel, entryId: pending.primaryEntryId ?? null },
              ...pending.siblingTrees.flatMap((tree) => (tree.fileName ? [{ name: tree.fileName, sample: tree.sampleLabel, entryId: tree.entryId ?? null }] : [])),
            ];
            // Two files of one name are told apart by the sample each is, else by where each is,
            // its event count and when it was recorded -- here and among the files that follow
            // the tree, where the same name was listed under both.
            const twice = stagedNameListedTwice(pending);
            const called = loadedFileNames();
            return listed.map((f) => (twice(f.name)
              ? (f.sample ? `${f.name} (${f.sample})` : (f.entryId ? called.get(f.entryId) : undefined) ?? f.name)
              : f.name));
          })()}
          primaryByChoice={pendingGatingMlImport.primaryByChoice ?? null}
          followNames={(() => {
            const pending = pendingGatingMlImport;
            if (!pending.primaryFileName) return null;
            const twice = stagedNameListedTwice(pending);
            const called = loadedFileNames();
            return [...(pending.unreadFiles ?? []), ...(pending.followFiles ?? [])].map((f) => {
              const own = f.entryId ? samples.find((entry) => entry.id === f.entryId)?.name : undefined;
              return own && twice(own) ? called.get(f.entryId!) ?? f.name : f.name;
            });
          })()}
          files={samples.length > 1
            ? {
                total: samples.length,
                selected: checkedSamples.length,
                viewedName: fileName,
                tailored: hierarchyGroups.flatMap((group) => group.members).filter((member) => member.tailored === true).length,
              }
            : null}
          onCancel={() => {
            const opened = pendingGatingMlImport.openedSampleIds ?? [];
            setPendingGatingMlImport(null);
            if (opened.length) {
              // Cancelling the strategy cancels the open: the files it loaded go too, rather than
              // staying as a workspace with its gates left out.
              void removeSamples(opened).then(() => setImportMsg(
                `Workspace open cancelled; the ${opened.length === 1 ? "file it loaded was" : `${opened.length} files it loaded were`} ` +
                "removed again and the current strategy was not changed.",
              ));
            } else {
              setImportMsg("Gating-ML import cancelled; the current strategy was not changed.");
            }
          }}
          onImport={applyGatingImport}
          busy={gatingImportBusy}
          flowJoGrid={pendingGatingMlImport.flowJoGridChoice
            ? { value: pendingGatingMlImport.flowJoGridChoice.value, busy: flowJoGridRedoing }
            : null}
          onFlowJoGrid={(value) => {
            const staged = pendingGatingMlImport;
            if (!staged.flowJoGridChoice) return;
            setFlowJoGridRedoing(true);
            // The workspace is read again with the other answer and the import staged afresh; the
            // matrix answered in this dialog stays answered.
            void staged.flowJoGridChoice.redo(value).finally(() => {
              setFlowJoGridRedoing(false);
              setPendingGatingMlImport((cur) => (cur && cur !== staged ? { ...cur, matrixChoice: staged.matrixChoice } : cur));
            });
          }}
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
          nominalLinearFrom={sample?.hostedAssaySpace === "display" ? sample.hostedAssayId : null}
          hierarchy={{ name: activeHierarchy?.name ?? "", index: activeHierarchyIndex, count: state.hierarchies.length }}
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
      {flowJoExportOpen && sample && (
        <FlowJoExportModal
          files={samples.map((e) => ({
            id: e.id,
            name: e.name,
            hierarchy: state.hierarchies.find((h) => h.id === hierarchyOfFile(e.id))?.name ?? "",
            checked: checkedSamples.some((c) => c.id === e.id),
          }))}
          plan={(scope) => {
            try {
              return planFlowJoExport(flowJoExportSamples(scope));
            } catch (e) {
              return { error: e instanceof Error ? e.message : String(e) };
            }
          }}
          folder={{
            writes: supportsDirectoryAccess() ? "directory" : "zip",
            preview: (scope) => {
              try {
                const { stem, plan } = flowJoFolderPlan(scope);
                const wanted = flowJoExportSamples(scope);
                // The .wsp as the export will write it, at the most its counts could make it.
                const workspaceBytes = flowJoWorkspaceBytesAtMost({
                  samples: wanted.map((sample, i) => ({ ...sample, folderPath: plan.files[i].path })),
                  producer: "GateLab",
                  groups: flowJoExportGroups(),
                });
                return previewFlowJoFolder(plan, stem, workspaceBytes);
              } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
              }
            },
          }}
          onCancel={() => setFlowJoExportOpen(false)}
          onExport={(scope, asFolder) => {
            void exportFlowJo(scope, asFolder);
            setFlowJoExportOpen(false);
          }}
        />
      )}
      {tour.step && !isSceHost && (
        <TourOverlay
          step={tour.step}
          index={tour.index}
          total={tour.total}
          reached={tour.reached}
          held={tour.held}
          arriving={tour.arriving}
          ctx={readTourContext()}
          tabLabels={TOUR_TAB_LABELS}
          onNext={tour.next}
          onBack={tour.back}
          onEnd={tour.end}
          onArrive={tour.arrive}
        />
      )}
    </div>
  );

  /** The app as the tutorial sees it. Read on demand, so the tabs' own state is current. */
  /**
   * Takes the app to where a tutorial step happens, one thing at a time: a workspace first (the
   * demo, when none is open), then the tab, then the Compensation tab's view. The tutorial calls
   * again until nothing is unmet, so each call does only what can be done now.
   */
  function arriveForTour(unmet: TourNeeds): void {
    if (unmet.workspace) {
      // One opening at a time, and none after one has failed: a copy without a demo says so
      // once, and the tutorial then waits for the user to open a workspace.
      if (tourOpeningDemo.current === "opening" || tourOpeningDemo.current === "failed") return;
      tourOpeningDemo.current = "opening";
      void openDemoWorkspace().then((opened) => { tourOpeningDemo.current = opened ? "idle" : "failed"; });
      return;
    }
    if (unmet.tab) {
      if (TABS.some((tab) => tab.id === unmet.tab)) setActiveTab(unmet.tab as TabId);
      return;
    }
    if (unmet.compensationView) {
      // The view is the tab's own state, so it is changed as the user changes it: by its switch.
      const view = resolveTourTarget({ selector: '[role="tab"]', text: t(unmet.compensationView === "global" ? "Global inspector" : "Matrix"), exact: true });
      if (view instanceof HTMLElement) view.click();
    }
  }

  function readTourContext(): TourContext {
    const populations: TourContext["populations"] = {};
    for (const [id, pop] of Object.entries(state.populations)) {
      populations[id] = { id, name: pop.name, parentId: pop.parent_id, children: [...pop.children], gateCount: pop.gate_refs?.length ?? 0, gateIds: (pop.gate_refs ?? []).map((ref) => ref.gate_id) };
    }
    const gates: TourContext["gates"] = {};
    for (const id of state.gate_order.length ? state.gate_order : Object.keys(state.gates)) {
      const gate = state.gates[id];
      if (gate) gates[id] = { id, name: gate.name, type: gate.gate_type, x: gate.x_channel, y: gate.y_channel, shape: JSON.stringify("vertices" in gate ? gate.vertices : gate), onFlowJoGrid: gate.space === "display" && gate.transforms?.[gate.x_channel]?.kind === "flowjoChannels" && gate.transforms?.[gate.y_channel]?.kind === "flowjoChannels" };
    }
    const strategy = strategyConfigRef.current;
    const figure = illustConfigRef.current?.figure ?? null;
    const activeSheet = layoutWorkspace.sheets.find((sheet) => sheet.id === layoutWorkspace.activeSheetId) ?? layoutWorkspace.sheets[0];
    return {
      host: isSceHost ? "sce" : "browser",
      language,
      activeTab,
      workspaceName: wsName,
      files: samples.map((entry) => ({ id: entry.id, name: entry.name, checked: !excludedSampleIds.has(entry.id), viewed: entry.id === activeSampleId })),
      pooled: poolSelection,
      rootId: state.root_population_id,
      populations,
      gates,
      activePopulationId: state.active_population_id,
      selectedGateId: state.selected_gate_id,
      axes: (() => {
        const xKey = sample?.channels[xIdx]?.key ?? null;
        const yKey = sample?.channels[yIdx]?.key ?? null;
        const scaleOf = (idx: number) => !sample || !sample.channels[idx]
          ? null
          : sample.isScatterAxis(idx)
            ? sample.scatterScale(idx)
            : sample.isFluorChannel(idx)
              ? sample.fluorScale(idx)
              : sample.isImagingFeatureAxis(idx)
                ? sample.featureScale(idx)
                : "fixed";
        return {
          x: xKey,
          y: yKey,
          xScale: scaleOf(xIdx),
          yScale: scaleOf(yIdx),
          xLinearOffered: !!sample && (sample.isScatterAxis(xIdx) || sample.isImagingFeatureAxis(xIdx)),
          yLinearOffered: !!sample && (sample.isScatterAxis(yIdx) || sample.isImagingFeatureAxis(yIdx)),
          rangeKey: JSON.stringify([xRange, yRange, xKey ? globalScales[xKey] ?? null : null, yKey ? globalScales[yKey] ?? null : null]),
        };
      })(),
      displayMode: mode,
      maxEvents,
      strategy: strategy ? { fullPath: strategy.fullPath, back: strategy.gateView.includes("back"), mode: strategy.mode } : null,
      illustration: figure ? { composition: figure.composition, populations: figure.populations.length } : null,
      layout: {
        items: layoutWorkspace.sheets.reduce((total, sheet) => total + sheet.items.length, 0),
        sheets: layoutWorkspace.sheets.length,
        allEvents: activeSheet?.style?.maxEvents === 0,
      },
      proportions: { populations: readProportionsSettings(defaultProportionsSettings(samples, state, metadataColumns)).selectedPops.length },
      metadataColumns: metadataColumnNames,
      divisionProfiles: Object.keys(divisionProfiles).length,
      assayLayer: sample?.activeLayer ?? null,
      compensation: (() => {
        const held = Object.entries(readPersistedTabValues("compensation."));
        return {
          pairSelected: held.some(([key, value]) => key.endsWith(".selectedPair") && value !== null),
          view: String(held.find(([key]) => key.endsWith(".workspaceView"))?.[1] ?? "matrix"),
          galleryLayer: String(held.find(([key]) => key.endsWith(".globalInspectorLayer"))?.[1] ?? "compensated"),
          matrixKey: JSON.stringify(workspaceCompensation.lineages),
        };
      })(),
      scales: (() => {
        // The Scales tab draws every channel with a held range in blue. A range GateLab fitted
        // itself when a plot was first shown is still marked as such; any other was set by the user.
        const adjusted: string[] = [];
        const fitted: string[] = [];
        sample?.channels.forEach((channel, index) => {
          if (!globalScales[channel.key]) return;
          const byGateLab = !!activeAxisScaleContextKey && autoFittedScales.current.has(autoFittedScaleKey(activeAxisScaleContextKey, channel.key));
          (byGateLab ? fitted : adjusted).push(sample.channelLabel(index));
        });
        return { adjusted, fitted, locked: lockScalesBetweenFiles };
      })(),
      signals: { ...tourSignals.current },
    };
  }
}
