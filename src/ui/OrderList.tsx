// OrderList.tsx — a list whose order the user sets by dragging, several rows at a time. Rows are
// chosen as files are in a finder: a click chooses one, Cmd or Ctrl adds or removes, Shift takes
// the range from the last plain click. Dragging any chosen row moves the whole choice to where it
// is dropped; the arrow buttons step it by one; a sort button orders everything at once.

import { useRef, useState, type DragEvent, type MouseEvent } from "react";

export interface OrderSort<T> {
  label: string;
  title?: string;
  apply: (items: readonly T[]) => T[];
}

interface Props<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  onReorder: (items: T[]) => void;
  /** The list's accessible name, e.g. "Population order". */
  label: string;
  sorts?: readonly OrderSort<T>[];
}

/** The chosen items moved, in their order, to sit before the item at `index` (or at the end). */
export function moveChosenTo<T>(items: readonly T[], chosen: ReadonlySet<string>, keyOf: (item: T) => string, index: number): T[] {
  const picked = items.filter((item) => chosen.has(keyOf(item)));
  if (!picked.length) return [...items];
  const before = items.slice(0, index).filter((item) => !chosen.has(keyOf(item)));
  const after = items.slice(index).filter((item) => !chosen.has(keyOf(item)));
  return [...before, ...picked, ...after];
}

/** The chosen items stepped one place up or down, each past an unchosen neighbour; a run of them moves as one. */
export function stepChosen<T>(items: readonly T[], chosen: ReadonlySet<string>, keyOf: (item: T) => string, direction: -1 | 1): T[] {
  const out = [...items];
  const isChosen = (i: number) => i >= 0 && i < out.length && chosen.has(keyOf(out[i]));
  if (direction < 0) {
    for (let i = 1; i < out.length; i++) if (isChosen(i) && !isChosen(i - 1)) [out[i - 1], out[i]] = [out[i], out[i - 1]];
  } else {
    for (let i = out.length - 2; i >= 0; i--) if (isChosen(i) && !isChosen(i + 1)) [out[i + 1], out[i]] = [out[i], out[i + 1]];
  }
  return out;
}

export function OrderList<T>({ items, keyOf, labelOf, onReorder, label, sorts }: Props<T>) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const keys = items.map(keyOf);
  const live = new Set(keys.filter((key) => chosen.has(key)));

  const choose = (key: string, event: MouseEvent) => {
    setChosen((current) => {
      const next = new Set([...current].filter((k) => keys.includes(k)));
      if (event.shiftKey && anchor.current && keys.includes(anchor.current)) {
        const [a, b] = [keys.indexOf(anchor.current), keys.indexOf(key)].sort((x, y) => x - y);
        if (!event.metaKey && !event.ctrlKey) next.clear();
        for (const k of keys.slice(a, b + 1)) next.add(k);
        return next;
      }
      if (event.metaKey || event.ctrlKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else if (next.size === 1 && next.has(key)) {
        next.clear();
      } else {
        next.clear();
        next.add(key);
      }
      return next;
    });
    if (!event.shiftKey) anchor.current = key;
  };

  const dragStart = (key: string, event: DragEvent) => {
    // Dragging a row that was not chosen drags that row alone.
    if (!live.has(key)) {
      setChosen(new Set([key]));
      anchor.current = key;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };
  const dragOver = (index: number, event: DragEvent) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const below = event.clientY - rect.top > rect.height / 2;
    setDropAt(below ? index + 1 : index);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const target = dropAt;
    setDropAt(null);
    if (target === null) return;
    const moved = live.size ? live : new Set([event.dataTransfer.getData("text/plain")]);
    onReorder(moveChosenTo(items, moved, keyOf, target));
  };

  return (
    <div className="gl-order-list">
      <div className="gl-order-list-actions">
        <button
          type="button"
          aria-label={`Move the chosen ${label.toLowerCase()} earlier`}
          title="Move the chosen rows up one"
          disabled={!live.size}
          onClick={() => onReorder(stepChosen(items, live, keyOf, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move the chosen ${label.toLowerCase()} later`}
          title="Move the chosen rows down one"
          disabled={!live.size}
          onClick={() => onReorder(stepChosen(items, live, keyOf, 1))}
        >
          ↓
        </button>
        {sorts?.map((sort) => (
          <button key={sort.label} type="button" title={sort.title} onClick={() => onReorder(sort.apply(items))}>
            {sort.label}
          </button>
        ))}
        <span className="gl-order-list-hint">
          {live.size ? `${live.size} chosen · drag to move` : "Click to choose, drag to move"}
        </span>
      </div>
      <div
        role="listbox"
        aria-label={label}
        aria-multiselectable
        className="gl-order-list-rows"
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={drop}
        onDragOver={(event) => event.preventDefault()}
      >
        {items.map((item, index) => {
          const key = keyOf(item);
          return (
            <div
              key={key}
              role="option"
              aria-selected={live.has(key)}
              draggable
              className={
                "gl-order-row" +
                (live.has(key) ? " is-chosen" : "") +
                (dropAt === index ? " drop-before" : "") +
                (dropAt === index + 1 && index === items.length - 1 ? " drop-after" : "")
              }
              onClick={(event) => choose(key, event)}
              onDragStart={(event) => dragStart(key, event)}
              onDragOver={(event) => dragOver(index, event)}
              onDragEnd={() => setDropAt(null)}
            >
              <span className="gl-order-row-grip" aria-hidden="true">⋮⋮</span>
              <span className="gl-order-row-label">{labelOf(item)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
