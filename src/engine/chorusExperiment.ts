/**
 * Read gates from a BD FACSChorus experiment file (`.cef`).
 *
 * FACSChorus is the acquisition and sort software of the FACSDiscover S8 (and the FACSMelody).
 * It holds ONE gate set per panel, applied to every tube, and it cannot write gates out in any
 * format. What it does write is the experiment file: a zip holding `experiment.json`, the whole
 * experiment as JSON, beside a manifest, the instrument record and a verification hash (which
 * is why this module only reads the format). Two things in it matter here:
 *
 *   • `panels[].analysis.gates` — the gates as they are now. Each is a `gateKind` (Polygon and
 *     Rectangle are what Chorus draws; Saturated and Unsaturated are its automatic gates), two
 *     `parameters`, RAW `vertices`, a `parentPopulationId`, and the population it defines, with
 *     the colour Chorus drew it in.
 *   • `sortRecords[].gateHierarchy` — the same structure, snapshotted at the start of every
 *     sort. Chorus has no per-sample gating, but a sort record IS the gating state a sorted
 *     sample was sorted under, kept even after the live gates move on. Across 59 experiment
 *     files on this machine every record is a sort; a plain recording snapshots nothing.
 *
 * Chorus's gate model is FlowJo's: raw vertices, straight in the space each parameter is
 * DISPLAYED in, which is `scale` Linear, Biexponential or Log. A Linear axis is raw, so a gate
 * on two Linear axes (scatter, most QC) imports exactly. A Biexponential axis is BD's
 * biexponential, the Logicle whose width comes from the parameter's "R value" (the most
 * negative displayed value), the model GateLab already uses for FACSDiva (divaWorkspace.ts).
 * The R value is in the file only when someone set it by hand
 * (`visualizationSettings.analysisRValueMap`); Chorus's default is automatic (−1), computed
 * from the data by a rule the file does not record, and the S8's T and M are not Diva's 18-bit
 * constants either. So those gates import straight in raw space and say so. Checked against
 * Chorus's own statistics export for one experiment (three recordings, 93 population counts):
 * Linear-axis gates match event for event, biexponential-axis gates land within 2.4%, and no
 * single global R reproduces the counts. `chorusBiexSpec` holds the model for a file whose R
 * values are set; `CHORUS_DISPLAY_MODEL` is null.
 *
 * Like the FlowJo and Diva importers, this one rewrites the gates as a Gating-ML 2.0 document
 * with names and parents and hands it to importGatingML, so channel resolution, validation,
 * population building and merge/replace are unchanged.
 */

import { unzipSync, strFromU8 } from "fflate";
import { GATE_COLOR_TAG } from "./gatingml";
import { WSP_GATE_SPACE_TAG } from "./flowjoWorkspace";
import type { ChorusGateReport, ChorusImportRecord } from "./chorusStatistics";
import { transformFromSpec } from "./sample";
import type { TransformSpec } from "./models";

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

export interface ChorusParameter {
  /** A scatter or image name ("SSC (Imaging)"), or a detector id for a colour ("Violet_|_BP/…"). */
  measurementId: string;
  /** The fluorochrome a colour parameter is unmixed to, which is what its FCS `$PnN` names. */
  fluorochrome: string;
  /** "A", "H", "W" or "T"; null for an image feature, whose name IS the measurementId. */
  measurement: string | null;
  scale: string;
  parameterKind: string;
}

export interface ChorusGate {
  gateId: string;
  gateKind: string;
  /** The gate's own label; the population it defines has its own name. */
  name: string;
  parentPopulationId: string;
  parameters: ChorusParameter[];
  vertices: Array<{ x: number; y: number }>;
  /** The population(s) the gate defines: one, in every file seen. */
  children: Array<{ name: string; color: string; populationId: string }>;
}

export interface ChorusSortRecord {
  name: string;
  /** Chorus's own timestamp string, instrument-local, e.g. "2025-07-28T06:50:16.07". */
  startedAt: string | null;
  stoppedAt: string | null;
  gates: ChorusGate[];
  /** Events the sort processed, from the sort report. */
  totalEvents: number | null;
  /** Sorted events per destination population, from the sort report. */
  destinations: Array<{ population: string; sortCount: number; targetCount: number }>;
}

