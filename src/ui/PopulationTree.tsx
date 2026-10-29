// PopulationTree.tsx — reproduced from GateLabR output$population_tree_ui.
// Recursive rows with SVG ├/└ tree connectors (make_tree_connectors), gate-ref badges (coloured
// by gate, "-name" when excluded, .selected-gate ring when that gate is selected), count and
// "% pnt, % tot".
// The blue highlight is the tree's one selection (David, 2026-10-23; it replaced a column of ticks
// kept apart from it since 2026-09-04): a click highlights one row and makes it active, Shift-click
// the range from the active row, Cmd/Ctrl-click adds or removes a row, Cmd/Ctrl-A every row, and
// Escape or a click on empty space goes back to the active row alone. The highlighted rows are
// drawn together on the plot, are what Duplicate and Delete act on, and move together in a drag.
// They are the store's selected_pop_ids (with the active population).
// A row's triangle shows on hover, or while its branch is folded; ←/→ fold and unfold the active
// row, and Option-click on a triangle folds or unfolds the whole branch.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CoreState, Derived, Action } from "../store";
import { wouldCreateCycle, type Gate, type GateRef } from "../engine/models";
import { TreeConnectors } from "./TreeConnectors";
import { useI18n, type TranslationValues } from "./i18n";

type Translate = (source: string, values?: TranslationValues) => string;
import { MenuButton, type MenuEntry } from "./MenuButton";
import type { QuadrantNaming } from "../engine/quadrantNames";
import { gateRefLabel, EXCLUDE_HINT } from "./gateRefLabel";
import { isCopyRef, type HierarchyRef } from "../engine/hierarchies";
import { BranchIcon, ChevronIcon } from "./icons";
import { useGateColour, useGateInk, useGateSwatch } from "../plots/gateInk";

/**
 * The tree row: its name, how its files stand, and the ways back. Where an edit goes is each
 * gate's own scope (the gate list's chips and menus), not a setting of the tree.
 */
export interface TreeControlsProps {
  /** The viewed file's name; null with nothing loaded. */
  fileName: string | null;
  /** The viewed file's group, when it is in one, and its colour. */
  groupName: string | null;
  groupColour?: string | null;
  groupFiles: number;
  /** The group's tree has gates whose coordinates differ from the tree's. */
  groupTailored: boolean;
  /** What the viewed file follows: "the tree", or its group's name. */
  sourceLabel: string;
  /** The viewed file has gates whose coordinates differ from what it follows. */
  fileTailored: boolean;
  onRename: () => void;
  /** Name every quadrant gate's four populations by a scheme. */
  onNameQuadrants?: (scheme: QuadrantNaming) => void;
  /** A workspace saved with several trees: switch between them, and delete one, until one is left. */
  onSwitchTree?: (id: string) => void;
  onDeleteTree?: () => void;
  checkedCount: number;
  /** How many files have tailored gates, for Revert all. */
  tailoredFiles: number;
  /** Drop the viewed file's tailoring: it follows the tree, or its group, again. */
  onRevertFile?: () => void;
  /** Drop the group's tailoring: every gate of the group's tree takes the tree's coordinates. */
  onRevertGroup?: () => void;
  /** Drop the selected files' tailoring, after confirmation. */
  onRevertChecked?: () => void;
  /** Drop every file's tailoring, after confirmation. */
  onRevertAll?: () => void;
  /** What the viewed file (or its group) follows takes its coordinates, and every file follows it again. */
  onPromote?: () => void;
  /** Whose coordinates Promote gives, and to what: the file's or the group's name, and "the tree" or the group's. */
  promoteFrom?: string | null;
  promoteTo?: string;
  /** "17 files · all following", or how many are tailored. */
  summary?: string;
}

interface Props {
  state: CoreState;
  derived: Derived;
  dispatch: (a: Action) => void;
  perFile?: TreeControlsProps;
  /** Render the tree controls here; false when App places them above the gate list. */
  showHierarchyControls?: boolean;
  statsPending?: boolean;
  statsSampleCount?: number;
  displayContributorCount?: number;
  displayContributorNames?: readonly string[];
  /** Gates of this copy whose geometry differs from the tree's: FlowJo's tailored marks. */
  tailoredGateIds?: ReadonlySet<string>;
  /** Line the gate badges up in one column after the longest name; off, each row's follow its own name. */
  alignGates?: boolean;
  /** Counts below this are greyed; null marks none (the Statistics tab's "Minimum events"). */
  minEvents?: number | null;
  /**
   * The siblings each population shares events with, and how many, in `overlapFileName`: marked
   * on the row. Absent while the marker is off (the Populations ⋯ menu).
   */
  siblingOverlaps?: ReadonlyMap<string, readonly { name: string; shared: number }[]>;
  overlapFileName?: string;
}

function focusTreeContainer() {
  const c = document.getElementById("population_tree_container");
  if (c) c.focus({ preventScroll: true });
}

