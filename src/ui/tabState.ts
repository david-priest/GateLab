// tabState.ts — session-scoped tab-state persistence.
//
// Tabs unmount when you switch away and remount when you return, so plain useState resets every
// visit. This is a drop-in useState replacement that stashes each value in a module-level store
// keyed by a stable string, so a tab returns in the state you left it (until the page reloads).
// Use it for GLOBAL tab config (which populations/channels are selected, plot type, palette…) —
// NOT for per-sample state (dye channel, division boundaries), which belongs to the sample.
//
// This is deliberately lighter than the Illustration/Strategy configRef pattern: no interface, no
// prop threading through App — just swap `useState(x)` → `usePersistedTabState("tab.field", x)`.
// Like configRef it is in-session only (not written to the workspace file).

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { OVERLAY_PALETTES } from "../engine/palettes";
import { normalizePanelWidth, normalizeProportionsSettings, type ProportionsSettings } from "../engine/proportionsSettings";
import { FIRST_PLOTTING_CHART, type WorkspacePlottingCharts } from "../engine/workspace";

const store: Record<string, unknown> = {};

/** useState, but the value survives this tab unmounting/remounting (keyed by `key`, session-scoped). */
export function usePersistedTabState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    key in store
      ? (store[key] as T)
      : typeof initial === "function"
        ? (initial as () => T)()
        : initial,
  );
  useEffect(() => {
    store[key] = value;
  }, [key, value]);
  return [value, setValue];
}

/** The session-held values whose keys start with `prefix`, for a reader outside the tab (the tutorial). */
export function readPersistedTabValues(prefix: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(store).filter(([key]) => key.startsWith(prefix)));
}

/** Drop persisted tab state (e.g. when a fresh workspace is opened, so stale selections don't leak). */
export function clearPersistedTabState(): void {
  for (const k of Object.keys(store)) delete store[k];
}

export function savedPlottingState(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(store).filter(([key]) => key.startsWith("prop.")),
  );
}

/**
 * The Plotting tab's settings as it would show them now: what the store holds over the defaults
 * given, so a chart can be taken from the tab whether or not it has been opened.
 */
export function readProportionsSettings(defaults: ProportionsSettings): ProportionsSettings {
  const held = Object.fromEntries(
    Object.entries(store).filter(([key]) => key.startsWith("prop.")).map(([key, value]) => [key.slice(5), value]),
  );
  return normalizeProportionsSettings(held, defaults);
}

/** Put a chart's settings into the Plotting tab, so it opens showing that chart. */
export function writeProportionsSettings(settings: ProportionsSettings): void {
  for (const [key, value] of Object.entries(settings)) store[`prop.${key}`] = structuredClone(value);
}

/** Only known presentation settings are restored; malformed values fall back to UI defaults. */
export function restorePlottingState(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = value as Record<string, unknown>;
  const enums: Record<string, string[]> = {
    categoryKind: ["population", "division"],
    valueKind: ["proportion", "cells", "statistic"],
    plotType: ["stacked", "box", "violin", "bar", "dots", "splitViolin", "ridgeline"],
    statistic: ["median", "mean", "geomean"],
    errorBar: ["sd", "sem"],
    proportionValue: ["parent", "total", "count"],
    xAxis: ["populations", "groups"],
    cellRange: ["gating", "fit"],
    replicateMarks: ["none", "median", "mean"],
    comparisons: ["overall", "pairwise"],
    comparisonsShow: ["all", "significant"],
    panelColumns: ["", "populations", "groups", "facet", "channels"],
    panelRows: ["", "populations", "groups", "facet", "channels"],
    pageBy: ["", "populations", "groups", "facet", "channels"],
    palette: OVERLAY_PALETTES.map((palette) => palette.value),
  };
  const numeric: Record<string, [number, number]> = {
    fontTick: [5, 20],
    fontAxis: [5, 24],
    fontLegend: [5, 20],
    height: [140, 800],
    pointRadius: [0.5, 5],
    panelsPerRow: [1, 12],
  };
  for (const [key, item] of Object.entries(entries)) {
    if (!key.startsWith("prop.")) continue;
    const field = key.slice(5);
    if (
      enums[field]?.includes(item as string) ||
      (["groupSel", "unitSel", "facetSel", "hierarchy", "parent", "channel"].includes(field) &&
        typeof item === "string") ||
      ([
        "includeUngated",
        "averagePerUnit",
        "grid",
        "points",
        "paired",
        "legend",
        "violinBox",
        "test",
        "showN",
        "valueFromZero",
        "followFigureStyle",
        "colourByPopulation",
        "populationsTogether",
      ].includes(field) &&
        typeof item === "boolean") ||
      (["selectedPops", "files", "channels"].includes(field) &&
        Array.isArray(item) &&
        item.every((id) => typeof id === "string"))
    )
      store[key] = item;
    else if (["valueMin", "valueMax", "shareValueAxis"].includes(field) && item === null)
      store[key] = null;
    else if (field === "shareValueAxis" && typeof item === "boolean")
      store[key] = item;
    else if (["valueMin", "valueMax"].includes(field) && typeof item === "number" && Number.isFinite(item))
      store[key] = item;
    else if (field === "panelWidth" && typeof item === "number" && Number.isFinite(item))
      store[key] = normalizePanelWidth(item);
    else if (
      numeric[field] &&
      typeof item === "number" &&
      Number.isFinite(item)
    )
      store[key] = Math.max(
        numeric[field][0],
        Math.min(numeric[field][1], item),
      );
  }
}

