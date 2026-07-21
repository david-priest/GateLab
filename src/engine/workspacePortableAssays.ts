import { strFromU8, strToU8 } from "fflate";
import {
  compensatedBindingSignature,
  digestBytesSha256,
} from "./compensationCache";
import type { Sha256Digest } from "./compensationProfile";
import {
  Sample,
  type CompensatedLayerColumn,
  type PreparedCompensatedLayer,
} from "./sample";
import type { WorkspaceFileV3 } from "./workspaceV3";

export const PORTABLE_ASSAY_MANIFEST_PATH = "assays/manifest.json" as const;
export const PORTABLE_ASSAY_SCHEMA = "gatelab.portable-assays.v1" as const;
export const PORTABLE_ASSAY_ENCODING = "float32-le" as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

export interface PortableArchiveFile {
  readonly path: string;
  /** Borrowed immutable bytes. The archive writer must not mutate them. */
  readonly bytes: Uint8Array;
}

export interface PortableWorkspaceSampleSource {
  readonly dataPath: string;
  readonly fcsBytes: Uint8Array;
  readonly sample: Sample;
}

export interface PortableAssayColumnManifest {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  readonly path: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

export interface PortableAssayLayerManifest {
  readonly bindingSignature: string;
  readonly profileHash: Sha256Digest;
  readonly matrixHash: Sha256Digest;
  readonly columns: readonly PortableAssayColumnManifest[];
}

export interface PortableAssaySampleManifest {
  readonly dataPath: string;
  readonly fcsDigest: Sha256Digest;
  readonly fcsByteLength: number;
  readonly eventCount: number;
  readonly assay: PortableAssayLayerManifest | null;
}

export interface PortableAssayManifest {
  readonly schema: typeof PORTABLE_ASSAY_SCHEMA;
  readonly encoding: typeof PORTABLE_ASSAY_ENCODING;
  readonly samples: readonly PortableAssaySampleManifest[];
}

export interface PortableAssayArchivePlan {
  readonly manifest: PortableAssayManifest;
  readonly manifestBytes: Uint8Array;
  readonly fcsFiles: readonly PortableArchiveFile[];
  readonly assayFiles: readonly PortableArchiveFile[];
  readonly payloadByteLength: number;
}

export interface PortableAssayArchiveEnvelope {
  readonly manifest: PortableAssayManifest;
  /** Only the binary assay entries declared by the manifest. */
  readonly files: Readonly<Record<string, Uint8Array>>;
}

export interface PortableAssayProgress {
  readonly phase: "hashing-fcs" | "hashing-assay" | "restoring";
  readonly processedBytes: number;
  readonly totalBytes: number;
  readonly sampleIndex: number;
  readonly sampleCount: number;
}

export interface PortableAssayPlanOptions {
  readonly onProgress?: (progress: PortableAssayProgress) => void;
  /** Throws when the caller has cancelled or replaced the surrounding workspace operation. */
  readonly checkCancelled?: () => void;
}

export interface PortableAssayRestoreResult {
  readonly sampleCount: number;
  readonly eventCount: number;
  readonly sourceDigests: Readonly<Record<string, Sha256Digest>>;
}

export class PortableAssayError extends Error {
  readonly code:
    | "invalid-manifest"
    | "missing-file"
    | "unexpected-file"
    | "source-mismatch"
    | "binding-mismatch"
    | "corrupt-column";

  constructor(code: PortableAssayError["code"], message: string) {
    super(`Invalid portable assay bundle: ${message}`);
    this.name = "PortableAssayError";
    this.code = code;
  }
}

function fail(code: PortableAssayError["code"], message: string): never {
  throw new PortableAssayError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail("invalid-manifest", `${label} has an invalid field set.`);
  }
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-manifest", `${label} must be an array.`);
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail("invalid-manifest", `${label} must not contain sparse entries.`);
    }
  }
  return value;
}

function isSafeDataPath(value: string): boolean {
  return value.startsWith("data/") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid-manifest", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value as Sha256Digest;
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-manifest", `${label} must be a non-negative safe integer.`);
  }
  return Object.is(value, -0) ? 0 : value as number;
}

