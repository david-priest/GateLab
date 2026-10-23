// testFakeDrive.ts — test-only: an in-memory Drive behind the DriveApi interface, with drive.file's
// rule that GateLab reaches a file only once it created it or the user picked it. Nothing in the
// app imports this. Names are synthetic (hard rule 22).

import { writeFcs } from "../engine/fcsExport";
import {
  DriveAuthError,
  DriveError,
  DriveNetworkError,
  DriveNotFoundError,
  FOLDER_MIME,
  type DriveApi,
  type DriveFile,
  type DriveFileWrite,
  type DriveUploadState,
} from "./api";
import { md5Hex } from "./md5";
import type { DriveAccount, DriveAuth } from "./auth";
import type { DriveConfig } from "./config";
import type { DrivePicker, PickedDoc } from "./picker";

export const FAKE_CONFIG: DriveConfig = Object.freeze({
  clientId: "123-abc.apps.googleusercontent.com",
  apiKey: "AIzaFakeFakeFakeFakeFakeFake",
  appId: "123456789",
  rootFolderId: "ROOT_FOLDER_0001",
  domain: "lab.example.org",
});

interface Stored {
  meta: DriveFile;
  bytes: Uint8Array;
  revision: number;
}

/** A resumable upload session in progress. */
interface Session {
  readonly url: string;
  readonly meta: DriveFileWrite;
  readonly size: number;
  readonly data: Uint8Array;
  received: number;
  fileId: string | null;
  gone: boolean;
}

/** Which request a fault falls on. */
export type FaultOn = "start" | "chunk" | "query" | "folder" | "file";

/**
 * A request that fails, once, the next time one of its kind is made (and `when` holds). Status 0
 * is no answer at all. An `applied` fault fails after Drive acted on the request: the chunk was
 * kept, the file or folder made (P6's 500 "The operation was successful, but there was an error
 * preparing the response").
 */
export interface Fault {
  readonly on: FaultOn;
  readonly status: number;
  readonly applied?: boolean;
  readonly when?: (request: { name: string; start: number; end: number; size: number }) => boolean;
}

/** A small FCS whose acquisition keywords the test chooses. */
export function syntheticFcs(identity: { btim: string; date?: string; tot?: number }, events = 4): Uint8Array {
  const columns = [
    Float32Array.from({ length: events }, (_, i) => 1000 + i * 10),
    Float32Array.from({ length: events }, (_, i) => 100 + i * 50),
    Float32Array.from({ length: events }, (_, i) => 50 + i * 20),
  ];
  return writeFcs(columns, [
    { name: "FSC-A", desc: "" },
    { name: "FL1-A", desc: "CD3" },
    { name: "FL2-A", desc: "CD19" },
  ], {
    keywords: [
      ["$DATE", identity.date ?? "01-JAN-2026"],
      ["$BTIM", identity.btim],
      ["$ETIM", "23:59:00"],
    ],
  });
}

/** Marks a stored entry as a folder (kept out of the appProperties the fake reports). */
const FOLDER_MARK = "__fakeFolder";

export class FakeDrive implements DriveApi {
  readonly files = new Map<string, Stored>();
  /** IDs GateLab may reach: created by it, or picked. */
  readonly reachable = new Set<string>();
  readonly kept: string[] = [];
  readonly calls: string[] = [];
  /** Folders GateLab may create files in. */
  readonly writableFolders = new Set<string>();
  private nextId = 1;
  failKeep = false;
  readonly faults: Fault[] = [];
  readonly sessions = new Map<string, Session>();
  /** Drive's Range header is not readable, as when a browser's CORS rules hide it. */
  rangeHidden = false;
  /** Uploads arrive with their first byte changed. */
  alterUploads = false;
  /** Awaited before each chunk is taken, so a test can act while an upload is under way. */
  beforeChunk: (() => Promise<void>) | null = null;

  constructor(readonly user = { displayName: "Member One", emailAddress: "member1@lab.example.org" }) {}

  private newId(): string {
    return `FILE_${String(this.nextId++).padStart(8, "0")}`;
  }