export interface ChorusPanel {
  /** Chorus's id for the panel; a recording's FCS names this, or the experiment's id, as its association. */
  id: string | null;
  name: string;
  gates: ChorusGate[];
  /** The R value per parameter, keyed by parameterKey(); −1 means Chorus's automatic value. */
  rValues: Map<string, number>;
  /** Detector id ("Violet_|_BP/420/20/BP/447/74") → the name Chorus gives it ("Violet_A"). */
  detectors: Map<string, string>;
}

export interface ChorusExperiment {
  /** Chorus's id for the experiment; a recording's FCS names it as its association. */
  id: string | null;
  name: string;
  /** Recordings the experiment holds in Chorus, from its metadata; none of them is in the file. */
  recordingCount: number | null;
  /** When the experiment was last saved, as Chorus wrote it (UTC, no zone designator). */
  savedAt: string | null;
  chorusVersion: string | null;
  panels: ChorusPanel[];
  sorts: ChorusSortRecord[];
}

/** A `.cef` by name; the content is checked when it is read. */
export function isChorusExperimentFile(fileName: string): boolean {
  return /\.cef$/i.test(fileName.trim());
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Chorus JSON-encodes its timestamps twice ("\"2025-07-28T06:50:16.07\""); one layer is enough. */
function timestamp(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v).trim().replace(/^"+|"+$/g, "");
  return s && s !== "null" ? s : null;
}

function parameter(v: unknown): ChorusParameter {
  const p = obj(v);
  return {
    measurementId: str(p.measurementId),
    fluorochrome: str(p.fluorochrome),
    measurement: typeof p.measurement === "string" && p.measurement ? p.measurement : null,
    scale: str(p.scale),
    parameterKind: str(p.parameterKind),
  };
}

function gate(v: unknown): ChorusGate {
  const g = obj(v);
  return {
    gateId: str(g.gateId),
    gateKind: str(g.gateKind),
    name: str(g.name),
    parentPopulationId: str(g.parentPopulationId),
    parameters: arr(g.parameters).map(parameter),
    vertices: arr(g.vertices).map((p) => ({ x: Number(obj(p).x), y: Number(obj(p).y) })),
    children: arr(g.children).map((c) => ({
      name: str(obj(c).name), color: str(obj(c).color), populationId: str(obj(c).populationId),
    })),
  };
}

/** How the R-value map keys a parameter: the same fields the gate's parameters carry. */
export function parameterKey(p: ChorusParameter): string {
  return `${p.parameterKind}|${p.measurementId}|${p.fluorochrome}|${p.measurement ?? ""}|${p.scale}`;
}

/**
 * Read a `.cef`.
 *
 * Every field is read defensively: the format is undocumented, and a missing block should cost
 * the feature that needs it, not the import.
 */
export function readChorusExperiment(bytes: Uint8Array): ChorusExperiment {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a FACSChorus experiment file (.cef): it is not a zip archive.");
  }
  const expBytes = files["experiment.json"];
  if (!expBytes) {
    throw new Error("This file is not a FACSChorus experiment file (.cef): it holds no experiment.json.");
  }
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(expBytes));
  } catch {
    throw new Error("This FACSChorus experiment file's experiment.json could not be parsed.");
  }
  let chorusVersion: string | null = null;
  if (files["manifest.json"]) {
    try {
      chorusVersion = str(obj(JSON.parse(strFromU8(files["manifest.json"]))).chorusVersion) || null;
    } catch {
      chorusVersion = null;
    }
  }
  const root = obj(json);
  const experiment = obj(root.experiment);
  const sorts: ChorusSortRecord[] = arr(root.sortRecords).map((v) => {
    const r = obj(v);
    const report = obj(r.sortReport);
    return {
      name: str(r.name).replace(/\\+$/, "").trim() || "Sort",
      startedAt: timestamp(r.startSortTime),
      stoppedAt: timestamp(r.stopSortTime),
      gates: arr(r.gateHierarchy).map(gate),
      totalEvents: Number.isFinite(Number(report.totalEvents)) && report.totalEvents !== undefined && report.totalEvents !== null ? Number(report.totalEvents) : null,
      destinations: arr(report.destinationReports).map((d) => ({
        population: str(obj(d).population),
        sortCount: Number(obj(d).sortCount) || 0,
        targetCount: Number(obj(d).targetCount) || 0,
      })),
    };
  });
  // Detector names live in the cytometer settings a sort record snapshots; the panel's optical
  // configuration lists only measurement kinds.
  const detectors = new Map<string, string>();
  for (const v of arr(root.sortRecords)) {
    const settings = obj(obj(v).cytometerSettings);
    for (const a of arr(settings.acquisitionParameter)) {
      const p = obj(a);
      const id = str(p.laserFilterMirrorUniqueId);
      if (id && !detectors.has(id)) detectors.set(id, str(p.name));
    }
  }
  const panels: ChorusPanel[] = arr(experiment.panels).map((v, i) => {
    const p = obj(v);
    const analysis = obj(p.analysis);
    const rValues = new Map<string, number>();
    for (const entry of arr(obj(analysis.visualizationSettings).analysisRValueMap)) {
      const e = obj(entry);
      const value = Number(e.value);
      if (Number.isFinite(value)) rValues.set(parameterKey(parameter(e.key)), value);
    }
    return { id: str(p.id) || null, name: str(p.name) || `panel ${i + 1}`, gates: arr(analysis.gates).map(gate), rValues, detectors };
  });
  if (!panels.length) throw new Error("This FACSChorus experiment holds no panel, so no gates.");
  const recordingCount = Number(obj(experiment.metadata).dataRecordCount);
  return {
    id: str(experiment.id) || null,
    name: str(experiment.name) || "FACSChorus experiment",
    recordingCount: Number.isFinite(recordingCount) && obj(experiment.metadata).dataRecordCount !== undefined ? recordingCount : null,
    savedAt: timestamp(experiment.updated),
    chorusVersion, panels, sorts,
  };
}