/** The tree the live hierarchy belongs to: itself, or the tree its copy (or its copy's group) follows. */
function treeOfLive(hierarchies: readonly HierarchyRef[], activeId: string): HierarchyRef | undefined {
  let cur = hierarchies.find((h) => h.id === activeId);
  const seen = new Set<string>();
  while (cur && isCopyRef(cur) && cur.source_hierarchy_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = hierarchies.find((h) => h.id === cur!.source_hierarchy_id) ?? cur;
    if (seen.has(cur.id)) break;
  }
  return cur;
}

/** How the population tree's rows are edited: the Populations header's "?" hint. */
export const POPULATION_TREE_HINT = "Click to select, Shift-click a range, Cmd/Ctrl-click to add or remove a row, Cmd/Ctrl-A every row; the selected rows are drawn together · Double-click a name to rename · Drag to move rows, Option-drag to copy them · ←/→ fold a branch, Option-click its triangle to fold every branch under it · Shift-click a gate to change/remove · + adds a gate";

/** The one tree's row above the gate list: its name with a menu of the tree's actions, and a summary. */
/**
 * The tree's own actions: rename it, name quadrant populations, the ways back (this file, its
 * group, the selected files, every file), using a copy's gates for what it follows, and, in an
 * old workspace with several trees, switching or deleting one. The Populations header's ⋯ menu
 * carries them now that the tree has no row of its own.
 */
export function treeMenuItems(state: CoreState, perFile: TreeControlsProps | undefined, t: Translate): MenuEntry[] {
  const hierarchies = state.hierarchies ?? [];
  const activeHierarchyId = state.active_hierarchy_id ?? hierarchies[0]?.id ?? "";
  const templates = hierarchies.filter((hierarchy) => !isCopyRef(hierarchy));
  const tree = treeOfLive(hierarchies, activeHierarchyId);
  // A workspace saved under the old model can hold several trees; they stay reachable, and
  // deletable, until one is left. Nothing here makes a second one.
  const legacy = templates.length > 1;
  const hasQuadrants = Object.values(state.gates).some((gate) => gate.gate_type === "quadrant");
  const namingTitle = t("Renames the four populations of every quadrant gate; the names shown in the Create quadrant gate dialog.");
  const revertItems = perFile
    ? [
        ...(perFile.onRevertFile
          ? [{
              label: perFile.fileName ? t("Revert {name} to {target}", { name: perFile.fileName, target: perFile.sourceLabel }) : t("Revert this file"),
              className: "population-tree-revert-group",
              title: t("Drop this file's tailoring: every gate takes the coordinates it follows again"),
              disabled: !perFile.fileTailored,
              onClick: perFile.onRevertFile,
            }]
          : []),
        ...(perFile.groupName && perFile.onRevertGroup
          ? [{
              label: t("Revert {name} to the tree", { name: perFile.groupName }),
              className: "population-tree-revert-groupcopy",
              title: t("Drop the group's tailoring: every gate of the group's tree takes the tree's coordinates again; files following the group follow along"),
              disabled: !perFile.groupTailored,
              onClick: perFile.onRevertGroup,
            }]
          : []),
        ...(perFile.onRevertChecked
          ? [{
              label: t("Revert {count} selected files…", { count: perFile.checkedCount }),
              className: "population-tree-revert-checked",
              title: t("Drop the selected files' tailoring, after confirmation. Unselected files and the tree stay unchanged."),
              disabled: perFile.checkedCount === 0,
              onClick: perFile.onRevertChecked,
            }]
          : []),
        ...(perFile.onRevertAll
          ? [{
              label: t("Revert all files…"),
              className: "population-tree-revert-all",
              title: t("Drop every file's tailoring, after confirmation: every file follows the tree."),
              disabled: perFile.tailoredFiles === 0,
              onClick: perFile.onRevertAll,
            }]
          : []),
        ...(perFile.onPromote && perFile.promoteFrom
          ? [{
              label: t("Use {name}'s gates for {target}…", { name: perFile.promoteFrom, target: perFile.promoteTo ?? t("the tree") }),
              className: "population-tree-promote",
              title: t("{target} takes every gate's coordinates from {name}, and every file following it follows again, its own tailoring dropped. Undo is available.", { name: perFile.promoteFrom, target: perFile.promoteTo ?? t("the tree") }),
              onClick: perFile.onPromote,
            }]
          : []),
      ]
    : [];
  const items: MenuEntry[] = [
    { label: t("Rename the tree…"), className: "population-tree-rename", title: t("The tree is called {name}.", { name: tree?.name ?? "" }), onClick: () => perFile?.onRename() },
    ...(perFile?.onNameQuadrants && hasQuadrants
      ? [
          { label: t("Name quadrant populations DN, DP, SP"), className: "population-tree-name-quadrants-dndp", title: namingTitle, onClick: () => perFile.onNameQuadrants?.("dndp") },
          { label: t("Name quadrant populations by signs"), className: "population-tree-name-quadrants-signs", title: namingTitle, onClick: () => perFile.onNameQuadrants?.("signs") },
        ]
      : []),
    ...(revertItems.length ? ["separator" as const, ...revertItems] : []),
    ...(legacy && perFile?.onSwitchTree
      ? ["separator" as const, ...templates.filter((candidate) => candidate.id !== tree?.id).map((candidate) => ({
          label: t("Switch to {name}", { name: candidate.name }),
          className: "population-tree-switch",
          onClick: () => perFile.onSwitchTree?.(candidate.id),
        }))]
      : []),
    ...(legacy && perFile?.onDeleteTree
      ? [{ label: t("Delete this tree…"), className: "population-tree-delete", danger: true, title: t("Its gates go with it; its files follow the tree that is left."), onClick: perFile.onDeleteTree }]
      : []),
  ];
  return items;
}

