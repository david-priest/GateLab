import {
  canonicalizeCompensationProfileHashInput,
  hashCompensationMatrix,
  hashCompensationProfile,
  serializeCanonicalCompensationMatrix,
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type CanonicalCompensationProfileHashInput,
  type CanonicalSolverSetting,
  type CompensationProfileHashInput,
  type FlowSolverSettingsInput,
  type NnlsSolverSettingsInput,
  type Sha256Digest,
  type SolverSettingValue,
} from "./compensationProfile";

export const COMPENSATION_PROFILE_RECORD_SCHEMA =
  "gatelab.compensation-profile-record.v1" as const;

export type CompensationProfileOrigin =
  | {
      readonly type: "embedded-fcs";
      /** Source FCS name. Preserved exactly; not a scientific identity. */
      readonly fileName: string;
      /** SHA-256 of the exact original FCS bytes, when available. */
      readonly fileDigest?: Sha256Digest;
      readonly keyword?: "$SPILLOVER" | "$SPILL" | "SPILL";
    }
  | {
      readonly type: "uploaded";
      /** Source matrix filename. Preserved exactly; not a scientific identity. */
      readonly fileName: string;
      /** SHA-256 of the exact original uploaded bytes, when available. */
      readonly fileDigest?: Sha256Digest;
      readonly format: "csv" | "tsv";
      readonly sourceColumnHeader: string;
    }
  | {
      readonly type: "bundled-preset";
      readonly presetId: string;
      readonly presetVersion: string;
      /** SHA-256 of the exact bundled asset bytes. */
      readonly assetDigest: Sha256Digest;
    };

export interface EstimationSoftware {
  readonly name: string;
  readonly version?: string;
}

export interface CompensationProfileProvenance {
  readonly controlDate?: string;
  readonly sourceDescription?: string;
  readonly controlType?: string;
  readonly instrument?: string;
  readonly panel?: string;
  readonly reagentLot?: string;
  readonly fixation?: string;
  readonly estimationMethod?: string;
  readonly estimationSoftware?: EstimationSoftware;
  readonly wasManuallyAdjustedBeforeImport?: boolean;
  readonly applicabilityNote?: string;
}

interface CompensationProfileRecordBase {
  readonly schema: typeof COMPENSATION_PROFILE_RECORD_SCHEMA;
  readonly recordType: "baseline" | "revision";
  readonly profileId: string;
  readonly name: string;
  /** Canonical UTC RFC3339 timestamp with millisecond precision. */
  readonly createdAt: string;
  readonly note: string | null;
  readonly scientific: CanonicalCompensationProfileHashInput;
  /** Hashes only numerical/computational identity, not record metadata. */
  readonly matrixHash: Sha256Digest;
  readonly profileHash: Sha256Digest;
  readonly origin: CompensationProfileOrigin;
  readonly provenance: CompensationProfileProvenance | null;
  readonly baselineProfileId: string;
  readonly baselineMatrixHash: Sha256Digest;
  readonly baselineProfileHash: Sha256Digest;
  readonly parentProfileId: string | null;
  readonly revisionReason: "edit" | "reset-to-baseline" | null;
}

export interface BaselineCompensationProfileRecord extends CompensationProfileRecordBase {
  readonly recordType: "baseline";
  readonly parentProfileId: null;
  readonly revisionReason: null;
}

export interface RevisionCompensationProfileRecord extends CompensationProfileRecordBase {
  readonly recordType: "revision";
  readonly parentProfileId: string;
  readonly revisionReason: "edit" | "reset-to-baseline";
}

export type CompensationProfileRecord =
  | BaselineCompensationProfileRecord
  | RevisionCompensationProfileRecord;

export interface NewBaselineMetadata {
  readonly profileId: string;
  readonly name: string;
  readonly createdAt: string | Date;
  readonly note?: string;
  readonly origin: CompensationProfileOrigin;
  readonly provenance?: CompensationProfileProvenance;
}

export interface NewRevisionMetadata {
  readonly profileId: string;
  readonly name?: string;
  readonly createdAt: string | Date;
  readonly note?: string;
}

