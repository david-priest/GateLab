// headless.ts — GateLab's engine without the app: open FCS files, put a gating tree on them the way
// the app's import does, and read every population's membership and counts.
//
// The app's own import is a chain of steps inside App.tsx (prepareGatingImportFromGatingML,
// applyGatingImport, openWorkspaceFromEnvelope), interleaved with dialogs. This module takes the
// same engine calls in the same order, with each question the app would ask answered by an option
// or refused, and evaluates through the store's own reducer and recompute, so a count here is the
// count the app shows for the file opened alone. Nothing in the frozen engine is changed or copied.
//
// Anything the import leaves out is collected as a refusal rather than dropped: a population left
// out of a Gating-ML file, a gate on a channel the file lacks, a gate whose $PnG could not be
// restated, a Cytobank compensation the file does not carry, or anything a FlowJo workspace's
// conversion skipped or altered. The caller decides whether a refusal stops the run (cli.ts does,
// unless told otherwise); it is never silent.

import { parseFcs, FcsMultipleDataSetsError } from "../engine/fcs";
import { Sample, maxCoefficientDelta } from "../engine/sample";
import type { DisplaySpillover } from "../engine/compensation";
import {
  importGatingML,
  resolveGatingMLCompensation,
  restoreGatingMLScaleState,
  gatingMLImportOptionsFor,
  fcsDeclaresCompensation,
  cytobankTailoredFiles,
  cytobankDocumentForFile,
  type GatingMLResult,
  type GatingMLCompensationResolution,
} from "../engine/gatingml";
import { gatingMlGains } from "../engine/gatingmlGain";
import {
  isFlowJoWorkspace,
  listFlowJoWorkspaceSamples,
  flowJoWorkspaceToGatingML,
  type FlowJoSampleSummary,
  type FlowJoSpillover,
} from "../engine/flowjoWorkspace";
import { pairFile, sameFileName, identityKeywords } from "../engine/fileIdentity";
import { populationTreeOrder } from "../engine/populations";
import { exportPopulationFcs, type FcsExportAssay } from "../engine/fcsExport";
import type { Gate, PopulationMap } from "../engine/models";
import { coreReducer, initialCoreState, recomputeOwnTreeGating } from "../store";

/** The parts of a tree that gating reads. */
export interface GatingTree {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export type GatingSourceKind = "gatingml" | "flowjo" | "gatelab";

/** Something the import left out or could not do as the file asks. */
export interface Refusal {
  kind:
    | "population-left-out"
    | "gate-skipped"
    | "channel-unmatched"
    | "gain-unconverted"
    | "missing-compensation"
    | "flowjo-conversion";
  message: string;
}

export interface OpenOptions {
  /** As the app's instrument switch: detected from the file unless set. */
  instrument?: "auto" | "flow" | "cytof";
  /** The CyTOF arcsinh cofactor, where it is not the default (5). */
  cytofCofactor?: number;
  /** For a file holding several data sets: which one (0-based). */
  dataSet?: number;
}

export interface ImportOptions {
  /**
   * When a FlowJo workspace or a Gating-ML file brings a matrix that differs from the FCS file's
   * own, which one the gates are evaluated under: the app asks, and defaults to "workspace".
   */
  matrixChoice?: "workspace" | "file";
  /** A FlowJo workspace's sample to take, by 1-based position or by name, instead of pairing. */
  wspSample?: string;
  /** A FlowJo sample's tree, by 1-based position or by name, when the sample holds several. */
  wspTree?: string;
}

/** One FCS file with the tree it is gated under. */
export interface GatedFile {
  /** The file's name as given (an FCS argument, or the name a workspace records). */
  file: string;
  sample: Sample;
  tree: GatingTree;
  /** The hierarchy a workspace gates this file under, by name; null for an imported tree. */
  hierarchy: string | null;
  source: { kind: GatingSourceKind; detail: string };
  /** What the import said that is not a refusal: compensation, gains, tailoring. */
  notes: string[];
  refusals: Refusal[];
  compensation: { enabled: boolean; resolution: string };
  /** FlowJo's own count per population name, for a workspace import. */
  flowJoCounts?: Record<string, number>;
}

/** One population of one file. */
export interface PopulationCount {
  file: string;
  hierarchy: string | null;
  populationId: string;
  population: string;
  /** Names from the top of the tree down to this population, the root excluded. */
  path: string[];
  parentId: string | null;
  events: number;
  parentEvents: number;
  totalEvents: number;
  /** FlowJo's own count for a population of that name, for a workspace import; else undefined. */
  flowJoEvents?: number | null;
}

export class HeadlessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadlessError";
  }
}

