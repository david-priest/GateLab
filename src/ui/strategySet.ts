// strategySet.ts — the Strategy tab's named strategies, a tab each across the top (Strategies.tsx),
// as the Plotting tab keeps its charts and the Illustration tab its plots.
//
// The workspace holds one Strategy record (engine/workspace.ts's `strategy`, written whole and read
// back as written). The shown strategy's controls stay that record's own fields, so every reader of
// it (the agent's view, the tutorial, a GateLab from before the tabs) reads the shown strategy; the
// list rides beside them as `strategies`, each other strategy with its own controls. A workspace
// saved before the tabs has no list and opens as one strategy.

import type { StrategyConfig as SavedStrategyConfig } from "../engine/workspace";

/** One strategy's controls: the Strategy tab's config without the list. */
export type StrategySettings = SavedStrategyConfig & { exportTree?: boolean };

export interface NamedStrategy {
  id: string;
  name: string;
  /** Its controls as last left; null for a strategy not shown yet, which opens on the tab's defaults. */
  config: StrategySettings | null;
}

export interface StrategySet {
  activeId: string;
  strategies: NamedStrategy[];
}

/** The list as the workspace's Strategy record carries it. */
export interface SavedStrategyList {
  activeId: string;
  /** In tab order. The shown strategy has no config here: its controls are the record's own fields. */
  items: { id: string; name: string; config?: StrategySettings }[];
  /**
   * The tree's selection when the tab was last shown. A single-population strategy opens on its
   * own population unless the selection has changed since (StrategyTab's ownPopulation).
   */
  seenPopulationId?: string | null;
}

/** The Strategy record: the shown strategy's controls, and the list once there is one. */
export type StrategyRecord = StrategySettings & { strategies?: SavedStrategyList };

/** The one strategy of a workspace saved before the tabs, and of a new workspace. */
export const FIRST_STRATEGY = { id: "strategy-1", name: "Strategy 1" } as const;

/** Undo and redo hold whole sets, at most this many steps each, as the Plotting tab holds its charts. */
export const STRATEGY_HISTORY_LIMIT = 30;

export interface StrategyHistory {
  undo: StrategySet[];
  redo: StrategySet[];
}

/**
 * The gates' look is the workspace's (gateInk.ts): a config writes these three but the tab no
 * longer reads them, so a change to one is not a step of the strategy's own history.
 */
const WORKSPACE_INK_FIELDS = new Set(["pubStyle", "gateLineWidth", "labelBackground"]);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function settingsOf(record: StrategyRecord): StrategySettings {
  const { strategies: _list, ...settings } = record;
  return settings;
}

/** The list a record carries, when it is one this version can show; null otherwise. */
function savedList(record: StrategyRecord | null): SavedStrategyList | null {
  const list: unknown = record?.strategies;
  if (!isRecord(list) || typeof list.activeId !== "string" || !Array.isArray(list.items)) return null;
  const items = list.items.filter((item): item is SavedStrategyList["items"][number] =>
    isRecord(item) && typeof item.id === "string" && !!item.id && typeof item.name === "string" && (item.config === undefined || isRecord(item.config)));
  const ids = new Set(items.map((item) => item.id));
  if (!items.length || items.length !== list.items.length || ids.size !== items.length || !ids.has(list.activeId)) return null;
  const seen = list.seenPopulationId;
  return { activeId: list.activeId, items, ...(typeof seen === "string" || seen === null ? { seenPopulationId: seen } : {}) };
}

/** The strategies a Strategy record holds: its list, or the record itself as the one strategy. */
export function strategySetFromRecord(record: StrategyRecord | null): StrategySet {
  const list = savedList(record);
  if (!record || !list) {
    return { activeId: FIRST_STRATEGY.id, strategies: [{ ...FIRST_STRATEGY, config: record ? settingsOf(record) : null }] };
  }
  const shown = settingsOf(record);
  return {
    activeId: list.activeId,
    strategies: list.items.map((item) => ({ id: item.id, name: item.name, config: item.id === list.activeId ? shown : item.config ?? null })),
  };
}

/** The tree's selection a record says the tab last saw; undefined when it does not say. */
export function seenPopulationOf(record: StrategyRecord | null): string | null | undefined {
  return savedList(record)?.seenPopulationId;
}

/**
 * The set as the workspace's Strategy record. Null while the shown strategy has no controls yet:
 * the tab fills them in as it mounts, before anything can read the record.
 */
export function strategyRecordFromSet(set: StrategySet, seenPopulationId: string | null | undefined): StrategyRecord | null {
  const shown = set.strategies.find((strategy) => strategy.id === set.activeId)?.config;
  if (!shown) return null;
  return {
    ...shown,
    strategies: {
      activeId: set.activeId,
      items: set.strategies.map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
        ...(strategy.id !== set.activeId && strategy.config ? { config: strategy.config } : {}),
      })),
      ...(seenPopulationId === undefined ? {} : { seenPopulationId }),
    },
  };
}

/**
 * The controls of the shown strategy whose values differ between two sets of the same strategies,
 * the workspace's gate look left out; null when the strategies themselves differ.
 */
export function changedStrategyFields(before: StrategySet, after: StrategySet): string[] | null {
  if (before.activeId !== after.activeId || before.strategies.length !== after.strategies.length) return null;
  if (before.strategies.some((strategy, i) => strategy.id !== after.strategies[i].id || strategy.name !== after.strategies[i].name)) return null;
  const controls = (set: StrategySet): Record<string, unknown> => ({ ...set.strategies.find((strategy) => strategy.id === set.activeId)?.config });
  const a = controls(before), b = controls(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !WORKSPACE_INK_FIELDS.has(key) && JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/** History with `before` kept as one undo step; the redo steps are dropped. */
export function recordedStrategyStep(history: StrategyHistory, before: StrategySet): StrategyHistory {
  return { undo: [...history.undo, structuredClone(before)].slice(-STRATEGY_HISTORY_LIMIT), redo: [] };
}

/** One step back from `current`: the set to show and the history then; null when there is nothing to undo. */
export function undoneStrategyStep(history: StrategyHistory, current: StrategySet): { set: StrategySet; history: StrategyHistory } | null {
  const previous = history.undo.at(-1);
  if (!previous) return null;
  return {
    set: structuredClone(previous),
    history: { undo: history.undo.slice(0, -1), redo: [structuredClone(current), ...history.redo].slice(0, STRATEGY_HISTORY_LIMIT) },
  };
}

/** One undone step forward again; null when there is nothing to redo. */
export function redoneStrategyStep(history: StrategyHistory, current: StrategySet): { set: StrategySet; history: StrategyHistory } | null {
  const next = history.redo[0];
  if (!next) return null;
  return {
    set: structuredClone(next),
    history: { undo: [...history.undo, structuredClone(current)].slice(-STRATEGY_HISTORY_LIMIT), redo: history.redo.slice(1) },
  };
}
