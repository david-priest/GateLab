// relay.mjs — the WebSocket end an open GateLab tab connects to. One tab at a time, on this
// computer only, with a token the tab must present. The relay turns a method call into a request
// to the tab and resolves it with the tab's response; the tab's "changed" events are kept as the
// latest revision, for a tool that wants to wait for the user's next edit.
//
// The messages are src/agent/protocol.ts; nothing here reads the gating itself.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const DEFAULT_PORT = 48123;
const REQUEST_TIMEOUT_MS = 120_000;

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

  const http = createServer((request, response) => {
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
    /** Ask the connected tab. Rejects with RelayError when no tab is there, on a refusal, or on a timeout. */
    call(method, params = {}) {
      if (!tab || tab.readyState !== tab.OPEN) return Promise.reject(new RelayError("No GateLab tab is connected. Open GateLab, choose Agent ▸ Connect to an agent… and paste the relay address.", "no-tab"));
      const id = `r${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RelayError(`The GateLab tab did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} s.`, "timeout"));
        }, REQUEST_TIMEOUT_MS);
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
      for (const client of wss.clients) client.close(1001, "relay closing");
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => http.close(() => resolve()));
    },
  };
}
