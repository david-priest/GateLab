// fsAccess.ts — File System Access API (Chromium) wrappers giving GateLab a document model:
// open a file keeping its handle, then Save writes back IN PLACE (no re-download). Falls back
// gracefully on Firefox/Safari (callers use the download/upload path there). Also a tiny
// IndexedDB store for persisting FCS file handles so a reference workspace re-links its data.

export const supportsFileSystemAccess = (): boolean =>
  typeof window !== "undefined" && typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
    id?: string;
    startIn?: FileSystemHandle;
  }) => Promise<FileSystemDirectoryHandle>;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

const directoryPickerWindow = (): DirectoryPickerWindow => window as DirectoryPickerWindow;

export const supportsDirectoryAccess = (): boolean =>
  typeof window !== "undefined" && typeof directoryPickerWindow().showDirectoryPicker === "function";

export interface PickedFile {
  handle: FileSystemFileHandle;
  bytes: Uint8Array;
  name: string;
}

/** A user-approved file that has not yet been read into GateLab's data model. */
export interface PickedFileSource {
  handle: FileSystemFileHandle;
  file: File;
  name: string;
  /** Path below a selected source folder; just the filename for a normal file picker. */
  relativePath: string;
}

export interface PickedDirectory {
  handle: FileSystemDirectoryHandle;
  name: string;
  files: PickedFileSource[];
}

export interface PickFileOptions {
  /**
   * Accepted for compatibility and ignored: every GateLab picker shares one id, so the
   * browser remembers a single last-used folder for the whole app (see PICKER_ID).
   */
  id?: string;
  /** A handle to open beside, overriding the remembered last location for this one picker. */
  startIn?: FileSystemHandle;
}

/**
 * The one picker id for the whole app. Chromium remembers the last-used directory per id and
 * origin, so with a shared id every open and save dialog starts where the previous one ended,
 * across buttons and across page loads. Separate ids per workflow (the earlier arrangement)
 * made each button remember its own folder, which is not what anyone wants when the FCS
 * files, the workspace and the barcode sheet all sit in one experiment folder.
 */
export const PICKER_ID = "gatelab";

let lastLocation: FileSystemHandle | null = null;

/** Remember where the user last opened or saved, so the next picker starts there. */
export function rememberPickerLocation(handle: FileSystemHandle | null | undefined): void {
  if (handle) lastLocation = handle;
}

export function lastPickerLocation(): FileSystemHandle | null {
  return lastLocation;
}

/** For tests. */
export function resetPickerLocation(): void {
  lastLocation = null;
}

/** The id and start location every picker passes: a caller's startIn, else the last location. */
function pickerPlacement(options: PickFileOptions = {}): { id: string; startIn?: FileSystemHandle } {
  const startIn = options.startIn ?? lastLocation ?? undefined;
  return { id: PICKER_ID, ...(startIn ? { startIn } : {}) };
}

async function readHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; name: string }> {
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
}

/** Ensure read or read/write permission on a persisted handle (may prompt the user). */
export async function ensurePermission(handle: FileSystemFileHandle, mode: "read" | "readwrite"): Promise<boolean> {
  try {
    if ((await handle.queryPermission?.({ mode })) === "granted") return true;
    return (await handle.requestPermission?.({ mode })) === "granted";
  } catch {
    return false;
  }
}