// ── A recording, from its FCS file ──────────────────────────────────────────────────────────

/** What an S8 FCS file says about the recording it holds, and the gates it was recorded under. */
export interface ChorusRecording {
  /** Chorus's id for the recording; the Recording Id of its statistics export. */
  dataRecordId: string | null;
  /** The experiment it belongs to (`experiment.id` in the `.cef`). */
  experimentId: string | null;
  /** $PROJ. */
  experimentName: string | null;
  /** The recording's name ($SMNO). */
  name: string;
  category: string | null;
  /** UTC, as Chorus wrote it. */
  startedAt: string | null;
  stoppedAt: string | null;
  eventCount: number | null;
  /** The gates as they stood when the recording was made, with the display's R values. */
  panel: ChorusPanel;
}

export const CHORUS_RECORD_KEYWORD = "BDCHORUSDATARECORD";

/** The keyword's JSON capitalises every key; the `.cef` does not. */
function uncapitalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(uncapitalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k.charAt(0).toLowerCase() + k.slice(1)] = uncapitalise(val);
    return out;
  }
  return v;
}

/** True when the FCS keywords carry a Chorus recording; the content is checked when it is read. */
export function hasChorusRecording(keywords: Record<string, string>): boolean {
  return typeof keywords[CHORUS_RECORD_KEYWORD] === "string" && keywords[CHORUS_RECORD_KEYWORD].trim().startsWith("{");
}

/**
 * Read the recording an S8 FCS carries. Null when the keyword is absent; throws when it is
 * present but unreadable, so a broken file is not mistaken for a file without gates.
 */
export function readChorusRecording(keywords: Record<string, string>): ChorusRecording | null {
  const raw = keywords[CHORUS_RECORD_KEYWORD];
  if (typeof raw !== "string" || !raw.trim()) return null;
  let json: unknown;
  try {
    json = uncapitalise(JSON.parse(raw));
  } catch {
    throw new Error(`This file's ${CHORUS_RECORD_KEYWORD} keyword is not valid JSON.`);
  }
  const root = obj(json);
  const info = obj(root.recordingInfo);
  const config = obj(root.recordingConfiguration);
  const model = obj(config.analysisModel);
  const rValues = new Map<string, number>();
  for (const entry of arr(obj(model.visualizationSettings).analysisRValueMap)) {
    const e = obj(entry);
    const value = Number(e.value);
    if (Number.isFinite(value)) rValues.set(parameterKey(parameter(e.key)), value);
  }
  const detectors = new Map<string, string>();
  for (const a of arr(obj(config.cytometerSettings).acquisitionParameter)) {
    const p = obj(a);
    const id = str(p.laserFilterMirrorUniqueId);
    if (id && !detectors.has(id)) detectors.set(id, str(p.name));
  }
  const name = str(info.name) || keywords["$SMNO"] || keywords["$FIL"] || "recording";
  const events = Number(config.eventCount);
  return {
    dataRecordId: str(info.dataRecordId) || str(config.dataRecordId) || null,
    experimentId: str(info.associationId) || null,
    experimentName: keywords["$PROJ"] || null,
    name,
    category: str(info.category) || null,
    startedAt: timestamp(config.startRecordingTime) ?? (keywords["$BEGINDATETIME"] || null),
    stoppedAt: timestamp(config.stopRecordingTime) ?? (keywords["$ENDDATETIME"] || null),
    eventCount: Number.isFinite(events) && config.eventCount !== undefined ? events : null,
    panel: { id: null, name, gates: arr(model.gates).map(gate), rValues, detectors },
  };
}

