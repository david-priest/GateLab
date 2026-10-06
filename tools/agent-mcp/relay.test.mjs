// The relay with a stand-in tab on a real socket, and the MCP framing over in-memory streams.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import WebSocket from "ws";
import { serveMcp } from "./mcp.mjs";
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
      expect(names).toEqual(["gatelab_guide", "gatelab_status", "gatelab_describe", "gatelab_distribution", "gatelab_stats", "gatelab_preview", "gatelab_apply", "gatelab_view", "gatelab_render", "gatelab_wait_for_change", "gatelab_reload", "gatelab_export"]);
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