function parseManifestObject(value: unknown): PortableAssayManifest {
  if (!isRecord(value)) fail("invalid-manifest", "manifest must be an object.");
  assertExactKeys(value, ["schema", "encoding", "samples"], "manifest");
  if (value.schema !== PORTABLE_ASSAY_SCHEMA) {
    fail("invalid-manifest", `unsupported schema '${String(value.schema)}'.`);
  }
  if (value.encoding !== PORTABLE_ASSAY_ENCODING) {
    fail("invalid-manifest", `unsupported assay encoding '${String(value.encoding)}'.`);
  }

  const rawSamples = denseArray(value.samples, "manifest samples");
  const seenDataPaths = new Set<string>();
  const seenAssayPaths = new Set<string>();
  const samples = rawSamples.map((candidate, sampleIndex): PortableAssaySampleManifest => {
    if (!isRecord(candidate)) fail("invalid-manifest", `sample ${sampleIndex + 1} must be an object.`);
    assertExactKeys(
      candidate,
      ["dataPath", "fcsDigest", "fcsByteLength", "eventCount", "assay"],
      `sample ${sampleIndex + 1}`,
    );
    if (typeof candidate.dataPath !== "string" || !isSafeDataPath(candidate.dataPath)) {
      fail("invalid-manifest", `sample ${sampleIndex + 1} has an unsafe dataPath.`);
    }
    if (seenDataPaths.has(candidate.dataPath)) {
      fail("invalid-manifest", `sample dataPath '${candidate.dataPath}' is duplicated.`);
    }
    seenDataPaths.add(candidate.dataPath);
    const fcsDigest = parseDigest(candidate.fcsDigest, `sample ${sampleIndex + 1} FCS digest`);
    const fcsByteLength = safeNonNegativeInteger(
      candidate.fcsByteLength,
      `sample ${sampleIndex + 1} FCS byte length`,
    );
    const eventCount = safeNonNegativeInteger(
      candidate.eventCount,
      `sample ${sampleIndex + 1} event count`,
    );

    let assay: PortableAssayLayerManifest | null = null;
    if (candidate.assay !== null) {
      if (!isRecord(candidate.assay)) {
        fail("invalid-manifest", `sample ${sampleIndex + 1} assay must be an object or null.`);
      }
      assertExactKeys(
        candidate.assay,
        ["bindingSignature", "profileHash", "matrixHash", "columns"],
        `sample ${sampleIndex + 1} assay`,
      );
      if (
        typeof candidate.assay.bindingSignature !== "string" ||
        candidate.assay.bindingSignature.length === 0
      ) {
        fail("invalid-manifest", `sample ${sampleIndex + 1} has an invalid binding signature.`);
      }
      const profileHash = parseDigest(
        candidate.assay.profileHash,
        `sample ${sampleIndex + 1} profile hash`,
      );
      const matrixHash = parseDigest(
        candidate.assay.matrixHash,
        `sample ${sampleIndex + 1} matrix hash`,
      );
      const rawColumns = denseArray(
        candidate.assay.columns,
        `sample ${sampleIndex + 1} assay columns`,
      );
      if (rawColumns.length === 0) {
        fail("invalid-manifest", `sample ${sampleIndex + 1} assay has no columns.`);
      }
      const columns = rawColumns.map((rawColumn, columnIndex): PortableAssayColumnManifest => {
        if (!isRecord(rawColumn)) {
          fail("invalid-manifest", `sample ${sampleIndex + 1} column ${columnIndex + 1} must be an object.`);
        }
        assertExactKeys(
          rawColumn,
          ["pnn", "fcsColumnIndex", "path", "byteLength", "digest"],
          `sample ${sampleIndex + 1} column ${columnIndex + 1}`,
        );
        if (typeof rawColumn.pnn !== "string" || rawColumn.pnn.length === 0) {
          fail("invalid-manifest", `sample ${sampleIndex + 1} column ${columnIndex + 1} has no $PnN.`);
        }
        const fcsColumnIndex = safeNonNegativeInteger(
          rawColumn.fcsColumnIndex,
          `sample ${sampleIndex + 1} column ${columnIndex + 1} FCS index`,
        );
        const path = `assays/${sampleIndex}/columns/${columnIndex}.f32`;
        if (rawColumn.path !== path || seenAssayPaths.has(path)) {
          fail("invalid-manifest", `sample ${sampleIndex + 1} column ${columnIndex + 1} has an invalid path.`);
        }
        seenAssayPaths.add(path);
        const byteLength = safeNonNegativeInteger(
          rawColumn.byteLength,
          `sample ${sampleIndex + 1} column ${columnIndex + 1} byte length`,
        );
        if (byteLength !== eventCount * Float32Array.BYTES_PER_ELEMENT) {
          fail(
            "invalid-manifest",
            `sample ${sampleIndex + 1} column ${columnIndex + 1} byte length does not match its event count.`,
          );
        }
        return Object.freeze({
          pnn: rawColumn.pnn,
          fcsColumnIndex,
          path,
          byteLength,
          digest: parseDigest(
            rawColumn.digest,
            `sample ${sampleIndex + 1} column ${columnIndex + 1} digest`,
          ),
        });
      });
      assay = Object.freeze({
        bindingSignature: candidate.assay.bindingSignature,
        profileHash,
        matrixHash,
        columns: Object.freeze(columns),
      });
    }
    return Object.freeze({
      dataPath: candidate.dataPath,
      fcsDigest,
      fcsByteLength,
      eventCount,
      assay,
    });
  });
  return Object.freeze({
    schema: PORTABLE_ASSAY_SCHEMA,
    encoding: PORTABLE_ASSAY_ENCODING,
    samples: Object.freeze(samples),
  });
}

