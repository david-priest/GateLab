// LayoutProportions.tsx — the Plotting tab's chart on a Layout page, drawn by the tab's own model
// and chart from the settings the block holds, so it looks on the page as it does there. The
// block keeps the chart as it was when added; "Edit in Plotting" hands it back to that tab, and
// the block can be replaced with the tab's current chart.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DivisionProfileLike } from "../engine/factors";
import type { FigureSample } from "../engine/figure";
import type { LayoutProportionsRecipe, LayoutSheet } from "../engine/layout";
import { pageContentBox } from "../engine/layoutArrange";
import {
  buildProportionsModel,
  proportionsCategoryColors,
  proportionsPopulations,
  type ProportionsModel,
  type ProportionsSampleRef,
  type ProportionsSettings,
} from "../engine/proportionsModel";
import type { CoreState } from "../store";
import { ProportionsChart, proportionPanelLayout } from "./ProportionsTab";

/** The workspace's files as the Plotting model reads them: by id, file name and tree. */
export function proportionsSampleRefs(samples: readonly FigureSample[]): ProportionsSampleRef[] {
  return samples.map((entry) => ({ id: entry.id, name: entry.fileName ?? entry.name, sample: entry.sample, hierarchyId: entry.hierarchyId }));
}

/**
 * A frame for a new block: the chart at its natural size, panels side by side over the legend,
 * within the sheet's page content box.
 */
export function proportionsBlockFrame(
  settings: ProportionsSettings,
  model: ProportionsModel,
  sheet: LayoutSheet,
): { width: number; height: number } {
  const box = pageContentBox(sheet);
  const facets = model.hasFacet ? Math.max(1, new Set(model.perSample.map((row) => row.facet ?? "")).size) : 1;
  const groups = [...new Set(model.perSample.map((row) => row.group))];
  const labels = settings.plotType === "stacked" ? groups : model.catLevels;
  const panel = proportionPanelLayout(settings.plotType, labels, Math.max(1, groups.length), settings.fontTick);
  const legendCount = settings.plotType === "stacked" ? model.catLevels.length : groups.length;
  const columns = Math.min(4, Math.max(1, Math.ceil(legendCount / 10)));
  const rows = Math.max(1, Math.ceil(legendCount / columns));
  const width = Math.max(360, columns * 145, facets * panel.width + (facets - 1) * 12) + 24;
  const height = panel.height - 240 + settings.height + (settings.legend ? 22 + rows * (settings.fontLegend + 9) : 0) + 24;
  return { width: Math.round(Math.min(width, box.width)), height: Math.round(Math.min(height, box.height)) };
}

export function LayoutProportionsSurface({
  recipe,
  samples,
  state,
  metadataById,
  divisionProfiles,
  width,
  height,
  containerId,
}: Readonly<{
  recipe: LayoutProportionsRecipe;
  samples: readonly FigureSample[];
  state: CoreState;
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  width: number;
  height: number;
  /** The chart card's element id; each block on a page needs its own. */
  containerId: string;
}>) {
  const settings = recipe.settings;
  const files = useMemo(() => proportionsSampleRefs(samples), [samples]);
  const model = useMemo(
    () => buildProportionsModel(settings, files, state, metadataById, divisionProfiles),
    [settings, files, state, metadataById, divisionProfiles],
  );
  const populations = useMemo(() => proportionsPopulations(settings, state), [settings, state]);
  const catColors = useMemo(() => proportionsCategoryColors(model, settings, populations), [model, settings, populations]);
  // The chart is laid out at its natural size and zoomed to fit the frame, never enlarged.
  const zoomRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useLayoutEffect(() => {
    const node = zoomRef.current;
    if (!node) return;
    const measure = () => {
      const natural = node.firstElementChild as HTMLElement | null;
      if (!natural) return;
      const w = natural.offsetWidth;
      const h = natural.offsetHeight;
      if (!w || !h) return;
      setZoom(Math.min(1, width / w, height / h));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, height, model]);

  if (!model.catLevels.length || !model.perSample.length) {
    return (
      <div className="gl-layout-plot-host gl-layout-proportions-host is-missing">
        {settings.files.length && (settings.categoryKind === "division" || settings.selectedPops.length)
          ? "The chart's files or populations are not in this workspace."
          : "The chart has no files or populations."}
      </div>
    );
  }
  return (
    <div className="gl-layout-plot-host gl-layout-proportions-host" style={{ width, height }}>
      <div ref={zoomRef} className="gl-layout-figure-zoom" style={{ zoom, width: "max-content" }}>
        <ProportionsChart
          containerId={containerId}
          plotType={settings.plotType}
          model={model}
          catColors={catColors}
          palette={settings.palette}
          averagePerUnit={settings.averagePerUnit}
          populations={populations}
          fonts={{ tick: settings.fontTick, axis: settings.fontAxis, legend: settings.fontLegend }}
          appearance={{
            height: settings.height,
            showGrid: settings.grid,
            showPoints: settings.points,
            showLegend: settings.legend,
            pointRadius: settings.pointRadius,
          }}
        />
      </div>
    </div>
  );
}
