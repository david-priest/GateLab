// BD FACSDiva experiment XML → Gating-ML 2.0, mirroring flowjoWorkspace.ts so the whole
// downstream import pipeline — channel resolution, validation, population building — is reused
// unchanged.
//
// Diva is the acquisition software on every BD instrument, so its experiment export is the gate
// record BEFORE FlowJo ever touches it. Structurally it is a friendlier source than a .wsp:
//   • hierarchy is explicit twice over (backslash fullname paths AND a <parent> element), so
//     there is no id-stability problem;
//   • scatter gates store RAW LINEAR vertices, importable exactly;
//   • every gate carries its own <num_events>, a built-in verification target;
//   • the tube's instrument settings carry the compensation actually applied — which matters,
//     because a hand-adjusted matrix lives HERE and often nowhere else (S6's DivaCompMtx exists
//     in the Diva XML and the FlowJo workspace built from it, but not in the FCS).
//
// The one non-trivial part is fluorescence geometry. A gate axis flagged
// is_*_parameter_scaled="true" stores its points as DISPLAY BINS in [0, 4096] under Diva's
// biexponential display, whose under-zero extent is set by the per-axis
// *_parameter_scale_value. Diva's "biexponential" is the LOGICLE transform (Parks & Moore —
// Diva was its first commercial licensee), and the working model here is
//   Logicle(T = 262144, M = 4.5, A = 0, W = (M − log10(T / scale)) / 2),  y = bin / 4096,
// i.e. the scale value is the most negative raw value the axis displays, which is exactly how
// Diva's UI presents it. Two independent checks pin this on the S6 experiment/workspace pair
// (the FlowJo workspace was created FROM this Diva experiment, so FlowJo's importer already
// converted these very gates to raw): against FlowJo's converted vertices the model agrees to
// 1.5% of the coordinate VALUE at worst over all 88 fluorescence coordinates — FlowJo's own
// stored per-channel transforms are its biex re-approximation of this logicle, which is why a
// model fitted to those parameters matched at the top of the range and drifted near zero — and
// against Diva's own per-gate num_events the converted tree reproduces the counts (pinned in
// divaWorkspace.test.ts). Every constant above is read from the files or the logicle
// definition; none is invented.
//
// An axis flagged is_*_parameter_log="true" WITHOUT the scaled flag is a pure log display. No
// verified conversion exists for it in the calibration pair (every log axis there is also
// scaled), so such a gate is refused by name together with its descendants rather than guessed
// at — a plausible-looking wrong boundary is the failure this importer must never produce.
//
// One more Diva trap, discovered because the count check failed by 90%: the XML's -H and -W
// parameter NAMES are crossed relative to the FCS columns on this instrument. Diva's gate on
// "FSC-H" evaluates correctly against the FCS's FSC-W (60,597 of 65k events, matching Diva's
// own 60,680) and catastrophically against FSC-H (6,268). The parameter's <type> code is the
// stable identity — 30 area, 20 height, 10 width — and FlowJo's independent conversion of this
// experiment confirms the rule on BOTH scatter pairs (FSC-H→FSC-W and SSC-H→SSC-W). A gate
// axis whose name-suffix disagrees with its type code is therefore remapped to the type code's
// column, with a named warning per channel; when name and type agree, nothing changes, and a
// parameter with no type code keeps its name untouched.

import { Logicle } from "./transforms";
import type { SpilloverMatrix } from "./fcs";
import type { FlowJoSpillover } from "./flowjoWorkspace";

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

/** Diva's display raster: 12-bit bins over the display range. */
const DIVA_BINS = 4096;
/** Logicle T: the instrument maximum Diva's top bin lands on (BD 26-bit digital range). */
const DIVA_LOGICLE_T = 262144;
/** Logicle M: Diva displays 4.5 decades. */
const DIVA_LOGICLE_M = 4.5;

export interface DivaGateTreeSummary {
  /** Position in the document's list of gate-bearing containers; pass to divaToGatingML. */
  index: number;
  /** "worksheet" trees are Diva global sheets (apply to any tube); "tube" trees are per-tube. */
  kind: "worksheet" | "tube";
  /** Worksheet name or tube name. */
  label: string;
  /** The tube's FCS file name, for matching against the loaded file. Worksheets have none. */
  dataFilename: string | null;
  gateCount: number;
}

