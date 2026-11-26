// A GateLabR session saved as a portable .gatelab (hostedPortableCopy.ts), gated and counted.
//
// Each case builds a hosted dataset the way the app does (loadHostedDataset over a synthetic R
// host), gates it through the store's own actions, writes the copy, and reopens it through the
// standalone open path (the headless runner's openWorkspace, which takes App.tsx's steps): every
// population of every sample must hold the same events, event by event, as the live session, and
// the counts must be the ones the synthetic events were made to give. Synthetic samples D1 and
// D2 and made-up channels throughout; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { parseFcs } from "./engine/fcs";
import { exportPopulationFcs } from "./engine/fcsExport";
import { cloneHierarchyTree, fileHierarchyId, storeHierarchy, type StoredHierarchy } from "./engine/hierarchies";
import { decodeUint8Base64 } from "./engine/encode";
import type { WorkspaceFile } from "./engine/workspace";
import type { TransformSpec } from "./engine/models";
import { coreReducer, initialCoreState, recomputeGating, type CoreState } from "./store";
import { loadHostedDataset, type GateLabHostedSample } from "./host/hostedSample";
import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostChannelDescriptor,
  type GateLabHostDatasetDescriptor,
} from "./host/datasetContract";
import { buildHostedMemberships, gatingStateForTree, type HierarchyTree } from "./host/hostedMemberships";
import type { GateLabHostWorkspaceMemberships } from "./host/workspaceContract";
import { workspaceGatingRecord, workspaceSampleRecord } from "./workspaceRecords";
import { CompensationManager } from "./engine/compensationManager";
import { createCompensationBaselineProfile } from "./engine/compensationProfileRecord";
import { validateAndCanonicalizeCompensationMatrix } from "./engine/compensationProfile";
import { packWorkspaceV3, type WorkspaceFileV3 } from "./engine/workspaceV3";
import { SAMPLE_ASSAY_BINDING_SCHEMA, WORKSPACE_COMPENSATION_SCHEMA } from "./engine/workspaceCompensation";
import { authoritativeRProfile } from "./host/compensationContract";
import { openWorkspace } from "./headless/workspace";
import { memberships } from "./headless/headless";
import { buildHostedPortableCopy, HostedPortableCopyRefused, type HostedPortableCopy } from "./hostedPortableCopy";

const N = 60;
const ASINH150: TransformSpec = { kind: "asinh", cofactor: 150 };

// ── The synthetic R host ─────────────────────────────────────────────────────────────────────

interface EventClass { cell: boolean; a: boolean; b: boolean; c: boolean; d: boolean }

/** The class each event of a sample was made in: debris or cell, and four markers on or off. */
function classes(): EventClass[] {
  return Array.from({ length: N }, (_, i) => ({ cell: i % 5 !== 0, a: i % 2 === 0, b: i % 3 === 0, c: i % 4 < 2, d: i % 7 < 3 }));
}

/** Linear values of one sample, channel-major, from its classes. D2's cells sit at a higher FSC. */
function linearValues(sampleIndex: number, channels: number): Float32Array[] {
  const ev = classes();
  const fsc = (e: EventClass, i: number) => (e.cell ? (sampleIndex === 1 ? 80_000 : 50_000) : 5_000) + i * 3;
  const cols: number[][] = [
    ev.map(fsc),
    ev.map((e, i) => (e.cell ? 30_000 : 2_000) + i * 5),
    ev.map((e, i) => (e.a ? 5_000 : 50) + i),
    ev.map((e, i) => (e.b ? 4_000 : 30) + i),
    ev.map((e, i) => (e.c ? 3_000 : 20) + i),
    ev.map((e, i) => (e.d ? 6_000 : 40) + i),
  ];
  while (cols.length < channels) cols.push(ev.map((_, i) => 10 + i));
  return cols.slice(0, channels).map((c) => Float32Array.from(c));
}

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength) as ArrayBuffer;
}