// ── Opening a file ───────────────────────────────────────────────────────────────────────────

/** An ArrayBuffer holding exactly these bytes, without a copy when they already are one. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

/** A Sample as the app's createEntry makes one, with the instrument and cofactor it is told. */
export function openFcs(bytes: Uint8Array, name: string, opts: OpenOptions = {}): Sample {
  let sample: Sample;
  try {
    sample = new Sample(opts.dataSet === undefined ? parseFcs(ownBuffer(bytes)) : parseFcs(ownBuffer(bytes), { dataSet: opts.dataSet }));
  } catch (e) {
    if (e instanceof FcsMultipleDataSetsError) {
      throw new HeadlessError(`${name}: ${e.message} Choose one with --data-set (0 to ${e.dataSets.length - 1}).`);
    }
    throw new HeadlessError(`${name}: could not be read as FCS: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (opts.instrument === "flow" || opts.instrument === "cytof") sample.setInstrumentMode(opts.instrument);
  if (opts.cytofCofactor !== undefined) {
    if (!(Number.isFinite(opts.cytofCofactor) && opts.cytofCofactor > 0)) throw new HeadlessError("The CyTOF cofactor must be a positive number.");
    sample.setCytofCofactor(opts.cytofCofactor);
  }
  return sample;
}

// ── Importing a Gating-ML file or a FlowJo workspace onto one file ───────────────────────────

/** Which kind of tree a text holds: a FlowJo workspace, or Gating-ML (standard or Cytobank). */
export function gatingTextKind(text: string): "flowjo" | "gatingml" {
  return isFlowJoWorkspace(text) ? "flowjo" : "gatingml";
}

/** The matrix the gates are evaluated with, as the app's appliedImportMatrix decides it. */
function appliedImportMatrix(sample: Sample, external: DisplaySpillover | null, choice: "workspace" | "file"): DisplaySpillover | null {
  if (!external) return null;
  const differs = sample.spillover !== null && maxCoefficientDelta(sample.spillover, external) > 1e-6;
  return differs && choice === "file" ? null : external;
}

/** What a Gating-ML result left out, each as a refusal. */
function resultRefusals(res: GatingMLResult): Refusal[] {
  const out: Refusal[] = [];
  for (const w of res.warnings ?? []) out.push({ kind: "population-left-out", message: w });
  if (res.skipped_channels?.length) {
    out.push({ kind: "channel-unmatched", message: `Gates on channels not in the file were skipped: ${res.skipped_channels.join(", ")}.` });
  }
  // Every population left out is named above; a count of skipped gates without a name is still said.
  if (res.n_gates_skipped > 0 && !res.warnings?.length && !res.skipped_channels?.length) {
    out.push({ kind: "gate-skipped", message: `${res.n_gates_skipped} gate(s) could not be imported.` });
  }
  if (res.gain?.unconverted.length) {
    out.push({ kind: "gain-unconverted", message: `Not converted from Gating-ML scale values by $PnG: ${res.gain.unconverted.join(", ")}.` });
  }
  if (res.missing_compensation) {
    const m = res.missing_compensation;
    out.push({
      kind: "missing-compensation",
      message: `Gates drawn under Cytobank compensation ${m.id}, which the file does not carry: ${m.gates.join(", ")}. ` +
        "The app asks for that matrix; the headless import cannot supply it.",
    });
  }
  return out;
}

/** Choose a FlowJo workspace's sample for a file, by pairing (name and identity) or by the option. */
function chooseWspSample(samples: readonly FlowJoSampleSummary[], fileName: string, keywords: Record<string, string>, wanted?: string): FlowJoSampleSummary {
  const list = () => samples.map((s) => `${s.index + 1}: ${s.name}`).join("; ");
  if (wanted !== undefined) {
    const byIndex = /^\d+$/.test(wanted) ? samples.find((s) => s.index === Number(wanted) - 1) : undefined;
    const byName = samples.filter((s) => s.name === wanted || sameFileName(s.name, wanted));
    if (byIndex) return byIndex;
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new HeadlessError(`Several workspace samples are named "${wanted}"; give its position instead (${list()}).`);
    throw new HeadlessError(`The workspace has no sample "${wanted}" (${list()}).`);
  }
  const pairing = pairFile({ name: fileName, keywords }, samples, (s) => [s.name, ...s.candidateFileNames], (s) => s.recorded ?? {});
  if (pairing.kind === "own") return pairing.sample;
  if (pairing.kind === "ambiguous") {
    throw new HeadlessError(`${fileName}: several workspace samples could be this file (${pairing.candidates.map((c) => `${c.sample.index + 1}: ${c.sample.name}`).join("; ")}); choose one with --wsp-sample.`);
  }
  if (pairing.kind === "contradicted") {
    throw new HeadlessError(`${fileName}: the workspace samples named like it record another acquisition (${pairing.candidates.map((c) => `${c.sample.index + 1}: ${c.sample.name}`).join("; ")}); choose one with --wsp-sample if it is the file.`);
  }
  throw new HeadlessError(`${fileName}: no sample in the workspace is this file (${list()}); choose one with --wsp-sample.`);
}

/** The tree of a FlowJo sample to import: its only one, or the one asked for. */
function chooseWspTree(sample: FlowJoSampleSummary, wanted?: string): number | null {
  if (wanted === undefined) {
    if (sample.trees.length > 1) {
      throw new HeadlessError(`Workspace sample "${sample.name}" holds ${sample.trees.length} independent trees (${sample.trees.map((t) => `${t.index + 1}: ${t.name}`).join("; ")}); choose one with --wsp-tree.`);
    }
    return null;
  }
  const byIndex = /^\d+$/.test(wanted) ? sample.trees.find((t) => t.index === Number(wanted) - 1) : undefined;
  const byName = sample.trees.filter((t) => t.name === wanted);
  if (byIndex) return byIndex.index;
  if (byName.length === 1) return byName[0].index;
  throw new HeadlessError(`Workspace sample "${sample.name}" has no single tree "${wanted}" (${sample.trees.map((t) => `${t.index + 1}: ${t.name}`).join("; ")}).`);
}

/**
 * Put the tree a Gating-ML file or a FlowJo workspace holds onto one sample, as the app imports it
 * onto the viewed file with nothing else loaded, replacing any tree. The sample's compensation and
 * scales are set as the import sets them.
 */
export function importGatingOnto(sample: Sample, fileName: string, text: string, sourcePath: string, opts: ImportOptions = {}): GatedFile {
  const choice = opts.matrixChoice ?? "workspace";
  const notes: string[] = [];
  const refusals: Refusal[] = [];
  let gatingMl: string;
  let workspaceSpillover: FlowJoSpillover | null = null;
  let flowJoCounts: Record<string, number> | undefined;
  const kind: "gatingml" | "flowjo" = gatingTextKind(text);
  let detail: string;

  if (kind === "flowjo") {
    const wsSamples = listFlowJoWorkspaceSamples(text);
    const chosen = chooseWspSample(wsSamples, fileName, sample.fcs.keywords, opts.wspSample);
    const treeIndex = chooseWspTree(chosen, opts.wspTree);
    // FlowJo's grid, as the app asks for it (and as is the default).
    const conv = flowJoWorkspaceToGatingML(text, chosen.index, treeIndex, undefined, { flowJoGrid: true });
    for (const w of conv.warnings) refusals.push({ kind: "flowjo-conversion", message: w });
    gatingMl = conv.gatingMl;
    workspaceSpillover = conv.spillover ?? null;
    flowJoCounts = conv.flowJoCounts;
    detail = `FlowJo workspace ${sourcePath}, sample ${chosen.index + 1} "${chosen.name}"`;
  } else {
    // A Cytobank file can carry gates tailored per FCS file; the file's own go onto it, and no
    // file's go into the tree (App.tsx, the Cytobank branch of the gating open).
    const tailored = cytobankTailoredFiles(text);
    const own = tailored.find((f) => sameFileName(f.fileName, fileName));
    gatingMl = tailored.length ? cytobankDocumentForFile(text, own ? own.fileName : null) : text;
    if (own) notes.push(`Cytobank tailored ${own.gates} gate(s) for this file; its own coordinates were used.`);
    detail = `Gating-ML ${sourcePath}`;
  }

  const pnnMap: Record<string, string> = {};
  for (const c of sample.channels) pnnMap[c.pnn] = c.key;
  const workspaceMatrix = workspaceSpillover && sample.instrument === "flow"
    ? sample.externalSpilloverPreview(workspaceSpillover.matrix).display
    : null;
  // A standard Gating-ML file states coordinates on scale values, stored value / $PnG; a converted
  // FlowJo strategy is already on stored values (gatingmlGain.ts).
  const gains = kind === "gatingml" ? gatingMlGains(sample) : null;
  let res: GatingMLResult;
  try {
    res = importGatingML(
      gatingMl, sample.channels.map((c) => c.key), pnnMap, sample.instrument,
      { ...gatingMLImportOptionsFor(sample, appliedImportMatrix(sample, workspaceMatrix, choice)), ...(gains?.size ? { gains } : {}) });
  } catch (e) {
    // Gates on channels the file lacks stop the import, with the gates and channels named.
    throw new HeadlessError(`${fileName}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (kind === "gatingml" && res.source === "cytobank") detail = `Cytobank Gating-ML ${sourcePath}`;
  refusals.push(...resultRefusals(res));
  if (res.gain?.converted.length) notes.push(`${res.gain.converted.length} gate(s) converted from Gating-ML scale values by $PnG.`);

  // The matrix the gates were drawn under: the workspace's, else one the Gating-ML file defines.
  const fileMatrix: FlowJoSpillover | null = !workspaceSpillover && res.spectrum_matrix
    ? { name: res.spectrum_matrix.name, prefix: "", suffix: "", matrix: { channels: res.spectrum_matrix.channels, matrix: res.spectrum_matrix.matrix } }
    : null;
  const gatesMatrix = workspaceSpillover ?? fileMatrix;
  const external = gatesMatrix && sample.instrument === "flow" ? sample.externalSpilloverPreview(gatesMatrix.matrix) : null;
  if (external?.dropped.length) {
    notes.push(`The ${fileMatrix ? "Gating-ML file's" : "workspace's"} matrix names parameters the file lacks, left out of it: ${external.dropped.join(", ")}.`);
  }
  const comp: GatingMLCompensationResolution = resolveGatingMLCompensation(
    res.compensation, res.compensation_refs, sample.instrument === "flow",
    external?.display ?? sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) });
  if (comp.note) notes.push(comp.note);
  // The app asks before a change of compensation its dialog cannot settle by itself; here it is
  // made, and said.
  if (comp.requiresConfirmation) notes.push(`The app asks to confirm this compensation (${describeCompensation(comp)}); it was applied.`);
  const differs = external?.display != null && sample.spillover !== null && maxCoefficientDelta(sample.spillover, external.display) > 1e-6;
  if (comp.target === true && external?.display != null && !(differs && choice === "file")) {
    sample.installExternalSpillover(gatesMatrix!.matrix, gatesMatrix!.name || (fileMatrix ? "the Gating-ML file" : "the FlowJo workspace"), { replaceEmbedded: sample.spillover !== null });
    notes.push(`Compensated with ${fileMatrix ? "the Gating-ML file's" : "the workspace's"} matrix "${gatesMatrix!.name}"${differs ? ", which differs from the FCS file's own" : ""}.`);
  } else if (differs && comp.target === true) {
    notes.push(`The ${fileMatrix ? "Gating-ML file's" : "workspace's"} matrix differs from the FCS file's own; the file's was kept (--matrix file).`);
  }
  if (comp.target !== null) {
    sample.setCompensation(comp.target);
    if (sample.compensationEnabled !== comp.target) {
      throw new HeadlessError(`${fileName}: the spillover matrix could not be applied, so the gating strategy was not imported.`);
    }
  }
  restoreGatingMLScaleState(sample, res.scales, res.cytof_cofactor);

  // The store's own import, replacing any tree, as applyGatingImport dispatches it.
  const state = coreReducer(initialCoreState(), {
    type: "importGating", gates: res.gates, gate_order: res.gate_order, populations: res.populations,
    root_population_id: res.root_population_id, mode: "replace", clearHistory: true,
  });
  return {
    file: fileName,
    sample,
    tree: { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id! },
    hierarchy: null,
    source: { kind, detail },
    notes,
    refusals,
    compensation: { enabled: sample.compensationEnabled, resolution: describeCompensation(comp) },
    ...(flowJoCounts ? { flowJoCounts } : {}),
  };
}

