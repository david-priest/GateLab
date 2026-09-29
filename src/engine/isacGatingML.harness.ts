// isacGatingML.harness.ts — the ISAC Gating-ML 2.0 compliance suite (gatingMLData 2.38.0), read
// through GateLab's own import and evaluated through the sample's own gating path.
//
// Test support only; nothing in the app imports it. The fixtures and their licence are in
// __fixtures__/isac-gatingml (README.md there).
//
// Each case is one gate of a set's file, imported on its own with what it depends on (its
// parent_id chain and the gates a BooleanGate references) and every transformation and matrix the
// file declares: GateLab refuses a whole file for one gate it cannot hold (a QuadrantGate, a
// hyperlog), and each case should say what happens to its own gate. The gate's population is then
// compared with the suite's per-event truth, event by event.
import { readFileSync } from "node:fs";
import { gunzipSync, strFromU8 } from "fflate";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { importGatingML, fcsDeclaresCompensation, gatingMLImportOptionsFor, resolveGatingMLCompensation } from "./gatingml";
import { applyGatingStrategy } from "./populations";

export const ISAC_DIR = "src/engine/__fixtures__/isac-gatingml";

/** The five Gating-ML files the suite ships, each with the FCS file its flowUtils test reads. */
export const ISAC_SETS = [
  { set: 1, gates: "gates1.xml", fcs: "data1.fcs" },
  { set: 2, gates: "gates2.xml", fcs: "data2.fcs" },
  { set: 3, gates: "gates3.xml", fcs: "9399_1_3_NKR.fcs" },
  { set: 4, gates: "gates4.xml", fcs: "9399_1_3_NKR.fcs" },
  { set: 5, gates: "gates5.xml", fcs: "9399_1_3_NKR.fcs" },
] as const;

export type IsacOutcome =
  | { kind: "not in the file" }
  | { kind: "match"; events: number }
  | { kind: "differ"; gatelab: number; expected: number; differing: number }
  | { kind: "refused"; message: string }
  | { kind: "left out"; warning: string };

/**
 * The FCS file as the suite's own reference reads it: flowCore's read.FCS with
 * transformation = "linearize-with-PnG-scaling" (flowUtils inst/RUnitGml2Script_Files), which
 * divides each linearly amplified channel by $PnG. GateLab keeps stored values, and data1.fcs
 * carries $P1G = 3.67 and $P2G = 8 on FSC-H and SSC-H, so those two columns are divided here, the
 * gain then stated as 1, and nothing else changes. Which side of Gating-ML's boundary a gain is
 * applied on is a separate question (PR #348); this suite is about what a gate means.
 */
export function isacSample(fcsName: string): Sample {
  const bytes = gunzipSync(new Uint8Array(readFileSync(`${ISAC_DIR}/${fcsName}.gz`)));
  const fcs = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  fcs.channels.forEach((ch, i) => {
    const key = `$P${i + 1}G`;
    const g = Number(fcs.keywords[key]);
    const logAmp = /^\s*[1-9]/.test(fcs.keywords[`$P${i + 1}E`] ?? "0");
    if (!Number.isFinite(g) || g <= 0 || g === 1 || logAmp || /^time$/i.test(ch.name)) return;
    const col = fcs.columns[ch.index];
    const out = new Float64Array(col.length);
    for (let j = 0; j < col.length; j++) out[j] = col[j] / g;
    fcs.columns[ch.index] = out;
    fcs.keywords[key] = "1";
    if ("gain" in ch) (ch as { gain?: number }).gain = 1;
  });
  return new Sample(fcs);
}

