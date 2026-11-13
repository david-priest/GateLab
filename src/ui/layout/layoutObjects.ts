// layoutObjects.ts — a Layout sheet's items as an objects list: each item's name (its own, else
// one made from what it is), which items are hidden, the list's rows in stacking order with the
// members of a group under a row for the group, reordering the stack from the list, and the id an
// item's group takes in an SVG export when it has a name of its own (objectExportId.ts).

import type { LayoutItem, LayoutSheet } from "../../engine/layout";
import { isPanelLetter } from "./panelLetters";
import { CHART_STATISTIC_LABELS } from "../LayoutChart";
import { statisticTitle } from "../StatisticChart";

type Translate = (source: string, values?: Record<string, string | number>) => string;

const fill: Translate = (source, values) =>
  source.replace(/\{(\w+)\}/g, (whole, key: string) => (values && key in values ? String(values[key]) : whole));

/** What a default name needs to know of the workspace: a file's name and a population's, by id. */
export interface ObjectNaming {
  fileName: (sampleId: string) => string | undefined;
  populationName: (sampleId: string, populationId: string) => string | undefined;
}

/** Naming from the tab's prepared files: each file's name, and its tree's populations' names. */
export function objectNaming(samples: readonly { id: string; name: string; tree: { populations: Readonly<Record<string, { name: string } | undefined>> } }[]): ObjectNaming {
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  return {
    fileName: (sampleId) => byId.get(sampleId)?.name,
    populationName: (sampleId, populationId) => byId.get(sampleId)?.tree.populations[populationId]?.name,
  };
}

/** A short word for an item's kind, shown at the start of its row. */
export function objectKindWord(item: Pick<LayoutItem, "recipe">, t: Translate = fill): string {
  const kind = item.recipe.kind as string;
  if (isPanelLetter(item)) return t("Letter");
  switch (kind) {
    case "biplot": return t("Plot");
    case "histogram": return t("Histogram");
    case "strategy": return t("Strategy");
    case "chart":
    case "proportions": return t("Chart");
    case "figure": return t("Figure");
    case "text": return t("Text");
    case "imagewall": return t("Images");
    case "cellpanel": return t("Cell panel");
    case "shape": return t("Shape");
    case "image": return t("Image");
    default: return kind;
  }
}

/** The first words of a text, at most `count` of them, on its first line that has any. */
function firstWords(text: string, count = 5): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const words = line.split(/\s+/).filter(Boolean);
  return words.length > count ? `${words.slice(0, count).join(" ")}…` : words.join(" ");
}

/**
 * The name an item has when it has none of its own, made from what it is: a plot's population
 * and file (or how many files it pools), a strategy's population, a chart's kind, a figure's
 * name, a text block's first words, a panel letter's letter, a placed image's file name.
 */
export function defaultObjectName(item: LayoutItem, naming: ObjectNaming, t: Translate = fill): string {
  const recipe = item.recipe;
  if (recipe.kind === "text") {
    if (isPanelLetter(item)) return t("Panel letter {letter}", { letter: recipe.text || "?" });
    return firstWords(recipe.text) || t("Text");
  }
  if (recipe.kind === "figure") return recipe.illustration.figure?.name?.trim() || t("Figure");
  if (recipe.kind === "proportions") {
    const settings = recipe.settings;
    const chart = settings.valueKind === "cells"
      ? t("{channel} per cell", { channel: settings.channel || t("Channel") })
      : settings.valueKind === "statistic"
        ? statisticTitle(settings.statistic, settings.channel || "channel")
        : settings.plotType === "box" ? t("Boxplot") : t("Composition");
    if (!recipe.panel) return chart;
    if ("legend" in recipe.panel) return `${chart} · ${t("legend")}`;
    const panel = recipe.panel;
    const which = [panel.population, panel.group, panel.facet, panel.channel, panel.page].filter((part): part is string => !!part);
    return which.length ? `${chart} · ${which.join(" · ")}` : chart;
  }
  if (recipe.kind === "imagewall") return `${recipe.populationName || t("Population")} · ${recipe.fileName || t("images")}`;
  if (recipe.kind === "cellpanel") return `${t("{count} cells", { count: recipe.cells.length })} · ${recipe.fileName || t("images")}`;
  if (recipe.kind === "image") return recipe.fileName;
  if (!("sampleId" in recipe) || !("populationId" in recipe)) return objectKindWord(item, t);
  const population = naming.populationName(recipe.sampleId, recipe.populationId) ?? t("Population");
  if (recipe.kind === "chart") return `${population} · ${t(CHART_STATISTIC_LABELS[recipe.statistic])}`;
  if (recipe.kind === "strategy") return t("{population} strategy", { population });
  const pooled = (recipe.kind === "biplot" || recipe.kind === "histogram") && recipe.pool && recipe.pool.sampleIds.length > 1 ? recipe.pool.sampleIds.length : 0;
  if (pooled) return `${population} · ${t("{count} files", { count: pooled })}`;
  return `${population} · ${naming.fileName(recipe.sampleId) ?? t("file")}`;
}

/** An item's name: its own when it has one, else its default. */
export function objectName(item: LayoutItem, naming: ObjectNaming, t: Translate = fill): string {
  return item.name?.trim() || defaultObjectName(item, naming, t);
}

/** Give an item a name of its own, in place; an empty name takes it back to its default. */
export function renameObject(sheet: LayoutSheet, id: string, name: string): void {
  const item = sheet.items.find((candidate) => candidate.id === id);
  if (!item) return;
  const trimmed = name.trim();
  if (trimmed) item.name = trimmed;
  else delete item.name;
}

