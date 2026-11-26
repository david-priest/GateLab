// hostedPortableCopy.ts — a GateLabR session saved as a portable .gatelab that opens in the
// standalone app with nothing to relink.
//
// A hosted sample has no FCS file: the R host sends one float32 matrix per assay, and the app
// wraps it in an in-memory FCS whose channel keys are the R object's channel ids (appKey). To make
// a standalone copy, each sample is written as an FCS file of the values the app gates it on, with
// the app's own FCS export (engine/fcsExport.ts): the drawn assay's linear values, or, where the
// sample is gated on compensated values (a matrix applied in the browser, or a layer the R host
// computed with its own solver), those compensated values, with compensation off in the copy.
//
// Each written file is read back with the standalone reader, so the channel keys are the ones
// resolveChannels derives from it ($PnS, else $PnN; duplicates told apart; an unmixed spectral
// file's raw detectors left out), and the workspace is rewritten to them and to new sample ids
// wherever it names either. Before the bytes are handed back, the copy is opened and gated by the
// headless runner's own steps (headless/evaluate.ts), and every population's membership in every
// sample is compared with the live session's, event by event. A difference stops the copy and
// names the sample and the population. Nothing here decides membership.

import { parseFcs } from "./engine/fcs";
import { exportPopulationFcs } from "./engine/fcsExport";
import { Sample } from "./engine/sample";
import { packWorkspace, type WorkspaceFile, type WorkspaceSample } from "./engine/workspace";
import type { WorkspaceFileV3 } from "./engine/workspaceV3";
import type { Gate } from "./engine/models";
import { decodeUint8Base64 } from "./engine/encode";
import type { GateLabHostWorkspaceMemberships } from "./host/workspaceContract";
import { evaluateWorkspaceArchive } from "./headless/evaluate";
import { sampleDataPath } from "./workspaceRecords";

type LiveWorkspaceFile = WorkspaceFile | WorkspaceFileV3;

/** One hosted sample as the session holds it, in the workspace's sample order. */
export interface HostedCopySample {
  /** The store's id for it (`<datasetId>:<sampleId>`), which the workspace names. */
  entryId: string;
  /** The R host's id for it, which the memberships payload names. */
  hostSampleId: string;
  name: string;
  sample: Sample;
}

export interface HostedPortableCopyInput {
  /** The workspace as the session builds it for a save (App.tsx buildWorkspaceFile). */
  workspace: LiveWorkspaceFile;
  samples: readonly HostedCopySample[];
  /** The live session's memberships: every population of every hierarchy over every sample (buildHostedMemberships). */
  live: GateLabHostWorkspaceMemberships;
  /** A new sample id for the copy; crypto.randomUUID by default. */
  newSampleId?: () => string;
  /** The `app` the copy records. */
  app?: string;
}

export interface HostedPortableCopy {
  /** The .gatelab bundle, checked. */
  bytes: Uint8Array;
  /** The workspace it holds, as written (before stamping). */
  workspace: WorkspaceFile;
  /** Hosted sample id (the store's) to the copy's. */
  sampleIds: Record<string, string>;
  /** Hosted channel key to the key the standalone reader derives, where they differ. */
  channelKeys: Record<string, string>;
  /** Samples gated on compensated values: written as compensated, with compensation off in the copy. */
  compensatedValues: string[];
  /** Hosted channels the standalone reader does not offer (raw spectral detectors), which nothing in the gating names. */
  leftOutChannels: string[];
  /** What was compared: populations over samples, event by event. */
  checked: { samples: number; populations: number; events: number };
}

/** The copy was refused: what it names cannot be carried, or the check found a difference. */
export class HostedPortableCopyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedPortableCopyRefused";
  }
}

const withFcsExtension = (name: string) => (/\.fcs$/i.test(name) ? name : `${name}.fcs`);

function keyedRecord<T>(record: Record<string, T> | undefined, key: (k: string) => string | null): Record<string, T> | undefined {
  if (!record) return record;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    const to = key(k);
    if (to !== null) out[to] = v;
  }
  return out;
}

function keyedList(list: string[] | undefined, key: (k: string) => string | null): string[] | undefined {
  return list ? list.map(key).filter((k): k is string => k !== null) : list;
}

