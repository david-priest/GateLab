// saveFallback.ts — Save through a file handle, and download the same bytes when the browser
// hands GateLab a handle and then refuses to write it.
//
// An embedded browser (the Claude desktop app's browser pane, 2026-10-22) returned a handle from
// the save dialog and made the file, then refused createWritable: "The request is not allowed by
// the user agent or the platform in the current context." The save left a 0-byte workspace on
// the Desktop and said so only on the error line. Here a write that fails becomes a download of
// the same bytes under the name chosen, with a message that says so, and the caller learns that
// the save went to a download, so it neither marks the workspace saved nor keeps the handle.
//
// The engine's write helpers (src/engine/fsAccess.ts) are used unchanged for a file already
// open; a new file is picked and written here, as saveAsHandle does, because saveAsHandle loses
// the handle when the write throws.

import {
  PICKER_ID,
  lastPickerLocation,
  noteHandlesRefused,
  rememberPickerLocation,
  writeHandle,
  writeHandleStream,
  type FileChunkProducer,
} from "./engine/fsAccess";

/** The bytes to save: whole, or made in chunks by a producer that can be run again. */
export type SaveBytes = { data: BlobPart } | { produce: FileChunkProducer };

export interface SaveFileTarget {
  suggestedName: string;
  accept: Record<string, string[]>;
  description: string;
  /** The type the download is given when the write is refused. */
  mime: string;
}

export type SaveOutcome =
  | { kind: "written"; handle: FileSystemFileHandle }
  | { kind: "downloaded"; name: string; message: string }
  | { kind: "cancelled" };

export type DownloadBlob = (name: string, blob: Blob) => void;

/**
 * Set once the browser has refused a write as not allowed in this context. That is a property of
 * the browser, not of one file, so for the rest of the page's life a new save is downloaded
 * without opening a save dialog that would only make another empty file. Other failures (a disk
 * full, a file locked by another program) fall back for that save alone.
 */
let writesRefused = false;

export function handleWritesRefused(): boolean {
  return writesRefused;
}

/** For tests. */
export function resetHandleWritesRefused(): void {
  writesRefused = false;
}

function noteRefusal(cause: unknown): void {
  if ((cause as DOMException | null)?.name !== "NotAllowedError") return;
  writesRefused = true;
  noteHandlesRefused();
}

async function collect(bytes: SaveBytes, mime: string): Promise<Blob> {
  if ("data" in bytes) return new Blob([bytes.data], { type: mime });
  const parts: BlobPart[] = [];
  await bytes.produce(async (chunk) => {
    parts.push(chunk as BlobPart);
  });
  return new Blob(parts, { type: mime });
}

/** Write a handle the save dialog just returned, as saveAsHandle and its streaming twin do. */
async function writeNew(handle: FileSystemFileHandle, bytes: SaveBytes): Promise<void> {
  const writable = await handle.createWritable();
  try {
    if ("data" in bytes) await writable.write(bytes.data as FileSystemWriteChunkType);
    else await bytes.produce(async (chunk) => { await writable.write(chunk as FileSystemWriteChunkType); });
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

/**
 * What became of the file the save dialog made. Taken away only when it is empty: a dialog may
 * have been pointed at a file already there, and a browser that left it as it was must not lose it.
 */
async function removeIfEmpty(handle: FileSystemFileHandle): Promise<"removed" | "empty" | "unknown" | "kept"> {
  try {
    if ((await handle.getFile()).size !== 0) return "kept";
  } catch {
    return "unknown";
  }
  const remove = (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove;
  if (typeof remove !== "function") return "empty";
  try {
    await remove.call(handle);
    return "removed";
  } catch {
    return "empty";
  }
}

const REFUSED = "This browser would not let GateLab write to";

/**
 * Save to a new file the user picks. Cancelled when the dialog is dismissed; downloaded, with the
 * message to show, when the write fails or this browser has already refused one.
 */
export async function saveToNewFile(
  target: SaveFileTarget,
  bytes: SaveBytes,
  download: DownloadBlob,
): Promise<SaveOutcome> {
  if (writesRefused) {
    download(target.suggestedName, await collect(bytes, target.mime));
    return {
      kind: "downloaded",
      name: target.suggestedName,
      message: `${REFUSED} a file earlier in this session, so this was downloaded instead: ${target.suggestedName}.`,
    };
  }
  let handle: FileSystemFileHandle;
  try {
    const startIn = lastPickerLocation();
    handle = await window.showSaveFilePicker!({
      suggestedName: target.suggestedName,
      types: [{ description: target.description, accept: target.accept }],
      id: PICKER_ID,
      ...(startIn ? { startIn } : {}),
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return { kind: "cancelled" };
    throw e;
  }
  rememberPickerLocation(handle);
  try {
    await writeNew(handle, bytes);
    return { kind: "written", handle };
  } catch (cause) {
    noteRefusal(cause);
    const name = handle.name;
    download(name, await collect(bytes, target.mime));
    const left = await removeIfEmpty(handle);
    const there =
      left === "removed" ? " The empty file the save dialog made there was removed."
      : left === "kept" ? ` The file ${name} where you chose was not changed.`
      : left === "empty" ? ` The file ${name} where you chose is empty; the download holds what was saved.`
      : ` The file ${name} where you chose may be empty; the download holds what was saved.`;
    return { kind: "downloaded", name, message: `${REFUSED} the file you chose, so it was downloaded instead: ${name}.${there}` };
  }
}

/**
 * Save in place to a file already open. When the write fails the same bytes are downloaded under
 * its name; the browser writes to a temporary file and moves it into place only when the write
 * closes, so the file itself still holds what it held.
 */
export async function saveToOpenFile(
  handle: FileSystemFileHandle,
  bytes: SaveBytes,
  mime: string,
  download: DownloadBlob,
): Promise<SaveOutcome> {
  try {
    if ("data" in bytes) await writeHandle(handle, bytes.data);
    else await writeHandleStream(handle, bytes.produce);
    return { kind: "written", handle };
  } catch (cause) {
    noteRefusal(cause);
    const name = handle.name;
    download(name, await collect(bytes, mime));
    return {
      kind: "downloaded",
      name,
      message: `${REFUSED} ${name}, so it was downloaded instead: ${name}. The file you opened was not changed.`,
    };
  }
}