export interface NamedCoefficientDiff {
  readonly sourceChannel: string;
  readonly receiverChannel: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

export interface NamedSolverSettingDiff {
  readonly key: string;
  readonly before: SolverSettingValue;
  readonly after: SolverSettingValue;
}

export interface CompensationProfileDiff {
  readonly fromProfileId: string;
  readonly toProfileId: string;
  readonly matrixHashChanged: boolean;
  readonly profileHashChanged: boolean;
  readonly coefficientChanges: readonly NamedCoefficientDiff[];
  readonly solverVersionChange: Readonly<{ before: string; after: string }> | null;
  readonly solverSettingChanges: readonly NamedSolverSettingDiff[];
  readonly includedChannelsAdded: readonly string[];
  readonly includedChannelsRemoved: readonly string[];
}

const RECORD_KEYS = [
  "schema",
  "recordType",
  "profileId",
  "name",
  "createdAt",
  "note",
  "scientific",
  "matrixHash",
  "profileHash",
  "origin",
  "provenance",
  "baselineProfileId",
  "baselineMatrixHash",
  "baselineProfileHash",
  "parentProfileId",
  "revisionReason",
] as const;

const SCIENTIFIC_KEYS = [
  "schema",
  "kind",
  "method",
  "solverVersion",
  "solverSettings",
  "matrix",
  "includedChannels",
] as const;

const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(`${label} contains unexpected field(s): ${extra.join(", ")}.`);
  }
}

function assertRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing required field(s): ${missing.join(", ")}.`);
  }
}

function deepCanonicalEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (Object.is(left, -0) && right === 0) || (left === 0 && Object.is(right, -0));
  }
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepCanonicalEqual(value, right[index]))
    );
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
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepCanonicalEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertJsonString(value: string, label: string, maxCodePoints: number): void {
  if (value.includes("\0")) throw new Error(`${label} must not contain NUL characters.`);
  if (hasLoneSurrogate(value)) throw new Error(`${label} contains an unpaired Unicode surrogate.`);
  if (Array.from(value).length > maxCodePoints) {
    throw new Error(`${label} exceeds ${maxCodePoints} Unicode code points.`);
  }
}

function canonicalId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`${label} must be a 1–128 character portable identifier.`);
  }
  return value;
}

function canonicalName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Profile name must be a string.");
  const normalized = value.trim().normalize("NFC");
  assertJsonString(normalized, "Profile name", 256);
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Profile name must be a non-empty single-line string.");
  }
  return normalized;
}

function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Profile note must be a string or null.");
  assertJsonString(value, "Profile note", 65536);
  return value;
}

function preservedFileName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Source filename must be a string.");
  assertJsonString(value, "Source filename", 1024);
  if (value.trim().length === 0) throw new Error("Source filename must not be blank.");
  return value;
}

function optionalDescriptiveText(
  value: unknown,
  label: string,
  preserveWhitespace = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "string") {
    throw new Error(`${label} must be a string when present.`);
  }
  const normalized = preserveWhitespace ? value : value.trim().normalize("NFC");
  assertJsonString(normalized, label, preserveWhitespace ? 65536 : 1024);
  if (!preserveWhitespace && normalized.length === 0) {
    throw new Error(`${label} must not be blank when present.`);
  }
  return normalized;
}

function canonicalDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase sha256: digest with 64 hexadecimal digits.`);
  }
  return value as Sha256Digest;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  // Date.UTC treats years 0–99 as 1900–1999. Set the year explicitly so the
  // four-digit RFC3339/ISO representation is validated without that legacy rule.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  if (!validCalendarDate(year, month, day)) throw new Error(`${label} is not a real date.`);
  return value;
}

function canonicalTimestampInput(value: string | Date): string {
  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    if (!Number.isFinite(time)) throw new Error("createdAt is not a valid date.");
    const canonical = Date.prototype.toISOString.call(value);
    if (!CANONICAL_TIMESTAMP_PATTERN.test(canonical)) {
      throw new Error("createdAt must use a four-digit year between 0000 and 9999.");
    }
    return canonical;
  }
  if (typeof value !== "string") throw new Error("createdAt must be a timestamp or Date.");
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) throw new Error("createdAt must be an RFC3339 timestamp with an explicit timezone.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (
    !validCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("createdAt contains an invalid calendar date or time.");
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 14 || zoneMinute > 59 || (zoneHour === 14 && zoneMinute !== 0)) {
      throw new Error("createdAt contains an invalid timezone offset.");
    }
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("createdAt is not a valid timestamp.");
  const canonical = parsed.toISOString();
  if (!CANONICAL_TIMESTAMP_PATTERN.test(canonical)) {
    throw new Error("createdAt must resolve to a four-digit UTC year between 0000 and 9999.");
  }
  return canonical;
}

function canonicalPersistedTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_TIMESTAMP_PATTERN.test(value)
  ) {
    throw new Error("Persisted createdAt must be canonical UTC RFC3339 with milliseconds.");
  }
  const canonical = canonicalTimestampInput(value);
  if (canonical !== value) throw new Error("Persisted createdAt is not canonical.");
  return value;
}

