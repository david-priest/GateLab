// The workspace evaluator a host calls (evaluate.ts), checked in plain Node, with no DOM.
//
// On the public demonstration workspace and on a synthetic workspace of two hierarchies, every
// membership it returns is compared, event by event, with the store's own evaluation of that
// sample under that tree and with the headless runner's --membership bits; a sample gated on a
// compensated layer kept by profile reference is refused as the runner refuses it. When the embed
// build is present (npm run build:embed), the same evaluation is run from dist-embed in a plain
// node process and compared with the one made here.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { packWorkspace, packWorkspaceReference, type WorkspaceFile } from "../engine/workspace";
import { writeFcs } from "../engine/fcsExport";
import { migrateWorkspaceV2ToV3, packWorkspaceV3 } from "../engine/workspaceV3";
import { SAMPLE_ASSAY_BINDING_SCHEMA, WORKSPACE_COMPENSATION_SCHEMA } from "../engine/workspaceCompensation";
import { createCompensationBaselineProfile } from "../engine/compensationProfileRecord";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import { fileHierarchyId } from "../engine/hierarchies";
import { decodeUint8Base64 } from "../engine/encode";
import type { Gate, PopulationMap } from "../engine/models";
import { recomputeGating } from "../store";
import { gatingStateForTree, workspaceHierarchyTrees } from "../host/hostedMemberships";
import { packMembershipBits } from "../host/colDataContract";
import { fixtureFcs } from "./__fixtures__/syntheticCytobank";
import { evaluateWorkspaceArchive, type WorkspaceEvaluation } from "./evaluate";
import { openWorkspaceState } from "./workspace";
import { main } from "./cli";

const ROOT = resolve(__dirname, "../..");
const DEMO = join(ROOT, "public/demo/gatelab-demo.gatelab");
const EMBED = join(ROOT, "dist-embed/gatelab-embed.js");
const quiet = { log: () => {}, warn: () => {} };
let dir = "";

const b64 = (mask: Uint8Array) => Buffer.from(packMembershipBits(mask)).toString("base64");

/** The masks the evaluator returned, by hierarchy, population and sample: packed base64. */
function evaluatorMasks(ev: WorkspaceEvaluation): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of ev.memberships.populations) {
    for (const m of p.sampleMasks) out.set(`${p.hierarchyId}|${p.populationId}|${m.sampleId}`, m.notEvaluated ? "not evaluated" : m.membershipBitsBase64);
  }
  return out;
}

/**
 * The store's own evaluation: each sample reopened, gated with recomputeGating under every
 * hierarchy's own tree. A sample's populations in the tree it is gated under are the masks the app
 * shows for it; for a hierarchy of another family they are that tree's gates applied to it.
 */
async function storeMasks(bytes: Uint8Array, fcs: { name: string; path: string; bytes: Uint8Array }[] = []): Promise<Map<string, string>> {
  const opened = await openWorkspaceState(bytes, "store", fcs);
  const out = new Map<string, string>();
  for (const tree of workspaceHierarchyTrees(opened.state)) {
    if (!tree.root_population_id) continue;
    opened.samples.forEach((sample, index) => {
      const masks = recomputeGating(sample, gatingStateForTree(opened.state, tree)).masks;
      for (const popId of Object.keys(tree.populations)) {
        const mask = popId === tree.root_population_id ? new Uint8Array(sample.fcs.nEvents).fill(1) : masks[popId];
        out.set(`${tree.id}|${popId}|${opened.fileIds[index]}`, b64(mask));
      }
    });
  }
  return out;
}