  /** A file put in the folder outside GateLab (Drive for desktop, the web, a colleague): not reachable until picked. */
  addOutside(folderId: string, name: string, bytes: Uint8Array, options: { driveId?: string | null; trashed?: boolean } = {}): string {
    const id = this.newId();
    this.files.set(id, {
      bytes,
      revision: 1,
      meta: this.metaOf(id, name, folderId, bytes, 1, {}, options.driveId ?? "SHARED_DRIVE_01", options.trashed ?? false,
        { displayName: "Member Two", emailAddress: "member2@lab.example.org" }),
    });
    return id;
  }

  /**
   * A folder with a chosen ID, made outside GateLab: reachable only once picked, unless `reachable`
   * (made by this member's GateLab, or chosen before).
   */
  addFolder(id: string, parentId: string, name: string, options: { reachable?: boolean; driveId?: string | null } = {}): string {
    this.files.set(id, {
      bytes: new Uint8Array(0),
      revision: 1,
      meta: this.metaOf(id, name, parentId, new Uint8Array(0), 1, { [FOLDER_MARK]: "1" }, options.driveId === undefined ? "SHARED_DRIVE_01" : options.driveId, false,
        { displayName: "Member Two", emailAddress: "member2@lab.example.org" }),
    });
    if (options.reachable) this.reachable.add(id);
    return id;
  }

  /** A file or folder moved to another folder, as a member might in Drive. */
  move(id: string, parentId: string): void {
    const stored = this.files.get(id)!;
    stored.meta = Object.freeze({ ...stored.meta, parents: [parentId] });
  }

  /** What the Picker hands back once the user picks these files: they become reachable. */
  pick(...ids: string[]): PickedDoc[] {
    return ids.map((id) => {
      this.reachable.add(id);
      const meta = this.files.get(id)!.meta;
      return { id, name: meta.name, mimeType: meta.mimeType };
    });
  }

  /** Another member's GateLab saves the file. */
  externalWrite(id: string, bytes: Uint8Array, by = { displayName: "Member Two", emailAddress: "member2@lab.example.org" }): void {
    const stored = this.files.get(id)!;
    stored.revision++;
    stored.bytes = bytes;
    stored.meta = this.metaOf(id, stored.meta.name, stored.meta.parents[0], bytes, stored.revision,
      { gatelabWriter: "other-tab", gatelabSave: `other-${stored.revision}` }, stored.meta.driveId, false, by);
  }

  text(id: string): string {
    return new TextDecoder().decode(this.files.get(id)!.bytes);
  }

  byName(name: string): DriveFile[] {
    return [...this.files.values()].map((stored) => stored.meta).filter((meta) => meta.name === name);
  }

  private metaOf(
    id: string, name: string, folderId: string, bytes: Uint8Array, revision: number,
    appProperties: Record<string, string>, driveId: string | null, trashed: boolean,
    user: { displayName: string; emailAddress: string },
  ): DriveFile {
    const folder = appProperties[FOLDER_MARK] === "1";
    return Object.freeze({
      id, name,
      mimeType: folder ? FOLDER_MIME : name.endsWith(".gatelab") ? "application/json" : "application/octet-stream",
      size: folder ? null : bytes.length,
      parents: [folderId],
      driveId,
      trashed,
      headRevisionId: `${id}_rev${revision}`,
      modifiedTime: new Date(Date.UTC(2026, 0, 1, 0, revision)).toISOString(),
      lastModifyingUser: user,
      appProperties: Object.fromEntries(Object.entries(appProperties).filter(([key]) => key !== FOLDER_MARK)),
      md5Checksum: folder ? null : md5Hex(bytes),
    });
  }

  /** The fault this request meets, taken off the list. */
  private fault(on: FaultOn, request: { name: string; start?: number; end?: number; size?: number }): Fault | null {
    const index = this.faults.findIndex((fault) => fault.on === on &&
      (!fault.when || fault.when({ name: request.name, start: request.start ?? 0, end: request.end ?? 0, size: request.size ?? 0 })));
    return index < 0 ? null : this.faults.splice(index, 1)[0];
  }

  private failWith(fault: Fault): never {
    if (fault.status === 0) throw new DriveNetworkError("No answer from Drive (fake).");
    if (fault.status === 404) throw new DriveNotFoundError("gone (fake)");
    throw new DriveError(fault.status >= 500 ? "The operation was successful, but there was an error preparing the response" : `HTTP ${fault.status}`, fault.status);
  }

