import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useI18n } from "./i18n";
import { MenuButton, type MenuEntry } from "./MenuButton";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { ChevronIcon, MoreIcon, PlusIcon } from "./icons";
import { HIERARCHY_COLOURS } from "../engine/hierarchies";
import { ModalEscape } from "./useModalEscape";
import { groupCheckedCount, type FacetColumn } from "../engine/sampleFacets";

export interface SampleListItem {
  id: string;
  name: string;
  eventCount: number;
  channelCount: number;
  sourcePath?: string;
  /** The cell images attached to the file, when any: the waveform file's name, for the badge. */
  images?: string;
  /** The file's tailored gates, when it has any: their names, for the badge and its tooltip. */
  tailored?: readonly string[];
  /** The group the file is in, when it is in one, and its colour. */
  group?: string;
  groupColour?: string;
  /**
   * The file is checked but belongs to a hierarchy other than the active one, so it contributes
   * nothing to the pooled display. Gates belong to their hierarchy and there is no way to draw
   * several sets at once, so this is a real limit rather than an oversight -- shown rather than
   * left for the user to infer from a count that does not add up.
   */
  gatedElsewhere?: boolean;
  /** This sample's metadata values, keyed by column. Absent where the workspace has none. */
  metadata?: Record<string, string>;
}

/**
 * What the file list asks the app to do with groups. "new", "assign" and "remove" act on
 * `fileIds` when given (a drag, a right-click), else on the selected files; "rename" with a
 * `name` renames in place, without one opens the dialog.
 */
export type GroupAction =
  | { kind: "new"; fileIds?: readonly string[] }
  /** One group per value of a metadata column. */
  | { kind: "fromMetadata" }
  | { kind: "assign"; groupId: string; fileIds?: readonly string[] }
  | { kind: "remove"; fileIds?: readonly string[] }
  | { kind: "rename"; groupId: string; name?: string }
  | { kind: "delete"; groupId: string }
  | { kind: "colour"; groupId: string; colour: string }
  | { kind: "reorder"; ids: readonly string[] };

/** What is being dragged inside the file list: files, or a group header. */
type ListDrag = { kind: "files"; ids: readonly string[] } | { kind: "group"; id: string };
const FILES_MIME = "application/x-gatelab-files";
const GROUP_MIME = "application/x-gatelab-group";

export interface FolderImportItem {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  duplicateName: boolean;
}

