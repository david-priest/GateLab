// A synthetic CyTOF run and a Cytobank-style Gating-ML tree for it, small enough to read.
//
// It carries the two things a reader of Cytobank's export gets wrong, each with events placed so
// that the wrong reading gives another count:
//
//   1. Time bounds in stored ticks. Cytobank writes a Time coordinate as the FCS stores it; a
//      reader that multiplies Time by $TIMESTEP (0.01 here) first, as FlowKit does, puts every
//      event stored below 100 ticks under the gate's lower bound of 1, and the "Time" population
//      keeps 24 of 420 events instead of all of them. The first four sit exactly on that floor.
//   2. A barcode population's parent named only in custom_info. Cytobank's BooleanGate for a
//      population under another lists only the population's own gates; the parent appears in
//      custom_info's booleanExpression ("pop_7 AND gate_10 AND gate_11"). Read from the standard
//      BooleanGate alone, the barcode populations take the DNA-negative events of their pattern too.
//
// Expected counts are computed here from the classes each event was made in, not by GateLab.

import { writeFcs } from "../../engine/fcsExport";

export const FIXTURE_TIMESTEP = 0.01;
const N = 420;

/** The class each event was generated in. */
export interface FixtureEvent {
  time: number;
  dnaPositive: boolean;
  /** Which barcode metals are high: B1 = 104 and 106, B2 = 104 and 108. */
  pattern: "B1" | "B2" | "106+108" | "none" | "all";
}

export function fixtureEvents(): FixtureEvent[] {
  const patterns: FixtureEvent["pattern"][] = ["B1", "B2", "106+108", "none", "all"];
  return Array.from({ length: N }, (_, i) => ({
    // Ticks 1 to 105; the first four events sit on the floor the Time gate starts at.
    time: 1 + Math.floor(i / 4),
    dnaPositive: i % 7 !== 0,
    pattern: patterns[i % 5],
  }));
}

/** The run as an FCS 3.1 file, float32, with $TIMESTEP. */
export function fixtureFcs(fileName = "D1.fcs"): Uint8Array {
  const ev = fixtureEvents();
  const high = (on: boolean) => (on ? 200 : 2);
  const has = (e: FixtureEvent, metal: 104 | 106 | 108) =>
    e.pattern === "all" ||
    (metal === 104 && (e.pattern === "B1" || e.pattern === "B2")) ||
    (metal === 106 && (e.pattern === "B1" || e.pattern === "106+108")) ||
    (metal === 108 && (e.pattern === "B2" || e.pattern === "106+108"));
  const columns = [
    ev.map((e) => e.time),
    ev.map(() => 20),
    ev.map((e) => (e.dnaPositive ? 500 : 5)),
    ev.map((e) => high(has(e, 104))),
    ev.map((e) => high(has(e, 106))),
    ev.map((e) => high(has(e, 108))),
  ];
  return writeFcs(columns, [
    { name: "Time", desc: "" },
    { name: "Event_length", desc: "" },
    { name: "Ir191Di", desc: "DNA" },
    { name: "Pd104Di", desc: "" },
    { name: "Pd106Di", desc: "" },
    { name: "Pd108Di", desc: "" },
  ], { keywords: [["$TIMESTEP", String(FIXTURE_TIMESTEP)], ["$CYT", "Synthetic mass cytometer"], ["$FIL", fileName]] });
}

/** Expected counts from the generating classes. */
export function fixtureExpected() {
  const ev = fixtureEvents();
  const cells = ev.filter((e) => e.dnaPositive);
  return {
    total: ev.length,
    time: ev.length,
    atFloor: ev.filter((e) => e.time === 1).length,
    cells: cells.length,
    B1: cells.filter((e) => e.pattern === "B1").length,
    B2: cells.filter((e) => e.pattern === "B2").length,
    /** What a reader that drops the parent from booleanExpression would count. */
    B1WithoutParent: ev.filter((e) => e.pattern === "B1").length,
    /** What a reader that scales Time by $TIMESTEP would count in the Time gate. */
    timeScaledBySeconds: ev.filter((e) => e.time * FIXTURE_TIMESTEP >= 1).length,
  };
}

// ── The Gating-ML tree, as Cytobank exports one ──────────────────────────────────────────────

const NS = 'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';

/** arcsinh(x / 5) as Gating-ML's fasinh states it: T = 5 sinh(1), M = 1 / ln 10, A = 0. */
const ASINH5 = `<transforms:transformation transforms:id="Tr_Arcsinh_5"><transforms:fasinh transforms:T="${5 * Math.sinh(1)}" transforms:M="${1 / Math.LN10}" transforms:A="0.0"/></transforms:transformation>`;

interface Dim { channel: string; min: number; max: number; asinh: boolean }

