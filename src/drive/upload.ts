// upload.ts — putting an FCS file into an experiment folder of the lab Drive by resumable upload,
// in 8 MiB chunks. The chunks carry no token (probe P6), so an upload outlives the hour a token lasts.
//
// An error from Drive does not mean the upload failed. In P6 Drive answered a chunk with 500 "The
// operation was successful, but there was an error preparing the response" and had stored the
// file; a second upload would have made a duplicate, which Drive allows. So on a 5xx, or no answer
// at all, the session is asked what it holds (Content-Range: bytes */<size>) before anything else,
// and the upload goes on from there. Only when the session is gone is a new one started, and
// before that the folder is listed and any file of the same name and size is compared by MD5: a
// file Drive already holds is taken, not sent again. Every upload's MD5 is compared with the one
// Drive reports for the stored file, so a file that arrived altered is refused.

import {
  DriveError,
  DriveNetworkError,
  type DriveApi,
  type DriveFile,
  type DriveUploadState,
} from "./api";
import { md5HexAsync } from "./md5";

/** A multiple of 256 KiB, as resumable uploads require of every chunk but the last. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** The appProperties key of the upload that made a file, so a stored file can be told as this save's. */
export const UPLOAD_KEY = "gatelabUpload";
export const FCS_MIME = "application/octet-stream";

/** Sessions tried for one file before the upload is given up. */
const MAX_SESSIONS = 3;
/** Status queries tried after an error before a session is given up as unreachable. */
const MAX_QUERIES = 5;
/** Errors, or answers that moved nothing forward, in one session before it is given up. */
const MAX_SESSION_FAILURES = 8;

export interface UploadTarget {
  readonly folderId: string;
  readonly driveId: string | null;
}

export interface UploadItem {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface UploadResult {
  readonly file: DriveFile;
  /** The folder held this file before the save began, so it was not sent. */
  readonly already: boolean;
}

export interface UploadOptions {
  readonly signal?: AbortSignal;
  /** Bytes of this file Drive has confirmed it holds, as they grow. */
  readonly onProgress?: (sent: number) => void;
  /** What is being done when it is not sending: checking the folder, or reading the file's checksum. */
  readonly onPhase?: (phase: "checking" | "uploading" | "verifying") => void;
  /** Waits between status queries; tests pass one that does not wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** An error after which Drive may or may not have acted: a 5xx, a timeout or throttling, or no answer. */
export function outcomeUnknown(cause: unknown): boolean {
  if (cause instanceof DriveNetworkError) return true;
  if (!(cause instanceof DriveError) || cause.status === null) return false;
  return cause.status >= 500 || cause.status === 408 || cause.status === 429;
}

/** The session no longer exists: it ran out, or Drive dropped it. */
function sessionGone(cause: unknown): boolean {
  return cause instanceof DriveError && (cause.status === 404 || cause.status === 410);
}

/** Wait before the n-th status query (0-based): 1, 2, 4, 8, 16 s. */
const backoff = (n: number) => 1000 * 2 ** n;

/** Upload one file into the folder, or take the copy of it the folder already holds. */
export async function uploadFile(
  api: DriveApi,
  target: UploadTarget,
  item: UploadItem,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { signal, onProgress, onPhase, sleep = pause } = options;
  const size = item.bytes.length;
  let checksum: Promise<string> | null = null;
  const md5 = () => {
    if (!checksum) {
      onPhase?.("verifying");
      checksum = md5HexAsync(item.bytes, signal ? { signal } : {});
      // A cancelled read is read again when it is next needed.
      checksum.catch(() => { checksum = null; });
    }
    return checksum;
  };

  /** A file of this name, size and content already in the folder. */
  const stored = async (): Promise<DriveFile | null> => {
    onPhase?.("checking");
    const listed = await api.listChildren(target.folderId, target.driveId);
    const same = listed.filter((file) =>
      file.name === item.name && file.size === size && !file.trashed && file.parents.includes(target.folderId));
    if (same.length === 0) return null;
    const sum = await md5();
    return same.find((file) => file.md5Checksum === sum) ?? null;
  };

  /** Ask the session what it holds, waiting longer each time it does not answer; null when it is gone. */
  const query = async (session: string): Promise<DriveUploadState | null> => {
    for (let tries = 0; tries < MAX_QUERIES; tries++) {
      await sleep(backoff(tries), signal);
      try {
        return await api.queryUpload(session, size, signal);
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (sessionGone(cause)) return null;
        if (!outcomeUnknown(cause)) throw cause;
      }
    }
    // It cannot be asked: given up. It never completes, since nothing more is sent to it, and a
    // file it did complete is found in the folder before a new session starts.
    return null;
  };

  /** Send the file through one session; the stored file, or null when the session is gone. */
  const send = async (session: string): Promise<DriveFile | null> => {
    let offset = 0;
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, size);
      let state: DriveUploadState | null;
      let answered = true;
      try {
        state = await api.putUploadChunk(session, item.bytes.subarray(offset, end), offset, size, signal);
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (sessionGone(cause)) return null;
        if (!outcomeUnknown(cause)) throw cause;
        // Whether Drive kept the chunk, or the whole file, is not known: ask before sending anything.
        failures++;
        answered = false;
        state = await query(session);
        if (state === null) return null;
      }
      if (state.kind === "complete") return state.file;
      // Drive says how much it holds. A chunk it accepted without saying is taken as received,
      // except the last: a session still incomplete after it is asked.
      let received = state.received;
      if (received === null && answered && end < size) received = end;
      if (received === null) {
        failures++;
        const asked = await query(session);
        if (asked === null) return null;
        if (asked.kind === "complete") return asked.file;
        received = asked.received ?? 0;
      }
      if (received > size) throw new DriveError(`Drive says it holds more of ${item.name} than the file has.`);
      if (received <= offset && answered) failures++;
      if (failures > MAX_SESSION_FAILURES) return null;
      offset = received;
      onProgress?.(offset);
      onPhase?.("uploading");
    }
  };

  for (let attempt = 1; attempt <= MAX_SESSIONS; attempt++) {
    const found = await stored();
    if (found) {
      onProgress?.(size);
      return { file: found, already: attempt === 1 };
    }
    onPhase?.("uploading");
    onProgress?.(0);
    const session = await api.startUpload({
      name: item.name,
      parentId: target.folderId,
      mimeType: FCS_MIME,
      appProperties: { [UPLOAD_KEY]: crypto.randomUUID() },
    }, size);
    const file = await send(session);
    if (!file) continue;
    const sum = await md5();
    const reported = file.md5Checksum ?? (await api.getMetadata(file.id)).md5Checksum;
    if (reported !== sum || file.size !== size) {
      throw new DriveError(
        `${item.name} arrived in the lab Drive altered (${file.size ?? "?"} bytes, MD5 ${reported ?? "not given"}; ` +
          `the file here is ${size} bytes, MD5 ${sum}). Nothing more was saved. Remove that copy from the experiment folder, then save again.`,
      );
    }
    onProgress?.(size);
    return { file, already: false };
  }
  throw new DriveError(
    `${item.name} could not be uploaded: Drive dropped the upload ${MAX_SESSIONS} times. Nothing more was saved; save again to go on from where it stopped.`,
  );
}
