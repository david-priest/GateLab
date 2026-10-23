#!/usr/bin/env node
// Deterministic hosted-workspace replay through the shipped MCP and relay, without a live R session.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { createServer } from "vite";
import { startRelay } from "./relay.mjs";
import { serveMcp } from "./mcp.mjs";
import { gatelabTools } from "./tools.mjs";
import { auditTools, MCP_VERSION } from "./audit.mjs";
import { sha256 } from "./feedback.mjs";

const buffer = (value) => { const b = Buffer.from(value, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const insist = (ok, message) => { if (!ok) throw new Error(message); };

export async function replay({ inputPath, out }) {
  const text = await readFile(inputPath, "utf8"), input = JSON.parse(text);
  insist(input.format === "gatelab-hosted-replay" && input.version === 1, "Expected gatelab-hosted-replay version 1.");
  // Fresh output directory: do not overwrite a previous run's evidence.
  await mkdir(out);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const sourceRevision = execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  const sourceDirty = !!execFileSync("git",["-C",root,"status","--porcelain","--untracked-files=normal"],{encoding:"utf8"}).trim();
  // Do not load application config: it resolves renderer paths relative to the caller's cwd.
  // This runner needs Vite's TypeScript/asset loader only, with an explicit source root.
  const vite = await createServer({ root, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: "custom" });
  let relay, socket;
  try {
    const [{ loadHostedDataset }, { createAgentHandler }, { coreReducer, initialCoreState, recomputeGating }, { workspaceHierarchyTrees, gatingStateForTree }, { fileHierarchyId, referencedGateIds }] = await Promise.all([
      vite.ssrLoadModule("/src/host/hostedSample.ts"), vite.ssrLoadModule("/src/agent/handler.ts"), vite.ssrLoadModule("/src/store.ts"),
      vite.ssrLoadModule("/src/host/hostedMemberships.ts"), vite.ssrLoadModule("/src/engine/hierarchies.ts"),
    ]);
    const entries = await loadHostedDataset({
      readAssay: async (_dataset, sampleId) => buffer(input.payloads[sampleId].assay),
      readEventIndex: async (_dataset, sampleId) => buffer(input.payloads[sampleId].eventIndex),
    }, input.dataset);
    // The workspace as the app's hosted open restores it (App.tsx): every hierarchy, each parked one
    // with its own gates, and each sample's hierarchy and group by position, since the SCE's sample
    // order is the workspace's. perFileHierarchies is a flag, not the assignments; with it off every
    // file is on the first tree.
    const restoreStored = (h, shared) => h.gates
      ? { ...h, gate_order: h.gate_order ?? Object.keys(h.gates), selected_pop_ids: [] }
      : (() => { const gates = Object.fromEntries([...referencedGateIds(h.populations)].filter((id) => shared[id]).map((id) => [id, shared[id]])); return { ...h, gates, gate_order: Object.keys(gates), selected_pop_ids: [] }; })();
    const restore = (ws) => {
      const g = ws.gating, saved = Array.isArray(ws.samples) && ws.samples.length === entries.length ? ws.samples : null;
      const byPosition = (key) => saved ? Object.fromEntries(saved.flatMap((s, i) => (s[key] ? [[entries[i].sampleId, s[key]]] : []))) : {};
      return coreReducer(initialCoreState(), {
        type: "loadWorkspace", gates: g.gates, gate_order: g.gate_order, populations: g.populations,
        root_population_id: g.root_population_id, active_population_id: g.active_population_id, selected_gate_id: g.selected_gate_id,
        hierarchies: g.hierarchies, active_hierarchy_id: g.active_hierarchy_id,
        stored_hierarchies: g.stored_hierarchies?.map((h) => restoreStored(h, g.gates)),
        file_hierarchies: g.perFileHierarchies === true ? byPosition("hierarchyId") : {},
        groups: g.groups ?? [], file_groups: byPosition("groupId"),
      });
    };
    let state = restore(input.workspace);
    const info = { app: "GateLab replay", version: JSON.parse(await readFile(join(root,"package.json"),"utf8")).version, host: "sce", workspaceName: input.dataset.label };
    const gatingCache = new Map();
    const handler = createAgentHandler({
      info: () => info, state: () => state,
      context: () => ({ assay: { id: input.dataset.defaultAssayId, space: input.dataset.assays.find((a) => a.id === input.dataset.defaultAssayId).coordinateSpace }, plot: { pooled: true, sampleIds: entries.map((s) => s.sampleId) }, populationCountScope: "all-loaded-samples", gateCountScope: "geometry-within-active-population" }),
      // Each sample under the tree it is gated under, as the app's agent adapter gives it.
      samples: () => { const trees = workspaceHierarchyTrees(state); return entries.map((s) => {
        const hierarchyId = fileHierarchyId(state.file_hierarchies[s.sampleId], state.hierarchies);
        return { id: s.sampleId, name: s.name, sample: s.sample, metadata: Object.fromEntries(Object.entries(s.metadata).map(([k,v]) => [k,String(v)])), viewed: s.sampleId === entries[0].sampleId, checked: true, hierarchyId, gating: () => {
          const cached = gatingCache.get(s.sampleId); if (cached?.state === state) return cached.value;
          const tree = trees.find((t) => t.id === hierarchyId);
          const value = tree && !tree.active ? recomputeGating(s.sample, gatingStateForTree(state, tree)) : recomputeGating(s.sample, state);
          gatingCache.set(s.sampleId,{state,value}); return value;
        } };
      }); },
      dispatch: (action) => { state = coreReducer(state,action); }, settled: async () => {},
      view: () => ({ populationId: state.active_population_id, sampleId: entries[0].sampleId, x: entries[0].sample.channels[0].key, y: entries[0].sample.channels[1].key, tab: "gating", ranges: { x: null, y: null } }),
      workspaceJson: () => JSON.stringify({ ...input.workspace, gating: { ...input.workspace.gating, gates: state.gates, gate_order: state.gate_order, populations: state.populations } }),
      setView: async () => { throw new Error("Replay is read-only."); }, render: async () => { throw new Error("Replay does not render a browser plot."); }, fit: () => {}, setAxisRange: () => {}, clearPan: () => {}, reload: () => {},
    });
    relay = await startRelay({ port: 0, writer: "replay" });
    socket = new WebSocket(relay.url);
    socket.on("message", async (data) => { const msg = JSON.parse(String(data)); if (msg.kind === "hello") handler.setWriter(msg.writer); if (msg.kind === "request") socket.send(JSON.stringify(await handler.handle(msg))); });
    await new Promise((ok,bad) => { socket.once("open",ok); socket.once("error",bad); });
    socket.send(JSON.stringify({ kind: "hello", protocol: 1, info }));
    await relay.waitForTab(2000);
    const inputStream = new PassThrough(), outputStream = new PassThrough(), pending = new Map();
    let counter = 0, accumulated = "";
    outputStream.on("data", (chunk) => { accumulated += String(chunk); let end; while ((end = accumulated.indexOf("\n")) >= 0) { const row = JSON.parse(accumulated.slice(0,end)); accumulated = accumulated.slice(end+1); pending.get(row.id)?.(row); pending.delete(row.id); } });
    // Only reads are exposed in this deterministic runner. Live apply remains available in server.mjs.
    const tools = gatelabTools(relay).filter((t) => ["gatelab_context","gatelab_describe","gatelab_evaluate","gatelab_export"].includes(t.name));
    serveMcp({ name: "gatelab", version: MCP_VERSION, tools: await auditTools(tools,{ path: join(out,"mcp.jsonl"), writer: "replay" }), input: inputStream, output: outputStream });
    const call = (name,args = {}) => new Promise((ok,bad) => { const id = ++counter; const timer = setTimeout(() => { pending.delete(id); bad(new Error(`Timed out: ${name}`)); },120000); pending.set(id,(row) => { clearTimeout(timer); if (row.error || row.result.isError) bad(new Error(row.error?.message ?? row.result.content[0].text)); else ok(JSON.parse(row.result.content[0].text)); }); inputStream.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n"); });
    const context = await call("gatelab_context");
    await call("gatelab_export",{ path: join(out,"export.json") });
    const exported = JSON.parse(await readFile(join(out,"export.json"),"utf8"));
    const compare = (actual,expected) => expected.flatMap((p) => p.sampleMasks.map((m) => {
      const matches = actual.filter((a) => a.id === p.id);
      insist(matches.length === 1, `Missing population ${p.id}.`);
      const masks = matches[0].sampleMasks.filter((a) => a.sampleId === m.sampleId);
      insist(masks.length === 1 && masks[0].eventCount === m.eventCount, "Sample membership identity differs.");
      const a = Buffer.from(masks[0].membershipBitsBase64,"base64"), b = Buffer.from(m.membershipBitsBase64,"base64");
      insist(a.length === b.length, "Membership length differs.");
      let disagreements = 0;
      for (let i = 0; i < m.eventCount; i++) disagreements += ((a[i >> 3] ^ b[i >> 3]) >> (i % 8)) & 1;
      return { populationId: p.id, sampleId: m.sampleId, events: m.eventCount, disagreements };
    }));
    const concordance = compare(exported.populations,input.expectedMemberships.populations);
    state = restore(exported.workspace);
    await call("gatelab_export",{ path: join(out,"reopened.json") });
    const reopened = JSON.parse(await readFile(join(out,"reopened.json"),"utf8"));
    const persistence = compare(reopened.populations,exported.populations);
    const feedback = [];
    for (const [i,r] of (input.references ?? []).entries()) {
      const referencePath = join(out,`reference-${i}.json`);
      await writeFile(referencePath,JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: r.label, eventOrder: "as-loaded", sampleManifestSha256: context.sampleManifestSha256, sampleMasks: r.sampleMasks }));
      feedback.push(await call("gatelab_evaluate",{ referencePath, populationIds: r.populationIds, sampleIds: entries.map((s) => s.sampleId), ...(input.groupBy ? { groupBy: input.groupBy } : {}) }));
    }
    const report = { format: "gatelab-mcp-replay", version: 1, sourceRevision, sourceDirty, inputSha256: sha256(text), mcpVersion: MCP_VERSION, mode: "headless hosted adapter through MCP, relay and handler; no browser or R write-back", context, concordance, persistence, feedback };
    await writeFile(join(out,"report.json"),JSON.stringify(report,null,1));
    insist(concordance.every((r) => r.disagreements === 0) && persistence.every((r) => r.disagreements === 0), "Replay differs; inspect report.json.");
    inputStream.end(); outputStream.end();
    return report;
  } finally {
    if (socket) socket.close();
    if (relay) await relay.close();
    await vite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const inputPath = args[args.indexOf("--input") + 1], out = args[args.indexOf("--out") + 1];
  if (!args.includes("--input") || !args.includes("--out")) throw new Error("Usage: node replay.mjs --input <hosted-replay.json> --out <fresh-directory>");
  const report = await replay({ inputPath: resolve(inputPath), out: resolve(out) });
  console.log(JSON.stringify({ report: join(resolve(out),"report.json"), samplePopulationPairs: report.concordance.length, disagreements: report.concordance.reduce((n,r) => n+r.disagreements,0), persistenceDisagreements: report.persistence.reduce((n,r) => n+r.disagreements,0) }));
}
