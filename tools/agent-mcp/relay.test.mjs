// The relay with a stand-in tab on a real socket, and the MCP framing over in-memory streams.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { serveMcp } from "./mcp.mjs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "./relay.mjs";
import { gatelabTools } from "./tools.mjs";

/** A tab that answers describe and apply, and says hello. */
function fakeTab(url, { answer } = {}) {
  const ws = new WebSocket(url);
  const received = [];
  let revision = 1;
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    received.push(message);
    if (message.kind === "request") {
      if (answer) { answer(ws, message); return; }
      if (message.method === "apply") revision++;
      ws.send(JSON.stringify({ kind: "response", id: message.id, result: { method: message.method, params: message.params, revision } }));
      if (message.method === "apply") ws.send(JSON.stringify({ kind: "event", event: "changed", revision }));
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ kind: "hello", protocol: 1, info: { app: "GateLab", version: "t", host: "browser", workspaceName: "w.gatelab" } }));
      resolve();
    });
    ws.once("error", reject);
  });
  return { ws, received, open, close: () => ws.close() };
}

describe("the relay", () => {
  it("admits one tab with the token, answers calls through it, and reports its changes", async () => {
    const relay = await startRelay({ port: 0, writer: "claude" });
    try {
      expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/\?token=/);
      expect(relay.connected).toBe(false);
      await expect(relay.call("describe")).rejects.toMatchObject({ code: "no-tab" });
      // The wrong token is refused at the door.
      const refused = new WebSocket(relay.url.replace(/token=.*$/, "token=wrong"));
      await expect(new Promise((_, reject) => refused.once("error", reject))).rejects.toThrow(/403/);
      const tab = fakeTab(relay.url);
      await tab.open;
      expect(await relay.waitForTab(2000)).toMatchObject({ app: "GateLab", workspaceName: "w.gatelab" });
      expect(relay.connected).toBe(true);
      // The relay introduces the agent by name.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tab.received[0]).toEqual({ kind: "hello", writer: "claude" });
      const result = await relay.call("describe", { a: 1 });
      expect(result).toEqual({ method: "describe", params: { a: 1 }, revision: 1 });
      const change = relay.waitForChange(2000);
      await relay.call("apply", { command: { type: "undo" } });
      expect(await change).toBe(2);
      expect(relay.revision).toBe(2);
      expect(await relay.waitForChange(30)).toBeNull();
      // A second tab replaces the first.
      const second = fakeTab(relay.url);
      await second.open;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tab.ws.readyState).toBe(WebSocket.CLOSED);
      expect(await relay.call("describe")).toMatchObject({ method: "describe" });
      second.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(relay.connected).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it("turns a tab's refusal into a RelayError with its code, and a dropped tab into a rejection", async () => {
    const relay = await startRelay({ port: 0 });
    try {
      const tab = fakeTab(relay.url, {
        answer: (ws, message) => {
          if (message.method === "apply") ws.send(JSON.stringify({ kind: "response", id: message.id, error: { code: "refused", message: "Unknown population “x”." } }));
          // describe is never answered: the tab drops instead
          else ws.close();
        },
      });
      await tab.open;
      await relay.waitForTab(2000);
      await expect(relay.call("apply", {})).rejects.toMatchObject({ code: "refused", message: "Unknown population “x”." });
      await expect(relay.call("describe")).rejects.toMatchObject({ code: "disconnected" });
    } finally {
      await relay.close();
    }
  });
});

describe("the MCP server", () => {
  it("initialises, lists the tools and calls them over newline-delimited JSON-RPC", async () => {
    const relay = await startRelay({ port: 0, writer: "claude" });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = [];
    output.on("data", (chunk) => { for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push(JSON.parse(line)); });
    try {
      serveMcp({ name: "gatelab", version: "0.1.0", instructions: "hi", tools: gatelabTools(relay), input, output });
      const send = (message) => input.write(JSON.stringify(message) + "\n");
      const until = async (count) => { for (let i = 0; i < 100 && lines.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 10)); };
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await until(2);
      expect(lines[0]).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "gatelab" }, instructions: "hi", capabilities: { tools: {} } } });
      const names = lines[1].result.tools.map((tool) => tool.name);
      expect(names).toEqual(["gatelab_fit_start", "gatelab_fit_candidate", "gatelab_fit_finish", "gatelab_fit_cancel", "gatelab_guide", "gatelab_status", "gatelab_open_files", "gatelab_import_gating", "gatelab_save", "gatelab_describe", "gatelab_context", "gatelab_evaluate", "gatelab_distribution", "gatelab_stats", "gatelab_preview", "gatelab_apply", "gatelab_view", "gatelab_render", "gatelab_wait_for_change", "gatelab_reload", "gatelab_export"]);
      expect(lines[1].result.tools.every((tool) => tool.inputSchema.type === "object" && tool.description.length > 40)).toBe(true);
      // Status before a tab: not connected, with the address to give the user.
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gatelab_status", arguments: {} } });
      await until(3);
      expect(JSON.parse(lines[2].result.content[0].text)).toMatchObject({ connected: false, address: relay.url });
      // The guide is the specification file, served whole, and it names every command and the quadrant order.
      send({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "gatelab_guide", arguments: {} } });
      await until(4);
      const guide = lines[3].result.content[0].text;
      expect(lines[3].result.isError).toBeUndefined();
      for (const command of ["createGate", "createRange", "createQuadrant", "createEllipse", "definePopulation", "editGate", "moveQuadrantCenter", "renameGate", "renamePopulation", "movePopulation", "deleteGate", "deletePopulation", "undo"]) expect(guide).toContain(`\`${command}\``);
      expect(guide).toContain("Q1 = x− y+");
      expect(guide).toContain("gatelabSync");
      lines.splice(3, 1);
      // A tool call with no tab is an error result, not a protocol error.
      send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gatelab_describe", arguments: {} } });
      await until(4);
      expect(lines[3].result).toMatchObject({ isError: true });
      expect(lines[3].result.content[0].text).toContain("no-tab");
      // With a tab, describe goes through; render returns an image block.
      const tab = fakeTab(relay.url, {
        answer: (ws, message) => ws.send(JSON.stringify({ kind: "response", id: message.id, result: message.method === "render"
          ? { png: "data:image/png;base64,iVBORw0KGgo=", width: 2, height: 2, view: { x: "A" }, revision: 1 }
          : { echoed: message.params, revision: 1 } })),
      });
      await tab.open;
      await relay.waitForTab(2000);
      send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "gatelab_apply", arguments: { command: { type: "undo" }, rationale: "r" } } });
      send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gatelab_render", arguments: { width: 300 } } });
      send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } });
      send({ jsonrpc: "2.0", id: 8, method: "ping" });
      await until(8);
      const byId = Object.fromEntries(lines.map((line) => [line.id, line]));
      expect(JSON.parse(byId[5].result.content[0].text)).toEqual({ echoed: { command: { type: "undo" }, rationale: "r" }, revision: 1 });
      expect(byId[6].result.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
      expect(JSON.parse(byId[6].result.content[1].text)).toMatchObject({ width: 2, view: { x: "A" } });
      expect(byId[7].error.code).toBe(-32602);
      expect(byId[8].result).toEqual({});
      tab.close();
    } finally {
      await relay.close();
    }
  });
});

