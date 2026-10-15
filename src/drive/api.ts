// api.ts — the Drive v3 requests the lab workspace makes, and nothing else. The access token goes
// only in the Authorization header, never in a URL. Every request carries supportsAllDrives, so a
// Shared drive behaves as My Drive does. A file ID is checked before it is put into a path or a
// query, and a query is built from IDs alone: no name or other string from a workspace reaches one.

import { DRIVE_ID } from "./config";

const DRIVE = "https://www.googleapis.com/drive/v3/";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/";

/** The metadata read for every file; `size` and `headRevisionId` exist only for binary files. */
const FILE_FIELDS =
  "id,name,mimeType,size,parents,driveId,trashed,headRevisionId,modifiedTime," +
  "lastModifyingUser(displayName,emailAddress),appProperties,md5Checksum";

/** A listing past this many files is refused rather than read without end. */
const MAX_LISTED = 5000;

export class DriveError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "DriveError";
  }
}

/** The sign-in is missing, has run out, or Drive refused the token: a click on Reconnect mends it. */
export class DriveAuthError extends DriveError {
  constructor(message = "Sign-in to the lab Drive has run out. Choose Lab Drive ▸ Reconnect, then try again; nothing open here is lost.") {
    super(message, 401);
    this.name = "DriveAuthError";
  }
}

/** Drive does not have the file, or has not given GateLab it: under drive.file a file is reached only once picked. */
export class DriveNotFoundError extends DriveError {
  constructor(message: string) {
    super(message, 404);
    this.name = "DriveNotFoundError";
  }
}

/** A request that got no answer (the network failed): whether Drive acted on it is not known. */
export class DriveNetworkError extends DriveError {
  constructor(message: string) {
    super(message, null);
    this.name = "DriveNetworkError";
  }
}

export class DriveTooLargeError extends DriveError {
  constructor(message: string) {
    super(message);
    this.name = "DriveTooLargeError";
  }
}

/** Drive's head revision is not the one this tab opened or last saved. */
export class DriveConflictError extends DriveError {
  constructor(message: string) {
    super(message, 409);
    this.name = "DriveConflictError";
  }
}

export interface DriveUser {
  readonly displayName: string | null;
  readonly emailAddress: string | null;
}

export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly parents: readonly string[];
  readonly driveId: string | null;
  readonly trashed: boolean;
  readonly headRevisionId: string | null;
  readonly modifiedTime: string | null;
  readonly lastModifyingUser: DriveUser | null;
  readonly appProperties: Readonly<Record<string, string>>;
  readonly md5Checksum: string | null;
}

export interface DriveFileWrite {
  /** The new file's name; ignored by an update. */
  readonly name?: string;
  /** The folder a new file is created in; ignored by an update. */
  readonly parentId?: string;
  readonly mimeType: string;
  readonly appProperties?: Readonly<Record<string, string>>;
}

/** What a resumable upload session says after a chunk or a status query. */
export type DriveUploadState =
  | {
      readonly kind: "incomplete";
      /** How many bytes from the start Drive holds, from its Range header; null when it gave none. */
      readonly received: number | null;
    }
  | { readonly kind: "complete"; readonly file: DriveFile };

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveApi {
  getMetadata(fileId: string): Promise<DriveFile>;
  /** The files GateLab can reach in a folder: under drive.file, those it created or the user picked. */
  listChildren(folderId: string, driveId: string | null): Promise<DriveFile[]>;
  /** Bytes `start` to `end` inclusive, by a Range request. */
  readRange(fileId: string, start: number, end: number): Promise<Uint8Array>;
  /** The whole file; refused past `maxBytes`. */
  download(
    fileId: string,
    options?: { size?: number | null; maxBytes?: number; onProgress?: (loaded: number, total: number | null) => void },
  ): Promise<Uint8Array>;
  createFile(meta: DriveFileWrite, bytes: Uint8Array): Promise<DriveFile>;
  updateMedia(fileId: string, meta: DriveFileWrite, bytes: Uint8Array): Promise<DriveFile>;
  /** Keep a revision when Drive would otherwise purge it (Drive keeps 200 such per file). */
  setKeepForever(fileId: string, revisionId: string): Promise<void>;
  createFolder(meta: { readonly name: string; readonly parentId: string; readonly appProperties?: Readonly<Record<string, string>> }): Promise<DriveFile>;
  /** Open a resumable upload session for a new file of `size` bytes; the session's address is returned. */
  startUpload(meta: DriveFileWrite, size: number): Promise<string>;
  /**
   * Send bytes `start` to `start + chunk.length - 1` of `size` to the session. The session's
   * address is the capability: no token is sent, so an upload outlives the hour a token lasts (probe P6).
   */
  putUploadChunk(session: string, chunk: Uint8Array, start: number, size: number, signal?: AbortSignal): Promise<DriveUploadState>;
  /** Ask the session how much of `size` bytes it holds, or for the file when it is complete. */
  queryUpload(session: string, size: number, signal?: AbortSignal): Promise<DriveUploadState>;
}

