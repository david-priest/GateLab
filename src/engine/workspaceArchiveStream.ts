import { Unzip, UnzipInflate, Zip, ZipPassThrough } from "fflate";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_UNKNOWN_ENTRY_LIMIT = 64 * 1024 * 1024;

export interface StreamZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface StreamZipWriteProgress {
  readonly writtenPayloadBytes: number;
  readonly totalPayloadBytes: number;
  readonly entryIndex: number;
  readonly entryCount: number;
}

export interface StreamZipWriteOptions {
  readonly chunkBytes?: number;
  readonly onProgress?: (progress: StreamZipWriteProgress) => void;
}

export type ZipChunkSink = (chunk: Uint8Array) => void | Promise<void>;

function safeArchivePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

/**
 * Incrementally write a STORE-mode ZIP. Cytometry Float32 payloads compress weakly; avoiding a
 * second whole-archive buffer is more valuable than a small size reduction for multi-GB files.
 */
export async function writeStoredZip(
  entries: readonly StreamZipEntry[],
  sink: ZipChunkSink,
  options: StreamZipWriteOptions = {},
): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("A workspace ZIP requires at least one entry.");
  }
  const chunkBytes = positiveSafeInteger(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, "ZIP chunk size");
  const seenPaths = new Set<string>();
  let totalPayloadBytes = 0;
  for (const entry of entries) {
    if (!entry || !safeArchivePath(entry.path) || seenPaths.has(entry.path)) {
      throw new Error(`Unsafe or duplicate ZIP entry '${entry?.path ?? ""}'.`);
    }
    if (!(entry.bytes instanceof Uint8Array)) throw new Error(`ZIP entry '${entry.path}' has no byte payload.`);
    seenPaths.add(entry.path);
    totalPayloadBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalPayloadBytes)) throw new Error("Workspace ZIP payload is too large.");
  }

  let outputChain = Promise.resolve();
  let finalResolve: (() => void) | null = null;
  let finalReject: ((error: unknown) => void) | null = null;
  const finalOutput = new Promise<void>((resolve, reject) => {
    finalResolve = resolve;
    finalReject = reject;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      finalReject?.(error);
      return;
    }
    // fflate may reuse its output view after the callback; the sink must receive an owned chunk.
    const owned = chunk.slice();
    outputChain = outputChain.then(() => sink(owned));
    if (final) outputChain.then(() => finalResolve?.(), (cause) => finalReject?.(cause));
  });

  let writtenPayloadBytes = 0;
  try {
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
      const entry = entries[entryIndex];
      const file = new ZipPassThrough(entry.path);
      zip.add(file);
      if (entry.bytes.byteLength === 0) {
        file.push(new Uint8Array(0), true);
      } else {
        for (let start = 0; start < entry.bytes.byteLength; start += chunkBytes) {
          const end = Math.min(entry.bytes.byteLength, start + chunkBytes);
          file.push(entry.bytes.subarray(start, end), end === entry.bytes.byteLength);
          writtenPayloadBytes += end - start;
          await outputChain;
          options.onProgress?.(Object.freeze({
            writtenPayloadBytes,
            totalPayloadBytes,
            entryIndex,
            entryCount: entries.length,
          }));
        }
      }
      await outputChain;
    }
    zip.end();
    await finalOutput;
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

export interface StreamZipReadOptions {
  /** Entries returning false are skipped without decompression or allocation. */
  readonly select: (path: string) => boolean;
  /** Exact size hint, mutable as earlier metadata entries are decoded. */
  readonly expectedSize?: (path: string) => number | undefined;
  /** Called synchronously when an entry is complete, before later archive entries are read. */
  readonly onEntry?: (path: string, bytes: Uint8Array) => void;
  readonly unknownEntryLimit?: number | ((path: string) => number);
  /** Aggregate decompressed-byte ceiling across every selected entry. */
  readonly totalOutputLimit?: number;
}

/** Stream selected entries from a File without retaining the complete compressed archive. */
export async function readZipFileEntries(
  file: File,
  options: StreamZipReadOptions,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const unknownEntryLimitFor = (path: string): number => positiveSafeInteger(
    typeof options.unknownEntryLimit === "function"
      ? options.unknownEntryLimit(path)
      : options.unknownEntryLimit ?? DEFAULT_UNKNOWN_ENTRY_LIMIT,
    "Unknown ZIP entry limit",
  );
  const entries: Record<string, Uint8Array> = {};
  const seenPaths = new Set<string>();
  const pending: Promise<void>[] = [];
  let streamError: unknown = null;
  const totalOutputLimit = positiveSafeInteger(
    options.totalOutputLimit ?? Number.MAX_SAFE_INTEGER,
    "ZIP total output limit",
  );
  let totalReceived = 0;

  const unzip = new Unzip((archiveFile) => {
    if (!options.select(archiveFile.name)) return;
    if (!safeArchivePath(archiveFile.name) || seenPaths.has(archiveFile.name)) {
      streamError = new Error(`Unsafe or duplicate ZIP entry '${archiveFile.name}'.`);
      archiveFile.terminate();
      return;
    }
    seenPaths.add(archiveFile.name);
    const expected = options.expectedSize?.(archiveFile.name);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      streamError = new Error(`Invalid expected byte length for ZIP entry '${archiveFile.name}'.`);
      archiveFile.terminate();
      return;
    }

    let resolveEntry: (() => void) | null = null;
    let rejectEntry: ((error: unknown) => void) | null = null;
    const complete = new Promise<void>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    pending.push(complete);
    let exact = expected === undefined ? null : new Uint8Array(expected);
    const chunks: Uint8Array[] = [];
    let received = 0;
    archiveFile.ondata = (error, chunk, final) => {
      if (error) {
        streamError = error;
        rejectEntry?.(error);
        return;
      }
      try {
        received += chunk.byteLength;
        totalReceived += chunk.byteLength;
        if (!Number.isSafeInteger(totalReceived) || totalReceived > totalOutputLimit) {
          throw new Error("Selected ZIP contents exceed the aggregate decompressed-byte safety limit.");
        }
        if (exact !== null) {
          if (received > exact.byteLength) {
            throw new Error(`ZIP entry '${archiveFile.name}' exceeds its declared byte length.`);
          }
          exact.set(chunk, received - chunk.byteLength);
        } else {
          if (received > unknownEntryLimitFor(archiveFile.name)) {
            throw new Error(`ZIP metadata entry '${archiveFile.name}' exceeds the safety limit.`);
          }
          chunks.push(chunk.slice());
        }
        if (!final) return;
        if (exact !== null && received !== exact.byteLength) {
          throw new Error(`ZIP entry '${archiveFile.name}' does not match its declared byte length.`);
        }
        if (exact === null) {
          exact = new Uint8Array(received);
          let offset = 0;
          for (const part of chunks) {
            exact.set(part, offset);
            offset += part.byteLength;
          }
        }
        entries[archiveFile.name] = exact;
        options.onEntry?.(archiveFile.name, exact);
        resolveEntry?.();
      } catch (cause) {
        streamError = cause;
        archiveFile.terminate();
        rejectEntry?.(cause);
      }
    };
    archiveFile.start();
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (streamError) throw streamError;
      unzip.push(value, false);
    }
    if (streamError) throw streamError;
    unzip.push(new Uint8Array(0), true);
    await Promise.all(pending);
    if (streamError) throw streamError;
    return Object.freeze(entries);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