/** The suite's per-event truth for one set, by gate id. */
export function isacExpected(set: number): { events: number; gates: Record<string, Uint8Array> } {
  const json = JSON.parse(strFromU8(gunzipSync(new Uint8Array(readFileSync(`${ISAC_DIR}/expected-set${set}.json.gz`)))));
  const gates: Record<string, Uint8Array> = {};
  for (const [id, b64] of Object.entries(json.gates as Record<string, string>)) {
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    const bits = new Uint8Array(json.events);
    for (let i = 0; i < json.events; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
    gates[id] = bits;
  }
  return { events: json.events, gates };
}

const local = (el: Element, name: string) => {
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
};

/** One gate of a set's file, with what it depends on, as a document of its own. */
export function isacCaseDocument(xml: string, gateId: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  const byId = new Map<string, Element>();
  for (const el of Array.from(root.children)) {
    const id = local(el, "id");
    if (id && el.localName.endsWith("Gate")) byId.set(id, el);
    // A quadrant of a QuadrantGate is referenced by its own id; its case is its QuadrantGate.
    if (el.localName === "QuadrantGate") {
      for (const q of Array.from(el.getElementsByTagName("*"))) {
        const qid = q.localName === "Quadrant" ? local(q, "id") : null;
        if (qid) byId.set(qid, el);
      }
    }
  }
  const needed = new Set<string>();
  const visit = (id: string) => {
    if (needed.has(id) || !byId.has(id)) return;
    needed.add(id);
    const el = byId.get(id)!;
    needed.add(local(el, "id") ?? id);
    const parent = local(el, "parent_id");
    if (parent) visit(parent);
    for (const d of Array.from(el.getElementsByTagName("*"))) {
      if (d.localName === "gateReference") {
        const ref = local(d, "ref");
        if (ref) visit(ref);
      }
    }
  };
  visit(gateId);
  for (const el of Array.from(root.children)) {
    const keep = el.localName === "transformation" || el.localName === "spectrumMatrix"
      || (el.localName.endsWith("Gate") && needed.has(local(el, "id") ?? ""));
    if (!keep) root.removeChild(el);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** Whether the file declares this id, as a gate or as a quadrant of one. */
export function isacDeclares(xml: string, gateId: string): boolean {
  return new RegExp(`gating:id="${gateId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(xml);
}

/**
 * Import one case as the app does (App.tsx importGatingMLText and its confirm step): install a
 * matrix the file carries, turn compensation where the file asks, and compare the gate's
 * population with the truth.
 */
export function isacCase(xml: string, gateId: string, sample: Sample, expected: Uint8Array): IsacOutcome {
  if (!isacDeclares(xml, gateId)) return { kind: "not in the file" };
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  let res;
  try {
    res = importGatingML(isacCaseDocument(xml, gateId), sample.channels.map((c) => c.key), pnn, sample.instrument,
      gatingMLImportOptionsFor(sample));
  } catch (e) {
    return { kind: "refused", message: e instanceof Error ? e.message : String(e) };
  }
  const carried = res.spectrum_matrix && sample.instrument === "flow"
    ? { matrix: { channels: res.spectrum_matrix.channels, matrix: res.spectrum_matrix.matrix }, name: res.spectrum_matrix.name }
    : null;
  const external = carried ? sample.externalSpilloverPreview(carried.matrix) : null;
  let comp;
  try {
    comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, sample.instrument === "flow",
      external?.display ?? sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) });
  } catch (e) {
    return { kind: "refused", message: e instanceof Error ? e.message : String(e) };
  }
  if (comp.target === true && carried && external?.display) {
    sample.installExternalSpillover(carried.matrix, carried.name, { replaceEmbedded: sample.spillover !== null });
  }
  if (comp.target !== null && sample.compensationEnabled !== comp.target) sample.setCompensation(comp.target);
  const pop = Object.values(res.populations).find((p) => p.name === gateId);
  if (!pop) return { kind: "left out", warning: res.warnings.join(" ") || "(no warning)" };
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const mask = masks[pop.population_id];
  let gatelab = 0;
  let want = 0;
  let differing = 0;
  for (let i = 0; i < expected.length; i++) {
    gatelab += mask[i];
    want += expected[i];
    if (mask[i] !== expected[i]) differing++;
  }
  return differing === 0 ? { kind: "match", events: gatelab } : { kind: "differ", gatelab, expected: want, differing };
}