export interface DivaConversion {
  /** A standard Gating-ML 2.0 document, ready for importGatingML. */
  gatingMl: string;
  label: string;
  /** Diva's own <num_events> per gate name, for a concordance readout. */
  divaCounts: Record<string, number>;
  /** Anything skipped or altered, in the order encountered. Never silently discarded. */
  warnings: string[];
  /**
   * The spillover the gates were computed under, inverted from the tube's stored compensation
   * matrix (Diva stores the inverse). Null when compensation is disabled or absent.
   */
  spillover: FlowJoSpillover | null;
}

export function isDivaWorkspace(xmlText: string): boolean {
  const head = xmlText.slice(0, 2000);
  return /<bdfacs[\s>]/.test(head);
}

function parseDiva(xmlText: string): Document {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "bdfacs") {
    throw new Error("This file is not a BD FACSDiva experiment export GateLab can read.");
  }
  return doc;
}

function childText(el: Element, tag: string): string | null {
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === tag) return c.textContent;
  }
  return null;
}

interface GateContainer {
  kind: "worksheet" | "tube";
  label: string;
  dataFilename: string | null;
  gatesEl: Element;
  /** The tube element for a tube container, for its compensation. Null for worksheets. */
  tube: Element | null;
}

function gateContainers(doc: Document): GateContainer[] {
  const out: GateContainer[] = [];
  // Global worksheets first: in a worksheet-driven experiment (the common Diva workflow) that is
  // where the analysis tree lives, and each tube's own <gates> holds only "All Events".
  for (const ws of Array.from(doc.getElementsByTagName("worksheet_template"))) {
    for (const gs of Array.from(ws.children)) {
      if (gs.localName === "gates") {
        out.push({
          kind: "worksheet",
          label: ws.getAttribute("name") ?? "worksheet",
          dataFilename: null,
          gatesEl: gs,
          tube: null,
        });
      }
    }
  }
  for (const tube of Array.from(doc.getElementsByTagName("tube"))) {
    for (const gs of Array.from(tube.children)) {
      if (gs.localName === "gates") {
        out.push({
          kind: "tube",
          label: tube.getAttribute("name") ?? "tube",
          dataFilename: childText(tube, "data_filename"),
          gatesEl: gs,
          tube,
        });
      }
    }
  }
  return out;
}

function regionGateCount(gatesEl: Element): number {
  let n = 0;
  for (const g of Array.from(gatesEl.getElementsByTagName("gate"))) {
    if (g.getAttribute("type") === "Region_Classifier") n++;
  }
  return n;
}

export function listDivaGateTrees(xmlText: string): DivaGateTreeSummary[] {
  const doc = parseDiva(xmlText);
  return gateContainers(doc).map((c, index) => ({
    index,
    kind: c.kind,
    label: c.label,
    dataFilename: c.dataFilename,
    gateCount: regionGateCount(c.gatesEl),
  }));
}

// ── bin → raw conversion ─────────────────────────────────────────────────────────────────────

/** Memoised per scale value: the whole tree reuses a handful of scales. */
function binConverter(cache: Map<number, (bin: number) => number>, scale: number) {
  const hit = cache.get(scale);
  if (hit) return hit;
  // W from the scale value as the most negative displayed raw value; clamped at 0 so a zero or
  // missing scale degrades to a pure-log logicle rather than an invalid width.
  const W = Math.max(0, (DIVA_LOGICLE_M - Math.log10(DIVA_LOGICLE_T / Math.max(scale, 1e-9))) / 2);
  const lg = new Logicle(DIVA_LOGICLE_T, W, DIVA_LOGICLE_M, 0);
  const f = (bin: number): number => lg.inverse(bin / DIVA_BINS);
  cache.set(scale, f);
  return f;
}

interface DivaAxis {
  parm: string;
  scaled: boolean;
  log: boolean;
  scale: number;
}

function axisOf(gate: Element, which: "x" | "y", reg: Element): DivaAxis {
  return {
    parm: reg.getAttribute(`${which}parm`) ?? "",
    scaled: childText(gate, `is_${which}_parameter_scaled`) === "true",
    log: childText(gate, `is_${which}_parameter_log`) === "true",
    scale: Number(childText(gate, `${which}_parameter_scale_value`) ?? "0"),
  };
}

