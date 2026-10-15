// The Drive requests: errors mapped to what the app acts on, a folder query built from IDs alone,
// supportsAllDrives on every call, and the token in the Authorization header and in no URL.

import { describe, expect, it } from "vitest";
import {
  checkUploadSession,
  childrenQuery,
  createDriveApi,
  DriveAuthError,
  DriveError,
  DriveNetworkError,
  DriveNotFoundError,
  DriveTooLargeError,
  receivedOf,
  type DriveApi,
} from "./api";

const TOKEN = "ya29.secret-token-value";
const FILE = "FILE_000000000001";
const FOLDER = "FOLDER_0000000001";

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function stubbed(respond: (sent: Sent) => Response = () => Response.json({ id: FILE, name: "D1_treated.fcs" })) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = { method: init?.method ?? "GET", url: String(input), headers: { ...(init?.headers as Record<string, string>) } };
    sent.push(request);
    return respond(request);
  }) as typeof fetch;
  return { api: createDriveApi(() => TOKEN, fetchImpl), sent };
}

async function everyCall(api: DriveApi): Promise<void> {
  await api.getMetadata(FILE);
  await api.listChildren(FOLDER, "SHARED_DRIVE_0001");
  await api.listChildren(FOLDER, null);
  await api.readRange(FILE, 0, 57);
  await api.download(FILE, { size: 3 });
  await api.createFile({ name: "D1 workspace.gatelab", parentId: FOLDER, mimeType: "application/json", appProperties: { gatelabWriter: "tab" } }, Uint8Array.from([1]));
  await api.updateMedia(FILE, { mimeType: "application/json" }, Uint8Array.from([1]));
  await api.setKeepForever(FILE, "0B_revision-1");
}

describe("Drive requests", () => {
  it("set supportsAllDrives on every call and carry the token only in the Authorization header", async () => {
    const { api, sent } = stubbed((request) => request.url.includes("alt=media")
      ? new Response(Uint8Array.from([1, 2, 3]), { status: request.headers.Range ? 206 : 200 })
      : Response.json({ id: FILE, name: "x", files: [] }));
    await everyCall(api);
    expect(sent).toHaveLength(8);
    for (const request of sent) {
      expect(new URL(request.url).searchParams.get("supportsAllDrives")).toBe("true");
      expect(request.url).not.toContain(TOKEN);
      expect(decodeURIComponent(request.url)).not.toContain(TOKEN);
      expect(request.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(new URL(request.url).host).toBe("www.googleapis.com");
    }
    const list = new URL(sent[1].url).searchParams;
    expect(list.get("q")).toBe(`'${FOLDER}' in parents and trashed = false`);
    expect(list.get("corpora")).toBe("drive");
    expect(list.get("includeItemsFromAllDrives")).toBe("true");
    expect(new URL(sent[2].url).searchParams.get("corpora")).toBe("allDrives");
  });

  it("build a folder query from a checked ID and nothing else", async () => {
    expect(childrenQuery(FOLDER)).toBe(`'${FOLDER}' in parents and trashed = false`);
    for (const hostile of ["x' or name contains '", "FOLDER_0000000001' or 'a' in parents", "short", "../../files"]) {
      expect(() => childrenQuery(hostile)).toThrow(DriveError);
    }
    const { api, sent } = stubbed();
    await expect(api.listChildren("D1' or trashed = true or '", null)).rejects.toThrow(DriveError);
    await expect(api.getMetadata("../about")).rejects.toThrow(DriveError);
    expect(sent).toHaveLength(0);
  });

  it("map refusals to the errors the app acts on", async () => {
    const answer = (status: number) => stubbed(() => Response.json({ error: { message: `reason ${status}` } }, { status })).api;
    await expect(answer(401).getMetadata(FILE)).rejects.toBeInstanceOf(DriveAuthError);
    await expect(answer(404).getMetadata(FILE)).rejects.toBeInstanceOf(DriveNotFoundError);
    const forbidden = await answer(403).getMetadata(FILE).catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(DriveError);
    expect((forbidden as DriveError).status).toBe(403);
    expect((forbidden as DriveError).message).toContain("reason 403");
    const failed = await answer(500).updateMedia(FILE, { mimeType: "application/json" }, Uint8Array.from([1])).catch((error: unknown) => error);
    expect((failed as DriveError).status).toBe(500);
  });

  it("stop before sending when the token has run out", async () => {
    const sent: string[] = [];
    const api = createDriveApi(() => { throw new DriveAuthError(); }, (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return Response.json({});
    }) as typeof fetch);
    await expect(api.getMetadata(FILE)).rejects.toBeInstanceOf(DriveAuthError);
    expect(sent).toEqual([]);
  });

  it("refuse a download over its limit, before and while reading", async () => {
    const { api, sent } = stubbed(() => new Response(new Uint8Array(100)));
    await expect(api.download(FILE, { size: 100, maxBytes: 10 })).rejects.toBeInstanceOf(DriveTooLargeError);
    expect(sent).toHaveLength(0);
    await expect(api.download(FILE, { size: null, maxBytes: 10 })).rejects.toBeInstanceOf(DriveTooLargeError);
    const whole = await api.download(FILE, { size: 100 });
    expect(whole.length).toBe(100);
  });

  it("read a range from a server that sends the whole file", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    const { api, sent } = stubbed(() => new Response(bytes, { status: 200 }));
    expect([...await api.readRange(FILE, 2, 5)]).toEqual([2, 3, 4, 5]);
    expect(sent[0].headers.Range).toBe("bytes=2-5");
  });

  it("send a new file's folder and appProperties in the metadata part", async () => {
    let body = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = await (init?.body as Blob).text();
      return Response.json({ id: FILE, name: "D1 workspace.gatelab" });
    }) as typeof fetch;
    await createDriveApi(() => TOKEN, fetchImpl).createFile(
      { name: "D1 workspace.gatelab", parentId: FOLDER, mimeType: "application/json", appProperties: { gatelabWriter: "tab-1" } },
      new TextEncoder().encode("{\"format\":\"gatelab-workspace\"}"),
    );
    expect(body).toContain(`"parents":["${FOLDER}"]`);
    expect(body).toContain(`"appProperties":{"gatelabWriter":"tab-1"}`);
    expect(body).toContain("{\"format\":\"gatelab-workspace\"}");
  });
});

