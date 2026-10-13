// cellHoverStore.ts — the cell under the cursor, kept outside React state on purpose. The
// gating plot's hover changes many times a second, and App.tsx is a large component: holding
// the hovered cell in its state re-rendered the whole app on every change (measured at about
// 300 ms from pointer to panel). With a store, only the panels that subscribe re-render.

export interface HoveredCell {
  readonly sampleId: string;
  readonly eventIndex: number;
}

export interface CellHoverStore {
  get(): HoveredCell | null;
  set(value: HoveredCell | null): void;
  subscribe(listener: () => void): () => void;
}

const same = (a: HoveredCell | null, b: HoveredCell | null): boolean =>
  a === b || (a !== null && b !== null && a.sampleId === b.sampleId && a.eventIndex === b.eventIndex);

export function createCellHoverStore(): CellHoverStore {
  let value: HoveredCell | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (same(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
