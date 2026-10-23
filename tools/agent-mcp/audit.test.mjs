import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTools } from "./audit.mjs";

it("serializes multi-request tools even when logging is disabled", async () => {
  const events = [];
  let release, started;
  const held = new Promise((r) => { release = r; });
  const reading = new Promise((r) => { started = r; });
  const tools = await auditTools([{ name: "read", run: async () => { events.push("read start"); started(); await held; events.push("read end"); return { content: [] }; } }, { name: "apply", run: async () => { events.push("apply"); return { content: [] }; } }]);
  const a = tools[0].run({}), b = tools[1].run({});
  await reading;
  expect(events).toEqual(["read start"]);
  release(); await Promise.all([a,b]);
  expect(events).toEqual(["read start","read end","apply"]);
});
it("answers status and guide while a wait_for_change is pending, and still queues the rest", async () => {
  const events = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const tools = await auditTools([
    { name: "gatelab_wait_for_change", run: async () => { events.push("wait start"); await held; events.push("wait end"); return { content: [] }; } },
    { name: "gatelab_status", run: async () => { events.push("status"); return { content: [] }; } },
    { name: "read", run: async () => { events.push("read"); return { content: [] }; } },
  ]);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const waiting = byName.gatelab_wait_for_change.run({});
  await byName.gatelab_status.run({});
  await byName.read.run({});
  expect(events).toEqual(["wait start", "status", "read"]);
  release(); await waiting;
  expect(events).toEqual(["wait start", "status", "read", "wait end"]);
});
it("records unknown model separately from the writer and hashes image pixels", async () => {
  const dir = await mkdtemp(join(tmpdir(),"gatelab-audit-")), path = join(dir,"audit.jsonl");
  const tools = await auditTools([{ name: "render", run: async () => ({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }) }],{ path, writer: "test-agent" });
  await tools[0].run({});
  const rows = (await readFile(path,"utf8")).trim().split("\n").map(JSON.parse);
  expect(rows[0]).toMatchObject({ declaredModel: null, modelIdentitySource: "unknown", writer: "test-agent" });
  expect(rows[2].result.content[0]).toMatchObject({ type: "image", sha256: expect.any(String) });
  expect(rows[2].result.content[0].data).toBeUndefined();
});
it("does not repeat a successful apply when its response audit cannot be written", async () => {
  const dir = await mkdtemp(join(tmpdir(),"gatelab-audit-")), path = join(dir,"audit.jsonl");
  let applied = 0;
  const tools = await auditTools([{ name: "apply", run: async () => { applied++; await rename(path,join(dir,"retained.jsonl")); await mkdir(path); return { content: [{ type: "text", text: '{"created":true}' }] }; } }],{path,writer:"test-agent"});
  const result = await tools[0].run({});
  expect(applied).toBe(1);
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain('"created":true');
  expect(result.content[1].text).toContain("before retrying");
  await expect(tools[0].run({})).rejects.toThrow();
  expect(applied).toBe(1);
});