function canonicalOrigin(value: unknown): CompensationProfileOrigin {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Compensation profile origin must be an object.");
  }
  const origin = value as Record<string, unknown>;
  if (origin.type === "embedded-fcs") {
    assertExactKeys(origin, ["type", "fileName", "fileDigest", "keyword"], "embedded-fcs origin");
    assertRequiredKeys(origin, ["type", "fileName"], "embedded-fcs origin");
    const fileName = preservedFileName(origin.fileName);
    const fileDigest =
      origin.fileDigest === undefined
        ? undefined
        : canonicalDigest(origin.fileDigest, "FCS fileDigest");
    const keyword = origin.keyword;
    if (
      keyword !== undefined &&
      keyword !== "$SPILLOVER" &&
      keyword !== "$SPILL" &&
      keyword !== "SPILL"
    ) {
      throw new Error("Embedded FCS origin has an unsupported spillover keyword.");
    }
    return Object.freeze({
      type: "embedded-fcs",
      fileName,
      ...(fileDigest ? { fileDigest } : {}),
      ...(keyword ? { keyword } : {}),
    });
  }
  if (origin.type === "uploaded") {
    assertExactKeys(
      origin,
      ["type", "fileName", "fileDigest", "format", "sourceColumnHeader"],
      "uploaded origin",
    );
    assertRequiredKeys(
      origin,
      ["type", "fileName", "format", "sourceColumnHeader"],
      "uploaded origin",
    );
    const fileName = preservedFileName(origin.fileName);
    const fileDigest =
      origin.fileDigest === undefined
        ? undefined
        : canonicalDigest(origin.fileDigest, "Uploaded fileDigest");
    if (origin.format !== "csv" && origin.format !== "tsv") {
      throw new Error("Uploaded matrix origin format must be csv or tsv.");
    }
    if (typeof origin.sourceColumnHeader !== "string") {
      throw new Error("Uploaded matrix sourceColumnHeader must be a string.");
    }
    assertJsonString(origin.sourceColumnHeader, "sourceColumnHeader", 1024);
    return Object.freeze({
      type: "uploaded",
      fileName,
      ...(fileDigest ? { fileDigest } : {}),
      format: origin.format,
      sourceColumnHeader: origin.sourceColumnHeader,
    });
  }
  if (origin.type === "bundled-preset") {
    assertExactKeys(
      origin,
      ["type", "presetId", "presetVersion", "assetDigest"],
      "bundled-preset origin",
    );
    assertRequiredKeys(
      origin,
      ["type", "presetId", "presetVersion", "assetDigest"],
      "bundled-preset origin",
    );
    const presetId = canonicalId(origin.presetId, "presetId");
    const presetVersion = optionalDescriptiveText(origin.presetVersion, "presetVersion");
    if (!presetVersion) throw new Error("presetVersion is required.");
    const assetDigest = canonicalDigest(origin.assetDigest, "Preset assetDigest");
    return Object.freeze({ type: "bundled-preset", presetId, presetVersion, assetDigest });
  }
  throw new Error(`Unsupported compensation profile origin '${String(origin.type)}'.`);
}

function canonicalEstimationSoftware(value: unknown): EstimationSoftware {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("estimationSoftware must be an object.");
  }
  const software = value as Record<string, unknown>;
  assertExactKeys(software, ["name", "version"], "estimationSoftware");
  assertRequiredKeys(software, ["name"], "estimationSoftware");
  const name = optionalDescriptiveText(software.name, "estimationSoftware.name");
  if (!name) throw new Error("estimationSoftware.name is required.");
  const version = optionalDescriptiveText(software.version, "estimationSoftware.version");
  return Object.freeze({ name, ...(version ? { version } : {}) });
}

