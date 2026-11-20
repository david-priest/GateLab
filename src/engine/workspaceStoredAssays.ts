// A bundle's stored compensated assays: for each file, the compensated values of every matrix (and
// matrix version) applied to it other than the one in use, so switching back to one of them, or
// reopening the bundle, installs its values instead of solving again (David, 2026-11-20: "if there
// are multiple matrices for cytof data, then the compensated data should be stored for each of
// them, not recomputed each time, and not recomputed upon re-opening the workspace"; the bundle
// format was opened for this on his word the same day).
//
// The section lives under `stored-assays/`, beside the in-use assays of `assays/`
// (workspacePortableAssays.ts), which it does not change: a GateLab without this module selects
// no `stored-assays/` entry and opens the bundle as before. Its entries are located when the
// bundle is opened and read only when a layer is installed, so a bundle holding several matrices
// per file is never read into memory whole.
//
// A stored layer is found again by the FCS file's SHA-256 and the signature of the binding the
// compensation manager makes for that file and profile (compensatedBindingSignature); the reader
// checks each column's SHA-256 before its values are used. Installing the values is the caller's,
// through Sample.prepareCompensatedLayer, which checks them again against the binding.

import { strFromU8, strToU8 } from "fflate";
import { digestBytesSha256 } from "./compensationCache";
import type { Sha256Digest } from "./compensationProfile";
import {
  locateZipFileEntries,
  readLocatedZipEntry,
  type LazyStreamZipEntry,
  type LocatedZipEntry,
} from "./workspaceArchiveStream";

export const STORED_ASSAY_MANIFEST_PATH = "stored-assays/manifest.json" as const;
export const STORED_ASSAY_SCHEMA = "gatelab.stored-assays.v1" as const;
export const STORED_ASSAY_ENCODING = "float32-le" as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
const MAX_PROFILE_ID_LENGTH = 300;
const MAX_SIGNATURE_LENGTH = 1024 * 1024;

export interface StoredAssayColumnManifest {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  readonly path: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

export interface StoredAssayLayerManifest {
  /** The bundle path of the file's FCS data, for reading; the layer is matched by `fcsDigest`. */
  readonly dataPath: string;
  readonly fcsDigest: Sha256Digest;
  readonly eventCount: number;
  readonly profileId: string;
  readonly profileHash: Sha256Digest;
  readonly matrixHash: Sha256Digest;
  readonly bindingSignature: string;
  readonly columns: readonly StoredAssayColumnManifest[];
}

export interface StoredAssayManifest {
  readonly schema: typeof STORED_ASSAY_SCHEMA;
  readonly encoding: typeof STORED_ASSAY_ENCODING;
  readonly layers: readonly StoredAssayLayerManifest[];
}

/** An opened bundle's stored layers: the manifest, and where each column lies in the File. */
export interface StoredAssayArchive {
  readonly manifest: StoredAssayManifest;
  readonly file: File;
  readonly locations: ReadonlyMap<string, LocatedZipEntry>;
}

export class StoredAssayError extends Error {
  readonly code: "invalid-manifest" | "missing-file" | "unexpected-file" | "corrupt-column" | "unreadable-archive";

  constructor(code: StoredAssayError["code"], message: string) {
    super(`Stored compensated assays: ${message}`);
    this.name = "StoredAssayError";
    this.code = code;
  }
}

function fail(code: StoredAssayError["code"], message: string): never {
  throw new StoredAssayError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail("invalid-manifest", `${label} has an invalid field set.`);
  }
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-manifest", `${label} must be an array.`);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) fail("invalid-manifest", `${label} must not be sparse.`);
  }
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid-manifest", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value as Sha256Digest;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-manifest", `${label} must be a non-negative safe integer.`);
  }
  return Object.is(value, -0) ? 0 : value as number;
}

