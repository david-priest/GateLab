// membershipComparison.ts — two sets of population memberships over the same events, event by event:
// a test set (GateLab's, say) against a reference (another tool's, read from its own export).
//
// Equal counts do not make equal populations: two gates can each keep 400 events and share none
// of them. This compares which events each population holds, so a population is in agreement only
// when it holds exactly the reference's events. Populations are matched by path
// (membershipExport.ts), never by name alone, so two populations of one name under different
// parents are compared each with its own counterpart.
//
// Each population with any disagreeing event is attributed as flowjoCountCheck.ts attributes a
// count difference: "inherited" from the nearest population above it that disagrees too, and its
// "own" where every compared population above it agrees. The one difference is what "disagrees"
// means: there, a count that differs; here, any event held by one side and not the other, so a
// population whose counts match but whose events do not is "own" or "inherited" here and "exact"
// there. Because the events are known, each row also counts the disagreements that arise within
// events both sides' parents hold (withinAgreedParent); an inherited population with a non-zero
// count there differs at its own gate as well.

import type { MembershipTable } from "./membershipExport";
import { parentPopulationPath, splitPopulationPath } from "./membershipExport";

export type MembershipAttribution =
  /** Both sides hold exactly the same events. */
  | { kind: "exact" }
  /** Every compared population above it agrees, so the disagreement arises at its own gate. */
  | { kind: "own" }
  /** A population above it already disagrees, and it is counted within that one. */
  | { kind: "inherited"; from: string }
  /** Only the test set has a population of this path. */
  | { kind: "test-only" }
  /** Only the reference set has a population of this path. */
  | { kind: "reference-only" };

export interface ComparedPopulation {
  path: string;
  name: string;
  /** The path of its parent; null when the parent is the root, which holds every event on both sides. */
  parentPath: string | null;
  /** 1 for a population directly under the root. */
  depth: number;
  /** Members in the test set; null when only the reference has the population. */
  testEvents: number | null;
  /** Members in the reference set; null when only the test set has the population. */
  referenceEvents: number | null;
  /** Events both sides hold (true positives); null unless both sides have the population. */
  both: number | null;
  /** Events only the test set holds (false positives). */
  testOnly: number | null;
  /** Events only the reference holds (false negatives). */
  referenceOnly: number | null;
  /** both / testEvents; null where the test set holds no event or lacks the population. */
  precision: number | null;
  /** both / referenceEvents; null where the reference holds no event or lacks the population. */
  recall: number | null;
  /**
   * 2·TP / (2·TP + FP + FN). Where both sides hold no event at all it is 1: they agree on every
   * event, although precision and recall are undefined. Null unless both sides have the population.
   */
  f1: number | null;
  /**
   * Disagreeing events among those both sides' parents hold, i.e. disagreements that this
   * population's own gate makes rather than carries down. Null unless both sides have the
   * population and its parent.
   */
  withinAgreedParent: number | null;
  attribution: MembershipAttribution;
}

export interface MembershipComparison {
  totalEvents: number;
  /** The reference's populations in its column order, then those only the test set has, in its order. */
  rows: ComparedPopulation[];
  /** Paths only the test set has, in its order. */
  testOnlyPaths: string[];
  /** Paths only the reference has, in its order. */
  referenceOnlyPaths: string[];
  /** Populations both sides have. */
  compared: number;
  /** Compared populations that hold the same events on both sides. */
  exact: number;
  /** The compared row with the most disagreeing events; null when every compared row is exact. */
  largest: ComparedPopulation | null;
}

const csvField = (text: string): string => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** Where a row's disagreement arises, in words, for the table and its CSV. */
export function attributionText(attribution: MembershipAttribution): string {
  switch (attribution.kind) {
    case "exact": return "";
    case "own": return "at its own gate";
    case "inherited": return `within ${attribution.from}, which differs`;
    case "test-only": return "only in GateLab";
    case "reference-only": return "only in the reference";
  }
}