describe("gatelab_view on the Strategy tab", () => {
  it("passes the selection through, and refuses a core that answers on the Gating tab", async () => {
    const relay = await startRelay({ port: 0, writer: "claude" });
    let strategyCore = true;
    const tab = fakeTab(relay.url, {
      answer: (ws, message) => ws.send(JSON.stringify({ kind: "response", id: message.id, result: strategyCore
        ? { tab: "strategy", strategy: { mode: "multi", populationIds: message.params.strategy.populationIds, fullPath: false }, asked: message.params }
        // An older core ignores strategy and puts the Gating plot up.
        : { tab: "gating", populationId: "P1" } })),
    });
    try {
      await tab.open;
      await relay.waitForTab(2000);
      const view = gatelabTools(relay).find((tool) => tool.name === "gatelab_view");
      const params = { strategy: { populationIds: ["P1", "P2"] } };
      const ok = await view.run(params);
      expect(ok.isError).toBeUndefined();
      expect(JSON.parse(ok.content[0].text)).toMatchObject({ tab: "strategy", strategy: { populationIds: ["P1", "P2"] }, asked: params });
      strategyCore = false;
      const old = await view.run(params);
      expect(old.isError).toBe(true);
      expect(old.content[0].text).toContain("predates");
      expect((await view.run({ tab: "strategy" })).isError).toBe(true);
      // Without the Strategy tab the reply is passed on as before.
      expect((await view.run({ populationId: "P1" })).isError).toBeUndefined();
    } finally {
      tab.close();
      await relay.close();
    }
  });
});

