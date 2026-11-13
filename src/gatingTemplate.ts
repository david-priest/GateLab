// gatingTemplate.ts — a workspace's gating tree as a file of its own, to apply to other files
// exactly: every gate kind as GateLab stores it (curly and spider quadrants included, which
// Gating-ML cannot write), the populations with their NOT and OR logic, the gate order, and the
// channels the gates read, so another experiment's files can take the tree without loss (David,
// 2026-11-10; LabNotes/Coding/GateLab "exact gating template export and import, plan").
//
// Outside src/engine on purpose: it composes exported engine functions and changes none of them,
// so the engine freeze is not touched.

import { validateGate, type Gate, type PopulationMap, type TransformSpec } from "./engine/models";
import type { Sample } from "./engine/sample";
import { maxCoefficientDelta } from "./engine/sample";
import { resolveChannels, type ResolvedChannel } from "./engine/channels";
import { parseFcs } from "./engine/fcs";
import { readWorkspaceEnvelope } from "./engine/workspace";
import { resolveChannel, type GatingMLResult, type GatingMLScaleEntry } from "./engine/gatingml";
import { onChannels } from "./engine/tailoredImport";
import { gateChannelKeys } from "./engine/workspaceChannelKeys";
import { templateOf } from "./engine/groups";
import type { HierarchyRef } from "./engine/hierarchies";
import { isScatterChannel } from "./engine/transforms";

export const GATING_TEMPLATE_FORMAT = "gatelab-gating-template";
export const GATING_TEMPLATE_VERSION = 1;
export const GATING_TEMPLATE_EXTENSION = ".gatelabtree";
/** What the file picker for a template accepts: a template, or a saved workspace read as one. */
export const GATING_TEMPLATE_ACCEPT = ".gatelabtree,.gatelab,.json,application/json,application/zip";

/** A channel a template's gates read, as the file it was drawn on named it. */
export interface TemplateChannel {
  /** The session key the gates name. */
  key: string;
  /** $PnN; the key itself when the source did not say. */
  pnn: string;
  /** $PnS; null when there was none or the source did not say. */
  marker: string | null;
}

/** The compensation the template's gates were drawn under, on the file it was exported from. */
export interface TemplateCompensation {
  enabled: boolean;
  /**
   * fcs: the file's own $SPILLOVER; external: a matrix installed from a FlowJo workspace or a
   * Gating-ML file; profile: a compensation profile, whose matrix the template does not carry;
   * none: compensation was off.
   */
  origin: "fcs" | "external" | "profile" | "none";
  label: string | null;
  /** The matrix over $PnN, in FCS $SPILLOVER orientation; null when not carried. */
  matrix: { channels: string[]; matrix: number[][] } | null;
}