/** In a workspace saved with several trees, which others are still here; null otherwise. */
export function legacyTreeNote(state: CoreState, t: Translate): string | null {
  const hierarchies = state.hierarchies ?? [];
  const activeHierarchyId = state.active_hierarchy_id ?? hierarchies[0]?.id ?? "";
  const templates = hierarchies.filter((hierarchy) => !isCopyRef(hierarchy));
  if (templates.length <= 1) return null;
  const tree = treeOfLive(hierarchies, activeHierarchyId);
  return t("also here: {names} · switch or delete from the Populations ⋯ menu", { names: templates.filter((candidate) => candidate.id !== tree?.id).map((candidate) => candidate.name).join(", ") });
}

export function HierarchyControls({ state, perFile }: { state: CoreState; perFile?: TreeControlsProps }) {
  const { t } = useI18n();
  const hierarchies = state.hierarchies ?? [];
  const activeHierarchyId = state.active_hierarchy_id ?? hierarchies[0]?.id ?? "";
  const templates = hierarchies.filter((hierarchy) => !isCopyRef(hierarchy));
  const tree = treeOfLive(hierarchies, activeHierarchyId);
  const legacy = templates.length > 1;
  const items = treeMenuItems(state, perFile, t);
  return (
    <div className="population-tree-hierarchy">
      <div className="population-tree-hierarchy-row">
        <span title={t("The workspace's one tree. Its populations and gates apply to every file; a file can tailor a gate's coordinates without leaving it.")}>
          {t("Tree")}
        </span>
        <MenuButton label={tree?.name ?? ""} className="population-tree-name-menu" items={items} />
        {perFile?.summary && <span className="population-tree-hierarchy-count" title={perFile.summary}>{perFile.summary}</span>}
      </div>
      {legacy && (
        <div
          className="population-tree-hierarchy-row population-tree-legacy-note"
          title={t("This workspace was saved with several trees. GateLab now keeps one per workspace: switch to another from the tree menu, or delete it there, until one is left.")}
        >
          {t("also here: {names} · switch or delete from the Populations ⋯ menu", { names: templates.filter((candidate) => candidate.id !== tree?.id).map((candidate) => candidate.name).join(", ") })}
        </div>
      )}
    </div>
  );
}

type DropPlacement = "before" | "inside" | "after";

interface DropTarget {
  popId: string;
  placement: DropPlacement;
  valid: boolean;
}

interface PointerDrag {
  /** The rows being moved: the dragged row, or every checked row when it is checked. */
  popIds: string[];
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  dropTarget: DropTarget | null;
}

interface GateChoice {
  key: string;
  gateRef: GateRef;
  gate: Gate;
  shortLabel: string;
  label: string;
}

interface GatePickerState {
  popId: string;
  refIndex: number | null;
  /** Pending NOT state for the reference being added or changed. */
  exclude: boolean;
  left: number;
  top: number;
}

function gateRefKey(ref: GateRef): string {
  return `${ref.gate_id}:${ref.quadrant ?? ""}`;
}

function gateChoices(state: CoreState): GateChoice[] {
  const orderedIds = [
    ...state.gate_order,
    ...Object.keys(state.gates).filter((gateId) => !state.gate_order.includes(gateId)),
  ];
  return orderedIds.flatMap((gateId): GateChoice[] => {
    const gate = state.gates[gateId];
    if (!gate) return [];
    const suffix = `${gate.x_channel} / ${gate.y_channel}`;
    if (gate.gate_type !== "quadrant") {
      const gateRef: GateRef = { gate_id: gateId, include: true };
      return [{
        key: gateRefKey(gateRef),
        gateRef,
        gate,
        shortLabel: gate.name,
        label: `${gate.name} — ${suffix}`,
      }];
    }
    return [1, 2, 3, 4].map((quadrant) => {
      const gateRef: GateRef = { gate_id: gateId, include: true, quadrant };
      return {
        key: gateRefKey(gateRef),
        gateRef,
        gate,
        shortLabel: `${gate.name} [Q${quadrant}]`,
        label: `${gate.name} [Q${quadrant}] — ${suffix}`,
      };
    });
  });
}

