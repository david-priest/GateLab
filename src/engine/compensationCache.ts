import type { Sha256Digest } from "./compensationProfile";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";
import { Sample, type AssayLayer, type CompensatedLayerColumn } from "./sample";

const CACHE_SCHEMA = "gatelab.compensated-assay-cache.v1" as const;
const DB_NAME = "gatelab-compensated-assay-cache";
const DB_VERSION = 1;
const STORE_NAME = "layers";

// Avoid a browser-local acceleration cache causing a second very large in-memory copy. Large
// assays remain scientifically restorable from the saved profile and show normal Apply progress.
export const MAX_CACHED_COMPENSATED_BYTES = 256 * 1024 * 1024;

export interface CachedCompensatedAssay {
  readonly schema: typeof CACHE_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly fcsDigest: Sha256Digest;
  readonly bindingSignature: string;
  readonly eventCount: number;
  readonly byteLength: number;
  readonly columns: readonly CompensatedLayerColumn[];
}

export type CompensationCacheWriteResult = "saved" | "too-large" | "unavailable";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Exact SHA-256 identity for an owned or borrowed byte view. */
export async function digestBytesSha256(bytes: Uint8Array): Promise<Sha256Digest> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Compensation cache hashing requires Web Crypto (HTTPS or localhost).");
  }
  const source = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength &&
      bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

/** Exact identity of the original source data used to compute a derived assay. */
export const digestFcsBytes = digestBytesSha256;

/** Stable exact scientific/runtime binding check stored alongside the derived columns. */
export function compensatedBindingSignature(binding: PersistedCompensatedLayerBinding): string {
  return JSON.stringify({
    profileId: binding.profileId,
    profileHash: binding.profileHash,
    matrixHash: binding.matrixHash,
    kind: binding.kind,
    method: binding.method,
    includedPnns: Array.from(binding.includedPnns),
    channelBindings: binding.channelBindings.map((channel) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.fcsColumnIndex,
      matrixSourceIndex: channel.matrixSourceIndex,
      matrixReceiverIndex: channel.matrixReceiverIndex,
      included: channel.included,
    })),
    transformBinding: binding.transformBinding.kind === "cytof-asinh"
      ? { kind: "cytof-asinh", cofactor: binding.transformBinding.cofactor }
      : { kind: "flow-linear" },
  });
}

export function compensatedAssayCacheId(
  fcsDigest: Sha256Digest,
  binding: PersistedCompensatedLayerBinding,
): string {
  const transform = binding.transformBinding.kind === "cytof-asinh"
    ? `cytof-asinh:${binding.transformBinding.cofactor}`
    : "flow-linear";
  return `${CACHE_SCHEMA}:${fcsDigest}:${binding.profileHash}:${transform}`;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the compensation cache."));
  });
}

function getRecord(db: IDBDatabase, id: string): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read the compensation cache."));
  });
}

function putRecord(db: IDBDatabase, record: CachedCompensatedAssay): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not write the compensation cache."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Compensation cache write was aborted."));
  });
}

function deleteRecord(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove an invalid compensation cache entry."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Compensation cache removal was aborted."));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate untrusted browser storage before any values enter Sample's atomic layer installer. */
export function validateCachedCompensatedAssay(
  value: unknown,
  fcsDigest: Sha256Digest,
  binding: PersistedCompensatedLayerBinding,
  eventCount: number,
): CachedCompensatedAssay | null {
  if (!isRecord(value)) return null;
  const id = compensatedAssayCacheId(fcsDigest, binding);
  if (
    value.schema !== CACHE_SCHEMA || value.id !== id || value.fcsDigest !== fcsDigest ||
    value.bindingSignature !== compensatedBindingSignature(binding) ||
    value.eventCount !== eventCount || !Array.isArray(value.columns)
  ) return null;

  const expected = binding.channelBindings.filter(({ included }) => included);
  if (value.columns.length !== expected.length) return null;
  let byteLength = 0;
  const columns: CompensatedLayerColumn[] = [];
  for (let index = 0; index < expected.length; index++) {
    const raw = value.columns[index];
    const expectedColumn = expected[index];
    if (
      !isRecord(raw) || raw.pnn !== expectedColumn.pnn ||
      raw.fcsColumnIndex !== expectedColumn.fcsColumnIndex ||
      !(raw.values instanceof Float32Array) || raw.values.length !== eventCount
    ) return null;
    byteLength += raw.values.byteLength;
    columns.push({
      pnn: expectedColumn.pnn,
      fcsColumnIndex: expectedColumn.fcsColumnIndex,
      values: raw.values,
    });
  }
  if (value.byteLength !== byteLength || byteLength > MAX_CACHED_COMPENSATED_BYTES) return null;

  return {
    schema: CACHE_SCHEMA,
    id,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    fcsDigest,
    bindingSignature: compensatedBindingSignature(binding),
    eventCount,
    byteLength,
    columns,
  };
}