// ── Parameter names ─────────────────────────────────────────────────────────────────────────

/** Chorus's laser names as the FCS `$PnN` prefixes them ("Violet_|_BP/420/…" → "V1 (420)-A"). */
const LASER_PREFIX: Record<string, string> = { UV: "UV", Violet: "V", Blue: "B", YellowGreen: "YG", Red: "R" };

/**
 * The FCS `$PnN` a gate parameter names, or null when it cannot be reconstructed.
 *
 * Chorus writes the S8's unmixed parameters as `<fluorochrome>-<measurement>`, scatter as
 * `<name>-<measurement>` and image features by name alone, which is what the exported FCS
 * carries as `$PnN` (checked on an S8 export: "BUV805-A", "LightLoss (Violet)-A",
 * "Max Intensity (SSC (Imaging))"). A gate drawn on a raw detector names it by laser and
 * filter; the FCS names those `<laser><index> (<wavelength>)`, so the index is taken from the
 * detector's position among its laser's detectors and the wavelength from the filter — a
 * reconstruction, so it is reported as one.
 */
export function parameterName(p: ChorusParameter, panel: ChorusPanel, note: (msg: string) => void): string | null {
  if (!p.measurement) return p.measurementId || null;
  if (!p.measurementId.includes("_|_")) {
    // Chorus fills `fluorochrome` for scatter too ("SSC" for "SSC (Imaging)"); the FCS names
    // scatter by the full measurement and a colour by the fluorochrome it is unmixed to.
    const base = p.parameterKind === "Color" && p.fluorochrome ? p.fluorochrome : p.measurementId;
    return `${base}-${p.measurement}`;
  }
  const [laser, filter] = p.measurementId.split("_|_");
  const prefix = LASER_PREFIX[laser];
  const wavelength = filter?.split("/")[1];
  if (!prefix || !wavelength) return null;
  const siblings = [...panel.detectors.entries()]
    .filter(([id]) => id.startsWith(`${laser}_|_`))
    .sort((a, b) => a[1].localeCompare(b[1]));
  const index = siblings.findIndex(([id]) => id === p.measurementId);
  if (index < 0) return null;
  const name = `${prefix}${index + 1} (${wavelength})-${p.measurement}`;
  note(`"${p.measurementId}" is a raw detector, named "${name}" by its position among the ${laser} detectors; check the axis if the gate lands on the wrong channel.`);
  return name;
}

// ── BD's biexponential ──────────────────────────────────────────────────────────────────────

export interface ChorusDisplayModel {
  /** Logicle T: the top of the display. */
  T: number;
  /** Logicle M: decades displayed. */
  M: number;
}

/**
 * The display a Biexponential axis is straight in, as a GateLab transform: the Logicle with
 * W = (M − log10(T / R)) / 2, R being the parameter's R value, the most negative value the axis
 * shows. This is the model divaWorkspace.ts validated against FACSDiva's own counts with
 * T = 262144 and M = 4.5; the S8's constants are not those (its A parameters range to 2^31,
 * with a display maximum of 2^27 − 1) and Chorus's default R is automatic and unrecorded, so
 * the model is not applied by default.
 */
export function chorusBiexSpec(rValue: number, model: ChorusDisplayModel): TransformSpec | null {
  if (!(rValue > 0) || !(model.T > 0) || !(model.M > 0)) return null;
  const W = Math.max(0, (model.M - Math.log10(model.T / rValue)) / 2);
  return { kind: "logicle", T: model.T, W, M: model.M, A: 0 };
}

/** Null: the S8's T and M are unpinned and Chorus's default R is automatic (see chorusBiexSpec). */
export const CHORUS_DISPLAY_MODEL: ChorusDisplayModel | null = null;

// ── Trees ───────────────────────────────────────────────────────────────────────────────────

