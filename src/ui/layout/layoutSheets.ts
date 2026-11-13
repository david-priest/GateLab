// layoutSheets.ts — the Layout tab's sheet tabs: dragged left or right to reorder the sheets, and
// a menu (right-click) to move, rename, duplicate or delete one. The sheets' order is the order of
// the workspace's sheets; every change here is one undo step, as LayoutTab's mutate makes it.

import { useRef, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { copyLayoutItems, type LayoutSheet, type LayoutWorkspace } from "../../engine/layout";
import type { ContextMenuState } from "../ContextMenu";
import type { MenuEntry } from "../MenuButton";
import { useI18n } from "../i18n";
import "./layoutNavigation.css";

/** Moves the sheet to `to`, its index once moved. False when nothing changed. */
export function moveSheet(draft: LayoutWorkspace, id: string, to: number): boolean {
  const from = draft.sheets.findIndex((sheet) => sheet.id === id);
  const target = Math.max(0, Math.min(draft.sheets.length - 1, to));
  if (from < 0 || from === target) return false;
  const [sheet] = draft.sheets.splice(from, 1);
  draft.sheets.splice(target, 0, sheet);
  return true;
}

/** Where a sheet dropped on another's tab lands: before it or after it, as an index once moved. */
export function dropIndex(sheets: readonly LayoutSheet[], id: string, onto: string, side: "before" | "after"): number {
  const from = sheets.findIndex((sheet) => sheet.id === id);
  const at = sheets.findIndex((sheet) => sheet.id === onto) + (side === "after" ? 1 : 0);
  return at > from ? at - 1 : at;
}

/** A copy of the sheet, with its page and items, after the last sheet and shown: what "Duplicate sheet" does. */
export function duplicateSheet(draft: LayoutWorkspace, id: string): void {
  const sheet = draft.sheets.find((candidate) => candidate.id === id);
  if (!sheet) return;
  const copy: LayoutSheet = {
    ...sheet,
    id: crypto.randomUUID(),
    page: { ...sheet.page },
    ...(sheet.iteration ? { iteration: structuredClone(sheet.iteration) } : {}),
    name: `${sheet.name} copy`,
    // Headings that read from a plot read the copy's plot, not the original sheet's.
    items: copyLayoutItems(sheet.items).copies,
  };
  draft.sheets.push(copy);
  draft.activeSheetId = copy.id;
}

/** Removes the sheet, keeping at least one; a removed sheet that was shown gives way to the one before it. */
export function deleteSheet(draft: LayoutWorkspace, id: string): void {
  if (draft.sheets.length <= 1) return;
  const index = draft.sheets.findIndex((sheet) => sheet.id === id);
  if (index < 0) return;
  draft.sheets.splice(index, 1);
  if (draft.activeSheetId === id) draft.activeSheetId = draft.sheets[Math.max(0, index - 1)].id;
}

interface SheetTabOptions {
  workspace: LayoutWorkspace;
  mutate: (change: (draft: LayoutWorkspace) => void) => void;
  rename: (id: string) => void;
  openMenu: (menu: ContextMenuState) => void;
  clearSelection: () => void;
}

/** What each sheet's tab button takes: drag to reorder, and the menu. */
export function useLayoutSheetTabs({ workspace, mutate, rename, openMenu, clearSelection }: SheetTabOptions) {
  const { t } = useI18n();
  const dragged = useRef<string | null>(null);
  const move = (id: string, to: number) => {
    const probe = { ...workspace, sheets: [...workspace.sheets] };
    if (!moveSheet(probe, id, to)) return;
    mutate((draft) => { moveSheet(draft, id, to); });
  };
  const sideOf = (event: ReactDragEvent<HTMLElement>): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
  };
  const menuFor = (id: string): MenuEntry[] => {
    const index = workspace.sheets.findIndex((sheet) => sheet.id === id);
    const last = workspace.sheets.length - 1;
    return [
      { label: t("Move left"), disabled: index <= 0, onClick: () => move(id, index - 1) },
      { label: t("Move right"), disabled: index >= last, onClick: () => move(id, index + 1) },
      "separator",
      { label: t("Rename"), onClick: () => rename(id) },
      { label: t("Duplicate"), onClick: () => { mutate((draft) => duplicateSheet(draft, id)); clearSelection(); } },
      { label: t("Delete"), disabled: workspace.sheets.length <= 1, onClick: () => { mutate((draft) => deleteSheet(draft, id)); clearSelection(); } },
    ];
  };
  const tabProps = (id: string) => ({
    draggable: true,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      dragged.current = id;
      event.dataTransfer?.setData("text/plain", id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!dragged.current || dragged.current === id) return;
      event.preventDefault();
      event.currentTarget.dataset.drop = sideOf(event);
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => { delete event.currentTarget.dataset.drop; },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const from = dragged.current;
      delete event.currentTarget.dataset.drop;
      dragged.current = null;
      if (!from || from === id) return;
      event.preventDefault();
      move(from, dropIndex(workspace.sheets, from, id, sideOf(event)));
    },
    onDragEnd: () => { dragged.current = null; },
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      const name = workspace.sheets.find((sheet) => sheet.id === id)?.name ?? "";
      openMenu({ x: event.clientX, y: event.clientY, items: menuFor(id), label: name });
    },
  });
  return { tabProps, menuFor };
}
