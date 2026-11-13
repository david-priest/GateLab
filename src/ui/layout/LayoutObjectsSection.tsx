// LayoutObjectsSection.tsx — the Items tab's "Objects" fold: the active sheet's items in stacking
// order, top first, each with its kind, its name and buttons to hide or show and to lock or unlock
// it, the members of a group under a row for the group. A click selects an item on the page (Shift
// or Cmd adds or removes), so an item under another can be selected; a double-click renames it; a
// drag, or Move up and Move down in its menu, restacks it. Every change is one edit of the sheet,
// so one undo step.

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { LayoutItem, LayoutSheet } from "../../engine/layout";
import { FoldSummary } from "../FoldSummary";
import { MenuButton } from "../MenuButton";
import { ChevronIcon, LockIcon, MoreIcon } from "../icons";
import { useI18n } from "../i18n";
import {
  defaultObjectName,
  hiddenItemIds,
  moveObjects,
  objectEntries,
  objectKindWord,
  objectName,
  objectNaming,
  renameObject,
  setObjectsHidden,
  setObjectsLocked,
  stepObjects,
  type ObjectEntry,
} from "./layoutObjects";
import "./layoutObjects.css";

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" focusable="false">
      <path d="M1 6c1.6-2.8 3.6-4.2 6-4.2s4.4 1.4 6 4.2c-1.6 2.8-3.6 4.2-6 4.2S2.6 8.8 1 6z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {open ? <circle cx="7" cy="6" r="1.8" fill="currentColor" /> : <path d="M2 11 12 1" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}

interface Props {
  sheet: LayoutSheet;
  /** The selected items' ids (template ids). */
  selectedIds: readonly string[];
  /** The tab's prepared files, for the names of plots: their files' and populations' names. */
  samples: Parameters<typeof objectNaming>[0];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Select these items on the page, in place of the selection. */
  onSelect: (ids: string[]) => void;
  /** One edit of the active sheet: one undo step. */
  onChange: (change: (sheet: LayoutSheet) => void) => void;
}

/** Where a dragged row would land: before row `index` of its level (a group's members, or the top level). */
interface DropAt { index: number; within?: string }

