// Browser-local workspace checkpoints. These deliberately persist only WorkspaceFile JSON:
// FCS event bytes remain in the user's source files and are never copied into IndexedDB.

import { validateWorkspace, type WorkspaceFile } from "./workspace";
import { WORKSPACE_VERSION_3, type WorkspaceFileV3 } from "./workspaceV3";

export type CheckpointWorkspace = WorkspaceFile | WorkspaceFileV3;

export const AUTO_CHECKPOINT_INTERVAL_MS = 2 * 60 * 1000;
export const MAX_CHECKPOINTS_PER_WORKSPACE = 256;

const RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;
const HOURLY_WINDOW_MS = 48 * 60 * 60 * 1000;
const DAILY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DB_NAME = "gatelab-workspace-history";
const DB_VERSION = 1;
const STORE_NAME = "checkpoints";
const WORKSPACE_CREATED_INDEX = "workspace-created";

export type WorkspaceCheckpointReason =
  | "automatic"
  | "before-workspace-open"
  | "before-new-workspace"
  | "after-workspace-open"
  | "before-gatingml-replace"
  | "after-gatingml-import"
  | "before-gate-delete"
  | "before-population-delete"
  | "before-sample-remove"
  | "after-fcs-import"
  | "after-metadata-import"
  | "before-compensation-apply"
  | "after-compensation-apply"
  | "before-active-layer-change"
  | "compensation-profile-import";

export interface WorkspaceCheckpoint {
  id: string;
  workspaceId: string;
  createdAt: string;
  reason: WorkspaceCheckpointReason;
  workspace: CheckpointWorkspace;
  summary: {
    samples: number;
    gates: number;
    populations: number;
    bytes: number;
  };
}

export type WorkspaceCheckpointSaveResult = "saved" | "duplicate" | "unavailable";

function cloneWorkspace(workspace: CheckpointWorkspace): CheckpointWorkspace {
  // Workspace files are intentionally JSON-only. This both snapshots mutable input before the
  // asynchronous IndexedDB write and makes an accidental non-JSON/FCS payload impossible.
  return JSON.parse(JSON.stringify(workspace)) as CheckpointWorkspace;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Stable comparison for checkpoint de-duplication; save timestamps are not workspace edits. */
export function workspaceCheckpointSignature(workspace: CheckpointWorkspace): string {
  const normalized = cloneWorkspace(workspace);
  normalized.savedAt = "";
  return JSON.stringify(normalized);
}

/** Construct and synchronously snapshot a checkpoint before any destructive action proceeds. */
export function createWorkspaceCheckpoint(
  workspaceId: string,
  workspace: CheckpointWorkspace,
  reason: WorkspaceCheckpointReason,
  now = new Date(),
  id = randomId(),
): WorkspaceCheckpoint {
  if (!workspaceId.trim()) throw new Error("A workspace ID is required for local history.");
  const snapshot = cloneWorkspace(workspace);
  snapshot.workspaceId = workspaceId;
  if (snapshot.version === 2) {
    validateWorkspace(snapshot);
  } else if (
    snapshot.version !== WORKSPACE_VERSION_3 ||
    !Array.isArray(snapshot.samples) ||
    snapshot.samples.length === 0 ||
    snapshot.compensation == null
  ) {
    throw new Error("A valid GateLab workspace v2/v3 is required for local history.");
  }
  const json = JSON.stringify(snapshot);
  return {
    id,
    workspaceId,
    createdAt: now.toISOString(),
    reason,
    workspace: snapshot,
    summary: {
      samples: snapshot.samples.length,
      gates: Object.keys(snapshot.gating.gates).length,
      populations: Object.keys(snapshot.gating.populations).length,
      bytes: new TextEncoder().encode(json).byteLength,
    },
  };
}

/**
 * Tiered retention keeps fine-grained recent recovery without allowing IndexedDB to grow forever:
 * every checkpoint for 2 hours, one per hour through 48 hours, then one per day through 14 days.
 * The newest checkpoint is always retained, even when a workspace has been dormant for longer.
 */
export function retainedWorkspaceCheckpointIds(
  checkpoints: readonly WorkspaceCheckpoint[],
  nowMs = Date.now(),
  maxCheckpoints = MAX_CHECKPOINTS_PER_WORKSPACE,
): Set<string> {
  if (maxCheckpoints <= 0) return new Set();
  const sorted = [...checkpoints]
    .filter((checkpoint) => Number.isFinite(Date.parse(checkpoint.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (sorted.length === 0) return new Set();

  const retained: WorkspaceCheckpoint[] = [];
  const hourlyBuckets = new Set<number>();
  const dailyBuckets = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const checkpoint = sorted[i];
    const timestamp = Date.parse(checkpoint.createdAt);
    const age = Math.max(0, nowMs - timestamp);
    let keep = i === 0;

    if (age <= RECENT_WINDOW_MS) {
      keep = true;
    } else if (age <= HOURLY_WINDOW_MS) {
      const bucket = Math.floor(timestamp / HOUR_MS);
      if (!hourlyBuckets.has(bucket)) {
        hourlyBuckets.add(bucket);
        keep = true;
      }
    } else if (age <= DAILY_WINDOW_MS) {
      const bucket = Math.floor(timestamp / DAY_MS);
      if (!dailyBuckets.has(bucket)) {
        dailyBuckets.add(bucket);
        keep = true;
      }
    }

    if (keep) retained.push(checkpoint);
  }
  return new Set(retained.slice(0, maxCheckpoints).map((checkpoint) => checkpoint.id));
}

function openHistoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(WORKSPACE_CREATED_INDEX)) {
        store.createIndex(WORKSPACE_CREATED_INDEX, ["workspaceId", "createdAt"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open workspace history."));
  });
}

function workspaceRange(workspaceId: string): IDBKeyRange {
  return IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"]);
}

function readCheckpoints(db: IDBDatabase, workspaceId: string): Promise<WorkspaceCheckpoint[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction
      .objectStore(STORE_NAME)
      .index(WORKSPACE_CREATED_INDEX)
      .getAll(workspaceRange(workspaceId));
    request.onsuccess = () => {
      resolve((request.result as WorkspaceCheckpoint[]).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ));
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read workspace history."));
  });
}