function describeCompensation(c: GatingMLCompensationResolution): string {
  const target = c.target === null ? "left as the file opened" : c.target ? "on" : "off";
  return `${target} (${c.source})`;
}

// ── Reading memberships ──────────────────────────────────────────────────────────────────────

/** Every population's membership for one file, by population id, the root included. */
export function memberships(g: GatedFile): Record<string, Uint8Array> {
  return recomputeOwnTreeGating(g.sample, g.tree).masks;
}

/** The populations of a tree in the app's tree order, root excluded, each with its path. */
export function treePopulations(tree: GatingTree): { id: string; name: string; path: string[]; parentId: string | null }[] {
  const out: { id: string; name: string; path: string[]; parentId: string | null }[] = [];
  const pathOf = new Map<string, string[]>([[tree.root_population_id, []]]);
  for (const { popId } of populationTreeOrder(tree.populations, tree.root_population_id)) {
    if (popId === tree.root_population_id) continue;
    const pop = tree.populations[popId];
    const parent = pop.parent_id ?? tree.root_population_id;
    const path = [...(pathOf.get(parent) ?? []), pop.name];
    pathOf.set(popId, path);
    out.push({ id: popId, name: pop.name, path, parentId: parent === tree.root_population_id ? null : parent });
  }
  return out;
}