export function LayoutObjectsSection({ sheet, selectedIds, samples, open, onOpenChange, onSelect, onChange }: Readonly<Props>) {
  const { t } = useI18n();
  const naming = useMemo(() => objectNaming(samples), [samples]);
  const entries = objectEntries(sheet);
  const hidden = hiddenItemIds(sheet);
  const selected = new Set(selectedIds);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const drag = useRef<{ keys: string[]; within?: string } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The page's selection is scrolled into view in the list.
  const firstSelected = selectedIds[0];
  useEffect(() => {
    if (!open || !firstSelected) return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-object-id]") ?? [])].find((el) => el.dataset.objectId === firstSelected);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [open, firstSelected]);

  /** A click: the item alone, or with Shift, Cmd or Ctrl added to or taken from the selection. */
  const choose = (ids: string[], event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      const all = ids.every((id) => selected.has(id));
      onSelect(all ? selectedIds.filter((id) => !ids.includes(id)) : [...selectedIds, ...ids.filter((id) => !selected.has(id))]);
    } else onSelect(ids);
  };
  /** Space: the item added to or taken from the selection. */
  const toggle = (ids: string[]) => choose(ids, { shiftKey: true, metaKey: false, ctrlKey: false });
  const rowKeys = (ids: string[], event: KeyboardEvent<HTMLButtonElement>, rename?: () => void) => {
    if (event.key === " ") {
      event.preventDefault();
      toggle(ids);
    } else if (event.key === "F2" && rename) {
      event.preventDefault();
      rename();
    }
  };

  const dragStart = (key: string, within: string | undefined, event: DragEvent<HTMLElement>) => {
    // A selected row drags every selected row of its level; another row drags itself.
    const level = within ? (entries.find((entry) => entry.kind === "group" && entry.group === within) as Extract<ObjectEntry, { kind: "group" }>).members.map((m) => m.id) : entries.map((entry) => entry.key);
    const chosen = level.filter((k) => selected.has(k) || (k.startsWith("group:") && (entries.find((entry) => entry.key === k) as Extract<ObjectEntry, { kind: "group" }>).members.every((m) => selected.has(m.id))));
    drag.current = { keys: chosen.includes(key) ? chosen : [key], within };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  };
  const dragOver = (index: number, within: string | undefined, event: DragEvent<HTMLElement>) => {
    if (!drag.current || drag.current.within !== within) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const below = event.clientY - rect.top > rect.height / 2;
    setDropAt({ index: below ? index + 1 : index, within });
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const moving = drag.current;
    const target = dropAt;
    drag.current = null;
    setDropAt(null);
    if (!moving || !target || moving.within !== target.within) return;
    onChange((draft) => moveObjects(draft, moving.keys, target.index, target.within));
  };
  const dragEnd = () => {
    drag.current = null;
    setDropAt(null);
  };
  const dropClass = (index: number, within?: string) =>
    dropAt && dropAt.within === within ? (dropAt.index === index ? " is-drop-before" : dropAt.index === index + 1 ? " is-drop-after" : "") : "";

  const moveMenu = (key: string, within?: string, extra: { label: string; onClick: () => void }[] = []) => [
    ...extra,
    { label: t("Move up"), title: t("Draw it over the row above"), onClick: () => onChange((draft) => stepObjects(draft, [key], -1, within)) },
    { label: t("Move down"), title: t("Draw it under the row below"), onClick: () => onChange((draft) => stepObjects(draft, [key], 1, within)) },
  ];

  const toggles = (ids: string[], name: string, isHidden: boolean, isLocked: boolean) => (
    <>
      <button
        type="button"
        className="gl-layout-object-toggle"
        aria-pressed={isHidden}
        aria-label={isHidden ? t("Show {name}", { name }) : t("Hide {name}", { name })}
        title={isHidden ? t("Show: draw it on the page and in the export") : t("Hide: not drawn, selected on the page or exported")}
        onClick={() => onChange((draft) => setObjectsHidden(draft, ids, !isHidden))}
      >
        <EyeIcon open={!isHidden} />
      </button>
      <button
        type="button"
        className={`gl-layout-object-toggle${isLocked ? "" : " is-off"}`}
        aria-pressed={isLocked}
        aria-label={isLocked ? t("Unlock {name}", { name }) : t("Lock {name}", { name })}
        title={isLocked ? t("Unlock: it can be moved and resized again") : t("Lock: it keeps its place and size")}
        onClick={() => onChange((draft) => setObjectsLocked(draft, ids, !isLocked))}
      >
        <LockIcon />
      </button>
    </>
  );

  const itemRow = (item: LayoutItem, index: number, within?: string) => {
    const name = objectName(item, naming, t);
    const isHidden = hidden.has(item.id);
    const startRename = () => setRenaming(item.id);
    return (
      <li
        key={item.id}
        data-object-id={item.id}
        className={`gl-layout-object${within ? " is-member" : ""}${selected.has(item.id) ? " is-selected" : ""}${isHidden ? " is-hidden" : ""}${dropClass(index, within)}`}
        draggable={renaming !== item.id}
        onDragStart={(event) => dragStart(item.id, within, event)}
        onDragOver={(event) => dragOver(index, within, event)}
        onDrop={drop}
        onDragEnd={dragEnd}
      >
        <span className="gl-layout-object-kind">{objectKindWord(item, t)}</span>
        {renaming === item.id ? (
          <RenameField
            initial={item.name ?? defaultObjectName(item, naming, t)}
            label={t("Name of {name}", { name })}
            onCommit={(value) => {
              setRenaming(null);
              // Accepting the default as it stands gives the item no name of its own.
              if (!item.name && value.trim() === defaultObjectName(item, naming, t)) return;
              if (value.trim() === (item.name ?? "")) return;
              onChange((draft) => renameObject(draft, item.id, value));
            }}
            onCancel={() => setRenaming(null)}
          />
        ) : (
          <button
            type="button"
            className="gl-layout-object-name"
            aria-pressed={selected.has(item.id)}
            title={t("Click to select it on the page, Shift-click to add or remove; double-click to rename")}
            onClick={(event: MouseEvent<HTMLButtonElement>) => choose([item.id], event)}
            onDoubleClick={startRename}
            onKeyDown={(event) => rowKeys([item.id], event, startRename)}
            onKeyUp={(event) => { if (event.key === " ") event.preventDefault(); }}
          >
            {name}
          </button>
        )}
        {toggles([item.id], name, isHidden, item.locked === true)}
        <MenuButton
          label={t("Actions for {name}", { name })}
          icon={<MoreIcon size={12} />}
          className="gl-layout-object-menu"
          items={moveMenu(item.id, within, [{ label: t("Rename"), onClick: startRename }])}
        />
      </li>
    );
  };

  const groupRows = (entry: Extract<ObjectEntry, { kind: "group" }>, index: number) => {
    const ids = entry.members.map((member) => member.id);
    const name = t("Group of {count}", { count: entry.members.length });
    const isFolded = folded.has(entry.group);
    const allHidden = ids.every((id) => hidden.has(id));
    const allLocked = entry.members.every((member) => member.locked === true);
    const allSelected = ids.every((id) => selected.has(id));
    return (
      <li key={entry.key} className="gl-layout-object-group">
        <div
          data-object-id={entry.key}
          className={`gl-layout-object${allSelected ? " is-selected" : ""}${allHidden ? " is-hidden" : ""}${dropClass(index)}`}
          draggable
          onDragStart={(event) => dragStart(entry.key, undefined, event)}
          onDragOver={(event) => dragOver(index, undefined, event)}
          onDrop={drop}
          onDragEnd={dragEnd}
        >
          <button
            type="button"
            className="gl-layout-object-fold"
            aria-expanded={!isFolded}
            aria-label={isFolded ? t("Unfold {name}", { name }) : t("Fold {name}", { name })}
            onClick={() => setFolded((current) => {
              const next = new Set(current);
              if (next.has(entry.group)) next.delete(entry.group);
              else next.add(entry.group);
              return next;
            })}
          >
            <ChevronIcon open={!isFolded} size={10} />
          </button>
          <button
            type="button"
            className="gl-layout-object-name"
            aria-pressed={allSelected}
            title={t("Click to select the group on the page, Shift-click to add or remove it")}
            onClick={(event: MouseEvent<HTMLButtonElement>) => choose(ids, event)}
            onKeyDown={(event) => rowKeys(ids, event)}
            onKeyUp={(event) => { if (event.key === " ") event.preventDefault(); }}
          >
            {name}
          </button>
          {toggles(ids, name, allHidden, allLocked)}
          <MenuButton label={t("Actions for {name}", { name })} icon={<MoreIcon size={12} />} className="gl-layout-object-menu" items={moveMenu(entry.key)} />
        </div>
        {!isFolded && (
          <ul className="gl-layout-objects-list" aria-label={name}>
            {entry.members.map((member, k) => itemRow(member, k, entry.group))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <details className="gl-layout-objects" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <FoldSummary>{t("Objects")}</FoldSummary>
      {entries.length ? (
        <ul ref={listRef} className="gl-layout-objects-list" aria-label={t("Objects on the sheet, top of the stack first")}>
          {entries.map((entry, index) => (entry.kind === "item" ? itemRow(entry.item, index) : groupRows(entry, index)))}
        </ul>
      ) : (
        <p className="gl-hint">{t("Nothing on the sheet yet.")}</p>
      )}
    </details>
  );
}

/** The name being edited: Enter or leaving the field keeps it, Escape drops it. */
function RenameField({ initial, label, onCommit, onCancel }: { initial: string; label: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="gl-layout-object-rename"
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          done.current = true;
          onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (done.current) return;
        done.current = true;
        onCommit(value);
      }}
    />
  );
}