function putCheckpoint(db: IDBDatabase, checkpoint: WorkspaceCheckpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(checkpoint);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save workspace checkpoint."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace checkpoint save was aborted."));
  });
}

function deleteCheckpoints(db: IDBDatabase, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const id of ids) store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not prune workspace history."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Workspace history pruning was aborted."));
  });
}

async function persistWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<WorkspaceCheckpointSaveResult> {
  let db: IDBDatabase | null = null;
  try {
    db = await openHistoryDb();
    const existing = await readCheckpoints(db, checkpoint.workspaceId);
    const latest = existing[0];
    if (
      checkpoint.reason === "automatic" &&
      latest &&
      workspaceCheckpointSignature(latest.workspace) === workspaceCheckpointSignature(checkpoint.workspace)
    ) {
      return "duplicate";
    }

    await putCheckpoint(db, checkpoint);
    const current = await readCheckpoints(db, checkpoint.workspaceId);
    const retained = retainedWorkspaceCheckpointIds(current, Date.parse(checkpoint.createdAt));
    await deleteCheckpoints(db, current.filter((entry) => !retained.has(entry.id)).map((entry) => entry.id));
    return "saved";
  } catch {
    // History must never block gating when storage is unavailable, private mode is restrictive,
    // or the browser has exhausted its local quota.
    return "unavailable";
  } finally {
    db?.close();
  }
}

/** Save a lightweight checkpoint. The workspace is cloned synchronously before this returns. */
export function saveWorkspaceCheckpoint(
  workspaceId: string,
  workspace: CheckpointWorkspace,
  reason: WorkspaceCheckpointReason,
  now = new Date(),
): Promise<WorkspaceCheckpointSaveResult> {
  try {
    return persistWorkspaceCheckpoint(createWorkspaceCheckpoint(workspaceId, workspace, reason, now));
  } catch {
    return Promise.resolve("unavailable");
  }
}

/** Read API for a later recovery/history UI; newest checkpoints are returned first. */
export async function listWorkspaceCheckpoints(workspaceId: string): Promise<WorkspaceCheckpoint[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openHistoryDb();
    return await readCheckpoints(db, workspaceId);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Ask the browser not to evict GateLab's local recovery data under storage pressure. */
export async function requestPersistentWorkspaceHistory(): Promise<boolean | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}