// The Plotting tab's named charts. The shown chart's settings are the `prop.` keys above, so every
// reader of the tab's settings reads the shown chart; the list keeps the others, and the shown
// one's entry is brought up to date whenever the list is read. Undo and redo hold whole lists, at
// most PLOTTING_HISTORY_LIMIT steps each, as the Illustration tab holds 30 figure states.
const PLOTTING_CHARTS_KEY = "plotting.charts";
const PLOTTING_HISTORY_KEY = "plotting.history";
const PLOTTING_HISTORY_LIMIT = 30;

interface PlottingHistory {
  undo: WorkspacePlottingCharts[];
  redo: WorkspacePlottingCharts[];
}

/** The charts, the shown one's settings as the tab holds them now. One chart of the defaults until a workspace or the tab makes more. */
export function plottingCharts(): WorkspacePlottingCharts {
  const held = store[PLOTTING_CHARTS_KEY] as WorkspacePlottingCharts | undefined;
  // A new workspace's first chart uses the figure style, whether or not the tab has been opened.
  const list = held ?? { activeId: FIRST_PLOTTING_CHART.id, charts: [{ ...FIRST_PLOTTING_CHART, plotting: {} }] };
  const shown = held || "prop.followFigureStyle" in store ? savedPlottingState() : { ...savedPlottingState(), "prop.followFigureStyle": true };
  return {
    activeId: list.activeId,
    charts: list.charts.map((chart) => ({ ...chart, plotting: structuredClone(chart.id === list.activeId ? shown : chart.plotting) })),
  };
}

/** Make a list the charts and put its shown chart's settings into the tab, keeping only the fields the tab knows. */
function showPlottingCharts(list: WorkspacePlottingCharts): void {
  const shown = list.charts.find((chart) => chart.id === list.activeId) ?? list.charts[0];
  store[PLOTTING_CHARTS_KEY] = structuredClone({ activeId: shown.id, charts: list.charts });
  for (const key of Object.keys(store)) if (key.startsWith("prop.")) delete store[key];
  restorePlottingState(shown.plotting);
  // A chart saved before the figure style draws with its own sizes, as it did; a new one says so.
  if (!("prop.followFigureStyle" in store)) store["prop.followFigureStyle"] = false;
}

function plottingHistory(): PlottingHistory {
  return (store[PLOTTING_HISTORY_KEY] ??= { undo: [], redo: [] }) as PlottingHistory;
}

/** A workspace's charts, as it opens: the shown one in the tab, and no undo history. */
export function restorePlottingCharts(list: WorkspacePlottingCharts): void {
  showPlottingCharts(list);
  delete store[PLOTTING_HISTORY_KEY];
}

/** Show another chart. Not an undo step. */
export function selectPlottingChart(id: string): void {
  const list = plottingCharts();
  if (list.activeId === id || !list.charts.some((chart) => chart.id === id)) return;
  showPlottingCharts({ ...list, activeId: id });
}

/** Charts as they were before a change, kept as one undo step; the redo steps are dropped. */
export function recordPlottingStep(before: WorkspacePlottingCharts): void {
  const history = plottingHistory();
  history.undo = [...history.undo, structuredClone(before)].slice(-PLOTTING_HISTORY_LIMIT);
  history.redo = [];
}

/** Replace the charts as one undo step: a chart added, duplicated, renamed or deleted. */
export function changePlottingCharts(next: WorkspacePlottingCharts): void {
  recordPlottingStep(plottingCharts());
  showPlottingCharts(next);
}

export function canUndoPlotting(): boolean {
  return plottingHistory().undo.length > 0;
}

export function canRedoPlotting(): boolean {
  return plottingHistory().redo.length > 0;
}

/** Go back one step, showing the chart as it was then. False when there is nothing to undo. */
export function undoPlotting(): boolean {
  const history = plottingHistory();
  const previous = history.undo.at(-1);
  if (!previous) return false;
  history.undo = history.undo.slice(0, -1);
  history.redo = [plottingCharts(), ...history.redo].slice(0, PLOTTING_HISTORY_LIMIT);
  showPlottingCharts(previous);
  return true;
}

/** Go forward one undone step. False when there is nothing to redo. */
export function redoPlotting(): boolean {
  const history = plottingHistory();
  const next = history.redo[0];
  if (!next) return false;
  history.redo = history.redo.slice(1);
  history.undo = [...history.undo, plottingCharts()].slice(-PLOTTING_HISTORY_LIMIT);
  showPlottingCharts(next);
  return true;
}

/** `name`, or `name (2)`, `name (3)`, … when a chart already has it. */
export function uniquePlottingChartName(list: WorkspacePlottingCharts, name: string): string {
  const taken = new Set(list.charts.map((chart) => chart.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/** "Chart N", numbered on from the charts there are. */
export function newPlottingChartName(list: WorkspacePlottingCharts): string {
  const taken = new Set(list.charts.map((chart) => chart.name));
  let n = list.charts.length + 1;
  while (taken.has(`Chart ${n}`)) n += 1;
  return `Chart ${n}`;
}

/** Settings from elsewhere (a Layout block) as a new chart, shown, as one undo step. */
export function openPlottingSettingsAsChart(settings: ProportionsSettings, name: string): void {
  const list = plottingCharts();
  const chart = {
    id: crypto.randomUUID(),
    name: uniquePlottingChartName(list, name),
    plotting: Object.fromEntries(Object.entries(settings).map(([key, value]) => [`prop.${key}`, structuredClone(value)])),
  };
  changePlottingCharts({ activeId: chart.id, charts: [...list.charts, chart] });
}
