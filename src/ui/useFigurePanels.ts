import { useEffect, useMemo, useState } from "react";
import type { StoredHierarchy } from "../engine/hierarchies";
import {
  buildFigurePanel,
  figureDisplaySample,
  figureRanges,
  type FigurePage,
  type FigurePanelData,
  type FigureSource,
  type FigureSpec,
} from "../engine/figure";
import {
  defaultIllustrationConfig,
  figureStyle,
} from "../engine/figureDefaults";

export function useFigurePanels(
  page: FigurePage | undefined,
  figure: FigureSpec,
  sources: FigureSource[],
  trees: Record<string, StoredHierarchy>,
  pending: boolean,
  maxEvents: number,
  summaryStat: "median" | "mean" = "median",
  gatingRanges: Record<string, [number, number]> = {},
  /** Bumped by the Refresh button: every panel is built again. */
  refreshKey: number = 0,
) {
  const specsKey = JSON.stringify(figure.transforms);
  // Under the "gating" policy the figure is drawn on the Gating tab's own transforms, as they
  // are now, so its axes are the Gating tab's axes; the transforms the figure captured apply
  // under the other policies. The live specs are part of the key so a change on the Gating
  // tab reaches the figure.
  const live = figure.scalePolicy === "gating";
  const liveKey = live
    ? JSON.stringify(sources.map((s) =>
        Object.keys(figure.transforms).map((key) => (s.sample.index(key) === undefined ? null : s.sample.transformSpec(key)))))
    : "";
  const projected = useMemo(
    () =>
      sources.map((s) => ({
        ...s,
        sample: live ? s.sample : figureDisplaySample(s.sample, figure.transforms),
      })),
    [sources, specsKey, live, liveKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  // The Gating tab's ranges are in the units of the transforms it uses now, which under the
  // "gating" policy are the figure's too.
  const usableGating = useMemo(() => {
    if (!live) return {};
    const out: Record<string, [number, number]> = {};
    for (const key of Object.keys(figure.transforms)) {
      const range = gatingRanges[key];
      if (range) out[key] = range;
    }
    return out;
  }, [live, specsKey, gatingRanges]); // eslint-disable-line react-hooks/exhaustive-deps
  const gatingKey = JSON.stringify(usableGating);
  const ranges = useMemo(
    () => figureRanges(projected, figure, usableGating),
    [projected, specsKey, figure.scalePolicy, gatingKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const [result, setResult] = useState<{
    key: string;
    data: Record<string, FigurePanelData>;
    pending: boolean;
    error: string | null;
  }>({ key: "", data: {}, pending: true, error: null });
  const key = JSON.stringify([
    page,
    figure.composition,
    figure.overlayPopulations,
    figure.scalePolicy,
    figure.samplePopulations,
    figure.populationOverrides,
    figure.labelOffsets,
    maxEvents,
    summaryStat,
    specsKey,
    liveKey,
    gatingKey,
    refreshKey,
    pending,
    projected.map((s) => [
      s.id,
      s.name,
      s.sample.dataRevision,
      s.tree.gates,
      s.tree.populations,
      s.tree.source_population_ids,
    ]),
    Object.values(trees).map((tree) => [
      tree.id,
      tree.source_hierarchy_id,
      tree.source_population_ids,
      tree.source_gate_ids,
      tree.gates,
      tree.populations,
    ]),
  ]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    if (pending) return;
    if (!page) {
      setResult({ key, data: {}, pending: false, error: null });
      return;
    }
    const data: Record<string, FigurePanelData> = {};
    let index = 0;
    const options = figureStyle({
      ...defaultIllustrationConfig(),
      heatmapStat: summaryStat,
      maxEvents: Math.min(
        maxEvents,
        Math.max(100, Math.floor(300000 / Math.max(1, page.panels.length))),
      ),
    });
    function next() {
      if (cancelled) return;
      try {
        const panel = page!.panels[index++];
        data[panel.key] = buildFigurePanel(
          panel,
          { ...figure, showGates: true },
          projected,
          trees,
          options,
          ranges,
        );
        if (index < page!.panels.length) timer = setTimeout(next, 0);
        else setResult({ key, data, pending: false, error: null });
      } catch (error) {
        setResult({
          key,
          data: {},
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (page.panels.length) timer = setTimeout(next, 0);
    else setResult({ key, data, pending: false, error: null });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Style and panel dimensions are intentionally excluded: those repaint existing data only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    ...result,
    pending: pending || result.key !== key || result.pending,
    projected,
    ranges,
  };
}