function countOf(mask: Uint8Array | undefined): number {
  let n = 0;
  if (mask) for (let i = 0; i < mask.length; i++) n += mask[i] ? 1 : 0;
  return n;
}

/** Each population's count in one file, with its parent's and the file's total. */
export function populationCounts(g: GatedFile, masks: Record<string, Uint8Array> = memberships(g)): PopulationCount[] {
  const total = g.sample.fcs.nEvents;
  const counts = new Map<string, number>();
  const count = (id: string) => {
    let n = counts.get(id);
    if (n === undefined) {
      n = id === g.tree.root_population_id ? total : countOf(masks[id]);
      counts.set(id, n);
    }
    return n;
  };
  return treePopulations(g.tree).map((p) => ({
    file: g.file,
    hierarchy: g.hierarchy,
    populationId: p.id,
    population: p.name,
    path: p.path,
    parentId: p.parentId,
    events: count(p.id),
    parentEvents: count(p.parentId ?? g.tree.root_population_id),
    totalEvents: total,
    ...(g.flowJoCounts ? { flowJoEvents: Object.prototype.hasOwnProperty.call(g.flowJoCounts, p.name) ? g.flowJoCounts[p.name] : null } : {}),
  }));
}

/**
 * The population a selector names in a tree: a full path ("A > B > C"), or a name only one
 * population carries. Unmatched or ambiguous selectors are refused with what they could mean.
 */