export function parsePortableAssayManifest(bytes: Uint8Array): PortableAssayManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(bytes));
  } catch {
    fail("invalid-manifest", "manifest JSON could not be parsed.");
  }
  return parseManifestObject(parsed);
}

export function portableAssayExpectedFileSizes(
  manifest: PortableAssayManifest,
): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  for (const sample of manifest.samples) {
    sizes.set(sample.dataPath, sample.fcsByteLength);
    for (const column of sample.assay?.columns ?? []) sizes.set(column.path, column.byteLength);
  }
  return sizes;
}

function float32LittleEndianBytes(values: Float32Array): Uint8Array {
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    values.buffer instanceof SharedArrayBuffer
  ) {
    fail("binding-mismatch", "SharedArrayBuffer assay columns cannot be archived.");
  }
  if (LITTLE_ENDIAN) {
    return new Uint8Array(
      values.buffer as ArrayBuffer,
      values.byteOffset,
      values.byteLength,
    );
  }
  const bytes = new Uint8Array(values.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, values[index], true);
  }
  return bytes;
}

function decodeFloat32LittleEndian(bytes: Uint8Array, eventCount: number): Float32Array {
  if (bytes.byteLength !== eventCount * Float32Array.BYTES_PER_ELEMENT) {
    fail("corrupt-column", "a compensated column has the wrong byte length.");
  }
  if (LITTLE_ENDIAN && bytes.buffer instanceof ArrayBuffer && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, eventCount);
  }
  const values = new Float32Array(eventCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < eventCount; index++) {
    values[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}

function findCompensatedColumn(
  sample: Sample,
  pnn: string,
  fcsColumnIndex: number,
): Float32Array {
  const resolvedIndex = sample.channels.findIndex(
    (channel) => channel.pnn === pnn && channel.columnIndex === fcsColumnIndex,
  );
  if (resolvedIndex < 0) {
    fail("binding-mismatch", `sample channel '${pnn}' no longer matches its saved FCS index.`);
  }
  const values = sample.compensatedColumnData(resolvedIndex);
  if (!(values instanceof Float32Array) || values.length !== sample.fcs.nEvents) {
    fail("binding-mismatch", `compensated channel '${pnn}' is not a complete Float32 column.`);
  }
  return values;
}

/**
 * Snapshot exact FCS and installed linear compensated layers without copying the large arrays.
 * Hashes are computed before writing so a partially written archive is never presented as valid.
 */
export async function createPortableAssayArchivePlan(
  workspace: WorkspaceFileV3,
  sources: readonly PortableWorkspaceSampleSource[],
  options: PortableAssayPlanOptions = {},
): Promise<PortableAssayArchivePlan> {
  if (sources.length !== workspace.samples.length) {
    fail("binding-mismatch", "workspace samples and loaded sample sources do not align.");
  }

  const preflight = workspace.samples.map((workspaceSample, sampleIndex) => {
    const source = sources[sampleIndex];
    if (
      !source || source.dataPath !== workspaceSample.dataPath ||
      !(source.fcsBytes instanceof Uint8Array)
    ) {
      fail("binding-mismatch", `sample ${sampleIndex + 1} does not match its workspace dataPath.`);
    }
    if (source.sample.fcs.nEvents < 0 || !Number.isSafeInteger(source.sample.fcs.nEvents)) {
      fail("binding-mismatch", `sample ${sampleIndex + 1} has an invalid event count.`);
    }
    const binding = workspaceSample.assay.compensatedLayer;
    if (binding !== null && source.sample.compensatedLayerStatus(binding).state !== "ready") {
      fail("binding-mismatch", `sample ${sampleIndex + 1} does not have its exact saved compensated layer installed.`);
    }
    const columns = binding === null
      ? []
      : binding.channelBindings.filter(({ included }) => included).map(({ pnn, fcsColumnIndex }) => ({
          pnn,
          fcsColumnIndex,
          values: findCompensatedColumn(source.sample, pnn, fcsColumnIndex),
        }));
    return { workspaceSample, source, binding, columns };
  });

  const totalBytes = preflight.reduce(
    (total, item) => total + item.source.fcsBytes.byteLength +
      item.columns.reduce((sum, column) => sum + column.values.byteLength, 0),
    0,
  );
  let processedBytes = 0;
  const samples: PortableAssaySampleManifest[] = [];
  const fcsFiles: PortableArchiveFile[] = [];
  const assayFiles: PortableArchiveFile[] = [];

  for (let sampleIndex = 0; sampleIndex < preflight.length; sampleIndex++) {
    const item = preflight[sampleIndex];
    options.checkCancelled?.();
    const fcsDigest = await digestBytesSha256(item.source.fcsBytes);
    options.checkCancelled?.();
    processedBytes += item.source.fcsBytes.byteLength;
    options.onProgress?.(Object.freeze({
      phase: "hashing-fcs",
      processedBytes,
      totalBytes,
      sampleIndex,
      sampleCount: preflight.length,
    }));
    fcsFiles.push(Object.freeze({
      path: item.workspaceSample.dataPath,
      bytes: item.source.fcsBytes,
    }));

    let assay: PortableAssayLayerManifest | null = null;
    if (item.binding !== null) {
      const columns: PortableAssayColumnManifest[] = [];
      for (let columnIndex = 0; columnIndex < item.columns.length; columnIndex++) {
        options.checkCancelled?.();
        const sourceColumn = item.columns[columnIndex];
        const bytes = float32LittleEndianBytes(sourceColumn.values);
        const path = `assays/${sampleIndex}/columns/${columnIndex}.f32`;
        const digest = await digestBytesSha256(bytes);
        options.checkCancelled?.();
        processedBytes += bytes.byteLength;
        options.onProgress?.(Object.freeze({
          phase: "hashing-assay",
          processedBytes,
          totalBytes,
          sampleIndex,
          sampleCount: preflight.length,
        }));
        columns.push(Object.freeze({
          pnn: sourceColumn.pnn,
          fcsColumnIndex: sourceColumn.fcsColumnIndex,
          path,
          byteLength: bytes.byteLength,
          digest,
        }));
        assayFiles.push(Object.freeze({ path, bytes }));
      }
      assay = Object.freeze({
        bindingSignature: compensatedBindingSignature(item.binding),
        profileHash: item.binding.profileHash,
        matrixHash: item.binding.matrixHash,
        columns: Object.freeze(columns),
      });
    }
    samples.push(Object.freeze({
      dataPath: item.workspaceSample.dataPath,
      fcsDigest,
      fcsByteLength: item.source.fcsBytes.byteLength,
      eventCount: item.source.sample.fcs.nEvents,
      assay,
    }));
  }

  const manifest: PortableAssayManifest = Object.freeze({
    schema: PORTABLE_ASSAY_SCHEMA,
    encoding: PORTABLE_ASSAY_ENCODING,
    samples: Object.freeze(samples),
  });
  return Object.freeze({
    manifest,
    manifestBytes: strToU8(JSON.stringify(manifest, null, 2)),
    fcsFiles: Object.freeze(fcsFiles),
    assayFiles: Object.freeze(assayFiles),
    payloadByteLength: totalBytes,
  });
}

/** Validate and atomically install every portable layer; no Sample mutates on any failure. */
export async function restorePortableAssayLayers(
  envelope: PortableAssayArchiveEnvelope,
  workspace: WorkspaceFileV3,
  sources: readonly PortableWorkspaceSampleSource[],
  options: PortableAssayPlanOptions = {},
): Promise<PortableAssayRestoreResult> {
  const manifest = parseManifestObject(envelope.manifest);
  if (
    manifest.samples.length !== workspace.samples.length ||
    sources.length !== workspace.samples.length
  ) {
    fail("binding-mismatch", "manifest, workspace, and loaded sample counts do not match.");
  }

  const declaredFiles = new Set(
    manifest.samples.flatMap((sample) => sample.assay?.columns.map(({ path }) => path) ?? []),
  );
  for (const path of Object.keys(envelope.files)) {
    if (!declaredFiles.has(path)) fail("unexpected-file", `undeclared assay file '${path}' is present.`);
  }
  for (const path of declaredFiles) {
    if (!(envelope.files[path] instanceof Uint8Array)) {
      fail("missing-file", `declared assay file '${path}' is missing.`);
    }
  }

  const totalBytes = manifest.samples.reduce(
    (total, sample) => total + sample.fcsByteLength +
      (sample.assay?.columns.reduce((sum, column) => sum + column.byteLength, 0) ?? 0),
    0,
  );
  let processedBytes = 0;
  const prepared: PreparedCompensatedLayer[] = [];
  const sourceDigests: Record<string, Sha256Digest> = {};
  let restoredSamples = 0;
  let restoredEvents = 0;

  for (let sampleIndex = 0; sampleIndex < workspace.samples.length; sampleIndex++) {
    options.checkCancelled?.();
    const workspaceSample = workspace.samples[sampleIndex];
    const source = sources[sampleIndex];
    const manifestSample = manifest.samples[sampleIndex];
    if (
      !source || source.dataPath !== workspaceSample.dataPath ||
      manifestSample.dataPath !== workspaceSample.dataPath ||
      source.fcsBytes.byteLength !== manifestSample.fcsByteLength ||
      source.sample.fcs.nEvents !== manifestSample.eventCount
    ) {
      fail("source-mismatch", `sample ${sampleIndex + 1} does not match the archived source identity.`);
    }
    const fcsDigest = await digestBytesSha256(source.fcsBytes);
    options.checkCancelled?.();
    if (fcsDigest !== manifestSample.fcsDigest) {
      fail("source-mismatch", `sample ${sampleIndex + 1} FCS bytes do not match their archived SHA-256 digest.`);
    }
    sourceDigests[source.dataPath] = fcsDigest;
    processedBytes += source.fcsBytes.byteLength;
    options.onProgress?.(Object.freeze({
      phase: "restoring",
      processedBytes,
      totalBytes,
      sampleIndex,
      sampleCount: workspace.samples.length,
    }));

    const binding = workspaceSample.assay.compensatedLayer;
    if ((binding === null) !== (manifestSample.assay === null)) {
      fail("binding-mismatch", `sample ${sampleIndex + 1} portable layer availability does not match workspace state.`);
    }
    if (binding === null || manifestSample.assay === null) continue;
    if (
      manifestSample.assay.bindingSignature !== compensatedBindingSignature(binding) ||
      manifestSample.assay.profileHash !== binding.profileHash ||
      manifestSample.assay.matrixHash !== binding.matrixHash
    ) {
      fail("binding-mismatch", `sample ${sampleIndex + 1} compensation identity does not match workspace state.`);
    }
    const expectedBindings = binding.channelBindings.filter(({ included }) => included);
    if (manifestSample.assay.columns.length !== expectedBindings.length) {
      fail("binding-mismatch", `sample ${sampleIndex + 1} has an incomplete compensated layer.`);
    }

    const columns: CompensatedLayerColumn[] = [];
    for (let columnIndex = 0; columnIndex < expectedBindings.length; columnIndex++) {
      options.checkCancelled?.();
      const expected = expectedBindings[columnIndex];
      const archived = manifestSample.assay.columns[columnIndex];
      if (
        archived.pnn !== expected.pnn ||
        archived.fcsColumnIndex !== expected.fcsColumnIndex
      ) {
        fail("binding-mismatch", `sample ${sampleIndex + 1} compensated column identities do not match.`);
      }
      const bytes = envelope.files[archived.path];
      if (bytes.byteLength !== archived.byteLength) {
        fail("corrupt-column", `sample ${sampleIndex + 1} column '${archived.pnn}' has the wrong size.`);
      }
      const digest = await digestBytesSha256(bytes);
      options.checkCancelled?.();
      if (digest !== archived.digest) {
        fail("corrupt-column", `sample ${sampleIndex + 1} column '${archived.pnn}' failed its SHA-256 check.`);
      }
      columns.push(Object.freeze({
        pnn: expected.pnn,
        fcsColumnIndex: expected.fcsColumnIndex,
        values: decodeFloat32LittleEndian(bytes, manifestSample.eventCount),
      }));
      processedBytes += bytes.byteLength;
      options.onProgress?.(Object.freeze({
        phase: "restoring",
        processedBytes,
        totalBytes,
        sampleIndex,
        sampleCount: workspace.samples.length,
      }));
    }
    prepared.push(source.sample.prepareCompensatedLayer(
      { metadata: binding, columns },
      { activeLayer: workspaceSample.assay.activeLayer },
    ));
    restoredSamples++;
    restoredEvents += source.sample.fcs.nEvents;
  }

  options.checkCancelled?.();
  Sample.commitPreparedCompensatedLayers(prepared);
  return Object.freeze({
    sampleCount: restoredSamples,
    eventCount: restoredEvents,
    sourceDigests: Object.freeze(sourceDigests),
  });
}