function canonicalProvenance(value: unknown): CompensationProfileProvenance | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Compensation profile provenance must be an object or null.");
  }
  const provenance = value as Record<string, unknown>;
  const keys = [
    "controlDate",
    "sourceDescription",
    "controlType",
    "instrument",
    "panel",
    "reagentLot",
    "fixation",
    "estimationMethod",
    "estimationSoftware",
    "wasManuallyAdjustedBeforeImport",
    "applicabilityNote",
  ];
  assertExactKeys(provenance, keys, "profile provenance");
  const controlDate =
    provenance.controlDate === undefined
      ? undefined
      : canonicalDate(provenance.controlDate, "controlDate");
  const sourceDescription = optionalDescriptiveText(
    provenance.sourceDescription,
    "sourceDescription",
    true,
  );
  const controlType = optionalDescriptiveText(provenance.controlType, "controlType");
  const instrument = optionalDescriptiveText(provenance.instrument, "instrument");
  const panel = optionalDescriptiveText(provenance.panel, "panel");
  const reagentLot = optionalDescriptiveText(provenance.reagentLot, "reagentLot");
  const fixation = optionalDescriptiveText(provenance.fixation, "fixation");
  const estimationMethod = optionalDescriptiveText(
    provenance.estimationMethod,
    "estimationMethod",
  );
  const estimationSoftware =
    provenance.estimationSoftware === undefined
      ? undefined
      : canonicalEstimationSoftware(provenance.estimationSoftware);
  if (
    provenance.wasManuallyAdjustedBeforeImport !== undefined &&
    typeof provenance.wasManuallyAdjustedBeforeImport !== "boolean"
  ) {
    throw new Error("wasManuallyAdjustedBeforeImport must be a boolean when present.");
  }
  const applicabilityNote = optionalDescriptiveText(
    provenance.applicabilityNote,
    "applicabilityNote",
    true,
  );
  return Object.freeze({
    ...(controlDate ? { controlDate } : {}),
    ...(sourceDescription !== undefined ? { sourceDescription } : {}),
    ...(controlType ? { controlType } : {}),
    ...(instrument ? { instrument } : {}),
    ...(panel ? { panel } : {}),
    ...(reagentLot ? { reagentLot } : {}),
    ...(fixation ? { fixation } : {}),
    ...(estimationMethod ? { estimationMethod } : {}),
    ...(estimationSoftware ? { estimationSoftware } : {}),
    ...(provenance.wasManuallyAdjustedBeforeImport !== undefined
      ? { wasManuallyAdjustedBeforeImport: provenance.wasManuallyAdjustedBeforeImport }
      : {}),
    ...(applicabilityNote !== undefined ? { applicabilityNote } : {}),
  });
}

function normalizeMatrixZeros(
  matrix: CanonicalCompensationMatrix,
  kind: "flow-spillover" | "cytof-spillover",
): CanonicalCompensationMatrix {
  const normalized = validateAndCanonicalizeCompensationMatrix(
    {
      sourceChannels: matrix.sourceChannels,
      receiverChannels: matrix.receiverChannels,
      matrix: matrix.matrix.map((row) =>
        row.map((value) => (Object.is(value, -0) ? 0 : value)),
      ),
    },
    kind,
  );
  if (!normalized.ok) {
    throw new Error(normalized.errors.map(({ message }) => message).join(" "));
  }
  return normalized.value;
}

function solverSettingsObject(
  scientific: CanonicalCompensationProfileHashInput,
): FlowSolverSettingsInput | NnlsSolverSettingsInput {
  const settings = Object.fromEntries(
    scientific.solverSettings.map(({ key, value }) => [key, value]),
  );
  if (scientific.method === "matrix-inverse") {
    return settings as unknown as FlowSolverSettingsInput;
  }
  return settings as unknown as NnlsSolverSettingsInput;
}

function scientificHashInput(
  scientific: CanonicalCompensationProfileHashInput,
): CompensationProfileHashInput {
  if (scientific.kind === "flow-spillover") {
    return {
      kind: "flow-spillover",
      method: "matrix-inverse",
      solverVersion: scientific.solverVersion,
      solverSettings: solverSettingsObject(scientific) as FlowSolverSettingsInput,
      matrix: scientific.matrix,
    };
  }
  return {
    kind: "cytof-spillover",
    method: "nnls",
    solverVersion: scientific.solverVersion,
    solverSettings: solverSettingsObject(scientific) as NnlsSolverSettingsInput,
    matrix: scientific.matrix,
    includedChannels: scientific.includedChannels,
  };
}

function canonicalScientific(
  input: CompensationProfileHashInput,
): CanonicalCompensationProfileHashInput {
  const first = canonicalizeCompensationProfileHashInput(input);
  const matrix = normalizeMatrixZeros(first.matrix, first.kind);
  return canonicalizeCompensationProfileHashInput(
    first.kind === "flow-spillover"
      ? {
          kind: "flow-spillover",
          method: "matrix-inverse",
          solverVersion: first.solverVersion,
          solverSettings: solverSettingsObject(first) as FlowSolverSettingsInput,
          matrix,
        }
      : {
          kind: "cytof-spillover",
          method: "nnls",
          solverVersion: first.solverVersion,
          solverSettings: solverSettingsObject(first) as NnlsSolverSettingsInput,
          matrix,
          includedChannels: first.includedChannels,
        },
  );
}

async function scientificHashes(
  scientific: CanonicalCompensationProfileHashInput,
): Promise<{ readonly matrixHash: Sha256Digest; readonly profileHash: Sha256Digest }> {
  const [matrixHash, profileHash] = await Promise.all([
    hashCompensationMatrix(scientific.matrix),
    hashCompensationProfile(scientificHashInput(scientific)),
  ]);
  return Object.freeze({ matrixHash, profileHash });
}