/** Hide or show the items named, in place. */
export function setObjectsHidden(sheet: LayoutSheet, ids: readonly string[], hidden: boolean): void {
  for (const item of sheet.items) {
    if (!ids.includes(item.id)) continue;
    if (hidden) item.hidden = true;
    else delete item.hidden;
  }
}

/** Lock or unlock the items named, in place. */
export function setObjectsLocked(sheet: LayoutSheet, ids: readonly string[], locked: boolean): void {
  for (const item of sheet.items) if (ids.includes(item.id)) item.locked = locked;
}

/**
 * The ids of the items the page does not draw: those hidden, and the panel letter of an item that
 * is hidden, since a letter stands for its item.
 */
export function hiddenItemIds(sheet: Pick<LayoutSheet, "items"> | null | undefined): Set<string> {
  const hidden = new Set<string>();
  if (!sheet) return hidden;
  for (const item of sheet.items) if (item.hidden) hidden.add(item.id);
  if (!hidden.size) return hidden;
  for (const item of sheet.items) if (isPanelLetter(item) && hidden.has(item.recipe.letterFor)) hidden.add(item.id);
  return hidden;
}

/** The expanded pages of a sheet without the items it hides, so the page neither draws, selects, snaps to nor exports them. */
export function withoutHiddenItems<P extends { items: readonly { templateId: string }[] }>(pages: P[], sheet: Pick<LayoutSheet, "items">): P[] {
  const hidden = hiddenItemIds(sheet);
  return hidden.size ? pages.map((page) => ({ ...page, items: page.items.filter((item) => !hidden.has(item.templateId)) })) : pages;
}

/** A row of the list: an item, or a group with its members, each list top of the stack first. */
export type ObjectEntry =
  | { kind: "item"; key: string; item: LayoutItem }
  | { kind: "group"; key: string; group: string; members: LayoutItem[] };

/** The key of a group's row, apart from any item id. */
export const groupKey = (group: string) => `group:${group}`;

/**
 * The sheet's items as the list shows them, top of the stack first. A group's row stands where
 * its topmost member is, with every member under it, also top first.
 */
export function objectEntries(sheet: Pick<LayoutSheet, "items">): ObjectEntry[] {
  const ordered = [...sheet.items].sort((a, b) => b.z - a.z);
  const entries: ObjectEntry[] = [];
  const seen = new Set<string>();
  for (const item of ordered) {
    if (!item.group) {
      entries.push({ kind: "item", key: item.id, item });
      continue;
    }
    if (seen.has(item.group)) continue;
    seen.add(item.group);
    entries.push({ kind: "group", key: groupKey(item.group), group: item.group, members: ordered.filter((other) => other.group === item.group) });
  }
  return entries;
}

/** The entries flattened to item ids, top of the stack first. */
function flatten(entries: readonly ObjectEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "item" ? [entry.item.id] : entry.members.map((member) => member.id)));
}

/** Stack the sheet's items in the order given, top first: z becomes 0 … n−1 from the bottom. */
function restack(sheet: LayoutSheet, topFirst: readonly string[]): void {
  const byId = new Map(sheet.items.map((item) => [item.id, item]));
  topFirst.forEach((id, index) => {
    const item = byId.get(id);
    if (item) item.z = topFirst.length - 1 - index;
  });
}

/** The keys moved, in their order, to sit before the key at `index` of `keys` (or at the end). */
function moveKeys(keys: readonly string[], moving: ReadonlySet<string>, index: number): string[] {
  const picked = keys.filter((key) => moving.has(key));
  if (!picked.length) return [...keys];
  const before = keys.slice(0, index).filter((key) => !moving.has(key));
  const after = keys.slice(index).filter((key) => !moving.has(key));
  return [...before, ...picked, ...after];
}

/**
 * Reorder the stack from the list, in place: the rows named (items or group rows at the top level,
 * or members of one group) move to sit before the row at `index` of their level, top first. With
 * `within`, the rows are members of that group and move among its members only. A group's members
 * end up next to one another in the stack.
 */
export function moveObjects(sheet: LayoutSheet, keys: readonly string[], index: number, within?: string): void {
  const entries = objectEntries(sheet);
  const moving = new Set(keys);
  if (within) {
    const at = entries.findIndex((entry) => entry.kind === "group" && entry.group === within);
    const entry = entries[at];
    if (!entry || entry.kind !== "group") return;
    const order = moveKeys(entry.members.map((member) => member.id), moving, index);
    const byId = new Map(entry.members.map((member) => [member.id, member]));
    entries[at] = { ...entry, members: order.map((id) => byId.get(id)!) };
    restack(sheet, flatten(entries));
    return;
  }
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const order = moveKeys(entries.map((entry) => entry.key), moving, index);
  restack(sheet, flatten(order.map((key) => byKey.get(key)!)));
}

/** Step the rows named one place up (towards the top of the stack) or down their level, in place. */
export function stepObjects(sheet: LayoutSheet, keys: readonly string[], direction: -1 | 1, within?: string): void {
  const entries = objectEntries(sheet);
  const level = within
    ? (entries.find((entry) => entry.kind === "group" && entry.group === within) as Extract<ObjectEntry, { kind: "group" }> | undefined)?.members.map((member) => member.id) ?? []
    : entries.map((entry) => entry.key);
  const moving = new Set(keys);
  const indices = level.map((key, index) => (moving.has(key) ? index : -1)).filter((index) => index >= 0);
  if (!indices.length) return;
  // Before the row above the first moving one, or after the row below the last.
  const target = direction < 0 ? Math.max(0, indices[0] - 1) : Math.min(level.length, indices[indices.length - 1] + 2);
  moveObjects(sheet, keys, target, within);
}