function rectangle(id: string, gateId: number, name: string, dims: [Dim, Dim], tailoredFor?: string): string {
  const info = `<data-type:custom_info><cytobank><name>${name}</name><id>${gateId * 10}</id><gate_id>${gateId}</gate_id><type>RectangleGate</type><version>-1</version><compensation_id>-2</compensation_id><tailored>${tailoredFor ? "true" : "false"}</tailored>${tailoredFor ? `<fcs_file_filename>${tailoredFor}</fcs_file_filename>` : "<fcs_file_filename />"}</cytobank></data-type:custom_info>`;
  const dim = (d: Dim) => `<gating:dimension gating:compensation-ref="FCS" gating:min="${d.min}" gating:max="${d.max}"${d.asinh ? ' gating:transformation-ref="Tr_Arcsinh_5"' : ""}><data-type:fcs-dimension data-type:name="${d.channel}"/></gating:dimension>`;
  return `<gating:RectangleGate gating:id="${id}">${info}${dim(dims[0])}${dim(dims[1])}</gating:RectangleGate>`;
}

function population(id: string, setId: number, name: string, gateIds: number[], refs: string[], parentSet?: number): string {
  const expr = [...(parentSet !== undefined ? [`pop_${parentSet}`] : []), ...gateIds.map((g) => `gate_${g}`)].join(" AND ");
  const definition = JSON.stringify({ gates: gateIds, negGates: [], tailoredPerPopulation: {}, booleanExpression: expr });
  return `<gating:BooleanGate gating:id="${id}"><data-type:custom_info><cytobank><name>${name}</name><id>${setId * 100}</id><gate_set_id>${setId}</gate_set_id><version>-1</version><tailored>false</tailored><compensation_id>0</compensation_id><definition>${definition}</definition></cytobank></data-type:custom_info><gating:and>${refs.map((r) => `<gating:gateReference gating:ref="${r}"/>`).join("")}</gating:and></gating:BooleanGate>`;
}

/**
 * The tree: the Time gate alone makes "Time" (pop_6), as Cytobank repeats a population's whole
 * ancestry in its BooleanGate; Time and DNA make "Cells" (pop_7); two barcode populations under it, B1 and
 * B2, whose BooleanGates list only their own gates. With `tailorFor`, Cytobank's per-file copy of
 * the DNA gate for that file, drawn where no event is.
 */
export function fixtureGatingMl(opts: { tailorFor?: string } = {}): string {
  const time = rectangle("Gate_1_VGltZQ", 1, "Time", [
    { channel: "Time", min: 1, max: 1000, asinh: false },
    { channel: "Ir191Di", min: -1, max: 10, asinh: true },
  ]);
  const dna = rectangle("Gate_2_RE5B", 2, "DNA", [
    { channel: "Ir191Di", min: 4, max: 7, asinh: true },
    { channel: "Event_length", min: 0, max: 100, asinh: false },
  ]);
  const dnaTailored = opts.tailorFor
    ? rectangle("Gate_2t_RE5B", 2, "DNA", [
      { channel: "Ir191Di", min: 8, max: 9, asinh: true },
      { channel: "Event_length", min: 0, max: 100, asinh: false },
    ], opts.tailorFor)
    : "";
  const g10 = rectangle("Gate_10_MTA0KzEwNis", 10, "104+106+", [
    { channel: "Pd104Di", min: 3, max: 6, asinh: true },
    { channel: "Pd106Di", min: 3, max: 6, asinh: true },
  ]);
  const g11 = rectangle("Gate_11_MTA4LQ", 11, "108-", [
    { channel: "Pd108Di", min: -1, max: 2, asinh: true },
    { channel: "Pd104Di", min: -1, max: 10, asinh: true },
  ]);
  const g12 = rectangle("Gate_12_MTA0KzEwOCs", 12, "104+108+", [
    { channel: "Pd104Di", min: 3, max: 6, asinh: true },
    { channel: "Pd108Di", min: 3, max: 6, asinh: true },
  ]);
  const g13 = rectangle("Gate_13_MTA2LQ", 13, "106-", [
    { channel: "Pd106Di", min: -1, max: 2, asinh: true },
    { channel: "Pd104Di", min: -1, max: 10, asinh: true },
  ]);
  const timePop = population("GateSet_6", 6, "Time", [1], ["Gate_1_VGltZQ"]);
  const cells = population("GateSet_7", 7, "Cells", [1, 2], ["Gate_1_VGltZQ", "Gate_2_RE5B"]);
  const b1 = population("GateSet_8", 8, "B1", [10, 11], ["Gate_10_MTA0KzEwNis", "Gate_11_MTA4LQ"], 7);
  const b2 = population("GateSet_9", 9, "B2", [12, 13], ["Gate_12_MTA0KzEwOCs", "Gate_13_MTA2LQ"], 7);
  const about = `<data-type:custom_info><cytobank><about>Gating-ML 2.0 export of a synthetic experiment.</about><cytobank_gating_version>2.0</cytobank_gating_version></cytobank></data-type:custom_info>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML ${NS}>${about}${ASINH5}${time}${dna}${dnaTailored}${g10}${g11}${g12}${g13}${timePop}${cells}${b1}${b2}</gating:Gating-ML>\n`;
}