function isSafeDataPath(value: string): boolean {
  return value.startsWith("data/") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** The archive path of one stored column: fixed by its place in the manifest. */
export function storedAssayColumnPath(layerIndex: number, columnIndex: number): string {
  return `stored-assays/${layerIndex}/${columnIndex}.f32`;
}

function layerKey(fcsDigest: string, bindingSignature: string): string {
  return `${fcsDigest}\n${bindingSignature}`;
}

function parseManifestObject(value: unknown): StoredAssayManifest {
  if (!isRecord(value)) fail("invalid-manifest", "the manifest must be an object.");
  exactKeys(value, ["schema", "encoding", "layers"], "the manifest");
  if (value.schema !== STORED_ASSAY_SCHEMA) fail("invalid-manifest", `unsupported schema '${String(value.schema)}'.`);
  if (value.encoding !== STORED_ASSAY_ENCODING) fail("invalid-manifest", `unsupported encoding '${String(value.encoding)}'.`);
  const seen = new Set<string>();
  const layers = denseArray(value.layers, "the manifest's layers").map((candidate, layerIndex): StoredAssayLayerManifest => {
    const label = `layer ${layerIndex + 1}`;
    if (!isRecord(candidate)) fail("invalid-manifest", `${label} must be an object.`);
    exactKeys(candidate, [
      "dataPath", "fcsDigest", "eventCount", "profileId", "profileHash", "matrixHash", "bindingSignature", "columns",
    ], label);
    if (typeof candidate.dataPath !== "string" || !isSafeDataPath(candidate.dataPath)) {
      fail("invalid-manifest", `${label} has an unsafe dataPath.`);
    }
    if (
      typeof candidate.profileId !== "string" || candidate.profileId.length === 0 ||
      candidate.profileId.length > MAX_PROFILE_ID_LENGTH
    ) fail("invalid-manifest", `${label} has an invalid profileId.`);
    if (
      typeof candidate.bindingSignature !== "string" || candidate.bindingSignature.length === 0 ||
      candidate.bindingSignature.length > MAX_SIGNATURE_LENGTH
    ) fail("invalid-manifest", `${label} has an invalid binding signature.`);
    const fcsDigest = digest(candidate.fcsDigest, `${label} FCS digest`);
    const key = layerKey(fcsDigest, candidate.bindingSignature);
    if (seen.has(key)) fail("invalid-manifest", `${label} repeats an earlier layer.`);
    seen.add(key);
    const eventCount = nonNegativeInteger(candidate.eventCount, `${label} event count`);
    const columns = denseArray(candidate.columns, `${label} columns`).map((raw, columnIndex): StoredAssayColumnManifest => {
      const columnLabel = `${label} column ${columnIndex + 1}`;
      if (!isRecord(raw)) fail("invalid-manifest", `${columnLabel} must be an object.`);
      exactKeys(raw, ["pnn", "fcsColumnIndex", "path", "byteLength", "digest"], columnLabel);
      if (typeof raw.pnn !== "string" || raw.pnn.length === 0) fail("invalid-manifest", `${columnLabel} has no $PnN.`);
      if (raw.path !== storedAssayColumnPath(layerIndex, columnIndex)) fail("invalid-manifest", `${columnLabel} has an invalid path.`);
      const byteLength = nonNegativeInteger(raw.byteLength, `${columnLabel} byte length`);
      if (byteLength !== eventCount * Float32Array.BYTES_PER_ELEMENT) {
        fail("invalid-manifest", `${columnLabel} byte length does not match the event count.`);
      }
      return Object.freeze({
        pnn: raw.pnn,
        fcsColumnIndex: nonNegativeInteger(raw.fcsColumnIndex, `${columnLabel} FCS index`),
        path: raw.path,
        byteLength,
        digest: digest(raw.digest, `${columnLabel} digest`),
      });
    });
    if (columns.length === 0) fail("invalid-manifest", `${label} has no columns.`);
    return Object.freeze({
      dataPath: candidate.dataPath,
      fcsDigest,
      eventCount,
      profileId: candidate.profileId,
      profileHash: digest(candidate.profileHash, `${label} profile hash`),
      matrixHash: digest(candidate.matrixHash, `${label} matrix hash`),
      bindingSignature: candidate.bindingSignature,
      columns: Object.freeze(columns),
    });
  });
  return Object.freeze({ schema: STORED_ASSAY_SCHEMA, encoding: STORED_ASSAY_ENCODING, layers: Object.freeze(layers) });
}

export function parseStoredAssayManifest(bytes: Uint8Array): StoredAssayManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(bytes));
  } catch {
    fail("invalid-manifest", "the manifest JSON could not be parsed.");
  }
  return parseManifestObject(parsed);
}

/**
 * Locates every column the manifest declares, without reading one. A declared column that is
 * missing or of the wrong size, or a `stored-assays/` entry the manifest does not declare, refuses
 * the section.
 */
export async function locateStoredAssays(file: File, manifestBytes: Uint8Array): Promise<StoredAssayArchive> {
  const manifest = parseStoredAssayManifest(manifestBytes);
  const located = await locateZipFileEntries(
    file,
    (path) => path.startsWith("stored-assays/") && path !== STORED_ASSAY_MANIFEST_PATH,
  );
  if (!located) fail("unreadable-archive", "the bundle's directory cannot be read, so its stored layers cannot be located.");
  const declared = new Set<string>();
  for (const layer of manifest.layers) {
    for (const column of layer.columns) {
      declared.add(column.path);
      const entry = located.get(column.path);
      if (!entry) fail("missing-file", `the declared file '${column.path}' is missing.`);
      if (entry.size !== column.byteLength) fail("corrupt-column", `'${column.path}' is not its declared size.`);
    }
  }
  for (const path of located.keys()) {
    if (!declared.has(path)) fail("unexpected-file", `the file '${path}' is not declared.`);
  }
  return Object.freeze({ manifest, file, locations: located });
}

