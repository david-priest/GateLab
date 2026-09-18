// ProportionsTab.tsx — population/category composition across samples, ported from GateLabR's
// Proportions tab (app.R:1130-1155, 4287-4441). Unlike GateLabR (which only read SCE colData and
// so could not use gated populations), GateLab lets a POPULATION partition be the Category: each
// event is labelled by the deepest selected population (events in none → "ungated"). Group / Unit /
// Facet come from per-sample metadata (or the sample name). Rendered as a custom SVG stacked bar
// (composition per Group) or boxplot (per-unit fraction per Category, dodged by Group).

import { useEffect, useMemo, useState } from "react";
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
import { figureHierarchies } from "../engine/figure";
import {
  buildProportionsModel,
  defaultProportionsSettings,
  proportionsCategoryColors,
  type ProportionsSettings,
} from "../engine/proportionsModel";
import { BASE_PROPORTIONS_SETTINGS, PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../engine/proportionsSettings";

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
  const [section, setSection] = useState("data");
  // The settings before the user touches anything, shared with the Layout tab, so a chart taken
  // from there before this tab has been opened is the chart this tab would show.
  const [defaults] = useState(() => defaultProportionsSettings(files, activeState, metadataColumns));
  const [selectedFiles, setSelectedFiles] = usePersistedTabState<string[]>("prop.files", () => defaults.files);
  const [hierarchyId, setHierarchyId] = usePersistedTabState("prop.hierarchy", defaults.hierarchy);
  const trees = figureHierarchies(activeState);
  const tree = trees[hierarchyId] ?? trees[activeState.active_hierarchy_id];
  const state = { ...activeState, ...tree };
  const samples = files.filter((file) => selectedFiles.includes(file.id));
  const [chartHeight, setChartHeight] = usePersistedTabState("prop.height", defaults.height);
  const [showGrid, setShowGrid] = usePersistedTabState("prop.grid", defaults.grid);
  const [showPoints, setShowPoints] = usePersistedTabState("prop.points", defaults.points);
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
  useEffect(() => {
    onConfigChange?.();
  }, [
    selectedFiles,
    hierarchyId,
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
  const exportSvg = (kind: "svg" | "png") =>
    downloadChart("gl-prop-svg", "proportions", kind);
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
          <h3>Files / samples</h3>
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
          {Object.keys(trees).length > 1 && (<>
          <label className="gl-field-inline">
            Population hierarchy
            <select
              value={tree.id}
              onChange={(event) => {
                setHierarchyId(event.target.value);
                setSelectedPops([]);
              }}
            >
              {Object.values(trees).map((tree) => (
                <option key={tree.id} value={tree.id}>
                  {tree.name}
                </option>
              ))}
            </select>
          </label>
          <p className="gl-hint">
            Each file uses its own gates. Correspondence follows hierarchy
            provenance, not population names.
          </p>
          </>)}
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
              {t("Data")}
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
              <label className="gl-field-inline">
                {t("Replicate unit")}
                <select
                  value={unitSel}
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
              <p className="gl-hint">
                Group controls the bars or box colours. Facet creates separate
                panels. Each boxplot observation represents one replicate unit,
                not one event.
              </p>
              <label
                className="gl-check"
                title="Normalise within each unit before averaging across units"
              >
                <input
                  type="checkbox"
                  checked={averagePerUnit}
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
              <p className="gl-hint">Composition assigns events to their deepest selected population. Excluding ungated events renormalizes percentages to the selected populations.</p>
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
                <input
                  type="number"
                  min={5}
                  max={20}
                  value={fontTick}
                  onChange={(e) =>
                    setFontTick(Math.max(5, Math.min(20, +e.target.value || 9)))
                  }
                />
              </label>
              <label className="gl-field-inline">
                {t("Axis")}
                <input
                  type="number"
                  min={5}
                  max={24}
                  value={fontAxis}
                  onChange={(e) =>
                    setFontAxis(
                      Math.max(5, Math.min(24, +e.target.value || 10)),
                    )
                  }
                />
              </label>
              <label className="gl-field-inline">
                {t("Legend")}
                <input
                  type="number"
                  min={5}
                  max={20}
                  value={fontLegend}
                  onChange={(e) =>
                    setFontLegend(
                      Math.max(5, Math.min(20, +e.target.value || 11)),
                    )
                  }
                />
              </label>
              <label className="gl-field-inline">
                Plot height
                <input
                  type="number"
                  min={140}
                  max={800}
                  value={chartHeight}
                  onChange={(event) =>
                    setChartHeight(
                      Math.max(140, Math.min(800, +event.target.value || 280)),
                    )
                  }
                />
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
              <label className="gl-check">
                <input
                  type="checkbox"
                  checked={showPoints}
                  onChange={(event) => setShowPoints(event.target.checked)}
                />
                Show replicate points
              </label>
              <label className="gl-field-inline">
                Point size
                <input
                  type="range"
                  min={0.5}
                  max={5}
                  step={0.5}
                  value={pointRadius}
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
                title="Export the current Proportions chart as PNG"
                onClick={() => exportSvg("png")}
              >
                PNG
              </button>
              <button
                className="gl-mini-btn"
                title="Export the current Proportions chart as SVG"
                onClick={() => exportSvg("svg")}
              >
                SVG
              </button>
            </div>
          </section>
        </div>
      </aside>
      <div className="gl-prop-body">
        <div className="gl-prop-chart-scroll">
          {model.excluded?.length ? (
            <p className="gl-plotting-warning" role="status">
              {model.excluded.length} files excluded: selected populations are
              missing, ambiguous, or structurally changed.{" "}
              {model.excluded.join(", ")}
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
          {samples.length === 0 || nCat === 0 ? (
            <div className="gl-tab-empty">
              Select at least one population, and load samples with metadata.
            </div>
          ) : (
            <ProportionsChart
              plotType={plotType}
              model={model}
              catColors={catColors}
              palette={palette}
              averagePerUnit={averagePerUnit}
              populations={state.populations}
              fonts={{ tick: fontTick, axis: fontAxis, legend: fontLegend }}
              appearance={{
                height: chartHeight,
                showGrid,
                showPoints,
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
    showLegend: boolean;
    pointRadius: number;
  };
  /** The card's element id, which the export composer finds it by; each chart on a page needs its own. */
  containerId?: string;
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
  const slotWidth =
    plotType === "box" ? Math.max(52, groupCount * 18 + 18) : 72;
  const innerWidth = Math.max(280, labels.length * slotWidth);
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
}: ChartProps) {
  const { catLevels, perSample, hasFacet, levels } = model;
  const [hoveredLegend, setHoveredLegend] = useState<number | null>(null);
  const [pinnedLegend, setPinnedLegend] = useState<number | null>(null);
  const highlightedLegend = hoveredLegend ?? pinnedLegend;
  const nCat = catLevels.length;
  const facets = hasFacet
    ? [...new Set(perSample.map((s) => s.facet ?? ""))].sort()
    : [null];

  // Legend entities: categories for stacked, groups for box.
  const groups = [...new Set(perSample.map((s) => s.group))].sort();
  const groupColors = paletteColors(palette, Math.max(1, groups.length));
  const legend =
    plotType === "stacked"
      ? catLevels.map((l, i) => ({ label: l, color: catColors[i] }))
      : groups.map((g, i) => ({ label: g, color: groupColors[i] }));

  // Keep large category sets compact: at most ten rows, up to four columns. The chart card
  // expands horizontally rather than becoming a mostly-empty page-height legend column.
  const legendColumns = Math.min(4, Math.max(1, Math.ceil(legend.length / 10)));
  const markOpacity = (legendIndex: number) =>
    highlightedLegend === null || highlightedLegend === legendIndex ? 1 : 0.16;

  const renderPanel = (facet: string | null, key: string) => {
    const sub = hasFacet
      ? perSample.filter((s) => (s.facet ?? "") === facet)
      : perSample;
    const stackedBars =
      plotType === "stacked"
        ? computeStackedBars(sub, nCat, {
            averagePerUnit,
            hasUnit: true,
            hasFacet: false,
          }).sort((a, b) => (a.group < b.group ? -1 : 1))
        : null;
    const xLabels = stackedBars
      ? stackedBars.map((bar) => bar.group)
      : catLevels;
    const layout = proportionPanelLayout(
      plotType,
      xLabels,
      groups.length,
      fonts.tick,
    );
    const PW = layout.width,
      PH = layout.height - 240 + (appearance?.height ?? 240),
      M = layout.margin;
    const iw = PW - M.left - M.right,
      ih = appearance?.height ?? 240;
    const plotBottom = M.top + ih;
    const y = (v: number) => M.top + ih * (1 - v); // v in [0,1]
    let body: JSX.Element[] = [];
    let xTicks: { x: number; label: string }[] = [];

    if (stackedBars) {
      const bars = stackedBars;
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
                <title>{`${catLevels[node.cat]}: ${((node.y1 - node.y0) * 100).toFixed(1)}%`}</title>
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
                <title>{`ungated: ${(ungated * 100).toFixed(1)}%`}</title>
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
              <title>{`${catLevels[seg.cat]}: ${(seg.value * 100).toFixed(1)}%`}</title>
            </rect>,
          );
          acc += seg.value;
        });
      });
    } else {
      const units = perUnitProps(sub, nCat);
      const boxes = computeBoxes(units, nCat, false);
      const bw = 14;
      const catStep = nCat ? iw / nCat : 0;
      catLevels.forEach((_, ci) => {
        const cxCat = M.left + catStep * (ci + 0.5);
        xTicks.push({ x: cxCat, label: catLevels[ci] });
        const catBoxes = boxes.filter((b) => b.cat === ci);
        const ng = groups.length || 1;
        catBoxes.sort((a, b) => (a.group < b.group ? -1 : 1));
        catBoxes.forEach((box) => {
          const gi = groups.indexOf(box.group);
          const dodge = (gi - (ng - 1) / 2) * (bw + 3);
          const cx = cxCat + dodge;
          const col = groupColors[gi] ?? "#888";
          const { q1, med, q3, min, max } = box.stats;
          body.push(
            <g
              key={`b-${ci}-${box.group}`}
              className="gl-prop-mark-group"
              opacity={markOpacity(gi)}
            >
              <line
                x1={cx}
                x2={cx}
                y1={y(max)}
                y2={y(min)}
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
                <title>{`${catLevels[ci]} · ${box.group}: median ${(med * 100).toFixed(1)}%`}</title>
              </rect>
              <line
                x1={cx - bw / 2}
                x2={cx + bw / 2}
                y1={y(med)}
                y2={y(med)}
                stroke="#111"
                strokeWidth={1}
              />
              {appearance?.showPoints !== false &&
                box.values.map((v, vi) => (
                  <circle
                    key={vi}
                    cx={cx + ((vi % 5) - 2) * 2.1}
                    cy={y(v)}
                    r={appearance?.pointRadius ?? 1.5}
                    fill="#222"
                    fillOpacity={0.65}
                  />
                ))}
            </g>,
          );
        });
      });
    }

    return (
      <svg
        key={key}
        width={PW}
        height={PH}
        viewBox={`0 0 ${PW} ${PH}`}
        className="gl-prop-panel"
      >
        {hasFacet && (
          <text
            x={PW / 2}
            y={14}
            textAnchor="middle"
            fontSize={fonts.axis}
            fontWeight={600}
            fill="#334155"
          >
            {facet || "(NA)"}
          </text>
        )}
        {/* y grid + axis (percent) */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
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
              {Math.round(t * 100)}%
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
          {plotType === "stacked" ? "Composition (%)" : "Events (%)"}
        </text>
        {body}
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
    >
      <div className="gl-prop-panels">
        {facets.map((f, i) => renderPanel(f, `p${i}`))}
      </div>
      <div
        className="gl-prop-legend"
        hidden={appearance?.showLegend === false}
        aria-label={plotType === "stacked" ? "Categories" : "Groups"}
        style={{
          fontSize: fonts.legend,
          gridTemplateColumns: `repeat(${legendColumns}, minmax(0, 1fr))`,
        }}
      >
        {legend.map((l, i) => (
          <button
            type="button"
            key={i}
            className={
              "gl-prop-legend-item" +
              (highlightedLegend === i ? " highlighted" : "")
            }
            title={`${l.label} — hover to highlight; click to pin`}
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
  const fallbackHeight =
    fallbackLegendTop + 10 + legendRows * legendRowHeight + padding;
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
        : legendTop + 10 + row * legendRowHeight;
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
      exportLabel.setAttribute("dominant-baseline", "middle");
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

// Serialize the complete chart for download (PNG via canvas, SVG direct).
function downloadChart(containerId: string, name: string, kind: "svg" | "png") {
  const composed = composeProportionsChartSvg(containerId);
  if (!composed) return;
  const { root, width, height } = composed;
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
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => {
      if (b) triggerDownload(URL.createObjectURL(b), `${name}.png`);
    });
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