export interface ChorusTreeSummary {
  /** Pass to chorusToGatingML. */
  index: number;
  /** The gates as they are now, or a sort's snapshot of them. */
  kind: "current" | "sort" | "recording";
  label: string;
  panel: string;
  /** For a sort: when it started, as Chorus wrote it. */
  sortedAt: string | null;
  gateCount: number;
  /** Gates of a kind this importer does not read, Chorus's automatic gates aside. */
  unsupportedCount: number;
  /** Population names, depth-first. */
  populations: string[];
  /** For a sort: whether its gates are the current ones, vertex for vertex. */
  sameAsCurrent: boolean;
  /** For a sort: events it processed, from its sort report. */
  totalEvents: number | null;
  /** For a sort: the populations it sorted and how many events of each. */
  sorted: Array<{ population: string; sortCount: number }>;
}

/** Chorus's automatic saturation gates: a QC filter, not a gate anyone drew. */
const AUTOMATIC_KINDS = new Set(["Saturated", "Unsaturated"]);
const SUPPORTED_KINDS = new Set(["Polygon", "Rectangle"]);

/** Gates as a comparable string: kind, name, parent, axes and vertices, order-free. */
export function treeSignature(gates: ChorusGate[]): string {
  return JSON.stringify(gates.map((g) => [g.gateKind, g.name, g.parentPopulationId,
    g.parameters.map((p) => [p.measurementId, p.fluorochrome, p.measurement, p.scale]),
    g.vertices.map((v) => [v.x, v.y])]).sort());
}

/** Chorus writes sort times as ISO strings with no zone designator, and they are UTC: the pre-sort recording's
 *  $BTIM, which FCS keeps in local time, runs the instrument's whole UTC offset ahead of the sort's startSortTime.
 *  The label is therefore in local time, the clock the FCS files and the sort names were written under. */
