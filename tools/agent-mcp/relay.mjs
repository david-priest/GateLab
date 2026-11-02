// relay.mjs — the WebSocket end an open GateLab tab connects to. One tab at a time, on this
// computer only, with a token the tab must present. The relay turns a method call into a request
// to the tab and resolves it with the tab's response; the tab's "changed" events are kept as the
// latest revision, for a tool that wants to wait for the user's next edit.
//
// The messages are src/agent/protocol.ts; nothing here reads the gating itself.
//
// Files travel over the relay's HTTP side, never inside a WebSocket message: an FCS file of a few
// hundred megabytes would not fit one. To hand the tab a file on this computer the relay offers it
// at a one-time path (`offerFile`), the request names that path, and the tab fetches it with the
// relay's token. Each offer is served once and lapses after OFFER_TTL_MS.
//
// The other way, a save the user confirmed in the tab: the relay opens a one-time upload slot for
// a path on this computer (`receiveFile`), the tab posts the workspace's bytes to it, and the relay
// writes them to a temporary file outside the target's folder before copying them into place, so
// no partial file is ever left beside the target (a synced folder would upload it).

import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { WebSocketServer } from "ws";

export const DEFAULT_PORT = 48123;
const REQUEST_TIMEOUT_MS = 120_000;
const OFFER_TTL_MS = 10 * 60_000;

