import { inflateSync, Unzip, UnzipInflate, Zip, ZipPassThrough } from "fflate";

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
  /**
   * Hand the sink each chunk as fflate emits it instead of a copy: for a stored entry, a view of
   * the entry's own bytes, and headers fflate allocates for each call (fflate 0.8's Zip and
   * ZipPassThrough reuse no output buffer). For a sink that keeps every chunk, such as the parts
   * of a Blob, this spares a whole copy of the archive; the entries' bytes must not change after.
   */
  readonly borrowChunks?: boolean;
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
    // fflate may reuse its output view after the callback; the sink must receive an owned chunk,
    // unless the caller takes fflate's own (borrowChunks).
    const owned = options.borrowChunks ? chunk : chunk.slice();
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

/** One entry of an archive's central directory. */
interface ZipDirectoryEntry {
  readonly path: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

const u16 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const sliceBytes = async (file: File, start: number, end: number): Promise<Uint8Array> =>
  new Uint8Array(await file.slice(start, end).arrayBuffer());

/**
 * The archive's central directory, or null where it cannot be relied on: no end record, a ZIP64
 * archive, or a directory that does not sit where the end record says (an archive past 4 GB from
 * a writer without ZIP64, whose 32-bit offsets have wrapped).
 */
async function readZipDirectory(file: File): Promise<{ entries: ZipDirectoryEntry[]; offset: number } | null> {
  const END_RECORD = 22;
  if (file.size < END_RECORD) return null;
  const tailStart = Math.max(0, file.size - END_RECORD - 0xffff);
  const tail = await sliceBytes(file, tailStart, file.size);
  let end = -1;
  for (let at = tail.length - END_RECORD; at >= 0; at--) {
    if (u32(tail, at) === 0x06054b50 && at + END_RECORD + u16(tail, at + 20) === tail.length) { end = at; break; }
  }
  if (end < 0) return null;
  const count = u16(tail, end + 10);
  const size = u32(tail, end + 12);
  const offset = u32(tail, end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
  if (u16(tail, end + 4) !== 0 || u16(tail, end + 6) !== 0 || u16(tail, end + 8) !== count) return null;
  if (offset + size !== tailStart + end) return null;
  const directory = await sliceBytes(file, offset, offset + size);
  const entries: ZipDirectoryEntry[] = [];
  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder("utf-8");
  let at = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > directory.length || u32(directory, at) !== 0x02014b50) return null;
    const flags = u16(directory, at + 8);
    const nameLength = u16(directory, at + 28);
    const next = at + 46 + nameLength + u16(directory, at + 30) + u16(directory, at + 32);
    if (next > directory.length) return null;
    const compressedSize = u32(directory, at + 20);
    const entrySize = u32(directory, at + 24);
    const localOffset = u32(directory, at + 42);
    if (compressedSize === 0xffffffff || entrySize === 0xffffffff || localOffset === 0xffffffff) return null;
    const name = directory.subarray(at + 46, at + 46 + nameLength);
    entries.push({
      path: (flags & 0x800 ? utf8 : latin1).decode(name),
      method: u16(directory, at + 10),
      compressedSize,
      size: entrySize,
      localOffset,
    });
    at = next;
  }
  if (at !== directory.length) return null;
  entries.sort((a, b) => a.localOffset - b.localOffset);
  return { entries, offset };
}

/**
 * Read selected entries from a File without retaining the complete compressed archive.
 *
 * An entry's extent is taken from the archive's central directory. The streamed reading below
 * finds the end of an entry written with a data descriptor (every entry writeStoredZip writes)
 * by looking for a ZIP signature in the entry's own bytes, so an FCS file holding the four bytes
 * 50 4B 07 08 was cut short there, and a bundle GateLab had written was refused as not matching
 * its declared byte length. The streamed reading remains for an archive whose directory cannot be
 * relied on.
 */
export async function readZipFileEntries(
  file: File,
  options: StreamZipReadOptions,
): Promise<Readonly<Record<string, Uint8Array>>> {
  const directory = await readZipDirectory(file);
  if (!directory) return readZipFileEntriesStreamed(file, options);

  const unknownEntryLimitFor = (path: string): number => positiveSafeInteger(
    typeof options.unknownEntryLimit === "function"
      ? options.unknownEntryLimit(path)
      : options.unknownEntryLimit ?? DEFAULT_UNKNOWN_ENTRY_LIMIT,
    "Unknown ZIP entry limit",
  );
  const totalOutputLimit = positiveSafeInteger(
    options.totalOutputLimit ?? Number.MAX_SAFE_INTEGER,
    "ZIP total output limit",
  );
  const entries: Record<string, Uint8Array> = {};
  const seenPaths = new Set<string>();
  let totalReceived = 0;
  // In archive order, each entry complete before the next is read: an earlier entry's onEntry
  // may supply a later one's expected size.
  for (const entry of directory.entries) {
    if (!options.select(entry.path)) continue;
    if (!safeArchivePath(entry.path) || seenPaths.has(entry.path)) {
      throw new Error(`Unsafe or duplicate ZIP entry '${entry.path}'.`);
    }
    seenPaths.add(entry.path);
    const expected = options.expectedSize?.(entry.path);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      throw new Error(`Invalid expected byte length for ZIP entry '${entry.path}'.`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`ZIP entry '${entry.path}' uses a compression method GateLab does not read.`);
    }
    if (expected !== undefined && entry.size > expected) {
      throw new Error(`ZIP entry '${entry.path}' exceeds its declared byte length.`);
    }
    if (expected !== undefined && entry.size !== expected) {
      throw new Error(`ZIP entry '${entry.path}' does not match its declared byte length.`);
    }
    if (expected === undefined && entry.size > unknownEntryLimitFor(entry.path)) {
      throw new Error(`ZIP metadata entry '${entry.path}' exceeds the safety limit.`);
    }
    totalReceived += entry.size;
    if (!Number.isSafeInteger(totalReceived) || totalReceived > totalOutputLimit) {
      throw new Error("Selected ZIP contents exceed the aggregate decompressed-byte safety limit.");
    }
    const local = await sliceBytes(file, entry.localOffset, entry.localOffset + 30);
    if (local.length < 30 || u32(local, 0) !== 0x04034b50) {
      throw new Error(`ZIP entry '${entry.path}' has no local header where the archive's directory places it.`);
    }
    const dataStart = entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
    if (dataStart + entry.compressedSize > directory.offset) {
      throw new Error(`ZIP entry '${entry.path}' runs past the archive's directory.`);
    }
    const stored = await sliceBytes(file, dataStart, dataStart + entry.compressedSize);
    if (stored.length !== entry.compressedSize) {
      throw new Error(`ZIP entry '${entry.path}' is cut short.`);
    }
    const bytes = entry.method === 0 ? stored : inflateSync(stored, { out: new Uint8Array(entry.size) });
    if (bytes.length !== entry.size) {
      throw new Error(`ZIP entry '${entry.path}' does not match its declared byte length.`);
    }
    entries[entry.path] = bytes;
    options.onEntry?.(entry.path, bytes);
  }
  return Object.freeze(entries);
}

/** Stream selected entries, each ended where the stream shows its end. */
async function readZipFileEntriesStreamed(
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
