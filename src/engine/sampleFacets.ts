// sampleFacets.ts — choosing sets of samples by their metadata.
//
// A hosted SCE arrives with per-sample metadata already filled in: GateLabR collapses every
// colData column that is constant within a sample and ships one value per sample, which App turns
// into the same `metadata` map the Metadata tab edits. A 60-sample workspace is therefore already
// describable as donor × cell type × stimulation × batch — this module turns that description into
// clickable groups.
//
// A chip is a bulk checkbox for its group, and nothing more. Clicking one checks every sample
// carrying that value, or unchecks them if they are already all checked. There is no separate
// filter state to reason about: what a chip looks like is simply how much of its group is checked,
// and clicking it changes exactly that.
//
// This is deliberately set arithmetic rather than a query. A query ANDs its terms, so picking a
// stimulation and then a cell type would narrow to their intersection -- whereas what someone
// reading a sample list wants from that second click is to drop that cell type from the selection.
//
// The toggle is pure so it can be tested without rendering, which matters because the checked set
// drives pooled display, Statistics and Proportions: a mistake here is a number reported over the
// wrong files, and nothing downstream would flag it.

import { distinctValues, type MetadataColumn } from "./metadata";

/** Per-sample metadata, keyed by sample id then field — the shape App holds in `metadata`. */
export type SampleMetadata = Record<string, Record<string, string>>;

export interface FacetValue {
  value: string;
  /** Sample ids carrying this value, in the order the samples were given. */
  sampleIds: string[];
}

export interface FacetColumn {
  name: string;
  values: FacetValue[];
  /** Samples carrying a value here, and how many there are; unequal means the column has holes. */
  covered: number;
  sampleCount: number;
}

/**
 * A column is only worth a row of chips when it actually divides the samples.
 *
 * One distinct value cannot filter anything. A value per sample — a barcode, a well id, the sample
 * name itself — is a wall of chips that each select one row, which is slower than the list it sits
 * above. The upper cap alone does not catch that: an identifier only exceeds twelve values once the
 * workspace has more than twelve samples, so a small workspace would show its barcodes as facets.
 * Comparing against the sample count catches it at any size.
 *
 * Everything outside the range stays reachable through the columns control — hidden, not
 * discarded, because which columns matter is the user's judgement and not ours.
 */
export const FACET_MIN_VALUES = 2;
export const FACET_MAX_VALUES = 12;

/** How many samples carry a value for this column. */
export function columnCoverage(metadata: SampleMetadata, column: string): number {
  return Object.values(metadata).reduce(
    (count, row) => count + Number(Boolean(row[column])), 0);
}

/**
 * Whether a column describes the samples themselves.
 *
 * A gate saved into colData is per-EVENT, so R skips it for any sample holding a mix of TRUE and
 * FALSE but still ships it for samples that happen to be entirely one or the other. The column
 * then arrives looking like sample metadata with holes in it, and chips built from it would count
 * only the handful of samples that happened to be uniform -- a selection that means nothing.
 * Requiring a value for every sample is what separates "a property of this sample" from "a
 * summary of its events that happened to be constant".
 *
 * Such a column stays available through the columns control, marked, because deciding it is
 * useless is not ours to do -- only deciding it is not automatic.
 */
export function isAutoFacetColumn(metadata: SampleMetadata, column: string): boolean {
  const sampleCount = Object.keys(metadata).length;
  const count = distinctValues(metadata, column).length;
  if (count < FACET_MIN_VALUES || count > FACET_MAX_VALUES) return false;
  if (columnCoverage(metadata, column) < sampleCount) return false;
  return count < sampleCount;
}

/**
 * The chip rows to draw.
 *
 * `shown` is the user's explicit choice of columns; when it is undefined every column that divides
 * the samples is offered. A column the user pinned is honoured even if it falls outside the
 * automatic range, and a column that no longer exists in the metadata is dropped rather than
 * rendered empty.
 */