function sameAxes(
  left: CanonicalCompensationProfileHashInput,
  right: CanonicalCompensationProfileHashInput,
): boolean {
  return (
    left.matrix.sourceChannels.length === right.matrix.sourceChannels.length &&
    left.matrix.receiverChannels.length === right.matrix.receiverChannels.length &&
    left.matrix.sourceChannels.every(
      (channel, index) => channel === right.matrix.sourceChannels[index],
    ) &&
    left.matrix.receiverChannels.every(
      (channel, index) => channel === right.matrix.receiverChannels[index],
    )
  );
}

function freezeRecord<T extends CompensationProfileRecord>(record: T): T {
  return Object.freeze(record);
}

function requireChronological(createdAt: string, parentCreatedAt: string): void {
  if (createdAt < parentCreatedAt) {
    throw new Error("A profile revision cannot predate its parent record.");
  }
}

async function createRevisionRecord(
  parent: CompensationProfileRecord,
  scientific: CanonicalCompensationProfileHashInput,
  metadata: NewRevisionMetadata,
  revisionReason: "edit" | "reset-to-baseline",
): Promise<RevisionCompensationProfileRecord> {
  const profileId = canonicalId(metadata.profileId, "profileId");
  if (profileId === parent.profileId || profileId === parent.baselineProfileId) {
    throw new Error("A revision profileId must differ from its parent and baseline IDs.");
  }
  const createdAt = canonicalTimestampInput(metadata.createdAt);
  requireChronological(createdAt, parent.createdAt);
  const name = metadata.name === undefined ? parent.name : canonicalName(metadata.name);
  const note = optionalNote(metadata.note);
  const { matrixHash, profileHash } = await scientificHashes(scientific);
  const origin = canonicalOrigin(parent.origin);
  const provenance = canonicalProvenance(parent.provenance);
  const record: RevisionCompensationProfileRecord = {
    schema: COMPENSATION_PROFILE_RECORD_SCHEMA,
    recordType: "revision",
    profileId,
    name,
    createdAt,
    note,
    scientific,
    matrixHash,
    profileHash,
    origin,
    provenance,
    baselineProfileId: parent.baselineProfileId,
    baselineMatrixHash: parent.baselineMatrixHash,
    baselineProfileHash: parent.baselineProfileHash,
    parentProfileId: parent.profileId,
    revisionReason,
  };
  return freezeRecord(record);
}

export async function createCompensationBaselineProfile(
  scientificInput: CompensationProfileHashInput,
  metadata: NewBaselineMetadata,
): Promise<BaselineCompensationProfileRecord> {
  const profileId = canonicalId(metadata.profileId, "profileId");
  const name = canonicalName(metadata.name);
  const createdAt = canonicalTimestampInput(metadata.createdAt);
  const note = optionalNote(metadata.note);
  const origin = canonicalOrigin(metadata.origin);
  const provenance = canonicalProvenance(metadata.provenance);
  const scientific = canonicalScientific(scientificInput);
  const { matrixHash, profileHash } = await scientificHashes(scientific);
  return freezeRecord({
    schema: COMPENSATION_PROFILE_RECORD_SCHEMA,
    recordType: "baseline",
    profileId,
    name,
    createdAt,
    note,
    scientific,
    matrixHash,
    profileHash,
    origin,
    provenance,
    baselineProfileId: profileId,
    baselineMatrixHash: matrixHash,
    baselineProfileHash: profileHash,
    parentProfileId: null,
    revisionReason: null,
  });
}

export async function createCompensationProfileRevision(
  parentInput: CompensationProfileRecord,
  completeCandidate: CompensationProfileHashInput,
  metadata: NewRevisionMetadata,
): Promise<RevisionCompensationProfileRecord> {
  const parent = await validateCompensationProfileRecord(parentInput);
  const scientific = canonicalScientific(completeCandidate);
  if (
    scientific.kind !== parent.scientific.kind ||
    scientific.method !== parent.scientific.method
  ) {
    throw new Error("A profile revision cannot change compensation kind or method.");
  }
  if (!sameAxes(parent.scientific, scientific)) {
    throw new Error("A profile revision cannot change the matrix source or receiver axes.");
  }
  const { profileHash } = await scientificHashes(scientific);
  if (profileHash === parent.profileHash) {
    throw new Error("The proposed profile revision has no scientific changes.");
  }
  if (profileHash === parent.baselineProfileHash) {
    throw new Error("Use createResetToBaselineRevision() to restore baseline scientific state.");
  }
  return createRevisionRecord(parent, scientific, metadata, "edit");
}