export class RelayError extends Error {
  constructor(message, code = "relay") {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

/**
 * @param {{ port?: number; host?: string; token?: string; writer?: string; log?: (line: string) => void }} options
 */
export async function startRelay(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(12).toString("base64url");
  const writer = options.writer ?? "agent";
  const log = options.log ?? (() => {});
  /** @type {import("ws").WebSocket | null} */
  let tab = null;
  let hello = null;
  let revision = null;
  let counter = 0;
  const pending = new Map();
  const changeWaiters = new Set();
  const listeners = new Set();
  /** Files offered to the tab, by the id in their path: { path, name, size, timer }. */
  const offers = new Map();
  /** Upload slots for confirmed saves, by the id in their path: { target, overwrite, timer, settle }. */
  const slots = new Map();

  // The tab is served from another origin (the dev server, GitHub Pages, GateLabR's port), so a
  // fetch of an offered file is a cross-origin request; from an https page it is also a request
  // into the private network, which Chrome preflights. The token, not the origin, is the check.
  const cors = (request) => ({
    "access-control-allow-origin": request.headers.origin ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    vary: "origin",
  });

  /** Write a confirmed save's upload: to a temporary file, then copied to the target. */
  const receive = async (request, slot) => {
    const dir = await mkdtemp(join(tmpdir(), "gatelab-relay-save-"));
    const part = join(dir, "upload");
    try {
      const hash = createHash("sha256");
      let bytes = 0;
      await new Promise((resolve, reject) => {
        const out = createWriteStream(part);
        request.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
        request.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        request.pipe(out);
      });
      await copyFile(part, slot.target, slot.overwrite ? 0 : constants.COPYFILE_EXCL);
      return { path: slot.target, bytes, sha256: hash.digest("hex") };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    const slotId = url.pathname.startsWith("/save/") ? url.pathname.slice("/save/".length) : null;
    if (slotId !== null) {
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors(request));
        response.end();
        return;
      }
      const slot = slots.get(slotId);
      if (url.searchParams.get("token") !== token || !slot || request.method !== "POST") {
        response.writeHead(slot ? 403 : 404, { ...cors(request), "content-type": "text/plain; charset=utf-8" });
        response.end(slot ? "Forbidden\n" : "No such save (each takes one upload).\n");
        return;
      }
      slots.delete(slotId);
      clearTimeout(slot.timer);
      receive(request, slot).then(
        (written) => {
          response.writeHead(200, { ...cors(request), "content-type": "application/json" });
          response.end(JSON.stringify(written));
          log(`saved ${written.path} (${written.bytes} bytes)`);
          slot.settle({ written });
        },
        (error) => {
          const message = error?.code === "EEXIST" ? `${slot.target} appeared while the workspace was being saved; nothing was written.` : `Could not write ${slot.target}: ${error instanceof Error ? error.message : String(error)}`;
          response.writeHead(500, { ...cors(request), "content-type": "text/plain; charset=utf-8" });
          response.end(`${message}\n`);
          slot.settle({ error: new RelayError(message, "failed") });
        },
      );
      return;
    }
    const offerId = url.pathname.startsWith("/file/") ? url.pathname.slice("/file/".length) : null;
    if (offerId !== null) {
      if (request.method === "OPTIONS") {
        response.writeHead(204, cors(request));
        response.end();
        return;
      }
      const offer = offers.get(offerId);
      if (url.searchParams.get("token") !== token || !offer || request.method !== "GET") {
        response.writeHead(offer ? 403 : 404, { ...cors(request), "content-type": "text/plain; charset=utf-8" });
        response.end(offer ? "Forbidden\n" : "No such file offer (each is served once).\n");
        return;
      }
      offers.delete(offerId);
      clearTimeout(offer.timer);
      response.writeHead(200, { ...cors(request), "content-type": "application/octet-stream", "content-length": String(offer.size) });
      const stream = createReadStream(offer.path);
      stream.on("error", (error) => response.destroy(error));
      stream.pipe(response);
      log(`served ${offer.name} (${offer.size} bytes)`);
      return;
    }
    // A plain GET says what this is, for a browser that lands here by mistake.
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("GateLab agent relay. Connect from GateLab's Agent menu with the ws:// address the session printed.\n");
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  const notify = (event) => {
    for (const listener of listeners) listener(event);
  };

  wss.on("connection", (ws) => {
    if (tab) {
      // One tab at a time: the newer connection replaces the older, which is told so.
      try { tab.close(4000, "another tab connected"); } catch { /* gone */ }
    }
    tab = ws;
    hello = null;
    log("tab connected");
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.kind === "hello") {
        hello = message.info ?? null;
        ws.send(JSON.stringify({ kind: "hello", writer }));
        notify({ type: "hello", info: hello });
        return;
      }
      if (message.kind === "event" && message.event === "changed") {
        revision = message.revision;
        for (const waiter of changeWaiters) waiter(revision);
        changeWaiters.clear();
        notify({ type: "changed", revision });
        return;
      }
      if (message.kind === "response" && typeof message.id === "string") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new RelayError(message.error.message, message.error.code));
        else entry.resolve(message.result);
      }
    });
    ws.on("close", () => {
      if (tab !== ws) return;
      tab = null;
      hello = null;
      log("tab disconnected");
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new RelayError("The GateLab tab disconnected before answering.", "disconnected"));
      }
      pending.clear();
      notify({ type: "disconnected" });
    });
  });

  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? DEFAULT_PORT, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const port = http.address().port;
  const url = `ws://${host}:${port}/?token=${token}`;

  return {
    url,
    port,
    token,
    /** The tab's hello, or null while no tab is connected. */
    get info() { return hello; },
    get connected() { return tab !== null && tab.readyState === tab.OPEN; },
    get revision() { return revision; },
    /**
     * Offer a file on this computer to the tab: resolves with the name, the size and the one-time
     * path the tab fetches it from (with the token). Rejects with RelayError for a relative path
     * or anything that is not a readable file.
     */
    async offerFile(path) {
      if (typeof path !== "string" || !isAbsolute(path)) throw new RelayError(`Not an absolute path: ${String(path)}`, "refused");
      let info;
      try {
        info = await stat(path);
      } catch {
        throw new RelayError(`No such file: ${path}`, "refused");
      }
      if (!info.isFile()) throw new RelayError(`Not a file: ${path}`, "refused");
      const id = randomBytes(12).toString("base64url");
      const name = basename(path);
      const timer = setTimeout(() => offers.delete(id), OFFER_TTL_MS);
      timer.unref?.();
      offers.set(id, { path, name, size: info.size, timer });
      return { name, size: info.size, path: `/file/${id}` };
    },
    /** Offers not yet fetched, for a test. */
    get pendingOffers() { return offers.size; },
    /**
     * Open a one-time upload slot for a save to `target`, an absolute path whose folder exists.
     * Refused when the file is there already, unless `overwrite`. Resolves with the path the tab
     * posts to and `written`, a promise of `{path, bytes, sha256}` once the upload is on disk;
     * `cancel()` closes the slot unused.
     */
    async receiveFile(target, { overwrite = false } = {}) {
      if (typeof target !== "string" || !isAbsolute(target)) throw new RelayError(`Not an absolute path: ${String(target)}`, "refused");
      let folder;
      try {
        folder = await stat(dirname(target));
      } catch {
        folder = null;
      }
      if (!folder?.isDirectory()) throw new RelayError(`No such folder: ${dirname(target)}`, "refused");
      const existing = await stat(target).catch(() => null);
      if (existing?.isDirectory()) throw new RelayError(`A folder is there: ${target}`, "refused");
      if (existing && !overwrite) throw new RelayError(`A file is there already: ${target}. Pass overwrite: true to replace it.`, "refused");
      const id = randomBytes(12).toString("base64url");
      let settle;
      const outcome = new Promise((resolve) => { settle = resolve; });
      const timer = setTimeout(() => { slots.delete(id); settle({ error: new RelayError("The save was not uploaded in time.", "timeout") }); }, OFFER_TTL_MS);
      timer.unref?.();
      slots.set(id, { target, overwrite, timer, settle });
      const written = outcome.then((result) => { if (result.error) throw result.error; return result.written; });
      // A slot cancelled or lapsed with nobody awaiting it must not surface as an unhandled rejection.
      written.catch(() => {});
      return {
        path: `/save/${id}`,
        name: basename(target),
        written,
        cancel: () => {
          if (!slots.delete(id)) return;
          clearTimeout(timer);
          settle({ error: new RelayError("The save was cancelled.", "cancelled") });
        },
      };
    },
    /** Upload slots not yet used, for a test. */
    get pendingSaves() { return slots.size; },
    /**
     * Ask the connected tab. Rejects with RelayError when no tab is there, on a refusal, or on a
     * timeout; `options.timeoutMs` lengthens the wait for a request that waits on the user.
     */
    call(method, params = {}, options = {}) {
      const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      if (!tab || tab.readyState !== tab.OPEN) return Promise.reject(new RelayError("No GateLab tab is connected. Open GateLab, choose Agent ▸ Connect to an agent… and paste the relay address.", "no-tab"));
      const id = `r${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RelayError(`The GateLab tab did not answer ${method} within ${timeoutMs / 1000} s.`, "timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        tab.send(JSON.stringify({ kind: "request", id, method, params }));
      });
    },
    /** Resolves with the next revision the tab reports, or null after `timeoutMs`. */
    waitForChange(timeoutMs = 60_000) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { changeWaiters.delete(waiter); resolve(null); }, timeoutMs);
        const waiter = (rev) => { clearTimeout(timer); resolve(rev); };
        changeWaiters.add(waiter);
      });
    },
    /** Resolves once a tab has said hello, or null after `timeoutMs`. */
    waitForTab(timeoutMs = 60_000) {
      if (hello) return Promise.resolve(hello);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { listeners.delete(listener); resolve(null); }, timeoutMs);
        const listener = (event) => {
          if (event.type !== "hello") return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(event.info);
        };
        listeners.add(listener);
      });
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() {
      for (const offer of offers.values()) clearTimeout(offer.timer);
      offers.clear();
      for (const slot of slots.values()) { clearTimeout(slot.timer); slot.settle({ error: new RelayError("The relay closed.", "disconnected") }); }
      slots.clear();
      for (const client of wss.clients) client.close(1001, "relay closing");
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => http.close(() => resolve()));
    },
  };
}