  private store(name: string, folderId: string, bytes: Uint8Array, appProperties: Record<string, string>): DriveFile {
    const id = this.newId();
    const stored: Stored = {
      bytes: bytes.slice(),
      revision: 1,
      meta: this.metaOf(id, name, folderId, bytes, 1, appProperties, "SHARED_DRIVE_01", false, this.user),
    };
    this.files.set(id, stored);
    this.reachable.add(id);
    return stored.meta;
  }

  /** The folders GateLab can reach in a folder, by name. */
  folders(parentId: string, name?: string): DriveFile[] {
    return [...this.files.values()].map((stored) => stored.meta)
      .filter((meta) => meta.mimeType === FOLDER_MIME && meta.parents.includes(parentId) && (name === undefined || meta.name === name));
  }

  /** The files in a folder, reachable or not. */
  inFolder(folderId: string): DriveFile[] {
    return [...this.files.values()].map((stored) => stored.meta).filter((meta) => meta.parents.includes(folderId));
  }

  private reach(id: string): Stored {
    const stored = this.files.get(id);
    if (!stored || !this.reachable.has(id)) throw new DriveNotFoundError(`${id}: not reachable`);
    return stored;
  }

  async getMetadata(fileId: string): Promise<DriveFile> {
    this.calls.push(`get ${fileId}`);
    return this.reach(fileId).meta;
  }

  async listChildren(folderId: string): Promise<DriveFile[]> {
    this.calls.push(`list ${folderId}`);
    return [...this.files.values()]
      .filter((stored) => this.reachable.has(stored.meta.id) && stored.meta.parents.includes(folderId) && !stored.meta.trashed)
      .map((stored) => stored.meta);
  }

  async readRange(fileId: string, start: number, end: number): Promise<Uint8Array> {
    this.calls.push(`range ${fileId} ${start}-${end}`);
    return this.reach(fileId).bytes.slice(start, end + 1);
  }

  async download(fileId: string, options: { maxBytes?: number; onProgress?: (loaded: number, total: number | null) => void } = {}): Promise<Uint8Array> {
    this.calls.push(`download ${fileId}`);
    const bytes = this.reach(fileId).bytes;
    if (options.maxBytes !== undefined && bytes.length > options.maxBytes) throw new DriveError("too large");
    options.onProgress?.(bytes.length, bytes.length);
    return bytes.slice();
  }

  async createFile(meta: { name?: string; parentId?: string; appProperties?: Readonly<Record<string, string>> }, bytes: Uint8Array): Promise<DriveFile> {
    this.calls.push(`create ${meta.name}`);
    if (!this.writableFolders.has(meta.parentId!)) throw new DriveNotFoundError("folder not reachable");
    const fault = this.fault("file", { name: meta.name! });
    if (fault && !fault.applied) this.failWith(fault);
    const file = this.store(meta.name!, meta.parentId!, bytes, { ...meta.appProperties });
    if (fault) this.failWith(fault);
    return file;
  }

  async createFolder(meta: { name: string; parentId: string; appProperties?: Readonly<Record<string, string>> }): Promise<DriveFile> {
    this.calls.push(`folder ${meta.name}`);
    if (!this.writableFolders.has(meta.parentId)) throw new DriveNotFoundError("folder not reachable");
    const fault = this.fault("folder", { name: meta.name });
    if (fault && !fault.applied) this.failWith(fault);
    const folder = this.store(meta.name, meta.parentId, new Uint8Array(0), { ...meta.appProperties, [FOLDER_MARK]: "1" });
    // GateLab may create files in a folder it made.
    this.writableFolders.add(folder.id);
    if (fault) this.failWith(fault);
    return folder;
  }