// ── parameter-name resolution (the crossed -H/-W names) ─────────────────────────────────────

/** Diva parameter <type> codes: 30 = area, 20 = height, 10 = width. */
const DIVA_TYPE_SUFFIX: Record<string, string> = { "20": "-H", "10": "-W" };

function parameterTypes(settings: Element | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!settings) return out;
  for (const p of Array.from(settings.children)) {
    if (p.localName !== "parameter") continue;
    const name = p.getAttribute("name");
    const type = childText(p, "type") ?? p.getAttribute("type");
    if (name && type) out.set(name, type);
  }
  return out;
}

function settingsFor(doc: Document, tube: Element | null): Element | null {
  const own = tube && Array.from(tube.children).find((c) => c.localName === "instrument_settings");
  if (own) return own;
  const exp = doc.getElementsByTagName("experiment")[0];
  return exp
    ? Array.from(exp.children).find((c) => c.localName === "instrument_settings") ?? null
    : null;
}

/** Map a gate-axis parameter name to the FCS column it actually gates, warning on a remap. */
function resolveParm(
  parm: string,
  types: Map<string, string>,
  warnings: string[],
  warned: Set<string>,
): string {
  const m = /^(.*)(-[HW])$/.exec(parm);
  if (!m) return parm;
  const want = DIVA_TYPE_SUFFIX[types.get(parm) ?? ""];
  if (!want || want === m[2]) return parm;
  const mapped = m[1] + want;
  if (!warned.has(parm)) {
    warned.add(parm);
    warnings.push(
      `Diva names the parameter "${parm}" but declares it as ${want === "-W" ? "a width" : "a height"} ` +
        `(type ${types.get(parm)}); gates on it were mapped to the FCS column "${mapped}", ` +
        "matching how FlowJo converts this experiment and Diva's own event counts.",
    );
  }
  return mapped;
}

// ── compensation ─────────────────────────────────────────────────────────────────────────────

/**
 * Diva stores the COMPENSATION matrix (the inverse a cytometrist edits as "spillover" is
 * derived from), one coefficient row per fluorescence parameter. GateLab wants spillover, so
 * the matrix is inverted here (Gauss-Jordan; these are small, diagonally dominant 7×7s).
 * Verified in the test suite: inverting S6's stored matrix reproduces the hand-adjusted
 * DivaCompMtx_19319.fcs coefficients recorded in the FlowJo workspace.
 */
function invertMatrix(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

function tubeSpillover(tube: Element, experimentName: string): FlowJoSpillover | null {
  let settings: Element | null = null;
  for (let c = tube.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === "instrument_settings") settings = c;
  }
  if (!settings || childText(settings, "compensation_enabled") !== "true") return null;
  const channels: string[] = [];
  const rows: number[][] = [];
  for (const p of Array.from(settings.children)) {
    if (p.localName !== "parameter") continue;
    let comp: Element | null = null;
    for (let c = p.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === "compensation") comp = c;
    }
    if (!comp) continue;
    const coeffs = Array.from(comp.getElementsByTagName("compensation_coefficient"))
      .map((c) => Number(c.textContent));
    if (!coeffs.length || coeffs.some((v) => !Number.isFinite(v))) continue;
    channels.push(p.getAttribute("name") ?? "");
    rows.push(coeffs);
  }
  if (channels.length < 2 || rows.some((r) => r.length !== channels.length)) return null;
  // Diva's row for parameter P computes compensated_P from the OBSERVED vector:
  // true = M · obs. Spillover is defined the other way round — obs = Sᵀ · true, row i of S
  // being fluorochrome i's spill across detectors — so S = (M⁻¹)ᵀ: invert, then transpose.
  const inv = invertMatrix(rows);
  if (!inv) return null;
  const spill = inv.map((_, i) => inv.map((row) => row[i]));
  const matrix: SpilloverMatrix = { channels, matrix: spill };
  return {
    name: `Diva compensation (${experimentName})`,
    prefix: "",
    suffix: "",
    matrix,
  };
}

