// workspace.ts — a saved .gatelab workspace, reopened without the app.
//
// The steps are App.tsx openWorkspaceFromEnvelope's, in its order, minus what only a window has
// (handles, cell images, checkpoints, axis ranges, display settings): read the envelope, resolve
// each declared FCS file (bundled, or linked and given here), restore each sample's instrument,
// cofactor, channel settings, derived channels, workspace matrix and compensation, restate channel
// keys the files now read differently, restore the shared channel scales, and load the trees into
// the store as its loadWorkspace action does. Each file is then gated under the tree the app gates
// it under (fileHierarchyId), as the Statistics tab tabulates it.
//
// A compensated layer saved by reference to a compensation profile is computed by the app's
// compensation manager on a worker, which is not here; such a workspace is refused, by sample,
// unless it is a portable bundle that carries the compensated values (restorePortableAssayLayers).

import { parseFcs, parseFcsDataSetFileName, FcsMultipleDataSetsError } from "../engine/fcs";
import { Sample } from "../engine/sample";
import {
  readWorkspaceEnvelope,
  migrateWorkspaceToV2,
  validateWorkspace,
  type WorkspaceFile,
  type WorkspaceStoredHierarchy,
} from "../engine/workspace";
import {
  WORKSPACE_VERSION_3,
  validateWorkspaceV3,
  type WorkspaceFileV3,
  type WorkspaceV3SampleRestoreContexts,
} from "../engine/workspaceV3";
import { restorePortableAssayLayers } from "../engine/workspacePortableAssays";
import { planWorkspaceFcsRelink, type WorkspaceFcsRequirement } from "../engine/workspaceRelink";
import { identityKeywords } from "../engine/fileIdentity";
import { planChannelKeyRemap, gateChannelKeys, remapGateChannels } from "../engine/workspaceChannelKeys";
import { decodeDerivedChannel } from "../engine/derivedChannels";
import { ChannelScales } from "../engine/channelScales";
import { restoreChannelScales } from "../engine/restoreChannelScales";
import { fileHierarchyId, referencedGateIds, type StoredHierarchy } from "../engine/hierarchies";
import type { Gate } from "../engine/models";
import { coreReducer, initialCoreState, type CoreState } from "../store";
import { HeadlessError, type GatedFile, type GatingTree, type OpenOptions } from "./headless";

type LiveWorkspaceFile = WorkspaceFile | WorkspaceFileV3;

export interface FcsInput {
  /** The file's name, as a workspace would declare it (a basename). */
  name: string;
  /** Where it was read from, for messages. */
  path: string;
  bytes: Uint8Array;
}

/** A parked hierarchy's tree with its own gates, as App.tsx restoreStoredHierarchy rebuilds it. */
function restoreStoredHierarchy(stored: WorkspaceStoredHierarchy, sharedGates: Record<string, Gate>): StoredHierarchy {
  if (stored.gates) {
    return { ...stored, gates: stored.gates, gate_order: stored.gate_order ?? Object.keys(stored.gates), selected_pop_ids: [] } as StoredHierarchy;
  }
  const gates: Record<string, Gate> = {};
  for (const id of referencedGateIds(stored.populations)) if (sharedGates[id]) gates[id] = sharedGates[id];
  return { ...stored, gates, gate_order: Object.keys(gates), selected_pop_ids: [] } as StoredHierarchy;
}

/** A hierarchy's tree, live or parked, as App.tsx treeOf reads it; null for an empty one. */
function treeOf(state: CoreState, id: string): GatingTree | null {
  if (id === state.active_hierarchy_id) {
    return state.root_population_id
      ? { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id }
      : null;
  }
  const h = state.stored_hierarchies[id];
  return h && h.root_population_id
    ? { gates: h.gates, gate_order: h.gate_order, populations: h.populations, root_population_id: h.root_population_id }
    : null;
}