/** The headless runner's --membership bits, by the hierarchy each file is gated under. */
function runnerBits(workspacePath: string, out: string, fcsPaths: string[] = []): Promise<{ status: number; membership?: { files: { file: string; eventCount: number; populations: { populationId: string; membershipBitsBase64: string }[] }[] }; report: { error?: string } }> {
  return main(["--gating", workspacePath, "--out", out, "--membership", "bits", ...fcsPaths], quiet).then((status) => ({
    status,
    membership: existsSync(join(out, "membership.json")) ? JSON.parse(readFileSync(join(out, "membership.json"), "utf8")) : undefined,
    report: JSON.parse(readFileSync(join(out, "report.json"), "utf8")),
  }));
}

/** The evaluator against the store and the runner, for every sample's own hierarchy. */
async function expectAgreement(ev: WorkspaceEvaluation, bytes: Uint8Array, workspacePath: string, out: string, fcsPaths: string[] = [], fcs: { name: string; path: string; bytes: Uint8Array }[] = []) {
  const got = evaluatorMasks(ev);
  const store = await storeMasks(bytes, fcs);
  // Every population of every hierarchy, for every sample: read from the tree the sample is gated
  // under where that tree is of the hierarchy's family, else with the hierarchy's own gates.
  const opened = await openWorkspaceState(bytes, "store", fcs);
  for (const [key, value] of got) {
    const [hierarchyId, , sampleId] = key.split("|");
    const index = opened.fileIds.indexOf(sampleId);
    const own = fileHierarchyId(opened.state.file_hierarchies[sampleId], opened.state.hierarchies);
    const sameFamilyCopy = own !== hierarchyId && opened.state.hierarchies.find((h) => h.id === own)?.source_hierarchy_id;
    if (!sameFamilyCopy) expect(value, `${key} (${opened.workspace.samples[index].fileName})`).toBe(store.get(key));
  }
  // Every population the store gates each sample with under its own tree, and nothing else.
  const ownKeys = [...store.keys()].filter((k) => {
    const [hierarchyId, , sampleId] = k.split("|");
    return fileHierarchyId(opened.state.file_hierarchies[sampleId], opened.state.hierarchies) === hierarchyId;
  });
  expect(ownKeys.length).toBeGreaterThan(0);
  for (const k of ownKeys) expect(got.get(k), k).toBe(store.get(k));

  const runner = await runnerBits(workspacePath, out, fcsPaths);
  expect(runner.status, runner.report.error).toBe(0);
  for (const file of runner.membership!.files) {
    const sample = ev.samples.find((s) => s.fileName === file.file)!;
    expect(file.eventCount).toBe(sample.eventCount);
    for (const p of file.populations) {
      expect(got.get(`${sample.hierarchyId}|${p.populationId}|${sample.sampleId}`), `${file.file} ${p.populationId}`).toBe(p.membershipBitsBase64);
    }
    // The runner leaves out the root; the evaluator includes it, every event of the sample.
    expect(ev.memberships.populations.filter((x) => x.hierarchyId === sample.hierarchyId).length).toBe(file.populations.length + 1);
  }
}

// ── A synthetic workspace of two hierarchies ─────────────────────────────────────────────────

const RECT = (id: string, name: string, x: string, y: string, v: [number, number][]): Gate =>
  ({ gate_id: id, name, gate_type: "rectangle", x_channel: x, y_channel: y, vertices: v, color: "#e41a1c", label_offset: null });

const POP = (id: string, name: string, parent: string | null, children: string[], gates: string[]) =>
  ({ population_id: id, name, parent_id: parent, children, gate_refs: gates.map((g) => ({ gate_id: g, include: true })), gate_logic: "and" as const, event_count: null, percent_of_parent: null });

