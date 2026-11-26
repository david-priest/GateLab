// Strategies.tsx — the Strategy tab's named strategies: a tab each across the top, as the Plotting
// tab shows its charts and the Illustration tab its plots (SheetTabs.tsx: click to show,
// double-click to rename, drag to reorder, right-click to move, rename, duplicate or delete, + for
// a new strategy), with Undo and Redo at the strip's right end. Each strategy keeps its own
// controls: the populations it traces, its layout and its look. The files drawn are the tab's, as
// before: the file viewed app-wide, or the tab's pool.
//
// The set is held here while the tab is shown and written into the App-held Strategy record after
// every change (strategySet.ts), so it outlives the tab's unmounting and is saved with the
// workspace; the history is the session's. StrategyTab is remounted to show another strategy or
// an undone state, since it reads its controls when it mounts.

import { useEffect, useMemo, useRef, useState, type ComponentProps, type MutableRefObject } from "react";
import { historyShortcutAction } from "./historyShortcuts";
import { useI18n } from "./i18n";
import { movedSheetTabs, nextSheetTabName, SheetTabs, uniqueSheetTabName } from "./SheetTabs";
import { StrategyTab, type StrategyConfig } from "./StrategyTab";
import {
  changedStrategyFields,
  recordedStrategyStep,
  redoneStrategyStep,
  seenPopulationOf,
  strategyRecordFromSet,
  strategySetFromRecord,
  undoneStrategyStep,
  type NamedStrategy,
  type StrategyHistory,
  type StrategySet,
} from "./strategySet";
import { usePersistedTabState } from "./tabState";

type Props = Omit<ComponentProps<typeof StrategyTab>, "ownPopulation">;

/** A field a value is typed or dragged in: a number, text or slider input, not a box or a button. */
function typingField(element: Element | null): Element | null {
  return element instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "file", "color"].includes(element.type)
    ? element
    : null;
}

