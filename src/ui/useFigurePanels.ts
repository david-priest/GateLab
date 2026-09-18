import { useEffect, useMemo, useRef, useState } from "react";
import type { StoredHierarchy } from "../engine/hierarchies";
import type { Gate } from "../engine/models";
import { cellLabelOffsets, type GateOverlay } from "../engine/illustration";
import {
  buildFigurePanel,
  figureDisplaySample,
  figureRanges,
  type FigurePage,
  type FigurePanelData,
  type FigureSource,
  type FigureSpec,
  withFigureLabelOffsets,
} from "../engine/figure";
import {
  defaultIllustrationConfig,
  figureStyle,
} from "../engine/figureDefaults";

/** A tree's gates without their label placements: what a panel is built from, so a moved label repaints rather than rebuilds. */
function gateShapes(gates: Record<string, Gate>): unknown[] {
  return Object.values(gates).map((gate) => {
    const { label_offset: _label, quadrant_label_offsets: _quadrants, ...shape } = gate as Gate & { quadrant_label_offsets?: unknown };
    return shape;
  });
}

/** The trees' label placements alone, as a key: a change repaints the panels that show them. */
function gatePlacements(trees: Record<string, StoredHierarchy>): unknown[] {
  return Object.values(trees).map((tree) => [
    tree.id,
    Object.values(tree.gates).map((gate) => [gate.gate_id, gate.label_offset, (gate as Gate & { quadrant_label_offsets?: unknown }).quadrant_label_offsets ?? null]),
  ]);
}

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
      gateShapes(s.tree.gates),
      s.tree.populations,
      s.tree.source_population_ids,
    ]),
    Object.values(trees).map((tree) => [
      tree.id,
      tree.source_hierarchy_id,
      tree.source_population_ids,
      tree.source_gate_ids,
      gateShapes(tree.gates),
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
        Math.max(100, Math.floor(1_000_000 / Math.max(1, page.panels.length))),
      ),
    });
    function next() {
      if (cancelled) return;
      try {
        const panel = page!.panels[index++];
        data[panel.key] = buildFigurePanel(
          panel,
          // Built without the figure's label offsets: those only move labels on a built panel,
          // and are put on below, so a label drag repaints its panel rather than rebuilding all.
          { ...figure, showGates: true, labelOffsets: undefined },
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
  // Label placements are the gates' own and live in the trees, so a move changes no panel's
  // events: the built panels stay and the placements are laid over them here, keyed by the
  // placements alone. A figure saved with placements of its own still lays those on top.
  const offsetsKey = JSON.stringify(figure.labelOffsets ?? null);
  const placementsKey = JSON.stringify(gatePlacements(trees));
  const latest = useRef({ projected, trees });
  latest.current = { projected, trees };
  const data = useMemo(() => {
    if (!page) return result.data;
    const { projected, trees } = latest.current;
    const legacy = !!figure.labelOffsets && Object.keys(figure.labelOffsets).length > 0;
    const out: Record<string, FigurePanelData> = {};
    let changed = false;
    for (const [panelKey, panel] of Object.entries(result.data)) {
      const gates = panel.config?.gates as GateOverlay[] | undefined;
      const sampleId = page.panels.find((p) => p.key === panelKey)?.samples[0];
      const source = sampleId ? projected.find((s) => s.id === sampleId) : undefined;
      if (!gates?.length || !source || !panel.config) {
        out[panelKey] = panel;
        continue;
      }
      let placed = gates.map((gate) => {
        const own = source.tree.gates[gate.gate_id];
        if (!own) return gate;
        const cell = cellLabelOffsets(own, !!gate.flipped);
        return {
          ...gate,
          ...(cell.label_offset ? { label_offset: cell.label_offset } : {}),
          ...(cell.quadrant_label_offsets ? { quadrant_label_offsets: cell.quadrant_label_offsets } : {}),
        };
      });
      if (legacy) placed = withFigureLabelOffsets(placed, figure, source.tree, trees);
      out[panelKey] = { ...panel, config: { ...panel.config, gates: placed } };
      changed = true;
    }
    return changed ? out : result.data;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.data, offsetsKey, placementsKey, page]);
  return {
    ...result,
    data,
    pending: pending || result.key !== key || result.pending,
    projected,
    ranges,
  };
}