/** D1 under "Main" (cells, then B1 and B2 by barcode), D2 under "Second" (Pd108 high only). */
function twoTreeWorkspace(): WorkspaceFile {
  const gates: Record<string, Gate> = {
    cells: RECT("cells", "Cells", "Time", "DNA", [[-1, 4], [10, 9]]),
    b1: RECT("b1", "B1", "Pd104Di", "Pd106Di", [[3, 3], [9, 9]]),
    b2: RECT("b2", "B2", "Pd104Di", "Pd108Di", [[3, 3], [9, 9]]),
  };
  const populations: PopulationMap = {
    root: POP("root", "All Events", null, ["pCells"], []),
    pCells: POP("pCells", "Cells", "root", ["pB1", "pB2"], ["cells"]),
    pB1: POP("pB1", "B1", "pCells", [], ["b1"]),
    pB2: POP("pB2", "B2", "pCells", [], ["b2"]),
  };
  const secondGates: Record<string, Gate> = { hi108: RECT("hi108", "Pd108 high", "Pd106Di", "Pd108Di", [[-2, 3], [9, 9]]) };
  const second: PopulationMap = {
    root2: POP("root2", "All Events", null, ["p108"], []),
    p108: POP("p108", "Pd108 high", "root2", [], ["hi108"]),
  };
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [
      { sampleId: "s1", fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false, hierarchyId: "main" },
      { sampleId: "s2", fileName: "D2.fcs", dataPath: "data/1_D2.fcs", logicleW: {}, compensationOn: false, hierarchyId: "second" },
    ],
    activeSample: 0,
    gating: {
      gates, gate_order: Object.keys(gates), populations, root_population_id: "root", active_population_id: "root", selected_gate_id: null,
      hierarchies: [{ id: "main", name: "Main" }, { id: "second", name: "Second" }],
      active_hierarchy_id: "main",
      stored_hierarchies: [{ id: "second", name: "Second", gates: secondGates, gate_order: ["hi108"], populations: second, root_population_id: "root2", active_population_id: "root2" }],
      perFileHierarchies: true,
    },
    scales: { globalScales: {} },
    display: { xChannel: "Time", yChannel: "DNA", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  } as WorkspaceFile;
}

// ── A flow workspace gated on a compensated layer kept by profile reference ──────────────────

function flowFcs(): Uint8Array {
  const n = 200;
  const a = Array.from({ length: n }, (_, i) => (i % 2 ? 5000 : 50));
  const b = Array.from({ length: n }, (_, i) => (i % 3 ? 4000 : 40));
  return writeFcs([a.map((_, i) => 1000 + i), a.map((_, i) => 800 + i), a, b], [
    { name: "FSC-A", desc: "" }, { name: "SSC-A", desc: "" }, { name: "A", desc: "" }, { name: "B", desc: "" },
  ], { keywords: [["$CYT", "Synthetic flow cytometer"], ["$FIL", "F1.fcs"]] });
}