export function checkDriveId(id: string, what = "file"): string {
  if (!DRIVE_ID.test(id)) throw new DriveError(`Not a Drive ${what} ID: ${JSON.stringify(id.slice(0, 40))}.`);
  return id;
}

/** A Drive URL; supportsAllDrives is set on every one. */
export function driveUrl(base: "drive" | "upload", path: string, params: Readonly<Record<string, string>> = {}): string {
  const url = new URL((base === "drive" ? DRIVE : UPLOAD) + path);
  url.searchParams.set("supportsAllDrives", "true");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** A resumable upload session's address, as Drive gave it: only Drive's own upload endpoint is accepted. */
export function checkUploadSession(location: string | null): string {
  let url: URL;
  try {
    url = new URL(location ?? "");
  } catch {
    throw new DriveError("Drive did not give an upload address.");
  }
  if (url.protocol !== "https:" || url.host !== "www.googleapis.com" || !url.pathname.startsWith("/upload/drive/v3/files") ||
    !url.searchParams.get("upload_id")) {
    throw new DriveError("Drive gave an upload address that is not its own upload endpoint.");
  }
  return url.toString();
}

/** The bytes a session holds from its Range header ("bytes=0-1048575" holds 1048576); null when it gave none. */
export function receivedOf(range: string | null): number | null {
  const match = /^bytes=0-(\d+)$/.exec(range?.trim() ?? "");
  return match ? Number(match[1]) + 1 : null;
}

/** The query that lists a folder's files: built from the folder's checked ID and nothing else. */
export function childrenQuery(folderId: string): string {
  return `'${checkDriveId(folderId, "folder")}' in parents and trashed = false`;
}

function toDriveFile(raw: Record<string, unknown>): DriveFile {
  const user = raw.lastModifyingUser as Record<string, unknown> | undefined;
  const size = typeof raw.size === "string" || typeof raw.size === "number" ? Number(raw.size) : NaN;
  const appProperties = raw.appProperties && typeof raw.appProperties === "object"
    ? Object.fromEntries(Object.entries(raw.appProperties as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return Object.freeze({
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    mimeType: String(raw.mimeType ?? ""),
    size: Number.isFinite(size) ? size : null,
    parents: Array.isArray(raw.parents) ? raw.parents.map(String) : [],
    driveId: typeof raw.driveId === "string" ? raw.driveId : null,
    trashed: raw.trashed === true,
    headRevisionId: typeof raw.headRevisionId === "string" ? raw.headRevisionId : null,
    modifiedTime: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
    lastModifyingUser: user
      ? {
          displayName: typeof user.displayName === "string" ? user.displayName : null,
          emailAddress: typeof user.emailAddress === "string" ? user.emailAddress : null,
        }
      : null,
    appProperties,
    md5Checksum: typeof raw.md5Checksum === "string" ? raw.md5Checksum : null,
  });
}

/** Drive's own reason for a refused request, when it gave one. */
async function reasonOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON: the text itself, cut short.
  }
  return text.slice(0, 200) || response.statusText || `HTTP ${response.status}`;
}

/** A refused response as the error the app acts on. */
export async function driveErrorOf(response: Response, what: string): Promise<DriveError> {
  const reason = await reasonOf(response);
  if (response.status === 401) return new DriveAuthError();
  if (response.status === 404) {
    return new DriveNotFoundError(
      `${what}: Drive has no such file, or GateLab has not been given it. Under the lab Drive's ` +
        "access, GateLab reaches a file only once it is chosen in Google's file picker or GateLab made it.",
    );
  }
  return new DriveError(`${what}: Drive answered ${response.status} (${reason}).`, response.status);
}

function multipartBody(meta: Record<string, unknown>, bytes: Uint8Array, mimeType: string): { body: Blob; contentType: string } {
  const boundary = `gatelab${crypto.randomUUID().replace(/-/g, "")}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    body: new Blob([head, bytes as BlobPart, tail]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

export function createDriveApi(token: () => string, fetchImpl: typeof fetch = (...args) => fetch(...args)): DriveApi {
  const request = async (
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal; anonymous?: boolean } = {},
  ) => {
    // The token is read for each request, so one that has run out stops the request before it is
    // sent. An upload session's own requests carry none: its address is the capability.
    const headers = init.anonymous ? { ...init.headers } : { Authorization: `Bearer ${token()}`, ...init.headers };
    try {
      return await fetchImpl(url, {
        method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        // A Drive response is the user's data: never kept by the browser's HTTP cache.
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (cause) {
      if (init.signal?.aborted || !(cause instanceof TypeError)) throw cause;
      throw new DriveNetworkError(`No answer from Drive (${cause.message}).`);
    }
  };
  /** A session's answer: 308 is "not yet complete", with what it holds in Range. */
  const uploadState = async (response: Response, what: string): Promise<DriveUploadState> => {
    if (response.status === 308) return { kind: "incomplete", received: receivedOf(response.headers.get("Range")) };
    return { kind: "complete", file: toDriveFile(await json(response, what)) };
  };
  const json = async (response: Response, what: string): Promise<Record<string, unknown>> => {
    if (!response.ok) throw await driveErrorOf(response, what);
    return await response.json() as Record<string, unknown>;
  };

  return {
    async getMetadata(fileId) {
      const url = driveUrl("drive", `files/${checkDriveId(fileId)}`, { fields: FILE_FIELDS });
      return toDriveFile(await json(await request("GET", url), "Reading a file's details"));
    },

    async listChildren(folderId, driveId) {
      const out: DriveFile[] = [];
      let pageToken: string | null = null;
      do {
        const params: Record<string, string> = {
          q: childrenQuery(folderId),
          includeItemsFromAllDrives: "true",
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: "1000",
          ...(driveId ? { corpora: "drive", driveId: checkDriveId(driveId, "shared drive") } : { corpora: "allDrives" }),
          ...(pageToken ? { pageToken } : {}),
        };
        const body = await json(await request("GET", driveUrl("drive", "files", params)), "Listing the experiment folder");
        for (const raw of Array.isArray(body.files) ? body.files : []) out.push(toDriveFile(raw as Record<string, unknown>));
        if (out.length > MAX_LISTED) throw new DriveError(`The experiment folder lists more than ${MAX_LISTED} files.`);
        pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
      } while (pageToken);
      return out;
    },

    async readRange(fileId, start, end) {
      if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start)) {
        throw new DriveError(`Not a byte range: ${start}-${end}.`);
      }
      const url = driveUrl("drive", `files/${checkDriveId(fileId)}`, { alt: "media" });
      const response = await request("GET", url, { headers: { Range: `bytes=${start}-${end}` } });
      if (!response.ok) throw await driveErrorOf(response, "Reading a file's header");
      const want = end - start + 1;
      if (response.status === 206) return new Uint8Array(await response.arrayBuffer()).slice(0, want);
      // A 200 is the whole file: read only as far as the range needs, then stop.
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(start, end + 1);
      const out = new Uint8Array(end + 1);
      let loaded = 0;
      while (loaded < out.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, out.length - loaded);
        out.set(value.subarray(0, take), loaded);
        loaded += take;
      }
      await reader.cancel().catch(() => undefined);
      return out.slice(start, loaded);
    },

    async download(fileId, options = {}) {
      const { size = null, maxBytes = Number.MAX_SAFE_INTEGER, onProgress } = options;
      if (size !== null && size > maxBytes) {
        throw new DriveTooLargeError(`The file is ${size} bytes, over the ${maxBytes}-byte limit.`);
      }
      const url = driveUrl("drive", `files/${checkDriveId(fileId)}`, { alt: "media" });
      const response = await request("GET", url);
      if (!response.ok) throw await driveErrorOf(response, "Downloading a file");
      const reader = response.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new DriveTooLargeError(`The file is over the ${maxBytes}-byte limit.`);
        onProgress?.(bytes.length, bytes.length);
        return bytes;
      }
      // Into one buffer of the size Drive gave, so a large FCS is not held twice while it arrives.
      let out = new Uint8Array(size ?? 1 << 20);
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DriveTooLargeError(`The file is over the ${maxBytes}-byte limit.`);
        }
        if (loaded + value.length > out.length) {
          const grown = new Uint8Array(Math.max(out.length * 2, loaded + value.length));
          grown.set(out.subarray(0, loaded));
          out = grown;
        }
        out.set(value, loaded);
        loaded += value.length;
        onProgress?.(loaded, size);
      }
      return loaded === out.length ? out : out.slice(0, loaded);
    },

    async createFile(meta, bytes) {
      if (!meta.name || !meta.parentId) throw new DriveError("A new file needs a name and a folder.");
      const { body, contentType } = multipartBody({
        name: meta.name,
        parents: [checkDriveId(meta.parentId, "folder")],
        mimeType: meta.mimeType,
        ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
      }, bytes, meta.mimeType);
      const url = driveUrl("upload", "files", { uploadType: "multipart", fields: FILE_FIELDS });
      return toDriveFile(await json(await request("POST", url, { headers: { "Content-Type": contentType }, body }), "Creating the workspace file"));
    },

    async updateMedia(fileId, meta, bytes) {
      const { body, contentType } = multipartBody({
        ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
      }, bytes, meta.mimeType);
      const url = driveUrl("upload", `files/${checkDriveId(fileId)}`, { uploadType: "multipart", fields: FILE_FIELDS });
      return toDriveFile(await json(await request("PATCH", url, { headers: { "Content-Type": contentType }, body }), "Saving the workspace file"));
    },

    async setKeepForever(fileId, revisionId) {
      if (!/^[A-Za-z0-9_.=-]{1,200}$/.test(revisionId)) throw new DriveError("Not a Drive revision ID.");
      const url = driveUrl("drive", `files/${checkDriveId(fileId)}/revisions/${encodeURIComponent(revisionId)}`, { fields: "id,keepForever" });
      const response = await request("PATCH", url, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepForever: true }),
      });
      if (!response.ok) throw await driveErrorOf(response, "Keeping the saved revision");
    },

    async createFolder(meta) {
      const url = driveUrl("drive", "files", { fields: FILE_FIELDS });
      const response = await request("POST", url, {
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          name: meta.name,
          mimeType: FOLDER_MIME,
          parents: [checkDriveId(meta.parentId, "folder")],
          ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
        }),
      });
      return toDriveFile(await json(response, "Creating the experiment folder"));
    },

    async startUpload(meta, size) {
      if (!meta.name || !meta.parentId) throw new DriveError("A new file needs a name and a folder.");
      if (!Number.isSafeInteger(size) || size < 0) throw new DriveError(`Not a file size: ${size}.`);
      const url = driveUrl("upload", "files", { uploadType: "resumable", fields: FILE_FIELDS });
      const response = await request("POST", url, {
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": meta.mimeType,
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify({
          name: meta.name,
          parents: [checkDriveId(meta.parentId, "folder")],
          mimeType: meta.mimeType,
          ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
        }),
      });
      if (!response.ok) throw await driveErrorOf(response, `Starting the upload of ${meta.name}`);
      return checkUploadSession(response.headers.get("Location"));
    },

    async putUploadChunk(session, chunk, start, size, signal) {
      const end = start + chunk.length;
      if (!(Number.isSafeInteger(start) && start >= 0 && end <= size)) throw new DriveError(`Not a part of the file: ${start}-${end} of ${size}.`);
      const response = await request("PUT", checkUploadSession(session), {
        anonymous: true,
        headers: { "Content-Range": chunk.length === 0 ? `bytes */${size}` : `bytes ${start}-${end - 1}/${size}` },
        body: chunk as BodyInit,
        ...(signal ? { signal } : {}),
      });
      if (response.status !== 308 && !response.ok) throw await driveErrorOf(response, "Uploading");
      return uploadState(response, "Uploading");
    },

    async queryUpload(session, size, signal) {
      const response = await request("PUT", checkUploadSession(session), {
        anonymous: true,
        headers: { "Content-Range": `bytes */${size}` },
        ...(signal ? { signal } : {}),
      });
      if (response.status !== 308 && !response.ok) throw await driveErrorOf(response, "Asking Drive how much of the upload it holds");
      return uploadState(response, "Asking Drive how much of the upload it holds");
    },
  };
}