/** Read a best-effort browser-local derived layer. A miss never blocks scientific restoration. */
export async function readCachedCompensatedAssay(
  fcsDigest: Sha256Digest,
  binding: PersistedCompensatedLayerBinding,
  eventCount: number,
): Promise<CachedCompensatedAssay | null> {
  let db: IDBDatabase | null = null;
  const id = compensatedAssayCacheId(fcsDigest, binding);
  try {
    db = await openCacheDb();
    const raw = await getRecord(db, id);
    if (raw === null) return null;
    const valid = validateCachedCompensatedAssay(raw, fcsDigest, binding, eventCount);
    if (valid) return valid;
    await deleteRecord(db, id);
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function captureColumns(
  sample: Sample,
  binding: PersistedCompensatedLayerBinding,
): readonly CompensatedLayerColumn[] | null {
  if (sample.compensatedLayerStatus(binding).state !== "ready") return null;
  const columns: CompensatedLayerColumn[] = [];
  for (const expected of binding.channelBindings.filter(({ included }) => included)) {
    const resolvedIndex = sample.channels.findIndex(({ pnn, columnIndex }) =>
      pnn === expected.pnn && columnIndex === expected.fcsColumnIndex
    );
    if (resolvedIndex < 0) return null;
    const values = sample.compensatedColumnData(resolvedIndex, binding);
    if (!(values instanceof Float32Array)) return null;
    columns.push({
      pnn: expected.pnn,
      fcsColumnIndex: expected.fcsColumnIndex,
      values,
    });
  }
  return columns;
}

/** Persist immutable derived columns after a successful, fully verified compensation Apply. */
export async function writeCachedCompensatedAssay(
  fcsDigest: Sha256Digest,
  sample: Sample,
  binding: PersistedCompensatedLayerBinding,
): Promise<CompensationCacheWriteResult> {
  const byteLength = binding.channelBindings.filter(({ included }) => included).length *
    sample.fcs.nEvents * Float32Array.BYTES_PER_ELEMENT;
  if (byteLength > MAX_CACHED_COMPENSATED_BYTES) return "too-large";
  const columns = captureColumns(sample, binding);
  if (!columns) return "unavailable";

  const record: CachedCompensatedAssay = {
    schema: CACHE_SCHEMA,
    id: compensatedAssayCacheId(fcsDigest, binding),
    createdAt: new Date().toISOString(),
    fcsDigest,
    bindingSignature: compensatedBindingSignature(binding),
    eventCount: sample.fcs.nEvents,
    byteLength,
    columns,
  };
  let db: IDBDatabase | null = null;
  try {
    db = await openCacheDb();
    await putRecord(db, record);
    return "saved";
  } catch {
    return "unavailable";
  } finally {
    db?.close();
  }
}

/** Atomically install a validated cached layer; Sample rechecks identity, size and finiteness. */
export function installCachedCompensatedAssay(
  sample: Sample,
  cached: CachedCompensatedAssay,
  binding: PersistedCompensatedLayerBinding,
  activeLayer: AssayLayer,
): boolean {
  try {
    sample.installCompensatedLayer({ metadata: binding, columns: cached.columns }, { activeLayer });
    return sample.compensatedLayerStatus(binding).state === "ready" &&
      sample.activeLayer === activeLayer;
  } catch {
    return false;
  }
}