async function profileReferencedWorkspace(): Promise<Uint8Array> {
  const canonical = validateAndCanonicalizeCompensationMatrix(
    { sourceChannels: ["A", "B"], receiverChannels: ["A", "B"], matrix: [[1, 0.1], [0.05, 1]] }, "flow-spillover");
  if (!canonical.ok) throw new Error("matrix");
  const profile = await createCompensationBaselineProfile({
    kind: "flow-spillover", method: "matrix-inverse", solverVersion: "flow-lu-v1",
    solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 }, matrix: canonical.value,
  }, { profileId: "p1", name: "P1", createdAt: "2026-01-01T00:00:00.000Z", origin: { type: "uploaded", fileName: "p1.csv", format: "csv", sourceColumnHeader: "channel" } });
  const v2: WorkspaceFile = {
    format: "gatelab-workspace", version: 2, savedAt: "2026-01-01T00:00:00.000Z", app: "GateLab",
    samples: [{ sampleId: "f1", fileName: "F1.fcs", dataPath: "data/0_F1.fcs", logicleW: {}, compensationOn: false, instrumentMode: "flow" }],
    activeSample: 0,
    gating: {
      gates: { g: RECT("g", "A high", "A", "B", [[1000, -1e9], [1e9, 1e9]]) }, gate_order: ["g"],
      populations: { root: POP("root", "All Events", null, ["p"], []), p: POP("p", "A high", "root", [], ["g"]) },
      root_population_id: "root", active_population_id: "root", selected_gate_id: null,
      hierarchies: [{ id: "main", name: "Main" }], active_hierarchy_id: "main", stored_hierarchies: [],
    },
    scales: { globalScales: {} },
    display: { xChannel: "A", yChannel: "B", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  } as WorkspaceFile;
  const v3 = migrateWorkspaceV2ToV3(v2);
  v3.compensation = { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [{ baselineProfileId: profile.profileId, records: [profile] }] };
  v3.samples[0].assay = {
    schema: SAMPLE_ASSAY_BINDING_SCHEMA,
    activeLayer: "compensated",
    compensatedLayer: {
      profileId: profile.profileId, profileHash: profile.profileHash, matrixHash: profile.matrixHash,
      kind: "flow-spillover", method: "matrix-inverse", includedPnns: ["A", "B"],
      channelBindings: [
        { pnn: "A", fcsColumnIndex: 2, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true },
        { pnn: "B", fcsColumnIndex: 3, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true },
      ],
      transformBinding: { kind: "flow-linear" },
    },
  };
  return packWorkspaceV3(v3, { "data/0_F1.fcs": flowFcs() });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gatelab-evaluate-"));
  writeFileSync(join(dir, "D1.fcs"), fixtureFcs("D1.fcs"));
  writeFileSync(join(dir, "D2.fcs"), fixtureFcs("D2.fcs"));
  const ws = twoTreeWorkspace();
  writeFileSync(join(dir, "two.gatelab"), packWorkspace(ws, { "data/0_D1.fcs": fixtureFcs("D1.fcs"), "data/1_D2.fcs": fixtureFcs("D2.fcs") }));
  writeFileSync(join(dir, "two-linked.gatelab"), packWorkspaceReference(ws));
});

