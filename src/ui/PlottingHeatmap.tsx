// PlottingHeatmap.tsx — the Plotting tab's summary heatmap, drawn in the tab and in a Layout block.
// The numbers are the Illustration heatmap's (plottingHeatmapModel.ts); the drawing is FigureHeatmap.
// Panels are built one at a time between frames, as the Illustration tab builds its own, so a
// heatmap of many populations, files and channels never holds the page.

import { useEffect, useMemo, useState } from "react";
import type { CoreState } from "../store";
import type { Sample } from "../engine/sample";
import { figureHierarchies, type FigurePanelData, type FigurePopulation, type FigureSample } from "../engine/figure";
import { consistentChannels, type ProportionsSettings } from "../engine/proportionsSettings";
import type { HeatmapMatrix } from "../engine/figureHeatmap";
import { useFigureSources } from "./useFigureSources";
import { FigureHeatmap } from "./FigureHeatmap";
import { useI18n } from "./i18n";
import type { ColumnLevels } from "./plottingColours";
import {
  buildPlottingHeatmapPanel,
  plottingHeatmapConfig,
  plottingHeatmapFigure,
  plottingHeatmapMatrix,
  plottingHeatmapPage,
  plottingHeatmapPlot,
  plottingHeatmapPopulationIds,
  plottingHeatmapUnits,
} from "./plottingHeatmapModel";

interface Props {
  settings: ProportionsSettings;
  samples: readonly { id: string; name: string; sample: Sample; hierarchyId?: string }[];
  state: CoreState;
  metadata: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  columnLevels?: ColumnLevels;
  dataRevisionKey: string;
  fonts: { fontTick: number; fontAxis: number };
  /** The drawn matrix, for the data table and the export; null until it is built. */
  onMatrix?: (matrix: HeatmapMatrix | null) => void;
  /** The chart's element id, by which the Plotting export finds it. */
  containerId?: string;
}

/** The class Plotting's export collects a chart's SVGs by. */
const EXPORT_CLASS = "gl-prop-panel";

export function PlottingHeatmap({ settings, samples, state, metadata, columnLevels, dataRevisionKey, fonts, onMatrix, containerId = "gl-prop-svg" }: Props) {
  const { t } = useI18n();
  const trees = useMemo(() => figureHierarchies(state), [state]);
  const tree = trees[settings.hierarchy] ?? trees[state.active_hierarchy_id];
  const channels = useMemo(() => consistentChannels(settings.channels, settings.channel), [settings.channels, settings.channel]);
  const populations = useMemo<FigurePopulation[]>(
    () => (tree ? plottingHeatmapPopulationIds(settings, tree).map((id) => ({ hierarchyId: tree.id, populationId: id, label: tree.populations[id]?.name ?? id })) : []),
    [tree, settings.parent, settings.selectedPops], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const chosen = useMemo(() => new Set(settings.files), [settings.files]);
  const figureSamples = useMemo<FigureSample[]>(
    () => samples.filter((entry) => chosen.has(entry.id)).map((entry) => ({
      id: entry.id,
      name: entry.name,
      sample: entry.sample,
      hierarchyId: entry.hierarchyId ?? state.active_hierarchy_id,
      metadata: { ...(metadata[entry.id] ?? {}) },
    })),
    [samples, chosen, metadata, state.active_hierarchy_id],
  );
  const units = useMemo(
    () => plottingHeatmapUnits(settings, figureSamples, metadata, columnLevels),
    [settings.files, settings.unitSel, settings.groupSel, figureSamples, metadata, columnLevels], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const plot = useMemo(() => plottingHeatmapPlot(channels), [channels]);
  const figure = useMemo(
    () => (tree ? plottingHeatmapFigure(figureSamples, trees, tree.id, populations, plot) : null),
    [figureSamples, trees, tree, populations, plot],
  );
  const page = useMemo(() => plottingHeatmapPage(units, populations, plot), [units, populations, plot]);
  const config = useMemo(
    () => plottingHeatmapConfig(settings, fonts),
    [settings.statistic, settings.heatmapScale, settings.heatmapPalette, settings.heatmapClusterRows, settings.heatmapClusterColumns, settings.heatmapShowValues, settings.heatmapCellSize, fonts.fontTick, fonts.fontAxis], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const prepared = useFigureSources(figureSamples, figureSamples.map((s) => s.id), state, dataRevisionKey);
  // The panels: rebuilt when the data, the rows, the channels or the statistic change, never for a
  // change of colour, scale or order, which only re-derive the matrix.
  const buildKey = JSON.stringify([page.panels.map((p) => [p.key, p.samples]), channels, config.heatmapStat, figure?.transforms, dataRevisionKey, prepared.pending, prepared.sources.length]);
  const [built, setBuilt] = useState<{ key: string; data: Record<string, FigurePanelData>; done: number }>({ key: "", data: {}, done: 0 });
  useEffect(() => {
    if (!figure || !tree || prepared.pending > 0) return;
    let cancelled = false;
    const data: Record<string, FigurePanelData> = {};
    let index = 0;
    const step = () => {
      if (cancelled) return;
      const started = performance.now();
      // A few panels a frame, then yield.
      while (index < page.panels.length && performance.now() - started < 30) {
        const panel = page.panels[index++];
        data[panel.key] = buildPlottingHeatmapPanel(panel, figure, prepared.sources, trees, config);
      }
      setBuilt({ key: buildKey, data: { ...data }, done: index });
      if (index < page.panels.length) setTimeout(step, 0);
    };
    setBuilt({ key: buildKey, data: {}, done: 0 });
    const timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [buildKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const complete = built.key === buildKey && built.done >= page.panels.length && !prepared.pending;
  const matrix = useMemo(
    () => (complete ? plottingHeatmapMatrix(page, units, built.data, config) : null),
    [complete, page, units, built.data, config],
  );
  useEffect(() => {
    onMatrix?.(matrix);
  }, [matrix, onMatrix]);
  const problems = useMemo(
    () => [...new Set(Object.values(built.data).flatMap((d) => (d.problem ? [d.problem] : [])))],
    [built.data],
  );
  if (!channels.length) return <div className="gl-prop-empty">{t("Choose the channels to draw.")}</div>;
  if (!populations.length) return <div className="gl-prop-empty">{t("Tick the populations to draw.")}</div>;
  if (!units.length) return <div className="gl-prop-empty">{t("Choose the files to draw.")}</div>;
  if (prepared.error) return <div className="gl-figure-warning" role="alert">{prepared.error}</div>;
  if (!matrix)
    return (
      <div className="gl-prop-empty" role="status">
        {t("Building the heatmap · {done} of {total} rows", { done: String(built.key === buildKey ? built.done : 0), total: String(page.panels.length) })}
      </div>
    );
  return (
    <div id={containerId} className="gl-prop-chart gl-prop-heatmap">
      <FigureHeatmap matrix={matrix} config={config} cellSize={Math.max(12, Math.min(120, settings.heatmapCellSize))} svgClassName={EXPORT_CLASS} />
      {problems.length > 0 && (
        <div className="gl-figure-note" role="note">
          {t("Rows left blank: {list}", { list: problems.join("; ") })}
        </div>
      )}
    </div>
  );
}
