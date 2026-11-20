// SheetTabs.tsx — a strip of tabs, one per figure or chart, as the Layout tab shows its sheets:
// click to show one, double-click to rename it, drag it left or right to reorder, right-click for
// Move left, Move right, Rename, Duplicate and Delete, and + for a new one. It draws with the
// Layout sheet tabs' classes, so the three tabs look alike; what each action does to the list is
// the caller's (each is one undo step there).

import { useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { MenuEntry } from "./MenuButton";
import { useI18n } from "./i18n";
import "./layout/layoutNavigation.css";

export interface SheetTabItem {
  id: string;
  name: string;
}

interface Props {
  items: readonly SheetTabItem[];
  activeId: string;
  /** The tab list's accessible name, such as "Figures". */
  label: string;
  /** The + button's tooltip, such as "New figure". */
  addTitle: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /** Move the tab to `to`, its index once moved. */
  onMove: (id: string, to: number) => void;
  onAdd: () => void;
  onDuplicate: (id: string) => void;
  /** Not offered for the last tab. */
  onDelete: (id: string) => void;
  /** Drawn at the strip's right end, such as Undo and Redo. */
  children?: ReactNode;
  /** No tab changes while true (an export running). */
  disabled?: boolean;
}

/** Where a tab dropped on another's lands: before it or after it, as an index once moved. */
export function sheetTabDropIndex(items: readonly SheetTabItem[], id: string, onto: string, side: "before" | "after"): number {
  const from = items.findIndex((item) => item.id === id);
  const at = items.findIndex((item) => item.id === onto) + (side === "after" ? 1 : 0);
  return at > from ? at - 1 : at;
}

/** The list with `id` moved to `to`, its index once moved; the same list when nothing moves. */
export function movedSheetTabs<T extends { id: string }>(items: readonly T[], id: string, to: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (from < 0 || from === target) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** `name`, or `name (2)`, `name (3)`, … when another tab already has it. */
export function uniqueSheetTabName(items: readonly SheetTabItem[], name: string): string {
  const taken = new Set(items.map((item) => item.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/** "`prefix` N", numbered on from the tabs there are. */
export function nextSheetTabName(items: readonly SheetTabItem[], prefix: string): string {
  const taken = new Set(items.map((item) => item.name));
  let n = items.length + 1;
  while (taken.has(`${prefix} ${n}`)) n += 1;
  return `${prefix} ${n}`;
}

export function SheetTabs({ items, activeId, label, addTitle, onSelect, onRename, onMove, onAdd, onDuplicate, onDelete, children, disabled = false }: Props) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const dragged = useRef<string | null>(null);
  const cancelled = useRef(false);
  const sideOf = (event: ReactDragEvent<HTMLElement>): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
  };
  const menuFor = (id: string): MenuEntry[] => {
    const index = items.findIndex((item) => item.id === id);
    return [
      { label: t("Move left"), disabled: index <= 0, onClick: () => onMove(id, index - 1) },
      { label: t("Move right"), disabled: index >= items.length - 1, onClick: () => onMove(id, index + 1) },
      "separator",
      { label: t("Rename"), onClick: () => setRenaming(id) },
      { label: t("Duplicate"), onClick: () => onDuplicate(id) },
      { label: t("Delete"), disabled: items.length <= 1, onClick: () => onDelete(id) },
    ];
  };
  return (
    <div className="gl-layout-sheet-tabs gl-sheet-tabs" {...(disabled ? { inert: "" } : {})}>
      <div className="gl-sheet-tabs-list" role="tablist" aria-label={label}>
        {items.map((item) => (
          <div key={item.id} className="gl-layout-sheet-tab-wrap">
            {renaming === item.id ? (
              <input
                className="gl-layout-sheet-rename"
                aria-label={t("Name")}
                defaultValue={item.name}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  setRenaming(null);
                  if (cancelled.current) {
                    cancelled.current = false;
                    return;
                  }
                  if (name && name !== item.name) onRename(item.id, name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    cancelled.current = true;
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={item.id === activeId}
                className={`gl-layout-sheet-tab${item.id === activeId ? " active" : ""}`}
                title={t("Drag to reorder; double-click to rename; right-click for more")}
                draggable
                onClick={() => {
                  if (item.id !== activeId) onSelect(item.id);
                }}
                onDoubleClick={() => setRenaming(item.id)}
                onDragStart={(event) => {
                  dragged.current = item.id;
                  event.dataTransfer?.setData("text/plain", item.id);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (!dragged.current || dragged.current === item.id) return;
                  event.preventDefault();
                  event.currentTarget.dataset.drop = sideOf(event);
                }}
                onDragLeave={(event) => {
                  delete event.currentTarget.dataset.drop;
                }}
                onDrop={(event) => {
                  const from = dragged.current;
                  delete event.currentTarget.dataset.drop;
                  dragged.current = null;
                  if (!from || from === item.id) return;
                  event.preventDefault();
                  onMove(from, sheetTabDropIndex(items, from, item.id, sideOf(event)));
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, items: menuFor(item.id), label: item.name });
                }}
              >
                {item.name}
              </button>
            )}
          </div>
        ))}
        <button type="button" className="gl-layout-sheet-add" title={addTitle} aria-label={addTitle} onClick={onAdd}>
          +
        </button>
      </div>
      {children && <div className="gl-sheet-tabs-end">{children}</div>}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
