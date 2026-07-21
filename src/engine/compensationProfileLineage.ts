import {
  validateCompensationProfileRecord,
  type BaselineCompensationProfileRecord,
  type CompensationProfileRecord,
  type RevisionCompensationProfileRecord,
} from "./compensationProfileRecord";

export type CompensationProfileLineageValidationCode =
  | "invalid-lineage-container"
  | "empty-lineage"
  | "invalid-record"
  | "duplicate-profile-id"
  | "baseline-count"
  | "baseline-reference-mismatch"
  | "missing-parent"
  | "cycle"
  | "disconnected-record"
  | "chronology"
  | "origin-mismatch"
  | "provenance-mismatch"
  | "kind-method-mismatch"
  | "axis-mismatch"
  | "hash-identity-conflict"
  | "edit-no-op"
  | "edit-restores-baseline"
  | "reset-not-baseline"
  | "reset-no-op";

export interface CompensationProfileLineageErrorDetails {
  readonly recordIndex?: number;
  readonly profileId?: string;
  readonly relatedProfileId?: string;
  readonly cycle?: readonly string[];
  readonly cause?: unknown;
}

/** A stable, machine-readable trust-boundary failure for compensation history. */
export class CompensationProfileLineageValidationError extends Error {
  readonly code: CompensationProfileLineageValidationCode;
  readonly recordIndex?: number;
  readonly profileId?: string;
  readonly relatedProfileId?: string;
  readonly cycle?: readonly string[];
  override readonly cause?: unknown;

  constructor(
    code: CompensationProfileLineageValidationCode,
    message: string,
    details: CompensationProfileLineageErrorDetails = {},
  ) {
    super(`Invalid compensation profile lineage: ${message}`);
    this.name = "CompensationProfileLineageValidationError";
    this.code = code;
    this.recordIndex = details.recordIndex;
    this.profileId = details.profileId;
    this.relatedProfileId = details.relatedProfileId;
    this.cycle = details.cycle ? Object.freeze(Array.from(details.cycle)) : undefined;
    this.cause = details.cause;
  }
}

export interface ValidatedCompensationProfileLineage {
  readonly baseline: BaselineCompensationProfileRecord;
  /** Canonical root-first topological order, independent of input order. */
  readonly records: readonly CompensationProfileRecord[];
}

function invalidLineage(
  code: CompensationProfileLineageValidationCode,
  message: string,
  details: CompensationProfileLineageErrorDetails = {},
): never {
  throw new CompensationProfileLineageValidationError(code, message, details);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function deepCanonicalEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (Object.is(left, -0) && right === 0) ||
      (left === 0 && Object.is(right, -0));
  }
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => deepCanonicalEqual(value, right[index]));
  }
  if (
    left == null ||
    right == null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort(compareCodePoints);
  const rightKeys = Object.keys(rightRecord).sort(compareCodePoints);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] &&
      deepCanonicalEqual(leftRecord[key], rightRecord[key]),
  );
}

function sameAxis(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareRecords(
  left: CompensationProfileRecord,
  right: CompensationProfileRecord,
): number {
  const byTime = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
  return byTime || compareCodePoints(left.profileId, right.profileId);
}

function heapPush(
  heap: CompensationProfileRecord[],
  value: CompensationProfileRecord,
): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRecords(heap[parent], heap[index]) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function heapPop(heap: CompensationProfileRecord[]): CompensationProfileRecord {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareRecords(heap[left], heap[smallest]) < 0) smallest = left;
    if (right < heap.length && compareRecords(heap[right], heap[smallest]) < 0) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
  return first;
}

function canonicalCycle(path: readonly string[]): readonly string[] {
  const open = path[0] === path[path.length - 1] ? path.slice(0, -1) : Array.from(path);
  let smallest = 0;
  for (let index = 1; index < open.length; index++) {
    if (compareCodePoints(open[index], open[smallest]) < 0) smallest = index;
  }
  const rotated = [...open.slice(smallest), ...open.slice(0, smallest)];
  return Object.freeze([...rotated, rotated[0]]);
}