// ── conversion ───────────────────────────────────────────────────────────────────────────────

export function divaToGatingML(
  xmlText: string,
  treeIndex: number,
  /**
   * The loaded FCS's file name, used to pick which tube's compensation applies when importing a
   * GLOBAL worksheet tree (a global sheet belongs to no tube, but the matrix does).
   */
  tubeHint: string | null = null,
): DivaConversion {
  const doc = parseDiva(xmlText);
  const containers = gateContainers(doc);
  const container = containers[treeIndex];
  if (!container) {
    throw new Error(
      `This experiment has no gate tree at position ${treeIndex + 1}; it holds ${containers.length}.`,
    );
  }
  const experimentName =
    doc.getElementsByTagName("experiment")[0]?.getAttribute("name") ?? "Diva experiment";

  const out = new DOMParser().parseFromString(
    `<gating:Gating-ML xmlns:gating="${GATING_NS}" xmlns:data-type="${DATATYPE_NS}"/>`,
    "application/xml",
  );
  const root = out.documentElement;
  const warnings: string[] = [];
  const divaCounts: Record<string, number> = {};
  const convCache = new Map<number, (bin: number) => number>();
  const hintedTube = tubeHint
    ? Array.from(doc.getElementsByTagName("tube")).find(
        (t) => (childText(t, "data_filename") ?? "").toLowerCase() === tubeHint.toLowerCase()) ?? null
    : null;
  const parmTypes = parameterTypes(settingsFor(doc, container.tube ?? hintedTube));
  const remapWarned = new Set<string>();

  // Gates in document order; Diva writes parents before children, but the fullname path makes
  // the order verifiable rather than assumed: sorting by path depth preserves any valid input.
  const gateEls = Array.from(container.gatesEl.getElementsByTagName("gate"))
    .map((el) => ({ el, fullname: el.getAttribute("fullname") ?? "" }))
    .sort((a, b) => a.fullname.split("\\").length - b.fullname.split("\\").length);

  const idByFullname = new Map<string, string>();
  /** Fullname prefixes whose subtree is being skipped, so descendants are named too. */
  const skipped: string[] = [];
  let serial = 0;

  const convertAxis = (
    gateName: string,
    axis: DivaAxis,
  ): ((v: number) => number) => {
    if (axis.scaled) return binConverter(convCache, axis.scale);
    if (axis.log) {
      throw new Error(
        `"${gateName}" is drawn on ${axis.parm} with a pure log display (no biexponential ` +
          "scale), for which no verified bin conversion exists yet",
      );
    }
    return (v) => v; // linear axes store raw values
  };

  for (const { el, fullname } of gateEls) {
    const type = el.getAttribute("type");
    const name = childText(el, "name") ?? `gate_${serial + 1}`;
    const parentPath = childText(el, "parent");
    const count = Number(childText(el, "num_events"));

    const underSkipped = skipped.find((p) => fullname.startsWith(p + "\\"));
    if (underSkipped) continue; // its ancestor's warning already names the subtree

    if (type === "EventSource_Classifier") {
      // "All Events": the root, not a gate. Its count is still worth carrying — it is the
      // total of the tube the counts were recorded on, which the caller can check against the
      // loaded file rather than assuming the two match.
      if (Number.isFinite(count)) divaCounts[name] = count;
      continue;
    }
    if (type !== "Region_Classifier") {
      warnings.push(
        `"${name}" is a ${type ?? "gate of unknown type"}, which this importer does not read; ` +
          "it and anything below it were skipped.",
      );
      skipped.push(fullname);
      continue;
    }
    let reg: Element | null = null;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === "region") reg = c;
    }
    const regType = reg?.getAttribute("type");
    if (!reg || (regType !== "POLYGON_REGION" && regType !== "RECTANGLE_REGION")) {
      warnings.push(
        `"${name}" uses ${regType ?? "no region"}, which this importer does not read yet; ` +
          "it and anything below it were skipped.",
      );
      skipped.push(fullname);
      continue;
    }

    const ax = axisOf(el, "x", reg);
    const ay = axisOf(el, "y", reg);
    let fx: (v: number) => number;
    let fy: (v: number) => number;
    try {
      fx = convertAxis(name, ax);
      fy = convertAxis(name, ay);
    } catch (e) {
      warnings.push(
        `${e instanceof Error ? e.message : String(e)}; it and anything below it were skipped.`,
      );
      skipped.push(fullname);
      continue;
    }

    const pts = Array.from(reg.getElementsByTagName("point")).map((p) => [
      fx(Number(p.getAttribute("x"))),
      fy(Number(p.getAttribute("y"))),
    ]);
    if (pts.length < 3 || pts.some((p) => p.some((v) => !Number.isFinite(v)))) {
      warnings.push(`"${name}" has unusable region geometry; it and anything below it were skipped.`);
      skipped.push(fullname);
      continue;
    }

    const gateId = `diva_gate_${++serial}`;
    const isRect = regType === "RECTANGLE_REGION";
    const gate = out.createElementNS(GATING_NS, isRect ? "gating:RectangleGate" : "gating:PolygonGate");
    gate.setAttributeNS(GATING_NS, "gating:id", gateId);
    gate.setAttributeNS(GATING_NS, "gating:name", name);
    // The <parent> element names the parent by fullname; the root EventSource is not a gate.
    const parentId = parentPath ? idByFullname.get(parentPath) : undefined;
    if (parentId) gate.setAttributeNS(GATING_NS, "gating:parent_id", parentId);

    const dims = [ax.parm, ay.parm]
      .map((parm) => resolveParm(parm, parmTypes, warnings, remapWarned))
      .map((parm, i) => {
      const dim = out.createElementNS(GATING_NS, "gating:dimension");
      if (isRect) {
        const vals = pts.map((p) => p[i]);
        dim.setAttributeNS(GATING_NS, "gating:min", String(Math.min(...vals)));
        dim.setAttributeNS(GATING_NS, "gating:max", String(Math.max(...vals)));
      }
      const fd = out.createElementNS(DATATYPE_NS, "data-type:fcs-dimension");
      fd.setAttributeNS(DATATYPE_NS, "data-type:name", parm);
      dim.appendChild(fd);
      return dim;
    });
    for (const d of dims) gate.appendChild(d);
    if (!isRect) {
      for (const [x, y] of pts) {
        const v = out.createElementNS(GATING_NS, "gating:vertex");
        for (const val of [x, y]) {
          const c = out.createElementNS(GATING_NS, "gating:coordinate");
          c.setAttributeNS(DATATYPE_NS, "data-type:value", String(val));
          v.appendChild(c);
        }
        gate.appendChild(v);
      }
    }
    root.appendChild(gate);
    idByFullname.set(fullname, gateId);
    if (Number.isFinite(count)) divaCounts[name] = count;
  }

  if (!idByFullname.size) {
    throw new Error(`"${container.label}" contains no gates GateLab can read.`);
  }

  // Compensation. A tube tree carries its own; a worksheet tree belongs to no tube, so the
  // matrix comes from the tube matching the loaded file, and when nothing matches, from the
  // first tube that has one — NAMED, because a wrong silent matrix is this importer's origin
  // story (S6's acquisition-vs-adjusted confusion).
  let spillover: FlowJoSpillover | null = null;
  if (container.tube) {
    spillover = tubeSpillover(container.tube, experimentName);
  } else {
    const tubes = Array.from(doc.getElementsByTagName("tube"));
    const hinted = tubeHint
      ? tubes.find((t) => (childText(t, "data_filename") ?? "").toLowerCase() === tubeHint.toLowerCase())
      : undefined;
    const source = hinted ?? tubes.find((t) => tubeSpillover(t, experimentName) !== null) ?? null;
    if (source) {
      spillover = tubeSpillover(source, experimentName);
      if (spillover && !hinted && tubes.length > 1) {
        warnings.push(
          `Compensation was taken from tube "${source.getAttribute("name")}" — the imported ` +
            "worksheet belongs to no tube, and no tube's data file matched the loaded FCS. " +
            "Check it is the right matrix before trusting compensated gates.",
        );
      }
    }
  }

  return {
    gatingMl: new XMLSerializer().serializeToString(out),
    label: `${experimentName} · ${container.label}`,
    divaCounts,
    warnings,
    spillover,
  };
}