export function facetColumns(
  metadata: SampleMetadata,
  columns: readonly MetadataColumn[],
  shown?: readonly string[],
): FacetColumn[] {
  const wanted = shown
    ? (name: string) => shown.includes(name)
    : (name: string) => isAutoFacetColumn(metadata, name);
  return columns
    .filter((column) => wanted(column.name))
    .map((column) => ({
      name: column.name,
      values: facetValues(metadata, column),
      covered: columnCoverage(metadata, column.name),
      sampleCount: Object.keys(metadata).length,
    }))
    .filter((column) => column.values.length > 0);
}

/**
 * The chips for one column, each carrying the samples it covers.
 *
 * `MetadataColumn.levels` is honoured when present so an ordered factor keeps its own order rather
 * than first-seen order; levels naming no sample are dropped.
 */
export function facetValues(metadata: SampleMetadata, column: MetadataColumn): FacetValue[] {
  const present = distinctValues(metadata, column.name);
  const ordered = column.levels
    ? column.levels.filter((level) => present.includes(level))
    : present;
  return ordered.map((value) => ({
    value,
    sampleIds: Object.keys(metadata).filter((id) => metadata[id]?.[column.name] === value),
  }));
}

/** How much of a group is currently checked — the chip's whole appearance. */
export function groupCheckedCount(
  group: readonly string[],
  excluded: ReadonlySet<string>,
): number {
  return group.reduce((count, id) => count + Number(!excluded.has(id)), 0);
}

/**
 * Check every sample in the group, or uncheck them when they are already all checked.
 *
 * A partly-checked group completes rather than clearing, which is how a tri-state checkbox
 * behaves everywhere else: the first click on something ambiguous should add, not take away.
 */
export function toggleGroupChecked(
  group: readonly string[],
  excluded: ReadonlySet<string>,
): Set<string> {
  const next = new Set(excluded);
  const allChecked = groupCheckedCount(group, excluded) === group.length;
  for (const id of group) {
    if (allChecked) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * The values a locked row holds fixed, by column name.
 *
 * A lock is the one piece of memory the board has. Set arithmetic alone cannot express "hold the
 * cell type at CTL while I flip the stimulation": once the checked set is CTL and unstimulated,
 * those samples no longer record that CTL was the reason the other unstimulated files are out, so
 * the next click on a stimulation chip can only complete its whole group or clear it. Freezing the
 * column is what gives the later clicks something to be bounded by.
 */
export type FacetLocks = Readonly<Record<string, readonly string[]>>;

/** The values in a column with at least one checked sample -- what locking the row freezes. */
export function checkedValues(column: FacetColumn, excluded: ReadonlySet<string>): string[] {
  return column.values
    .filter((entry) => entry.sampleIds.some((id) => !excluded.has(id)))
    .map((entry) => entry.value);
}

/**
 * The samples a chip click may reach: those carrying a frozen value in every locked row.
 *
 * Null when nothing is locked, which is both the common case and a cheaper one -- callers skip the
 * intersection entirely rather than rebuilding every group against a set of all the sample ids.
 *
 * A lock naming a column the workspace no longer has would otherwise match nothing and block every
 * click, so such a lock is ignored rather than obeyed.
 */
export function allowedByLocks(
  metadata: SampleMetadata,
  locks: FacetLocks,
  columns?: readonly string[],
): Set<string> | null {
  const active = Object.keys(locks).filter((name) => (
    locks[name].length > 0 && (!columns || columns.includes(name))
  ));
  if (active.length === 0) return null;
  return new Set(Object.keys(metadata).filter((id) => (
    active.every((name) => locks[name].includes(metadata[id]?.[name] ?? ""))))); 
}

/**
 * Narrow every chip to the samples a click may reach.
 *
 * A chip has to say what it will do: under a lock on one cell type, a stimulation chip must read the files it can reach rather than
 * offering 41 and then checking 13. Values left with no reachable sample are kept rather than
 * dropped -- they read as 0/0, which is the honest statement that the lock rules them out, and the
 * row keeps its shape instead of reflowing every time a lock is turned on.
 */
export function restrictFacets(
  facets: readonly FacetColumn[],
  allowed: ReadonlySet<string> | null,
): FacetColumn[] {
  if (!allowed) return facets as FacetColumn[];
  return facets.map((column) => ({
    ...column,
    values: column.values.map((entry) => ({
      value: entry.value,
      sampleIds: entry.sampleIds.filter((id) => allowed.has(id)),
    })),
  }));
}