  async startUpload(meta: DriveFileWrite, size: number): Promise<string> {
    this.calls.push(`start ${meta.name}`);
    if (!this.writableFolders.has(meta.parentId!)) throw new DriveNotFoundError("folder not reachable");
    const fault = this.fault("start", { name: meta.name!, size });
    if (fault) this.failWith(fault);
    const url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=FAKE_${this.sessions.size + 1}`;
    this.sessions.set(url, { url, meta, size, data: new Uint8Array(size), received: 0, fileId: null, gone: false });
    return url;
  }

  private sessionState(session: Session): DriveUploadState {
    if (session.fileId) return { kind: "complete", file: this.files.get(session.fileId)!.meta };
    // Drive sends no Range while it holds nothing.
    return { kind: "incomplete", received: this.rangeHidden || session.received === 0 ? null : session.received };
  }

  async putUploadChunk(url: string, chunk: Uint8Array, start: number, size: number, signal?: AbortSignal): Promise<DriveUploadState> {
    if (this.beforeChunk) await this.beforeChunk();
    signal?.throwIfAborted();
    const session = this.sessions.get(url);
    const name = String(session?.meta.name);
    this.calls.push(`chunk ${name} ${start}-${start + chunk.length}`);
    if (!session || session.gone) throw new DriveNotFoundError("upload session gone (fake)");
    if (size !== session.size) throw new DriveError("size changed", 400);
    const fault = this.fault("chunk", { name, start, end: start + chunk.length, size });
    if (fault?.status === 404) session.gone = true;
    if (fault && !fault.applied) this.failWith(fault);
    if (start > session.received) throw new DriveError("a gap before this chunk", 400);
    session.data.set(chunk, start);
    session.received = Math.max(session.received, start + chunk.length);
    if (session.received === size && !session.fileId) {
      const data = session.data.slice();
      if (this.alterUploads) data[0] ^= 0xff;
      session.fileId = this.store(name, session.meta.parentId!, data, { ...session.meta.appProperties }).id;
    }
    if (fault) this.failWith(fault);
    return this.sessionState(session);
  }

  async queryUpload(url: string, size: number, signal?: AbortSignal): Promise<DriveUploadState> {
    signal?.throwIfAborted();
    const session = this.sessions.get(url);
    this.calls.push(`query ${String(session?.meta.name)}`);
    if (!session || session.gone) throw new DriveNotFoundError("upload session gone (fake)");
    if (size !== session.size) throw new DriveError("size changed", 400);
    const fault = this.fault("query", { name: String(session.meta.name), size });
    if (fault?.status === 404) session.gone = true;
    if (fault) this.failWith(fault);
    return this.sessionState(session);
  }

  async updateMedia(fileId: string, meta: { appProperties?: Readonly<Record<string, string>> }, bytes: Uint8Array): Promise<DriveFile> {
    this.calls.push(`update ${fileId}`);
    const stored = this.reach(fileId);
    stored.revision++;
    stored.bytes = bytes.slice();
    stored.meta = this.metaOf(fileId, stored.meta.name, stored.meta.parents[0], bytes, stored.revision,
      { ...stored.meta.appProperties, ...meta.appProperties }, stored.meta.driveId, false, this.user);
    return stored.meta;
  }

  async setKeepForever(fileId: string, revisionId: string): Promise<void> {
    this.calls.push(`keep ${fileId} ${revisionId}`);
    if (this.failKeep) throw new DriveError("The file has 200 revisions kept forever.", 403);
    this.kept.push(revisionId);
  }
}

/**
 * A Drive whose every request takes `latencyMs` before the in-memory Drive answers, as each request
 * to the real Drive takes 0.3 to 0.6 s. It counts the requests and the most in flight at once.
 */
export class SlowDrive implements DriveApi {
  requests = 0;
  readonly peak: Record<string, number> = {};
  private readonly running: Record<string, number> = {};

  constructor(readonly inner: FakeDrive, readonly latencyMs: number) {}

  private async slow<T>(kind: string, run: () => Promise<T>): Promise<T> {
    this.requests++;
    this.running[kind] = (this.running[kind] ?? 0) + 1;
    this.peak[kind] = Math.max(this.peak[kind] ?? 0, this.running[kind]);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      return await run();
    } finally {
      this.running[kind]--;
    }
  }

  getMetadata(fileId: string) { return this.slow("get", () => this.inner.getMetadata(fileId)); }
  listChildren(folderId: string) { return this.slow("list", () => this.inner.listChildren(folderId)); }
  readRange(fileId: string, start: number, end: number) { return this.slow("range", () => this.inner.readRange(fileId, start, end)); }
  download(fileId: string, options?: { maxBytes?: number; onProgress?: (loaded: number, total: number | null) => void }) {
    return this.slow("download", () => this.inner.download(fileId, options));
  }
  createFile(meta: DriveFileWrite, bytes: Uint8Array) { return this.slow("create", () => this.inner.createFile(meta, bytes)); }
  updateMedia(fileId: string, meta: DriveFileWrite, bytes: Uint8Array) { return this.slow("update", () => this.inner.updateMedia(fileId, meta, bytes)); }
  setKeepForever(fileId: string, revisionId: string) { return this.slow("keep", () => this.inner.setKeepForever(fileId, revisionId)); }
  createFolder(meta: { name: string; parentId: string; appProperties?: Readonly<Record<string, string>> }) {
    return this.slow("folder", () => this.inner.createFolder(meta));
  }
  startUpload(meta: DriveFileWrite, size: number) { return this.slow("start", () => this.inner.startUpload(meta, size)); }
  putUploadChunk(url: string, chunk: Uint8Array, start: number, size: number, signal?: AbortSignal) {
    return this.slow("chunk", () => this.inner.putUploadChunk(url, chunk, start, size, signal));
  }
  queryUpload(url: string, size: number, signal?: AbortSignal) { return this.slow("query", () => this.inner.queryUpload(url, size, signal)); }
}

/** A signed-in member whose token runs out only when the test sets `expired`. */
export function fakeAuth(account: DriveAccount = { email: "member1@lab.example.org", name: "Member One" }): DriveAuth & {
  signedIn: boolean;
  expired: boolean;
  reconnects: number;
  /** Run out the token, as an hour passing does, and tell the listeners. */
  expire(): void;
} {
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const auth = {
    signedIn: true,
    expired: false,
    reconnects: 0,
    prepare: async () => undefined,
    signIn: async () => {
      auth.signedIn = true;
      auth.expired = false;
      notify();
      return account;
    },
    reconnect: async () => {
      auth.reconnects++;
      auth.signedIn = true;
      auth.expired = false;
      notify();
      return account;
    },
    expire: () => {
      auth.expired = true;
      notify();
    },
    signOut: () => {
      auth.signedIn = false;
      auth.expired = false;
      notify();
    },
    token: () => {
      if (!auth.signedIn) throw new DriveError("signed out", 401);
      if (auth.expired) throw new DriveAuthError();
      return "fake-token";
    },
    account: () => (auth.signedIn ? account : null),
    expiresAt: () => (auth.signedIn ? Date.now() + 3600_000 : null),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return auth;
}

type Pick = PickedDoc[] | null;

/** A Picker that hands back whatever the test queues next; null is a cancel, and a function is picked when the Picker opens. */
export class FakePicker implements DrivePicker {
  readonly queue: (Pick | (() => Pick))[] = [];
  readonly opened: string[] = [];
  folder: PickedDoc | null = null;

  async pickExperimentFiles(): Promise<PickedDoc[] | null> {
    this.opened.push("experiment");
    return this.next();
  }

  async pickMissing(folderId: string, names: readonly string[]): Promise<PickedDoc[] | null> {
    this.opened.push(`missing ${folderId} ${names.join(",")}`);
    return this.next();
  }

  private next(): Pick {
    const next = this.queue.shift() ?? null;
    return typeof next === "function" ? next() : next;
  }

  /** Called when a folder is picked, as Drive would then let GateLab create files in it. */
  onFolderPicked: ((folder: PickedDoc) => void) | null = null;

  /** Folders handed back by the next folder picks, before `folder`; null is a cancel. */
  readonly folders: (PickedDoc | null)[] = [];
  /** The titles the folder picks were opened with. */
  readonly folderTitles: (string | undefined)[] = [];

  async pickFolder(kind: "experiment" | "lab" | "location" = "experiment", title?: string): Promise<PickedDoc | null> {
    this.opened.push(kind === "lab" ? "lab folder" : kind === "location" ? "location" : "folder");
    this.folderTitles.push(title);
    const folder = this.folders.length > 0 ? this.folders.shift() ?? null : this.folder;
    if (folder) this.onFolderPicked?.(folder);
    return folder;
  }
}
