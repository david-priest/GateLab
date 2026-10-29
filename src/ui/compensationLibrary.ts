// compensationLibrary.ts — the Compensation tab's Matrices list, as data.
//
// The list is a library to choose from: the matrices the workspace stores (its lineages, each shown
// by one record) and each file's embedded $SPILLOVER, identical matrices shown once (matrixHash).
// One matrix is active for the whole workspace (WorkspaceCompensationState.activeProfileId), the
// rule of 2026-10-05 that a workspace keeps one kind of compensation. Nothing here computes a
// compensated value: a switch goes through the App's Apply path (applyCompensationProfile).
//
// Design: vault note "GateLab — Compensation Matrices panel (2026-10-23)".

import { reportMatrixCompatibility } from "../engine/compensationCompatibility";
import {
  hashCompensationMatrix,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CompensationMatrixInput,
  type MatrixValidationResult,
  type Sha256Digest,
} from "../engine/compensationProfile";
import { parseCompensationMatrixTable } from "../engine/compensationMatrixImport";
import {
  createCompensationBaselineProfile,
  type BaselineCompensationProfileRecord,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import { DEFAULT_FLOW_SOLVER_SETTINGS, FLOW_SOLVER_VERSION } from "../engine/flowCompensationEngine";
import type { Gate, PopulationMap } from "../engine/models";
import type { Sample } from "../engine/sample";
import type { WorkspaceCompensationState } from "../engine/workspaceCompensation";

/**
 * How far a coefficient may sit from 0 or 1 and still be read as exactly 0 or 1 when a flow matrix
 * is stored. BD FACSDiva writes its matrices with single-precision noise (coefficients of -5e-9, a
 * diagonal of 1.000002), which the stored-profile rules (no negative coefficient, a diagonal of
 * exactly 1) refuse; the matrix could then be applied to its own file but never copied, edited or
 * used for the workspace. A value this close changes a compensated value by at most 1e-5 of the
 * source signal.
 */
export const FLOW_MATRIX_NOISE_TOLERANCE = 1e-5;

/** A flow matrix as GateLab stores it, and how many coefficients were set to exactly 0 or 1 for that. */
export interface StorableFlowMatrix {
  readonly validation: MatrixValidationResult;
  /** Negative coefficients set to 0 and diagonals set to 1, each within FLOW_MATRIX_NOISE_TOLERANCE. */
  readonly roundedCoefficients: number;
}

/**
 * Validates a flow matrix for storing. Where the only objections are negative coefficients and
 * diagonals other than 1, every one of them within FLOW_MATRIX_NOISE_TOLERANCE, exactly those
 * coefficients are set to 0 and 1 and the result validated again; any other objection, or one a
 * larger value raises, is returned as it stands. No coefficient the validator accepts changes.
 */
export function storableFlowMatrix(input: CompensationMatrixInput): StorableFlowMatrix {
  const validation = validateAndCanonicalizeCompensationMatrix(input, "flow-spillover");
  if (validation.ok || !Array.isArray(input.matrix)) return { validation, roundedCoefficients: 0 };
  const replacements = new Map<string, number>();
  for (const { code, row, column } of validation.errors) {
    const value = row === undefined || column === undefined ? undefined : input.matrix[row]?.[column];
    const target = code === "negative-coefficient" ? 0 : code === "non-unit-diagonal" ? 1 : null;
    if (typeof value !== "number" || target === null || Math.abs(value - target) > FLOW_MATRIX_NOISE_TOLERANCE) {
      return { validation, roundedCoefficients: 0 };
    }
    replacements.set(`${row}:${column}`, target);
  }
  const matrix = input.matrix.map((values: readonly number[], row) =>
    values.map((value, column) => replacements.get(`${row}:${column}`) ?? value));
  const cleaned = validateAndCanonicalizeCompensationMatrix({ ...input, matrix }, "flow-spillover");
  return cleaned.ok ? { validation: cleaned, roundedCoefficients: replacements.size } : { validation, roundedCoefficients: 0 };
}

/** The provenance line for a stored matrix: exact, or which coefficients were set to 0 or 1. */
export function storedCoefficientsNote(prefix: string, roundedCoefficients: number): string {
  return roundedCoefficients === 0
    ? `${prefix}; coefficients preserved exactly`
    : `${prefix}; ${roundedCoefficients} coefficient${roundedCoefficients === 1 ? "" : "s"} within ${FLOW_MATRIX_NOISE_TOLERANCE} of 0 or 1 set to exactly 0 or 1, all others preserved exactly`;
}

/** A file's embedded flow spillover matrix, read exactly as "Enable matrix editing" reads it. */
export interface EmbeddedFlowMatrix {
  readonly fileName: string;
  /** The matrix's identity in the list: its hash, or for one GateLab cannot store, its values. */
  readonly key: string;
  /** As the file carries it, over $PnN where every channel maps back to one. */
  readonly input: CompensationMatrixInput;
  /** Null where the matrix cannot be stored as a profile; `problem` says why. */
  readonly matrix: CanonicalCompensationMatrix | null;
  readonly matrixHash: Sha256Digest | null;
  /**
   * Why the matrix cannot be stored or used for the workspace (a diagonal other than 1, a
   * negative coefficient, a channel that does not map back): the legacy embedded compensation
   * still applies it to its own file, so it is listed, but not offered.
   */
  readonly problem: string | null;
  /** Coefficients set to exactly 0 or 1 for the matrix to be stored (storableFlowMatrix). */
  readonly roundedCoefficients: number;
  readonly keyword?: "$SPILLOVER" | "$SPILL" | "SPILL";
  /**
   * Set where the file's active matrix is not its own but one an imported FlowJo or Gating-ML
   * workspace supplied (Sample.externalSpillover): that workspace's label.
   */
  readonly externalLabel?: string;
}

/** Where a matrix came from, as the list's second line says it. */
export type MatrixSource =
  | Readonly<{ type: "embedded"; fileName: string }>
  | Readonly<{ type: "external"; label: string }>
  | Readonly<{ type: "imported"; fileName: string }>
  | Readonly<{ type: "edited"; from: string }>
  | Readonly<{ type: "empty" }>
  | Readonly<{ type: "preset"; presetId: string }>;

export interface MatrixLibraryRow {
  /** `lineage:<baselineProfileId>` or `embedded:<matrixHash>`. */
  readonly id: string;
  readonly kind: "lineage" | "embedded";
  readonly name: string;
  /** True where the user named it (a lineage's `name`); otherwise the name is the record's or the file's. */
  readonly named: boolean;
  readonly source: MatrixSource;
  readonly compensationKind: "flow-spillover" | "cytof-spillover";
  readonly channelCount: number;
  /** Null for an embedded matrix GateLab cannot store; `unusable` says why. */
  readonly matrix: CanonicalCompensationMatrix | null;
  /** The values Export CSV… writes. */
  readonly exportMatrix: CompensationMatrixInput;
  readonly matrixHash: Sha256Digest | null;
  readonly unusable: string | null;
  /** The record a lineage row shows: the active one if it is in this lineage, else the newest. */
  readonly profile: CompensationProfileRecord | null;
  readonly baselineProfileId: string | null;
  /** An embedded row's first file carrying it. */
  readonly embedded: EmbeddedFlowMatrix | null;
  /** The files whose installed layer is this matrix. */
  readonly filesUsing: number;
  readonly active: boolean;
  readonly canRename: boolean;
  readonly canDelete: boolean;
  /**
   * What the row's number is kept under in MatrixNumbers: `lineage:<baselineProfileId>`, or
   * `embedded:<key>` for a file's matrix and for the stored form that stands in for it.
   */
  readonly numberKey: string;
  /** M1, M2, … as a number: given once, never reused; null until given. */
  readonly number: number | null;
  /** The matrix in use when the data came in (MatrixNumbers.primary). */
  readonly primary: boolean;
}

/**
 * The short names of the workspace's matrices, M1, M2, …: each matrix is given the next number the
 * first time it is listed, keeps it, and no number is given twice, even after a matrix is deleted.
 * The primary matrix is the one in use when the data came in (the files' own, or one an imported
 * workspace applied), or where none was, the first file's own; it is decided once.
 * Display only: saved in the workspace's `display` section, where a GateLab without it ignores it,
 * and read by nothing that computes.
 */
export interface MatrixNumbers {
  /** The number the next matrix is given. */
  readonly next: number;
  readonly byKey: Readonly<Record<string, number>>;
  /** The primary matrix's numberKey; null where the data came in with no matrix; absent until decided. */
  readonly primary?: string | null;
}

const MAX_MATRIX_NUMBER = 100_000;
const MAX_NUMBER_KEY_LENGTH = 300;

/** The numbers a saved workspace carries, or null where it carries none or they do not hold together. */
export function restoredMatrixNumbers(value: unknown): MatrixNumbers | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { next, byKey, primary } = value as Record<string, unknown>;
  if (!Number.isInteger(next) || (next as number) < 1 || (next as number) > MAX_MATRIX_NUMBER) return null;
  if (typeof byKey !== "object" || byKey === null || Array.isArray(byKey)) return null;
  const seen = new Set<number>();
  const numbers: Record<string, number> = {};
  for (const [key, number] of Object.entries(byKey)) {
    if (key.length === 0 || key.length > MAX_NUMBER_KEY_LENGTH) return null;
    if (!Number.isInteger(number) || (number as number) < 1 || (number as number) >= (next as number)) return null;
    if (seen.has(number as number)) return null;
    seen.add(number as number);
    numbers[key] = number as number;
  }
  if (primary !== undefined && primary !== null && (typeof primary !== "string" || !(primary in numbers))) return null;
  return { next: next as number, byKey: numbers, ...(primary !== undefined ? { primary } : {}) };
}

