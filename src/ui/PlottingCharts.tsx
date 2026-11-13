// PlottingCharts.tsx — the Plotting tab's named charts: a picker with New chart, Duplicate, Rename
// and Delete at the top of the side panel, and Undo and Redo, as the Illustration tab has beside
// its figure's name. The charts and their history are held in tabState.ts, so they outlive the
// tab's unmounting and are saved with the workspace; the tab itself is remounted to show another
// chart or an undone state, since it reads its settings when it mounts.

import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { WorkspacePlottingCharts } from "../engine/workspace";
import { historyShortcutAction } from "./historyShortcuts";
import { useI18n } from "./i18n";
import { PlottingTab } from "./PlottingTab";
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

type Props = Omit<ComponentProps<typeof PlottingTab>, "chartBar">;

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
  const [renaming, setRenaming] = useState(false);
  const renameCancelled = useRef(false);
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
  const duplicate = () => {
    const chart = { id: crypto.randomUUID(), name: uniquePlottingChartName(list, `${active.name} copy`), plotting: structuredClone(active.plotting) };
    const at = list.charts.findIndex(({ id }) => id === active.id) + 1;
    changePlottingCharts({ activeId: chart.id, charts: [...list.charts.slice(0, at), chart, ...list.charts.slice(at)] });
    shown(true);
  };
  const rename = (name: string) => {
    setRenaming(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === active.name) return;
    changePlottingCharts({ ...list, charts: list.charts.map((chart) => (chart.id === active.id ? { ...chart, name: trimmed } : chart)) });
    // The shown chart's settings are unchanged: the tab is not remounted.
    baseline.current = plottingCharts();
    lastStep.current = null;
    setListVersion((value) => value + 1);
    syncHistory();
    onConfigChange?.();
  };
  const remove = () => {
    if (list.charts.length < 2) return;
    const index = list.charts.findIndex(({ id }) => id === active.id);
    const charts = list.charts.filter(({ id }) => id !== active.id);
    changePlottingCharts({ activeId: charts[Math.min(index, charts.length - 1)].id, charts });
    shown(true);
  };
  const select = (id: string) => {
    selectPlottingChart(id);
    shown(false);
  };

  const chartBar = (
    <section className="gl-plotting-charts" aria-label={t("Charts")}>
      <div className="gl-plotting-actions">
        {renaming ? (
          <input
            className="gl-plotting-chart-name"
            aria-label={t("Chart name")}
            defaultValue={active.name}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              if (renameCancelled.current) {
                renameCancelled.current = false;
                setRenaming(false);
                return;
              }
              rename(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                renameCancelled.current = true;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <select
            aria-label={t("Chart")}
            title={t("The charts in this workspace, each with its own settings")}
            value={active.id}
            onChange={(event) => select(event.target.value)}
          >
            {list.charts.map((chart) => (
              <option key={chart.id} value={chart.id}>{chart.name}</option>
            ))}
          </select>
        )}
      </div>
      <div className="gl-plotting-actions">
        <button type="button" className="gl-mini-btn" title={t("A new chart with the default settings")} onClick={newChart}>
          {t("New chart")}
        </button>
        <button type="button" className="gl-mini-btn" title={t("A copy of this chart as a new chart")} onClick={duplicate}>
          {t("Duplicate")}
        </button>
        <button type="button" className="gl-mini-btn" disabled={renaming} title={t("Rename this chart")} onClick={() => setRenaming(true)}>
          {t("Rename")}
        </button>
        <button
          type="button"
          className="gl-mini-btn"
          disabled={list.charts.length < 2}
          title={list.charts.length < 2 ? t("The last chart cannot be deleted") : t("Delete this chart")}
          onClick={remove}
        >
          {t("Delete")}
        </button>
      </div>
      <div className="gl-plotting-actions">
        <button type="button" className="gl-mini-btn" disabled={!history.undo} title={t("Undo the last Plotting change (Cmd-Z)")} onClick={undo}>
          {t("Undo")}
        </button>
        <button type="button" className="gl-mini-btn" disabled={!history.redo} title={t("Redo the undone edit (Shift-Cmd-Z)")} onClick={redo}>
          {t("Redo")}
        </button>
      </div>
    </section>
  );

  return <PlottingTab {...props} key={`${list.activeId}:${epoch}`} onConfigChange={onSettingsChange} chartBar={chartBar} />;
}