/** Open-file picker → handle + bytes. Returns null if the user cancels. */
export async function pickFile(
  accept: Record<string, string[]> | null,
  description: string,
  options: PickFileOptions = {},
): Promise<PickedFile | null> {
  try {
    const [handle] = await window.showOpenFilePicker!({
      ...(accept ? { types: [{ description, accept }] } : {}),
      multiple: false,
      ...pickerPlacement(options),
    });
    rememberPickerLocation(handle);
    const { bytes, name } = await readHandle(handle);
    return { handle, bytes, name };
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

/** Open one file without eagerly duplicating it into a whole-file Uint8Array. */
export async function pickFileSource(
  accept: Record<string, string[]> | null,
  description: string,
  options: PickFileOptions = {},
): Promise<PickedFileSource | null> {
  try {
    const [handle] = await window.showOpenFilePicker!({
      ...(accept ? { types: [{ description, accept }] } : {}),
      multiple: false,
      ...pickerPlacement(options),
    });
    rememberPickerLocation(handle);
    const file = await handle.getFile();
    return { handle, file, name: file.name, relativePath: file.name };
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

/** Open-file picker for a batch. Reading/parsing is deliberately left to the caller. */
export async function pickFiles(
  accept: Record<string, string[]>,
  description: string,
  options: PickFileOptions = {},
): Promise<PickedFileSource[] | null> {
  try {
    const handles = await window.showOpenFilePicker!({
      types: [{ description, accept }],
      multiple: true,
      ...pickerPlacement(options),
    });
    rememberPickerLocation(handles[0]);
    return await Promise.all(handles.map(async (handle) => {
      const file = await handle.getFile();
      return { handle, file, name: file.name, relativePath: file.name };
    }));
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

/**
 * Pick and enumerate a folder without reading file contents. GateLab imports a confirmed
 * snapshot of the returned files; it does not silently mirror later folder changes.
 */
export async function pickDirectoryFiles(
  extensions: readonly string[],
  options: PickFileOptions = {},
): Promise<PickedDirectory | null> {
  try {
    const handle = await directoryPickerWindow().showDirectoryPicker!({
      mode: "read",
      ...pickerPlacement(options),
    });
    rememberPickerLocation(handle);
    const allowed = new Set(extensions.map((extension) => extension.toLowerCase()));
    const files: PickedFileSource[] = [];

    const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const entry of (directory as IterableDirectoryHandle).values()) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          await walk(entry as FileSystemDirectoryHandle, relativePath);
          continue;
        }
        const dot = entry.name.lastIndexOf(".");
        const extension = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
        if (!allowed.has(extension)) continue;
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        files.push({ handle: fileHandle, file, name: file.name, relativePath });
      }
    };

    await walk(handle, "");
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
    return { handle, name: handle.name, files };
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
}

/** Write to an existing handle (in-place Save). */
export async function writeHandle(handle: FileSystemFileHandle, data: BlobPart): Promise<void> {
  if (!(await ensurePermission(handle, "readwrite"))) throw new Error("Write permission was denied.");
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
  rememberPickerLocation(handle);
}

export type FileChunkProducer = (
  write: (chunk: Uint8Array) => Promise<void>,
) => Promise<void>;

async function streamToHandle(
  handle: FileSystemFileHandle,
  produce: FileChunkProducer,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await produce(async (chunk) => {
      await writable.write(chunk as FileSystemWriteChunkType);
    });
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

/** Stream to an existing handle without constructing a complete in-memory Blob. */
export async function writeHandleStream(
  handle: FileSystemFileHandle,
  produce: FileChunkProducer,
): Promise<void> {
  if (!(await ensurePermission(handle, "readwrite"))) throw new Error("Write permission was denied.");
  await streamToHandle(handle, produce);
}

/** Save-file picker → write + return the new handle. Null if cancelled. */
export async function saveAsHandle(
  suggestedName: string,
  accept: Record<string, string[]>,
  description: string,
  data: BlobPart,
): Promise<FileSystemFileHandle | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker!({ suggestedName, types: [{ description, accept }], ...pickerPlacement() });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
  rememberPickerLocation(handle);
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
  return handle;
}

/** Save-file picker with a chunk producer for large portable workspaces. */
export async function saveAsHandleStream(
  suggestedName: string,
  accept: Record<string, string[]>,
  description: string,
  produce: FileChunkProducer,
): Promise<FileSystemFileHandle | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker!({ suggestedName, types: [{ description, accept }], ...pickerPlacement() });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
  rememberPickerLocation(handle);
  await streamToHandle(handle, produce);
  return handle;
}

/** Re-read a persisted handle (requests permission if needed). Null if unavailable. */
export async function readFromHandle(handle: FileSystemFileHandle): Promise<{ bytes: Uint8Array; name: string } | null> {
  try {
    if (!(await ensurePermission(handle, "read"))) return null;
    return await readHandle(handle);
  } catch {
    return null;
  }
}

/**
 * Re-read a persisted handle only when the browser has already granted access.
 * Workspace preflight uses this silent path so reopening a many-file workspace never
 * produces one permission prompt per remembered FCS.
 */
export async function readFromHandleIfPermitted(
  handle: FileSystemFileHandle,
): Promise<{ bytes: Uint8Array; name: string } | null> {
  try {
    if ((await handle.queryPermission?.({ mode: "read" })) !== "granted") return null;
    return await readHandle(handle);
  } catch {
    return null;
  }
}

// ── IndexedDB handle store (FCS handles persist across sessions for reference workspaces) ──
const DB_NAME = "gatelab";
const STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best-effort */
  }
}

export async function recallHandle(key: string): Promise<FileSystemFileHandle | null> {
  try {
    const db = await openDb();
    const handle = await new Promise<FileSystemFileHandle | null>((resolve) => {
      const rq = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      rq.onsuccess = () => resolve((rq.result as FileSystemFileHandle) ?? null);
      rq.onerror = () => resolve(null);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

/**
 * Open through the File System Access picker when the browser has it, so the dialog starts in
 * the last-used folder like every other GateLab picker; otherwise click the hidden
 * `<input type="file">` and let its change handler take over. Resolves to the picked files,
 * or null when the input took over or the user cancelled.
 */
export async function pickFilesOrInput(
  input: HTMLInputElement | null,
  accept: Record<string, string[]>,
  description: string,
  multiple = false,
): Promise<File[] | null> {
  if (!supportsFileSystemAccess()) {
    input?.click();
    return null;
  }
  const picked = multiple
    ? await pickFiles(accept, description)
    : await pickFileSource(accept, description).then((one) => (one ? [one] : null));
  return picked ? picked.map((p) => p.file) : null;
}