/** The comparison as CSV, one row per population in the comparison's order; empty cells for n/a. */
export function membershipComparisonCsv(comparison: MembershipComparison, fileName: string): string {
  const num = (v: number | null, digits?: number) => (v === null ? "" : digits === undefined ? String(v) : v.toFixed(digits));
  const lines = [
    ["file", "population", "gatelab_events", "reference_events", "both", "gatelab_only", "reference_only", "precision", "recall", "f1", "within_agreed_parent", "where"].join(","),
    ...comparison.rows.map((row) => [
      csvField(fileName), csvField(row.path), num(row.testEvents), num(row.referenceEvents), num(row.both), num(row.testOnly),
      num(row.referenceOnly), num(row.precision, 6), num(row.recall, 6), num(row.f1, 6), num(row.withinAgreedParent),
      csvField(attributionText(row.attribution)),
    ].join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

const countOf = (mask: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
};

/**
 * Compare a test set of memberships with a reference over the same events. Both must cover the same
 * number of events, in the same order; a different number is refused, since no population of one
 * can then be matched event by event with the other's.
 */
export function compareMemberships(test: MembershipTable, reference: MembershipTable): MembershipComparison {
  if (test.totalEvents !== reference.totalEvents) {
    throw new Error(
      `The two membership sets cover different events: the test set has ${test.totalEvents} ` +
        `and the reference ${reference.totalEvents}. They can only be compared over the same events.`,
    );
  }
  const n = reference.totalEvents;
  const maskOf = (table: MembershipTable, side: string, path: string): Uint8Array => {
    const mask = table.masks.get(path);
    if (!mask || mask.length !== n) throw new Error(`The ${side} set's population '${path}' has no mask of ${n} events.`);
    return mask;
  };
  const testPaths = new Set(test.paths);
  const referencePaths = new Set(reference.paths);
  const rows: ComparedPopulation[] = [];
  const byPath = new Map<string, ComparedPopulation>();
  const describe = (path: string) => {
    const names = splitPopulationPath(path);
    return { path, name: names[names.length - 1], parentPath: parentPopulationPath(path), depth: names.length };
  };

  for (const path of reference.paths) {
    const ref = maskOf(reference, "reference", path);
    if (!testPaths.has(path)) {
      const row: ComparedPopulation = {
        ...describe(path), testEvents: null, referenceEvents: countOf(ref), both: null, testOnly: null, referenceOnly: null,
        precision: null, recall: null, f1: null, withinAgreedParent: null, attribution: { kind: "reference-only" },
      };
      rows.push(row);
      byPath.set(path, row);
      continue;
    }
    const tst = maskOf(test, "test", path);
    const where = describe(path);
    // The parent on each side: every event for a population under the root.
    const parent = where.parentPath;
    const testParent = parent === null ? null : test.masks.get(parent);
    const refParent = parent === null ? null : reference.masks.get(parent);
    const parentKnown = parent === null || (testParent?.length === n && refParent?.length === n);
    let tp = 0, fp = 0, fn = 0, within = 0;
    for (let i = 0; i < n; i++) {
      const t = tst[i] ? 1 : 0;
      const r = ref[i] ? 1 : 0;
      if (t && r) tp++;
      else if (t) fp++;
      else if (r) fn++;
      else continue;
      if (t !== r && parentKnown && (parent === null || (testParent![i] && refParent![i]))) within++;
    }
    const testEvents = tp + fp;
    const referenceEvents = tp + fn;
    const row: ComparedPopulation = {
      ...where,
      testEvents,
      referenceEvents,
      both: tp,
      testOnly: fp,
      referenceOnly: fn,
      precision: testEvents > 0 ? tp / testEvents : null,
      recall: referenceEvents > 0 ? tp / referenceEvents : null,
      // Both sides empty: no event is in dispute, so the agreement is complete (F1 = 1).
      f1: tp + fp + fn === 0 ? 1 : (2 * tp) / (2 * tp + fp + fn),
      withinAgreedParent: parentKnown ? within : null,
      attribution: { kind: "exact" },
    };
    rows.push(row);
    byPath.set(path, row);
  }
  const testOnlyPaths: string[] = [];
  for (const path of test.paths) {
    if (referencePaths.has(path)) continue;
    testOnlyPaths.push(path);
    const row: ComparedPopulation = {
      ...describe(path), testEvents: countOf(maskOf(test, "test", path)), referenceEvents: null, both: null, testOnly: null,
      referenceOnly: null, precision: null, recall: null, f1: null, withinAgreedParent: null, attribution: { kind: "test-only" },
    };
    rows.push(row);
    byPath.set(path, row);
  }

  // As flowjoCountCheck: walk up from a disagreeing population, past ancestors that are not
  // compared or that agree, to the nearest one that disagrees.
  const disagrees = (row: ComparedPopulation | undefined): boolean =>
    !!row && row.both !== null && (row.testOnly! > 0 || row.referenceOnly! > 0);
  for (const row of rows) {
    if (!disagrees(row)) continue;
    let from: string | null = null;
    for (let up = row.parentPath; up !== null; up = parentPopulationPath(up)) {
      if (disagrees(byPath.get(up))) { from = up; break; }
    }
    row.attribution = from !== null ? { kind: "inherited", from } : { kind: "own" };
  }

  const compared = rows.filter((row) => row.both !== null);
  let largest: ComparedPopulation | null = null;
  const disagreement = (row: ComparedPopulation) => row.testOnly! + row.referenceOnly!;
  for (const row of compared) {
    if (disagreement(row) > 0 && (!largest || disagreement(row) > disagreement(largest))) largest = row;
  }
  return {
    totalEvents: n,
    rows,
    testOnlyPaths,
    referenceOnlyPaths: reference.paths.filter((path) => !testPaths.has(path)),
    compared: compared.length,
    exact: compared.filter((row) => row.attribution.kind === "exact").length,
    largest,
  };
}
