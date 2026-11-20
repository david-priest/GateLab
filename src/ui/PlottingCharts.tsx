// PlottingCharts.tsx — the Plotting tab's named charts: a tab each across the top, as the Layout
// tab shows its sheets (SheetTabs.tsx: click to show, double-click to rename, drag to reorder,
// right-click to move, rename, duplicate or delete, + for a new chart), with Undo and Redo at the
// strip's right end. The charts and their history are held in tabState.ts, so they outlive the
// tab's unmounting and are saved with the workspace; the tab itself is remounted to show another
// chart or an undone state, since it reads its settings when it mounts.

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { WorkspacePlottingCharts } from "../engine/workspace";
import { historyShortcutAction } from "./historyShortcuts";
import { useI18n } from "./i18n";
import { PlottingTab } from "./PlottingTab";
import { movedSheetTabs, SheetTabs } from "./SheetTabs";
import {
  canRedoPlotting,
  canUndoPlotting,
  changePlottingCharts,
  newPlottingChartName,
  plottingCharts,
  recordPlottingStep,
  redoPlotting,
  selectPlottingChart,
  undoPlotting,
  uniquePlottingChartName,
} from "./tabState";

type Props = ComponentProps<typeof PlottingTab>;

/** The fields of the shown chart whose values differ between two lists of the same charts; null when the charts themselves differ. */
function changedFields(before: WorkspacePlottingCharts, after: WorkspacePlottingCharts): string[] | null {
  if (before.activeId !== after.activeId || before.charts.length !== after.charts.length) return null;
  if (before.charts.some((chart, i) => chart.id !== after.charts[i].id || chart.name !== after.charts[i].name)) return null;
  const a = before.charts.find((chart) => chart.id === before.activeId)?.plotting ?? {};
  const b = after.charts.find((chart) => chart.id === after.activeId)?.plotting ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** A field a value is typed or dragged in: a number, text or slider input, not a box or a button. */
function typingField(element: Element | null): Element | null {
  return element instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(element.type)
    ? element
    : null;
}

export function PlottingChartsTab(props: Props) {
  const { t } = useI18n();
  const { onConfigChange } = props;
  // Bumped when the tab must show settings it did not make: another chart, an undone state.
  const [epoch, setEpoch] = useState(0);
  const [, setListVersion] = useState(0);
  const [history, setHistory] = useState(() => ({ undo: canUndoPlotting(), redo: canRedoPlotting() }));
  const list = plottingCharts();
  const active = list.charts.find((chart) => chart.id === list.activeId) ?? list.charts[0];

  // The charts as the tab last left them, taken once it has mounted and filled its defaults in, so
  // a change is told from the state before it.
  const baseline = useRef<WorkspacePlottingCharts | null>(null);
  // The last step's one field and the input it was made in: further changes to that field from
  // the same input (typing, its spinner, a slider dragged) stay in that step.
  const lastStep = useRef<{ field: string; input: Element } | null>(null);
  useEffect(() => {
    baseline.current = plottingCharts();
    lastStep.current = null;
  }, [epoch, list.activeId]);
  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      if (lastStep.current?.input === event.target) lastStep.current = null;
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

  const syncHistory = () => {
    const undo = canUndoPlotting(), redo = canRedoPlotting();
    setHistory((current) => (current.undo === undo && current.redo === redo ? current : { undo, redo }));
  };

  const onSettingsChange = () => {
    onConfigChange?.();
    const before = baseline.current;
    if (!before) return;
    const now = plottingCharts();
    const fields = changedFields(before, now);
    if (fields && fields.length === 0) return;
    const input = typingField(document.activeElement);
    const field = fields?.length === 1 ? fields[0] : null;
    const same = field !== null && input !== null && lastStep.current?.field === field && lastStep.current.input === input;
    if (!same) recordPlottingStep(before);
    lastStep.current = field !== null && input !== null ? { field, input } : null;
    baseline.current = now;
    syncHistory();
  };

  /** After the charts were replaced from here: show them, and mark the workspace changed if they were. */
  const shown = (changed: boolean) => {
    setEpoch((value) => value + 1);
    setListVersion((value) => value + 1);
    syncHistory();
    if (changed) onConfigChange?.();
  };
  const undo = () => { if (undoPlotting()) shown(true); };
  const redo = () => { if (redoPlotting()) shown(true); };
  const historyRef = useRef({ undo, redo });
  historyRef.current = { undo, redo };

  // Undo and redo belong to the charts while this tab is shown, as on the Layout tab: taken on the
  // window in the capture phase, before the app's own listener would undo the last gating edit. A
  // field keeps its own undo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = historyShortcutAction(event);
      if (!action) return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "undo") historyRef.current.undo();
      else historyRef.current.redo();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const newChart = () => {
    // A new chart uses the workspace's figure style.
    const chart = { id: crypto.randomUUID(), name: newPlottingChartName(list), plotting: { "prop.followFigureStyle": true } };
    changePlottingCharts({ activeId: chart.id, charts: [...list.charts, chart] });
    shown(true);
  };
  const duplicate = (id: string) => {
    const source = list.charts.find((chart) => chart.id === id);
    if (!source) return;
    const chart = { id: crypto.randomUUID(), name: uniquePlottingChartName(list, `${source.name} copy`), plotting: structuredClone(source.plotting) };
    const at = list.charts.findIndex((each) => each.id === id) + 1;
    changePlottingCharts({ activeId: chart.id, charts: [...list.charts.slice(0, at), chart, ...list.charts.slice(at)] });
    shown(true);
  };
  /** A change to the list that leaves the shown chart's settings as they are: the tab is not remounted. */
  const listChanged = (next: typeof list) => {
    changePlottingCharts(next);
    baseline.current = plottingCharts();
    lastStep.current = null;
    setListVersion((value) => value + 1);
    syncHistory();
    onConfigChange?.();
  };
  const rename = (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || list.charts.some((chart) => chart.id === id && chart.name === trimmed)) return;
    listChanged({ ...list, charts: list.charts.map((chart) => (chart.id === id ? { ...chart, name: trimmed } : chart)) });
  };
  const move = (id: string, to: number) => {
    const charts = movedSheetTabs(list.charts, id, to);
    if (charts.every((chart, i) => chart.id === list.charts[i].id)) return;
    listChanged({ ...list, charts });
  };
  const remove = (id: string) => {
    if (list.charts.length < 2) return;
    const index = list.charts.findIndex((chart) => chart.id === id);
    if (index < 0) return;
    const charts = list.charts.filter((chart) => chart.id !== id);
    // Another chart deleted: the shown one stays. The shown one deleted: the one before it is shown.
    if (id !== list.activeId) {
      listChanged({ ...list, charts });
      return;
    }
    changePlottingCharts({ activeId: charts[Math.max(0, index - 1)].id, charts });
    shown(true);
  };
  const select = (id: string) => {
    selectPlottingChart(id);
    shown(false);
  };

  return (
    <div className="gl-tab-panel gl-tab-fill gl-sheet-tabbed">
      <SheetTabs
        items={list.charts}
        activeId={active.id}
        label={t("Charts")}
        addTitle={t("New chart")}
        onSelect={select}
        onRename={rename}
        onMove={move}
        onAdd={newChart}
        onDuplicate={duplicate}
        onDelete={remove}
      >
        <button type="button" className="gl-mini-btn" disabled={!history.undo} title={t("Undo the last Plotting change (Cmd-Z)")} onClick={undo}>
          {t("Undo")}
        </button>
        <button type="button" className="gl-mini-btn" disabled={!history.redo} title={t("Redo the undone edit (Shift-Cmd-Z)")} onClick={redo}>
          {t("Redo")}
        </button>
      </SheetTabs>
      <PlottingTab {...props} key={`${list.activeId}:${epoch}`} onConfigChange={onSettingsChange} />
    </div>
  );
}