function localTimeLabel(iso: string): string {
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(iso);
  const d = new Date(zoned ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ").slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Tree {
  kind: "current" | "sort" | "recording";
  label: string;
  panel: ChorusPanel;
  gates: ChorusGate[];
  sortedAt: string | null;
  sort: ChorusSortRecord | null;
}

function trees(exp: ChorusExperiment): Tree[] {
  const out: Tree[] = exp.panels.map((panel) => ({
    kind: "current", label: exp.panels.length > 1 ? `Current gates · ${panel.name}` : "Current gates",
    panel, gates: panel.gates, sortedAt: null, sort: null,
  }));
  const sorted = [...exp.sorts].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  for (const s of sorted) {
    const when = s.startedAt ? ` · ${localTimeLabel(s.startedAt)}` : "";
    out.push({ kind: "sort", label: `${s.name}${when}`, panel: exp.panels[0], gates: s.gates, sortedAt: s.startedAt, sort: s });
  }
  return out;
}

/** Population names in tree order, and the automatic gates left out. */
function walkNames(gates: ChorusGate[]): string[] {
  const byParent = new Map<string, ChorusGate[]>();
  for (const g of gates) byParent.set(g.parentPopulationId, [...(byParent.get(g.parentPopulationId) ?? []), g]);
  const out: string[] = [];
  const visit = (popId: string): void => {
    for (const g of byParent.get(popId) ?? []) {
      if (!AUTOMATIC_KINDS.has(g.gateKind)) out.push(g.children[0]?.name || g.name);
      for (const c of g.children) visit(c.populationId);
    }
  };
  visit("0-1");
  return out;
}

export function listChorusTrees(exp: ChorusExperiment): ChorusTreeSummary[] {
  const current = exp.panels[0] ? treeSignature(exp.panels[0].gates) : "";
  return trees(exp).map((t, index) => {
    const drawn = t.gates.filter((g) => !AUTOMATIC_KINDS.has(g.gateKind));
    return {
      index,
      kind: t.kind,
      label: t.label,
      panel: t.panel.name,
      sortedAt: t.sortedAt,
      gateCount: drawn.filter((g) => SUPPORTED_KINDS.has(g.gateKind)).length,
      unsupportedCount: drawn.filter((g) => !SUPPORTED_KINDS.has(g.gateKind)).length,
      populations: walkNames(t.gates),
      sameAsCurrent: t.kind === "sort" && treeSignature(t.gates) === current,
      totalEvents: t.sort?.totalEvents ?? null,
      sorted: t.sort?.destinations.map((d) => ({ population: d.population, sortCount: d.sortCount })) ?? [],
    };
  });
}

// ── Conversion ──────────────────────────────────────────────────────────────────────────────

export interface ChorusConversion {
  /** A standard Gating-ML 2.0 document, ready for importGatingML. */
  gatingMl: string;
  label: string;
  kind: "current" | "sort" | "recording";
  /** Anything skipped, approximated or reconstructed, in the order met. Never silent. */
  warnings: string[];
  /** What was done with each gate, for comparing the tree with Chorus's own statistics later. */
  record: ChorusImportRecord;
}

/** "206,218,74" → "#ced24a"; null for anything else. */
function hexColor(rgb: string): string | null {
  const m = rgb.trim().match(/^(\d{1,3}),(\d{1,3}),(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((v) => v > 255)) return null;
  return "#" + parts.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Population names, qualified with parents until unique, so two "P1"s under different parents
 * stay apart (as the FlowJo importer does). A name that is unique already is left as written.
 */
function qualifiedNames(items: Array<{ id: string; path: string[] }>): Map<string, string> {
  const depth = items.map(() => 1);
  let names = items.map((it) => it.path[it.path.length - 1]);
  for (;;) {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    let progressed = false;
    items.forEach((it, i) => {
      if ((counts.get(names[i]) ?? 0) > 1 && depth[i] < it.path.length) {
        depth[i]++;
        progressed = true;
      }
    });
    if (!progressed) break;
    names = items.map((it, i) => it.path.slice(-depth[i]).join("/"));
  }
  return new Map(items.map((it, i) => [it.id, names[i]]));
}

export function chorusToGatingML(
  exp: ChorusExperiment,
  treeIndex: number,
  opts: { displayModel?: ChorusDisplayModel | null } = {},
): ChorusConversion {
  const all = trees(exp);
  const tree = all[treeIndex];
  if (!tree) {
    throw new Error(`This experiment has no gate tree at position ${treeIndex + 1}; it holds ${all.length}.`);
  }
  const model = opts.displayModel === undefined ? CHORUS_DISPLAY_MODEL : opts.displayModel;
  // A snapshot is compared with the live gates, so a gate moved after the sort can be named.
  return convertTree(exp.name, tree, model, tree.kind === "sort" ? exp.panels[0]?.gates ?? null : null);
}

/** One gate's geometry, for telling a snapshot's gate from the current one of the same name. */
function gateGeometryKey(g: ChorusGate): string {
  return JSON.stringify([g.gateKind, g.parameters.map((p) => [p.measurementId, p.fluorochrome, p.measurement, p.scale]), g.vertices.map((v) => [v.x, v.y])]);
}

/**
 * The tree an S8 recording was made under, read from the FCS file itself: Chorus writes the
 * recording it stored — identity, times, the analysis model, the cytometer settings — into a
 * `BDCHORUSDATARECORD` keyword, so the gates live in the FCS with its data. Same schema as the
 * `.cef`, with capitalised keys.
 */
export function chorusRecordingToGatingML(
  rec: ChorusRecording,
  opts: { displayModel?: ChorusDisplayModel | null; currentGates?: readonly ChorusGate[] | null } = {},
): ChorusConversion {
  const model = opts.displayModel === undefined ? CHORUS_DISPLAY_MODEL : opts.displayModel;
  const tree: Tree = { kind: "recording", label: rec.name, panel: rec.panel, gates: rec.panel.gates, sortedAt: rec.startedAt, sort: null };
  return convertTree(rec.experimentName ?? "FACSChorus recording", tree, model, opts.currentGates ?? null);
}

function convertTree(expName: string, tree: Tree, model: ChorusDisplayModel | null, currentGates: readonly ChorusGate[] | null): ChorusConversion {
  // The current gates by the population they define: a gate of a snapshot that has no
  // geometrically identical current gate under that name has moved since.
  const current = currentGates ? new Map<string, string[]>() : null;
  if (current && currentGates) {
    for (const g of currentGates) {
      const key = g.children[0]?.name || g.name;
      current.set(key, [...(current.get(key) ?? []), gateGeometryKey(g)]);
    }
  }
  const warnings: string[] = [];
  const noted = new Set<string>();
  const note = (msg: string): void => {
    if (!noted.has(msg)) {
      noted.add(msg);
      warnings.push(msg);
    }
  };

  const out = new DOMParser().parseFromString(
    `<gating:Gating-ML xmlns:gating="${GATING_NS}" xmlns:data-type="${DATATYPE_NS}"/>`,
    "application/xml",
  );
  const root = out.documentElement;

  // Gates by the population they define, and by parent, so the walk goes root-down and every
  // gate sees its parent's outcome (emitted, skipped, or transparent) before its own.
  const byParent = new Map<string, ChorusGate[]>();
  for (const g of tree.gates) byParent.set(g.parentPopulationId, [...(byParent.get(g.parentPopulationId) ?? []), g]);

  // Names first, so a duplicate can be qualified before anything refers to it.
  const paths: Array<{ id: string; path: string[] }> = [];
  const collect = (popId: string, path: string[]): void => {
    for (const g of byParent.get(popId) ?? []) {
      const own = g.children[0]?.name || g.name || `gate ${g.gateId}`;
      const next = AUTOMATIC_KINDS.has(g.gateKind) ? path : [...path, own];
      if (!AUTOMATIC_KINDS.has(g.gateKind)) paths.push({ id: g.gateId, path: next });
      for (const c of g.children) collect(c.populationId, next);
    }
  };
  collect("0-1", []);
  const names = qualifiedNames(paths);
  const qualified = paths.filter((p) => names.get(p.id) !== p.path[p.path.length - 1]).map((p) => names.get(p.id)!);
  if (qualified.length) {
    note(`${qualified.length} population name(s) recur under different parents and were qualified with their parent so they stay distinct: ${qualified.slice(0, 6).map((n) => `"${n}"`).join(", ")}${qualified.length > 6 ? ", …" : ""}.`);
  }

  let emitted = 0;
  let approximated = 0;
  const approximatedNames: string[] = [];
  const unsupported: string[] = [];
  const reports: ChorusGateReport[] = [];

  /** Emit `g` under `parentGmlId` (null at the top), then its children under the id it got. */
  const visit = (g: ChorusGate, parentGmlId: string | null, automaticAbove: boolean): void => {
    const displayName = names.get(g.gateId) ?? g.children[0]?.name ?? g.name;
    if (AUTOMATIC_KINDS.has(g.gateKind)) {
      // Chorus's saturation filter: not applied here, and said once if anything sits beneath it.
      for (const c of g.children) for (const child of byParent.get(c.populationId) ?? []) visit(child, parentGmlId, true);
      return;
    }
    if (!SUPPORTED_KINDS.has(g.gateKind)) {
      unsupported.push(`"${displayName}" (${g.gateKind || "unknown kind"})`);
      return; // its subtree is measured inside it; nothing is left to measure it in
    }
    if (g.parameters.length < 2) {
      note(`"${displayName}" names ${g.parameters.length} parameter(s); a gate needs two. It and anything below it were skipped.`);
      return;
    }
    if (automaticAbove) {
      note("Populations beneath Chorus's automatic Unsaturated gate were attached to its parent: that saturation filter is not applied here, so their counts include saturated events.");
    }

    const axisNames = g.parameters.slice(0, 2).map((p) => parameterName(p, tree.panel, note));
    if (axisNames.some((n) => !n)) {
      note(`"${displayName}" is drawn on a detector whose FCS name could not be reconstructed (${g.parameters.map((p) => p.measurementId).join(" × ")}); it and anything below it were skipped.`);
      return;
    }
    // The space each axis is straight in. Linear IS raw. Biexponential is carried only under a
    // calibrated model; without one the gate imports straight in raw and is named below.
    const specs: Array<TransformSpec | null> = g.parameters.slice(0, 2).map((p) => {
      if (p.scale === "Linear" || !p.scale) return { kind: "identity" as const };
      if (p.scale === "Biexponential" && model) {
        const r = tree.panel.rValues.get(parameterKey(p));
        return r !== undefined ? chorusBiexSpec(r, model) : null;
      }
      return null;
    });
    const carried = specs.every((s) => s !== null) && specs.some((s) => s!.kind !== "identity");
    if (specs.some((s) => s === null)) {
      approximated++;
      approximatedNames.push(`"${displayName}"`);
    }
    reports.push({
      name: displayName,
      kind: g.gateKind,
      axes: axisNames.map((n, i) => ({ name: n!, scale: g.parameters[i].scale || "Linear" })),
      approximated: specs.some((s) => s === null),
      ...(current ? { differsFromCurrent: !(current.get(g.children[0]?.name || g.name) ?? []).includes(gateGeometryKey(g)) } : {}),
    });

    const pts = g.vertices.map((v) => [v.x, v.y] as [number, number]).filter((p) => p.every(Number.isFinite));
    const isRect = g.gateKind === "Rectangle";
    if (pts.length < (isRect ? 2 : 3)) {
      note(`"${displayName}" has unusable geometry (${g.vertices.length} vertices); it and anything below it were skipped.`);
      return;
    }
    const placed = carried
      ? pts.map(([x, y]) => [transformFromSpec(specs[0]!).forward(x), transformFromSpec(specs[1]!).forward(y)] as [number, number])
      : pts;

    const gmlId = `chorus_gate_${g.gateId}`;
    const el = out.createElementNS(GATING_NS, isRect ? "gating:RectangleGate" : "gating:PolygonGate");
    el.setAttributeNS(GATING_NS, "gating:id", gmlId);
    el.setAttributeNS(GATING_NS, "gating:name", displayName);
    if (parentGmlId) el.setAttributeNS(GATING_NS, "gating:parent_id", parentGmlId);

    const info = out.createElementNS(DATATYPE_NS, "data-type:custom_info");
    const colour = hexColor(g.children[0]?.color ?? "");
    if (colour) {
      const tag = out.createElementNS(DATATYPE_NS, `data-type:${GATE_COLOR_TAG}`);
      tag.textContent = colour;
      info.appendChild(tag);
    }
    if (carried) {
      const tag = out.createElementNS(DATATYPE_NS, `data-type:${WSP_GATE_SPACE_TAG}`);
      tag.textContent = JSON.stringify({ space: "display", x: specs[0], y: specs[1] });
      info.appendChild(tag);
    }
    if (info.childNodes.length) el.appendChild(info);

    axisNames.forEach((axisName, i) => {
      const dim = out.createElementNS(GATING_NS, "gating:dimension");
      dim.setAttributeNS(GATING_NS, "gating:compensation-ref", "uncompensated");
      if (isRect) {
        const vals = placed.map((p) => p[i]);
        dim.setAttributeNS(GATING_NS, "gating:min", String(Math.min(...vals)));
        dim.setAttributeNS(GATING_NS, "gating:max", String(Math.max(...vals)));
      }
      const fd = out.createElementNS(DATATYPE_NS, "data-type:fcs-dimension");
      fd.setAttributeNS(DATATYPE_NS, "data-type:name", axisName!);
      dim.appendChild(fd);
      el.appendChild(dim);
    });
    if (!isRect) {
      for (const [x, y] of placed) {
        const v = out.createElementNS(GATING_NS, "gating:vertex");
        for (const val of [x, y]) {
          const c = out.createElementNS(GATING_NS, "gating:coordinate");
          c.setAttributeNS(DATATYPE_NS, "data-type:value", String(val));
          v.appendChild(c);
        }
        el.appendChild(v);
      }
    }
    root.appendChild(el);
    emitted++;
    for (const c of g.children) for (const child of byParent.get(c.populationId) ?? []) visit(child, gmlId, false);
  };
  for (const g of byParent.get("0-1") ?? []) visit(g, null, false);

  if (unsupported.length) {
    note(`${unsupported.length} gate(s) of a kind this importer does not read were skipped with everything beneath them: ${unsupported.slice(0, 6).join(", ")}${unsupported.length > 6 ? ", …" : ""}.`);
  }
  if (approximated) {
    warnings.push(
      `${approximated} gate(s) are drawn on axes Chorus displays with its biexponential or log scale and were imported straight in RAW space: ` +
      `${approximatedNames.slice(0, 6).join(", ")}${approximated > 6 ? ", …" : ""}. Chorus evaluates them straight in its display, ` +
      "so their counts will differ from Chorus's near the axes (within 2.4% of every population count in the one experiment " +
      "checked against Chorus's own statistics export). Chorus's automatic R values are computed from the data and not stored, " +
      "so the display cannot be rebuilt from the file; a Linear axis is exact.",
    );
  }
  if (!emitted) {
    throw new Error(`"${tree.label}" contains no gates GateLab can read.` + (warnings.length ? ` ${warnings[0]}` : ""));
  }
  return {
    gatingMl: new XMLSerializer().serializeToString(out),
    label: `${expName} · ${tree.label}`,
    kind: tree.kind,
    warnings,
    record: { experimentName: expName, treeLabel: tree.label, kind: tree.kind, sortedAt: tree.sortedAt, gates: reports },
  };
}