function readSample(bytes: Uint8Array, declaredName: string, notes: string[]): Sample {
  const ab = bytes.slice().buffer as ArrayBuffer;
  // One data set of a multi-data-set file is declared by a name that says which (fcs.ts).
  const dataSet = parseFcsDataSetFileName(declaredName);
  try {
    return new Sample(dataSet ? parseFcs(ab, { dataSet: dataSet.index }) : parseFcs(ab));
  } catch (cause) {
    if (!(cause instanceof FcsMultipleDataSetsError)) throw cause;
    // A workspace saved before GateLab read every data set holds such a file as its first one.
    notes.push(`${declaredName} holds ${cause.dataSets.length} data sets and this workspace uses the first, as it was saved.`);
    return new Sample(parseFcs(ab, { dataSet: 0 }));
  }
}

/**
 * Reopen a .gatelab workspace and return each of its files with the tree it is gated under. A
 * linked (reference) workspace takes its FCS files from `fcs`, matched by name and recorded
 * acquisition as the app relinks them; a portable bundle carries its own and takes none.
 */
export async function openWorkspace(bytes: Uint8Array, workspacePath: string, fcs: readonly FcsInput[], opts: Pick<OpenOptions, "instrument"> = {}): Promise<GatedFile[]> {
  const envelope = readWorkspaceEnvelope(bytes);
  const raw = envelope.raw;
  const rawVersion = raw != null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  let ws: LiveWorkspaceFile;
  if (rawVersion === WORKSPACE_VERSION_3) {
    const provisional = raw as Partial<WorkspaceFileV3>;
    if (!Array.isArray(provisional.samples) || provisional.samples.length === 0) {
      throw new HeadlessError("Invalid GateLab workspace v3: sample declarations are missing.");
    }
    ws = provisional as WorkspaceFileV3;
  } else {
    ws = migrateWorkspaceToV2(raw);
    validateWorkspace(ws);
  }
  const { fcsByPath, storage } = envelope;
  if (storage === "bundle" && fcs.length) {
    throw new HeadlessError(`${workspacePath} is a portable workspace that carries its own FCS files; give no FCS files with it.`);
  }

  // Each declared file: bundled, or one of those given, relinked by name and recorded identity.
  const requirements: WorkspaceFcsRequirement[] = ws.samples
    .filter((wss) => !fcsByPath?.[wss.dataPath])
    .map((wss) => ({ dataPath: wss.dataPath, fileName: wss.fileName, ...(wss.identity ? { identity: wss.identity } : {}) }));
  const resolved = new Map<string, FcsInput>();
  const notes: string[] = [];
  if (requirements.length) {
    const candidates = fcs.map((f) => ({ name: f.name, relativePath: f.path, input: f }));
    const identityOf = (c: (typeof candidates)[number]) => {
      try {
        return identityKeywords(parseFcs(c.input.bytes.slice().buffer as ArrayBuffer, { dataSet: 0 }).keywords);
      } catch {
        return null;
      }
    };
    const plan = planWorkspaceFcsRelink(requirements, candidates, identityOf);
    const problems: string[] = [
      ...plan.missing.map((r) => `${r.fileName}: not among the FCS files given`),
      ...plan.ambiguous.map((a) => `${a.requirement.fileName}: matched by ${a.candidates.map((c) => c.relativePath).join(" and ")}, which nothing saved with it tells apart`),
      ...plan.mismatched.map((m) => `${m.requirement.fileName}: every file of that name records another acquisition (${m.candidates.map((c) => c.candidate.relativePath).join(", ")})`),
    ];
    if (problems.length) throw new HeadlessError(`${workspacePath} links FCS files that could not be resolved:\n  ${problems.join("\n  ")}`);
    for (const u of plan.unconfirmed) notes.push(`${u.requirement.fileName} was relinked to ${u.candidate.relativePath} by name; nothing recorded confirms it is that acquisition.`);
    for (const [dataPath, c] of plan.matches) resolved.set(dataPath, c.input);
    const used = new Set([...resolved.values()]);
    const unused = fcs.filter((f) => !used.has(f));
    if (unused.length) throw new HeadlessError(`${workspacePath} declares no sample for: ${unused.map((f) => f.path).join(", ")}.`);
  }

  const samples: Sample[] = [];
  const fileIds: string[] = [];
  for (const [index, wss] of ws.samples.entries()) {
    const input = resolved.get(wss.dataPath);
    const fcsBytes = fcsByPath?.[wss.dataPath] ?? input?.bytes;
    if (!fcsBytes) throw new HeadlessError(`${workspacePath}: ${wss.fileName} could not be resolved.`);
    let sample: Sample;
    try {
      sample = readSample(fcsBytes, wss.fileName, notes);
    } catch (cause) {
      throw new HeadlessError(`Could not read ${wss.fileName}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (wss.instrumentMode === "flow" || wss.instrumentMode === "cytof") sample.setInstrumentMode(wss.instrumentMode);
    else if (opts.instrument === "flow" || opts.instrument === "cytof") sample.setInstrumentMode(opts.instrument);
    if (Number.isFinite(wss.cytofCofactor) && (wss.cytofCofactor ?? 0) > 0) sample.setCytofCofactor(wss.cytofCofactor!);
    samples.push(sample);
    fileIds.push(wss.sampleId ?? `sample-${index + 1}`);
  }

  if (rawVersion === WORKSPACE_VERSION_3) {
    const contexts: WorkspaceV3SampleRestoreContexts = Object.freeze(Object.fromEntries(ws.samples.map((wss, index) => [
      wss.dataPath,
      Object.freeze({ sampleChannels: samples[index].channels, instrumentKind: samples[index].instrument }),
    ])));
    ws = await validateWorkspaceV3(raw, contexts);
  }

  // Channel keys the files now read differently, restated (workspaceChannelKeys.ts).
  const savedKeys = new Set<string>([
    ...gateChannelKeys(ws.gating.gates),
    ...(ws.gating.stored_hierarchies ?? []).flatMap((h) => [...gateChannelKeys(h.gates ?? {})]),
    ...ws.samples.flatMap((wss) => [
      ...Object.keys(wss.logicleW ?? {}), ...Object.keys(wss.scatterCofactor ?? {}), ...(wss.scatterLinear ?? []),
      ...(wss.fluorArcsinh ?? []), ...Object.keys(wss.fluorBiex ?? {}),
      ...Object.keys(wss.fluorBiexRecorded ?? {}), ...Object.keys(wss.labels ?? {}),
    ]),
  ]);
  const remap = planChannelKeyRemap(savedKeys, samples.map((s) => s.channels));
  const key = (k: string) => remap.get(k) ?? k;
  const keyed = <T,>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).map(([k, v]) => [key(k), v]));
  if (remap.size) {
    ws = {
      ...ws,
      gating: {
        ...ws.gating,
        gates: remapGateChannels(ws.gating.gates, remap),
        stored_hierarchies: ws.gating.stored_hierarchies?.map((h) => (h.gates ? { ...h, gates: remapGateChannels(h.gates, remap) } : h)),
      },
    } as LiveWorkspaceFile;
    notes.push(`Channel keys restated: ${[...remap].map(([from, to]) => `"${from}" is now "${to}"`).join(", ")}.`);
  }

  for (const [index, wss] of ws.samples.entries()) {
    const sample = samples[index];
    for (const [k, w] of Object.entries(keyed(wss.logicleW ?? {}))) {
      const idx = sample.index(k);
      if (idx !== undefined && Number.isFinite(w)) sample.setLogicleW(idx, w);
    }
    for (const [k, cofactor] of Object.entries(keyed(wss.scatterCofactor ?? {}))) {
      const idx = sample.index(k);
      if (idx !== undefined && Number.isFinite(cofactor) && cofactor > 0) sample.setScatterCofactor(idx, cofactor);
    }
    sample.applyScatterLinearKeys((wss.scatterLinear ?? []).map(key));
    sample.applyFluorArcsinhKeys((wss.fluorArcsinh ?? []).map(key));
    sample.applyFluorBiex(keyed(wss.fluorBiex ?? {}), keyed(wss.fluorBiexRecorded ?? {}));
    sample.applyLabelOverrides(keyed(wss.labels ?? {}));
    for (const record of wss.derived ?? []) {
      try {
        sample.addDerivedChannel(decodeDerivedChannel(record, sample.fcs.nEvents));
      } catch (cause) {
        notes.push(`${wss.fileName}: a derived channel was left out: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (wss.externalSpillover) {
      const { label, channels, matrix, leftOut } = wss.externalSpillover;
      try {
        sample.installExternalSpillover({ channels, matrix }, label, { replaceEmbedded: true, leftOut: leftOut ?? [] });
      } catch (cause) {
        throw new HeadlessError(`${wss.fileName} was compensated with the spillover matrix "${label}", saved with the workspace, which cannot be applied to it: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (ws.version === 2 && "compensationOn" in wss && wss.compensationOn) {
      sample.setCompensation(true);
      if (!sample.compensationEnabled) throw new HeadlessError(`${wss.fileName} was saved compensated, and its compensation could not be turned on.`);
    }
  }

  if (ws.version === WORKSPACE_VERSION_3) {
    const v3 = ws;
    const bound = v3.samples.some((s) => s.assay.compensatedLayer !== null);
    // Gated on a compensated layer: what the gates are evaluated on. A layer kept only to switch
    // back to (the original active) changes no count.
    const active = v3.samples.filter((s) => s.assay.compensatedLayer !== null && s.assay.activeLayer === "compensated").map((s) => s.fileName);
    if (bound && envelope.portableAssays) {
      await restorePortableAssayLayers(envelope.portableAssays, v3, v3.samples.map((wss, index) => Object.freeze({
        dataPath: wss.dataPath,
        fcsBytes: fcsByPath?.[wss.dataPath] ?? resolved.get(wss.dataPath)!.bytes,
        sample: samples[index],
      })));
    } else if (active.length) {
      throw new HeadlessError(
        `${workspacePath} gates ${active.join(", ")} on a compensated layer kept by reference to a compensation profile, which the app ` +
        "recomputes on a worker and the headless runner does not. Save a portable workspace from the app (it carries the compensated values) and run that.");
    }
  }

  const scales = new ChannelScales();
  const activeIdx = Math.min(Math.max(0, ws.activeSample), samples.length - 1);
  restoreChannelScales(scales, samples, ws.samples, activeIdx);
  for (const sample of samples) sample.attachChannelScales(scales);

  const fileHierarchies: Record<string, string> = {};
  const fileGroups: Record<string, string> = {};
  ws.samples.forEach((wss, index) => {
    if (wss.hierarchyId) fileHierarchies[fileIds[index]] = wss.hierarchyId;
    if (wss.groupId) fileGroups[fileIds[index]] = wss.groupId;
  });
  const state = coreReducer(initialCoreState(), {
    type: "loadWorkspace",
    gates: ws.gating.gates,
    gate_order: ws.gating.gate_order,
    populations: ws.gating.populations,
    root_population_id: ws.gating.root_population_id,
    active_population_id: ws.gating.active_population_id,
    selected_gate_id: ws.gating.selected_gate_id,
    hierarchies: ws.gating.hierarchies,
    active_hierarchy_id: ws.gating.active_hierarchy_id,
    stored_hierarchies: ws.gating.stored_hierarchies?.map((h) => restoreStoredHierarchy(h, ws.gating.gates)),
    // A workspace saved with per-file hierarchies off meant every file on the first tree.
    file_hierarchies: ws.gating.perFileHierarchies === true ? fileHierarchies : {},
    groups: ws.gating.groups ?? [],
    file_groups: fileGroups,
  });

  return ws.samples.map((wss, index) => {
    const hierarchyId = fileHierarchyId(state.file_hierarchies[fileIds[index]], state.hierarchies);
    const hierarchy = state.hierarchies.find((h) => h.id === hierarchyId);
    const tree = treeOf(state, hierarchyId);
    const fileNotes = [...notes];
    if (!tree) fileNotes.push(`${wss.fileName} is gated under "${hierarchy?.name ?? hierarchyId}", which holds no tree.`);
    return {
      file: wss.fileName,
      sample: samples[index],
      tree: tree ?? { gates: {}, gate_order: [], populations: {}, root_population_id: "" },
      hierarchy: hierarchy?.name ?? hierarchyId,
      source: { kind: "gatelab" as const, detail: `GateLab workspace ${workspacePath} (${storage === "bundle" ? "portable" : "linked FCS"})` },
      notes: fileNotes,
      refusals: [],
      compensation: { enabled: samples[index].compensationEnabled, resolution: "as saved" },
    };
  });
}