export async function createResetToBaselineRevision(
  currentInput: CompensationProfileRecord,
  baselineInput: BaselineCompensationProfileRecord,
  metadata: NewRevisionMetadata,
): Promise<RevisionCompensationProfileRecord> {
  const current = await validateCompensationProfileRecord(currentInput);
  const baselineRecord = await validateCompensationProfileRecord(baselineInput);
  if (baselineRecord.recordType !== "baseline") {
    throw new Error("Reset requires the baseline profile record for this lineage.");
  }
  if (current.createdAt < baselineRecord.createdAt) {
    throw new Error("The current profile cannot predate its baseline record.");
  }
  if (
    current.baselineProfileId !== baselineRecord.profileId ||
    current.baselineMatrixHash !== baselineRecord.matrixHash ||
    current.baselineProfileHash !== baselineRecord.profileHash
  ) {
    throw new Error("The supplied baseline does not match the current profile lineage.");
  }
  if (
    !deepCanonicalEqual(current.origin, baselineRecord.origin) ||
    !deepCanonicalEqual(current.provenance, baselineRecord.provenance)
  ) {
    throw new Error("The current profile origin/provenance does not match its baseline.");
  }
  if (current.profileHash === baselineRecord.profileHash) {
    throw new Error("The current profile is already at its baseline scientific state.");
  }
  if (
    current.scientific.kind !== baselineRecord.scientific.kind ||
    current.scientific.method !== baselineRecord.scientific.method ||
    !sameAxes(current.scientific, baselineRecord.scientific)
  ) {
    throw new Error("The baseline scientific model is incompatible with the current lineage.");
  }
  return createRevisionRecord(
    current,
    baselineRecord.scientific,
    metadata,
    "reset-to-baseline",
  );
}

function sameSettingValue(left: SolverSettingValue, right: SolverSettingValue): boolean {
  if (typeof left !== typeof right) return false;
  if (typeof left === "number" && typeof right === "number") {
    return Object.is(left, -0) ? Object.is(right, -0) || right === 0 : left === right;
  }
  return left === right;
}