/** Every string equal to a hosted sample id, as a value or a key, replaced by the copy's id. */
function replaceSampleIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceSampleIds(v, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, replaceSampleIds(v, ids)]));
  }
  return value;
}

/** A gate with its channel keys restated: both axes, its transforms and FlowJo's saved axes and bounds. */
function remapGate(gate: Gate, key: (k: string) => string): Gate {
  const g = gate as Gate & { flowjo_axes?: Record<string, unknown>; flowjo_bounds?: Record<string, unknown> };
  const keyed = <T,>(r: Record<string, T> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [key(k), v])) : r);
  return {
    ...g,
    x_channel: key(g.x_channel),
    y_channel: key(g.y_channel),
    ...(g.transforms ? { transforms: keyed(g.transforms) } : {}),
    ...(g.flowjo_axes ? { flowjo_axes: keyed(g.flowjo_axes) } : {}),
    ...(g.flowjo_bounds ? { flowjo_bounds: keyed(g.flowjo_bounds) } : {}),
  } as Gate;
}

function gateKeys(gates: Record<string, Gate> | undefined): string[] {
  const out: string[] = [];
  for (const g of Object.values(gates ?? {})) out.push(g.x_channel, g.y_channel, ...Object.keys(g.transforms ?? {}));
  return out;
}

function countDiffering(a: Uint8Array, b: Uint8Array, n: number): number {
  let d = 0;
  for (let i = 0; i < n; i++) d += ((a[i >> 3] ?? 0) >> (i & 7) & 1) === ((b[i >> 3] ?? 0) >> (i & 7) & 1) ? 0 : 1;
  return d;
}

/**
 * Write the session as a portable .gatelab, check it with the engine against the live session, and
 * return the bytes. Throws HostedPortableCopyRefused, naming what, when the copy cannot be made
 * faithfully.
 */