/** The values of one column of a stored layer, read from the bundle and checked against its SHA-256. */
export async function readStoredAssayColumn(
  archive: StoredAssayArchive,
  column: StoredAssayColumnManifest,
  eventCount: number,
): Promise<Float32Array> {
  const location = archive.locations.get(column.path);
  if (!location) fail("missing-file", `the file '${column.path}' is missing.`);
  const bytes = await readLocatedZipEntry(archive.file, location);
  if (bytes.byteLength !== column.byteLength || bytes.byteLength !== eventCount * Float32Array.BYTES_PER_ELEMENT) {
    fail("corrupt-column", `'${column.path}' is not its declared size.`);
  }
  if (await digestBytesSha256(bytes) !== column.digest) {
    fail("corrupt-column", `'${column.path}' failed its SHA-256 check.`);
  }
  return decodeFloat32LittleEndian(bytes, eventCount);
}

/** Float32 values as the bundle stores them: little-endian, whatever the machine's order. */
export function float32ColumnBytes(values: Float32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(values.buffer as ArrayBuffer, values.byteOffset, values.byteLength);
  const bytes = new Uint8Array(values.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index], true);
  return bytes;
}

export function decodeFloat32LittleEndian(bytes: Uint8Array, eventCount: number): Float32Array {
  if (bytes.byteLength !== eventCount * Float32Array.BYTES_PER_ELEMENT) {
    fail("corrupt-column", "a stored column has the wrong byte length.");
  }
  const values = new Float32Array(eventCount);
  if (LITTLE_ENDIAN) {
    new Uint8Array(values.buffer).set(bytes);
    return values;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < eventCount; index++) values[index] = view.getFloat32(index * 4, true);
  return values;
}

/** One layer to be written: its identity, and each column's size, digest and bytes on demand. */
export interface StoredAssayLayerSource {
  readonly dataPath: string;
  readonly fcsDigest: Sha256Digest;
  readonly eventCount: number;
  readonly profileId: string;
  readonly profileHash: Sha256Digest;
  readonly matrixHash: Sha256Digest;
  readonly bindingSignature: string;
  readonly columns: readonly {
    readonly pnn: string;
    readonly fcsColumnIndex: number;
    readonly byteLength: number;
    readonly digest: Sha256Digest;
    /** The column's little-endian Float32 bytes (float32ColumnBytes). */
    readonly read: () => Promise<Uint8Array>;
  }[];
}

export interface StoredAssayArchivePlan {
  readonly manifest: StoredAssayManifest;
  readonly entries: readonly ({ readonly path: string; readonly bytes: Uint8Array } | LazyStreamZipEntry)[];
  readonly payloadByteLength: number;
}

/**
 * The manifest and lazy entries for a bundle's stored layers. Each column's bytes are read when
 * the bundle writer reaches it, and checked against the digest the manifest declares, so a column
 * that changed after the plan was made is never written under it.
 */
export function createStoredAssayArchivePlan(layers: readonly StoredAssayLayerSource[]): StoredAssayArchivePlan | null {
  if (layers.length === 0) return null;
  const lazy: LazyStreamZipEntry[] = [];
  const manifestLayers = layers.map((layer, layerIndex) => ({
    dataPath: layer.dataPath,
    fcsDigest: layer.fcsDigest,
    eventCount: layer.eventCount,
    profileId: layer.profileId,
    profileHash: layer.profileHash,
    matrixHash: layer.matrixHash,
    bindingSignature: layer.bindingSignature,
    columns: layer.columns.map((column, columnIndex) => {
      const path = storedAssayColumnPath(layerIndex, columnIndex);
      lazy.push(Object.freeze({
        path,
        byteLength: column.byteLength,
        read: async () => {
          const bytes = await column.read();
          if (bytes.byteLength !== column.byteLength || await digestBytesSha256(bytes) !== column.digest) {
            fail("corrupt-column", `the stored column '${column.pnn}' changed after the save began.`);
          }
          return bytes;
        },
      }));
      return {
        pnn: column.pnn,
        fcsColumnIndex: column.fcsColumnIndex,
        path,
        byteLength: column.byteLength,
        digest: column.digest,
      };
    }),
  }));
  // Validated as a reader will read it, so a bundle is never written that the reader refuses.
  const manifest = parseManifestObject({ schema: STORED_ASSAY_SCHEMA, encoding: STORED_ASSAY_ENCODING, layers: manifestLayers });
  return Object.freeze({
    manifest,
    entries: Object.freeze([
      Object.freeze({ path: STORED_ASSAY_MANIFEST_PATH, bytes: strToU8(JSON.stringify(manifest, null, 2)) }),
      ...lazy,
    ]),
    payloadByteLength: lazy.reduce((sum, entry) => sum + entry.byteLength, 0),
  });
}
