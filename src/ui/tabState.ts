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

const store: Record<string, unknown> = {};

/** useState, but the value survives this tab unmounting/remounting (keyed by `key`, session-scoped). */
export function usePersistedTabState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    key in store ? (store[key] as T) : typeof initial === "function" ? (initial as () => T)() : initial,
  );
  useEffect(() => {
    store[key] = value;
  }, [key, value]);
  return [value, setValue];
}

/** Drop persisted tab state (e.g. when a fresh workspace is opened, so stale selections don't leak). */
export function clearPersistedTabState(): void {
  for (const k of Object.keys(store)) delete store[k];
}