export interface GatingTemplateTree {
  name: string;
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

export interface GatingTemplate {
  format: typeof GATING_TEMPLATE_FORMAT;
  version: typeof GATING_TEMPLATE_VERSION;
  app: string;
  savedAt: string;
  /** The source file's instrument; null when a workspace saved by reference does not say. */
  source: { workspaceId: string | null; fileName: string | null; files: number; instrument: "flow" | "cytof" | null };
  tree: GatingTemplateTree;
  channels: TemplateChannel[];
  /** The source file's axes, keyed by its channel keys; null when not carried. Display only. */
  scales: Record<string, GatingMLScaleEntry> | null;
  cytof_cofactor: number | null;
  /** Null on mass cytometry, which has no spillover matrix in this sense. */
  compensation: TemplateCompensation | null;
  /** Gates whose display transforms were written into them at export, by name. */
  fixed_transforms: string[];
  /** What the export could not carry, said again when the template is applied. */
  notes: string[];
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Every gate with its space stated, and every display-space gate with the transform of each axis
 * it was evaluated with written into it. An axis a display gate records no transform for is read
 * in the file's gating space (sample.ts gatingDataFor, gatingColumn): raw values on flow, the
 * current display on mass cytometry, so it follows the axes of whichever file it is evaluated on.
 * Written into the gate, the gate holds the same raw values in any workspace, whatever that
 * workspace's axes. `transformOf` gives that reading; see gatingSpaceTransform.
 */
export function fixGateSpaces(
  gates: Record<string, Gate>,
  defaultSpace: "raw" | "display",
  transformOf: (channel: string) => TransformSpec,
): { gates: Record<string, Gate>; fixed: string[] } {
  const out: Record<string, Gate> = {};
  const fixed: string[] = [];
  for (const [id, gate] of Object.entries(gates)) {
    const space = gate.space ?? defaultSpace;
    if (space === "raw") {
      out[id] = { ...gate, space } as Gate;
      continue;
    }
    const axes = [...new Set([gate.x_channel, gate.y_channel])];
    const lacking = axes.filter((ch) => !gate.transforms?.[ch]);
    if (!lacking.length) {
      out[id] = { ...gate, space } as Gate;
      continue;
    }
    const transforms: Record<string, TransformSpec> = { ...(gate.transforms ?? {}) };
    for (const ch of lacking) transforms[ch] = transformOf(ch);
    out[id] = { ...gate, space, transforms } as Gate;
    fixed.push(gate.name);
  }
  return { gates: out, fixed };
}

/** How `sample` reads an axis a display gate records no transform for: its gating column. */
export function gatingSpaceTransform(sample: Pick<Sample, "gatingSpace" | "transformSpec">): (channel: string) => TransformSpec {
  return (channel) => (sample.gatingSpace === "raw" ? { kind: "identity" } : sample.transformSpec(channel));
}

/**
 * How a file of the given gating space read an axis a display gate records no transform for, at
 * the arcsinh cofactor it was shown with (sample.ts gatingDataFor, gatingColumn): raw values on
 * flow, arcsinh at the cofactor on mass cytometry. Needs nothing from the FCS file.
 */
export function legacyAxisTransform(gatingSpace: "raw" | "display", cofactor: number): () => TransformSpec {
  return () => (gatingSpace === "raw" ? { kind: "identity" } : { kind: "asinh", cofactor });
}

/** The channels the tree's gates read, as `channels` names them; key alone where it lacks one. */
function templateChannelsOf(gates: Record<string, Gate>, channels: readonly Pick<ResolvedChannel, "key" | "pnn" | "marker">[]): TemplateChannel[] {
  return [...gateChannelKeys(gates)].sort().map((key) => {
    const c = channels.find((ch) => ch.key === key);
    return { key, pnn: c?.pnn || key, marker: c?.marker?.trim() || null };
  });
}

/** The viewed file's axes, as Gating-ML's scale record states them (gatingml.ts GatingMLScaleEntry). */
function scalesOf(sample: Sample, globalScales: Record<string, [number, number]>): Record<string, GatingMLScaleEntry> {
  const out: Record<string, GatingMLScaleEntry> = {};
  sample.channels.forEach((c, idx) => {
    const entry: GatingMLScaleEntry = {};
    const kind = sample.transformKind(idx);
    if (kind === "logicle") entry.w = sample.currentLogicleW(idx);
    else if (kind === "asinh" && sample.instrument === "flow") {
      entry.cofactor = isScatterChannel(c.key) ? sample.currentScatterCofactor(idx) : sample.currentFluorCofactor(idx);
    }
    if (sample.instrument === "flow" && sample.isFluorChannel(idx)) {
      const biex = sample.fluorBiexParams(idx);
      if (biex) entry.biex = biex;
    }
    const range = globalScales[c.key];
    if (range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]) {
      entry.lo = range[0];
      entry.hi = range[1];
      const rawLo = sample.displayToRaw(c.key, range[0]);
      const rawHi = sample.displayToRaw(c.key, range[1]);
      if (Number.isFinite(rawLo) && Number.isFinite(rawHi) && rawHi > rawLo) {
        entry.raw_lo = rawLo;
        entry.raw_hi = rawHi;
      }
    }
    if (Object.keys(entry).length) out[c.key] = entry;
  });
  return out;
}

/** The compensation the viewed file is gated under, with its matrix over $PnN where it is carried. */
function compensationOf(sample: Sample): TemplateCompensation | null {
  if (sample.instrument !== "flow") return null;
  if (!sample.compensationEnabled) return { enabled: false, origin: "none", label: null, matrix: null };
  if (!sample.embeddedCompensationEnabled) return { enabled: true, origin: "profile", label: null, matrix: null };
  const external = sample.externalSpillover;
  if (external) {
    return { enabled: true, origin: "external", label: external.label, matrix: { channels: [...external.channels], matrix: external.matrix.map((row) => [...row]) } };
  }
  const own = sample.spillover;
  if (!own) return { enabled: true, origin: "fcs", label: null, matrix: null };
  const pnnOf = new Map(sample.channels.map((c) => [c.key, c.pnn]));
  return {
    enabled: true, origin: "fcs", label: null,
    matrix: { channels: own.channels.map((key) => pnnOf.get(key) ?? key), matrix: own.matrix.map((row) => [...row]) },
  };
}

/** The tree in the workspace, as the viewed file gates it, written as a template. */
export function buildGatingTemplate(opts: {
  tree: GatingTemplateTree;
  sample: Sample;
  globalScales: Record<string, [number, number]>;
  app: string;
  workspaceId: string | null;
  fileName: string | null;
  files: number;
  savedAt?: string;
}): GatingTemplate {
  const { sample } = opts;
  const { gates, fixed } = fixGateSpaces(opts.tree.gates, sample.gatingSpace, gatingSpaceTransform(sample));
  const compensation = compensationOf(sample);
  const notes: string[] = [];
  if (compensation?.origin === "profile") {
    notes.push("The gates were drawn under a compensation profile, whose matrix the template does not carry; each file it is applied to is compensated with its own matrix.");
  }
  return {
    format: GATING_TEMPLATE_FORMAT,
    version: GATING_TEMPLATE_VERSION,
    app: opts.app,
    savedAt: opts.savedAt ?? new Date().toISOString(),
    source: { workspaceId: opts.workspaceId, fileName: opts.fileName, files: opts.files, instrument: sample.instrument },
    tree: { ...opts.tree, gates },
    channels: templateChannelsOf(gates, sample.channels),
    scales: scalesOf(sample, opts.globalScales),
    cytof_cofactor: sample.instrument === "cytof" ? sample.arcsinhCofactor : null,
    compensation,
    fixed_transforms: fixed,
    notes,
  };
}

export function serializeGatingTemplate(template: GatingTemplate): string {
  return JSON.stringify(template, null, 1);
}

// ── Reading ──────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The tree checked as GateLab checks gates (models.ts validateGate): every population's parent and
 * gate references present, the root present, the gate order naming only gates.
 */
function checkedTree(raw: unknown, what: string): GatingTemplateTree {
  if (!isRecord(raw)) throw new Error(`${what}: the gating tree is missing.`);
  const { gates, gate_order, populations, root_population_id } = raw as Partial<GatingTemplateTree>;
  if (!isRecord(gates) || !Array.isArray(gate_order) || !isRecord(populations) || typeof root_population_id !== "string") {
    throw new Error(`${what}: the gating tree is incomplete.`);
  }
  if (!populations[root_population_id]) throw new Error(`${what}: the tree's root population is missing.`);
  for (const [id, gate] of Object.entries(gates)) {
    if (!isRecord(gate) || gate.gate_id !== id) throw new Error(`${what}: gate ${id} is malformed.`);
    try {
      validateGate(gate as unknown as Gate);
    } catch (e) {
      throw new Error(`${what}: gate "${String(gate.name ?? id)}" is not valid: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const id of gate_order) if (!gates[id]) throw new Error(`${what}: the gate order names a gate it does not hold (${id}).`);
  for (const [id, pop] of Object.entries(populations)) {
    if (!isRecord(pop) || !Array.isArray(pop.gate_refs)) throw new Error(`${what}: population ${id} is malformed.`);
    for (const ref of pop.gate_refs as { gate_id?: unknown }[]) {
      if (typeof ref?.gate_id !== "string" || !gates[ref.gate_id]) {
        throw new Error(`${what}: population "${String(pop.name ?? id)}" uses a gate the tree does not hold.`);
      }
    }
    const parent = pop.parent_id;
    if (id !== root_population_id && (typeof parent !== "string" || !populations[parent])) {
      throw new Error(`${what}: population "${String(pop.name ?? id)}" has no parent in the tree.`);
    }
  }
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Imported tree",
    gates: gates as Record<string, Gate>,
    gate_order: [...gate_order] as string[],
    populations: populations as PopulationMap,
    root_population_id,
  };
}

/** A template file's text, checked; throws naming what is wrong. */
export function parseGatingTemplate(text: string): GatingTemplate {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a GateLab gating template: the file is not JSON.");
  }
  if (!isRecord(raw) || raw.format !== GATING_TEMPLATE_FORMAT) throw new Error("Not a GateLab gating template.");
  if (raw.version !== GATING_TEMPLATE_VERSION) {
    throw new Error(`This gating template is version ${String(raw.version)}; this GateLab reads version ${GATING_TEMPLATE_VERSION}.`);
  }
  const tree = checkedTree(raw.tree, "Gating template");
  const channels = Array.isArray(raw.channels)
    ? (raw.channels as unknown[]).flatMap((c) => (isRecord(c) && typeof c.key === "string"
        ? [{ key: c.key, pnn: typeof c.pnn === "string" && c.pnn ? c.pnn : c.key, marker: typeof c.marker === "string" && c.marker.trim() ? c.marker.trim() : null }]
        : []))
    : [];
  // A channel a gate reads that the list leaves out is named by its key alone.
  for (const key of gateChannelKeys(tree.gates)) if (!channels.some((c) => c.key === key)) channels.push({ key, pnn: key, marker: null });
  const source = isRecord(raw.source) ? raw.source : {};
  const comp = isRecord(raw.compensation) ? raw.compensation : null;
  const matrix = comp && isRecord(comp.matrix) && Array.isArray(comp.matrix.channels) && Array.isArray(comp.matrix.matrix)
    ? { channels: (comp.matrix.channels as unknown[]).map(String), matrix: (comp.matrix.matrix as unknown[][]).map((row) => row.map(Number)) }
    : null;
  return {
    format: GATING_TEMPLATE_FORMAT,
    version: GATING_TEMPLATE_VERSION,
    app: typeof raw.app === "string" ? raw.app : "",
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    source: {
      workspaceId: typeof source.workspaceId === "string" ? source.workspaceId : null,
      fileName: typeof source.fileName === "string" ? source.fileName : null,
      files: typeof source.files === "number" ? source.files : 0,
      instrument: source.instrument === "cytof" || source.instrument === "flow" ? source.instrument : null,
    },
    tree,
    channels,
    scales: isRecord(raw.scales) ? (raw.scales as Record<string, GatingMLScaleEntry>) : null,
    cytof_cofactor: typeof raw.cytof_cofactor === "number" ? raw.cytof_cofactor : null,
    compensation: comp
      ? {
          enabled: comp.enabled === true,
          origin: comp.origin === "fcs" || comp.origin === "external" || comp.origin === "profile" ? comp.origin : "none",
          label: typeof comp.label === "string" ? comp.label : null,
          matrix,
        }
      : null,
    fixed_transforms: Array.isArray(raw.fixed_transforms) ? (raw.fixed_transforms as unknown[]).map(String) : [],
    notes: Array.isArray(raw.notes) ? (raw.notes as unknown[]).map(String) : [],
  };
}

/**
 * A saved workspace (`.gatelab`, bundled or by reference) read as a template: the tree the active
 * hierarchy follows (its template where the active one is a file's or a group's copy), and the
 * compensation of the file it was saved viewing. A bundled workspace's FCS gives the channels'
 * $PnN and markers and the file's own matrix; a workspace by reference names channels by key
 * alone. Axis scales are not carried from a workspace.
 */
export function templateFromWorkspace(raw: unknown, activeFcs: ArrayBuffer | null, fileName: string | null): GatingTemplate {
  if (!isRecord(raw) || raw.format !== "gatelab-workspace" || !isRecord(raw.gating) || !Array.isArray(raw.samples)) {
    throw new Error("Not a GateLab workspace.");
  }
  const gating = raw.gating as Record<string, unknown>;
  const refs = (Array.isArray(gating.hierarchies) ? gating.hierarchies : []) as HierarchyRef[];
  const activeId = typeof gating.active_hierarchy_id === "string" ? gating.active_hierarchy_id : refs[0]?.id;
  const tree = activeId ? templateOf(activeId, refs) : null;
  let treeRaw: Record<string, unknown> = { ...gating, name: refs.find((h) => h.id === activeId)?.name };
  if (tree && tree.id !== activeId) {
    const stored = (Array.isArray(gating.stored_hierarchies) ? gating.stored_hierarchies : [])
      .find((h: unknown) => isRecord(h) && h.id === tree.id) as Record<string, unknown> | undefined;
    if (!stored) throw new Error("The workspace's tree could not be found in it.");
    const gates = isRecord(stored.gates) ? stored.gates : gating.gates;
    treeRaw = { ...stored, gates, gate_order: Array.isArray(stored.gate_order) ? stored.gate_order : Object.keys(gates as object), name: tree.name };
  }
  if (typeof treeRaw.root_population_id !== "string") throw new Error("The workspace holds no gating tree.");
  const checked = checkedTree(treeRaw, "Workspace");
  // Only the gates the tree's populations use, in the tree's order.
  const used = new Set(Object.values(checked.populations).flatMap((p) => p.gate_refs.map((r) => r.gate_id)));
  const ordered = checked.gate_order.filter((id) => used.has(id));
  const gates = Object.fromEntries(Object.entries(checked.gates).filter(([id]) => used.has(id) || ordered.includes(id)));

  const samples = raw.samples as Record<string, unknown>[];
  const active = samples[typeof raw.activeSample === "number" ? raw.activeSample : 0] ?? samples[0] ?? {};
  const fcs = activeFcs ? parseFcs(activeFcs) : null;
  const instrumentMode = active.instrumentMode === "flow" || active.instrumentMode === "cytof" ? active.instrumentMode : null;
  // Known from the FCS file of a bundled workspace or from an instrument chosen by hand; a
  // workspace saved by reference, with compensation on, is flow. Otherwise not known here, and
  // the gates' spaces are stated when the template is applied (templateImportResult).
  const instrument: "flow" | "cytof" | null = instrumentMode ?? fcs?.instrument ?? (active.compensationOn === true ? "flow" : null);
  const cofactor = typeof active.cytofCofactor === "number" ? active.cytofCofactor : 5;
  const fixedSpaces = instrument
    ? fixGateSpaces(gates, instrument === "cytof" ? "display" : "raw", legacyAxisTransform(instrument === "cytof" ? "display" : "raw", cofactor))
    : { gates, fixed: [] };
  const notes = ["Axis scales are not carried from a workspace file; the files keep their own."];
  const channels: Pick<ResolvedChannel, "key" | "pnn" | "marker">[] = fcs ? resolveChannels(fcs) : [];
  let compensation: TemplateCompensation | null = null;
  if (instrument !== "cytof") {
    const ext = isRecord(active.externalSpillover) ? active.externalSpillover : null;
    const profile = isRecord(active.assay) && typeof active.assay.profileId === "string";
    if (active.compensationOn !== true) compensation = { enabled: false, origin: "none", label: null, matrix: null };
    else if (profile) compensation = { enabled: true, origin: "profile", label: null, matrix: null };
    else if (ext && Array.isArray(ext.channels) && Array.isArray(ext.matrix)) {
      compensation = { enabled: true, origin: "external", label: typeof ext.label === "string" ? ext.label : null, matrix: { channels: (ext.channels as unknown[]).map(String), matrix: (ext.matrix as number[][]).map((r) => [...r]) } };
    } else {
      compensation = { enabled: true, origin: "fcs", label: null, matrix: fcs?.spillover ? { channels: [...fcs.spillover.channels], matrix: fcs.spillover.matrix.map((r) => [...r]) } : null };
    }
    if (compensation.enabled && !compensation.matrix) {
      notes.push("The workspace does not carry the matrix its gates were compensated with; each file it is applied to is compensated with its own matrix.");
    }
  }
  return {
    format: GATING_TEMPLATE_FORMAT,
    version: GATING_TEMPLATE_VERSION,
    app: typeof raw.app === "string" ? raw.app : "",
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    source: { workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : null, fileName, files: samples.length, instrument },
    tree: { ...checked, gates: fixedSpaces.gates, gate_order: ordered },
    channels: templateChannelsOf(fixedSpaces.gates, channels),
    scales: null,
    cytof_cofactor: instrument === "flow" ? null : cofactor,
    compensation,
    fixed_transforms: fixedSpaces.fixed,
    notes,
  };
}

/** A template file's bytes, or a saved workspace's, read as a template. */
export function readGatingTemplateBytes(bytes: Uint8Array, fileName: string | null): GatingTemplate {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!zip) {
    const text = new TextDecoder().decode(bytes);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error("Not a GateLab gating template or workspace: the file is not JSON or a zip.");
    }
    if (isRecord(raw) && raw.format === GATING_TEMPLATE_FORMAT) return parseGatingTemplate(text);
    return templateFromWorkspace(raw, null, fileName);
  }
  const envelope = readWorkspaceEnvelope(bytes);
  const raw = envelope.raw as Record<string, unknown>;
  const samples = (Array.isArray(raw?.samples) ? raw.samples : []) as Record<string, unknown>[];
  const active = samples[typeof raw?.activeSample === "number" ? raw.activeSample : 0] ?? samples[0];
  const data = active && typeof active.dataPath === "string" ? envelope.fcsByPath?.[active.dataPath] : undefined;
  const buffer = data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer : null;
  return templateFromWorkspace(raw, buffer, fileName);
}

// ── Applying ─────────────────────────────────────────────────────────────────

/** How a template channel was found among the loaded file's: in the order they are tried. */
export type TemplateChannelMatch = "key" | "pnn" | "marker" | "name" | "manual";

export interface TemplateChannelRow {
  channel: TemplateChannel;
  /** The loaded file's channel key, or null when there is none to take. */
  target: string | null;
  by: TemplateChannelMatch | null;
  /** Why there is no target: none found, or more than one, or another template channel's. */
  problem: "missing" | "ambiguous" | "shared" | null;
}

export interface TemplateChannelPlan {
  rows: TemplateChannelRow[];
  /** Template key → loaded key, for every row with a target. */
  map: Map<string, string>;
  ok: boolean;
}

/**
 * Each template channel's channel in the loaded file, taken at the first way that finds one:
 *   1. a hand-picked channel (`manual`);
 *   2. the same session key;
 *   3. the same $PnN;
 *   4. the same marker ($PnS);
 *   5. gatingml.ts resolveChannel on the key, then on the $PnN: case and punctuation ignored and,
 *      on mass cytometry, the same metal.
 * A way that finds two channels refuses the template channel rather than take the first, and two
 * template channels found on one loaded channel are both refused.
 */
export function planTemplateChannels(
  channels: readonly TemplateChannel[],
  target: readonly Pick<ResolvedChannel, "key" | "pnn" | "marker">[],
  instrument: "flow" | "cytof",
  manual: Readonly<Record<string, string>> = {},
): TemplateChannelPlan {
  const keys = target.map((c) => c.key);
  const pnnMap = Object.fromEntries(target.map((c) => [c.pnn, c.key]));
  const rows: TemplateChannelRow[] = channels.map((channel) => {
    const found = (hits: readonly string[], by: TemplateChannelMatch): TemplateChannelRow | null => {
      const distinct = [...new Set(hits)];
      if (!distinct.length) return null;
      return distinct.length === 1
        ? { channel, target: distinct[0], by, problem: null }
        : { channel, target: null, by: null, problem: "ambiguous" };
    };
    const picked = manual[channel.key];
    if (picked !== undefined && keys.includes(picked)) return { channel, target: picked, by: "manual", problem: null };
    return found(keys.filter((k) => k === channel.key), "key")
      ?? found(target.filter((c) => c.pnn === channel.pnn).map((c) => c.key), "pnn")
      ?? (channel.marker ? found(target.filter((c) => c.marker?.trim() === channel.marker).map((c) => c.key), "marker") : null)
      ?? found([resolveChannel(channel.key, keys, pnnMap, instrument) ?? resolveChannel(channel.pnn, keys, pnnMap, instrument)].filter((k): k is string => k !== null), "name")
      ?? { channel, target: null, by: null, problem: "missing" };
  });
  const taken = new Map<string, number>();
  for (const row of rows) if (row.target) taken.set(row.target, (taken.get(row.target) ?? 0) + 1);
  for (const row of rows) {
    if (row.target && (taken.get(row.target) ?? 0) > 1) {
      row.target = null;
      row.by = null;
      row.problem = "shared";
    }
  }
  const map = new Map(rows.flatMap((r) => (r.target ? [[r.channel.key, r.target] as const] : [])));
  return { rows, map, ok: rows.every((r) => r.target !== null) };
}

/** The template's tree on the loaded file's channels: each gate's axes, and everything keyed by them. */
export function templateTreeOnChannels(tree: GatingTemplateTree, map: ReadonlyMap<string, string>): GatingTemplateTree {
  const gates = Object.fromEntries(Object.entries(tree.gates).map(([id, gate]) => [
    id, onChannels(gate, map.get(gate.x_channel) ?? gate.x_channel, map.get(gate.y_channel) ?? gate.y_channel),
  ]));
  return { ...tree, gates };
}

/**
 * The template as an import result, the shape every gating import stages (App.tsx
 * PendingGatingMLImport), so that Replace and Merge, the targets, the checkpoint and the result
 * line are the ones every import has. Scales are restated on the loaded file's keys, and left out
 * when `withScales` is false.
 */
export function templateImportResult(
  template: GatingTemplate,
  plan: TemplateChannelPlan,
  withScales: boolean,
  /** The loaded file's gating space, for gates whose space the template could not state. */
  gatingSpace: "raw" | "display",
): GatingMLResult & { fixed_at_apply: string[] } {
  if (!plan.ok) throw new Error("Every channel the template's gates read must be found in the loaded file before it is applied.");
  const remapped = templateTreeOnChannels(template.tree, plan.map);
  // A template read from a workspace saved by reference states no space for a gate whose space
  // follows the instrument: it is read as a file of this kind reads it, at the template's cofactor.
  const stated = fixGateSpaces(remapped.gates, gatingSpace, legacyAxisTransform(gatingSpace, template.cytof_cofactor ?? 5));
  const tree = { ...remapped, gates: stated.gates };
  const scales = withScales && template.scales
    ? Object.fromEntries(Object.entries(template.scales).map(([key, entry]) => [plan.map.get(key) ?? key, entry]))
    : null;
  return {
    gates: tree.gates,
    gate_order: tree.gate_order,
    populations: tree.populations,
    root_population_id: tree.root_population_id,
    n_gates_imported: Object.keys(tree.gates).length,
    n_gates_skipped: 0,
    skipped_channels: [],
    warnings: [],
    source: "gatelabr",
    n_pops_imported: Math.max(0, Object.keys(tree.populations).length - 1),
    scales,
    cytof_cofactor: withScales ? template.cytof_cofactor : null,
    compensation: null,
    compensation_refs: [],
    spectrum_matrix: null,
    missing_compensation: null,
    fixed_at_apply: stated.fixed,
  };
}

/**
 * The template's compensation set against the loaded file's: what the import turns compensation
 * to (null: leaves it), and the template's matrix where the file should be offered it — the file
 * has none of its own, or its own differs. The file's own is used unless the user chooses the
 * template's (D4 of the plan).
 */
export function templateCompensationFor(template: GatingTemplate, sample: Sample): {
  target: boolean | null;
  offer: { matrix: { channels: string[]; matrix: number[][] }; label: string; dropped: string[]; replacesEmbedded: boolean; differsFromEmbedded: boolean; maxDelta: number | null } | null;
  /** The file has no matrix of its own and the template carries none either. */
  unavailable: boolean;
} {
  const comp = template.compensation;
  if (!comp || sample.instrument !== "flow") return { target: null, offer: null, unavailable: false };
  if (!comp.enabled) return { target: false, offer: null, unavailable: false };
  if (!comp.matrix) return { target: true, offer: null, unavailable: sample.spillover === null };
  const preview = sample.externalSpilloverPreview(comp.matrix);
  if (!preview.display) return { target: true, offer: null, unavailable: sample.spillover === null };
  const label = comp.label ?? (template.source.fileName ? `the matrix of ${template.source.fileName}` : "the template's matrix");
  if (sample.spillover === null) {
    return { target: true, offer: { matrix: comp.matrix, label, dropped: preview.dropped, replacesEmbedded: false, differsFromEmbedded: false, maxDelta: null }, unavailable: false };
  }
  const delta = maxCoefficientDelta(sample.spillover, preview.display);
  if (delta <= 1e-6) return { target: true, offer: null, unavailable: false };
  return { target: true, offer: { matrix: comp.matrix, label, dropped: preview.dropped, replacesEmbedded: true, differsFromEmbedded: true, maxDelta: delta }, unavailable: false };
}
