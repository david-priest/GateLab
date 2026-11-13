// PlottingTab.tsx — population/category composition across samples, ported from GateLabR's
// Proportions tab (app.R:1130-1155, 4287-4441). Unlike GateLabR (which only read SCE colData and
// so could not use gated populations), GateLab lets a POPULATION partition be the Category: each
// event is labelled by the deepest selected population (events in none → "ungated"). Group / Unit /
// Facet come from per-sample metadata (or the sample name). Rendered as a custom SVG stacked bar
// (composition per Group) or boxplot (per-unit fraction per Category, dodged by Group).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { finishExportSvg, pdfVectorPage, pngBlob } from "../plots/exportSvg";
import { usePersistedTabState } from "./tabState";
import type { CoreState, Derived } from "../store";
import type { Sample } from "../engine/sample";
import { populationTreeOrder } from "../engine/populations";
import type { DivisionProfileLike } from "../engine/factors";
import { OVERLAY_PALETTES, populationColorOf, type PaletteName } from "../engine/palettes";
import { plottingFacetLevels, plottingFactorLevels, plottingGroupLevels } from "./plottingColours";
import { columnLevelsAfterReorder, LevelOrderControl } from "./LevelOrderControl";
import type { MetadataColumn } from "../engine/metadata";
import { SAMPLE_ID_FIELD } from "../engine/metadata";
import { useI18n } from "./i18n";
import { TabIntro, TabIntroToggle, useTabIntro } from "./TabIntro";
import { NumberField } from "./NumberField";
import { FigureStyleFollow, useFigureStyle } from "./figureStyle";
import { figureHierarchies } from "../engine/figure";
import {
  buildProportionsModel,
  defaultProportionsSettings,
  proportionsCategoryColors,
  type ProportionsModel,
  type ProportionsSettings,
} from "../engine/proportionsModel";
import { BASE_PROPORTIONS_SETTINGS, consistentPlotType, normalizePanelWidth, PLOT_TYPES_BY_VALUE, PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";
import { buildCellValuesModel } from "../engine/cellValuesModel";
import { CellValuesChart, cellChartAxis, cellPlotType, splitsViolins, type CellChannelPart } from "./CellValuesChart";
import { sharesValueAxis, valueAxisOptions } from "./chart/valueAxis";
import { comparisonDescription, comparisonPaired } from "./chart/chartComparisons";
import { StatisticChart } from "./StatisticChart";
import { cellsDataTable, channelsDataTable, plottingDataTableCsv, proportionsDataTable, statisticDataTable } from "./plottingData";
import { PlottingDataTableView } from "./PlottingDataTableView";
import { FoldSummary } from "./FoldSummary";
import { FileChecklist } from "./FileChecklist";
import { PopulationChecklist } from "./PopulationChecklist";
import { plottingPages, plottingPanelBlocks, type PlottingPanelBlock } from "./plottingPanels";
import { panelDimensionText } from "./panelArrangement";
import type { LayoutProportionsPanel } from "../engine/layout";
import { DimensionShelves } from "./DimensionShelves";
import { useEveryPageMenu } from "./layoutHandoff/useEveryPageMenu";
import { chartShelfAllowed, chartShelves, chartDimensionMovable, placeChartDimension, type ChartDimension, type ChartShelf } from "./plottingShelves";
import { composeProportionsChartSvg, divisionWithinName, ProportionsChart, proportionsFactorTitle, proportionsValueTitle } from "./ProportionsChart";

// The chart moved to ProportionsChart.tsx and its label format to chart/chartFormat.ts; their
// names stay exported from here, where other files and tests import them.
export {
  composeProportionsChartSvg,
  divisionWithinName,
  fittedValueAxis,
  ProportionsChart,
  proportionPanelLayout,
  proportionsFactorTitle,
  proportionsValueTitle,
  type ProportionPanelLayout,
} from "./ProportionsChart";
export { compactChartLabel } from "./chart/chartFormat";

interface SampleRef {
  id: string;
  name: string;
  sample: Sample;
  hierarchyId?: string;
}
interface Props {
  samples: SampleRef[];
  activeSampleId: string | null;
  state: CoreState;
  derived: Derived;
  metadata: Record<string, Record<string, string>>;
  metadataColumns: MetadataColumn[];
  divisionProfiles: Record<string, DivisionProfileLike>;
  /** Aggregate Sample revision snapshot; every sample contributes to the model. */
  dataRevisionKey: string;
  onConfigChange?: () => void;
  /** Put the chart as it is now on the Layout tab, as one block that keeps these settings; with pages, `panel` names the page shown. */
  onAddToLayout?: (settings: ProportionsSettings, panel?: LayoutProportionsPanel) => void;
  /** Put the chart on the Layout tab as a block per panel, in the arrangement drawn here, and its legend. */
  onAddPanelsToLayout?: (settings: ProportionsSettings, blocks: PlottingPanelBlock[]) => void;
  /** Every page of the chart on the Layout tab, a new sheet per page named by its label, each holding a block of that page. */
  onAddPagesToLayout?: (settings: ProportionsSettings, pages: readonly { label: string; page: string }[]) => void;
  /** Every page's panels on the Layout tab, a new sheet per page, each holding a block per panel of that page and the legend. */
  onAddPanelPagesToLayout?: (settings: ProportionsSettings, pages: readonly { label: string; blocks: PlottingPanelBlock[] }[]) => void;
  /**
   * A channel's range on the Gating tab, for a per-cell chart's value axis: asked for the one
   * channel drawn, and only while the chart is framed on it.
   */
  gatingRange?: (channel: string) => [number, number] | undefined;
  /** The Illustration figure's panel size, so a chart's panels can be made the same size; unset when there is no figure. */
  illustrationPanelSize?: number;
  /** The chart picker and its undo and redo, drawn at the top of the side panel. */
  chartBar?: ReactNode;
  /** Set a metadata column's order of its values for the whole workspace, or clear it (undefined) for the file list's order. */
  onColumnLevels?: (column: string, levels: string[] | undefined) => void;
}

/** The channel a per-cell chart opens on: forward scatter, the usual measure of cell size, else the first. */
export function defaultCellChannel(channels: readonly { key: string }[]): string {
  return (channels.find((c) => /^FSC-?A$/i.test(c.key)) ?? channels.find((c) => /^FSC/i.test(c.key)) ?? channels[0])?.key ?? "";
}

/**
 * The channels a per-cell chart can draw: every given file's, in the first file's order, each by
 * key with its label on the file it is first found in.
 */
export function cellChannelOptions(files: readonly { sample: Sample }[]): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const entry of files) {
    entry.sample.channels.forEach((channel, index) => {
      if (!seen.has(channel.key)) seen.set(channel.key, entry.sample.channelLabel(index));
    });
  }
  return [...seen].map(([key, label]) => ({ key, label }));
}

/**
 * The channel a per-cell chart draws: the one chosen when a drawn file has it, else the default.
 * The tab and the Layout tab's "+ Plotting chart" both resolve it here, so they draw the same one.
 */
export function resolveCellChannel(chosen: string, files: readonly { sample: Sample }[]): string {
  const options = cellChannelOptions(files);
  return options.some((option) => option.key === chosen) ? chosen : defaultCellChannel(options);
}

/**
 * The files as last given, while each is the same file: App hands the tab a new array on every
 * render, and the chart's models are keyed on it, so without this they would be rebuilt for a
 * style change or any unrelated App update.
 */
function useStableFiles(files: SampleRef[]): SampleRef[] {
  const held = useRef(files);
  const prev = held.current;
  if (
    prev !== files &&
    (prev.length !== files.length ||
      files.some((file, i) => file.id !== prev[i].id || file.name !== prev[i].name || file.sample !== prev[i].sample || file.hierarchyId !== prev[i].hierarchyId))
  )
    held.current = files;
  return held.current;
}

/** The proportion model while the tab draws cells: nothing is counted for a chart not shown. */
const EMPTY_PROPORTIONS_MODEL: ProportionsModel = { catLevels: [], perSample: [], hasFacet: false, excluded: [] };

/** Which populations are not drawn in which files (a model's `partial`): "D3.fcs (FSC_high); …". */
function partialList(partial: readonly { file: string; populations: string[] }[]): string {
  return partial.map((entry) => `${entry.file} (${entry.populations.join(", ")})`).join("; ");
}

const SAMPLE_OPT = PROPORTIONS_SAMPLE_FACTOR;
const NONE_OPT = PROPORTIONS_NO_FACTOR;
/** Each plot type's name in the Plot picker. */
const PLOT_TYPE_LABELS: Record<ProportionsSettings["plotType"], string> = {
  stacked: "Stacked bar",
  box: "Boxplot",
  violin: "Violin",
  bar: "Bar",
  dots: "Points",
  splitViolin: "Split violin",
  ridgeline: "Ridgelines",
};
/** A panel's height beyond its plot: the title above and the axis labels below. */
const PANEL_MARGIN_HEIGHT = 68;

/**
 * A value-axis limit: a number, or blank for automatic. Committed on Enter or leaving the field,
 * as NumberField commits; Escape restores the committed value.
 */
function AxisLimitField({ value, onCommit, placeholder, "aria-label": ariaLabel }: { value: number | null; onCommit: (value: number | null) => void; placeholder: string; "aria-label": string }) {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (raw: string) => {
    const next = raw.trim() === "" ? null : Number(raw);
    if (next !== null && !Number.isFinite(next)) {
      setDraft(shown);
      return;
    }
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(shown);
        }
      }}
    />
  );
}