function assertHashIdentityAgreement(
  left: CompensationProfileRecord,
  right: CompensationProfileRecord,
): void {
  const matrixEqual = deepCanonicalEqual(left.scientific.matrix, right.scientific.matrix);
  const matrixHashEqual = left.matrixHash === right.matrixHash;
  const scienceEqual = deepCanonicalEqual(left.scientific, right.scientific);
  const profileHashEqual = left.profileHash === right.profileHash;
  if (matrixEqual !== matrixHashEqual || scienceEqual !== profileHashEqual) {
    invalidLineage(
      "hash-identity-conflict",
      `profiles "${left.profileId}" and "${right.profileId}" disagree between canonical state and hash identity.`,
      { profileId: left.profileId, relatedProfileId: right.profileId },
    );
  }
}

function assertRevisionSemantics(
  revision: RevisionCompensationProfileRecord,
  parent: CompensationProfileRecord,
  baseline: BaselineCompensationProfileRecord,
): void {
  assertHashIdentityAgreement(revision, parent);
  assertHashIdentityAgreement(revision, baseline);
  const sameAsParent = deepCanonicalEqual(revision.scientific, parent.scientific);
  const sameAsBaseline = deepCanonicalEqual(revision.scientific, baseline.scientific);
  if (revision.revisionReason === "edit") {
    if (sameAsParent) {
      invalidLineage("edit-no-op", `edit "${revision.profileId}" has no scientific change from its parent.`, {
        profileId: revision.profileId,
        relatedProfileId: parent.profileId,
      });
    }
    if (sameAsBaseline) {
      invalidLineage(
        "edit-restores-baseline",
        `edit "${revision.profileId}" restores baseline state but is not labelled as a reset.`,
        { profileId: revision.profileId, relatedProfileId: baseline.profileId },
      );
    }
    return;
  }
  if (!sameAsBaseline) {
    invalidLineage(
      "reset-not-baseline",
      `reset "${revision.profileId}" does not restore the complete baseline scientific state.`,
      { profileId: revision.profileId, relatedProfileId: baseline.profileId },
    );
  }
  if (sameAsParent) {
    invalidLineage(
      "reset-no-op",
      `reset "${revision.profileId}" starts from a parent already at baseline state.`,
      { profileId: revision.profileId, relatedProfileId: parent.profileId },
    );
  }
}

/**
 * Validate a complete, single-root compensation revision graph.
 *
 * Branches are valid; choosing the active branch is workspace state and is not inferred here.
 * Returned records are newly canonicalized, deeply immutable, and deterministically ordered.
 */