describe("evaluateWorkspaceArchive", () => {
  it("runs with no DOM", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe("undefined");
  });

  it("evaluates the demonstration workspace as the store and the headless runner do", async () => {
    const bytes = new Uint8Array(readFileSync(DEMO));
    const ev = await evaluateWorkspaceArchive(bytes);
    expect(ev.format).toBe("gatelab-workspace-evaluation");
    expect(ev.storage).toBe("bundle");
    expect(JSON.parse(ev.workspaceJson).format).toBe("gatelab-workspace");
    expect(ev.samples.map((s) => [s.fileName, s.dataPath, s.eventCount])).toEqual(
      JSON.parse(ev.workspaceJson).samples.map((s: { fileName: string; dataPath: string }, i: number) => [s.fileName, s.dataPath, ev.samples[i].eventCount]));
    for (const s of ev.samples) {
      expect(s.eventCount).toBeGreaterThan(0);
      expect(s.refusals).toEqual([]);
      // Every channel the app offers is a column of the file, named by $PnN.
      const keyed = s.columns.filter((c) => c.key !== null);
      expect(keyed.length).toBeGreaterThan(0);
      for (const c of keyed) expect(c.fcsColumn).not.toBeNull();
      expect(s.columns.find((c) => c.pnn === "FSC-A")?.key).toBe("FSC-A");
    }
    // One hierarchy; its root holds every event of every sample.
    expect(ev.memberships.hierarchies.length).toBe(1);
    const root = ev.memberships.populations.find((p) => p.parentId === null)!;
    for (const m of root.sampleMasks) {
      const bits = decodeUint8Base64(m.membershipBitsBase64);
      const n = ev.samples.find((s) => s.sampleId === m.sampleId)!.eventCount;
      let count = 0;
      for (let i = 0; i < n; i++) count += (bits[i >> 3] >> (i & 7)) & 1;
      expect(count).toBe(n);
    }
    await expectAgreement(ev, bytes, DEMO, join(dir, "demo"));
  });

  it("evaluates every population of every hierarchy for every sample, portable or linked", async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, "two.gatelab")));
    const ev = await evaluateWorkspaceArchive(bytes);
    expect(ev.memberships.hierarchies.map((h) => h.name)).toEqual(["Main", "Second"]);
    expect(ev.samples.map((s) => [s.sampleId, s.hierarchyId])).toEqual([["s1", "main"], ["s2", "second"]]);
    // Main's 4 populations and Second's 2, each over both samples.
    expect(ev.memberships.populations.length).toBe(6);
    for (const p of ev.memberships.populations) expect(p.sampleMasks.map((m) => m.sampleId)).toEqual(["s1", "s2"]);
    expect(ev.samples[0].columns.find((c) => c.pnn === "Ir191Di")).toMatchObject({ key: "DNA", pns: "DNA", fcsColumn: 2 });
    await expectAgreement(ev, bytes, join(dir, "two.gatelab"), join(dir, "two"));

    // The same workspace linked, with its FCS files given: the same answer.
    const linkedBytes = new Uint8Array(readFileSync(join(dir, "two-linked.gatelab")));
    const fcs = ["D2.fcs", "D1.fcs"].map((name) => ({ name, path: join(dir, name), bytes: new Uint8Array(readFileSync(join(dir, name))) }));
    const linked = await evaluateWorkspaceArchive({ workspace: linkedBytes, fcs });
    expect(linked.storage).toBe("reference");
    expect(linked.memberships).toEqual(ev.memberships);
    // And from the workspace JSON as text.
    const fromText = await evaluateWorkspaceArchive({ workspace: new TextDecoder().decode(linkedBytes), fcs });
    expect(fromText.memberships).toEqual(ev.memberships);
  });

  it("refuses a linked workspace whose files are not all given, with the runner's message", async () => {
    const linkedBytes = new Uint8Array(readFileSync(join(dir, "two-linked.gatelab")));
    const fcs = [{ name: "D1.fcs", bytes: new Uint8Array(readFileSync(join(dir, "D1.fcs"))) }];
    await expect(evaluateWorkspaceArchive({ workspace: linkedBytes, fcs })).rejects.toThrow(/D2\.fcs: not among the FCS files given/);
  });

  it("refuses a sample gated on a compensated layer kept by profile reference, as the headless runner refuses it", async () => {
    const bytes = await profileReferencedWorkspace();
    const path = join(dir, "profile.gatelab");
    writeFileSync(path, bytes);
    const runner = await runnerBits(path, join(dir, "profile"));
    expect(runner.status).toBe(1);
    expect(runner.report.error).toMatch(/gates F1\.fcs on a compensated layer kept by reference to a compensation profile/);
    let message = "";
    try {
      await evaluateWorkspaceArchive({ workspace: bytes, path });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe(runner.report.error);
  });

  it.runIf(existsSync(EMBED))("gives the same evaluation from the embed build, in a plain node process", async () => {
    const script = join(dir, "evaluate-embed.mjs");
    writeFileSync(script, [
      'import { readFileSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      "const [bundle, file] = process.argv.slice(2);",
      "const core = await import(pathToFileURL(bundle).href);",
      "if (typeof globalThis.document !== 'undefined' || typeof globalThis.DOMParser !== 'undefined') throw new Error('a DOM is present');",
      "const ev = await core.evaluateWorkspaceArchive(new Uint8Array(readFileSync(file)));",
      "process.stdout.write(JSON.stringify(ev));",
    ].join("\n"));
    for (const file of [DEMO, join(dir, "two.gatelab")]) {
      const out = execFileSync(process.execPath, [script, EMBED, file], { encoding: "utf8", maxBuffer: 1 << 28 });
      const fromBundle = JSON.parse(out) as WorkspaceEvaluation;
      const here = await evaluateWorkspaceArchive(new Uint8Array(readFileSync(file)));
      expect(fromBundle).toEqual(JSON.parse(JSON.stringify(here)));
    }
  });
});