export function diffCompensationProfiles(
  from: CompensationProfileRecord,
  to: CompensationProfileRecord,
): CompensationProfileDiff {
  if (
    from.schema !== COMPENSATION_PROFILE_RECORD_SCHEMA ||
    to.schema !== COMPENSATION_PROFILE_RECORD_SCHEMA
  ) {
    throw new Error("Compensation profile diff requires supported profile records.");
  }
  if (from.baselineProfileId !== to.baselineProfileId) {
    throw new Error("Compensation profiles from different lineages cannot be diffed.");
  }
  if (
    from.baselineMatrixHash !== to.baselineMatrixHash ||
    from.baselineProfileHash !== to.baselineProfileHash ||
    !deepCanonicalEqual(from.origin, to.origin) ||
    !deepCanonicalEqual(from.provenance, to.provenance)
  ) {
    throw new Error("Compensation profiles from different lineages cannot be diffed.");
  }
  if (
    from.scientific.kind !== to.scientific.kind ||
    from.scientific.method !== to.scientific.method ||
    !sameAxes(from.scientific, to.scientific)
  ) {
    throw new Error("Compensation profiles have incompatible scientific models or axes.");
  }
  const coefficientChanges: NamedCoefficientDiff[] = [];
  const sourceChannels = from.scientific.matrix.sourceChannels;
  const receiverChannels = from.scientific.matrix.receiverChannels;
  for (let row = 0; row < sourceChannels.length; row++) {
    for (let column = 0; column < receiverChannels.length; column++) {
      const before = from.scientific.matrix.matrix[row][column];
      const after = to.scientific.matrix.matrix[row][column];
      if (sameSettingValue(before, after)) continue;
      const rawDelta = after - before;
      coefficientChanges.push(
        Object.freeze({
          sourceChannel: sourceChannels[row],
          receiverChannel: receiverChannels[column],
          before,
          after,
          delta: Object.is(rawDelta, -0) ? 0 : rawDelta,
        }),
      );
    }
  }

  const fromSettings = new Map(from.scientific.solverSettings.map(({ key, value }) => [key, value]));
  const toSettings = new Map(to.scientific.solverSettings.map(({ key, value }) => [key, value]));
  const solverSettingChanges: NamedSolverSettingDiff[] = [];
  for (const key of sortedCodePointStrings(new Set([...fromSettings.keys(), ...toSettings.keys()]))) {
    const before = fromSettings.get(key);
    const after = toSettings.get(key);
    if (before === undefined || after === undefined) {
      throw new Error("Comparable profiles must have the same solver-setting keys.");
    }
    if (!sameSettingValue(before, after)) {
      solverSettingChanges.push(Object.freeze({ key, before, after }));
    }
  }
  const fromIncluded = new Set(from.scientific.includedChannels);
  const toIncluded = new Set(to.scientific.includedChannels);
  const includedChannelsAdded = sortedCodePointStrings(
    Array.from(toIncluded).filter((channel) => !fromIncluded.has(channel)),
  );
  const includedChannelsRemoved = sortedCodePointStrings(
    Array.from(fromIncluded).filter((channel) => !toIncluded.has(channel)),
  );
  const solverVersionChange =
    from.scientific.solverVersion === to.scientific.solverVersion
      ? null
      : Object.freeze({
          before: from.scientific.solverVersion,
          after: to.scientific.solverVersion,
        });
  return Object.freeze({
    fromProfileId: from.profileId,
    toProfileId: to.profileId,
    matrixHashChanged: from.matrixHash !== to.matrixHash,
    profileHashChanged: from.profileHash !== to.profileHash,
    coefficientChanges: Object.freeze(coefficientChanges),
    solverVersionChange,
    solverSettingChanges: Object.freeze(solverSettingChanges),
    includedChannelsAdded: Object.freeze(includedChannelsAdded),
    includedChannelsRemoved: Object.freeze(includedChannelsRemoved),
  });
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

function sortedCodePointStrings(values: Iterable<string>): string[] {
  return Array.from(values).sort(compareCodePoints);
}

function decodeScientific(value: unknown): CanonicalCompensationProfileHashInput {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Profile scientific state must be an object.");
  }
  const scientific = value as Record<string, unknown>;
  assertExactKeys(scientific, SCIENTIFIC_KEYS, "profile scientific state");
  assertRequiredKeys(scientific, SCIENTIFIC_KEYS, "profile scientific state");
  if (!Array.isArray(scientific.solverSettings)) {
    throw new Error("Profile solverSettings must be a canonical array.");
  }
  const settingEntries: CanonicalSolverSetting[] = scientific.solverSettings.map(
    (entry, index) => {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`solverSettings entry ${index + 1} must be an object.`);
      }
      const setting = entry as Record<string, unknown>;
      assertExactKeys(setting, ["key", "value"], `solverSettings entry ${index + 1}`);
      assertRequiredKeys(setting, ["key", "value"], `solverSettings entry ${index + 1}`);
      if (typeof setting.key !== "string") {
        throw new Error(`solverSettings entry ${index + 1} key must be a string.`);
      }
      if (
        typeof setting.value !== "string" &&
        typeof setting.value !== "number" &&
        typeof setting.value !== "boolean"
      ) {
        throw new Error(`solverSettings entry ${index + 1} value has an unsupported type.`);
      }
      return { key: setting.key, value: setting.value };
    },
  );
  if (!Array.isArray(scientific.includedChannels)) {
    throw new Error("Profile includedChannels must be an array.");
  }
  if (scientific.matrix == null || typeof scientific.matrix !== "object") {
    throw new Error("Profile scientific matrix must be an object.");
  }
  const matrix = scientific.matrix as Record<string, unknown>;
  assertExactKeys(
    matrix,
    ["schema", "orientation", "sourceChannels", "receiverChannels", "matrix"],
    "profile scientific matrix",
  );
  assertRequiredKeys(
    matrix,
    ["schema", "orientation", "sourceChannels", "receiverChannels", "matrix"],
    "profile scientific matrix",
  );
  const settingsObject = Object.fromEntries(
    settingEntries.map(({ key, value: settingValue }) => [key, settingValue]),
  );
  const input = {
    kind: scientific.kind,
    method: scientific.method,
    solverVersion: scientific.solverVersion,
    solverSettings: settingsObject,
    matrix: scientific.matrix,
    ...(scientific.kind === "cytof-spillover"
      ? { includedChannels: scientific.includedChannels }
      : {}),
  } as unknown as CompensationProfileHashInput;
  const canonical = canonicalScientific(input);
  if (scientific.schema !== canonical.schema) {
    throw new Error("Profile scientific schema is unsupported.");
  }
  serializeCanonicalCompensationMatrix(scientific.matrix as CanonicalCompensationMatrix);
  const canonicalSettings = canonical.solverSettings;
  if (
    settingEntries.length !== canonicalSettings.length ||
    settingEntries.some(
      ({ key, value: settingValue }, index) =>
        key !== canonicalSettings[index].key ||
        !sameSettingValue(settingValue, canonicalSettings[index].value),
    ) ||
    scientific.solverVersion !== canonical.solverVersion ||
    (scientific.includedChannels as unknown[]).length !== canonical.includedChannels.length ||
    (scientific.includedChannels as unknown[]).some(
      (channel, index) => channel !== canonical.includedChannels[index],
    )
  ) {
    throw new Error("Stored profile scientific state is not canonical.");
  }
  return canonical;
}