export async function buildHostedPortableCopy(input: HostedPortableCopyInput): Promise<HostedPortableCopy> {
  const { workspace, samples, live } = input;
  const newSampleId = input.newSampleId ?? (() => crypto.randomUUID());
  if (samples.length !== workspace.samples.length || samples.some((s, i) => workspace.samples[i].sampleId !== s.entryId)) {
    throw new HostedPortableCopyRefused("The workspace and the session's samples do not correspond; nothing was written.");
  }

  // ── Each sample as an FCS file of the values it is gated on, and read back ────────────────
  const fcsByPath: Record<string, Uint8Array> = {};
  const compensatedValues: string[] = [];
  const keyMaps: Map<string, string | null>[] = [];
  const dataPaths: string[] = [];
  const fileNames: string[] = [];
  for (const [index, hosted] of samples.entries()) {
    const compensated = hosted.sample.compensationEnabled;
    if (compensated) compensatedValues.push(hosted.name);
    let bytes: Uint8Array;
    try {
      bytes = exportPopulationFcs(hosted.sample, null, compensated ? "compensated" : "original");
    } catch (cause) {
      throw new HostedPortableCopyRefused(`${hosted.name} could not be written as FCS: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const fileName = withFcsExtension(hosted.name);
    const dataPath = sampleDataPath(fileName, index);
    fileNames.push(fileName);
    dataPaths.push(dataPath);
    fcsByPath[dataPath] = bytes;
    const reread = new Sample(parseFcs(bytes.slice().buffer as ArrayBuffer));
    reread.setInstrumentMode(hosted.sample.instrument);
    // The export writes the hosted sample's channels in order, one column each.
    const keyOfColumn = new Map(reread.channels.map((c) => [c.columnIndex, c.key]));
    keyMaps.push(new Map(hosted.sample.channels.map((c, column) => [c.key, keyOfColumn.get(column) ?? null])));
  }

  // One key per hosted channel, the same in every sample: the gates are shared.
  const keyMap = new Map<string, string | null>(keyMaps[0] ?? []);
  for (const [index, map] of keyMaps.entries()) {
    for (const [from, to] of map) {
      if (keyMap.has(from) && keyMap.get(from) !== to) {
        throw new HostedPortableCopyRefused(
          `The channel "${from}" reads as "${keyMap.get(from) ?? "(left out)"}" in ${samples[0].name} and as "${to ?? "(left out)"}" in ${samples[index].name}; ` +
          "one workspace cannot name both. Give it one label in every sample (Panel tab) and save again.");
      }
      keyMap.set(from, to);
    }
  }
  const leftOut = [...keyMap].filter(([, to]) => to === null).map(([from]) => from);
  const trees = [
    { name: "the live tree", gates: workspace.gating.gates },
    ...(workspace.gating.stored_hierarchies ?? []).map((h) => ({ name: h.name, gates: h.gates })),
  ];
  const named = new Set(trees.flatMap((t) => gateKeys(t.gates)));
  const lost = leftOut.filter((k) => named.has(k));
  if (lost.length) {
    throw new HostedPortableCopyRefused(
      `Gates are drawn on ${lost.map((k) => `"${k}"`).join(", ")}, which the standalone app does not offer from an FCS file of this panel ` +
      "(it reads the panel as an unmixed spectral one and leaves its raw detectors out). Nothing was written.");
  }
  const key = (k: string): string | null => (keyMap.has(k) ? keyMap.get(k)! : k);
  const gateKey = (k: string): string => key(k) ?? k;

  // ── The workspace, restated for the copy ─────────────────────────────────────────────────
  const sampleIds = new Map(samples.map((s) => [s.entryId, newSampleId()]));
  const {
    hostedAssayId: _assay,
    hostedChannelTransforms: _transforms,
    requiredFeatures: _features,
    compensation: _compensation,
    ...common
  } = workspace as LiveWorkspaceFile & { hostedAssayId?: unknown; hostedChannelTransforms?: unknown; requiredFeatures?: unknown; compensation?: unknown };
  const restated = replaceSampleIds(common, sampleIds) as Omit<WorkspaceFile, "version" | "samples"> & { samples: (WorkspaceSample & { assay?: unknown })[] };
  const display = restated.display;
  const offered = (k: string) => key(k) !== null;
  const firstOffered = samples[0]?.sample.channels.map((c) => c.key).filter(offered) ?? [];
  const copy: WorkspaceFile = {
    ...restated,
    version: 2,
    savedAt: new Date().toISOString(),
    ...(input.app ? { app: input.app } : {}),
    samples: restated.samples.map(({ assay: _binding, ...wss }, index) => {
      const division = wss.division && key(wss.division.channelKey) !== null
        ? (() => {
            const { coordinateBindingKey, ...rest } = wss.division!;
            const to = key(rest.channelKey)!;
            // A binding names the channel; where the key changed it is computed again on open.
            return { ...rest, channelKey: to, ...(to === rest.channelKey && coordinateBindingKey ? { coordinateBindingKey } : {}) };
          })()
        : undefined;
      const { division: _division, ...rest } = wss;
      const record = {
        ...rest,
        fileName: fileNames[index],
        dataPath: dataPaths[index],
        instrumentMode: samples[index].sample.instrument,
        compensationOn: false,
        logicleW: keyedRecord(wss.logicleW, key) ?? {},
        scatterCofactor: keyedRecord(wss.scatterCofactor, key),
        scatterLinear: keyedList(wss.scatterLinear, key),
        fluorArcsinh: keyedList(wss.fluorArcsinh, key),
        fluorBiex: keyedRecord(wss.fluorBiex, key),
        ...(wss.fluorBiexRecorded ? { fluorBiexRecorded: keyedRecord(wss.fluorBiexRecorded, key) } : {}),
        labels: keyedRecord(wss.labels, key),
        ...(division ? { division } : {}),
      };
      // A field the session left out stays out: the validator reads a present key as stated.
      for (const k of Object.keys(record) as (keyof typeof record)[]) if (record[k] === undefined) delete record[k];
      return record as WorkspaceSample;
    }),
    gating: {
      ...restated.gating,
      gates: Object.fromEntries(Object.entries(restated.gating.gates).map(([id, g]) => [id, remapGate(g, gateKey)])),
      stored_hierarchies: restated.gating.stored_hierarchies?.map((h) => (h.gates
        ? { ...h, gates: Object.fromEntries(Object.entries(h.gates).map(([id, g]) => [id, remapGate(g, gateKey)])) }
        : h)),
    },
    scales: {
      ...restated.scales,
      globalScales: keyedRecord(restated.scales.globalScales, key) ?? {},
      ...(restated.scales.perSampleGlobalScales
        ? { perSampleGlobalScales: Object.fromEntries(Object.entries(restated.scales.perSampleGlobalScales).map(([id, r]) => [id, keyedRecord(r, key) ?? {}])) }
        : {}),
    },
    display: {
      ...display,
      xChannel: key(display.xChannel) ?? firstOffered[0] ?? display.xChannel,
      yChannel: key(display.yChannel) ?? firstOffered[1] ?? firstOffered[0] ?? display.yChannel,
    },
  };

  let bytes: Uint8Array;
  try {
    bytes = packWorkspace(copy, fcsByPath);
  } catch (cause) {
    throw new HostedPortableCopyRefused(`The copy could not be packed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // ── The check: the copy opened and gated by the engine, against the live session ──────────
  let opened;
  try {
    opened = await evaluateWorkspaceArchive(bytes);
  } catch (cause) {
    throw new HostedPortableCopyRefused(`The copy does not open in standalone GateLab: ${cause instanceof Error ? cause.message : String(cause)} Nothing was written.`);
  }
  const copyIdOfHost = new Map(samples.map((s) => [s.hostSampleId, sampleIds.get(s.entryId)!]));
  const nameOfHost = new Map(samples.map((s) => [s.hostSampleId, s.name]));
  const hierarchyName = new Map(live.hierarchies.map((h) => [h.id, h.name]));
  const reopened = new Map(opened.memberships.populations.map((p) => [`${p.hierarchyId}|${p.populationId}`, p]));
  const differences: string[] = [];
  let events = 0;
  for (const p of live.populations) {
    const where = `"${p.populationName}" of "${hierarchyName.get(p.hierarchyId) ?? p.hierarchyId}"`;
    const other = reopened.get(`${p.hierarchyId}|${p.populationId}`);
    reopened.delete(`${p.hierarchyId}|${p.populationId}`);
    if (!other) {
      differences.push(`${where} is not in the copy`);
      continue;
    }
    const masks = new Map(other.sampleMasks.map((m) => [m.sampleId, m]));
    for (const m of p.sampleMasks) {
      const sampleName = nameOfHost.get(m.sampleId) ?? m.sampleId;
      const o = masks.get(copyIdOfHost.get(m.sampleId) ?? "");
      if (!o) {
        differences.push(`${sampleName}: ${where} is not evaluated in the copy`);
        continue;
      }
      if (!!m.notEvaluated !== !!o.notEvaluated) {
        differences.push(`${sampleName}: ${where} is ${m.notEvaluated ? "not evaluated in the session and evaluated in the copy" : "evaluated in the session and not in the copy"}`);
        continue;
      }
      if (m.notEvaluated) continue;
      if (m.eventCount !== o.eventCount) {
        differences.push(`${sampleName}: ${m.eventCount} events in the session, ${o.eventCount} in the copy`);
        continue;
      }
      events += m.eventCount;
      if (m.membershipBitsBase64 === o.membershipBitsBase64) continue;
      const n = countDiffering(decodeUint8Base64(m.membershipBitsBase64), decodeUint8Base64(o.membershipBitsBase64), m.eventCount);
      if (n > 0) differences.push(`${sampleName}: ${where} holds ${n.toLocaleString("en-US")} event${n === 1 ? "" : "s"} otherwise in the copy`);
    }
  }
  for (const p of reopened.values()) differences.push(`"${p.populationName}" is in the copy and not in the session`);
  if (differences.length) {
    const shown = differences.slice(0, 8);
    throw new HostedPortableCopyRefused(
      "The portable copy was not saved: opened in standalone GateLab, it does not gate as this session does. " +
      `${shown.join("; ")}${differences.length > shown.length ? `; and ${differences.length - shown.length} more` : ""}.`);
  }

  const channelKeys = Object.fromEntries([...keyMap].filter(([from, to]) => to !== null && to !== from) as [string, string][]);
  return {
    bytes,
    workspace: copy,
    sampleIds: Object.fromEntries(sampleIds),
    channelKeys,
    compensatedValues,
    leftOutChannels: leftOut,
    checked: { samples: samples.length, populations: live.populations.length, events },
  };
}