describe("files the relay offers the tab", () => {
  const httpOf = (relay, path, token = relay.token) => `http://127.0.0.1:${relay.port}${path}?token=${token}`;

  it("serves an offer once, with the token, to a page on another origin; refuses everything else", async () => {
    const relay = await startRelay({ port: 0 });
    const dir = await mkdtemp(join(tmpdir(), "gatelab-relay-"));
    const file = join(dir, "D1.fcs");
    await writeFile(file, Buffer.from("FCS3.1 synthetic bytes"));
    try {
      await expect(relay.offerFile("D1.fcs")).rejects.toMatchObject({ code: "refused" });
      await expect(relay.offerFile(join(dir, "missing.fcs"))).rejects.toMatchObject({ code: "refused" });
      await expect(relay.offerFile(dir)).rejects.toMatchObject({ code: "refused", message: expect.stringMatching(/Not a file/) });
      const offer = await relay.offerFile(file);
      expect(offer).toMatchObject({ name: "D1.fcs", size: 22, path: expect.stringMatching(/^\/file\/[A-Za-z0-9_-]+$/) });
      expect(relay.pendingOffers).toBe(1);
      // The preflight a page on https sends before reaching into this computer.
      const preflight = await fetch(httpOf(relay, offer.path), { method: "OPTIONS", headers: { origin: "https://example.org", "access-control-request-private-network": "true" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
      expect(preflight.headers.get("access-control-allow-origin")).toBe("https://example.org");
      expect((await fetch(httpOf(relay, offer.path, "wrong"))).status).toBe(403);
      const served = await fetch(httpOf(relay, offer.path), { headers: { origin: "http://localhost:5173" } });
      expect(served.status).toBe(200);
      expect(served.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(await served.text()).toBe("FCS3.1 synthetic bytes");
      // Once only.
      expect((await fetch(httpOf(relay, offer.path))).status).toBe(404);
      expect(relay.pendingOffers).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("gatelab_open_files and gatelab_import_gating offer the files and wait on the tab; status gives the connected link", async () => {
    const relay = await startRelay({ port: 0 });
    const dir = await mkdtemp(join(tmpdir(), "gatelab-relay-"));
    await writeFile(join(dir, "D1.fcs"), "one");
    await writeFile(join(dir, "D2.fcs"), "two!");
    await writeFile(join(dir, "tree.wsp"), "<Workspace/>");
    // A tab that fetches every offer it is handed, as the app does, and reports what it read.
    const tab = fakeTab(relay.url, {
      answer: async (ws, message) => {
        const files = message.method === "openFiles" ? message.params.files : [message.params.file];
        const read = [];
        for (const f of files) read.push([f.name, await (await fetch(httpOf(relay, f.path))).text()]);
        ws.send(JSON.stringify({ kind: "response", id: message.id, result: { method: message.method, read, revision: 1 } }));
      },
    });
    try {
      await tab.open;
      await relay.waitForTab(2000);
      const tools = Object.fromEntries(gatelabTools(relay).map((tool) => [tool.name, tool]));
      const opened = await tools.gatelab_open_files.run({ paths: [join(dir, "D1.fcs"), join(dir, "D2.fcs")] });
      expect(JSON.parse(opened.content[0].text)).toEqual({ method: "openFiles", read: [["D1.fcs", "one"], ["D2.fcs", "two!"]], revision: 1 });
      const imported = await tools.gatelab_import_gating.run({ path: join(dir, "tree.wsp") });
      expect(JSON.parse(imported.content[0].text)).toMatchObject({ method: "importGating", read: [["tree.wsp", "<Workspace/>"]] });
      expect(relay.pendingOffers).toBe(0);
      // A path that is not there is refused before the tab is asked.
      const missing = await tools.gatelab_open_files.run({ paths: [join(dir, "D9.fcs")] });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toContain("No such file");
      const status = JSON.parse((await tools.gatelab_status.run({ appUrl: "http://localhost:5173/" })).content[0].text);
      expect(new URL(status.launchUrl).searchParams.get("agent")).toBe(relay.url);
      expect((await tools.gatelab_status.run({ appUrl: "javascript:alert(1)" })).isError).toBe(true);
    } finally {
      tab.close();
      await relay.close();
    }
  });
});

describe("a save the user confirmed", () => {
  const httpOf = (relay, path, token = relay.token) => `http://127.0.0.1:${relay.port}${path}?token=${token}`;

  it("opens one upload slot for a path whose folder exists, writes the upload there, and refuses the rest", async () => {
    const relay = await startRelay({ port: 0 });
    const dir = await mkdtemp(join(tmpdir(), "gatelab-relay-"));
    const target = join(dir, "copy.gatelab");
    try {
      await expect(relay.receiveFile("copy.gatelab")).rejects.toMatchObject({ code: "refused" });
      await expect(relay.receiveFile(join(dir, "missing", "copy.gatelab"))).rejects.toMatchObject({ code: "refused", message: expect.stringMatching(/No such folder/) });
      await mkdir(join(dir, "sub"));
      await expect(relay.receiveFile(join(dir, "sub"))).rejects.toMatchObject({ code: "refused", message: expect.stringMatching(/A folder is there/) });
      const slot = await relay.receiveFile(target);
      expect(slot.path).toMatch(/^\/save\/[A-Za-z0-9_-]+$/);
      expect(relay.pendingSaves).toBe(1);
      expect((await fetch(httpOf(relay, slot.path, "wrong"), { method: "POST", body: "x" })).status).toBe(403);
      const body = Buffer.from("{\"format\":\"gatelab-workspace\"}");
      const posted = await fetch(httpOf(relay, slot.path), { method: "POST", body, headers: { origin: "http://localhost:5173" } });
      expect(posted.status).toBe(200);
      expect(posted.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const sha256 = createHash("sha256").update(body).digest("hex");
      expect(await posted.json()).toEqual({ path: target, bytes: body.length, sha256 });
      expect(await slot.written).toEqual({ path: target, bytes: body.length, sha256 });
      expect(await readFile(target)).toEqual(body);
      // Nothing but the copy is left in the target's folder.
      expect((await readdir(dir)).sort()).toEqual(["copy.gatelab", "sub"]);
      // One upload per slot; a file there is refused unless overwrite.
      expect((await fetch(httpOf(relay, slot.path), { method: "POST", body })).status).toBe(404);
      await expect(relay.receiveFile(target)).rejects.toMatchObject({ code: "refused", message: expect.stringMatching(/overwrite/) });
      const again = await relay.receiveFile(target, { overwrite: true });
      await fetch(httpOf(relay, again.path), { method: "POST", body: "replaced" });
      expect(await readFile(target, "utf8")).toBe("replaced");
      // A cancelled slot takes no upload and tells whoever waits on it.
      const cancelled = await relay.receiveFile(join(dir, "never.gatelab"));
      cancelled.cancel();
      await expect(cancelled.written).rejects.toMatchObject({ code: "cancelled" });
      expect((await fetch(httpOf(relay, cancelled.path), { method: "POST", body })).status).toBe(404);
      expect(relay.pendingSaves).toBe(0);
    } finally {
      await relay.close();
    }
  });

  it("gatelab_save waits on the tab, which posts the copy only when the user saves", async () => {
    const relay = await startRelay({ port: 0 });
    const dir = await mkdtemp(join(tmpdir(), "gatelab-relay-"));
    let userSays = "save";
    const asked = [];
    const tab = fakeTab(relay.url, {
      answer: async (ws, message) => {
        asked.push(message.params);
        if (userSays === "save") await fetch(httpOf(relay, message.params.upload), { method: "POST", body: `copy:${message.params.kind}` });
        ws.send(JSON.stringify({ kind: "response", id: message.id, result: { outcome: userSays === "save" ? "saved" : "cancelled", revision: 4 } }));
      },
    });
    try {
      await tab.open;
      await relay.waitForTab(2000);
      const save = gatelabTools(relay).find((tool) => tool.name === "gatelab_save");
      const target = join(dir, "D1.gatelab");
      const saved = JSON.parse((await save.run({ path: target, kind: "portable" })).content[0].text);
      expect(saved).toMatchObject({ outcome: "saved", path: target, bytes: 13, kind: "portable", revision: 4 });
      expect(asked[0]).toMatchObject({ kind: "portable", target, overwrite: false, upload: expect.stringMatching(/^\/save\//) });
      expect(await readFile(target, "utf8")).toBe("copy:portable");
      // The user declines: nothing written, the slot closed.
      userSays = "cancel";
      const declined = JSON.parse((await save.run({ path: join(dir, "D2.gatelab") })).content[0].text);
      expect(declined).toEqual({ outcome: "cancelled", path: join(dir, "D2.gatelab"), revision: 4 });
      expect(asked[1].kind).toBe("linked");
      expect((await readdir(dir)).sort()).toEqual(["D1.gatelab"]);
      expect(relay.pendingSaves).toBe(0);
      // Refused before the user is asked: a file there without overwrite, a kind that is not one.
      expect((await save.run({ path: target })).isError).toBe(true);
      expect((await save.run({ path: join(dir, "D3.gatelab"), kind: "zip" })).isError).toBe(true);
      expect(asked).toHaveLength(2);
    } finally {
      tab.close();
      await relay.close();
    }
  });
});