interface HostSpec {
  instrument: "flow" | "cytof";
  channels: GateLabHostChannelDescriptor[];
  /** Linear values per sample, channel-major; a display assay is derived from them. */
  values?: (sampleIndex: number) => Float32Array[];
  display?: { cofactor: number };
  compensationMatrix?: GateLabHostDatasetDescriptor["compensationMatrix"];
}

/** A dataset of two samples, D1 and D2, served the way GateLabR's host serves one. */
async function hostedSamples(spec: HostSpec): Promise<{ dataset: GateLabHostDatasetDescriptor; hosted: GateLabHostedSample[] }> {
  const values = spec.values ?? ((i: number) => linearValues(i, spec.channels.length));
  const dataset: GateLabHostDatasetDescriptor = {
    contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
    id: "sce",
    label: "Synthetic SCE",
    instrument: spec.instrument,
    eventCount: 2 * N,
    channels: spec.channels,
    assays: [
      { id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" },
      ...(spec.display
        ? [{ id: "exprs", label: "exprs", role: "transformed" as const, coordinateSpace: "display" as const, revision: 0, encoding: "channel-major-float32-le" as const, displayCofactor: spec.display.cofactor }]
        : []),
    ],
    defaultAssayId: spec.display ? "exprs" : "counts",
    samples: ["D1", "D2"].map((label, index) => ({
      id: `sample-${index}`, label, eventCount: N, metadata: { donor: label },
      assayByteLength: spec.channels.length * N * 4, eventIndexEncoding: "uint32-le" as const, eventIndexByteLength: N * 4,
    })),
    ...(spec.compensationMatrix ? { compensationMatrix: spec.compensationMatrix } : {}),
  };
  const port = {
    async listDatasets() { return [dataset]; },
    async readAssay(_d: string, sampleId: string, assayId: string) {
      const linear = values(sampleId === "sample-0" ? 0 : 1);
      const cols = assayId === "exprs" ? linear.map((c) => Float32Array.from(c, (v) => Math.asinh(v / spec.display!.cofactor))) : linear;
      const out = new Float32Array(cols.length * N);
      cols.forEach((c, i) => out.set(c, i * N));
      return bufferOf(out);
    },
    async readEventIndex(_d: string, sampleId: string) {
      const offset = sampleId === "sample-0" ? 0 : N;
      return bufferOf(Uint32Array.from({ length: N }, (_, i) => i + offset));
    },
  };
  return { dataset, hosted: await loadHostedDataset(port, dataset) };
}

// ── A session: gates through the store's actions, the workspace as the app builds it ────────

interface Session {
  state: CoreState;
  hosted: GateLabHostedSample[];
  entryIds: string[];
  workspace: WorkspaceFile;
  live: GateLabHostWorkspaceMemberships;
}

const popId = (state: CoreState, name: string) => Object.values(state.populations).find((p) => p.name === name)!.population_id;

function session(hosted: GateLabHostedSample[], build: (state: CoreState, entryIds: string[]) => CoreState, extra: Partial<WorkspaceFile> = {}): Session {
  const entryIds = hosted.map((h) => `${h.datasetId}:${h.sampleId}`);
  const state = build(coreReducer(initialCoreState(), { type: "loadSample", nEvents: N }), entryIds);
  const workspace: WorkspaceFile = {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "synthetic-session",
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab test",
    hostedAssayId: hosted[0].assayId,
    hostedChannelTransforms: Object.fromEntries(hosted[0].sample.channels.map((c) => [c.key, hosted[0].sample.transformSpec(c.key)])),
    samples: hosted.map((h, i) => workspaceSampleRecord({ id: entryIds[i], name: h.name, sample: h.sample }, i, {
      metadata: { donor: h.name },
      hierarchyId: state.file_hierarchies[entryIds[i]],
      groupId: state.file_groups[entryIds[i]],
      compensationPending: false,
    })),
    activeSample: 0,
    gating: workspaceGatingRecord(state),
    scales: { globalScales: {}, lockBetweenFiles: true, perSampleGlobalScales: {} },
    display: { xChannel: hosted[0].sample.channels[0].key, yChannel: hosted[0].sample.channels[1].key, mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
    ...extra,
  };
  const live = buildHostedMemberships(state, hosted.map((h, i) => ({
    sampleId: h.sampleId,
    eventCount: N,
    name: h.name,
    hierarchyId: fileHierarchyId(state.file_hierarchies[entryIds[i]], state.hierarchies),
    gatingFor: (tree: HierarchyTree) => recomputeGating(h.sample, gatingStateForTree(state, tree)),
  })));
  return { state, hosted, entryIds, workspace, live };
}

async function copyOf(s: Session, live = s.live): Promise<HostedPortableCopy> {
  let n = 0;
  return buildHostedPortableCopy({
    workspace: s.workspace,
    samples: s.hosted.map((h, i) => ({ entryId: s.entryIds[i], hostSampleId: h.sampleId, name: h.name, sample: h.sample })),
    live,
    newSampleId: () => `copy-${++n}`,
  });
}

const bits = (b64: string) => {
  const packed = decodeUint8Base64(b64);
  return Uint8Array.from({ length: N }, (_, i) => (packed[i >> 3] >> (i & 7)) & 1);
};

/** The live session's mask of a population, by name, for a sample, read in the tree the sample is gated under. */
function liveMask(s: Session, sampleIndex: number, name: string): Uint8Array {
  const own = fileHierarchyId(s.state.file_hierarchies[s.entryIds[sampleIndex]], s.state.hierarchies);
  const p = s.live.populations.find((x) => x.hierarchyId === own && x.populationName === name)!;
  return bits(p.sampleMasks.find((m) => m.sampleId === s.hosted[sampleIndex].sampleId)!.membershipBitsBase64);
}

const count = (mask: ArrayLike<number>) => Array.from(mask).reduce((a, b) => a + (b ? 1 : 0), 0);

/**
 * The copy reopened through the standalone open path: each file under the tree it is gated under,
 * every population's mask by name. Every one must equal the live session's, event by event.
 */
async function expectSameGating(s: Session, copy: HostedPortableCopy): Promise<Record<string, Record<string, number>>> {
  const files = await openWorkspace(copy.bytes, "copy.gatelab", []);
  expect(files.map((f) => f.file)).toEqual(s.hosted.map((h) => `${h.name}.fcs`));
  const counts: Record<string, Record<string, number>> = {};
  files.forEach((f, index) => {
    const masks = memberships(f);
    counts[s.hosted[index].name] = {};
    for (const p of Object.values(f.tree.populations)) {
      if (p.population_id === f.tree.root_population_id) continue;
      const reopened = Uint8Array.from(masks[p.population_id], (v) => (v ? 1 : 0));
      expect(Array.from(reopened), `${f.file}: ${p.name}`).toEqual(Array.from(liveMask(s, index, p.name)));
      counts[s.hosted[index].name][p.name] = count(reopened);
    }
  });
  return counts;
}

/** A hosted sample's original values as FCS, as the app's export writes them. */
function exportFcsOf(h: GateLabHostedSample): Uint8Array {
  return exportPopulationFcs(h.sample, null, "original");
}

function workspaceIn(copy: HostedPortableCopy): Record<string, any> {
  return JSON.parse(strFromU8(unzipSync(copy.bytes)["workspace.json"]));
}

// ── The cases ────────────────────────────────────────────────────────────────────────────────

/** Flow, channel ids equal to $PnN with markers in $PnS: the standalone keys are the markers. */
const FLOW_CHANNELS: GateLabHostChannelDescriptor[] = [
  { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
  { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
  { id: "FITC-A", label: "CD3", pnn: "FITC-A", pns: "CD3" },
  { id: "PE-A", label: "CD19", pnn: "PE-A", pns: "CD19" },
  { id: "APC-A", label: "CD4", pnn: "APC-A", pns: "CD4" },
  { id: "BV421-A", label: "CD8", pnn: "BV421-A", pns: "CD8" },
];

/** Cells (rectangle), A+B- (polygon on an arcsinh display) and its NOT, and a quadrant on C and D. */
function flowGating(state: CoreState, channels = ["FSC-A", "SSC-A", "FITC-A", "PE-A", "APC-A", "BV421-A"]): CoreState {
  const [fsc, ssc, a, b, c, d] = channels;
  const root = state.active_population_id!;
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", gateId: "g-cells", name: "Cells", xChannel: fsc, yChannel: ssc,
    vertices: [[20_000, 10_000], [70_000, 60_000]], space: "raw", createPop: { name: "Cells", parentId: root } });
  const cells = popId(state, "Cells");
  state = coreReducer(state, { type: "addGate", gateType: "polygon", gateId: "g-ab", name: "A+B-", xChannel: a, yChannel: b,
    vertices: [[2.5, -1], [6, -1], [6, 1.5], [2.5, 1.5]], space: "display", transforms: { [a]: ASINH150, [b]: ASINH150 },
    createPop: { name: "A+B-", parentId: cells, notName: "not A+B-" } });
  state = coreReducer(state, { type: "addQuadrant", xChannel: c, yChannel: d, center: [1_000, 1_000], prefix: "Q", parentId: cells, space: "raw",
    names: ["C-D+", "C+D+", "C+D-", "C-D-"] });
  return state;
}

/** D2 (the second entry) tailors the Cells rectangle in its own copy of the tree, as the switch does. */
function tailorCellsForSecond(state: CoreState, entryIds: string[]): CoreState {
  const template = storeHierarchy(state.hierarchies[0], state);
  const c = cloneHierarchyTree(template.populations, template.root_population_id!, template.gates, template.gate_order);
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
  const copy: StoredHierarchy = {
    id: "copy-d2", name: "D2 · Main", owner_sample_id: entryIds[1], structure_locked: true, source_hierarchy_id: state.hierarchies[0].id,
    source_gate_ids: invert(c.gateIdMap), source_population_ids: invert(c.idMap),
    gates: c.gates, gate_order: c.gate_order, populations: c.populations, root_population_id: c.root_population_id,
    active_population_id: c.root_population_id, selected_pop_ids: [],
  };
  state = coreReducer(state, { type: "addHierarchyCopies", copies: [copy], activeHierarchyId: state.hierarchies[0].id, assignments: { [entryIds[0]]: state.hierarchies[0].id, [entryIds[1]]: "copy-d2" } });
  state = coreReducer(state, { type: "setGateTailored", fileId: entryIds[1], gateId: "g-cells", on: true });
  const copyCells = c.gateIdMap["g-cells"];
  return coreReducer(state, { type: "editGateIn", hierarchyId: "copy-d2", edit: { type: "editGate", gateId: copyCells, vertices: [[60_000, 10_000], [100_000, 60_000]] } });
}

/** Counts the synthetic classes give under flowGating, with D2 under its tailored Cells. */
function expectedFlowCounts(): Record<string, number> {
  const ev = classes().filter((e) => e.cell);
  const n = (f: (e: EventClass) => boolean) => ev.filter(f).length;
  return {
    "Cells": ev.length,
    "A+B-": n((e) => e.a && !e.b),
    "not A+B-": n((e) => !(e.a && !e.b)),
    "C-D+": n((e) => !e.c && e.d), "C+D+": n((e) => e.c && e.d), "C+D-": n((e) => e.c && !e.d), "C-D-": n((e) => !e.c && !e.d),
  };
}

describe("Save Portable Copy from a hosted session", () => {
  it("draws a rectangle, a polygon, a quadrant, a NOT and a tailored gate, and the reopened copy gates every event as the session did", async () => {
    const { hosted } = await hostedSamples({ instrument: "flow", channels: FLOW_CHANNELS });
    const s = session(hosted, (state, ids) => tailorCellsForSecond(flowGating(state), ids), {
      scales: { globalScales: { "FITC-A": [0, 6] }, lockBetweenFiles: true, perSampleGlobalScales: { "sce:sample-1": { "PE-A": [0, 5] } } },
      display: { xChannel: "FITC-A", yChannel: "PE-A", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
    });
    // The gates hold the events they were drawn around, in the session.
    const expected = expectedFlowCounts();
    for (const index of [0, 1]) {
      for (const [name, n] of Object.entries(expected)) expect(count(liveMask(s, index, name)), `${hosted[index].name}: ${name}`).toBe(n);
    }
    // Under the tree's rectangle D2's cells, at a higher FSC, would be outside: the tailoring matters.
    expect(count(recomputeGating(hosted[1].sample, s.state).masks[popId(s.state, "Cells")])).toBe(0);

    const copy = await copyOf(s);
    const counts = await expectSameGating(s, copy);
    expect(counts).toEqual({ D1: expected, D2: expected });
    expect(copy.checked).toEqual({ samples: 2, populations: s.live.populations.length, events: s.live.populations.length * 2 * N });

    // Keys and ids restated wherever the workspace names them; the hosted-only fields gone.
    expect(copy.channelKeys).toEqual({ "FITC-A": "CD3", "PE-A": "CD19", "APC-A": "CD4", "BV421-A": "CD8" });
    expect(copy.sampleIds).toEqual({ "sce:sample-0": "copy-1", "sce:sample-1": "copy-2" });
    const ws = workspaceIn(copy);
    expect(ws.hostedAssayId).toBeUndefined();
    expect(ws.hostedChannelTransforms).toBeUndefined();
    expect(ws.samples.map((x: any) => [x.sampleId, x.fileName, x.dataPath, x.instrumentMode, x.compensationOn, x.hierarchyId ?? null]))
      .toEqual([["copy-1", "D1.fcs", "data/0_D1.fcs", "flow", false, "main"], ["copy-2", "D2.fcs", "data/1_D2.fcs", "flow", false, "copy-d2"]]);
    expect(ws.gating.gates["g-ab"]).toMatchObject({ x_channel: "CD3", y_channel: "CD19", transforms: { CD3: ASINH150, CD19: ASINH150 } });
    const storedCopy = ws.gating.stored_hierarchies.find((h: any) => h.id === "copy-d2");
    expect(Object.values(storedCopy.gates).map((g: any) => g.x_channel).sort()).toEqual(["APC-A", "CD3", "FSC-A"].map((k) => copy.channelKeys[k] ?? k).sort());
    expect(ws.gating.hierarchies.find((h: any) => h.id === "copy-d2").owner_sample_id).toBe("copy-2");
    expect(ws.scales.globalScales).toEqual({ CD3: [0, 6] });
    expect(ws.scales.perSampleGlobalScales).toEqual({ "copy-2": { CD19: [0, 5] } });
    expect([ws.display.xChannel, ws.display.yChannel]).toEqual(["CD3", "CD19"]);
    expect(JSON.stringify(ws)).not.toMatch(/sce:sample-/);
  });

  it("writes the values the app drew for a display assay, put back through its cofactor, and the copy gates as the session did", async () => {
    const channels: GateLabHostChannelDescriptor[] = [
      { id: "Time", label: "Time", pnn: "Time" },
      { id: "DNA", label: "DNA", pnn: "Ir191Di", pns: "DNA" },
      { id: "CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" },
      { id: "CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
    ];
    const values = (i: number) => {
      const ev = classes();
      return [
        Float32Array.from(ev, (_, k) => 100 + k + i * N),
        Float32Array.from(ev, (e, k) => (e.cell ? 500 : 5) + k),
        Float32Array.from(ev, (e, k) => (e.a ? 200 : 2) + k / 10),
        Float32Array.from(ev, (e, k) => (e.b ? 150 : 1) + k / 10),
      ];
    };
    const { hosted } = await hostedSamples({ instrument: "cytof", channels, values, display: { cofactor: 5 } });
    expect(hosted[0].assayId).toBe("exprs");
    // CyTOF gates are in display units with no transforms: arcsinh at the assay's cofactor.
    const s = session(hosted, (state) => {
      const root = state.active_population_id!;
      state = coreReducer(state, { type: "addGate", gateType: "rectangle", gateId: "g-dna", name: "DNA+", xChannel: "Time", yChannel: "DNA",
        vertices: [[0, 4], [10_000, 9]], createPop: { name: "DNA+", parentId: root } });
      return coreReducer(state, { type: "addGate", gateType: "polygon", gateId: "g-t", name: "CD3+CD19-", xChannel: "CD3", yChannel: "CD19",
        vertices: [[3, -1], [7, -1], [7, 2.5], [3, 2.5]], createPop: { name: "CD3+CD19-", parentId: popId(state, "DNA+") } });
    });
    const ev = classes();
    expect(count(liveMask(s, 0, "DNA+"))).toBe(ev.filter((e) => e.cell).length);
    expect(count(liveMask(s, 0, "CD3+CD19-"))).toBe(ev.filter((e) => e.cell && e.a && !e.b).length);
    const copy = await copyOf(s);
    await expectSameGating(s, copy);
    expect(copy.channelKeys).toEqual({});
    // The FCS holds 5·sinh(stored), the nominal linear values the app drew, as float32.
    const fcs = parseFcs(unzipSync(copy.bytes)["data/0_D1.fcs"].slice().buffer as ArrayBuffer);
    expect(Array.from(fcs.columns[2] as Float32Array)).toEqual(Array.from(hosted[0].sample.fcs.columns[2] as Float32Array));
    expect(workspaceIn(copy).samples.map((x: any) => [x.instrumentMode, x.cytofCofactor])).toEqual([["cytof", 5], ["cytof", 5]]);
  });

  it("writes a sample compensated with the host's spillover matrix as compensated values, with compensation off in the copy, and says so", async () => {
    const { hosted } = await hostedSamples({
      instrument: "flow", channels: FLOW_CHANNELS,
      compensationMatrix: { kind: "flow-spillover", name: "host matrix", sourceChannels: ["FITC-A", "PE-A"], receiverChannels: ["FITC-A", "PE-A"], matrix: [[1, 0.2], [0.1, 1]] },
    });
    for (const h of hosted) {
      h.sample.setCompensation(true);
      expect(h.sample.compensationEnabled).toBe(true);
    }
    const s = session(hosted, (state) => flowGating(state));
    const copy = await copyOf(s);
    await expectSameGating(s, copy);
    expect(copy.compensatedValues).toEqual(["D1", "D2"]);
    const files = await openWorkspace(copy.bytes, "copy.gatelab", []);
    for (const [index, f] of files.entries()) {
      expect(f.sample.compensationEnabled).toBe(false);
      const key = copy.channelKeys["FITC-A"];
      const reopened = f.sample.rawColumnData(f.sample.index(key)!);
      const drawn = hosted[index].sample.rawColumnData(hosted[index].sample.index("FITC-A")!);
      expect(Array.from(reopened)).toEqual(Array.from(drawn));
    }
    const fcsText = strFromU8(unzipSync(copy.bytes)["data/0_D1.fcs"].subarray(0, 4096));
    expect(fcsText).not.toMatch(/SPILLOVER/);
    expect(fcsText).toMatch(/GATELAB_ASSAY.compensated/);
  });

  it("writes a layer the R host computed under its own solver profile as the values gated, with compensation off, where the runner refuses the profile", async () => {
    const { hosted } = await hostedSamples({ instrument: "flow", channels: FLOW_CHANNELS });
    // A browser matrix re-identified as R's solver, as the Compensation tab's Apply does under the
    // R host; the values are R's, here made up: each included channel scaled by 0.8.
    const canonical = validateAndCanonicalizeCompensationMatrix(
      { sourceChannels: ["FITC-A", "PE-A"], receiverChannels: ["FITC-A", "PE-A"], matrix: [[1, 0.2], [0.1, 1]] }, "flow-spillover");
    if (!canonical.ok) throw new Error("matrix");
    const browser = await createCompensationBaselineProfile({
      kind: "flow-spillover", method: "matrix-inverse", solverVersion: "flow-lu-v1",
      solverSettings: { singularTolerance: 1e-12, conditionWarningThreshold: 1e8 }, matrix: canonical.value,
    }, { profileId: "m1", name: "M1", createdAt: "2026-01-01T00:00:00.000Z", origin: { type: "uploaded", fileName: "m1.csv", format: "csv", sourceColumnHeader: "channel" } });
    const rProfile = await authoritativeRProfile(browser);
    expect(rProfile.scientific.solverVersion).toBe("r-matrix-inverse-v1");
    const manager = new CompensationManager({ workspaceKey: "synthetic", workerPoolSize: 1 });
    for (const h of hosted) {
      const { binding } = await manager.prepareExternalApplyBinding(rProfile, h.sample);
      h.sample.installCompensatedLayer({
        metadata: binding,
        columns: binding.channelBindings.filter(({ included }) => included).map(({ pnn, fcsColumnIndex }) => ({
          pnn, fcsColumnIndex, values: Float32Array.from(h.sample.fcs.columns[fcsColumnIndex], (v) => v * 0.8),
        })),
      }, { activeLayer: "compensated" });
      expect(h.sample.compensationEnabled).toBe(true);
    }
    manager.dispose();
    // The workspace as the app saves it then (App.tsx buildWorkspaceFile): version 3, each sample's
    // layer bound to the R profile in place of compensationOn.
    const s = session(hosted, (state) => flowGating(state));
    const { version: _v, samples: legacySamples, ...common } = s.workspace;
    const v3 = {
      ...common,
      version: 3,
      compensation: { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [{ baselineProfileId: rProfile.profileId, records: [rProfile] }] },
      samples: legacySamples.map(({ compensationOn: _on, ...wss }, index) => {
        const status = hosted[index].sample.compensatedLayerStatus();
        if (status.state !== "ready") throw new Error("layer");
        const { runtimeIdentity: _r, ...persisted } = status.metadata as typeof status.metadata & { runtimeIdentity?: unknown };
        return { ...wss, assay: { schema: SAMPLE_ASSAY_BINDING_SCHEMA, activeLayer: "compensated" as const, compensatedLayer: persisted as never } };
      }),
    } as unknown as WorkspaceFileV3;
    // That workspace, bundled with FCS of the drawn values, is one the headless runner refuses.
    const asSaved = packWorkspaceV3(v3, Object.fromEntries(v3.samples.map((wss, i) => [wss.dataPath, exportFcsOf(hosted[i])])));
    await expect(openWorkspace(asSaved, "as-saved.gatelab", [])).rejects.toThrow(/kept by reference to a compensation profile/);

    const copy = await copyOf({ ...s, workspace: v3 as unknown as WorkspaceFile });
    await expectSameGating(s, copy);
    expect(copy.compensatedValues).toEqual(["D1", "D2"]);
    const ws = workspaceIn(copy);
    expect(ws.version === 2 || ws.version === 4).toBe(true);
    expect(ws.compensation).toBeUndefined();
    expect(ws.samples.map((x: any) => [x.compensationOn, x.assay])).toEqual([[false, undefined], [false, undefined]]);
    const files = await openWorkspace(copy.bytes, "copy.gatelab", []);
    const key = copy.channelKeys["FITC-A"];
    expect(Array.from(files[0].sample.rawColumnData(files[0].sample.index(key)!)))
      .toEqual(Array.from(hosted[0].sample.rawColumnData(hosted[0].sample.index("FITC-A")!)));
  });

  it("keeps keys that already are the standalone keys: ids equal to $PnN with no marker, and ids that differ from $PnN", async () => {
    const channels: GateLabHostChannelDescriptor[] = [
      { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
      { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
      { id: "FL1-A", label: "FL1-A", pnn: "FL1-A" },
      // An id that is not its $PnN, given as the channel's label: written as $PnS, read back as the key.
      { id: "marker_b", label: "marker_b", pnn: "FL2-A" },
      { id: "FL3-A", label: "FL3-A", pnn: "FL3-A" },
      { id: "FL4-A", label: "FL4-A", pnn: "FL4-A" },
    ];
    const { hosted } = await hostedSamples({ instrument: "flow", channels });
    const s = session(hosted, (state) => flowGating(state, ["FSC-A", "SSC-A", "FL1-A", "marker_b", "FL3-A", "FL4-A"]));
    const copy = await copyOf(s);
    expect(copy.channelKeys).toEqual({});
    const counts = await expectSameGating(s, copy);
    const expected = expectedFlowCounts();
    expect(counts.D1).toEqual(expected);
  });

  it("restates keys the standalone reader tells apart: a marker named twice, and an unmixed spectral panel's channels", async () => {
    const duplicates: GateLabHostChannelDescriptor[] = [
      { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
      { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
      { id: "FITC-A", label: "CD3", pnn: "FITC-A", pns: "CD3" },
      { id: "PE-A", label: "CD3", pnn: "PE-A", pns: "CD3" },
      { id: "APC-A", label: "CD4", pnn: "APC-A", pns: "CD4" },
      { id: "BV421-A", label: "CD8", pnn: "BV421-A", pns: "CD8" },
    ];
    const dup = await hostedSamples({ instrument: "flow", channels: duplicates });
    const s1 = session(dup.hosted, (state) => flowGating(state));
    const c1 = await copyOf(s1);
    expect(c1.channelKeys).toMatchObject({ "FITC-A": "CD3 (FITC-A)", "PE-A": "CD3 (PE-A)" });
    await expectSameGating(s1, c1);

    // Two unmixed population channels ($PnS ending -A) and two raw detectors: the standalone reader
    // names the first "marker (detector)" and leaves the detectors out.
    const unmixed: GateLabHostChannelDescriptor[] = [
      { id: "FSC-A", label: "FSC-A", pnn: "FSC-A" },
      { id: "SSC-A", label: "SSC-A", pnn: "SSC-A" },
      { id: "U1-A", label: "CD3-A", pnn: "U1-A", pns: "CD3-A" },
      { id: "U2-A", label: "CD19-A", pnn: "U2-A", pns: "CD19-A" },
      { id: "U3-A", label: "CD4-A", pnn: "U3-A", pns: "CD4-A" },
      { id: "U4-A", label: "CD8-A", pnn: "U4-A", pns: "CD8-A" },
      { id: "V1-A", label: "V1-A", pnn: "V1-A" },
      { id: "V2-A", label: "V2-A", pnn: "V2-A" },
    ];
    const spec = await hostedSamples({ instrument: "flow", channels: unmixed });
    const s2 = session(spec.hosted, (state) => flowGating(state, ["FSC-A", "SSC-A", "U1-A", "U2-A", "U3-A", "U4-A"]));
    const c2 = await copyOf(s2);
    expect(c2.channelKeys).toEqual({ "U1-A": "CD3-A (U1-A)", "U2-A": "CD19-A (U2-A)", "U3-A": "CD4-A (U3-A)", "U4-A": "CD8-A (U4-A)" });
    expect(c2.leftOutChannels).toEqual(["V1-A", "V2-A"]);
    await expectSameGating(s2, c2);

    // A gate on a raw detector cannot be carried: refused by name, nothing written.
    const s3 = session(spec.hosted, (state) => flowGating(state, ["FSC-A", "SSC-A", "V1-A", "U2-A", "U3-A", "U4-A"]));
    await expect(copyOf(s3)).rejects.toThrow(/Gates are drawn on "V1-A"/);
  });

  it("refuses the copy, naming the sample and the population, when the reopened copy does not gate as the session did", async () => {
    const { hosted } = await hostedSamples({ instrument: "flow", channels: FLOW_CHANNELS });
    const s = session(hosted, (state) => flowGating(state));
    // The session's answer for D2's "A+B-" with one event changed: the copy, gated by the engine, disagrees.
    const tampered: GateLabHostWorkspaceMemberships = {
      ...s.live,
      populations: s.live.populations.map((p) => p.populationName !== "A+B-" ? p : {
        ...p,
        sampleMasks: p.sampleMasks.map((m) => {
          if (m.sampleId !== "sample-1") return m;
          const packed = decodeUint8Base64(m.membershipBitsBase64);
          packed[0] ^= 1 << 1;
          return { ...m, membershipBitsBase64: Buffer.from(packed).toString("base64") };
        }),
      }),
    };
    let error: unknown;
    try {
      await copyOf(s, tampered);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HostedPortableCopyRefused);
    expect((error as Error).message).toMatch(/^The portable copy was not saved/);
    expect((error as Error).message).toContain(`D2: "A+B-" of "Main" holds 1 event otherwise in the copy`);
  });
});

