// ProportionsTab.tsx — population/category composition across samples, ported from GateLabR's
// Proportions tab (app.R:1130-1155, 4287-4441). Unlike GateLabR (which only read SCE colData and
// so could not use gated populations), GateLab lets a POPULATION partition be the Category: each
// event is labelled by the deepest selected population (events in none → "ungated"). Group / Unit /
// Facet come from per-sample metadata (or the sample name). Rendered as a custom SVG stacked bar
// (composition per Group) or boxplot (per-unit fraction per Category, dodged by Group).

import { useEffect, useMemo, useRef, useState } from "react";
import { finishExportSvg, pdfVectorPage, pngBlob } from "../plots/exportSvg";
import { usePersistedTabState } from "./tabState";
import type { CoreState, Derived } from "../store";
import type { Sample } from "../engine/sample";
import { populationTreeOrder } from "../engine/populations";
import { TreeConnectors } from "./TreeConnectors";
import type { DivisionProfileLike } from "../engine/factors";
import {
  computeStackedBars,
  computeBoxes,
  perUnitProps,
  nestedBarLayout,
  type SampleComposition,
} from "../engine/proportions";
import type { PopulationMap } from "../engine/models";
import { OVERLAY_PALETTES, paletteColors, type PaletteName } from "../engine/palettes";
import type { MetadataColumn } from "../engine/metadata";
import { SAMPLE_ID_FIELD } from "../engine/metadata";
import { useI18n } from "./i18n";
import { TabIntro, TabIntroToggle, useTabIntro } from "./TabIntro";
import { NumberField } from "./NumberField";
import { figureHierarchies } from "../engine/figure";
import {
  buildProportionsModel,
  defaultProportionsSettings,
  proportionsCategoryColors,
  type ProportionsSettings,
} from "../engine/proportionsModel";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";

// Sample names and group levels are ordered as people read them: "2" before "10", "exp2" before
// "exp10". A plain sort put a 224-sample SCE's samples as 1, 10, 100, 101, …, 11, 110, ….
const LABEL_COLLATOR = new Intl.Collator(undefined, { numeric: true });
const compareLabels = (a: string, b: string): number => LABEL_COLLATOR.compare(a, b);

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
  /** Put the chart as it is now on the Layout tab, as one block that keeps these settings. */
  onAddToLayout?: (settings: ProportionsSettings) => void;
}

const SAMPLE_OPT = PROPORTIONS_SAMPLE_FACTOR;
const NONE_OPT = PROPORTIONS_NO_FACTOR;