export async function validateCompensationProfileLineage(
  untrusted: unknown,
): Promise<ValidatedCompensationProfileLineage> {
  if (!Array.isArray(untrusted)) {
    invalidLineage(
      "invalid-lineage-container",
      "profile history must be a dense array of records.",
    );
  }
  for (let index = 0; index < untrusted.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(untrusted, index)) {
      invalidLineage(
        "invalid-lineage-container",
        "profile history must be a dense array of records.",
      );
    }
  }
  if (untrusted.length === 0) {
    invalidLineage("empty-lineage", "profile history must contain at least one record.");
  }

  const rawRecords = Array.from(untrusted);
  const records: CompensationProfileRecord[] = [];
  for (let index = 0; index < rawRecords.length; index++) {
    try {
      records.push(await validateCompensationProfileRecord(rawRecords[index]));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      invalidLineage("invalid-record", `record ${index + 1} is invalid: ${detail}`, {
        recordIndex: index,
        cause,
      });
    }
  }
  const sortedById = Array.from(records).sort(
    (left, right) => compareCodePoints(left.profileId, right.profileId),
  );

  for (let index = 1; index < sortedById.length; index++) {
    if (sortedById[index - 1].profileId === sortedById[index].profileId) {
      const duplicate = sortedById[index].profileId;
      invalidLineage("duplicate-profile-id", `profileId "${duplicate}" appears more than once.`, {
        profileId: duplicate,
      });
    }
  }

  const baselines = sortedById.filter(
    (record): record is BaselineCompensationProfileRecord => record.recordType === "baseline",
  );
  if (baselines.length !== 1) {
    invalidLineage(
      "baseline-count",
      `profile history must contain exactly one baseline; found ${baselines.length}.`,
    );
  }
  const baseline = baselines[0];
  const byId = new Map(records.map((record) => [record.profileId, record]));

  for (const record of sortedById) {
    if (
      record.baselineProfileId !== baseline.profileId ||
      record.baselineMatrixHash !== baseline.matrixHash ||
      record.baselineProfileHash !== baseline.profileHash
    ) {
      invalidLineage(
        "baseline-reference-mismatch",
        `profile "${record.profileId}" does not identify the exact lineage baseline.`,
        { profileId: record.profileId, relatedProfileId: baseline.profileId },
      );
    }
  }

  for (const record of sortedById) {
    if (record.recordType === "revision" && !byId.has(record.parentProfileId)) {
      invalidLineage(
        "missing-parent",
        `profile "${record.profileId}" refers to missing parent "${record.parentProfileId}".`,
        { profileId: record.profileId, relatedProfileId: record.parentProfileId },
      );
    }
  }

  const completed = new Set<string>();
  const connectedToBaseline = new Set<string>([baseline.profileId]);
  for (const start of sortedById) {
    if (completed.has(start.profileId)) continue;
    const path: string[] = [];
    const pathPosition = new Map<string, number>();
    let cursor = start;
    while (!completed.has(cursor.profileId)) {
      const repeatedAt = pathPosition.get(cursor.profileId);
      if (repeatedAt !== undefined) {
        const cycle = canonicalCycle([...path.slice(repeatedAt), cursor.profileId]);
        invalidLineage("cycle", `profile history contains a cycle: ${cycle.join(" → ")}.`, {
          profileId: cycle[0],
          cycle,
        });
      }
      pathPosition.set(cursor.profileId, path.length);
      path.push(cursor.profileId);
      if (cursor.recordType === "baseline") break;
      cursor = byId.get(cursor.parentProfileId)!;
    }
    if (!connectedToBaseline.has(cursor.profileId)) {
      invalidLineage(
        "disconnected-record",
        `profile "${start.profileId}" is not connected to baseline "${baseline.profileId}".`,
        { profileId: start.profileId, relatedProfileId: baseline.profileId },
      );
    }
    for (const profileId of path) {
      completed.add(profileId);
      connectedToBaseline.add(profileId);
    }
  }

  const children = new Map<string, CompensationProfileRecord[]>();
  for (const record of records) children.set(record.profileId, []);
  for (const record of records) {
    if (record.recordType === "revision") children.get(record.parentProfileId)!.push(record);
  }
  const ready: CompensationProfileRecord[] = [];
  heapPush(ready, baseline);
  const ordered: CompensationProfileRecord[] = [];
  while (ready.length > 0) {
    const current = heapPop(ready);
    ordered.push(current);
    for (const child of children.get(current.profileId)!) heapPush(ready, child);
  }
  if (ordered.length !== records.length) {
    invalidLineage("disconnected-record", "profile history is not a single rooted graph.");
  }

  for (const record of ordered) {
    if (record.recordType === "baseline") continue;
    const parent = byId.get(record.parentProfileId)!;
    if (record.createdAt < parent.createdAt || record.createdAt < baseline.createdAt) {
      invalidLineage(
        "chronology",
        `profile "${record.profileId}" predates its parent or baseline.`,
        { profileId: record.profileId, relatedProfileId: parent.profileId },
      );
    }
    if (!deepCanonicalEqual(record.origin, baseline.origin)) {
      invalidLineage(
        "origin-mismatch",
        `profile "${record.profileId}" has different source identity from its baseline.`,
        { profileId: record.profileId, relatedProfileId: baseline.profileId },
      );
    }
    if (!deepCanonicalEqual(record.provenance, baseline.provenance)) {
      invalidLineage(
        "provenance-mismatch",
        `profile "${record.profileId}" has different provenance from its baseline.`,
        { profileId: record.profileId, relatedProfileId: baseline.profileId },
      );
    }
    if (
      record.scientific.kind !== baseline.scientific.kind ||
      record.scientific.method !== baseline.scientific.method
    ) {
      invalidLineage(
        "kind-method-mismatch",
        `profile "${record.profileId}" changes the lineage compensation kind or method.`,
        { profileId: record.profileId, relatedProfileId: baseline.profileId },
      );
    }
    if (
      !sameAxis(record.scientific.matrix.sourceChannels, baseline.scientific.matrix.sourceChannels) ||
      !sameAxis(record.scientific.matrix.receiverChannels, baseline.scientific.matrix.receiverChannels)
    ) {
      invalidLineage(
        "axis-mismatch",
        `profile "${record.profileId}" changes the lineage source or receiver channel axes.`,
        { profileId: record.profileId, relatedProfileId: baseline.profileId },
      );
    }
    assertRevisionSemantics(record, parent, baseline);
  }

  return Object.freeze({
    baseline,
    records: Object.freeze(ordered),
  });
}
