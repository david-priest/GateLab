// recentWorkspaces.ts — the workspaces opened or saved lately, as file handles the browser keeps
// in IndexedDB (the store the FCS handles already live in), so the Workspace menu can offer
// "Open recent". A handle survives the page and the browser being closed; reopening one asks the
// browser's permission once more, which the File System Access API grants only inside a click.
// Nothing of the workspace itself is kept: the file's name, where the handle points, and when.

import { recallHandle, rememberHandle } from "./fsAccess";

export interface RecentWorkspace {
  name: string;
  /** When it was last opened or saved, ms since the epoch. */
  at: number;
  handle: FileSystemFileHandle;
}

const KEY = "recent-workspaces";
export const RECENT_WORKSPACES_MAX = 8;

interface StoredRecent {
  name: string;
  at: number;
  handle: FileSystemFileHandle;
}

async function readAll(): Promise<StoredRecent[]> {
  // The list is kept under one key, as one record; the store's API is for a handle a key.
  const stored = (await recallHandle(KEY)) as unknown as StoredRecent[] | null;
  return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.name === "string" && entry.handle) : [];
}

async function writeAll(entries: StoredRecent[]): Promise<void> {
  await rememberHandle(KEY, entries as unknown as FileSystemFileHandle);
}

/** Note a workspace as the most recent; one entry per file (the same handle, or the same name). */
export async function rememberRecentWorkspace(handle: FileSystemFileHandle, name: string, now = Date.now()): Promise<void> {
  const entries = await readAll();
  const kept: StoredRecent[] = [];
  for (const entry of entries) {
    let same = entry.name === name;
    if (!same) {
      try { same = await entry.handle.isSameEntry(handle); } catch { same = false; }
    }
    if (!same) kept.push(entry);
  }
  await writeAll([{ name, at: now, handle }, ...kept].slice(0, RECENT_WORKSPACES_MAX));
}

/** The recent workspaces, most recent first. */
export async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return (await readAll()).sort((a, b) => b.at - a.at);
}

/** Drop one, by name: a file that could not be reopened. */
export async function forgetRecentWorkspace(name: string): Promise<void> {
  await writeAll((await readAll()).filter((entry) => entry.name !== name));
}