/**
 * Gives every row without a number the next one, and decides the primary matrix once: the active
 * row, else the first file's own matrix, else none. The primary is numbered first, so a workspace's
 * own matrix is M1. Returns `numbers` itself where nothing changes.
 */
export function numberMatrices(
  numbers: MatrixNumbers | null,
  rows: readonly MatrixLibraryRow[],
): MatrixNumbers | null {
  if (rows.length === 0) return numbers;
  const byKey: Record<string, number> = { ...(numbers?.byKey ?? {}) };
  let next = numbers?.next ?? 1;
  let primary = numbers?.primary;
  if (primary === undefined) {
    primary = (rows.find(({ active }) => active) ?? rows.find(({ kind }) => kind === "embedded"))?.numberKey ?? null;
  }
  let changed = primary !== numbers?.primary;
  for (const key of [...(primary ? [primary] : []), ...rows.map(({ numberKey }) => numberKey)]) {
    if (key in byKey) continue;
    byKey[key] = next++;
    changed = true;
  }
  return changed ? { next, byKey, primary } : numbers;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What one file is compensated with now: a stored profile, its own embedded matrix, or nothing. */
export type FileCompensationUse =
  | Readonly<{ kind: "profile"; profileId: string }>
  | Readonly<{ kind: "embedded"; key: string | null }>
  | null;

function baseFileName(name: string): string {
  return name.replace(/\.fcs$/i, "") || name;
}

/** A file's embedded flow matrix over exact $PnN identities, or null when it carries none. */
export async function embeddedFlowMatrixOf(
  sample: Sample,
  fileName: string,
): Promise<EmbeddedFlowMatrix | null> {
  const spill = sample.instrument === "flow" ? sample.spillover : null;
  if (!spill) return null;
  const pnns = spill.channels.map((key) => {
    const index = sample.index(key);
    return index === undefined ? null : sample.channels[index].pnn;
  });
  const external = sample.externalSpillover;
  const keyword = external
    ? undefined
    : (["$SPILLOVER", "$SPILL", "SPILL"] as const).find((candidate) => typeof sample.fcs.keywords[candidate] === "string");
  const common = {
    fileName,
    ...(keyword ? { keyword } : {}),
    ...(external ? { externalLabel: external.label } : {}),
  };
  const axis = pnns.map((pnn, index) => pnn ?? spill.channels[index]);
  const input: CompensationMatrixInput = { sourceChannels: axis, receiverChannels: axis, matrix: spill.matrix };
  // Keyed by a digest of its values, short enough to keep its number under (MatrixNumbers).
  const valuesKey = `values:${await sha256Hex(JSON.stringify([axis, spill.matrix]))}`;
  const unstored = (problem: string): EmbeddedFlowMatrix => ({
    ...common,
    key: valuesKey,
    input,
    matrix: null,
    matrixHash: null,
    problem,
    roundedCoefficients: 0,
  });
  if (pnns.some((pnn) => pnn === null)) {
    return unstored("The embedded matrix could not be mapped back to exact FCS channel identities.");
  }
  const { validation, roundedCoefficients } = storableFlowMatrix(input);
  if (!validation.ok) return unstored(validation.errors.map(({ message }) => message).join(" "));
  const matrixHash = await hashCompensationMatrix(validation.value);
  return { ...common, key: matrixHash, input, matrix: validation.value, matrixHash, problem: null, roundedCoefficients };
}

function sourceOf(
  record: CompensationProfileRecord,
  baseline: CompensationProfileRecord,
  baselineName: string,
): MatrixSource {
  if (record.recordType === "revision") return { type: "edited", from: baselineName };
  const origin = baseline.origin;
  if (origin.type === "embedded-fcs") return { type: "embedded", fileName: origin.fileName };
  if (origin.type === "uploaded") return { type: "imported", fileName: origin.fileName };
  if (origin.type === "manual") return { type: "empty" };
  return { type: "preset", presetId: origin.presetId };
}

function channelCountOf(record: CompensationProfileRecord): number {
  return record.scientific.kind === "flow-spillover"
    ? record.scientific.matrix.receiverChannels.length
    : record.scientific.includedChannels.length;
}

/**
 * The list's rows, lineages first in the order the workspace stores them, then each distinct
 * embedded matrix no lineage already stores as that file's matrix. A lineage is always listed (a
 * Duplicate is meant to be a second copy, and does not hide the row it copies); an embedded matrix
 * is listed once, whatever number of files carry it.
 */
export function buildMatrixLibrary(
  compensation: WorkspaceCompensationState,
  embedded: readonly EmbeddedFlowMatrix[],
  uses: readonly FileCompensationUse[],
  kind: "flow-spillover" | "cytof-spillover" = "flow-spillover",
  numbers: MatrixNumbers | null = null,
): MatrixLibraryRow[] {
  const rows: MatrixLibraryRow[] = [];
  const numbered = (numberKey: string) => ({
    numberKey,
    number: numbers?.byKey[numberKey] ?? null,
    primary: numbers?.primary === numberKey,
  });
  const rowName = (matrix: EmbeddedFlowMatrix) => `${baseFileName(matrix.fileName)} spillover`;
  // The embedded matrix a lineage stores as that file's matrix, by the storedAs identity below.
  const embeddedStoredAs = new Map(kind === "flow-spillover"
    ? embedded.map((matrix) => [`${matrix.key}\n${rowName(matrix)}`, matrix.key] as const)
    : []);
  const activeId = compensation.activeProfileId ?? null;
  const profileUses = new Map<string, number>();
  const embeddedUses = new Map<string, number>();
  for (const use of uses) {
    if (use?.kind === "profile") profileUses.set(use.profileId, (profileUses.get(use.profileId) ?? 0) + 1);
    else if (use?.kind === "embedded" && use.key) {
      embeddedUses.set(use.key, (embeddedUses.get(use.key) ?? 0) + 1);
    }
  }
  /**
   * A file's matrix as a lineage stores it (Use for the workspace, Enable matrix editing): its hash
   * and the name the baseline was given, the file's own row name. A copy is named otherwise and
   * does not stand in for the file's row, so the row it was copied from stays listed.
   */
  const storedAs = new Set<string>();
  const activeIsStored = activeId !== null &&
    compensation.lineages.some(({ records }) => records.some(({ profileId }) => profileId === activeId));

  for (const lineage of compensation.lineages) {
    const baseline = lineage.records.find(({ profileId }) => profileId === lineage.baselineProfileId) ??
      lineage.records[0];
    if (!baseline || baseline.scientific.kind !== kind) continue;
    const record = lineage.records.find(({ profileId }) => profileId === activeId) ??
      lineage.records[lineage.records.length - 1];
    const name = lineage.name ?? record.name;
    const lineageInUse = lineage.records.some(({ profileId }) => (profileUses.get(profileId) ?? 0) > 0);
    const active = record.profileId === activeId;
    const source = sourceOf(record, baseline, lineage.name ?? baseline.name);
    storedAs.add(`${record.matrixHash}\n${baseline.name}`);
    // The stored form of a file's matrix stands in for its row, so it shows that matrix's number;
    // once edited it is another matrix, and the file's row returns with the number.
    const standsFor = embeddedStoredAs.get(`${record.matrixHash}\n${baseline.name}`);
    rows.push({
      ...numbered(standsFor !== undefined ? `embedded:${standsFor}` : `lineage:${lineage.baselineProfileId}`),
      id: `lineage:${lineage.baselineProfileId}`,
      kind: "lineage",
      name,
      named: lineage.name !== undefined,
      source,
      compensationKind: record.scientific.kind,
      channelCount: channelCountOf(record),
      matrix: record.scientific.matrix,
      exportMatrix: record.scientific.matrix,
      matrixHash: record.matrixHash,
      unusable: null,
      profile: record,
      baselineProfileId: lineage.baselineProfileId,
      embedded: null,
      filesUsing: profileUses.get(record.profileId) ?? 0,
      active,
      canRename: true,
      // Neither the active matrix nor one a file is compensated with. A file's own matrix is
      // never lost by deleting a stored copy of it: its embedded row is listed again.
      canDelete: !active && !lineageInUse,
    });
  }

  if (kind === "flow-spillover") {
    // Stored as any one carrying file's matrix, it is stored for all of them.
    const listed = new Set<string>(embedded
      .filter((matrix) => storedAs.has(`${matrix.key}\n${rowName(matrix)}`))
      .map(({ key }) => key));
    for (const matrix of embedded) {
      if (listed.has(matrix.key)) continue;
      listed.add(matrix.key);
      const name = rowName(matrix);
      const filesUsing = embeddedUses.get(matrix.key) ?? 0;
      rows.push({
        ...numbered(`embedded:${matrix.key}`),
        id: `embedded:${matrix.matrixHash ?? matrix.fileName}`,
        kind: "embedded",
        name,
        named: false,
        source: matrix.externalLabel !== undefined
          ? { type: "external", label: matrix.externalLabel }
          : { type: "embedded", fileName: matrix.fileName },
        compensationKind: "flow-spillover",
        channelCount: matrix.input.receiverChannels.length,
        matrix: matrix.matrix,
        exportMatrix: matrix.input,
        matrixHash: matrix.matrixHash,
        unusable: matrix.problem,
        profile: null,
        baselineProfileId: null,
        embedded: matrix,
        filesUsing,
        // Files still on their own embedded matrix, with no stored matrix active: the matrix they
        // read is the one in use.
        active: !activeIsStored && filesUsing > 0,
        canRename: false,
        canDelete: false,
      });
    }
  }
  return rows;
}

/**
 * The active profile a workspace saved before the list existed opens with: the stored profile
 * most of its files are bound to (the first such, on a tie), or none.
 */
export function withDerivedActiveProfile(
  compensation: WorkspaceCompensationState,
  boundProfileIds: readonly (string | null)[],
): WorkspaceCompensationState {
  if (compensation.activeProfileId !== undefined) return compensation;
  const counts = new Map<string, number>();
  for (const profileId of boundProfileIds) {
    if (profileId !== null) counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [profileId, count] of counts) {
    if (best === null || count > counts.get(best)!) best = profileId;
  }
  const stored = best !== null &&
    compensation.lineages.some(({ records }) => records.some(({ profileId }) => profileId === best));
  return stored ? { ...compensation, activeProfileId: best! } : compensation;
}

export interface MatrixSwitchFile {
  readonly name: string;
  readonly sample: Sample;
}

export interface MatrixSwitchUncovered {
  readonly name: string;
  readonly wrongInstrument: boolean;
  readonly missingChannels: readonly string[];
  readonly message: string | null;
}

export interface MatrixSwitchPlan {
  readonly fileCount: number;
  /**
   * Files the matrix cannot compensate, with why: the file's instrument is the other kind, the
   * matrix names channels the file lacks, or the engine's own blocker. The switch is refused while
   * any is listed.
   */
  readonly uncovered: readonly MatrixSwitchUncovered[];
  /** Flow files now drawing from their own embedded matrix, which they leave. */
  readonly leavingEmbedded: readonly string[];
  /** Gates on a channel the matrix compensates, and the populations at or below one of them. */
  readonly gateCount: number;
  readonly populationCount: number;
}

/**
 * What "Use for the workspace…" would do: every file, its coverage, the files leaving their own
 * matrix, and the gates and populations whose membership is recomputed. Gate channels are read
 * through `viewed`, the file whose keys the gate tree uses.
 */
export function planMatrixSwitch(
  matrix: CanonicalCompensationMatrix,
  kind: "flow-spillover" | "cytof-spillover",
  files: readonly MatrixSwitchFile[],
  viewed: Sample | null,
  gates: Readonly<Record<string, Gate>>,
  populations: PopulationMap,
  rootPopulationId: string | null,
): MatrixSwitchPlan {
  const uncovered: MatrixSwitchUncovered[] = [];
  const leavingEmbedded: string[] = [];
  const instrument = kind === "flow-spillover" ? "flow" : "cytof";
  for (const { name, sample } of files) {
    if (sample.instrument !== instrument) {
      uncovered.push({ name, wrongInstrument: true, missingChannels: [], message: null });
      continue;
    }
    const report = kind === "flow-spillover"
      ? reportMatrixCompatibility({ kind, matrix, sampleChannels: sample.channels })
      : reportMatrixCompatibility({ kind, matrix, sampleChannels: sample.channels, includedChannels: matrix.receiverChannels });
    if (!report.canApply) {
      uncovered.push({
        name,
        wrongInstrument: false,
        missingChannels: report.matrixOnlyChannels,
        message: report.matrixOnlyChannels.length > 0
          ? null
          : report.blockers.map(({ message }) => message).join(" "),
      });
    }
    const layer = sample.compensatedLayerStatus();
    if (layer.state !== "missing" && layer.metadata.runtimeIdentity !== "profile") leavingEmbedded.push(name);
  }

  const compensated = new Set(matrix.receiverChannels);
  const pnnOf = (key: string): string | null => {
    const index = viewed?.index(key);
    return index === undefined || !viewed ? null : viewed.channels[index].pnn;
  };
  const affectedGates = new Set(
    Object.values(gates)
      .filter((gate) => [gate.x_channel, gate.y_channel].some((key) => {
        const pnn = pnnOf(key);
        return pnn !== null && compensated.has(pnn);
      }))
      .map(({ gate_id }) => gate_id),
  );
  const affectedPopulation = new Map<string, boolean>();
  const isAffected = (populationId: string, depth = 0): boolean => {
    const known = affectedPopulation.get(populationId);
    if (known !== undefined) return known;
    const population = populations[populationId];
    if (!population || depth > 1000) return false;
    const own = population.gate_refs.some(({ gate_id }) => affectedGates.has(gate_id));
    const result = own || (population.parent_id !== null && isAffected(population.parent_id, depth + 1));
    affectedPopulation.set(populationId, result);
    return result;
  };
  const populationCount = Object.keys(populations)
    .filter((populationId) => populationId !== rootPopulationId && isAffected(populationId)).length;
  return {
    fileCount: files.length,
    uncovered,
    leavingEmbedded,
    gateCount: affectedGates.size,
    populationCount,
  };
}

/** A name for a copy that no row has yet: "{name} copy", then "{name} copy 2", … */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

function newProfileSuffix(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A file's embedded matrix stored as a baseline profile, so the workspace can use it: the record
 * "Enable matrix editing" makes from the same matrix.
 */
export function baselineFromEmbedded(
  embedded: EmbeddedFlowMatrix,
  name: string,
): Promise<BaselineCompensationProfileRecord> {
  if (!embedded.matrix) return Promise.reject(new Error(embedded.problem ?? "This matrix cannot be stored."));
  return createCompensationBaselineProfile(
    {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: FLOW_SOLVER_VERSION,
      solverSettings: DEFAULT_FLOW_SOLVER_SETTINGS,
      matrix: embedded.matrix,
    },
    {
      profileId: `flow-${newProfileSuffix()}`,
      name,
      createdAt: new Date(),
      origin: embedded.externalLabel !== undefined
        ? { type: "uploaded", fileName: embedded.externalLabel, format: "csv", sourceColumnHeader: "channel" }
        : {
            type: "embedded-fcs",
            fileName: embedded.fileName,
            ...(embedded.keyword ? { keyword: embedded.keyword } : {}),
          },
      provenance: {
        sourceDescription: embedded.externalLabel !== undefined
          ? `Spillover matrix supplied by an imported workspace (${embedded.externalLabel})`
          : "Spillover matrix embedded in the source FCS file",
        estimationMethod: storedCoefficientsNote(
          embedded.externalLabel !== undefined ? "Imported with the workspace" : "Imported from FCS",
          embedded.roundedCoefficients,
        ),
      },
    },
  );
}

/** A second, separate copy of a row's matrix: a new baseline with the same coefficients and origin. */
export function duplicateOfRow(
  row: MatrixLibraryRow,
  name: string,
): Promise<BaselineCompensationProfileRecord> {
  if (!row.profile) {
    if (!row.embedded) throw new Error("This matrix cannot be copied.");
    return baselineFromEmbedded(row.embedded, name);
  }
  const record = row.profile;
  const solverSettings = Object.fromEntries(record.scientific.solverSettings.map(({ key, value }) => [key, value]));
  return createCompensationBaselineProfile(
    record.scientific.kind === "flow-spillover"
      ? {
          kind: "flow-spillover",
          method: "matrix-inverse",
          solverVersion: record.scientific.solverVersion,
          solverSettings: solverSettings as never,
          matrix: record.scientific.matrix,
        }
      : {
          kind: "cytof-spillover",
          method: "nnls",
          solverVersion: record.scientific.solverVersion,
          solverSettings: solverSettings as never,
          matrix: record.scientific.matrix,
          includedChannels: record.scientific.includedChannels,
        },
    {
      profileId: `${record.scientific.kind === "flow-spillover" ? "flow" : "cytof"}-${newProfileSuffix()}`,
      name,
      createdAt: new Date(),
      origin: record.origin,
      ...(record.provenance ? { provenance: record.provenance } : {}),
    },
  );
}

export interface ImportedFlowMatrix {
  readonly profile: BaselineCompensationProfileRecord;
  /** The matrix's channels that are no $PnN of any file in the workspace. */
  readonly unmatched: readonly string[];
  /** Coefficients set to exactly 0 or 1 for the matrix to be stored (storableFlowMatrix). */
  readonly roundedCoefficients: number;
}

export class MatrixImportError extends Error {}

/**
 * A flow spillover table read as the Compensation tab reads one (GateLab's own export, an R or
 * flowCore table written with row names, or a TSV), its channels matched to the workspace's files
 * by exact $PnN. A table none of whose channels a file has is refused.
 */
export async function importedFlowMatrix(
  text: string,
  fileName: string,
  workspacePnns: ReadonlySet<string>,
): Promise<ImportedFlowMatrix> {
  const parsed = parseCompensationMatrixTable(text);
  const { validation: validated, roundedCoefficients } = storableFlowMatrix(parsed.input);
  if (!validated.ok) {
    throw new MatrixImportError(validated.errors.map(({ message }) => message).join(" "));
  }
  const channels = validated.value.receiverChannels;
  const unmatched = channels.filter((pnn) => !workspacePnns.has(pnn));
  if (unmatched.length === channels.length) {
    throw new MatrixImportError(`None of its channels is a $PnN of a file in the workspace: ${channels.join(", ")}.`);
  }
  const profile = await createCompensationBaselineProfile(
    {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: FLOW_SOLVER_VERSION,
      solverSettings: DEFAULT_FLOW_SOLVER_SETTINGS,
      matrix: validated.value,
    },
    {
      profileId: `flow-import-${newProfileSuffix()}`,
      name: fileName.replace(/\.(?:csv|tsv|txt)$/i, "") || "Imported matrix",
      createdAt: new Date(),
      origin: {
        type: "uploaded",
        fileName,
        format: parsed.format.delimiter,
        sourceColumnHeader: parsed.format.sourceColumnHeader,
      },
      provenance: {
        sourceDescription: "User-imported flow spillover matrix",
        estimationMethod: storedCoefficientsNote("Imported", roundedCoefficients),
      },
    },
  );
  return { profile, unmatched, roundedCoefficients };
}