export function ProportionsTab({
  samples: files,
  state: activeState,
  metadata,
  metadataColumns,
  divisionProfiles,
  dataRevisionKey,
  onConfigChange,
  onAddToLayout,
}: Props) {
  const { t } = useI18n();
  const intro = useTabIntro("plotting");
  const [section, setSection] = useState("data");
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
  const rootId = state.root_population_id ?? "";
  const divisionSamples = useMemo(
    () => samples.filter((entry) => divisionProfiles[entry.id]),
    [samples, divisionProfiles, dataRevisionKey],
  );
  const hasDivision = divisionSamples.length > 0;

  const [categoryKind, setCategoryKind] = usePersistedTabState<
    "population" | "division"
  >("prop.categoryKind", defaults.categoryKind);
  const [plotType, setPlotType] = usePersistedTabState<"stacked" | "box">("prop.plotType", defaults.plotType);
  // A composition is the children of ONE parent, stacked to 100% with the rest of that parent:
  // never a mix of levels, which double-counted nested populations and could not tell the same
  // quadrant under two parents apart.
  const [parentSel, setParentSel] = usePersistedTabState<string>("prop.parent", defaults.parent);
  const parentId = state.populations[parentSel] ? parentSel : rootId;
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
  const [fontTick, setFontTick] = usePersistedTabState("prop.fontTick", defaults.fontTick);
  const [fontAxis, setFontAxis] = usePersistedTabState("prop.fontAxis", defaults.fontAxis);
  const [fontLegend, setFontLegend] = usePersistedTabState("prop.fontLegend", defaults.fontLegend);
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
    chartHeight,
    showGrid,
    showPoints,
    pairedLines,
    showLegend,
    pointRadius,
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
    () => buildProportionsModel(modelSettings, files, activeState, metadata, divisionProfiles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelSettings, files, divisionProfiles, activeState.gate_version, activeState.stored_hierarchies, metadata, dataRevisionKey],
  );

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

  const nCat = model.catLevels.length;
  const catColors = proportionsCategoryColors(model, { palette, includeUngated }, state.populations);
  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  const exportChart = (kind: "svg" | "png" | "pdf") =>
    void downloadChart("gl-prop-svg", "proportions", kind);
  const addToLayout = () =>
    onAddToLayout?.({
      ...modelSettings,
      plotType,
      palette,
      averagePerUnit,
      fontTick,
      fontAxis,
      fontLegend,
      height: chartHeight,
      grid: showGrid,
      points: showPoints,
      paired: pairedLines,
      legend: showLegend,
      pointRadius,
    });

  return (
    <div
      className={`gl-tab-panel gl-tab-fill gl-plotting-workspace section-${section}${section === "data" && categoryKind === "population" ? " pane-populations" : ""}`}
    >
      <div className="gl-plotting-head">
        <strong>Plotting</strong>
        <span>Population composition and replicate-level distributions</span>
        <TabIntroToggle intro={intro} />
        {onAddToLayout && (
          <div className="gl-plotting-head-actions">
            <button
              type="button"
              className="gl-mini-btn"
              disabled={samples.length === 0 || nCat === 0}
              title={t("One block on the Layout tab, drawn there as it is here; its files and populations stay its own")}
              onClick={addToLayout}
            >
              {t("Add to Layout")}
            </button>
          </div>
        )}
      </div>
      <aside className="gl-plotting-inspector" aria-label="Plotting controls">
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
          <h3>{t("Files / samples")}</h3>
          <div className="gl-plotting-actions">
            <button
              className="gl-mini-btn"
              onClick={() => setSelectedFiles(files.map((file) => file.id))}
            >
              All
            </button>
            <button
              className="gl-mini-btn"
              onClick={() => setSelectedFiles([])}
            >
              None
            </button>
            <span>{samples.length} selected</span>
          </div>
          <div className="gl-plotting-filelist">
            {files.map((file) => (
              <label className="gl-check" key={file.id}>
                <input
                  type="checkbox"
                  checked={selectedFiles.includes(file.id)}
                  onChange={() =>
                    setSelectedFiles((ids) => toggle(ids, file.id))
                  }
                />
                {file.name}
              </label>
            ))}
          </div>
        </section>
        <div className="gl-control-sections" aria-label="Plotting settings">
          <section
            className="gl-control-section gl-prop-section-plot"
            aria-labelledby="prop-plot-heading"
          >
            <span id="prop-plot-heading" className="gl-control-section-label">
              {t("Plot")}
            </span>
            <div className="gl-control-section-body">
              {(["stacked", "box"] as const).map((type) => (
                <label key={type} className="gl-check">
                  <input
                    type="radio"
                    name="prop-type"
                    checked={plotType === type}
                    onChange={() => setPlotType(type)}
                  />
                  {type === "stacked" ? t("Stacked bar") : t("Boxplot")}
                </label>
              ))}
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
              <label
                className="gl-check"
                title={
                  hasDivision
                    ? ""
                    : "Apply a division profile in the Division tab first"
                }
              >
                <input
                  type="radio"
                  name="prop-cat"
                  disabled={!hasDivision}
                  checked={categoryKind === "division"}
                  onChange={() => setCategoryKind("division")}
                />
                {t("Division")}
              </label>
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
              <label
                className="gl-field-inline"
                title={plotType === "stacked" && !averagePerUnit ? t("A pooled stacked bar has no replicate units; tick Average per unit or draw a boxplot") : undefined}
              >
                {t("Replicate unit")}
                <select
                  value={unitSel}
                  disabled={plotType === "stacked" && !averagePerUnit}
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
                  disabled={plotType !== "stacked"}
                  onChange={(e) => setAveragePerUnit(e.target.checked)}
                />
                {t("Average per unit")}
              </label>
              <label className="gl-check">
                <input
                  type="checkbox"
                  checked={includeUngated}
                  onChange={(e) => setIncludeUngated(e.target.checked)}
                />
                {parentId === rootId ? t("Include ungated") : t("Include the rest of the parent")}
              </label>
              <TabIntro intro={intro}>Composition assigns events to their deepest selected population. Excluding ungated events renormalizes percentages to the selected populations.</TabIntro>
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
              <label className="gl-field-inline">
                {t("Palette")}
                <select
                  value={palette}
                  onChange={(e) => setPalette(e.target.value as PaletteName)}
                >
                  {OVERLAY_PALETTES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="gl-ctl-sep" />
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
              <label className="gl-field-inline">
                {t("Plot height")}
                <NumberField value={chartHeight} min={140} max={800} integer onCommit={setChartHeight} />
              </label>
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
                  disabled={plotType !== "box"}
                  onChange={(event) => setShowPoints(event.target.checked)}
                />
                {t("Show replicate points")}
              </label>
              <label className="gl-check" title={plotType !== "box" ? t("Lines join a unit's points across a boxplot's groups") : unitSel === SAMPLE_OPT ? t("Each file is its own unit, so no unit sits in two groups; choose a Replicate unit such as donor") : t("Join each replicate unit's points across the groups, for a design with each unit in every group")}>
                <input
                  type="checkbox"
                  checked={pairedLines}
                  disabled={plotType !== "box" || unitSel === SAMPLE_OPT}
                  onChange={(event) => setPairedLines(event.target.checked)}
                />
                {t("Join each unit across groups")}
              </label>
              <label className="gl-field-inline">
                {t("Point size")}
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={pointRadius}
                  disabled={plotType !== "box" || !showPoints}
                  onChange={(event) => setPointRadius(+event.target.value)}
                />
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
            </div>
          </section>
        </div>
      </aside>
      <div className="gl-prop-body">
        <div className="gl-prop-chart-scroll">
          {model.excluded?.length ? (
            <p className="gl-plotting-warning" role="status">
              {model.excluded.length} files excluded:{" "}
              {categoryKind === "division" ? "the population the division was fitted in is" : "selected populations are"}{" "}
              missing, ambiguous, or structurally changed.{" "}
              {model.excluded.join(", ")}
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
          {samples.length === 0 || nCat === 0 || model.perSample.length === 0 ? (
            <div className="gl-tab-empty">
              {files.length === 0
                ? t("Open files or a workspace to plot.")
                : samples.length === 0
                  ? t("No file is ticked. Tick the files to draw under Data.")
                  : nCat === 0
                    ? t("No population is ticked. Tick the populations to draw in the Populations pane under Data.")
                    : t("None of the ticked files can be drawn; the note above says why.")}
            </div>
          ) : (
            <ProportionsChart
              plotType={plotType}
              model={model}
              catColors={catColors}
              palette={palette}
              averagePerUnit={averagePerUnit}
              populations={state.populations}
              valueTitle={proportionsValueTitle(categoryKind, categoryKind === "division" ? divisionWithinName(model.divisionWithin) : parentId === rootId ? null : (state.populations[parentId]?.name ?? null), includeUngated)}
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
            />
          )}
        </div>
      </div>
      {categoryKind === "population" && (
        <aside className="gl-plotting-inspector gl-plotting-inspector-right" aria-label="Populations">
          <section className="gl-plotting-populations">
            <h3>Populations <span>{selectedPops.length} selected</span></h3>
            <p className="gl-hint gl-plotting-parent-hint">
              Click a name to compose within that population; tick the ones beneath it to show.
            </p>
            <div className="gl-plotting-actions">
              <button className="gl-mini-btn" onClick={() => setSelectedPops([...childIds])} title="The parent's direct children: a plain partition">
                Children
              </button>
              <button className="gl-mini-btn" onClick={() => setSelectedPops(armRows.map((r) => r.popId))} title="Every population beneath the parent; deeper ones nest inside their parents">
                All
              </button>
              <button className="gl-mini-btn" onClick={() => setSelectedPops([])}>
                None
              </button>
            </div>
            <div className="gl-plotting-tree gl-plotting-tree-picker" role="tree" aria-label="Composition parent and populations">
              {treeRows.map(({ popId, depth, isLastPath }) => {
                const name = state.populations[popId]?.name ?? popId;
                const isParent = popId === parentId;
                const inArm = armIds.has(popId);
                return (
                  <div
                    key={popId}
                    data-pop-id={popId}
                    className={"gl-plotting-tree-row" + (isParent ? " is-parent" : inArm ? " in-arm" : " off-arm")}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Show ${name}`}
                      disabled={!inArm}
                      checked={inArm && selectedPops.includes(popId)}
                      onChange={() => setSelectedPops(() => toggle(selectedPops, popId))}
                    />
                    <button
                      type="button"
                      className="gl-plotting-tree-name"
                      aria-pressed={isParent}
                      title={isParent ? `Composing within ${name}` : `Compose within ${name}`}
                      onClick={() => {
                        setParentSel(popId);
                        setSelectedPops(state.populations[popId]?.children.filter((id) => state.populations[id]) ?? []);
                      }}
                    >
                      <span className="gl-stats-tree-cell">
                        <TreeConnectors depth={depth} isLastPath={isLastPath} fill />
                        <span className="gl-stats-tree-label">{name}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            {armRows.length === 0 && <p className="gl-hint">This population has nothing beneath it to compose.</p>}
          </section>
        </aside>
      )}
    </div>
  );
}

// ── SVG chart ────────────────────────────────────────────────────────────────
interface ChartProps {
  plotType: "stacked" | "box";
  model: {
    catLevels: string[];
    perSample: SampleComposition[];
    hasFacet: boolean;
    levels?: { popId: string; depth: number }[];
  };
  catColors: string[];
  palette: PaletteName;
  averagePerUnit: boolean;
  populations: PopulationMap;
  fonts: { tick: number; axis: number; legend: number };
  appearance?: {
    height: number;
    showGrid: boolean;
    showPoints: boolean;
    /** Join each replicate unit's points across the groups of a boxplot. */
    paired?: boolean;
    showLegend: boolean;
    pointRadius: number;
  };
  /** The card's element id, which the export composer finds it by; each chart on a page needs its own. */
  containerId?: string;
  /** The value axis's title, naming what a percentage is of. */
  valueTitle?: string;
  /** What the groups are, for the stacked bar's category axis and the boxplot's legend. */
  groupTitle?: string;
  /** What the facets are, before each panel's value. */
  facetTitle?: string;
}

/** What the chart's percentages are of, for its value axis; for division, `parentName` is the population fitted in. */
export function proportionsValueTitle(
  categoryKind: "population" | "division",
  parentName: string | null,
  includeRest: boolean,
): string {
  if (categoryKind === "division") return parentName ? `% of ${parentName}` : "% of all events";
  if (!includeRest) return parentName ? `% of the populations shown in ${parentName}` : "% of the populations shown";
  return parentName ? `% of ${parentName}` : "% of all events";
}

/** The population a division chart counts within, for its value axis: one name, null for all events, or a phrase when files differ. */
export function divisionWithinName(within: (string | null)[] | undefined): string | null {
  if (!within || within.length === 0) return null;
  return within.length === 1 ? within[0] : "the population each file's division was fitted in";
}

/** A Group, Replicate unit or Facet picker's value as a title: the file, the sample id or the metadata column. */
export function proportionsFactorTitle(value: string): string | undefined {
  if (value === PROPORTIONS_NO_FACTOR) return undefined;
  if (value === PROPORTIONS_SAMPLE_FACTOR) return "File";
  if (value === SAMPLE_ID_FIELD) return "Sample ID";
  return value;
}

export interface ProportionPanelLayout {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  rotateLabels: boolean;
}

/** Size each panel from its actual x-axis content instead of squeezing every plot into 380px. */
export function proportionPanelLayout(
  plotType: "stacked" | "box",
  labels: string[],
  groupCount: number,
  tickFont: number,
): ProportionPanelLayout {
  const margin = { top: 22, right: 20, bottom: 46, left: 60 };
  // A boxplot panel is one population with a box per group; a stacked bar, a bar per group.
  void groupCount;
  const slotWidth = plotType === "box" ? 34 : 72;
  const innerWidth = Math.max(plotType === "box" ? 90 : 280, labels.length * slotWidth);
  const step = labels.length ? innerWidth / labels.length : innerWidth;
  const longestLabelPx = Math.max(
    0,
    ...labels.map((label) => label.length * tickFont * 0.58),
  );
  const rotateLabels = longestLabelPx > step * 0.88 && longestLabelPx > 70;
  if (rotateLabels) {
    // At 35°, the vertical component is ~57% of the rendered label width. Cap it because
    // labels are middle-ellipsized below, while their full value remains available in a tooltip.
    margin.bottom = Math.min(
      142,
      Math.max(68, 30 + Math.min(longestLabelPx, 210) * 0.57),
    );
  }
  return {
    width: margin.left + innerWidth + margin.right,
    height: margin.top + 240 + margin.bottom,
    margin,
    rotateLabels,
  };
}

const FULL_AXIS = { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };

/** A value axis from 0 to a round number just above `highest` (a fraction), with three to five ticks. */
export function fittedValueAxis(highest: number): { max: number; ticks: number[] } {
  if (!(highest > 0)) return FULL_AXIS;
  const target = Math.min(1, highest * 1.05);
  const raw = target / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((candidate) => candidate >= raw)!;
  const max = Math.min(1, Math.ceil(target / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let i = 0; i * step <= max + step * 1e-6; i++) ticks.push(Number((i * step).toPrecision(12)));
  return { max, ticks };
}

/** A tick as a percentage with the decimals the axis's ticks need (2.5%, 0.25%), and no more. */
function formatPercentTick(value: number, ticks: readonly number[]): string {
  const decimals = [0, 1, 2, 3].find((d) => ticks.every((tick) => Math.abs(Number((tick * 100).toFixed(d)) - tick * 100) < 1e-9)) ?? 3;
  return `${(value * 100).toFixed(decimals)}%`;
}

export function compactChartLabel(label: string, maxLength = 30): string {
  if (label.length <= maxLength) return label;
  const tail = Math.max(8, Math.floor(maxLength * 0.35));
  return `${label.slice(0, maxLength - tail - 1)}…${label.slice(-tail)}`;
}

export function ProportionsChart({
  plotType,
  model,
  catColors,
  averagePerUnit,
  palette,
  populations,
  fonts,
  appearance,
  containerId = "gl-prop-svg",
  valueTitle,
  groupTitle,
  facetTitle,
}: ChartProps) {
  const { catLevels, perSample, hasFacet, levels } = model;
  const { t } = useI18n();
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);
  const [pinnedLegend, setPinnedLegend] = useState<number | null>(null);
  const highlightedLegend = hoveredLegend ?? pinnedLegend;
  const nCat = catLevels.length;
  const facets = hasFacet
    ? [...new Set(perSample.map((s) => s.facet ?? ""))].sort(compareLabels)
    : [null];

  // Legend entities: categories for stacked, groups for box.
  const groups = [...new Set(perSample.map((s) => s.group))].sort(compareLabels);
  const groupColors = paletteColors(palette, Math.max(1, groups.length));
  // `index` is the category or group a legend entry stands for, which the marks' highlight reads.
  // A stacked bar's legend reads as its stack does, top to bottom: the stack draws the first
  // category at the bottom and nests each population's daughters above its own events, so the
  // stack from the top is the categories in reverse tree order, the rest of the parent first.
  const legend =
    plotType === "stacked"
      ? catLevels.map((l, i) => ({ index: i, label: l, color: catColors[i] })).reverse()
      : groups.map((g, i) => ({ index: i, label: g, color: groupColors[i] }));
  const pinnedEntry = pinnedLegend === null ? undefined : legend.find((entry) => entry.index === pinnedLegend);

  // Keep large category sets compact: at most ten rows, up to four columns. The chart card
  // expands horizontally rather than becoming a mostly-empty page-height legend column.
  const legendColumns = Math.min(4, Math.max(1, Math.ceil(legend.length / 10)));
  const markOpacity = (legendIndex: number) =>
    highlightedLegend === null || highlightedLegend === legendIndex ? 1 : 0.16;
  // A highlight dims every other mark, and a pinned one stays until it is cleared, which read as
  // the chart stuck faint: the pin says so under the legend, a click on the chart or Escape
  // clears it, and a highlight is dropped when the legend it was made on changes.
  const clearHighlight = () => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  };
  useEffect(() => {
    setHoveredLegend(null);
    setPinnedLegend(null);
  }, [plotType, legend.length]);

  // A boxplot draws one panel per category, each with a value axis of its own, fitted to the
  // category's highest unit across every facet, so a population at 0.5% fills its panel.
  const boxAxes = useMemo(() => {
    if (plotType !== "box") return [];
    const units = perUnitProps(perSample, nCat);
    return catLevels.map((_, ci) => fittedValueAxis(Math.max(0, ...computeBoxes(units, nCat, false).filter((box) => box.cat === ci).flatMap((box) => box.values))));
  }, [plotType, perSample, nCat, catLevels]);

  // Boxplot panels wrap five to a row (12 px apart, as .gl-prop-panels spaces them).
  const BOX_PANELS_PER_ROW = 5;
  const boxPanelCount = plotType === "box" ? facets.length * nCat : 0;
  const boxRowWidth = boxPanelCount > BOX_PANELS_PER_ROW
    ? BOX_PANELS_PER_ROW * proportionPanelLayout("box", groups, groups.length, fonts.tick).width + (BOX_PANELS_PER_ROW - 1) * 12
    : undefined;

  const renderPanel = (facet: string | null, key: string, boxCat?: number) => {
    const sub = hasFacet
      ? perSample.filter((s) => (s.facet ?? "") === facet)
      : perSample;
    const stackedBars =
      plotType === "stacked"
        ? computeStackedBars(sub, nCat, {
            averagePerUnit,
            hasUnit: true,
            hasFacet: false,
          }).sort((a, b) => compareLabels(a.group, b.group))
        : null;
    const xLabels = stackedBars
      ? stackedBars.map((bar) => bar.group)
      : groups;
    const layout = proportionPanelLayout(
      plotType,
      xLabels,
      groups.length,
      fonts.tick,
    );
    const M = layout.margin;
    const iw = layout.width - M.left - M.right,
      ih = appearance?.height ?? 240;
    const plotBottom = M.top + ih;
    // The stacked bar's category axis is the groups, titled under its labels: below the
    // margin rotated labels take, else just under the labels' one line.
    const xTitleY = stackedBars && groupTitle
      ? layout.rotateLabels
        ? plotBottom + M.bottom + fonts.axis
        : plotBottom + 18 + fonts.tick + fonts.axis
      : null;
    const PW = layout.width,
      PH = Math.max(plotBottom + M.bottom, xTitleY === null ? 0 : xTitleY + 6);
    const axis = boxCat === undefined ? FULL_AXIS : boxAxes[boxCat] ?? FULL_AXIS;
    const y = (v: number) => M.top + ih * (1 - v / axis.max); // v in [0,1]
    let body: JSX.Element[] = [];
    let xTicks: { x: number; label: string }[] = [];

    if (stackedBars) {
      const bars = stackedBars;
      // What each bar stands on: its replicate units when averaged, else its events.
      const units = averagePerUnit ? perUnitProps(sub, nCat) : [];
      const basis = (group: string, total: number) => {
        if (!averagePerUnit) return `${Math.round(total).toLocaleString("en-US")} events`;
        const n = units.filter((unit) => unit.group === group).length;
        return n === 1 ? "1 replicate unit" : `mean of ${n} replicate units`;
      };
      const bw = bars.length ? Math.min(64, (iw / bars.length) * 0.7) : 0;
      const step = bars.length ? iw / bars.length : 0;
      bars.forEach((bar, bi) => {
        const cx = M.left + step * (bi + 0.5);
        xTicks.push({ x: cx, label: bar.group });
        if (levels && levels.length) {
          // NESTED: each population's subtree, its selected children stacked inside it (inset by
          // depth so daughters read as within their parent). `nestedBarLayout` ignores any trailing
          // "ungated" segment; draw that as a flat cap on top.
          const nodes = nestedBarLayout(levels, bar.segments, populations);
          const INSET = 5;
          nodes.forEach((node) => {
            if (node.y1 - node.y0 <= 1e-9) return;
            const inset = Math.min(node.depth * INSET, bw * 0.45);
            const x = cx - bw / 2 + inset;
            const yTop = y(node.y1),
              yBot = y(node.y0);
            body.push(
              <rect
                className="gl-prop-mark"
                key={`${bi}-${node.popId}`}
                x={x}
                y={yTop}
                width={Math.max(1, bw - inset)}
                height={Math.max(0, yBot - yTop)}
                fill={catColors[node.cat]}
                stroke="#fff"
                strokeWidth={0.4}
                opacity={markOpacity(node.cat)}
              >
                <title>{`${catLevels[node.cat]}: ${((node.y1 - node.y0) * 100).toFixed(1)}% (${basis(bar.group, bar.total)})`}</title>
              </rect>,
            );
          });
          const nestedTotal = bar.segments
            .slice(0, levels.length)
            .reduce((a, s) => a + s.value, 0);
          const ungated = bar.segments[levels.length]?.value ?? 0; // present only when "include ungated"
          if (ungated > 1e-9) {
            const yTop = y(nestedTotal + ungated),
              yBot = y(nestedTotal);
            body.push(
              <rect
                className="gl-prop-mark"
                key={`${bi}-ungated`}
                x={cx - bw / 2}
                y={yTop}
                width={bw}
                height={Math.max(0, yBot - yTop)}
                fill={catColors[levels.length]}
                stroke="#fff"
                strokeWidth={0.4}
                opacity={markOpacity(levels.length)}
              >
                <title>{`${catLevels[levels.length]}: ${(ungated * 100).toFixed(1)}%`}</title>
              </rect>,
            );
          }
          return;
        }
        let acc = 0;
        bar.segments.forEach((seg) => {
          if (seg.value <= 0) return;
          const y0 = y(acc),
            y1 = y(acc + seg.value);
          body.push(
            <rect
              className="gl-prop-mark"
              key={`${bi}-${seg.cat}`}
              x={cx - bw / 2}
              y={y1}
              width={bw}
              height={Math.max(0, y0 - y1)}
              fill={catColors[seg.cat]}
              stroke="#444"
              strokeWidth={0.2}
              opacity={markOpacity(seg.cat)}
            >
              <title>{`${catLevels[seg.cat]}: ${(seg.value * 100).toFixed(1)}% (${basis(bar.group, bar.total)})`}</title>
            </rect>,
          );
          acc += seg.value;
        });
      });
    } else {
      const ci = boxCat ?? 0;
      const boxes = computeBoxes(perUnitProps(sub, nCat), nCat, false).filter((box) => box.cat === ci);
      const step = groups.length ? iw / groups.length : iw;
      const bw = Math.min(18, step * 0.6);
      const showPoints = appearance?.showPoints !== false;
      // A point's place in its box, spread over up to five columns so close values stay visible.
      const pointX = (cx: number, count: number, vi: number) =>
        showPoints ? cx + ((vi % Math.min(5, count)) - (Math.min(5, count) - 1) / 2) * 2.1 : cx;
      // Where each unit is drawn in each group, in group order, for the paired lines.
      const unitPath = new Map<string, { x: number; y: number }[]>();
      groups.forEach((group, gi) => {
        const cx = M.left + step * (gi + 0.5);
        xTicks.push({ x: cx, label: group });
        const box = boxes.find((candidate) => candidate.group === group);
        if (!box) return;
        const col = groupColors[gi] ?? "#888";
        const { q1, med, q3, lo, hi } = box.stats;
        box.units.forEach((unit, vi) => {
          const at = { x: pointX(cx, box.values.length, vi), y: y(box.values[vi]) };
          unitPath.set(unit, [...(unitPath.get(unit) ?? []), at]);
        });
        body.push(
          <g
            key={`b-${ci}-${box.group}`}
            className="gl-prop-mark-group"
            opacity={markOpacity(gi)}
          >
            <line
              x1={cx}
              x2={cx}
              y1={y(hi)}
              y2={y(lo)}
              stroke="#555"
              strokeWidth={0.8}
            />
            <rect
              className="gl-prop-mark"
              x={cx - bw / 2}
              y={y(q3)}
              width={bw}
              height={Math.max(0.5, y(q1) - y(q3))}
              fill={col}
              fillOpacity={0.85}
              stroke="#333"
              strokeWidth={0.5}
            >
              <title>{`${catLevels[ci]} · ${box.group}: median ${(med * 100).toFixed(1)}%, n = ${box.values.length}`}</title>
            </rect>
            <line
              x1={cx - bw / 2}
              x2={cx + bw / 2}
              y1={y(med)}
              y2={y(med)}
              stroke="#111"
              strokeWidth={1}
            />
            {showPoints &&
              box.values.map((v, vi) => (
                <circle
                  key={vi}
                  cx={pointX(cx, box.values.length, vi)}
                  cy={y(v)}
                  r={appearance?.pointRadius ?? 1.5}
                  fill="#222"
                  fillOpacity={0.65}
                />
              ))}
          </g>,
        );
      });
      if (appearance?.paired) {
        body.push(
          <g key={`paired-${ci}`} className="gl-prop-paired" fill="none" stroke="#666" strokeWidth={0.6} strokeOpacity={0.7}>
            {[...unitPath].filter(([, path]) => path.length > 1).map(([unit, path]) => (
              <polyline key={unit} points={path.map((p) => `${p.x},${p.y}`).join(" ")}>
                <title>{unit}</title>
              </polyline>
            ))}
          </g>,
        );
      }
    }

    return (
      <svg
        key={key}
        width={PW}
        height={PH}
        viewBox={`0 0 ${PW} ${PH}`}
        className="gl-prop-panel"
      >
        {(hasFacet || boxCat !== undefined) && (
          <text
            x={PW / 2}
            y={14}
            textAnchor="middle"
            fontSize={fonts.axis}
            fontWeight={600}
            fill="#334155"
          >
            {[
              boxCat !== undefined ? catLevels[boxCat] : null,
              hasFacet ? (facetTitle ? `${facetTitle}: ${facet || "(NA)"}` : facet || "(NA)") : null,
            ].filter(Boolean).join(" · ")}
          </text>
        )}
        {/* y grid + axis (percent) */}
        {axis.ticks.map((t) => (
          <g key={t}>
            {appearance?.showGrid !== false && (
              <line
                x1={M.left}
                x2={M.left + iw}
                y1={y(t)}
                y2={y(t)}
                stroke="#eee"
              />
            )}
            <text
              x={M.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={fonts.tick}
              fill="#666"
            >
              {formatPercentTick(t, axis.ticks)}
            </text>
          </g>
        ))}
        <line
          x1={M.left}
          x2={M.left}
          y1={M.top}
          y2={plotBottom}
          stroke="#94a3b8"
        />
        <line
          x1={M.left}
          x2={M.left + iw}
          y1={plotBottom}
          y2={plotBottom}
          stroke="#94a3b8"
        />
        <text
          x={16}
          y={M.top + ih / 2}
          textAnchor="middle"
          fontSize={fonts.axis}
          fill="#475569"
          transform={`rotate(-90 16 ${M.top + ih / 2})`}
        >
          {valueTitle ?? (plotType === "stacked" ? "Composition (%)" : "Events (%)")}
        </text>
        {body}
        {xTitleY !== null && (
          <text
            x={M.left + iw / 2}
            y={xTitleY}
            textAnchor="middle"
            fontSize={fonts.axis}
            fill="#475569"
          >
            {groupTitle}
          </text>
        )}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={plotBottom + 18}
            textAnchor={layout.rotateLabels ? "end" : "middle"}
            fontSize={fonts.tick}
            fill="#334155"
            transform={
              layout.rotateLabels
                ? `rotate(-35 ${t.x} ${plotBottom + 18})`
                : undefined
            }
          >
            <title>{t.label}</title>
            {compactChartLabel(t.label)}
          </text>
        ))}
      </svg>
    );
  };

  return (
    <div
      id={containerId}
      className="gl-prop-chart"
      style={{ minWidth: Math.max(360, legendColumns * 145) }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && (hoveredLegend !== null || pinnedLegend !== null)) {
          event.stopPropagation();
          clearHighlight();
        }
      }}
    >
      <div
        className="gl-prop-panels"
        style={boxRowWidth ? { width: boxRowWidth } : undefined}
        onClick={pinnedLegend === null ? undefined : clearHighlight}
        title={pinnedLegend === null ? undefined : t("Click to show every category again")}
      >
        {plotType === "box"
          ? facets.flatMap((f, i) => catLevels.map((_, ci) => renderPanel(f, `p${i}-${ci}`, ci)))
          : facets.map((f, i) => renderPanel(f, `p${i}`))}
      </div>
      {pinnedEntry && (
        <p className="gl-prop-highlight-note" role="status">
          {t("Highlighting {label}; the rest is faded. Click it again, the chart or Show all to clear.", { label: pinnedEntry.label })}
          <button type="button" className="gl-mini-btn" onClick={clearHighlight}>{t("Show all")}</button>
        </p>
      )}
      <div
        className="gl-prop-legend"
        onPointerLeave={() => setHoveredLegend(null)}
        hidden={appearance?.showLegend === false}
        aria-label={plotType === "stacked" ? "Categories" : "Groups"}
        style={{
          fontSize: fonts.legend,
          gridTemplateColumns: `repeat(${legendColumns}, minmax(0, 1fr))`,
        }}
      >
        {plotType === "box" && groupTitle && <span className="gl-prop-legend-title">{groupTitle}</span>}
        {legend.map(({ index: i, ...l }) => (
          <button
            type="button"
            key={i}
            className={
              "gl-prop-legend-item" +
              (highlightedLegend === i ? " highlighted" : "")
            }
            title={t("{label} — hover to highlight; click to keep it highlighted, click again to clear", { label: l.label })}
            aria-pressed={pinnedLegend === i}
            onMouseEnter={() => setHoveredLegend(i)}
            onMouseLeave={() => setHoveredLegend(null)}
            onFocus={() => setHoveredLegend(i)}
            onBlur={() => setHoveredLegend(null)}
            onClick={() =>
              setPinnedLegend((current) => (current === i ? null : i))
            }
          >
            <span className="gl-prop-swatch" style={{ background: l.color }} />
            <span className="gl-prop-legend-label">{l.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface ProportionsExport {
  root: SVGSVGElement;
  width: number;
  height: number;
}

function svgDimension(svg: SVGSVGElement, name: "width" | "height"): number {
  const direct = Number.parseFloat(svg.getAttribute(name) ?? "");
  if (Number.isFinite(direct) && direct > 0) return direct;
  const viewBox = svg.viewBox.baseVal;
  return name === "width" ? viewBox.width : viewBox.height;
}

/**
 * Compose the complete Proportions card as one self-contained SVG. The on-screen legend is
 * deliberately HTML so it can provide linked hover/click behaviour; exports must redraw it as
 * SVG alongside every facet panel rather than serializing only the first chart SVG.
 */
export function composeProportionsChartSvg(
  chart: string | HTMLElement,
): ProportionsExport | null {
  const container = typeof chart === "string" ? document.getElementById(chart) : chart;
  if (!container) return null;
  const panels = [
    ...container.querySelectorAll<SVGSVGElement>("svg.gl-prop-panel"),
  ];
  if (!panels.length) return null;

  const containerRect = container.getBoundingClientRect();
  const hasLiveLayout = containerRect.width > 0 && containerRect.height > 0;
  // Under a CSS zoom (a Layout block fits its chart to its frame) client rects are zoomed and the
  // panels' own sizes are not, so every measure is taken back to the chart's own scale.
  const k = hasLiveLayout ? container.offsetWidth / containerRect.width : 1;
  const padding = 10;
  const panelGap = 12;
  const fallbackPanelSizes = panels.map((panel) => ({
    width: svgDimension(panel, "width"),
    height: svgDimension(panel, "height"),
  }));
  const fallbackPanelsWidth =
    fallbackPanelSizes.reduce((sum, size) => sum + size.width, 0) +
    Math.max(0, panels.length - 1) * panelGap;
  const fallbackPanelsHeight = Math.max(
    ...fallbackPanelSizes.map((size) => size.height),
  );

  const legend = container.querySelector<HTMLElement>(".gl-prop-legend");
  const legendItems =
    legend && !legend.hidden
      ? [...legend.querySelectorAll<HTMLElement>(".gl-prop-legend-item")]
      : [];
  const legendColumns = Math.min(
    4,
    Math.max(1, Math.ceil(legendItems.length / 10)),
  );
  const legendFontSize = Number.parseFloat(legend?.style.fontSize ?? "") || 11;
  const legendRowHeight = Math.max(18, legendFontSize + 7);
  const legendRows = Math.max(1, Math.ceil(legendItems.length / legendColumns));
  const fallbackInnerWidth = Math.max(
    360,
    fallbackPanelsWidth,
    legendColumns * 145,
  );
  const fallbackLegendTop = padding + fallbackPanelsHeight + 10;
  const fallbackWidth = fallbackInnerWidth + padding * 2;
  const legendTitleRows = legendItems.length && legend?.querySelector(".gl-prop-legend-title") ? 1 : 0;
  const fallbackHeight =
    fallbackLegendTop + 10 + (legendRows + legendTitleRows) * legendRowHeight + padding;
  const width = Math.max(
    1,
    Math.ceil(hasLiveLayout ? containerRect.width * k : fallbackWidth),
  );
  const height = Math.max(
    1,
    Math.ceil(hasLiveLayout ? containerRect.height * k : fallbackHeight),
  );

  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "Proportions chart with legend");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", "#ffffff");
  root.appendChild(background);

  let fallbackX = padding;
  panels.forEach((panel, index) => {
    const rect = panel.getBoundingClientRect();
    const useRect = hasLiveLayout && rect.width > 0 && rect.height > 0;
    const x = useRect ? (rect.left - containerRect.left) * k : fallbackX;
    const y = useRect ? (rect.top - containerRect.top) * k : padding;
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute(
      "transform",
      `translate(${Math.round(x)},${Math.round(y)})`,
    );
    const clone = panel.cloneNode(true) as SVGSVGElement;
    // A legend highlight is a way of looking at the chart, not part of it.
    clone.querySelectorAll(".gl-prop-mark, .gl-prop-mark-group").forEach((mark) => mark.removeAttribute("opacity"));
    clone.setAttribute("x", "0");
    clone.setAttribute("y", "0");
    group.appendChild(clone);
    root.appendChild(group);
    fallbackX += fallbackPanelSizes[index].width + panelGap;
  });

  if (legend && legendItems.length) {
    const legendRect = legend.getBoundingClientRect();
    const useLegendRect =
      hasLiveLayout && legendRect.width > 0 && legendRect.height > 0;
    const legendX = useLegendRect
      ? (legendRect.left - containerRect.left) * k
      : padding;
    const legendTop = useLegendRect
      ? (legendRect.top - containerRect.top) * k
      : fallbackLegendTop;
    const legendWidth = useLegendRect ? legendRect.width * k : width - padding * 2;

    const divider = document.createElementNS(SVG_NS, "line");
    divider.setAttribute("x1", String(Math.round(legendX)));
    divider.setAttribute("x2", String(Math.round(legendX + legendWidth)));
    divider.setAttribute("y1", String(Math.round(legendTop)));
    divider.setAttribute("y2", String(Math.round(legendTop)));
    divider.setAttribute("stroke", "#e2e8f0");
    divider.setAttribute("stroke-width", "1");
    root.appendChild(divider);

    const title = legend.querySelector<HTMLElement>(".gl-prop-legend-title");
    const titleRect = title?.getBoundingClientRect();
    const titleRow = title ? legendRowHeight : 0;
    if (title) {
      const useTitleRect = useLegendRect && !!titleRect && titleRect.height > 0;
      const exportTitle = document.createElementNS(SVG_NS, "text");
      exportTitle.setAttribute("x", String(Math.round(useTitleRect ? (titleRect!.left - containerRect.left) * k : legendX)));
      exportTitle.setAttribute("y", String(Math.round(useTitleRect ? (titleRect!.top - containerRect.top + titleRect!.height / 2) * k : legendTop + 10 + legendRowHeight / 2)));
      exportTitle.setAttribute("dy", "0.35em");
      exportTitle.setAttribute("font-size", String(legendFontSize));
      exportTitle.setAttribute("font-weight", "bold");
      exportTitle.setAttribute("fill", "#334155");
      exportTitle.textContent = title.textContent ?? "";
      root.appendChild(exportTitle);
    }
    const fallbackColumnWidth = legendWidth / legendColumns;
    legendItems.forEach((item, index) => {
      const itemRect = item.getBoundingClientRect();
      const useItemRect =
        useLegendRect && itemRect.width > 0 && itemRect.height > 0;
      const column = index % legendColumns;
      const row = Math.floor(index / legendColumns);
      const itemX = useItemRect
        ? (itemRect.left - containerRect.left) * k
        : legendX + column * fallbackColumnWidth;
      const itemY = useItemRect
        ? (itemRect.top - containerRect.top) * k
        : legendTop + 10 + titleRow + row * legendRowHeight;
      const itemHeight = useItemRect ? itemRect.height * k : legendRowHeight;
      const swatch = item.querySelector<HTMLElement>(".gl-prop-swatch");
      const label =
        item
          .querySelector<HTMLElement>(".gl-prop-legend-label")
          ?.textContent?.trim() ?? "";
      const color =
        swatch?.style.backgroundColor || swatch?.style.background || "#94a3b8";

      const exportItem = document.createElementNS(SVG_NS, "g");
      exportItem.setAttribute("class", "gl-prop-export-legend-item");
      const exportSwatch = document.createElementNS(SVG_NS, "rect");
      exportSwatch.setAttribute("x", String(Math.round(itemX)));
      exportSwatch.setAttribute(
        "y",
        String(Math.round(itemY + (itemHeight - 12) / 2)),
      );
      exportSwatch.setAttribute("width", "12");
      exportSwatch.setAttribute("height", "12");
      exportSwatch.setAttribute("rx", "2");
      exportSwatch.setAttribute("fill", color);
      exportSwatch.setAttribute("stroke", "rgba(0,0,0,0.2)");
      exportItem.appendChild(exportSwatch);

      const exportLabel = document.createElementNS(SVG_NS, "text");
      exportLabel.setAttribute("x", String(Math.round(itemX + 18)));
      exportLabel.setAttribute("y", String(Math.round(itemY + itemHeight / 2)));
      // Illustrator ignores dominant-baseline; a shift of a third of an em centres the label the same way.
      exportLabel.setAttribute("dy", "0.35em");
      exportLabel.setAttribute("font-size", String(legendFontSize));
      exportLabel.setAttribute("font-family", "Arial, Helvetica, sans-serif");
      exportLabel.setAttribute("fill", "#334155");
      exportLabel.textContent = label;
      exportItem.appendChild(exportLabel);
      root.appendChild(exportItem);
    });
  }

  return { root, width, height };
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