export function PopulationTree({
  state,
  derived,
  dispatch,
  statsPending = false,
  statsSampleCount = 1,
  displayContributorCount,
  displayContributorNames,
  perFile,
  showHierarchyControls = true, tailoredGateIds, alignGates = true, minEvents = null, siblingOverlaps, overlapFileName }: Props) {
  const { t } = useI18n();
  const gateColour = useGateColour();
  const { coloured: colouredGates } = useGateInk();
  const gateSwatch = useGateSwatch();
  const { populations, root_population_id, active_population_id, selected_gate_id, selected_pop_ids, gates } = state;
  const structureLocked = state.hierarchies.some(
    (hierarchy) => hierarchy.id === state.active_hierarchy_id && hierarchy.structure_locked === true,
  );
  const stats = derived.stats;
  const choices = useMemo(() => gateChoices(state), [state.gate_order, state.gates]);
  const [editingName, setEditingName] = useState<{ popId: string; value: string } | null>(null);
  /** Branches folded away: their rows are not shown, and the branch draws as a leaf. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapsed = (popId: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(popId)) next.delete(popId); else next.add(popId);
    return next;
  });
  const [draggingPopIds, setDraggingPopIds] = useState<readonly string[]>([]);
  /** The highlighted rows: the active population and the others selected with it. */
  const highlighted = new Set<string>(
    [active_population_id, ...selected_pop_ids].filter((id): id is string => !!id && !!populations[id]),
  );
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [gatePicker, setGatePicker] = useState<GatePickerState | null>(null);
  const [gateQuery, setGateQuery] = useState("");
  const gatePickerRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pointerDragRef = useRef<PointerDrag | null>(null);
  const suppressRowClickRef = useRef(false);

  useEffect(() => {
    if (!editingName) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [editingName?.popId]);

  useEffect(() => {
    if (!gatePicker) return;
    const closeIfOutside = (event: PointerEvent) => {
      if (!gatePickerRef.current?.contains(event.target as Node)) setGatePicker(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGatePicker(null);
    };
    const closeOnViewportChange = (event: Event) => {
      // The gate catalogue owns its scroll position. Only scrolling elsewhere in the app should
      // dismiss the fixed-position picker.
      if (
        event.type === "scroll" &&
        event.target instanceof Node &&
        gatePickerRef.current?.contains(event.target)
      ) return;
      setGatePicker(null);
    };
    window.addEventListener("pointerdown", closeIfOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeIfOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [gatePicker]);

  useEffect(() => {
    if (editingName && !populations[editingName.popId]) setEditingName(null);
    if (gatePicker && !populations[gatePicker.popId]) setGatePicker(null);
  }, [editingName, gatePicker, populations]);

  // The keys the tree answers to while it has the focus (its container is App's, which also moves
  // the active row with ↑/↓): Escape back to the active row alone, Cmd/Ctrl-A every row, ←/→ fold
  // and unfold the active row's branch. What they act on is set each render, below.
  const keyState = useRef<{
    active: string | null; highlighted: ReadonlySet<string>; order: readonly string[];
    collapsed: ReadonlySet<string>; populations: CoreState["populations"];
    fold: (popId: string, folded: boolean, whole: boolean) => void;
  } | null>(null);
  useEffect(() => {
    const container = document.getElementById("population_tree_container");
    if (!container) return;
    const onKey = (event: KeyboardEvent) => {
      const keys = keyState.current;
      if (event.target !== container || !keys?.active) return;
      const { active } = keys;
      if (event.key === "Escape" && keys.highlighted.size > 1) {
        event.preventDefault();
        dispatch({ type: "selectPopulations", activeId: active, popIds: [] });
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        dispatch({ type: "selectPopulations", activeId: active, popIds: [...keys.order] });
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && keys.populations[active]?.children.length) {
        const fold = event.key === "ArrowLeft";
        if (fold === keys.collapsed.has(active)) return;
        event.preventDefault();
        keys.fold(active, fold, false);
      }
    };
    container.addEventListener("keydown", onKey);
    return () => container.removeEventListener("keydown", onKey);
  }, [dispatch]);

  if (!root_population_id || Object.keys(populations).length === 0) {
    return (
      <div className="population-tree-panel">
        <em style={{ display: "block", padding: "6px var(--gl-pane-padding)", color: "#999", fontSize: 12 }}>{t("No data loaded.")}</em>
      </div>
    );
  }

  const rows: React.ReactNode[] = [];
  const visited = new Set<string>();
  /** Every rendered row in display order; filled by the walk below, read by the handlers. */
  const orderedPopIds: string[] = [];

  const startRename = (event: React.MouseEvent, popId: string) => {
    if (structureLocked || popId === root_population_id) return;
    event.preventDefault();
    event.stopPropagation();
    setEditingName({ popId, value: populations[popId].name });
  };

  const commitRename = () => {
    if (!editingName) return;
    const name = editingName.value.trim();
    if (name) dispatch({ type: "renamePopulation", popId: editingName.popId, name });
    setEditingName(null);
  };

  const openGatePicker = (
    event: React.MouseEvent<HTMLElement>,
    popId: string,
    refIndex: number | null,
  ) => {
    if (structureLocked) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 300;
    const height = 360;
    setGateQuery("");
    const existing =
      refIndex === null ? null : populations[popId]?.gate_refs[refIndex] ?? null;
    setGatePicker({
      popId,
      refIndex,
      exclude: existing ? !existing.include : false,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  };

  const chooseGate = (choice: GateChoice) => {
    if (!gatePicker) return;
    const population = populations[gatePicker.popId];
    if (!population) return;
    const gateRefs = population.gate_refs.map((ref) => ({ ...ref }));
    const picked = { ...choice.gateRef, include: !gatePicker.exclude };
    if (gatePicker.refIndex === null) gateRefs.push(picked);
    else if (gatePicker.refIndex >= 0 && gatePicker.refIndex < gateRefs.length) {
      gateRefs[gatePicker.refIndex] = picked;
    } else {
      return;
    }
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
    setGatePicker(null);
  };

  const setPickerExclude = (exclude: boolean) => {
    if (!gatePicker) return;
    setGatePicker({ ...gatePicker, exclude });
    if (gatePicker.refIndex === null) return; // adding: applied when a gate is chosen
    const population = populations[gatePicker.popId];
    const current = population?.gate_refs[gatePicker.refIndex];
    if (!population || !current) return;
    const gateRefs = population.gate_refs.map((ref, index) =>
      index === gatePicker.refIndex ? { ...ref, include: !exclude } : { ...ref },
    );
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
  };

  const removePickedGate = () => {
    if (!gatePicker || gatePicker.refIndex === null) return;
    const population = populations[gatePicker.popId];
    if (!population) return;
    const gateRefs = population.gate_refs
      .filter((_, index) => index !== gatePicker.refIndex)
      .map((ref) => ({ ...ref }));
    dispatch({ type: "setPopulationGateRefs", popId: gatePicker.popId, gateRefs });
    setGatePicker(null);
  };

  const validDrop = (
    sourceIds: readonly string[],
    targetId: string,
    placement: DropPlacement,
  ): boolean => {
    if (!sourceIds.length || !populations[targetId]) return false;
    const destinationParentId =
      placement === "inside" ? targetId : populations[targetId].parent_id;
    if (!destinationParentId || !populations[destinationParentId]) return false;
    return sourceIds.every(
      (sourceId) =>
        sourceId !== root_population_id &&
        sourceId !== targetId &&
        !!populations[sourceId] &&
        !wouldCreateCycle(populations, sourceId, destinationParentId),
    );
  };

  /** The rows a drag starting on `popId` carries: the highlighted rows when it is one of them. */
  const dragSetFor = (popId: string): string[] => {
    if (!highlighted.has(popId)) return [popId];
    const ids = orderedPopIds.filter((id) => highlighted.has(id) && id !== root_population_id);
    return ids.length ? ids : [popId];
  };

  const resetPointerDrag = (row: HTMLDivElement, pointerId: number): void => {
    if (row.hasPointerCapture?.(pointerId)) row.releasePointerCapture(pointerId);
    pointerDragRef.current = null;
    setDraggingPopIds([]);
    setDropTarget(null);
  };

  /**
   * Highlight the rows from the active population to `popId`, in the order the tree shows,
   * replacing the previous range so a shorter one un-highlights.
   */
  const highlightRangeTo = (popId: string): void => {
    const anchor = active_population_id && orderedPopIds.includes(active_population_id) ? active_population_id : popId;
    const a = orderedPopIds.indexOf(anchor);
    const b = orderedPopIds.indexOf(popId);
    if (a < 0 || b < 0) return;
    dispatch({ type: "selectPopulations", activeId: anchor, popIds: orderedPopIds.slice(Math.min(a, b), Math.max(a, b) + 1) });
  };

  /** Add or remove one row from the highlight; the active row itself stays highlighted. */
  const toggleHighlight = (popId: string): void => {
    if (popId === active_population_id || !active_population_id) return;
    const next = highlighted.has(popId) ? [...highlighted].filter((id) => id !== popId) : [...highlighted, popId];
    dispatch({ type: "selectPopulations", activeId: active_population_id, popIds: next });
  };

  /** Fold or unfold a branch; with every branch under it too when `whole`. */
  const setBranchFolded = (popId: string, folded: boolean, whole: boolean): void => {
    const ids = [popId];
    if (whole) for (let i = 0; i < ids.length; i++) ids.push(...(populations[ids[i]]?.children ?? []));
    setCollapsed((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (!populations[id]?.children.length) continue;
        if (folded) next.add(id); else next.delete(id);
      }
      return next;
    });
  };

  keyState.current = { active: active_population_id, highlighted, order: orderedPopIds, collapsed, populations, fold: setBranchFolded };

  const updatePointerDropTarget = (
    sourceIds: readonly string[],
    clientX: number,
    clientY: number,
  ): DropTarget | null => {
    const pointed = document.elementFromPoint(clientX, clientY);
    const row = pointed instanceof Element ? pointed.closest<HTMLElement>(".pop-row") : null;
    const targetId = row?.dataset.popId;
    if (!row || !targetId || !populations[targetId]) return null;
    const rect = row.getBoundingClientRect();
    const position = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const placement: DropPlacement = targetId === root_population_id
      ? "inside"
      : position < 0.28
        ? "before"
        : position > 0.72
          ? "after"
          : "inside";
    return {
      popId: targetId,
      placement,
      valid: validDrop(sourceIds, targetId, placement),
    };
  };

  const descendantCount = (popId: string): number => {
    let n = 0;
    const walk = (id: string) => { for (const c of populations[id]?.children ?? []) { n += 1; walk(c); } };
    walk(popId);
    return n;
  };
  const appendRows = (popId: string, depth: number, isLastPath: boolean[]) => {
    if (visited.has(popId)) return;
    visited.add(popId);
    const pop = populations[popId];
    if (!pop) return;
    orderedPopIds.push(popId);

    const isActive = popId === active_population_id;
    const isRoot = popId === root_population_id;
    const countVal = stats.event_count[popId] ?? pop.event_count;
    const pctParent = stats.percent_of_parent[popId] ?? pop.percent_of_parent;
    const pctTotal = stats.percent_of_total[popId];
    const countText = statsPending
      ? "…"
      : countVal != null
        ? countVal.toLocaleString()
        : "?";
    const low = !isRoot && !statsPending && minEvents !== null && countVal != null && countVal < minEvents;
    const lowClass = low ? " pop-row-low" : "";
    let pctText = "";
    if (!isRoot && !statsPending) {
      const parts: string[] = [];
      if (pctParent != null) parts.push(`${pctParent}% pnt`);
      if (pctTotal != null) parts.push(`${pctTotal}% tot`);
      if (parts.length) pctText = `(${parts.join(", ")})`;
    }

    rows.push(
      <div
        key={popId}
        className={
          "pop-row" +
          (isActive ? " active" : highlighted.has(popId) ? " highlighted" : "") +
          (draggingPopIds.includes(popId) ? " dragging" : "") +
          (dropTarget?.popId === popId
            ? ` drop-${dropTarget.placement}${dropTarget.valid ? "" : " drop-invalid"}`
            : "")
        }
        data-pop-id={popId}
        onClick={(event) => {
          if (suppressRowClickRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const target = event.target instanceof Element ? event.target : null;
          const onControl = !!target?.closest("button, input, .pop-tree-gate-badge");
          if (!isRoot && !onControl && event.shiftKey) {
            highlightRangeTo(popId);
            focusTreeContainer();
            return;
          }
          if (!isRoot && !onControl && (event.metaKey || event.ctrlKey)) {
            toggleHighlight(popId);
            focusTreeContainer();
            return;
          }
          dispatch({ type: "selectPopulations", activeId: popId, popIds: [] });
          focusTreeContainer();
        }}
        onPointerDown={(event) => {
          // A plain drag moves rows. Shift and Cmd/Ctrl are the SELECTION modifiers and never
          // start a drag, so shift-click still highlights a range and cmd-click still toggles a
          // row. A plain click is unaffected because a drag needs 8 px of movement before it
          // becomes one, so press-and-release still just makes the row active.
          //
          // Dragging a highlighted row still moves the whole highlighted set: dragSetFor()
          // returns it, so select-then-drag works without the modifier being held during the
          // drag itself, which is what made the old gesture awkward.
          if (structureLocked || isRoot || event.button !== 0) return;
          if (event.shiftKey || event.metaKey || event.ctrlKey) return;
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest("button, input, .pop-tree-gate-badge")) return;
          pointerDragRef.current = {
            popIds: dragSetFor(popId),
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            dropTarget: null,
          };
          // The pointer is captured only once the drag is real (below): capturing here sent the
          // click and double-click to the row instead of the name, so double-click to rename
          // worked only with Shift held, which skips the drag altogether.
        }}
        onPointerMove={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (!drag.active) {
            const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
            // 8 px, not 4: a click that slips a little on a trackpad became a drag, and a drop on
            // the row below reparented the population.
            if (moved < 8) return;
            drag.active = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDraggingPopIds(drag.popIds);
          }
          event.preventDefault();
          const nextTarget = updatePointerDropTarget(drag.popIds, event.clientX, event.clientY);
          drag.dropTarget = nextTarget;
          setDropTarget(nextTarget);
        }}
        onPointerUp={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (drag.active) {
            event.preventDefault();
            suppressRowClickRef.current = true;
            window.setTimeout(() => {
              suppressRowClickRef.current = false;
            }, 0);
          }
          if (drag.active && drag.dropTarget?.valid) {
            // Option (Alt) held at the drop copies the rows there, gates shared, the originals
            // staying put: the way to gate the same quadrant under several parents.
            dispatch(
              event.altKey
                ? { type: "copyPopulations", popIds: drag.popIds, targetId: drag.dropTarget.popId, placement: drag.dropTarget.placement }
                : drag.popIds.length === 1
                  ? { type: "movePopulation", popId: drag.popIds[0], targetId: drag.dropTarget.popId, placement: drag.dropTarget.placement }
                  : { type: "movePopulations", popIds: drag.popIds, targetId: drag.dropTarget.popId, placement: drag.dropTarget.placement },
            );
          }
          resetPointerDrag(event.currentTarget, event.pointerId);
        }}
        onPointerCancel={(event) => {
          const drag = pointerDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          resetPointerDrag(event.currentTarget, event.pointerId);
        }}
      >
        <span className="pop-row-name-col">
          <TreeConnectors depth={depth} isLastPath={isLastPath} fill />
          {/* Below the root the triangle takes no width: its slot lies over the end of the
              connector's arm, so the arm meets the name, and showing the triangle (hover, focus,
              a folded branch) never moves the name. The root has no arm, so its slot is in line. */}
          <span className={"pop-row-disclosure-slot" + (depth > 0 ? " is-over-arm" : "")}>
          {pop.children.length > 0 ? (
            <button
              type="button"
              className="pop-row-disclosure"
              aria-label={collapsed.has(popId) ? t("Show the populations under {name}", { name: pop.name }) : t("Hide the populations under {name}", { name: pop.name })}
              aria-expanded={!collapsed.has(popId)}
              title={collapsed.has(popId) ? t("{count} hidden", { count: descendantCount(popId) }) : t("Option-click folds every branch under it too")}
              onClick={(event) => {
                event.stopPropagation();
                if (event.altKey) setBranchFolded(popId, !collapsed.has(popId), true);
                else toggleCollapsed(popId);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <ChevronIcon open={!collapsed.has(popId)} size={12} />
            </button>
          ) : (
            <span className="pop-row-disclosure is-leaf" aria-hidden="true" />
          )}
          </span>
          {editingName?.popId === popId ? (
            <input
              className="pop-row-name-input"
              value={editingName.value}
              aria-label={t("Population name")}
              ref={renameInputRef}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onChange={(event) => setEditingName({ popId, value: event.target.value })}
              onBlur={commitRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditingName(null);
                }
              }}
            />
          ) : (
            <span
              className="pop-row-name"
              title={isRoot ? pop.name : `${pop.name}\n${t("Double-click to rename")}`}
              onDoubleClick={(event) => startRename(event, popId)}
            >
              {pop.name}
            </span>
          )}
          {siblingOverlaps?.get(popId)?.length ? (
            <span
              className="pop-row-overlap"
              title={siblingOverlaps.get(popId)!
                .map((o) => t("Shares {count} events with {name} in {file}", { count: o.shared.toLocaleString(), name: o.name, file: overlapFileName ?? "" }))
                .join("\n")}
            >∩</span>
          ) : null}
        </span>
        <span className="pop-row-gates-col">
          <span className="pop-row-gates">
            {pop.gate_refs.map((ref, i) => {
              const gate = gates[ref.gate_id];
              if (!gate) return null;
              const isSelGate = ref.gate_id === selected_gate_id;
              const cls =
                "gate-ref-badge pop-tree-gate-badge" +
                (tailoredGateIds?.has(ref.gate_id) ? " is-tailored" : "") +
                (!ref.include ? " exclude" : "") +
                (isSelGate ? " selected-gate" : "") +
                (colouredGates ? " is-coloured" : "");
              return (
                <span
                  key={i}
                  className={cls}
                  // The pill is a tint of this colour with dark text (styles.css); the colour itself shows as its edge, and as a dot in a narrow pane.
                  style={{ "--gate-colour": gateColour(gate.color) } as React.CSSProperties}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey && !isRoot && !structureLocked) openGatePicker(e, popId, i);
                    else dispatch({ type: "selectGate", gateId: ref.gate_id });
                  }}
                  title={`${gateRefLabel(gate.name, ref.include, ref.quadrant)}\n${structureLocked
                    ? t("Click to select. This tree follows its group's template: change the reference there, or unlink the tree from its group.")
                    : t("Click to select; Shift-click to change, exclude (NOT), or remove")}${tailoredGateIds?.has(ref.gate_id) ? `\n${t("Tailored for the file in view.")}` : ""}`}
                >
                  {tailoredGateIds?.has(ref.gate_id) && <BranchIcon size={9} />}
                  <span className="pop-tree-gate-badge-text">{gateRefLabel(gate.name, ref.include, ref.quadrant)}</span>
                </span>
              );
            })}
            {!isRoot && choices.length > 0 && (
              <button
                type="button"
                className="gate-ref-badge pop-tree-gate-add"
                aria-label={t("Add a gate to this population")}
                title={structureLocked
                  ? t("Add the gate on the group's template, or unlink this tree from its group")
                  : t("Add a gate to this population")}
                disabled={structureLocked}
                onClick={(event) => openGatePicker(event, popId, null)}
              >
                +
              </button>
            )}
          </span>
        </span>
        <span className={"pop-row-count" + lowClass} title={low ? t("Fewer than {min} events", { min: minEvents!.toLocaleString() }) : undefined}>{countText}</span>
        <span className={"pop-row-pct" + lowClass}>{pctText}</span>
        {/* In a narrow pane the percentage of the parent alone, the full line in the tooltip (styles.css). */}
        {pctText && <span className={"pop-row-pct-short" + lowClass} title={pctText}>{stats.percent_of_parent[popId] ?? pop.percent_of_parent}%</span>}
      </div>,
    );

    const childIds = [...new Set(pop.children)].filter((c) => c in populations);
    if (!collapsed.has(popId)) childIds.forEach((cid, i) => appendRows(cid, depth + 1, [...isLastPath, i === childIds.length - 1]));
  };

  appendRows(root_population_id, 0, []);

  const pickerPopulation = gatePicker ? populations[gatePicker.popId] : null;
  const pickerCurrentRef =
    gatePicker?.refIndex !== null && gatePicker?.refIndex !== undefined && pickerPopulation
      ? pickerPopulation.gate_refs[gatePicker.refIndex]
      : null;
  const pickerCurrentChoice = pickerCurrentRef
    ? choices.find((choice) => choice.key === gateRefKey(pickerCurrentRef)) ?? null
    : null;
  const usedKeys = new Set(
    (pickerPopulation?.gate_refs ?? [])
      .filter((_, index) => index !== gatePicker?.refIndex)
      .map(gateRefKey),
  );
  const query = gateQuery.trim().toLocaleLowerCase();
  const availableChoices = choices.filter(
    (choice) => !usedKeys.has(choice.key) && (!query || choice.label.toLocaleLowerCase().includes(query)),
  );

  return (
    <div className="population-tree-panel">
      {showHierarchyControls && (
        <HierarchyControls state={state} perFile={perFile} />
      )}
      {/* How the rows are edited is the Populations header's "?" hint (POPULATION_TREE_HINT); the
          strip is drawn only for the pooled-count note, so a single file's tree starts at its rows. */}
      {statsSampleCount > 1 && (
        <div className="population-tree-hint">
          <strong
            title={
              displayContributorNames
                ? t("Selected display contributors: {files}", {
                    files: displayContributorNames.length
                      ? displayContributorNames.join(", ")
                      : t("None"),
                  })
                : undefined
            }
          >
            {statsPending
              ? t("Pooling {count} files…", { count: statsSampleCount })
              : displayContributorCount === undefined
                ? t("Counts pooled across {count} files", { count: statsSampleCount })
                : t("Pooled counts: {count} FCS · selected display: {contributing} contribute", {
                    count: statsSampleCount,
                    contributing: displayContributorCount,
                  })}
          </strong>
        </div>
      )}
      {/* A click on empty space below the rows goes back to the active row alone. */}
      <div
        className={`population-tree-rows${alignGates ? " is-aligned" : ""}`}
        onClick={(event) => {
          if (event.target === event.currentTarget && active_population_id && highlighted.size > 1) {
            dispatch({ type: "selectPopulations", activeId: active_population_id, popIds: [] });
          }
        }}
      >{rows}</div>
      {gatePicker && pickerPopulation && (
        <div
          ref={gatePickerRef}
          className="pop-gate-picker"
          role="dialog"
          aria-label={gatePicker.refIndex === null ? t("Add gate") : t("Change gate")}
          style={{ left: gatePicker.left, top: gatePicker.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pop-gate-picker-title">
            <span>
              {gatePicker.refIndex === null
                ? t("Add gate")
                : t("Change gate: {gate}", {
                    gate: pickerCurrentChoice?.shortLabel ?? t("Unknown gate"),
                  })} · {pickerPopulation.name}
            </span>
            <button type="button" onClick={() => setGatePicker(null)} aria-label={t("Close")}>×</button>
          </div>
          {pickerCurrentChoice && (
            <div className="pop-gate-picker-current">
              {gateSwatch(pickerCurrentChoice.gate.color) && (
                <span
                  className="pop-gate-picker-swatch"
                  style={{ background: gateSwatch(pickerCurrentChoice.gate.color)! }}
                />
              )}
              <span><strong>{t("Current gate")}:</strong> {pickerCurrentChoice.shortLabel}</span>
            </div>
          )}
          <label className="pop-gate-picker-not" title={t(EXCLUDE_HINT)}>
            <input
              type="checkbox"
              checked={gatePicker.exclude}
              onChange={(event) => setPickerExclude(event.target.checked)}
            />
            <span>
              <strong>{t("NOT")}</strong> — {t("keep events outside this gate")}
            </span>
          </label>
          {gatePicker.refIndex !== null && (
            <button type="button" className="pop-gate-picker-remove" onClick={removePickedGate}>
              {t("Remove this gate from the population")}
            </button>
          )}
          <input
            className="pop-gate-picker-search"
            value={gateQuery}
            autoFocus
            placeholder={t("Find a gate…")}
            aria-label={t("Find a gate")}
            onChange={(event) => setGateQuery(event.target.value)}
          />
          <div className="pop-gate-picker-list">
            {availableChoices.map((choice) => (
              <button
                type="button"
                key={choice.key}
                className={
                  "pop-gate-picker-choice" +
                  (pickerCurrentRef && gateRefKey(pickerCurrentRef) === choice.key ? " current" : "")
                }
                onClick={() => chooseGate(choice)}
              >
                {gateSwatch(choice.gate.color) && <span className="pop-gate-picker-swatch" style={{ background: gateSwatch(choice.gate.color)! }} />}
                <span className="pop-gate-picker-choice-label">{choice.label}</span>
                {pickerCurrentRef && gateRefKey(pickerCurrentRef) === choice.key && (
                  <span className="pop-gate-picker-current-badge">{t("Current")}</span>
                )}
              </button>
            ))}
            {availableChoices.length === 0 && (
              <div className="pop-gate-picker-empty">{t("No available gates match.")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