describe("resumable upload requests", () => {
  const SESSION = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&upload_id=ABC123";

  it("open a session with the token and the file's size, and send chunks and status queries without it", async () => {
    const { api, sent } = stubbed((request) => {
      if (request.method === "POST") return new Response(null, { status: 200, headers: { Location: SESSION } });
      if (request.headers["Content-Range"] === "bytes */10") return new Response(null, { status: 308, headers: { Range: "bytes=0-3" } });
      if (request.headers["Content-Range"] === "bytes 0-3/10") return new Response(null, { status: 308, headers: { Range: "bytes=0-3" } });
      return Response.json({ id: FILE, name: "D1_treated.fcs", size: "10", md5Checksum: "abc" });
    });
    expect(await api.startUpload({ name: "D1_treated.fcs", parentId: FOLDER, mimeType: "application/octet-stream", appProperties: { gatelabUpload: "u-1" } }, 10)).toBe(SESSION);
    expect(await api.putUploadChunk(SESSION, Uint8Array.from([1, 2, 3, 4]), 0, 10)).toEqual({ kind: "incomplete", received: 4 });
    expect(await api.queryUpload(SESSION, 10)).toEqual({ kind: "incomplete", received: 4 });
    const done = await api.putUploadChunk(SESSION, Uint8Array.from([5, 6, 7, 8, 9, 10]), 4, 10);
    expect(done.kind === "complete" && done.file.md5Checksum).toBe("abc");

    const [start, first, query, last] = sent;
    expect(start.method).toBe("POST");
    expect(start.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(start.headers["X-Upload-Content-Length"]).toBe("10");
    expect(start.headers["X-Upload-Content-Type"]).toBe("application/octet-stream");
    const startUrl = new URL(start.url);
    expect(startUrl.pathname).toBe("/upload/drive/v3/files");
    expect(startUrl.searchParams.get("uploadType")).toBe("resumable");
    expect(startUrl.searchParams.get("supportsAllDrives")).toBe("true");
    expect(startUrl.searchParams.get("fields")).toContain("md5Checksum");
    for (const request of [first, query, last]) {
      expect(request.method).toBe("PUT");
      expect(request.url).toBe(SESSION);
      expect(request.headers.Authorization).toBeUndefined();
    }
    expect(first.headers["Content-Range"]).toBe("bytes 0-3/10");
    expect(query.headers["Content-Range"]).toBe("bytes */10");
    expect(last.headers["Content-Range"]).toBe("bytes 4-9/10");
    for (const request of sent) expect(decodeURIComponent(request.url)).not.toContain(TOKEN);
  });

  it("send the new file's folder and appProperties when opening the session", async () => {
    let body = "";
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(null, { status: 200, headers: { Location: SESSION } });
    }) as typeof fetch;
    await createDriveApi(() => TOKEN, fetchImpl).startUpload(
      { name: "D1_treated.fcs", parentId: FOLDER, mimeType: "application/octet-stream", appProperties: { gatelabUpload: "u-1" } }, 10);
    expect(JSON.parse(body)).toEqual({ name: "D1_treated.fcs", parents: [FOLDER], mimeType: "application/octet-stream", appProperties: { gatelabUpload: "u-1" } });
  });

  it("refuse an upload address that is not Drive's own", async () => {
    for (const location of [null, "", "http://www.googleapis.com/upload/drive/v3/files?upload_id=x",
      "https://evil.example.org/upload/drive/v3/files?upload_id=x", "https://www.googleapis.com/drive/v3/files?upload_id=x",
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"]) {
      expect(() => checkUploadSession(location), String(location)).toThrow(DriveError);
    }
    const { api } = stubbed(() => new Response(null, { status: 200, headers: { Location: "https://evil.example.org/upload?upload_id=x" } }));
    await expect(api.startUpload({ name: "D1_treated.fcs", parentId: FOLDER, mimeType: "application/octet-stream" }, 1)).rejects.toThrow(/not its own upload endpoint/);
    const sent: string[] = [];
    const quiet = createDriveApi(() => TOKEN, (async (input: RequestInfo | URL) => { sent.push(String(input)); return Response.json({}); }) as typeof fetch);
    await expect(quiet.putUploadChunk("https://evil.example.org/upload?upload_id=x", Uint8Array.from([1]), 0, 1)).rejects.toThrow(DriveError);
    expect(sent).toEqual([]);
  });

  it("read the bytes a session holds from its Range header", () => {
    expect(receivedOf("bytes=0-1048575")).toBe(1048576);
    expect(receivedOf(null)).toBeNull();
    expect(receivedOf("bytes=5-9")).toBeNull();
  });

  it("report a 5xx with its status, and no answer as a network error", async () => {
    const { api } = stubbed(() => Response.json({ error: { message: "The operation was successful, but there was an error preparing the response" } }, { status: 500 }));
    const failed = await api.putUploadChunk(SESSION, Uint8Array.from([1]), 0, 1).catch((error: unknown) => error);
    expect((failed as DriveError).status).toBe(500);
    const offline = createDriveApi(() => TOKEN, (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch);
    await expect(offline.queryUpload(SESSION, 1)).rejects.toBeInstanceOf(DriveNetworkError);
    const controller = new AbortController();
    controller.abort();
    const aborted = createDriveApi(() => TOKEN, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return Response.json({});
    }) as typeof fetch);
    const error = await aborted.putUploadChunk(SESSION, Uint8Array.from([1]), 0, 1, controller.signal).catch((cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(DriveError);
  });

  it("create a folder in a checked parent, with supportsAllDrives", async () => {
    const { api, sent } = stubbed(() => Response.json({ id: FOLDER, name: "Experiment 1", mimeType: "application/vnd.google-apps.folder" }));
    await api.createFolder({ name: "Experiment 1", parentId: FOLDER, appProperties: { gatelabSave: "n-1" } });
    expect(new URL(sent[0].url).searchParams.get("supportsAllDrives")).toBe("true");
    expect(sent[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    await expect(api.createFolder({ name: "x", parentId: "a' or 'b" })).rejects.toThrow(DriveError);
  });
});