export function findPopulation(tree: GatingTree, selector: string): string {
  const pops = treePopulations(tree);
  const want = selector.split(">").map((s) => s.trim()).filter(Boolean);
  if (!want.length) throw new HeadlessError("An empty population selector names nothing.");
  const byPath = pops.filter((p) => p.path.length === want.length && p.path.every((n, i) => n.trim() === want[i]));
  if (byPath.length === 1) return byPath[0].id;
  if (want.length === 1) {
    const byName = pops.filter((p) => p.name.trim() === want[0]);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) {
      throw new HeadlessError(`"${selector}" names ${byName.length} populations; give the path: ${byName.map((p) => p.path.join(" > ")).join("; ")}.`);
    }
  }
  if (byPath.length > 1) throw new HeadlessError(`"${selector}" names ${byPath.length} populations of the same path.`);
  throw new HeadlessError(`No population "${selector}" in the tree.`);
}

/** One population's events as an FCS file, through the app's own export. */
export function populationFcs(g: GatedFile, mask: Uint8Array, assay: FcsExportAssay): Uint8Array {
  return exportPopulationFcs(g.sample, mask, assay);
}

/** Bits least significant first, as the agent MCP's reference masks pack them, in base64. */
export function packMembership(mask: Uint8Array): string {
  const packed = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) if (mask[i]) packed[i >> 3] |= 1 << (i % 8);
  let bin = "";
  for (let i = 0; i < packed.length; i += 0x8000) bin += String.fromCharCode(...packed.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What a file recorded about its acquisition, for the report. */
export function fileIdentity(sample: Sample): Record<string, string> {
  return identityKeywords(sample.fcs.keywords) as Record<string, string>;
}