export interface SampleImportProgress {
  current: number;
  total: number;
  name: string;
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A drag only concerns this panel when it actually carries files. Without this check the panel
 * would arm itself for a dragged gate, a text selection, or a tab, and then swallow the drop.
 */
function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Directories dropped alongside files, counted from the drag entries.
 *
 * A dropped folder still appears in `dataTransfer.files`, as a name-only entry that no reader
 * can open, so counting the real directories here is what lets the caller say "use Add folder…"
 * instead of failing to parse something the user can plainly see they dropped.
 */
function droppedDirectoryCount(event: DragEvent<HTMLElement>): number {
  return Array.from(event.dataTransfer?.items ?? [])
    .filter((item) => item.webkitGetAsEntry?.()?.isDirectory)
    .length;
}

// Numeric-aware so exp10 follows exp9 rather than exp1, and case-insensitive so a stray capital
// does not sort a file away from its neighbours. Built once: constructing a collator per compare
// is what makes a naive sort slow.
const SAMPLE_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Order two sample filenames the way someone reading the list would expect. */
export function compareSampleNames(a: string, b: string): number {
  return SAMPLE_NAME_COLLATOR.compare(a, b);
}

/** The file list's folded groups, by name ("" for "No group"), kept per viewer. */
const FOLDED_GROUPS_KEY = "gatelab.fileList.foldedGroups";

function matchesQuery(item: SampleListItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return item.name.toLocaleLowerCase().includes(needle) ||
    (item.metadata?.sample_id?.toLocaleLowerCase().includes(needle) ?? false) ||
    (item.sourcePath?.toLocaleLowerCase().includes(needle) ?? false);
}

export function SampleNavigator({
  items,
  activeId,
  excludedIds,
  busy,
  importProgress,
  sourceLabel = "FCS samples",
  showImportActions = true,
  showManageActions = true,
  onOpenFiles,
  onOpenFolder,
  onManage,
  onManageSample,
  onActivate,
  onInspect,
  onSelectIds,
  onToggleIncluded,
  onIncludeAll,
  onIncludeNone,
  onInvertIncluded,
  pool,
  facets = [],
  facetColumnNames = [],
  facetPartialColumns = [],
  facetColumnChoice,
  facetLocks = {},
  facetLockOutside = 0,
  onToggleFacet,
  onToggleFacetLock,
  onSetFacetColumns,
  onDropFiles,
  groups,
  onGroupAction,
  onTailoredGates,
  fileMenuOf,
  treeSummary = null,
}: {
  items: readonly SampleListItem[];
  /** How the files stand against the tree, "4 files · 1 tailored": the header's second line. */
  treeSummary?: string | null;
  activeId: string | null;
  excludedIds: ReadonlySet<string>;
  busy: boolean;
  importProgress: SampleImportProgress | null;
  sourceLabel?: string;
  showImportActions?: boolean;
  showManageActions?: boolean;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  onManage: () => void;
  onManageSample: (id: string) => void;
  onActivate: (id: string) => void;
  /** Inspect without replacing the working selection (Enter). */
  onInspect?: (id: string) => void;
  onSelectIds?: (ids: readonly string[]) => void;
  onToggleIncluded: (id: string, included: boolean) => void;
  onIncludeAll: () => void;
  onIncludeNone: () => void;
  onInvertIncluded: () => void;
  /** The plot's pool, after All · None · Invert: one toggle, pressed while the checked files are pooled. */
  pool?: { on: boolean; count: number; disabled: boolean; title: string; onToggle: () => void };
  /** Metadata columns offered as chip rows, each with its values. Empty hides the board. */
  /** The workspace's groups, in order, with their colours: the Groups menu and the list's headers. */
  groups?: readonly { id: string; name: string; colour?: string }[];
  onGroupAction?: (action: GroupAction) => void;
  /** Open the table of tailored gates; absent when no file is gated with one. */
  onTailoredGates?: () => void;
  /** A right-click on a file row: the menu for these files (the checked files, when the row is one of them). */
  fileMenuOf?: (fileIds: readonly string[]) => MenuEntry[];
  facets?: readonly FacetColumn[];
  /** Every metadata column in the workspace, so the columns control can offer the hidden ones. */
  facetColumnNames?: readonly string[];
  /** Columns without a value for every sample -- per-event data such as a gate saved into colData. */
  facetPartialColumns?: readonly string[];
  /** Columns the user pinned, or undefined while the automatic choice stands. */
  facetColumnChoice?: readonly string[];
  /** Rows held fixed, by column, with the values each is frozen on. */
  facetLocks?: Readonly<Record<string, readonly string[]>>;
  /** Checked samples that no chip can count because a held row rules them out. */
  facetLockOutside?: number;
  /** Check every sample carrying this value, or uncheck them if they are all checked already. */
  onToggleFacet?: (column: string, value: string) => void;
  /** Freeze this row on what is checked in it, or release it. */
  onToggleFacetLock?: (column: string) => void;
  onSetFacetColumns?: (columns: readonly string[] | undefined) => void;
  /**
   * Files dropped onto the panel, with the number of folders that came with them. Omitted where
   * samples do not come from files at all -- a hosted SCE owns its own sample list.
   */
  onDropFiles?: (files: readonly File[], directoryCount: number) => void;
}) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false);
  // The samples panel is narrow and short. Collapsing the board hands the room back to the list
  // without losing the selection, which is what someone reading a long filtered list wants.
  const [boardOpen, setBoardOpen] = useState(true);
  // The panel is short and how much of it the chips deserve depends on the workspace, so the
  // board is draggable rather than a fixed guess.
  const [boardHeight, setBoardHeight] = useState(76);
  const boardDrag = useRef<{ y: number; h: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a boolean alone
  // flickers off as soon as the drag reaches a button. Depth counting tracks the panel as a whole.
  const dragDepth = useRef(0);
  const dropEnabled = Boolean(onDropFiles) && showImportActions && !busy;
  // With groups, the list is shown under a header per group, in the groups' order, then "No
  // group". A folded group's files leave the list, the arrow keys and Shift ranges alike; a search
  // looks inside folded groups too, and shows what it finds.
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FOLDED_GROUPS_KEY) ?? "[]") as string[]); } catch { return new Set(); }
  });
  useEffect(() => {
    try { localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify([...foldedGroups])); } catch { /* private mode */ }
  }, [foldedGroups]);
  const sections = useMemo(() => {
    if (!items.some((item) => item.group) && !groups?.length) return null;
    const names = [...new Set([
      ...(groups ?? []).map((g) => g.name),
      ...items.map((item) => item.group).filter((name): name is string => !!name),
    ])];
    // An empty group keeps its header, so files can be dragged into it.
    const out: { key: string; name: string; id: string | null; colour: string | null; items: SampleListItem[] }[] = names.map((name) => {
      const group = groups?.find((g) => g.name === name);
      return {
        key: name,
        name,
        id: group?.id ?? null,
        colour: group?.colour ?? items.find((item) => item.group === name)?.groupColour ?? null,
        items: items.filter((item) => item.group === name),
      };
    });
    const ungrouped = items.filter((item) => !item.group);
    out.push({ key: "", name: "", id: null, colour: null, items: ungrouped });
    return out;
  }, [items, groups]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  /** The group whose name is being edited in its header, and the one whose colour picker is open. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [colouring, setColouring] = useState<string | null>(null);
  /** The section a drag is over, by key, and what is being dragged (dataTransfer cannot be read before the drop). */
  const [dragOver, setDragOver] = useState<string | null>(null);
  const listDrag = useRef<ListDrag | null>(null);
  /** Files are being dragged in the list: "No group" shows even when empty, as a place to drop them. */
  const [draggingFiles, setDraggingFiles] = useState(false);
  const isFolded = (key: string) => !query && foldedGroups.has(key);
  const visible = useMemo(() => (sections
    ? sections.flatMap((section) => (!query && foldedGroups.has(section.key) ? [] : section.items))
    : items).filter((item) => matchesQuery(item, query)), [items, sections, foldedGroups, query]);
  const anchor = useRef<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const tabStop = visible.some(item => item.id === focusedId) ? focusedId
    : visible.some(item => item.id === activeId) ? activeId : visible[0]?.id;
  function selectRange(id: string, additive = false) {
    const end = visible.findIndex(item => item.id === id);
    const found = visible.findIndex(item => item.id === anchor.current);
    const start = found < 0 ? end : found;
    if (found < 0) anchor.current = id;
    const ids = new Set(additive ? items.filter(item => !excludedIds.has(item.id)).map(item => item.id) : []);
    for (const item of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) ids.add(item.id);
    onSelectIds?.([...ids]);
  }
  const includedCount = items.reduce((count, item) => count + Number(!excludedIds.has(item.id)), 0);
  // Files with gates of their own: the header says how many; its tooltip says the rest.
  const tailoredFiles = items.filter((item) => item.tailored?.length).length;
  // The header's ⋯: managing the files, the groups, Invert, and the keys the list answers to.
  const keyHints = [
    ...t("↑↓: view · Shift: range · Cmd/Ctrl: add or remove · Enter: inspect").split(" · "),
    ...(tailoredFiles > 0 ? [t("n = gates tailored for that file")] : []),
  ];
  const moreItems: MenuEntry[] = [
    ...(showManageActions
      ? [{ label: t("Manage files…"), className: "gl-sample-manage", disabled: busy || items.length === 0, onClick: onManage }]
      : []),
    ...(onGroupAction
      ? [
          { section: t("Groups") },
          {
            label: t("New group from the {count} selected…", { count: includedCount }),
            className: "gl-sample-group-new",
            title: t("A named set of files with gate coordinates of its own, between the tree and the files"),
            disabled: includedCount === 0,
            onClick: () => onGroupAction({ kind: "new" }),
          },
          {
            label: t("Groups from a metadata column…"),
            className: "gl-sample-group-from-metadata",
            title: t("One group per value of a column, each file in the group of its value; a group already named as a value takes the files"),
            disabled: !(facetColumnNames ?? []).length,
            onClick: () => onGroupAction({ kind: "fromMetadata" }),
          },
          ...((groups ?? []).length
            ? [
                "separator" as const,
                ...(groups ?? []).map((group) => ({
                  label: t("Add the {count} selected to {name}", { count: includedCount, name: group.name }),
                  className: "gl-sample-group-assign",
                  disabled: includedCount === 0,
                  onClick: () => onGroupAction({ kind: "assign", groupId: group.id }),
                })),
                {
                  label: t("Remove the {count} selected from their group", { count: includedCount }),
                  className: "gl-sample-group-remove",
                  disabled: includedCount === 0,
                  onClick: () => onGroupAction({ kind: "remove" }),
                },
                "separator" as const,
                ...(groups ?? []).map((group) => (
                  { label: t("Rename {name}…", { name: group.name }), className: "gl-sample-group-rename", onClick: () => onGroupAction({ kind: "rename", groupId: group.id }) }
                )),
                // The deletes last, after a separator, as in every menu.
                "separator" as const,
                ...(groups ?? []).map((group) => (
                  { label: t("Delete {name}…", { name: group.name }), className: "gl-sample-group-delete", danger: true, onClick: () => onGroupAction({ kind: "delete", groupId: group.id }) }
                )),
              ]
            : []),
        ]
      : []),
    ...(onTailoredGates
      ? [
          { section: t("Tailoring") },
          {
            label: t("Tailored gates…"),
            className: "gl-sample-tailored-gates",
            title: t("The gates files are gated with at coordinates of their own or their group's, each with its shift and a reason"),
            onClick: onTailoredGates,
          },
        ]
      : []),
    ...(items.length > 0
      ? [
          { section: t("Selection") },
          { label: t("Invert selection"), className: "gl-sample-invert", onClick: onInvertIncluded },
          // What the "?" at the end of the header said, as notes: picking one does nothing.
          { section: t("Keyboard shortcuts") },
          ...keyHints.map((hint) => ({ label: hint, className: "gl-menu-note gl-sample-key-hint", onClick: () => undefined })),
        ]
      : []),
  ];
  type Section = NonNullable<typeof sections>[number];
  function toggleFold(key: string) {
    setFoldedGroups((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  /** The files a drag or a right-click on this row is about: the checked files when it is one of several checked, else the row. */
  function filesFor(item: SampleListItem): string[] {
    if (!excludedIds.has(item.id)) {
      const checked = items.filter((entry) => !excludedIds.has(entry.id)).map((entry) => entry.id);
      if (checked.length > 1) return checked;
    }
    return [item.id];
  }
  function startDrag(event: DragEvent<HTMLElement>, drag: ListDrag) {
    listDrag.current = drag;
    if (drag.kind === "files") setDraggingFiles(true);
    event.dataTransfer?.setData(drag.kind === "files" ? FILES_MIME : GROUP_MIME, drag.kind === "files" ? drag.ids.join("\n") : drag.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function endListDrag() {
    listDrag.current = null;
    setDragOver(null);
    setDraggingFiles(false);
  }
  function sectionDragOver(event: DragEvent<HTMLElement>, section: Section) {
    const drag = listDrag.current;
    if (!drag || !onGroupAction) return;
    // Groups reorder among themselves; "No group" stays last.
    if (drag.kind === "group" && !section.id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dragOver !== section.key) setDragOver(section.key);
  }
  function sectionDrop(event: DragEvent<HTMLElement>, section: Section) {
    const drag = listDrag.current;
    endListDrag();
    if (!drag || !onGroupAction) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.kind === "files") {
      onGroupAction(section.id ? { kind: "assign", groupId: section.id, fileIds: drag.ids } : { kind: "remove", fileIds: drag.ids });
    } else if (section.id && section.id !== drag.id) {
      // The dragged group goes before the one it is dropped on.
      const order = (groups ?? []).map((g) => g.id).filter((id) => id !== drag.id);
      order.splice(order.indexOf(section.id), 0, drag.id);
      onGroupAction({ kind: "reorder", ids: order });
    }
  }
  /** A group header's actions: its ⋯ menu and its right-click menu alike. */
  function headerMenu(section: Section): MenuEntry[] {
    const folded = foldedGroups.has(section.key);
    const id = section.id;
    return [
      ...(id && onGroupAction ? [
        { label: t("Rename…"), className: "gl-group-menu-rename", onClick: () => setRenaming(id) },
        { label: t("Colour…"), className: "gl-group-menu-colour", onClick: () => setColouring(id) },
      ] : []),
      { label: folded ? t("Expand") : t("Collapse"), className: "gl-group-menu-fold", disabled: !!query, onClick: () => toggleFold(section.key) },
      { label: t("Select its files"), className: "gl-group-menu-select", disabled: !section.items.length || !onSelectIds, onClick: () => onSelectIds?.(section.items.map((item) => item.id)) },
      ...(id && onGroupAction ? [
        "separator" as const,
        {
          label: t("Delete group…"),
          className: "gl-group-menu-delete",
          danger: true,
          title: t("The group goes; its files move to No group, each keeping its own tailoring."),
          onClick: () => onGroupAction({ kind: "delete", groupId: id }),
        },
      ] : []),
    ];
  }
  function commitRename(id: string, name: string) {
    setRenaming(null);
    onGroupAction?.({ kind: "rename", groupId: id, name });
  }
  const renderRow = (item: SampleListItem) => {
    const included = !excludedIds.has(item.id);
    const active = item.id === activeId;
    const exactSummary = `${item.eventCount.toLocaleString()} events · ${item.channelCount} channels`;
    return (
      <div
        key={item.id}
        className={`gl-sample-row${included ? " included" : ""}${active ? " active" : ""}`}
        data-group={item.group}
        draggable={!!sections && !!onGroupAction}
        onDragStart={sections && onGroupAction ? (event) => startDrag(event, { kind: "files", ids: filesFor(item) }) : undefined}
        onDragEnd={endListDrag}
        onContextMenu={fileMenuOf ? (event) => {
          const entries = fileMenuOf(filesFor(item));
          if (!entries.length) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, items: entries });
        } : undefined}
        role="option"
        aria-selected={included}
        aria-current={active ? "true" : undefined}
        tabIndex={item.id === tabStop ? 0 : -1}
        title={`${item.sourcePath ?? item.name}\n${exactSummary}${item.group ? `\n${t("In the group {name}", { name: item.group })}` : ""}`}
        onFocus={() => setFocusedId(item.id)}
        onClick={(event) => {
          event.currentTarget.focus();
          if (event.shiftKey) selectRange(item.id, event.metaKey || event.ctrlKey);
          else if (event.metaKey || event.ctrlKey) {
            anchor.current = item.id;
            onToggleIncluded(item.id, !included);
          } else {
            anchor.current = item.id;
            onActivate(item.id);
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            onSelectIds?.(visible.map(entry => entry.id));
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const index = visible.findIndex(entry => entry.id === item.id);
            const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
              : Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
            const id = visible[next].id;
            if (event.shiftKey) {
              if (!anchor.current) anchor.current = item.id;
              selectRange(id, event.metaKey || event.ctrlKey);
            } else if (!(event.metaKey || event.ctrlKey) && id !== item.id) {
              // A plain arrow views the file it lands on, as Enter does, leaving the
              // checked selection as it is; Cmd or Ctrl moves the cursor alone, and Shift
              // extends the selection.
              (onInspect ?? onActivate)(id);
            }
            (event.currentTarget.closest(".gl-sample-list")?.querySelectorAll<HTMLElement>('[role="option"]')[next])?.focus();
          } else if (event.key === "Enter") {
            event.preventDefault();
            (onInspect ?? onActivate)(item.id);
          } else if (event.key === " ") {
            event.preventDefault();
            if (event.shiftKey) selectRange(item.id);
            else { anchor.current = item.id; onToggleIncluded(item.id, !included); }
          }
        }}
      >
        <span className="gl-sample-name">
          {item.name}
          {item.metadata?.sample_id && item.metadata.sample_id !== item.name && <small className="gl-sample-display-id" title={`Sample ID: ${item.metadata.sample_id}`}>{item.metadata.sample_id}</small>}
        </span>
        <span className="gl-sample-viewing">{active ? t("Viewing") : ""}</span>
        <span className="gl-sample-meta" title={exactSummary}>
          {/* The tailored count sits with the counts, so its appearance never moves the name. */}
          {item.tailored && item.tailored.length > 0 && (
            <span
              className={"gl-sample-tailored" + (item.gatedElsewhere ? " gl-hierarchy-elsewhere" : "")}
              title={t("{count} gates tailored for this file: {names}", { count: item.tailored.length, names: item.tailored.join(", ") })}
            >
              {item.tailored.length}
            </span>
          )}
          {item.images && (
            <span className="gl-sample-images" title={t("Cell images attached: {name}", { name: item.images })}>
              {t("img")}
            </span>
          )}
          {localizedCompactNumber.format(item.eventCount)} · {item.channelCount}ch
        </span>
        {showManageActions && (
          <button
            type="button"
            className="gl-sample-row-menu"
            aria-label={t("Manage {name}", { name: item.name })}
            title={t("Manage this sample")}
            onClick={(event) => {
              event.stopPropagation();
              onManageSample(item.id);
            }}
          >
            <MoreIcon />
          </button>
        )}
      </div>
    );
  };

  const localizedCompactNumber = useMemo(() => new Intl.NumberFormat(language === "ja" ? "ja-JP" : undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }), [language]);

  function endDrag() {
    dragDepth.current = 0;
    setDropActive(false);
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!dropEnabled || !carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDropActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!dropEnabled || !carriesFiles(event)) return;
    // Without this the browser treats the drop as navigation and opens the FCS file instead.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!dropEnabled || !carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDropActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!dropEnabled || !carriesFiles(event)) return;
    event.preventDefault();
    const directoryCount = droppedDirectoryCount(event);
    const files = Array.from(event.dataTransfer?.files ?? []);
    endDrag();
    onDropFiles?.(files, directoryCount);
  }

  return (
    <section
      className={`gl-sample-navigator${facets.length > 0 ? " has-facets" : ""}${dropEnabled && dropActive ? " is-drop-target" : ""}`}
      aria-label={t(sourceLabel)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropEnabled && dropActive && (
        <div className="gl-sample-drop-overlay">{t("Drop .fcs files to add them")}</div>
      )}
      {/* Two rows: the title with the counts and the ＋ and ⋯ menus; then Select all and the
          plot's Single | Pooled (David, 2026-10-23). */}
      <div className="gl-sample-heading">
        <div className="gl-side-title">{t("Files")}</div>
        <span className="gl-sample-heading-end">
          {/* How the files stand against the tree, in full, is the count's tooltip; the count says only how many are tailored. */}
          {items.length > 0 && (
            <span className="gl-sample-count gl-sample-tree-summary" title={treeSummary ?? undefined}>
              {t("{count} of {total} selected", { count: includedCount, total: items.length })}
              {tailoredFiles > 0 && <>{" · "}{t("{count} tailored", { count: tailoredFiles })}</>}
            </span>
          )}
          {showImportActions && (
            <MenuButton
              label={t("Add files")}
              icon={<PlusIcon size={16} />}
              className="gl-sample-add-menu"
              disabled={busy}
              items={[
                { label: t("Add files…"), className: "gl-sample-add-files", onClick: onOpenFiles },
                { label: t("Add folder…"), className: "gl-sample-add-folder", onClick: onOpenFolder },
              ]}
            />
          )}
          {moreItems.length > 0 && (
            <MenuButton label={t("File list actions")} icon={<MoreIcon />} className="gl-sample-more-menu" items={moreItems} />
          )}
        </span>
      </div>

      {items.length > 0 && (
        <div className="gl-sample-inclusion-actions" aria-label={t("File selection")}>
          <label className="gl-check gl-sample-select-all">
            <input
              type="checkbox"
              ref={(el) => { if (el) el.indeterminate = includedCount > 0 && includedCount < items.length; }}
              checked={includedCount === items.length}
              onChange={() => (includedCount === items.length ? onIncludeNone() : onIncludeAll())}
            />
            {t("Select all")}
          </label>
          {pool && (
            // The same control as the header's Original | Compensated: both choices shown, the current one selected.
            <div className="gl-segmented gl-pool-toggle" role="radiogroup" aria-label={t("Plot the selected files")}>
              <button
                type="button"
                role="radio"
                aria-checked={!pool.on}
                className={"gl-pool-single" + (pool.on ? "" : " is-selected")}
                title={pool.on ? pool.title : undefined}
                onClick={() => { if (pool.on) pool.onToggle(); }}
              >
                {t("Single")}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={pool.on}
                className={"gl-pool-pooled" + (pool.on ? " is-selected" : "")}
                disabled={!pool.on && pool.disabled}
                title={pool.on ? undefined : pool.title}
                onClick={() => { if (!pool.on) pool.onToggle(); }}
              >
                {t("Pooled · {count}", { count: pool.count })}
              </button>
            </div>
          )}
        </div>
      )}

      {facets.length > 0 && (
        <div className="gl-sample-facet-board" aria-label={t("Select samples by metadata")}>
          <div className="gl-sample-facet-head">
            <button
              type="button"
              className="gl-sample-facet-toggle"
              aria-expanded={boardOpen}
              title={boardOpen ? t("Hide the metadata chips") : t("Show the metadata chips")}
              onClick={() => setBoardOpen((open) => !open)}
            >
              {boardOpen ? "\u25be" : "\u25b8"}
            </button>
            {onSetFacetColumns && (
              <button type="button" onClick={() => setColumnsOpen((open) => !open)}>
                {t("Columns…")}
              </button>
            )}
            <span
              className="gl-sample-facet-tally"
              title={t("{included} / {total} included", { included: includedCount, total: items.length })}
            >
              {includedCount}/{items.length}
            </span>
            {facetLockOutside > 0 && (
              <span
                className="gl-sample-facet-outside"
                title={t("{count} selected outside the rows being held fixed, so no chip counts them. All / None / Invert stay global.", { count: facetLockOutside })}
              >
                +{facetLockOutside}
              </span>
            )}
          </div>
          {boardOpen && (
          <div className="gl-sample-facets" style={{ height: boardHeight }}>
          {facets.map((column) => {
            const locked = facetLocks[column.name];
            // Freezing an empty row would block every later click, so the control only arms once
            // there is something in the row to hold on to.
            const lockable = column.values.some(
              (entry) => entry.sampleIds.some((id) => !excludedIds.has(id)));
            return (
            <div key={column.name} className={`gl-sample-facet-row${locked ? " is-locked" : ""}`}>
              {onToggleFacetLock ? (
                <button
                  type="button"
                  className={`gl-sample-facet-lock${locked ? " is-locked" : ""}`}
                  aria-pressed={Boolean(locked)}
                  aria-label={t("Hold {column} fixed", { column: column.name })}
                  disabled={!locked && !lockable}
                  title={locked
                    ? t("{column} is held at {values}. Chips in the other rows reach only these samples. Click to release it.",
                        { column: column.name, values: locked.join(", ") })
                    : lockable
                      ? t("Hold {column} at what is selected in it, so chips in the other rows reach only those samples.",
                          { column: column.name })
                      : t("Check something in {column} first, then hold it fixed.", { column: column.name })}
                  onClick={() => onToggleFacetLock(column.name)}
                >
                  <svg viewBox="0 0 10 12" width="9" height="11" aria-hidden="true">
                    <path
                      d={locked ? "M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" : "M2.5 5V3.5a2.5 2.5 0 0 1 5 0"}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                    <rect x="1" y="5" width="8" height="6" rx="1.2" fill="currentColor" />
                  </svg>
                </button>
              ) : <span className="gl-sample-facet-lock" aria-hidden="true" />}
              <span
                className={`gl-sample-facet-name${column.covered < column.sampleCount ? " is-partial" : ""}`}
                title={column.covered < column.sampleCount
                  ? t("{column}: only {covered} of {total} samples have a value. This is per-event data, such as a gate saved into colData, so it does not describe whole samples.",
                      { column: column.name, covered: column.covered, total: column.sampleCount })
                  : column.name}
              >
                {column.name}
                {column.covered < column.sampleCount && (
                  <span className="gl-sample-facet-partial">{column.covered}/{column.sampleCount}</span>
                )}
                {locked && (
                  <span className="gl-sample-facet-held" title={locked.join(", ")}>{locked.join(", ")}</span>
                )}
              </span>
              <div className="gl-sample-facet-values">
              {column.values.map((entry) => {
                const on = groupCheckedCount(entry.sampleIds, excludedIds);
                const total = entry.sampleIds.length;
                // A lock can leave a value with no reachable sample. That is empty, not full:
                // without the guard `0 === 0` would paint it as a completely checked group.
                const empty = total === 0;
                const state = empty ? "none" : on === total ? "all" : on === 0 ? "none" : "some";
                // A partly-checked group is filled to its fraction, so the chip reads as a
                // progress bar rather than as a second colour that has to be learnt. Nobody
                // chooses the partial state -- it falls out of other clicks -- so it has to
                // explain itself.
                const fill = total > 0 ? Math.round((on / total) * 100) : 0;
                return (
                  <button
                    key={entry.value}
                    type="button"
                    className={`gl-sample-facet-chip is-${state}${empty ? " is-empty" : ""}`}
                    disabled={empty}
                    style={state === "some" ? { "--gl-facet-fill": `${fill}%` } as React.CSSProperties : undefined}
                    aria-pressed={!empty && on === total}
                    // Say what the click will do. A partly-checked group completes before it
                    // clears, so without this the second click is only discoverable by trying it.
                    title={empty
                      ? t("{value}: no sample here under the rows being held fixed", { value: entry.value })
                      : `${t("{value}: {on} of {total} selected", { value: entry.value, on, total })} \u2014 ${
                          on === total
                            ? t("click to deselect all {total}", { total })
                            : t("click to select all {total}", { total })
                        }`}
                    onClick={() => onToggleFacet?.(column.name, entry.value)}
                  >
                    <span className="gl-sample-facet-label">{entry.value}</span>
                    <span
                      className="gl-sample-facet-count"
                      style={{ minWidth: `${String(total).length * 2 + 1}ch` }}
                    >
                      {on}/{total}
                    </span>
                  </button>
                );
              })}
              </div>
            </div>
            );
          })}
          </div>
          )}
          {boardOpen && (
            <div
              className="gl-sample-facet-grip"
              title={t("Drag to resize")}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                boardDrag.current = { y: event.clientY, h: boardHeight };
              }}
              onPointerMove={(event) => {
                const drag = boardDrag.current;
                if (!drag) return;
                setBoardHeight(Math.max(28, Math.min(320, drag.h + event.clientY - drag.y)));
              }}
              onPointerUp={() => { boardDrag.current = null; }}
            />
          )}

          {columnsOpen && onSetFacetColumns && (
            <div className="gl-sample-facet-columns">
              {facetColumnNames.map((name) => {
                const shown = facets.some((column) => column.name === name);
                const partial = facetPartialColumns.includes(name);
                return (
                  <label
                    key={name}
                    className={partial ? "is-partial" : undefined}
                    title={partial ? t("Only some samples have a value here.") : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={shown}
                      onChange={() => onSetFacetColumns(
                        shown
                          ? facetColumnNames.filter((entry) => entry !== name && facets.some((column) => column.name === entry))
                          : [...facetColumnNames.filter((entry) => facets.some((column) => column.name === entry)), name],
                      )}
                    />
                    {name}
                    {partial && <span className="gl-sample-facet-partial-mark">*</span>}
                  </label>
                );
              })}
              {facetColumnChoice && (
                <button type="button" onClick={() => onSetFacetColumns(undefined)}>{t("Reset")}</button>
              )}
            </div>
          )}
        </div>
      )}

      {items.length >= 5 && (
        <input
          className="gl-sample-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Search samples…")}
          aria-label={t("Search samples…")}
        />
      )}

      {importProgress && (
        <div className="gl-sample-import-progress" role="status" aria-live="polite">
          <div>
            <span>{t("Loading {current} / {total}", { current: importProgress.current, total: importProgress.total })}</span>
            <span title={importProgress.name}>{importProgress.name}</span>
          </div>
          <progress max={importProgress.total} value={Math.max(0, importProgress.current - 1)} />
        </div>
      )}

      <div className="gl-sample-list" role="listbox" aria-multiselectable="true" aria-label={t("Loaded FCS samples")}>
        {items.length === 0 ? (
          showImportActions ? (
            // The one thing to do on an empty list, so the one primary button.
            <div className="gl-sample-empty">
              <button type="button" className="gl-btn gl-sample-add-primary" disabled={busy} onClick={onOpenFiles}>
                {t("+ Add files…")}
              </button>
              {dropEnabled && <span className="gl-hint">{t("or drop FCS files here")}</span>}
            </div>
          ) : (
            <em className="gl-hint">{t("No files loaded.")}</em>
          )
        ) : query && visible.length === 0 ? (
          // Only a search empties the list: with every file in folded groups, the headers stay.
          <em className="gl-hint">{t("No samples match “{query}”.", { query })}</em>
        ) : sections ? sections.map((section) => {
          const folded = isFolded(section.key);
          const rows = folded ? [] : visible.filter((item) => section.items.includes(item));
          if (query && !rows.length) return null;
          // "No group" with nothing in it is shown only as a place to drop files.
          if (!section.name && !section.items.length && !draggingFiles) return null;
          const label = section.name || t("No group");
          return (
            <div
              key={`group-${section.key}`}
              role="group"
              aria-label={label}
              className={"gl-sample-group-section" + (section.name ? "" : " is-ungrouped") + (dragOver === section.key ? " is-drop-target" : "")}
              style={section.colour ? ({ "--gl-group-colour": section.colour } as React.CSSProperties) : undefined}
              onDragOver={(event) => sectionDragOver(event, section)}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && dragOver === section.key) setDragOver(null); }}
              onDrop={(event) => sectionDrop(event, section)}
            >
              <div
                className="gl-sample-group-headrow"
                draggable={!!section.id && !!onGroupAction && renaming !== section.id}
                onDragStart={section.id && onGroupAction ? (event) => startDrag(event, { kind: "group", id: section.id! }) : undefined}
                onDragEnd={endListDrag}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, items: headerMenu(section) });
                }}
              >
                {renaming === section.id && section.id ? (
                  <input
                    className="gl-sample-group-name-input"
                    aria-label={t("Rename {name}", { name: label })}
                    defaultValue={section.name}
                    autoFocus
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename(section.id!, event.currentTarget.value);
                      else if (event.key === "Escape") { event.stopPropagation(); setRenaming(null); }
                    }}
                    onBlur={(event) => { if (renaming === section.id) commitRename(section.id!, event.currentTarget.value); }}
                  />
                ) : (
                  <button
                    type="button"
                    className="gl-sample-group-head"
                    aria-expanded={!folded}
                    disabled={!!query}
                    title={(folded ? t("Show the files in {name}", { name: label }) : t("Hide the files in {name}", { name: label }))
                      + (section.id && onGroupAction ? `\n${t("Double-click to rename; drag to reorder; drop files here to move them in")}` : `\n${t("Drop files here to take them out of their group")}`)}
                    onClick={(event) => { if (event.detail <= 1) toggleFold(section.key); }}
                    onDoubleClick={section.id && onGroupAction ? () => setRenaming(section.id) : undefined}
                  >
                    <span className="gl-sample-group-head-mark" aria-hidden="true"><ChevronIcon open={!folded} size={12} /></span>
                    <span className="gl-sample-group-head-name">{label}</span>
                    <span className="gl-sample-group-head-count">{section.items.length}</span>
                  </button>
                )}
                <MenuButton label={t("{name}: group actions", { name: label })} items={headerMenu(section)} icon={<MoreIcon />} className="gl-sample-group-menu" />
                {colouring === section.id && section.id && (
                  <div className="gl-group-colour-pop" role="dialog" aria-label={t("Colour of {name}", { name: label })}
                    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setColouring(null); } }}>
                    {HIERARCHY_COLOURS.map((colour) => (
                      <button
                        key={colour}
                        type="button"
                        className={"gl-group-colour-swatch" + (colour === section.colour ? " is-current" : "")}
                        style={{ background: colour }}
                        aria-label={colour}
                        aria-pressed={colour === section.colour}
                        onClick={() => { setColouring(null); onGroupAction?.({ kind: "colour", groupId: section.id!, colour }); }}
                      />
                    ))}
                    <input
                      type="color"
                      className="gl-group-colour-custom"
                      aria-label={t("Another colour")}
                      defaultValue={section.colour ?? "#7b8491"}
                      onChange={(event) => onGroupAction?.({ kind: "colour", groupId: section.id!, colour: event.currentTarget.value })}
                    />
                    <button type="button" className="gl-mini-btn" onClick={() => setColouring(null)}>{t("Done")}</button>
                  </div>
                )}
              </div>
              {rows.map(renderRow)}
            </div>
          );
        }) : visible.map(renderRow)}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </section>
  );
}

function ModalFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-sample-manager-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="gl-modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function SampleManagerModal({
  items,
  activeId,
  excludedIds,
  initialSelectedIds = [],
  onClose,
  onActivate,
  onToggleIncluded,
  onIncludeAll,
  onIncludeNone,
  onInvertIncluded,
  onRemove,
  onSort,
}: {
  items: readonly SampleListItem[];
  activeId: string | null;
  excludedIds: ReadonlySet<string>;
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  onActivate: (id: string) => void;
  onToggleIncluded: (id: string, included: boolean) => void;
  onIncludeAll: () => void;
  onIncludeNone: () => void;
  onInvertIncluded: () => void;
  onRemove: (ids: readonly string[]) => Promise<void>;
  /** Reorder the workspace's samples by filename. Omitted where the order is not the user's. */
  onSort?: (direction: "asc" | "desc") => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const visible = useMemo(() => items.filter((item) => matchesQuery(item, query)), [items, query]);

  useEffect(() => {
    setSelectedIds((previous) => new Set([...previous].filter((id) => items.some((item) => item.id === id))));
  }, [items]);

  const selectVisible = (selected: boolean) => {
    setConfirmRemove(false);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const item of visible) selected ? next.add(item.id) : next.delete(item.id);
      return next;
    });
  };

  return (
    <ModalFrame title={t("Manage samples")} onClose={confirmRemove ? () => setConfirmRemove(false) : onClose}>
      <div className="gl-sample-manager-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Search filename or source…")}
          aria-label={t("Search managed samples")}
        />
        <span>{t("{count} files", { count: items.length })}</span>
      </div>
      <div className="gl-sample-manager-actions">
        <span>{t("Manage selection")}</span>
        <button type="button" onClick={() => selectVisible(true)}>{t("All visible")}</button>
        <button type="button" onClick={() => selectVisible(false)}>{t("None visible")}</button>
        <span className="gl-sample-manager-separator" />
        <span>{t("Selected for actions")}</span>
        <button type="button" onClick={onIncludeAll}>{t("All")}</button>
        <button type="button" onClick={onIncludeNone}>{t("None")}</button>
        <button type="button" onClick={onInvertIncluded}>{t("Invert")}</button>
        {onSort && (
          <>
            <span className="gl-sample-manager-separator" />
            <span>{t("Order")}</span>
            <button
              type="button"
              title={t("Sort every loaded file by name. This is the order they appear in throughout the app.")}
              onClick={() => onSort("asc")}
            >
              {t("Name A–Z")}
            </button>
            <button
              type="button"
              title={t("Sort every loaded file by name, reversed.")}
              onClick={() => onSort("desc")}
            >
              {t("Name Z–A")}
            </button>
          </>
        )}
      </div>
      <div className="gl-sample-manager-table-wrap">
        <table className="gl-sample-manager-table">
          <thead>
            <tr>
              <th aria-label={t("Select for management")} />
              <th>{t("Active")}</th>
              <th>{t("Selected for actions")}</th>
              <th>{t("File")}</th>
              <th>{t("Events")}</th>
              <th>{t("Channels")}</th>
              <th>{t("Source")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id} className={item.id === activeId ? "active" : ""}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t("Select {name} for management", { name: item.name })}
                    checked={selectedIds.has(item.id)}
                    onChange={(event) => {
                      setConfirmRemove(false);
                      setSelectedIds((previous) => {
                        const next = new Set(previous);
                        event.target.checked ? next.add(item.id) : next.delete(item.id);
                        return next;
                      });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name="active-managed-sample"
                    aria-label={t("Make {name} active", { name: item.name })}
                    checked={item.id === activeId}
                    onChange={() => onActivate(item.id)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t("Select {name} for actions", { name: item.name })}
                    checked={!excludedIds.has(item.id)}
                    onChange={(event) => onToggleIncluded(item.id, event.target.checked)}
                  />
                </td>
                <td className="gl-sample-manager-file" title={item.name}>{item.name}</td>
                <td>{item.eventCount.toLocaleString()}</td>
                <td>{item.channelCount}</td>
                <td className="gl-sample-manager-source" title={item.sourcePath ?? t("Individually selected file")}>
                  {item.sourcePath ?? t("Individual file")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmRemove ? (
        <div className="gl-sample-manager-confirm" role="alert">
          <span>{t("Remove {count} selected samples from this workspace?", { count: selectedIds.size })}</span>
          <button type="button" className="gl-btn-ghost" onClick={() => setConfirmRemove(false)}>{t("Cancel")}</button>
          <button
            type="button"
            className="gl-btn gl-btn-danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              await onRemove([...selectedIds]);
              setRemoving(false);
              setSelectedIds(new Set());
              setConfirmRemove(false);
            }}
          >
            {removing ? t("Removing…") : t("Remove")}
          </button>
        </div>
      ) : (
        <div className="gl-modal-actions">
          <button
            type="button"
            className="gl-btn-ghost gl-sample-manager-remove"
            disabled={selectedIds.size === 0}
            onClick={() => setConfirmRemove(true)}
          >
            {t("Remove selected…")}
          </button>
          <button type="button" className="gl-btn" onClick={onClose}>{t("Done")}</button>
        </div>
      )}
    </ModalFrame>
  );
}