export function StrategiesTab(props: Props) {
  const { t } = useI18n();
  const { configRef, onConfigChange, state } = props;
  const [set, setSet] = useState<StrategySet>(() => strategySetFromRecord(configRef.current));
  // Bumped when the tab must show controls it did not set: an undone or redone state.
  const [epoch, setEpoch] = useState(0);
  const [history, setHistory] = usePersistedTabState<StrategyHistory>("strategy.history", { undo: [], redo: [] });
  const active = set.strategies.find((strategy) => strategy.id === set.activeId) ?? set.strategies[0];
  const shownKey = `${active.id}:${epoch}`;
  // The shown strategy's controls: what StrategyTab reads as it mounts, and mirrors after every render.
  const shownRef = useMemo<MutableRefObject<StrategyConfig | null>>(
    () => ({ current: active.config }),
    // A new ref for each mount of the tab, holding the controls that mount starts from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownKey],
  );
  /** The set, the shown strategy's controls as the tab holds them now. */
  const live = (): StrategySet => ({
    activeId: active.id,
    strategies: set.strategies.map((strategy) => (strategy.id === active.id ? { ...strategy, config: shownRef.current ?? strategy.config } : strategy)),
  });

  // The tree's selection when the tab was last shown: a strategy shown while it is unchanged opens
  // on its own population. Undefined for a record that does not say, which follows the selection
  // as the tab did before it had tabs.
  const seenPopulation = useRef<string | null | undefined>(seenPopulationOf(configRef.current));
  const ownPopulation = seenPopulation.current === state.active_population_id;
  const publish = () => {
    configRef.current = strategyRecordFromSet(live(), seenPopulation.current) ?? configRef.current;
  };
  useEffect(() => {
    seenPopulation.current = state.active_population_id;
    publish();
  });

  // The set as the tab last left it, taken once the shown strategy has mounted and filled its
  // defaults in, so a change is told from the state before it.
  const baseline = useRef<{ key: string; set: StrategySet } | null>(null);
  // The last step's one control and the input it was set in: further changes to that control from
  // the same input (typing, its spinner, a slider dragged) stay in that step.
  const lastStep = useRef<{ field: string; input: Element } | null>(null);
  useEffect(() => {
    baseline.current = { key: shownKey, set: live() };
    lastStep.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);
  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      if (lastStep.current?.input === event.target) lastStep.current = null;
    };
    document.addEventListener("focusout", onFocusOut);
    return () => document.removeEventListener("focusout", onFocusOut);
  }, []);

  /** The shown strategy's controls changed in the tab: one undo step, and the workspace has changed. */
  const onSettingsChange = () => {
    publish();
    // The tab filling its controls in as it mounts is not a change.
    const before = baseline.current;
    if (!before || before.key !== shownKey) return;
    const now = live();
    const fields = changedStrategyFields(before.set, now);
    if (!fields || fields.length === 0) return;
    const input = typingField(document.activeElement);
    const field = fields.length === 1 ? fields[0] : null;
    const same = field !== null && input !== null && lastStep.current?.field === field && lastStep.current.input === input;
    if (!same) setHistory((current) => recordedStrategyStep(current, before.set));
    lastStep.current = field !== null && input !== null ? { field, input } : null;
    baseline.current = { key: shownKey, set: now };
    onConfigChange?.();
  };

  /** Replace the set from here as one undo step: a strategy added, duplicated, renamed, moved or deleted. */
  const change = (next: StrategySet) => {
    const before = live();
    setHistory((current) => recordedStrategyStep(current, before));
    setSet(next);
    // The shown strategy stays mounted through a rename or a move: its baseline takes the new list.
    if (next.activeId === active.id) baseline.current = { key: shownKey, set: next };
    lastStep.current = null;
    onConfigChange?.();
  };
  const undo = () => {
    const step = undoneStrategyStep(history, live());
    if (!step) return;
    setHistory(step.history);
    setSet(step.set);
    setEpoch((value) => value + 1);
    onConfigChange?.();
  };
  const redo = () => {
    const step = redoneStrategyStep(history, live());
    if (!step) return;
    setHistory(step.history);
    setSet(step.set);
    setEpoch((value) => value + 1);
    onConfigChange?.();
  };
  const historyRef = useRef({ undo, redo });
  historyRef.current = { undo, redo };

  // Undo and redo belong to the strategies while this tab is shown, as on the Plotting and Layout
  // tabs: taken on the window in the capture phase, before the app's own listener would undo the
  // last gating edit. A field keeps its own undo.
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

  const add = () => {
    const now = live();
    // A new strategy opens on the tab's defaults and the tree's selection.
    const strategy: NamedStrategy = { id: crypto.randomUUID(), name: nextSheetTabName(now.strategies, "Strategy"), config: null };
    change({ activeId: strategy.id, strategies: [...now.strategies, strategy] });
  };
  const duplicate = (id: string) => {
    const now = live();
    const at = now.strategies.findIndex((strategy) => strategy.id === id);
    const source = now.strategies[at];
    if (!source) return;
    const copy: NamedStrategy = { id: crypto.randomUUID(), name: uniqueSheetTabName(now.strategies, `${source.name} copy`), config: structuredClone(source.config) };
    change({ activeId: copy.id, strategies: [...now.strategies.slice(0, at + 1), copy, ...now.strategies.slice(at + 1)] });
  };
  const rename = (id: string, name: string) => {
    const now = live();
    const trimmed = name.trim();
    if (!trimmed || now.strategies.some((strategy) => strategy.id === id && strategy.name === trimmed)) return;
    change({ ...now, strategies: now.strategies.map((strategy) => (strategy.id === id ? { ...strategy, name: trimmed } : strategy)) });
  };
  const move = (id: string, to: number) => {
    const now = live();
    const strategies = movedSheetTabs(now.strategies, id, to);
    if (strategies.every((strategy, i) => strategy.id === now.strategies[i].id)) return;
    change({ ...now, strategies });
  };
  const remove = (id: string) => {
    const now = live();
    if (now.strategies.length < 2) return;
    const index = now.strategies.findIndex((strategy) => strategy.id === id);
    if (index < 0) return;
    const strategies = now.strategies.filter((strategy) => strategy.id !== id);
    // Another strategy deleted: the shown one stays. The shown one deleted: the one before it is shown.
    change({ activeId: id === now.activeId ? strategies[Math.max(0, index - 1)].id : now.activeId, strategies });
  };
  /** Show another strategy. Not an undo step, and not a change to the workspace. */
  const select = (id: string) => {
    const now = live();
    if (id === now.activeId || !now.strategies.some((strategy) => strategy.id === id)) return;
    setSet({ ...now, activeId: id });
    lastStep.current = null;
  };

  return (
    <div className="gl-tab-panel gl-tab-fill gl-sheet-tabbed">
      <SheetTabs
        items={set.strategies}
        activeId={active.id}
        label={t("Strategies")}
        addTitle={t("New strategy")}
        onSelect={select}
        onRename={rename}
        onMove={move}
        onAdd={add}
        onDuplicate={duplicate}
        onDelete={remove}
      >
        <button type="button" className="gl-mini-btn" disabled={!history.undo.length} title={t("Undo the last Strategy change (Cmd-Z)")} onClick={undo}>
          {t("Undo")}
        </button>
        <button type="button" className="gl-mini-btn" disabled={!history.redo.length} title={t("Redo the undone edit (Shift-Cmd-Z)")} onClick={redo}>
          {t("Redo")}
        </button>
      </SheetTabs>
      <StrategyTab {...props} key={shownKey} configRef={shownRef} ownPopulation={ownPopulation} onConfigChange={onSettingsChange} />
    </div>
  );
}