export function PlottingTab({
  samples: givenFiles,
  state: activeState,
  metadata,
  metadataColumns,
  divisionProfiles,
  dataRevisionKey,
  onConfigChange,
  onAddToLayout,
  onAddPanelsToLayout,
  onAddPagesToLayout,
  onAddPanelPagesToLayout,
  gatingRange,
  illustrationPanelSize,
  chartBar,
  onColumnLevels,
}: Props) {
  const files = useStableFiles(givenFiles);
  const { t } = useI18n();
  const intro = useTabIntro("plotting");
  // Kept across the remount that showing another chart or undoing makes.
  const [section, setSection] = usePersistedTabState("plotting.section", "data");
  // The settings before the user touches anything, shared with the Layout tab, so a chart taken
  // from there before this tab has been opened is the chart this tab would show.
  const [defaults] = useState(() => defaultProportionsSettings(files, activeState, metadataColumns));
  const [selectedFiles, setSelectedFiles] = usePersistedTabState<string[]>("prop.files", () => defaults.files);
  // A file added to the workspace while the tab is in use is drawn too, as it would be had it been
  // there when the tab opened; a file the user unticked stays unticked.
  const knownFiles = useRef(new Set(files.map((file) => file.id)));
  useEffect(() => {
    const added = files.map((file) => file.id).filter((id) => !knownFiles.current.has(id));
    if (!added.length) return;
    added.forEach((id) => knownFiles.current.add(id));
    setSelectedFiles((ids) => [...ids, ...added.filter((id) => !ids.includes(id))]);
  }, [files, setSelectedFiles]);
  // One tree per workspace: the files' copies follow it by provenance, so there is no tree to pick.
  const [hierarchyId] = usePersistedTabState("prop.hierarchy", defaults.hierarchy);
  const trees = figureHierarchies(activeState);
  const tree = trees[hierarchyId] ?? trees[activeState.active_hierarchy_id];
  const state = { ...activeState, ...tree };
  const samples = files.filter((file) => selectedFiles.includes(file.id));
  const [chartHeight, setChartHeight] = usePersistedTabState("prop.height", defaults.height);
  const [showGrid, setShowGrid] = usePersistedTabState("prop.grid", defaults.grid);
  const [showPoints, setShowPoints] = usePersistedTabState("prop.points", defaults.points);
  const [pairedLines, setPairedLines] = usePersistedTabState("prop.paired", defaults.paired);
  const [showLegend, setShowLegend] = usePersistedTabState("prop.legend", defaults.legend);
  const [pointRadius, setPointRadius] = usePersistedTabState("prop.pointRadius", defaults.pointRadius);
  const [showN, setShowN] = usePersistedTabState("prop.showN", defaults.showN);
  const [colourByPopulation, setColourByPopulation] = usePersistedTabState("prop.colourByPopulation", false);
  const [populationsTogether, setPopulationsTogether] = usePersistedTabState("prop.populationsTogether", false);
  const rootId = state.root_population_id ?? "";
  const divisionSamples = useMemo(
    () => samples.filter((entry) => divisionProfiles[entry.id]),
    [samples, divisionProfiles, dataRevisionKey],
  );
  const hasDivision = divisionSamples.length > 0;

  const [categoryKind, setCategoryKind] = usePersistedTabState<
    "population" | "division"
  >("prop.categoryKind", defaults.categoryKind);
  const [plotTypeHeld, setPlotType] = usePersistedTabState<ProportionsSettings["plotType"]>("prop.plotType", defaults.plotType);
  const [valueKind, setValueKind] = usePersistedTabState<ProportionsSettings["valueKind"]>("prop.valueKind", defaults.valueKind);
  // The type the value kind can draw, as the settings reader takes it (consistentPlotType), so a
  // restored or hand-made mismatch is drawn as the Layout tab would take it.
  const plotType = consistentPlotType({ ...BASE_PROPORTIONS_SETTINGS, valueKind, plotType: plotTypeHeld }).plotType;
  // The channels a per-cell chart can draw: every ticked file's, in the first file's order.
  const channelSource = samples.length ? samples : files;
  const channelOptions = useMemo(
    () => cellChannelOptions(channelSource),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelSource.map((entry) => entry.id).join("\0"), files, dataRevisionKey],
  );
  const [channelSel, setChannel] = usePersistedTabState<string>("prop.channel", defaults.channel);
  const channel = resolveCellChannel(channelSel, channelSource);
  // The channels drawn besides the first, each with its own panels and value axis: those chosen
  // that a drawn file has, in the order chosen.
  const [channelsSel, setChannels] = usePersistedTabState<string[]>("prop.channels", defaults.channels);
  const extraChannels = useMemo(
    () => channelsSel.filter((key, i) => key !== channel && channelsSel.indexOf(key) === i && channelOptions.some((option) => option.key === key)),
    [channelsSel, channel, channelOptions],
  );
  const channelLabel = (key: string) => channelOptions.find((option) => option.key === key)?.label ?? key;
  const chooseChannel = (key: string) => {
    setChannel(key);
    setChannels([key, ...extraChannels.filter((extra) => extra !== key)]);
  };
  // The list keeps the first channel first, so a chart read from it draws the same one.
  const toggleChannel = (key: string, on: boolean) => {
    setChannel(channel);
    setChannels([channel, ...(on ? [...extraChannels, key] : extraChannels.filter((extra) => extra !== key))]);
  };
  const [xAxis, setXAxis] = usePersistedTabState<"populations" | "groups">("prop.xAxis", defaults.xAxis);
  const [cellRange, setCellRange] = usePersistedTabState<"gating" | "fit">("prop.cellRange", defaults.cellRange);
  const [violinBox, setViolinBox] = usePersistedTabState("prop.violinBox", defaults.violinBox);
  const [statistic, setStatistic] = usePersistedTabState<ProportionsSettings["statistic"]>("prop.statistic", defaults.statistic);
  const [errorBar, setErrorBar] = usePersistedTabState<ProportionsSettings["errorBar"]>("prop.errorBar", defaults.errorBar);
  const [rankTest, setRankTest] = usePersistedTabState("prop.test", defaults.test);
  const [comparisons, setComparisons] = usePersistedTabState<ProportionsSettings["comparisons"]>("prop.comparisons", defaults.comparisons);
  const [comparisonsShow, setComparisonsShow] = usePersistedTabState<ProportionsSettings["comparisonsShow"]>("prop.comparisonsShow", defaults.comparisonsShow);
  const [replicateMarks, setReplicateMarks] = usePersistedTabState<ProportionsSettings["replicateMarks"]>("prop.replicateMarks", defaults.replicateMarks);
  const [proportionValue, setProportionValue] = usePersistedTabState<ProportionsSettings["proportionValue"]>("prop.proportionValue", defaults.proportionValue);
  const [valueMin, setValueMin] = usePersistedTabState<number | null>("prop.valueMin", defaults.valueMin ?? null);
  const [valueMax, setValueMax] = usePersistedTabState<number | null>("prop.valueMax", defaults.valueMax ?? null);
  const [valueFromZero, setValueFromZero] = usePersistedTabState("prop.valueFromZero", defaults.valueFromZero);
  const [shareValueAxis, setShareValueAxis] = usePersistedTabState<boolean | null>("prop.shareValueAxis", defaults.shareValueAxis);
  const cells = valueKind === "cells";
  const stat = valueKind === "statistic";
  // A chart of a channel's values, per cell or per sample, rather than of proportions.
  const channelChart = cells || stat;
  const chooseValueKind = (kind: ProportionsSettings["valueKind"]) => {
    setValueKind(kind);
    if (!PLOT_TYPES_BY_VALUE[kind].includes(plotTypeHeld)) setPlotType(PLOT_TYPES_BY_VALUE[kind][0]);
    if (kind !== "proportion" && categoryKind === "division") setCategoryKind("population");
    // A statistic compares groups: they run along x, a panel per population, as the proportion boxplot draws them.
    if (kind === "statistic") setXAxis("groups");
  };
  // A composition is the children of ONE parent, stacked to 100% with the rest of that parent:
  // never a mix of levels, which double-counted nested populations and could not tell the same
  // quadrant under two parents apart.
  const [parentSel, setParentSel] = usePersistedTabState<string>("prop.parent", defaults.parent);
  const parentId = state.populations[parentSel] ? parentSel : rootId;
  // While the parent is being changed, the tree is the whole tree and a click picks the parent.
  const [choosingParent, setChoosingParent] = useState(false);
  // The whole tree, root first, for the arm picker: clicking a population makes it the parent
  // the proportions are shown within.
  const treeRows = useMemo(() => populationTreeOrder(state.populations, rootId), [state.populations, rootId]);
  const childIds = useMemo(() => state.populations[parentId]?.children.filter((id) => state.populations[id]) ?? [], [state.populations, parentId]);
  // Everything beneath the parent, at every depth, in tree order with its connectors relative
  // to the parent. A population that recurs under several arms is told apart by where it sits.
  const armRows = useMemo(() => {
    const out: { popId: string; depth: number; isLastPath: boolean[] }[] = [];
    const walk = (id: string, depth: number, isLastPath: boolean[]) => {
      const kids = state.populations[id]?.children.filter((c) => state.populations[c]) ?? [];
      kids.forEach((c, i) => {
        const path = [...isLastPath, i === kids.length - 1];
        out.push({ popId: c, depth, isLastPath: path });
        walk(c, depth + 1, path);
      });
    };
    walk(parentId, 0, []);
    return out;
  }, [state.populations, parentId]);
  const armIds = useMemo(() => new Set(armRows.map((r) => r.popId)), [armRows]);
  const [selectedPopsRaw, setSelectedPops] = usePersistedTabState<string[]>("prop.selectedPops", () => defaults.selectedPops);
  // Only populations beneath the parent count; a selection saved against another arm, or a
  // whole tree, reads as "the parent's children". Each event goes to the deepest selected
  // population holding it, so nested selections nest rather than double-count.
  const selectedPops = useMemo(() => {
    const within = selectedPopsRaw.filter((id) => armIds.has(id));
    return within.length || selectedPopsRaw.length === 0 ? within : childIds;
  }, [selectedPopsRaw, armIds, childIds]);
  const [includeUngated, setIncludeUngated] = usePersistedTabState("prop.includeUngated", defaults.includeUngated);
  const [groupSel, setGroupSel] = usePersistedTabState<string>("prop.groupSel", defaults.groupSel);
  const [unitSel, setUnitSel] = usePersistedTabState<string>("prop.unitSel", defaults.unitSel);
  const [facetSel, setFacetSel] = usePersistedTabState<string>("prop.facetSel", defaults.facetSel);
  const [palette, setPalette] = usePersistedTabState<PaletteName>("prop.palette", defaults.palette);
  const [averagePerUnit, setAveragePerUnit] = usePersistedTabState("prop.averagePerUnit", defaults.averagePerUnit);
  // Chart font sizes (px) — axis ticks / axis title / legend.
  const [ownFontTick, setFontTick] = usePersistedTabState("prop.fontTick", defaults.fontTick);
  const [ownFontAxis, setFontAxis] = usePersistedTabState("prop.fontAxis", defaults.fontAxis);
  const [ownFontLegend, setFontLegend] = usePersistedTabState("prop.fontLegend", defaults.fontLegend);
  // A chart that uses the workspace's figure style draws its text at the style's sizes; its own
  // are kept for when it stops. A chart of a workspace saved before the style holds false here
  // (tabState.ts), so only a new chart starts with it on.
  const [followFigureStyle, setFollowFigureStyle] = usePersistedTabState("prop.followFigureStyle", true);
  const { style: figureStyle } = useFigureStyle();
  const fontTick = followFigureStyle ? figureStyle.fontTick : ownFontTick;
  const fontAxis = followFigureStyle ? figureStyle.fontAxis : ownFontAxis;
  const fontLegend = followFigureStyle ? figureStyle.fontLegend : ownFontLegend;
  const [panelColumns, setPanelColumns] = usePersistedTabState<ProportionsSettings["panelColumns"]>("prop.panelColumns", defaults.panelColumns);
  const [panelRows, setPanelRows] = usePersistedTabState<ProportionsSettings["panelRows"]>("prop.panelRows", defaults.panelRows);
  const [pageBy, setPageBy] = usePersistedTabState<ProportionsSettings["pageBy"]>("prop.pageBy", defaults.pageBy);
  // The page shown, as Illustration's pager holds it: not saved, the first page on opening.
  const [pageIndex, setPageIndex] = useState(0);
  const [panelsPerRow, setPanelsPerRow] = usePersistedTabState("prop.panelsPerRow", defaults.panelsPerRow);
  const [panelWidth, setPanelWidth] = usePersistedTabState("prop.panelWidth", defaults.panelWidth);
  // A change marks the workspace unsaved; opening the tab, or a workspace opening under it, does not.
  const configMounted = useRef(false);
  useEffect(() => {
    if (!configMounted.current) {
      configMounted.current = true;
      return;
    }
    onConfigChange?.();
  }, [
    selectedFiles,
    hierarchyId,
    parentSel,
    categoryKind,
    plotType,
    selectedPops,
    includeUngated,
    groupSel,
    unitSel,
    facetSel,
    palette,
    averagePerUnit,
    fontTick,
    fontAxis,
    fontLegend,
    followFigureStyle,
    colourByPopulation,
    populationsTogether,
    chartHeight,
    showGrid,
    showPoints,
    pairedLines,
    showLegend,
    pointRadius,
    plotTypeHeld,
    valueKind,
    channelSel,
    channelsSel,
    xAxis,
    cellRange,
    violinBox,
    panelColumns,
    panelRows,
    pageBy,
    panelsPerRow,
    panelWidth,
    statistic,
    errorBar,
    rankTest,
    comparisons,
    comparisonsShow,
    proportionValue,
    showN,
    valueMin,
    valueMax,
    valueFromZero,
    shareValueAxis,
    replicateMarks,
  ]);

  useEffect(() => {
    if (categoryKind === "division" && !hasDivision)
      setCategoryKind("population");
  }, [categoryKind, hasDivision, setCategoryKind]);

  // The model's inputs, apart from how it is drawn, so a font or plot type change never recounts events.
  const modelSettings = useMemo<ProportionsSettings>(
    () => ({
      ...BASE_PROPORTIONS_SETTINGS,
      files: selectedFiles,
      hierarchy: hierarchyId,
      categoryKind,
      parent: parentSel,
      selectedPops: selectedPopsRaw,
      includeUngated,
      groupSel,
      unitSel,
      facetSel,
    }),
    [selectedFiles, hierarchyId, categoryKind, parentSel, selectedPopsRaw, includeUngated, groupSel, unitSel, facetSel],
  );
  const model = useMemo(
    () => (channelChart ? EMPTY_PROPORTIONS_MODEL : buildProportionsModel(modelSettings, files, activeState, metadata, divisionProfiles)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelChart, modelSettings, files, divisionProfiles, activeState.gate_version, activeState.stored_hierarchies, metadata, dataRevisionKey],
  );
  // The cells of a per-cell or statistic chart: counted again only when its data inputs change,
  // never for a style change. A statistic takes each replicate unit's cells on linear values, as
  // the Statistics tab's "Raw" does.
  const cellModel = useMemo(
    () =>
      channelChart
        ? buildCellValuesModel({ ...modelSettings, valueKind, channel }, files, activeState, metadata, stat ? { poolBy: "unit", values: "raw" } : {})
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelChart, stat, modelSettings, channel, files, activeState.gate_version, activeState.stored_hierarchies, metadata, dataRevisionKey],
  );
  // A per-cell chart's replicate marks: each unit's cells on linear values, pooled by unit as the
  // statistic chart pools them, so each mark is the value that chart draws for the unit.
  const replicateOn = cells && replicateMarks !== "none";
  const unitModel = useMemo(
    () => (replicateOn ? buildCellValuesModel({ ...modelSettings, valueKind, channel }, files, activeState, metadata, { poolBy: "unit", values: "raw" }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replicateOn, modelSettings, channel, files, activeState.gate_version, activeState.stored_hierarchies, metadata, dataRevisionKey],
  );
  const gatingFrame = useMemo(
    () => (cells && cellRange === "gating" ? gatingRange?.(channel) : undefined),
    [cells, cellRange, gatingRange, channel],
  );
  const xAxisFrame = useMemo(
    () => (cellModel && cells ? cellChartAxis(cellModel, cellRange, gatingFrame, { min: valueMin, max: valueMax }) : null),
    [cellModel, cells, cellRange, gatingFrame, valueMin, valueMax],
  );
  // Every channel besides the first: its cells (pooled by unit for a statistic), its replicate
  // marks' units and its own value axis, the typed limits taken in its own units.
  const extraModels = useMemo(
    () =>
      channelChart
        ? extraChannels.map((key) => ({
            key,
            model: buildCellValuesModel({ ...modelSettings, valueKind, channel: key }, files, activeState, metadata, stat ? { poolBy: "unit", values: "raw" } : {}),
            unitModel: replicateOn ? buildCellValuesModel({ ...modelSettings, valueKind, channel: key }, files, activeState, metadata, { poolBy: "unit", values: "raw" }) : null,
          }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channelChart, stat, replicateOn, modelSettings, extraChannels, files, activeState.gate_version, activeState.stored_hierarchies, metadata, dataRevisionKey],
  );
  // Every population side by side at each group in one panel: the groups along x, a per-cell or statistic chart.
  const together = populationsTogether && xAxis === "groups" && valueKind !== "proportion";
  // A split violin pairs the two groups of a panel per population; the plot-type hints say why not.
  const canSplit = !!cellModel && cells && !together && splitsViolins(new Set(cellModel.violins.map((violin) => violin.group)).size, xAxis);
  const plotTypeHint = (type: ProportionsSettings["plotType"]) =>
    type === "splitViolin"
      ? canSplit
        ? t("Each population's violin split between the two groups: the first group's cells on the left half, the second's on the right")
        : t("A split violin needs exactly two groups, along x; with any other number each group's violin is drawn whole")
      : type === "ridgeline"
        ? t("The Illustration tab draws ridgelines of single files with gates, under its histogram layout")
        : undefined;
  // The value axis's limits, start and sharing, as every chart kind takes them.
  const axisSettings = { valueMin, valueMax, valueFromZero, shareValueAxis };
  const axisOptions = valueAxisOptions({ valueKind, plotType, xAxis, populationsTogether: together, ...axisSettings });

  // Where the dimensions sit: one along x, and the panels wrapped or a column or row per value of
  // the chart's panel dimensions, as the Arrange dimensions shelves place them.
  const drawnChannels = channelChart ? [channel, ...extraModels.map((part) => part.key)] : [channel];
  const shelfSettings = { valueKind, plotType, xAxis, populationsTogether: together, panelColumns, panelRows, pageBy, channel, channels: drawnChannels };
  const hasFacet = facetSel !== NONE_OPT;
  const shelves = chartShelves(shelfSettings, hasFacet);
  const arrangement = { panelColumns, panelRows, pageBy, panelsPerRow, panelWidth };
  const placeDimension = (dimension: string, shelf: string) => {
    const patch = placeChartDimension(shelfSettings, hasFacet, dimension as ChartDimension, shelf as ChartShelf);
    if (patch.xAxis !== undefined) setXAxis(patch.xAxis);
    if (patch.panelColumns !== undefined) setPanelColumns(patch.panelColumns);
    if (patch.panelRows !== undefined) setPanelRows(patch.panelRows);
    if (patch.pageBy !== undefined) setPageBy(patch.pageBy);
  };
  const factorName = (factor: string) => (factor === SAMPLE_OPT ? t("Files") : proportionsFactorTitle(factor) ?? factor);
  const dimensionChip = (dimension: ChartDimension) => {
    const label = dimension === "channels" ? t("Channels") : dimension === "populations" ? t("Populations") : dimension === "groups" ? factorName(groupSel) : factorName(facetSel);
    return { id: dimension, label, name: label, fixed: !chartDimensionMovable(shelfSettings, dimension) };
  };
  const matchIllustration = () => {
    if (!illustrationPanelSize) return;
    // Illustration's panel size is a plot's whole side, its margins included.
    setPanelWidth(normalizePanelWidth(illustrationPanelSize));
    setChartHeight(Math.max(140, Math.min(800, Math.round(illustrationPanelSize - PANEL_MARGIN_HEIGHT))));
  };

  const factorOptions = (
    <>
      <option value={SAMPLE_OPT}>{t("File (filename)")}</option>
      {!metadataColumns.some((column) => column.name === SAMPLE_ID_FIELD) && (
        <option value={SAMPLE_ID_FIELD}>Sample ID</option>
      )}
      {metadataColumns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </>
  );

  const nCat = cellModel ? cellModel.catLevels.length : model.catLevels.length;
  const drawable = cellModel ? cellModel.violins.some((violin) => violin.values.length > 0) : model.perSample.length > 0;
  const catColors = cellModel
    ? proportionsCategoryColors(cellModel, { palette, includeUngated: false }, state.populations)
    : proportionsCategoryColors(model, { palette, includeUngated }, state.populations);
  // Where colour stands for populations the chart takes each population's own colour, and the
  // palette has nothing to colour.
  const coloursPopulations = cellModel ? xAxis === "populations" || together : plotType === "stacked" && categoryKind === "population";
  // Each group's colour is its place among the groups of every ticked file, as on a Layout block.
  // Groups, facets and units are drawn in each metadata column's own order of its values (the
  // workspace's, set here, in the Metadata tab or by an import), else in the file list's order, as
  // Illustration and the file list order them.
  const columnLevels = useMemo(
    () => Object.fromEntries(metadataColumns.filter((column) => column.levels?.length).map((column) => [column.name, column.levels!])),
    [metadataColumns],
  );
  const groupLevels = useMemo(() => plottingGroupLevels(modelSettings, files, metadata, columnLevels), [modelSettings, files, metadata, columnLevels]);
  const facetLevels = useMemo(() => plottingFacetLevels(modelSettings, files, metadata, columnLevels), [modelSettings, files, metadata, columnLevels]);
  const unitLevels = useMemo(() => plottingFactorLevels(modelSettings, unitSel, files, metadata, columnLevels), [modelSettings, unitSel, files, metadata, columnLevels]);
  const levels = { groups: groupLevels, facets: facetLevels, units: unitLevels };
  const replicates = useMemo(
    () => (unitModel && replicateMarks !== "none" ? { unitModel, statistic: replicateMarks, unitSel, unitLevels, test: rankTest && !together, comparisons: { comparisons, comparisonsShow } } : undefined),
    [unitModel, replicateMarks, unitSel, unitLevels, rankTest, together, comparisons, comparisonsShow],
  );
  // With several channels, each channel as the charts take it: its cells, its own value axis and replicate marks.
  const channelParts = useMemo((): CellChannelPart[] | undefined => {
    if (!cellModel || !extraModels.length) return undefined;
    const axisOf = (key: string, model: typeof cellModel) =>
      cells ? cellChartAxis(model, cellRange, cellRange === "gating" ? gatingRange?.(key) : undefined, { min: valueMin, max: valueMax }) : null;
    const first = { key: channel, label: cellModel.channelLabel || channelLabel(channel), model: cellModel, axis: xAxisFrame ?? axisOf(channel, cellModel), replicates };
    const rest = extraModels.map((part) => ({
      key: part.key,
      label: part.model.channelLabel || channelLabel(part.key),
      model: part.model,
      axis: axisOf(part.key, part.model),
      replicates: replicates && part.unitModel ? { ...replicates, unitModel: part.unitModel } : undefined,
    }));
    // A per-cell channel without an axis (no cells) is left out; a statistic frames its own.
    return [first, ...rest].flatMap((part) => (part.axis || stat ? [{ ...part, axis: part.axis ?? { range: [0, 1], major: [], minor: [] } }] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellModel, extraModels, cells, stat, cellRange, gatingRange, valueMin, valueMax, channel, xAxisFrame, replicates, channelOptions]);
  // With a dimension on Pages, a page per value, one shown at a time with the pager.
  const pages = useMemo(
    () => plottingPages({ ...BASE_PROPORTIONS_SETTINGS, valueKind, plotType, xAxis, populationsTogether: together, pageBy, channel, channels: channelParts?.map((part) => part.key) ?? [channel] }, channelChart ? null : model, cellModel, { groups: groupLevels, facets: facetLevels }),
    [valueKind, plotType, xAxis, together, pageBy, channel, channelParts, channelChart, model, cellModel, groupLevels, facetLevels],
  );
  const currentPage = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const page = pages.length ? pages[currentPage] : undefined;
  const pageText = page === undefined || !shelves.pages[0]
    ? ""
    : panelDimensionText({ facet: page, group: page, population: page, channel: page }, shelves.pages[0], { group: proportionsFactorTitle(groupSel), facet: proportionsFactorTitle(facetSel), channels: Object.fromEntries((channelParts ?? []).map((part) => [part.key, part.label])) });
  /** The Order control for a Group or Facet picker's value: a workspace column's, or a line saying files follow the file list. */
  const orderControl = (label: string, factor: string, shown: readonly string[]) => {
    const column = metadataColumns.find((entry) => entry.name === factor);
    if (!column) return <span className="gl-prop-order-hint">{t("Files are drawn in the file list's order.")}</span>;
    if (!onColumnLevels) return null;
    return (
      <LevelOrderControl
        label={label}
        levels={shown}
        customised={!!column.levels?.length}
        hint={t("This order applies wherever the column is used.")}
        onReorder={(order) => onColumnLevels(column.name, columnLevelsAfterReorder(order, column.levels))}
        onReset={() => onColumnLevels(column.name, undefined)}
      />
    );
  };
  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  // As Illustration's export does, the page shown is written.
  const exportChart = (kind: "svg" | "png" | "pdf") =>
    void downloadChart("gl-prop-svg", pages.length ? `proportions_page-${currentPage + 1}` : "proportions", kind);
  // The table the chart is drawn from. A per-cell chart's summaries are taken again on the cells'
  // linear values, as the Statistics tab takes them on Raw; the drawn model holds display values,
  // on which the whiskers are found. The same rows are shown under the chart; the function is
  // made again only when its inputs change, so the open table is not rebuilt for a redraw.
  const chartDataTable = useMemo(() => () => {
    const titles = { group: proportionsFactorTitle(groupSel), unit: proportionsFactorTitle(unitSel), facet: proportionsFactorTitle(facetSel) };
    const channelLabel = cellModel?.channelLabel ?? channel;
    const levels = { groups: groupLevels, facets: facetLevels, units: unitLevels };
    // With several channels, each channel's rows in turn, led by a Channel column.
    const parts = channelParts ?? [];
    if (stat && cellModel) {
      // With the populations together no test is drawn, so the table holds none.
      const statSettings = { statistic, errorBar, test: rankTest && !together, comparisons, comparisonsShow, xAxis, unitSel, plotType, panelWidth, height: chartHeight, fontTick, fontAxis };
      if (parts.length > 1) return channelsDataTable(parts.map((part) => ({ channel: part.label, table: statisticDataTable(part.model, statSettings, titles, "", levels) })));
      return statisticDataTable(cellModel, statSettings, titles, channelLabel, levels);
    } else if (cells && cellModel) {
      const rawOf = (key: string) => buildCellValuesModel({ ...modelSettings, valueKind, channel: key }, files, activeState, metadata, { values: "raw" });
      if (parts.length > 1) return channelsDataTable(parts.map((part) => ({ channel: part.label, table: cellsDataTable(rawOf(part.key), part.model, titles, "", { ...levels, xAxis }, part.replicates) })));
      const rawModel = rawOf(channel);
      return cellsDataTable(rawModel, cellModel, titles, channelLabel, { ...levels, xAxis }, replicates);
    }
    const names = new Map(files.map((entry) => [entry.id, entry.name]));
    const tests = rankTest && plotType !== "stacked" ? { comparisons, comparisonsShow, paired: comparisonPaired({ valueKind, plotType, paired: pairedLines, unitSel }) } : undefined;
    return proportionsDataTable(model, titles, (id) => names.get(id) ?? id, unitSel === SAMPLE_OPT || unitSel === NONE_OPT, levels, plotType === "stacked" ? "parent" : proportionValue, tests);
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [stat, cells, model, cellModel, channelParts, channel, valueKind, modelSettings, files, metadata, activeState.gate_version, activeState.stored_hierarchies, dataRevisionKey, groupSel, unitSel, facetSel, groupLevels, facetLevels, unitLevels, statistic, errorBar, rankTest, together, comparisons, comparisonsShow, pairedLines, xAxis, plotType, proportionValue, panelWidth, chartHeight, fontTick, fontAxis, replicates]);
  const exportData = () => {
    const csv = plottingDataTableCsv(chartDataTable());
    const stamp = new Date().toISOString().slice(0, 10);
    triggerDownload(URL.createObjectURL(new Blob([csv], { type: "text/csv" })), `plotting_${stat ? "statistic" : cells ? "cells" : "proportions"}_${stamp}.csv`);
  };
  // With pages, the page shown: the block records it, and the panels are the page's.
  const addToLayout = () => onAddToLayout?.(currentSettings(), page !== undefined ? ({ page } satisfies LayoutProportionsPanel) : undefined);
  const addPanelsToLayout = () => {
    const settings = currentSettings();
    onAddPanelsToLayout?.(settings, plottingPanelBlocks(settings, channelChart ? null : model, cellModel, levels, page, channelParts));
  };
  // Every page, a sheet each: each page named as the pager names it.
  const pageLabel = (value: string) => (shelves.pages[0] ? panelDimensionText({ facet: value, group: value, population: value, channel: value }, shelves.pages[0], { group: proportionsFactorTitle(groupSel), facet: proportionsFactorTitle(facetSel), channels: Object.fromEntries((channelParts ?? []).map((part) => [part.key, part.label])) }) : value);
  const addPagesToLayout = () => onAddPagesToLayout?.(currentSettings(), pages.map((value) => ({ label: pageLabel(value), page: value })));
  const addPanelPagesToLayout = () => {
    const settings = currentSettings();
    onAddPanelPagesToLayout?.(settings, pages.map((value) => ({ label: pageLabel(value), blocks: plottingPanelBlocks(settings, channelChart ? null : model, cellModel, levels, value, channelParts) })));
  };
  const pagesMenu = useEveryPageMenu();
  // Under the test control: whether to compare every pair, which brackets to draw, and one line
  // saying what is tested and on what (comparisonDescription, which a Layout legend also gives).
  const comparisonGroups = cellModel ? new Set(cellModel.violins.map((violin) => violin.group)).size : new Set(model.perSample.map((row) => row.group)).size;
  const testDescription = comparisonDescription({ valueKind, plotType, test: rankTest, xAxis, populationsTogether: together, comparisons, paired: pairedLines, unitSel, statistic, proportionValue, replicateMarks }, comparisonGroups);
  const comparisonControls = (enabled: boolean) => (
    <>
      <label className="gl-field-inline" title={t("Every pair of groups, each drawn as a bracket with its Holm-adjusted p, as well as the test across the groups")}>
        {t("Comparisons")}
        <select aria-label={t("Comparisons")} value={comparisons} disabled={!enabled} onChange={(e) => setComparisons(e.target.value as ProportionsSettings["comparisons"])}>
          <option value="overall">{t("Overall")}</option>
          <option value="pairwise">{t("Pairwise")}</option>
        </select>
      </label>
      <label className="gl-field-inline" title={t("Draw every pair's bracket, or only those with an adjusted p below 0.05")}>
        {t("Brackets")}
        <select aria-label={t("Brackets")} value={comparisonsShow} disabled={!enabled || comparisons !== "pairwise"} onChange={(e) => setComparisonsShow(e.target.value as ProportionsSettings["comparisonsShow"])}>
          <option value="all">{t("All pairs")}</option>
          <option value="significant">{t("Adjusted p < 0.05")}</option>
        </select>
      </label>
      {enabled && testDescription && <p className="gl-hint gl-prop-test-description">{testDescription}.</p>}
    </>
  );
  const currentSettings = (): ProportionsSettings => ({
      ...modelSettings,
      valueKind,
      channel,
      channels: drawnChannels,
      xAxis,
      cellRange,
      violinBox,
      statistic,
      errorBar,
      test: rankTest,
      comparisons,
      comparisonsShow,
      proportionValue,
      plotType,
      palette,
      averagePerUnit,
      fontTick: ownFontTick,
      fontAxis: ownFontAxis,
      fontLegend: ownFontLegend,
      followFigureStyle,
      ...(colourByPopulation ? { colourByPopulation: true } : {}),
      ...(populationsTogether ? { populationsTogether: true } : {}),
      height: chartHeight,
      grid: showGrid,
      points: showPoints,
      paired: pairedLines,
      legend: showLegend,
      pointRadius,
      showN,
      replicateMarks,
      panelColumns,
      panelRows,
      pageBy,
      panelsPerRow,
      panelWidth,
      ...axisSettings,
    });

  return (
    <div
      className={`gl-tab-panel gl-tab-fill gl-plotting-workspace section-${section}`}
    >
      <div className="gl-plotting-head">
        <strong>Plotting</strong>
        <span>{t("Population composition, replicate-level distributions and per-cell values")}</span>
        <TabIntroToggle intro={intro} />
        {onAddToLayout && (
          <div className="gl-plotting-head-actions">
            <button
              type="button"
              className="gl-mini-btn"
              disabled={samples.length === 0 || nCat === 0 || !drawable}
              title={t("One block on the Layout tab, drawn there as it is here; its files and populations stay its own")}
              onClick={(event) => pagesMenu.open(event, pages.length, addToLayout, onAddPagesToLayout && addPagesToLayout)}
            >
              {t("Add to Layout")}
            </button>
            {onAddPanelsToLayout && (
              <button
                type="button"
                className="gl-mini-btn"
                disabled={samples.length === 0 || nCat === 0 || !drawable}
                title={t("A block per panel on the Layout tab, in the arrangement drawn here, and the legend as a block of its own; under a sheet's file iteration, panels that differ only in their populations are drawn for each file")}
                onClick={(event) => pagesMenu.open(event, pages.length, addPanelsToLayout, onAddPanelPagesToLayout && addPanelPagesToLayout)}
              >
                {t("Add panels to Layout")}
              </button>
            )}
            {pagesMenu.menu}
          </div>
        )}
      </div>
      <aside className="gl-plotting-inspector" aria-label="Plotting controls">
        {chartBar}
        <nav className="gl-presentation-tabs" aria-label="Plotting inspector">
          {["data", "plot", "style", "export"].map((tab) => (
            <button
              key={tab}
              aria-pressed={section === tab}
              onClick={() => setSection(tab)}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </nav>
        <section className="gl-plotting-files">
          <h3>{t("Files / samples")} <span>{t("{count} selected", { count: samples.length })}</span></h3>
          <FileChecklist
            files={files.map((file) => ({ id: file.id, name: file.name, metadata: metadata[file.id] }))}
            selected={selectedFiles}
            onChange={setSelectedFiles}
            columns={[groupSel, unitSel, facetSel].filter((column, i, all) => column !== SAMPLE_OPT && column !== NONE_OPT && all.indexOf(column) === i)}
            levels={columnLevels}
            listClassName="gl-plotting-filelist"
          />
        </section>
        {categoryKind === "population" && (
          <section className="gl-plotting-populations" aria-label="Populations">
            <h3>Populations <span>{selectedPops.length} selected</span></h3>
            {/* The parent the shares are of: changed by picking a population in the tree, which
                then offers that parent's descendants to tick. */}
            <div className="gl-plotting-parent">
              <span>{t("Parent")}: <strong>{state.populations[parentId]?.name ?? parentId}</strong></span>
              <button
                type="button"
                className="gl-mini-btn"
                aria-pressed={choosingParent}
                title={choosingParent ? undefined : t("Pick a population in the tree to compose within")}
                onClick={() => setChoosingParent((current) => !current)}
              >
                {choosingParent ? t("Cancel") : t("Change")}
              </button>
            </div>
            <PopulationChecklist
              compact
              heading={false}
              label="Composition parent and populations"
              rows={choosingParent
                ? treeRows.map(({ popId, depth, isLastPath }) => ({ key: popId, name: state.populations[popId]?.name ?? popId, depth, isLastPath, color: populationColorOf(state.populations[popId]) }))
                : armRows.map(({ popId, depth, isLastPath }) => ({ key: popId, name: state.populations[popId]?.name ?? popId, depth: depth + 1, isLastPath, color: populationColorOf(state.populations[popId]) }))}
              selected={choosingParent ? [] : selectedPops}
              onToggle={(popId) => setSelectedPops(() => toggle(selectedPops, popId))}
              pick={choosingParent ? {
                current: parentId,
                title: (name) => t("Compose within {name}", { name }),
                onPick: (popId) => {
                  setParentSel(popId);
                  setSelectedPops(state.populations[popId]?.children.filter((id) => state.populations[id]) ?? []);
                  setChoosingParent(false);
                },
              } : undefined}
              actions={choosingParent ? undefined : <>
                <button type="button" className="gl-mini-btn" onClick={() => setSelectedPops([...childIds])} title="The parent's direct children: a plain partition">
                  Children
                </button>
                <button type="button" className="gl-mini-btn" onClick={() => setSelectedPops(armRows.map((r) => r.popId))} title="Every population beneath the parent; deeper ones nest inside their parents">
                  All
                </button>
                <button type="button" className="gl-mini-btn" onClick={() => setSelectedPops([])}>
                  None
                </button>
              </>}
            />
            {!choosingParent && armRows.length === 0 && <p className="gl-hint">This population has nothing beneath it to compose.</p>}
          </section>
        )}
        <div className="gl-control-sections" aria-label="Plotting settings">
          <section
            className="gl-control-section gl-prop-section-plot"
            aria-labelledby="prop-plot-heading"
          >
            <span id="prop-plot-heading" className="gl-control-section-label">
              {t("Plot")}
            </span>
            <div className="gl-control-section-body">
              <label className="gl-check" title={t("Each population's share of its parent, per file or replicate unit")}>
                <input
                  type="radio"
                  name="prop-value"
                  checked={!channelChart}
                  onChange={() => chooseValueKind("proportion")}
                />
                {t("Proportions")}
              </label>
              <label className="gl-check" title={t("A channel's value in every cell of each population, such as cell size by forward scatter")}>
                <input
                  type="radio"
                  name="prop-value"
                  checked={cells}
                  onChange={() => chooseValueKind("cells")}
                />
                {t("Channel per cell (violins, boxes)")}
              </label>
              <label className="gl-check" title={t("A channel's median, mean or geometric mean in each replicate unit's cells of each population, such as a marker's median per donor")}>
                <input
                  type="radio"
                  name="prop-value"
                  checked={stat}
                  onChange={() => chooseValueKind("statistic")}
                />
                {t("Channel statistic per sample (points, bars)")}
              </label>
              <span className="gl-ctl-sep" />
              {PLOT_TYPES_BY_VALUE[valueKind].map((type) => (
                <label key={type} className="gl-check" title={plotTypeHint(type)}>
                  <input
                    type="radio"
                    name="prop-type"
                    checked={plotType === type}
                    disabled={type === "splitViolin" && !canSplit}
                    onChange={() => setPlotType(type)}
                  />
                  {t(PLOT_TYPE_LABELS[type])}
                </label>
              ))}
              {!channelChart && (
                <>
                  <label className="gl-field-inline" title={plotType === "stacked" ? t("A stacked bar is the composition of the parent") : t("What each replicate unit's value is: the population's share of its parent, of the file's root population, or its events, as the Statistics tab gives them")}>
                    {t("Value")}
                    <select aria-label={t("Value")} value={proportionValue} disabled={plotType === "stacked"} onChange={(e) => setProportionValue(e.target.value as ProportionsSettings["proportionValue"])}>
                      <option value="parent">{t("% of parent")}</option>
                      <option value="total">{t("% of total")}</option>
                      <option value="count">{t("Count")}</option>
                    </select>
                  </label>
                  {(plotType === "bar" || plotType === "dots") && (
                    <label className="gl-field-inline">
                      {t("Error bar")}
                      <select aria-label={t("Error bar")} value={errorBar} onChange={(e) => setErrorBar(e.target.value as ProportionsSettings["errorBar"])}>
                        <option value="sd">SD</option>
                        <option value="sem">SEM</option>
                      </select>
                    </label>
                  )}
                  <label className="gl-check" title={plotType === "stacked" ? t("Draw a boxplot, bars or points to test between the groups") : t("Wilcoxon rank-sum for two groups, Kruskal-Wallis for more, on one value per replicate unit")}>
                    <input type="checkbox" checked={rankTest} disabled={plotType === "stacked"} onChange={(e) => setRankTest(e.target.checked)} />
                    {t("Rank test between groups")}
                  </label>
                  {comparisonControls(rankTest && plotType !== "stacked")}
                </>
              )}
              {channelChart && (
                <>
                  <span className="gl-ctl-sep" />
                  <label className="gl-field-inline">
                    {t("Channel")}
                    <select aria-label={t("Channel")} value={channel} onChange={(e) => chooseChannel(e.target.value)}>
                      {channelOptions.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details className="gl-prop-channels">
                    <FoldSummary>
                      <span title={t("Draw more channels, each in panels of its own on its own value axis")}>
                        {extraChannels.length ? t("Channels: {count}", { count: String(extraChannels.length + 1) }) : t("More channels")}
                      </span>
                    </FoldSummary>
                    <fieldset aria-label={t("More channels")}>
                      {channelOptions.filter((option) => option.key !== channel).map((option) => (
                        <label key={option.key} className="gl-check">
                          <input type="checkbox" checked={extraChannels.includes(option.key)} onChange={(e) => toggleChannel(option.key, e.target.checked)} />
                          {option.label}
                        </label>
                      ))}
                    </fieldset>
                  </details>
                  {stat && (
                    <>
                      <label className="gl-field-inline">
                        {t("Statistic")}
                        <select aria-label={t("Statistic")} value={statistic} onChange={(e) => setStatistic(e.target.value as ProportionsSettings["statistic"])}>
                          <option value="median">{t("Median")}</option>
                          <option value="mean">{t("Mean")}</option>
                          <option value="geomean">{t("Geometric mean")}</option>
                        </select>
                      </label>
                      <label className="gl-field-inline" title={plotType === "box" ? t("A boxplot shows the quartiles, not an error bar") : undefined}>
                        {t("Error bar")}
                        <select aria-label={t("Error bar")} value={errorBar} disabled={plotType === "box"} onChange={(e) => setErrorBar(e.target.value as ProportionsSettings["errorBar"])}>
                          <option value="sd">SD</option>
                          <option value="sem">SEM</option>
                        </select>
                      </label>
                      <label className="gl-check" title={together ? t("The rank test compares the groups within a panel of one population; with the populations side by side in one panel there is none") : xAxis === "groups" ? t("Wilcoxon rank-sum for two groups, Kruskal-Wallis for more, on one value per replicate unit") : t("Put the groups along x to test between them")}>
                        <input type="checkbox" checked={rankTest} disabled={xAxis !== "groups" || together} onChange={(e) => setRankTest(e.target.checked)} />
                        {t("Rank test between groups")}
                      </label>
                      {comparisonControls(rankTest && xAxis === "groups" && !together)}
                      <TabIntro intro={intro}>
                        {t("Each point is one replicate unit: the statistic of the channel's linear values in the unit's cells of a population, its files pooled, as the Statistics tab computes it on Raw values. A unit with no cell of a population has no point for it. The axis is linear, so a bar's length and an error bar read as values. A box spans the units' quartiles, its whiskers reaching the furthest units within 1.5 × the interquartile range (Tukey); a bar is the mean with SD or SEM. The rank test compares the groups' unit values in each panel, never the cells.")}
                      </TabIntro>
                    </>
                  )}
                  {cells && (
                  <>
                  <label className="gl-field-inline" title={t("The channel's range on the Gating tab, so the axis matches a gating plot of the channel; or the range of the cells drawn")}>
                    {t("Value axis")}
                    <select aria-label={t("Value axis")} value={cellRange} onChange={(e) => setCellRange(e.target.value as "gating" | "fit")}>
                      <option value="gating">{t("As on the Gating tab")}</option>
                      <option value="fit">{t("Fit to the cells")}</option>
                    </select>
                  </label>
                  <label className="gl-check">
                    <input
                      type="checkbox"
                      checked={violinBox}
                      disabled={plotType !== "violin" && plotType !== "splitViolin"}
                      onChange={(e) => setViolinBox(e.target.checked)}
                    />
                    {t("Median and quartiles inside")}
                  </label>
                  <label className="gl-field-inline" title={t("Draw each replicate unit's median or mean of its own cells as a point over the pooled cells; the unit is set under Grouping")}>
                    {t("Replicates")}
                    <select aria-label={t("Replicates")} value={replicateMarks} onChange={(e) => setReplicateMarks(e.target.value as ProportionsSettings["replicateMarks"])}>
                      <option value="none">{t("(none)")}</option>
                      <option value="median">{t("Median")}</option>
                      <option value="mean">{t("Mean")}</option>
                    </select>
                  </label>
                  {replicateOn && (
                    <label className="gl-check" title={together ? t("The rank test compares the groups within a panel of one population; with the populations side by side in one panel there is none") : xAxis === "groups" ? t("Wilcoxon rank-sum for two groups, Kruskal-Wallis for more, on one value per replicate unit, never on the cells") : t("Put the groups along x to test between them")}>
                      <input type="checkbox" checked={rankTest} disabled={xAxis !== "groups" || together} onChange={(e) => setRankTest(e.target.checked)} />
                      {t("Rank test between groups")}
                    </label>
                  )}
                  {replicateOn && comparisonControls(rankTest && xAxis === "groups" && !together)}
                  <TabIntro intro={intro}>
                    {t("Each violin or box holds every cell of a population in a group, the group's files pooled, on the channel's display scale as the Gating tab draws it. A violin's width is a kernel density of the cells (Silverman's bandwidth), scaled to the same greatest width for every violin. A box spans the quartiles and its whiskers reach the furthest cells within 1.5 × the interquartile range (Tukey); cells beyond them are not drawn one by one. Hover a violin for its cells, files and median.")}
                  </TabIntro>
                  </>
                  )}
                </>
              )}
              {/* Population or Division, drawn only when Division can be chosen: a division
                  profile is applied and the chart is a proportion chart. */}
              {hasDivision && !channelChart && (
                <>
                  <span className="gl-ctl-sep" />
                  <label className="gl-check">
                    <input
                      type="radio"
                      name="prop-cat"
                      checked={categoryKind === "population"}
                      onChange={() => setCategoryKind("population")}
                    />
                    {t("Population")}
                  </label>
                  <label className="gl-check">
                    <input
                      type="radio"
                      name="prop-cat"
                      checked={categoryKind === "division"}
                      onChange={() => setCategoryKind("division")}
                    />
                    {t("Division")}
                  </label>
                </>
              )}
            </div>
          </section>

          <section
            className="gl-control-section gl-control-section-wide gl-prop-section-data"
            aria-labelledby="prop-data-heading"
          >
            <span id="prop-data-heading" className="gl-control-section-label">
              {t("Grouping")}
            </span>
            <div className="gl-control-section-body">
              <label className="gl-field-inline">
                {t("Group")}
                <select
                  value={groupSel}
                  onChange={(e) => setGroupSel(e.target.value)}
                >
                  {factorOptions}
                </select>
              </label>
              {orderControl(t("Group"), groupSel, groupLevels)}
              <label
                className="gl-field-inline"
                title={cells && !replicateOn ? t("A per-cell chart pools the cells of a group's files; choose Replicates under Plot to mark each unit") : plotType === "stacked" && !averagePerUnit ? t("A pooled stacked bar has no replicate units; tick Average per unit or draw a boxplot") : undefined}
              >
                {t("Replicate unit")}
                <select
                  value={unitSel}
                  disabled={(cells && !replicateOn) || (plotType === "stacked" && !averagePerUnit)}
                  onChange={(e) => setUnitSel(e.target.value)}
                >
                  {factorOptions}
                </select>
              </label>
              <label className="gl-field-inline">
                {t("Facet")}
                <select
                  value={facetSel}
                  onChange={(e) => setFacetSel(e.target.value)}
                >
                  <option value={NONE_OPT}>{t("(none)")}</option>
                  {factorOptions}
                </select>
              </label>
              {facetSel !== NONE_OPT && orderControl(t("Facet"), facetSel, facetLevels)}
              <TabIntro intro={intro}>
                {t("Group sets the bars of a stacked bar and the box colours of a boxplot. Facet draws a panel per value. A replicate unit is one observation in each group it has files in: a boxplot draws one point per unit, every unit drawn; its box spans the quartiles, and each whisker reaches the furthest unit within 1.5 × the interquartile range of its quartile (Tukey).")}
              </TabIntro>
              <label
                className="gl-check"
                title={plotType === "stacked"
                  ? t("Each bar the mean of its replicate units' compositions, each unit weighted equally; off, the bar pools the group's events")
                  : t("A boxplot always takes one value per replicate unit")}
              >
                <input
                  type="checkbox"
                  checked={averagePerUnit}
                  disabled={channelChart || plotType !== "stacked"}
                  onChange={(e) => setAveragePerUnit(e.target.checked)}
                />
                {t("Average per unit")}
              </label>
              <label className="gl-check">
                <input
                  type="checkbox"
                  checked={includeUngated}
                  disabled={channelChart}
                  onChange={(e) => setIncludeUngated(e.target.checked)}
                />
                {parentId === rootId ? t("Include ungated") : t("Include the rest of the parent")}
              </label>
              <TabIntro intro={intro}>Composition assigns events to their deepest selected population. Excluding ungated events renormalizes percentages to the selected populations.</TabIntro>
              <div className="gl-prop-shelves" role="group" aria-labelledby="prop-shelves-heading">
                <h3 id="prop-shelves-heading" title={t("Drag between shelves, or use the placement menus.")}>{t("Arrange dimensions")}</h3>
                <DimensionShelves
                  dragType="text/gatelab-chart-dimension"
                  shelves={[
                    {
                      id: "x",
                      label: t("Along x"),
                      chips: [
                        ...shelves.x.map(dimensionChip),
                        ...(shelves.stack ? [{ id: "stack", label: t("Stack"), name: t("Stack"), fixed: true }] : []),
                      ],
                      footer: drawnChannels.length > 1 ? <p className="gl-hint">{t("Channels are drawn in panels of their own, each on its own value axis; they do not run along x.")}</p> : undefined,
                    },
                    { id: "columns", label: t("Columns"), chips: shelves.columns.map(dimensionChip) },
                    { id: "rows", label: t("Rows"), chips: shelves.rows.map(dimensionChip) },
                    { id: "pages", label: t("Pages"), chips: shelves.pages.map(dimensionChip) },
                    {
                      id: "wrap",
                      label: t("Wrap"),
                      chips: shelves.wrap.map(dimensionChip),
                      footer: (
                        <>
                          <label className="gl-field-inline">
                            {t("Per row")}
                            <NumberField
                              aria-label="Panels per row"
                              value={panelsPerRow}
                              min={1}
                              max={12}
                              integer
                              disabled={shelves.columns.length > 0 || shelves.rows.length > 0}
                              onCommit={setPanelsPerRow}
                            />
                          </label>
                          {shelves.wrap.length > 0 && (shelves.columns.length > 0 || shelves.rows.length > 0) && (
                            <p className="gl-hint">
                              {shelves.columns.length > 0
                                ? t("With a dimension on Columns, these run down the rows.")
                                : t("With a dimension on Rows only, these run across the columns.")}
                            </p>
                          )}
                        </>
                      ),
                    },
                  ]}
                  places={[
                    { value: "x", label: t("Along x") },
                    { value: "columns", label: t("Columns") },
                    { value: "rows", label: t("Rows") },
                    { value: "pages", label: t("Pages") },
                    { value: "wrap", label: t("Wrap") },
                  ]}
                  canPlace={(dimension, shelf) => chartShelfAllowed(shelfSettings, dimension as ChartDimension, shelf as ChartShelf)}
                  onPlace={placeDimension}
                />
              </div>
            </div>
          </section>

          <section
            className="gl-control-section gl-control-section-wide gl-prop-section-appearance"
            aria-labelledby="prop-appearance-heading"
          >
            <span
              id="prop-appearance-heading"
              className="gl-control-section-label"
            >
              {t("Appearance")}
            </span>
            <div className="gl-control-section-body">
              <label className="gl-field-inline" title={coloursPopulations ? t("Population colours are set in the population tree") : undefined}>
                {t("Palette")}
                <select
                  value={palette}
                  disabled={coloursPopulations}
                  onChange={(e) => setPalette(e.target.value as PaletteName)}
                >
                  {OVERLAY_PALETTES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {coloursPopulations && <span className="gl-hint">{t("Population colours are set in the population tree")}</span>}
              <span className="gl-ctl-sep" />
              <FigureStyleFollow following={followFigureStyle} onFollow={setFollowFigureStyle} />
              {!followFigureStyle && (
                <>
                  <label className="gl-field-inline">
                    {t("Tick")}
                    <NumberField value={fontTick} min={5} max={20} integer onCommit={setFontTick} />
                  </label>
                  <label className="gl-field-inline">
                    {t("Axis")}
                    <NumberField value={fontAxis} min={5} max={24} integer onCommit={setFontAxis} />
                  </label>
                  <label className="gl-field-inline">
                    {t("Legend")}
                    <NumberField value={fontLegend} min={5} max={20} integer onCommit={setFontLegend} />
                  </label>
                </>
              )}
              <label className="gl-field-inline">
                {t("Plot height")}
                <NumberField value={chartHeight} min={140} max={800} integer onCommit={setChartHeight} />
              </label>
              <span className="gl-ctl-sep" />
              <label className="gl-field-inline" title={t("Each panel's width in pixels, its margins included; 0 fits it to its contents")}>
                {t("Panel width")}
                <NumberField
                  aria-label="Panel width"
                  value={panelWidth}
                  min={0}
                  max={800}
                  integer
                  onCommit={(value) => setPanelWidth(normalizePanelWidth(value))}
                />
              </label>
              <button
                type="button"
                className="gl-mini-btn"
                disabled={!illustrationPanelSize}
                title={illustrationPanelSize ? t("Make each panel the size of an Illustration panel, so the chart sits beside the figure's plots at the same scale") : t("Open the Illustration tab to make a figure first")}
                onClick={matchIllustration}
              >
                {t("Match Illustration panel size")}
              </button>
              <label className="gl-check">
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(event) => setShowGrid(event.target.checked)}
                />
                Grid lines
              </label>
              <label className="gl-check">
                <input
                  type="checkbox"
                  checked={showLegend}
                  onChange={(event) => setShowLegend(event.target.checked)}
                />
                Show legend
              </label>
              <label className="gl-check" title={plotType === "box" ? undefined : t("A boxplot draws one point per replicate unit; a stacked bar has none")}>
                <input
                  type="checkbox"
                  checked={showPoints}
                  disabled={cells || plotType === "stacked" || plotType === "dots"}
                  onChange={(event) => setShowPoints(event.target.checked)}
                />
                {t("Show replicate points")}
              </label>
              <label className="gl-check" title={plotType !== "box" ? t("Lines join a unit's points across a boxplot's groups") : unitSel === SAMPLE_OPT ? t("Each file is its own unit, so no unit sits in two groups; choose a Replicate unit such as donor") : t("Join each replicate unit's points across the groups, for a design with each unit in every group")}>
                <input
                  type="checkbox"
                  checked={pairedLines}
                  disabled={channelChart || plotType !== "box" || unitSel === SAMPLE_OPT}
                  onChange={(event) => setPairedLines(event.target.checked)}
                />
                {t("Join each unit across groups")}
              </label>
              <label className="gl-check" title={t("Write each mark's n under its label: a violin's or box's cells, or the replicate units a box, bar or point summary stands on")}>
                <input
                  type="checkbox"
                  checked={showN}
                  onChange={(event) => setShowN(event.target.checked)}
                />
                {t("Show n")}
              </label>
              {xAxis === "groups" && valueKind !== "proportion" && (
                <label className="gl-check" title={t("Colour each mark by its panel's population in place of its group, as an Illustration summary panel does")}>
                  <input
                    type="checkbox"
                    checked={colourByPopulation || populationsTogether}
                    disabled={populationsTogether}
                    onChange={(event) => setColourByPopulation(event.target.checked)}
                  />
                  {t("Colour by population")}
                </label>
              )}
              {xAxis === "groups" && valueKind !== "proportion" && (
                <label className="gl-check" title={t("Draw every population in one panel, side by side at each group and coloured by population, as an Illustration summary panel does")}>
                  <input
                    type="checkbox"
                    checked={populationsTogether}
                    onChange={(event) => setPopulationsTogether(event.target.checked)}
                  />
                  {t("Populations side by side in one panel")}
                </label>
              )}
              <label className="gl-field-inline">
                {t("Point size")}
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={pointRadius}
                  disabled={cells || plotType === "stacked" || (plotType !== "dots" && !showPoints)}
                  onChange={(event) => setPointRadius(+event.target.value)}
                />
              </label>
              <span className="gl-ctl-sep" />
              <span className="gl-field-inline">{t("Value axis")}</span>
              <label
                className="gl-field-inline"
                title={channelChart
                  ? t("In the channel's measured units, placed through its transform; blank is automatic")
                  : !channelChart && plotType !== "stacked" && proportionValue === "count"
                    ? t("In events; blank is automatic")
                    : t("In per cent; blank is automatic")}
              >
                {t("Min")}
                <AxisLimitField aria-label="Value axis minimum" value={valueMin} placeholder={t("auto")} onCommit={setValueMin} />
              </label>
              <label className="gl-field-inline">
                {t("Max")}
                <AxisLimitField aria-label="Value axis maximum" value={valueMax} placeholder={t("auto")} onCommit={setValueMax} />
              </label>
              <label
                className="gl-check"
                title={cells
                  ? t("A per-cell axis is the channel's range on the Gating tab or fitted to the cells")
                  : plotType === "stacked"
                    ? t("A stacked bar is a composition from 0 to 100%")
                    : plotType === "bar"
                      ? t("A bar's length is its value, so bars always start at zero")
                      : t("Start the axis at zero; off, fit it to the values with headroom")}
              >
                <input
                  type="checkbox"
                  checked={plotType === "bar" || valueFromZero}
                  disabled={cells || plotType === "stacked" || plotType === "bar"}
                  onChange={(event) => setValueFromZero(event.target.checked)}
                />
                {t("Start at zero")}
              </label>
              <label
                className="gl-check"
                title={plotType === "stacked" && !channelChart
                  ? t("A stacked bar's axis is 0 to 100% in every panel")
                  : cells && cellRange === "gating"
                    ? t("The Gating tab's range is the same in every panel; choose Fit to the cells to fit each panel")
                    : t("One value axis over every panel, so the panels compare; off, each panel fits its own")}
              >
                <input
                  type="checkbox"
                  checked={sharesValueAxis({ valueKind, plotType, xAxis, shareValueAxis }) || (cells && cellRange === "gating")}
                  disabled={(plotType === "stacked" && !channelChart) || (cells && cellRange === "gating")}
                  onChange={(event) => setShareValueAxis(event.target.checked)}
                />
                {t("Same axis in every panel")}
              </label>
            </div>
          </section>

          <section
            className="gl-control-section gl-prop-section-export"
            aria-labelledby="prop-export-heading"
          >
            <span id="prop-export-heading" className="gl-control-section-label">
              {t("Export")}
            </span>
            <div className="gl-control-section-body">
              <button
                className="gl-mini-btn"
                title={t("The chart and its legend as a PNG at 300 dpi")}
                onClick={() => exportChart("png")}
              >
                PNG
              </button>
              <button
                className="gl-mini-btn"
                title={t("The chart and its legend as an SVG: shapes and text stay editable")}
                onClick={() => exportChart("svg")}
              >
                SVG
              </button>
              <button
                className="gl-mini-btn"
                title={t("The chart and its legend as a vector PDF")}
                onClick={() => exportChart("pdf")}
              >
                PDF
              </button>
              <button
                className="gl-mini-btn"
                title={t("The table the chart is drawn from, as CSV, in measured units: counts and percentages per file, each violin's cells and quartiles, or each replicate unit's statistic")}
                disabled={!drawable}
                onClick={exportData}
              >
                {t("Data (CSV)")}
              </button>
              {pages.length > 0 && <p className="gl-hint">{t("Export writes the page shown, page {n} of {count}.", { n: currentPage + 1, count: pages.length })}</p>}
            </div>
          </section>
        </div>
      </aside>
      <div className="gl-prop-body">
        <div className="gl-prop-chart-scroll">
          {cellModel?.excluded.length ? (
            <p className="gl-plotting-warning" role="status">
              {t("{count} files excluded: selected populations are missing, ambiguous, or structurally changed. {names}", { count: String(cellModel.excluded.length), names: cellModel.excluded.join(", ") })}
            </p>
          ) : null}
          {cellModel?.partial?.length ? (
            <p className="gl-plotting-warning" role="status">
              {t("Populations not drawn in some files: missing, ambiguous, or structurally changed there. {list}", { list: partialList(cellModel.partial) })}
            </p>
          ) : null}
          {cellModel?.noChannel.length ? (
            <p className="gl-plotting-warning" role="status">
              {t("{count} files have no channel {channel} and are left out: {names}", { count: String(cellModel.noChannel.length), channel, names: cellModel.noChannel.join(", ") })}
            </p>
          ) : null}
          {model.excluded?.length ? (
            <p className="gl-plotting-warning" role="status">
              {model.excluded.length} files excluded:{" "}
              {categoryKind === "division" ? "the population the division was fitted in is" : "selected populations are"}{" "}
              missing, ambiguous, or structurally changed.{" "}
              {model.excluded.join(", ")}
            </p>
          ) : null}
          {model.partial?.length ? (
            <p className="gl-plotting-warning" role="status">
              {t("Populations not drawn in some files: missing, ambiguous, or structurally changed there. {list}", { list: partialList(model.partial) })}
            </p>
          ) : null}
          {plotType === "stacked" && model.overlapping?.length ? (
            <p className="gl-plotting-warning" role="status">
              {t("{names} share events with another selected population that is not nested in them. A stacked bar draws each event once, in the first population in tree order, so these are drawn smaller than they are; the boxplot shows each population whole.", { names: model.overlapping.join(", ") })}
            </p>
          ) : null}
          {categoryKind === "division" &&
            divisionSamples.length < samples.length && (
              <div className="gl-hint gl-panel-hint" role="status">
                {samples.length - divisionSamples.length} sample
                {samples.length - divisionSamples.length === 1 ? "" : "s"}{" "}
                without a compatible division profile{" "}
                {samples.length - divisionSamples.length === 1 ? "is" : "are"}{" "}
                excluded.
              </div>
            )}
          {samples.length === 0 || nCat === 0 || !drawable || (cells && !xAxisFrame) ? (
            <div className="gl-tab-empty">
              {files.length === 0
                ? t("Open files or a workspace to plot.")
                : samples.length === 0
                  ? t("No file is ticked. Tick the files to draw under Data.")
                  : channelChart && !channel
                    ? t("Choose a channel to draw under Plot.")
                    : nCat === 0
                      ? t("No population is ticked. Tick the populations to draw in the Populations pane under Data.")
                      : cellModel && (cellModel.excluded.length || cellModel.noChannel.length)
                        ? t("None of the ticked files can be drawn; the note above says why.")
                        : cellModel
                          ? t("The ticked populations hold no cells in the ticked files.")
                          : t("None of the ticked files can be drawn; the note above says why.")}
            </div>
          ) : stat && cellModel ? (
            <StatisticChart
              model={cellModel}
              statistic={statistic}
              plotType={plotType === "bar" ? "bar" : plotType === "dots" ? "dots" : "box"}
              errorBar={errorBar}
              test={rankTest}
              comparisons={{ comparisons, comparisonsShow }}
              showN={showN}
              xAxis={xAxis}
              unitSel={unitSel}
              catColors={catColors}
              palette={palette}
              colourByPopulation={colourByPopulation}
              populationsTogether={populationsTogether}
              groupLevels={groupLevels}
              facetLevels={facetLevels}
              unitLevels={unitLevels}
              groupTitle={proportionsFactorTitle(groupSel)}
              facetTitle={proportionsFactorTitle(facetSel)}
              fonts={{ tick: fontTick, axis: fontAxis, legend: fontLegend }}
              appearance={{ height: chartHeight, showGrid, showLegend, showPoints, pointRadius }}
              arrangement={arrangement}
              page={page}
              axisSettings={axisSettings}
              channels={channelParts}
            />
          ) : cellModel && xAxisFrame ? (
            <CellValuesChart
              model={cellModel}
              plotType={cellPlotType(plotType)}
              xAxis={xAxis}
              violinBox={violinBox}
              showN={showN}
              axis={xAxisFrame}
              replicates={replicates}
              catColors={catColors}
              palette={palette}
              colourByPopulation={colourByPopulation}
              populationsTogether={populationsTogether}
              groupLevels={groupLevels}
              facetLevels={facetLevels}
              groupTitle={proportionsFactorTitle(groupSel)}
              facetTitle={proportionsFactorTitle(facetSel)}
              fonts={{ tick: fontTick, axis: fontAxis, legend: fontLegend }}
              appearance={{ height: chartHeight, showGrid, showLegend }}
              arrangement={arrangement}
              page={page}
              axisOptions={{ ...axisOptions, shared: axisOptions.shared || cellRange === "gating" }}
              channels={channelParts}
            />
          ) : (
            <ProportionsChart
              plotType={plotType === "bar" ? "bar" : plotType === "dots" ? "dots" : plotType === "stacked" ? "stacked" : "box"}
              proportionValue={proportionValue}
              errorBar={errorBar}
              test={rankTest}
              comparisons={{ comparisons, comparisonsShow }}
              showN={showN}
              unitSel={unitSel}
              model={model}
              catColors={catColors}
              palette={palette}
              groupLevels={groupLevels}
              facetLevels={facetLevels}
              averagePerUnit={averagePerUnit}
              populations={state.populations}
              valueTitle={proportionsValueTitle(categoryKind, categoryKind === "division" ? divisionWithinName(model.divisionWithin) : parentId === rootId ? null : (state.populations[parentId]?.name ?? null), includeUngated, plotType === "stacked" ? "parent" : proportionValue)}
              groupTitle={proportionsFactorTitle(groupSel)}
              facetTitle={proportionsFactorTitle(facetSel)}
              fonts={{ tick: fontTick, axis: fontAxis, legend: fontLegend }}
              appearance={{
                height: chartHeight,
                showGrid,
                showPoints,
                paired: pairedLines,
                showLegend,
                pointRadius,
              }}
              arrangement={arrangement}
              page={page}
              axisOptions={axisOptions}
            />
          )}
          {pages.length > 0 && drawable && nCat > 0 && (
            <div className="gl-prop-pager" role="group" aria-label={t("Pages")}>
              <button className="gl-mini-btn" type="button" disabled={currentPage === 0} aria-label={t("Previous page")} onClick={() => setPageIndex(currentPage - 1)}>
                {t("Previous")}
              </button>
              <span>
                {t("Page {n} of {count}", { n: currentPage + 1, count: pages.length })}
                {pageText ? ` · ${pageText}` : ""}
              </span>
              <button className="gl-mini-btn" type="button" disabled={currentPage >= pages.length - 1} aria-label={t("Next page")} onClick={() => setPageIndex(currentPage + 1)}>
                {t("Next")}
              </button>
            </div>
          )}
        </div>
        {drawable && nCat > 0 && <PlottingDataTableView build={chartDataTable} onDownloadCsv={exportData} />}
      </div>
    </div>
  );
}

// Serialize the complete chart for download: SVG direct, PDF as vector art, PNG at 300 dpi via canvas.
async function downloadChart(containerId: string, name: string, kind: "svg" | "png" | "pdf") {
  const composed = composeProportionsChartSvg(containerId);
  if (!composed) return;
  const { root, width, height } = composed;
  finishExportSvg(root, { widthPx: width, heightPx: height });
  if (kind === "pdf") {
    // CSS pixels are 1/96 inch; PDF points are 1/72 inch.
    const w = width * 72 / 96, h = height * 72 / 96;
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "pt", format: [w, h], compress: true });
    if (await pdfVectorPage(pdf, root, { width: w, height: h })) pdf.save(`${name}.pdf`);
    return;
  }
  const xml = new XMLSerializer().serializeToString(root);
  const blob = new Blob([`<?xml version="1.0"?>\n${xml}`], {
    type: "image/svg+xml",
  });
  if (kind === "svg") {
    triggerDownload(URL.createObjectURL(blob), `${name}.svg`);
    return;
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 300 / 96;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    void pngBlob(canvas, 300).then((b) => triggerDownload(URL.createObjectURL(b), `${name}.png`), () => undefined);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}
function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