export function FolderImportModal({
  folderName,
  items,
  onCancel,
  onImport,
}: {
  folderName: string;
  items: readonly FolderImportItem[];
  onCancel: () => void;
  onImport: (ids: readonly string[]) => void;
}) {
  const { t } = useI18n();
  const onlyNested = items.length > 0 && items.every((item) => item.relativePath.includes("/"));
  const [includeSubfolders, setIncludeSubfolders] = useState(onlyNested);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(
    items
      .filter((item) => (onlyNested || !item.relativePath.includes("/")) && !item.duplicateName)
      .map((item) => item.id),
  ));

  const eligible = useMemo(
    () => items.filter((item) => includeSubfolders || !item.relativePath.includes("/")),
    [includeSubfolders, items],
  );
  const selectedBytes = eligible.reduce(
    (sum, item) => sum + (selectedIds.has(item.id) ? item.size : 0),
    0,
  );

  const changeSubfolders = (include: boolean) => {
    setIncludeSubfolders(include);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const item of items) {
        if (!item.relativePath.includes("/")) continue;
        if (include && !item.duplicateName) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  };

  return (
    <ModalFrame title={t("Import FCS folder · {folder}", { folder: folderName })} onClose={onCancel}>
      <div className="gl-folder-import-summary">
        {t("Found {count} FCS files. Review this snapshot before adding it to the workspace.", { count: items.length })}
      </div>
      <div className="gl-folder-import-actions">
        <label>
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => changeSubfolders(event.target.checked)}
          />
          {t("Include subfolders")}
        </label>
        <button type="button" onClick={() => setSelectedIds(new Set(eligible.map((item) => item.id)))}>{t("All")}</button>
        <button type="button" onClick={() => setSelectedIds(new Set())}>{t("None")}</button>
        <span>{t("{count} selected · {size}B", { count: selectedIds.size, size: compactNumber.format(selectedBytes) })}</span>
      </div>
      <div className="gl-folder-import-list">
        {items.map((item) => {
          const nestedDisabled = !includeSubfolders && item.relativePath.includes("/");
          return (
            <label key={item.id} className={nestedDisabled ? "disabled" : ""}>
              <input
                type="checkbox"
                disabled={nestedDisabled}
                checked={selectedIds.has(item.id)}
                onChange={(event) => {
                  setSelectedIds((previous) => {
                    const next = new Set(previous);
                    event.target.checked ? next.add(item.id) : next.delete(item.id);
                    return next;
                  });
                }}
              />
              <span title={item.relativePath}>{item.relativePath}</span>
              <span>{compactNumber.format(item.size)}B</span>
              {item.duplicateName && <span className="gl-folder-import-duplicate">{t("name already loaded")}</span>}
            </label>
          );
        })}
      </div>
      <div className="gl-modal-actions">
        <button type="button" className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button
          type="button"
          className="gl-btn"
          disabled={selectedIds.size === 0}
          onClick={() => onImport([...selectedIds])}
        >
          {t("Import {count} files", { count: selectedIds.size })}
        </button>
      </div>
    </ModalFrame>
  );
}