export async function validateCompensationProfileRecord(
  untrusted: unknown,
): Promise<CompensationProfileRecord> {
  if (untrusted == null || typeof untrusted !== "object" || Array.isArray(untrusted)) {
    throw new Error("Compensation profile record must be an object.");
  }
  const candidate = untrusted as Record<string, unknown>;
  assertExactKeys(candidate, RECORD_KEYS, "compensation profile record");
  assertRequiredKeys(candidate, RECORD_KEYS, "compensation profile record");
  if (candidate.schema !== COMPENSATION_PROFILE_RECORD_SCHEMA) {
    throw new Error(`Unsupported compensation profile record schema '${String(candidate.schema)}'.`);
  }
  if (candidate.recordType !== "baseline" && candidate.recordType !== "revision") {
    throw new Error(`Unsupported profile recordType '${String(candidate.recordType)}'.`);
  }
  const profileId = canonicalId(candidate.profileId, "profileId");
  const name = canonicalName(candidate.name);
  if (candidate.name !== name) throw new Error("Persisted profile name is not canonical.");
  const createdAt = canonicalPersistedTimestamp(candidate.createdAt);
  if (candidate.note !== null && typeof candidate.note !== "string") {
    throw new Error("Persisted profile note must be a string or null.");
  }
  const note = optionalNote(candidate.note);
  const scientific = decodeScientific(candidate.scientific);
  const matrixHash = canonicalDigest(candidate.matrixHash, "matrixHash");
  const profileHash = canonicalDigest(candidate.profileHash, "profileHash");
  const hashes = await scientificHashes(scientific);
  if (matrixHash !== hashes.matrixHash) throw new Error("Stored matrixHash does not match the matrix.");
  if (profileHash !== hashes.profileHash) {
    throw new Error("Stored profileHash does not match the scientific profile state.");
  }
  const origin = canonicalOrigin(candidate.origin);
  const provenance = canonicalProvenance(candidate.provenance);
  if (!deepCanonicalEqual(candidate.origin, origin)) {
    throw new Error("Persisted compensation profile origin is not canonical.");
  }
  if (!deepCanonicalEqual(candidate.provenance, provenance)) {
    throw new Error("Persisted compensation profile provenance is not canonical.");
  }
  const baselineProfileId = canonicalId(candidate.baselineProfileId, "baselineProfileId");
  const baselineMatrixHash = canonicalDigest(candidate.baselineMatrixHash, "baselineMatrixHash");
  const baselineProfileHash = canonicalDigest(candidate.baselineProfileHash, "baselineProfileHash");

  if (candidate.recordType === "baseline") {
    if (candidate.parentProfileId !== null || candidate.revisionReason !== null) {
      throw new Error("A baseline profile must have null parentProfileId and revisionReason.");
    }
    if (
      baselineProfileId !== profileId ||
      baselineMatrixHash !== matrixHash ||
      baselineProfileHash !== profileHash
    ) {
      throw new Error("A baseline profile must identify its own exact matrix and profile hashes.");
    }
    return freezeRecord({
      schema: COMPENSATION_PROFILE_RECORD_SCHEMA,
      recordType: "baseline",
      profileId,
      name,
      createdAt,
      note,
      scientific,
      matrixHash,
      profileHash,
      origin,
      provenance,
      baselineProfileId,
      baselineMatrixHash,
      baselineProfileHash,
      parentProfileId: null,
      revisionReason: null,
    });
  }

  const parentProfileId = canonicalId(candidate.parentProfileId, "parentProfileId");
  if (parentProfileId === profileId || baselineProfileId === profileId) {
    throw new Error("A revision profileId must differ from its parent and baseline IDs.");
  }
  if (candidate.revisionReason !== "edit" && candidate.revisionReason !== "reset-to-baseline") {
    throw new Error("A revision must declare edit or reset-to-baseline as its reason.");
  }
  if (
    candidate.revisionReason === "reset-to-baseline" &&
    (matrixHash !== baselineMatrixHash || profileHash !== baselineProfileHash)
  ) {
    throw new Error("A reset revision must restore the complete baseline scientific state.");
  }
  if (candidate.revisionReason === "edit" && profileHash === baselineProfileHash) {
    throw new Error("A revision that restores baseline state must be recorded as reset-to-baseline.");
  }
  return freezeRecord({
    schema: COMPENSATION_PROFILE_RECORD_SCHEMA,
    recordType: "revision",
    profileId,
    name,
    createdAt,
    note,
    scientific,
    matrixHash,
    profileHash,
    origin,
    provenance,
    baselineProfileId,
    baselineMatrixHash,
    baselineProfileHash,
    parentProfileId,
    revisionReason: candidate.revisionReason,
  });
}
