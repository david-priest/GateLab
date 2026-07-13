// fsAccess.ts — File System Access API (Chromium) wrappers giving GateLab a document model:
// open a file keeping its handle, then Save writes back IN PLACE (no re-download). Falls back
// gracefully on Firefox/Safari (callers use the download/upload path there). Also a tiny
// IndexedDB store for persisting FCS file handles so a reference workspace re-links its data.

export const supportsFileSystemAccess = (): boolean =>
  typeof window !== "undefined" && typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function";

export interface PickedFile {
  handle: FileSystemFileHandle;
  bytes: Uint8Array;
  name: string;
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
export async function pickFile(accept: Record<string, string[]>, description: string): Promise<PickedFile | null> {
  try {
    const [handle] = await window.showOpenFilePicker!({ types: [{ description, accept }], multiple: false });
    const { bytes, name } = await readHandle(handle);
    return { handle, bytes, name };
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
    handle = await window.showSaveFilePicker!({ suggestedName, types: [{ description, accept }] });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
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
