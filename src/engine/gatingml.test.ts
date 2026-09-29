// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { importGatingML, normalizeChannel } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import type { Gate } from "./models";

const GATELABR = "vendor/GateLabR/Gates from GateLabR.xml";
const CYTOBANK = "vendor/GateLabR/Gates from Cytobank.xml";

/**
 * Per-event membership of one imported population over single-channel X data.
 * Import alone cannot show that NOT means what it should — only evaluating the
 * imported strategy against events can, so the NOT tests assert on this.
 */
function membership(
  res: ReturnType<typeof importGatingML>,
  popId: string,
  xs: number[],
): number[] {
  const data = { n: xs.length, column: (ch: string) => (ch === "X" ? xs : undefined) };
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, data);
  return Array.from(masks[popId]);
}

/** The non-root population with this name, and the names of all of them. */
function populationNamed(res: ReturnType<typeof importGatingML>, name: string) {
  const pop = Object.values(res.populations).find((p) => p.name === name);
  expect(pop, name).toBeDefined();
  return pop!;
}
const populationNames = (res: ReturnType<typeof importGatingML>) =>
  Object.values(res.populations).filter((p) => p.population_id !== res.root_population_id).map((p) => p.name).sort();

/** The single non-root population of a minimal import fixture. */
function onlyPopulation(res: ReturnType<typeof importGatingML>) {
  const pops = Object.values(res.populations).filter(
    (p) => p.population_id !== res.root_population_id,
  );
  expect(pops).toHaveLength(1);
  return pops[0];
}

/** All fcs-dimension channel names referenced in a Gating-ML file. */
function channelsIn(xml: string): string[] {
  const set = new Set<string>();
  for (const m of xml.matchAll(/data-type:name="([^"]+)"/g)) set.add(m[1]);
  return [...set];
}

describe("importGatingML — GateLabR export (GatingHierarchy path)", () => {
  const xml = readFileSync(GATELABR, "utf8");
  const channels = channelsIn(xml);
  const res = importGatingML(xml, channels);

  it("resolves every channel (no skips)", () => {
    // This export is Cytobank-format-compatible (no gatelabr_scales block), so it's
    // detected as "cytobank" — but it uses the GatingHierarchy path (tested below).
    expect(res.source).toBe("cytobank");
    expect(channels.length).toBeGreaterThan(2);
    expect(res.skipped_channels).toEqual([]);
    expect(res.n_gates_skipped).toBe(0);
  });

  it("imports primitive gates (polygon + rectangle)", () => {
    expect(res.n_gates_imported).toBeGreaterThan(20);
    const types = new Set(Object.values(res.gates).map((g) => g.gate_type));
    expect(types.has("polygon")).toBe(true);
    expect(types.has("rectangle")).toBe(true);
  });

  it("builds a population hierarchy from PopulationGatePairs", () => {
    expect(res.n_pops_imported).toBeGreaterThan(5);
    // every non-root population has a parent that exists
    const ids = new Set(Object.keys(res.populations));
    for (const p of Object.values(res.populations)) {
      if (p.population_id === res.root_population_id) continue;
      expect(p.parent_id).toBeTruthy();
      expect(ids.has(p.parent_id!)).toBe(true);
    }
    // there is real nesting (some population's parent is not the root)
    const nested = Object.values(res.populations).some(
      (p) => p.parent_id && p.parent_id !== res.root_population_id,
    );
    expect(nested).toBe(true);
  });

  it("every population gate_ref points at an imported gate", () => {
    for (const p of Object.values(res.populations)) {
      for (const ref of p.gate_refs) expect(res.gates[ref.gate_id]).toBeDefined();
    }
  });
});

describe("importGatingML — Cytobank export (flat Boolean path)", () => {
  const xml = readFileSync(CYTOBANK, "utf8");
  const channels = channelsIn(xml);
  const res = importGatingML(xml, channels);

  it("imports gates and reconstructs populations from Boolean gates", () => {
    expect(res.source).toBe("cytobank");
    expect(res.n_gates_imported).toBeGreaterThan(20);
    expect(res.n_pops_imported).toBeGreaterThan(5);
  });
});

describe("channel resolution", () => {
  it("normalizes metal names to a canonical token", () => {
    expect(normalizeChannel("Pr141Di")).toBe("pr141");
    expect(normalizeChannel("141Pr")).toBe("pr141");
    expect(normalizeChannel("CD3 (Y89Di)")).toBe("y89");
  });

  // A conventional flow panel puts the same optical filter behind several lasers, so the laser
  // prefix is the only thing separating two detectors. normalizeChannel is a CyTOF metal-name
  // helper, and until 2026-09 it kept any name's first letter+number token and discarded the rest,
  // so both of these reduced to "flt525". Matching the first hit evaluated a violet-laser viability
  // gate against the BLUE laser's detector: the gate resolved, drew, and reported a plausible count.
  // On a real FlowJo workspace that put the top gate 14% out with nothing reported. Neither names a
  // metal now, and the metal step is left to mass cytometry data besides.
  it("does not confuse two detectors behind the same filter", () => {
    expect(normalizeChannel("v-FLT525/30-E-A")).toBe("");
    expect(normalizeChannel("b-FLT525/30-B-A")).toBe("");

    const rect = (channel: string) => `
      <gating:RectangleGate gating:id="g1" gating:name="Live">
        <gating:dimension gating:min="10" gating:max="20">
          <data-type:fcs-dimension data-type:name="${channel}"/></gating:dimension>
        <gating:dimension gating:min="10" gating:max="20">
          <data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
      </gating:RectangleGate>`;
    const doc = (channel: string) => `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">${rect(channel)}
      </gating:Gating-ML>`;
    // The session names channels by marker, so resolution runs through the $PnN map.
    const session = ["Viability (v-FLT525/30-E-A)", "Spare (b-FLT525/30-B-A)", "SSC-A"];
    const pnn = {
      "v-FLT525/30-E-A": "Viability (v-FLT525/30-E-A)",
      "b-FLT525/30-B-A": "Spare (b-FLT525/30-B-A)",
      "SSC-A": "SSC-A",
    };

    // FlowJo writes the separator as "_", the FCS as "/". That difference alone must still resolve,
    // and must resolve to the VIOLET detector.
    const viaUnderscore = importGatingML(doc("v-FLT525_30-E-A"), session, pnn, "flow");
    expect(Object.values(viaUnderscore.gates)[0].x_channel).toBe("Viability (v-FLT525/30-E-A)");

    const exact = importGatingML(doc("b-FLT525/30-B-A"), session, pnn, "flow");
    expect(Object.values(exact.gates)[0].x_channel).toBe("Spare (b-FLT525/30-B-A)");

    // A name that matches NEITHER detector exactly is ambiguous under the metal normaliser, and
    // an ambiguous match must fail the import rather than pick one.
    expect(() => importGatingML(doc("FLT525"), session, pnn, "flow")).toThrow(/FLT525/);
  });

  describe("the scale a file's logicle coordinates are on", () => {
    const T = 846653.2;
    /** A logicle rectangle from 0 to `hi` on both axes, with `header` inside the root. */
    const logicleFile = (hi: string, header = "") => `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">${header}
        <transforms:transformation transforms:id="Tr_L">
          <transforms:logicle transforms:T="${T}" transforms:W="1.5" transforms:M="4.5" transforms:A="0"/>
        </transforms:transformation>
        <gating:RectangleGate gating:id="g1">
          <gating:dimension gating:min="0" gating:max="${hi}" gating:transformation-ref="Tr_L"><data-type:fcs-dimension data-type:name="CD19"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="${hi}" gating:transformation-ref="Tr_L"><data-type:fcs-dimension data-type:name="CD14"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const topOf = (xml: string) => {
      const g = Object.values(importGatingML(xml, ["CD19", "CD14"]).gates)[0];
      const verts = "vertices" in g ? g.vertices : [];
      return { g, hi: Math.max(...verts.map((v) => v[0])), lo: Math.min(...verts.map((v) => v[0])) };
    };

    it("reads a file from another tool on Gating-ML 2.0's own scale, where T is 1", () => {
      // Specification §6.4.1: the logicle scale maps T to 1. Reading every unmarked file on
      // flowCore's scale (T at M) put a standard file's gate 4.5 times too low.
      const { g, hi, lo } = topOf(logicleFile("1"));
      expect(hi).toBeCloseTo(1, 12);
      expect(lo).toBeCloseTo(0, 12);
      // The gate keeps the space the file declared, with the transform recorded on it, rather
      // than being inverted into raw, which per Gating-ML §2.3.2 would be a different gate.
      expect(g.space).toBe("display");
      expect(g.transforms?.CD19).toEqual({ kind: "logicle", T, W: 1.5, M: 4.5, A: 0 });
    });

    it("reads an unmarked GateLab or GateLabR file on flowCore's scale, where T is at M", () => {
      // Each of the three things only GateLab and GateLabR write identifies such a file. A vertex
      // at M must land at exactly 1 in GateLab units; read as [0, 1] it would sit at 4.5, off the
      // top of the scale, and inverting that blows up to ~1e23, which is what this first caught.
      const about = (who: string) => `<data-type:custom_info><cytobank>
          <about>Gating-ML 2.0 export from ${who} (standard / re-importable)</about></cytobank></data-type:custom_info>`;
      const scales = `<data-type:custom_info><gatelabr_scales><definition>{"version":3,"channels":{}}</definition></gatelabr_scales></data-type:custom_info>`;
      for (const header of [about("GateLab"), about("GateLabR"), scales]) {
        const { hi, lo } = topOf(logicleFile("4.5", header));
        expect(hi).toBeCloseTo(1, 9);
        expect(lo).toBeCloseTo(0, 9);
      }
      const hierarchy = logicleFile("4.5").replace("</gating:Gating-ML>",
        `<gating:GatingHierarchy><gating:PopulationGatePair gating:gate-ref="g1"><gating:name>P</gating:name></gating:PopulationGatePair></gating:GatingHierarchy></gating:Gating-ML>`);
      expect(topOf(hierarchy).hi).toBeCloseTo(1, 9);
    });

    it("reads flowCore's scale as Gating-ML's times M, whatever A is", () => {
      // flowCore's logicleTransform maps T to M for every A (checked in R: A = 0, 0.5 and 1 all
      // give 4.5 at T with M = 4.5), so its coordinate is Gating-ML's times M, not M + A. The two
      // agree only for the A = 0 GateLab and GateLabR write; at A = 0.5 a vertex at 4.5 is T.
      const scales = `<data-type:custom_info><gatelabr_scales><definition>{"version":3,"channels":{}}</definition></gatelabr_scales></data-type:custom_info>`;
      const withA = logicleFile("4.5", scales).replace('transforms:A="0"', 'transforms:A="0.5"');
      expect(topOf(withA).hi).toBeCloseTo(1, 9);
      // Beside an axis on a non-canonical fasinh, which is held exactly too, the same factor
      // applies: the vertex at 4.5 is the top of GateLab's logicle, T itself.
      const mixed = withA
        .replace("</transforms:transformation>", `</transforms:transformation>
        <transforms:transformation transforms:id="Tr_Odd"><transforms:fasinh transforms:T="1000" transforms:M="2" transforms:A="0.5"/></transforms:transformation>`)
        .replace(/(<gating:dimension gating:min="0" gating:max="4.5" gating:transformation-ref=")Tr_L("><data-type:fcs-dimension data-type:name="CD14")/, "$1Tr_Odd$2");
      const res = importGatingML(mixed, ["CD19", "CD14"], {}, "flow");
      const g = Object.values(res.gates)[0] as { space?: string; vertices: [number, number][] };
      expect(g.space).toBe("display");
      expect(Math.max(...g.vertices.map((v) => v[0]))).toBeCloseTo(1, 9);
    });

    it("lets the GateLab format mark name the scale, whoever wrote the rest", () => {
      const mark = (logicle: string, extra = "") => `<data-type:custom_info>${extra}
          <gatelab_format>{"version":2,"logicle":"${logicle}"}</gatelab_format></data-type:custom_info>`;
      const gatelab = `<cytobank><about>Gating-ML 2.0 export from GateLab (standard / re-importable)</about></cytobank>`;
      expect(topOf(logicleFile("1", mark("gating-ml", gatelab))).hi).toBeCloseTo(1, 12);
      expect(topOf(logicleFile("4.5", mark("flowcore"))).hi).toBeCloseTo(1, 9);
      // A mark that names no scale leaves the decision to who wrote the file.
      const noScale = (extra = "") => `<data-type:custom_info>${extra}
          <gatelab_format>{"version":2}</gatelab_format></data-type:custom_info>`;
      expect(topOf(logicleFile("4.5", noScale(gatelab))).hi).toBeCloseTo(1, 9);
      expect(topOf(logicleFile("1", noScale())).hi).toBeCloseTo(1, 12);
      // A mark that names a scale GateLab does not know is refused, not read as no mark.
      expect(() => topOf(logicleFile("1", mark("other")))).toThrow(/unknown logicle scale "other"/);
    });
  });

  // The metal normaliser is a CyTOF helper. Refusing an AMBIGUOUS flow match (2026-09-10)
  // covered a file holding both detectors behind one filter; a file holding only the other
  // laser's detector still resolved the gate onto it, with nothing reported. A flow name that
  // survives no exact test is absent, and the import says so.
  it("does not resolve a flow gate onto a different detector through the metal normaliser", () => {
    const rect = (channel: string) => `
      <gating:RectangleGate gating:id="g1" gating:name="Live">
        <gating:dimension gating:min="10" gating:max="20">
          <data-type:fcs-dimension data-type:name="${channel}"/></gating:dimension>
        <gating:dimension gating:min="10" gating:max="20">
          <data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
      </gating:RectangleGate>`;
    const doc = (channel: string) => `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">${rect(channel)}
      </gating:Gating-ML>`;
    // Only the BLUE detector is loaded; the gate names the violet one.
    const session = ["Spare (b-FLT525/30-B-A)", "SSC-A"];
    const pnn = { "b-FLT525/30-B-A": "Spare (b-FLT525/30-B-A)", "SSC-A": "SSC-A" };
    expect(() => importGatingML(doc("v-FLT525_30-E-A"), session, pnn, "flow")).toThrow(/v-FLT525_30-E-A/);
    // PE-CF594 is not CF594 either.
    expect(() => importGatingML(doc("PE-CF594-A"), ["PE-A", "CF594-A", "SSC-A"],
      { "PE-A": "PE-A", "CF594-A": "CF594-A", "SSC-A": "SSC-A" }, "flow")).toThrow(/PE-CF594-A/);
  });

  // ch1: $PnN FL1-A, $PnS FITC-A (key "FITC-A"); ch2: $PnN FITC-A, $PnS CD3 (key "CD3"). A gate on
  // "FITC-A" names ch2 by $PnN and ch1 by key at once; taking the key put it on the wrong detector.
  it("refuses a name that is one channel's key and another channel's $PnN", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="g1" gating:name="Pos">
          <gating:dimension gating:min="10" gating:max="20"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
          <gating:dimension gating:min="10" gating:max="20"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const session = ["FITC-A", "CD3", "SSC-A"];
    const pnn = { "FL1-A": "FITC-A", "FITC-A": "CD3", "SSC-A": "SSC-A" };
    expect(() => importGatingML(xml, session, pnn, "flow")).toThrow(/FITC-A/);
    // With no such collision the key resolves as it always did.
    expect(importGatingML(xml, session, { "FL1-A": "FITC-A", "SSC-A": "SSC-A" }, "flow").n_gates_imported).toBe(1);
  });

  it("resolves metal $PnN via the pnn→channel bridge", () => {
    // GatingML dimension "196Pt_CD45" resolves to the session channel "CD45"
    // through a pnn map keyed by the metal.
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="g1">
          <gating:dimension gating:min="0" gating:max="5"><data-type:fcs-dimension data-type:name="196Pt_CD45"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="5"><data-type:fcs-dimension data-type:name="89Y_CD3"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["CD45", "CD3"], { "196Pt": "CD45", "89Y": "CD3" });
    expect(res.n_gates_imported).toBe(1);
    const g = Object.values(res.gates)[0];
    expect([g.x_channel, g.y_channel].sort()).toEqual(["CD3", "CD45"]);
  });
});

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

describe("strict import safety", () => {
  it("cancels instead of silently dropping unsupported gates or transforms", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <transforms:transformation transforms:id="linear-1">
          <transforms:linear transforms:T="100" transforms:A="0"/>
        </transforms:transformation>
        <gating:PolygonGate gating:id="poly-1">
          <gating:dimension gating:transformation-ref="linear-1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
          <gating:dimension gating:transformation-ref="linear-1"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
          <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="0"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="0"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="1"/></gating:vertex>
        </gating:PolygonGate>
        <gating:EllipsoidGate gating:id="ellipse-1"/>
      </gating:Gating-ML>`;

    // EllipsoidGate is a supported type now, so a MALFORMED one (no mean, no covariance) must
    // cancel as unparseable rather than pass unnoticed — the safety property is unchanged.
    expect(() => importGatingML(xml, ["X", "Y"])).toThrow(/EllipsoidGate .*could not be parsed/);
    expect(() => importGatingML(xml, ["X", "Y"])).toThrow(/transformation linear-1/);
  });

  it("imports flat NOT logic as an excluded gate reference", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Inside">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="not-1" gating:name="Outside">
          <gating:not><gating:gateReference gating:ref="range-1"/></gating:not>
        </gating:BooleanGate>
      </gating:Gating-ML>`;

    const res = importGatingML(xml, ["X"]);
    expect(res.n_gates_imported).toBe(1);
    // Gating-ML 2.0: the range is a population too, and the NOT one beside it.
    expect(populationNames(res)).toEqual(["Inside", "Outside"]);
    const pop = populationNamed(res, "Outside");
    expect(pop.gate_refs).toHaveLength(1);
    expect(pop.gate_refs[0].include).toBe(false);
    // range-1 is X in [0, 1], so only the first event is inside it.
    expect(membership(res, pop.population_id, [0.5, 1.5, 2.5])).toEqual([0, 1, 1]);
  });

  // FlowJo's Gating-ML 2.0 export carries no BooleanGate and no
  // <GatingHierarchy>; ancestry lives only in gating:parent_id. Ignoring it
  // parents every gate to root, so each population is measured against All
  // Events and child counts exceed their parents' — the import looks like it
  // worked while being wrong.
  it("nests populations declared with gating:parent_id", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="g-scatter" gating:name="Scatter">
          <gating:dimension gating:min="0" gating:max="10"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="g-singlets" gating:parent_id="g-scatter" gating:name="Singlets">
          <gating:dimension gating:min="0" gating:max="5"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="g-b" gating:parent_id="g-singlets" gating:name="B cells">
          <gating:dimension gating:min="0" gating:max="2"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;

    const res = importGatingML(xml, ["X"]);
    expect(res.n_gates_imported).toBe(3);

    const byName: Record<string, string> = {};
    for (const pop of Object.values(res.populations)) byName[pop.name] = pop.population_id;

    expect(res.populations[byName["Scatter"]].parent_id).toBe(res.root_population_id);
    expect(res.populations[byName["Singlets"]].parent_id).toBe(byName["Scatter"]);
    expect(res.populations[byName["B cells"]].parent_id).toBe(byName["Singlets"]);

    // Each population carries only its own gate; ancestry supplies the rest.
    expect(res.populations[byName["B cells"]].gate_refs).toHaveLength(1);

    // The defect this pins is quantitative: event 7 is inside Scatter only,
    // event 3 inside Scatter+Singlets, event 1 inside all three. Flat parenting
    // would put 7 in Scatter and 3 in Singlets independently of their parents.
    const xs = [1, 3, 7, 20];
    expect(membership(res, byName["Scatter"], xs)).toEqual([1, 1, 1, 0]);
    expect(membership(res, byName["Singlets"], xs)).toEqual([1, 1, 0, 0]);
    expect(membership(res, byName["B cells"], xs)).toEqual([1, 0, 0, 0]);
  });

  // Which space an arcsinh vertex is in depends on how the app stores gates for that
  // instrument, not on the transform. Flow stores raw, so a flow fluorescence arcsinh vertex
  // must be inverted; CyTOF stores arcsinh, so it must not be. Treating flow as CyTOF left
  // every fluorescence gate sitting at its transformed coordinate — a plausible number in the
  // wrong space, which is how a Cytobank-exchanged flow strategy silently lands wrong.
  it("keeps arcsinh vertices in the declared space for BOTH instruments", () => {
    const cf = 150;
    const T = cf * Math.sinh(1);
    const raw = 1000;
    const transformed = Math.asinh(raw / cf);
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations">
        <transforms:transformation transforms:id="Tr_Fasinh_150">
          <transforms:fasinh transforms:T="${T}" transforms:M="0.43429448190325176" transforms:A="0"/>
        </transforms:transformation>
        <gating:RectangleGate gating:id="r1" gating:name="R">
          <gating:dimension gating:min="${transformed}" gating:max="${transformed * 2}"
            gating:transformation-ref="Tr_Fasinh_150">
            <data-type:fcs-dimension data-type:name="PE-A"/>
          </gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;

    // The instrument no longer decides the coordinate space — the FILE does. A dimension that
    // declares fasinh means "straight in fasinh", for flow exactly as for CyTOF, so both keep the
    // transformed coordinate and record the transform. Previously flow inverted to raw, which
    // silently produced a different gate from the one the file describes.
    for (const instrument of ["flow", "cytof"] as const) {
      const res = importGatingML(xml, ["PE-A"], {}, instrument);
      const g = Object.values(res.gates)[0] as { vertices: [number, number][]; space?: string;
        transforms?: Record<string, { kind: string; cofactor?: number }> };
      expect(g.vertices[0][0], instrument).toBeCloseTo(transformed, 6);
      expect(g.space, instrument).toBe("display");
      expect(g.transforms?.["PE-A"]?.kind).toBe("asinh");
      expect(g.transforms?.["PE-A"]?.cofactor).toBeCloseTo(cf, 6);
      // Not the raw value: keeping it raw is the bug this replaced.
      expect(g.vertices[0][0]).not.toBeCloseTo(raw, 3);
    }
  });

  it("imports a dimension with no transformation-ref as a raw-space gate", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
        <gating:RectangleGate gating:id="r1" gating:name="R">
          <gating:dimension gating:min="200" gating:max="8000">
            <data-type:fcs-dimension data-type:name="PE-A"/>
          </gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["PE-A"], {}, "flow");
    const g = Object.values(res.gates)[0] as { vertices: [number, number][]; space?: string };
    expect(g.space).toBe("raw");
    expect(g.vertices.map((v) => v[0])).toContain(200); // verbatim, nothing applied
    expect(res.n_gates_skipped).toBe(0);
  });

  it("keeps a flog gate in log space rather than inverting it into raw", () => {
    // Gating-ML makes the transform part of the gate, and GateLab can hold a log space even
    // though it never draws a log axis — the same arrangement biex and wsplog already use.
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations">
        <transforms:transformation transforms:id="Tr_Log">
          <transforms:flog transforms:T="10000" transforms:M="4"/>
        </transforms:transformation>
        <gating:RectangleGate gating:id="r1" gating:name="Logged">
          <gating:dimension gating:min="1" gating:max="2" gating:transformation-ref="Tr_Log">
            <data-type:fcs-dimension data-type:name="PE-A"/>
          </gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["PE-A"], {}, "flow");
    const g = Object.values(res.gates)[0] as {
      space?: string; vertices: [number, number][];
      transforms?: Record<string, { kind: string; T?: number; M?: number }>;
    };
    expect(g.space).toBe("display");
    // Gating-ML's own flog: this file is not GateLab's, so nothing is pinned at the floor.
    expect(g.transforms?.["PE-A"]).toEqual({ kind: "flog", T: 10000, M: 4, standard: true });
    // Vertices stay in the declared units, not inverted to 10^(...)·T.
    expect(Math.min(...g.vertices.map((v) => v[0]))).toBeCloseTo(1, 12);
    expect(res.n_gates_skipped).toBe(0);
  });

  it("holds a fasinh with any M and A exactly, as asinh with an affine change of units", () => {
    // Gating-ML fasinh is (asinh(x / c) + A ln10) / ((M + A) ln10) with c = T / sinh(M ln10), which
    // is affine in GateLab's asinh(x / c). This was inverted into raw instead, with the sign of A
    // reversed, and reported in a field the app never showed. A polygon, which is straight in the
    // declared space; a rectangle from another writer is held on raw values with its edges placed
    // exactly (gatingmlTransforms.test.ts, "a rectangle edge on an event's own value").
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations">
        <transforms:transformation transforms:id="Tr_Odd">
          <transforms:fasinh transforms:T="1000" transforms:M="2" transforms:A="0.5"/>
        </transforms:transformation>
        <gating:PolygonGate gating:id="r1" gating:name="Odd">
          <gating:dimension gating:transformation-ref="Tr_Odd"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
          <gating:dimension gating:transformation-ref="Tr_Odd"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
          <gating:vertex><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="1"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="2"/><gating:coordinate data-type:value="1"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="2"/><gating:coordinate data-type:value="2"/></gating:vertex>
        </gating:PolygonGate>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["PE-A", "FITC-A"], {}, "flow");
    const g = Object.values(res.gates)[0] as { space?: string; vertices: [number, number][];
      transforms?: Record<string, { kind: string; cofactor?: number }> };
    expect(g.space).toBe("display");
    expect(g.transforms?.["PE-A"]?.kind).toBe("asinh");
    const c = 1000 / Math.sinh(2 * Math.LN10);
    expect(g.transforms?.["PE-A"]?.cofactor).toBeCloseTo(c, 9);
    // Stored asinh(x / c) at the file's 1 and 2: y(M + A) ln10 − A ln10.
    const xs = g.vertices.map((v) => v[0]);
    expect(Math.min(...xs)).toBeCloseTo(2.5 * Math.LN10 - 0.5 * Math.LN10, 12);
    expect(Math.max(...xs)).toBeCloseTo(5 * Math.LN10 - 0.5 * Math.LN10, 12);
    expect(res.n_gates_skipped).toBe(0);
  });

  it("rejects a gating:parent_id that names no gate in the file", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="g-child" gating:parent_id="g-absent" gating:name="Orphan">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;

    expect(() => importGatingML(xml, ["X"])).toThrow(/missing parent gate g-absent/);
  });

  it("imports a complemented reference inside an AND population", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Inside">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="and-not-1" gating:name="Outside">
          <gating:and>
            <gating:gateReference gating:ref="range-1" gating:complement="true"/>
          </gating:and>
        </gating:BooleanGate>
      </gating:Gating-ML>`;

    const res = importGatingML(xml, ["X"]);
    expect(populationNames(res)).toEqual(["Inside", "Outside"]);
    const pop = populationNamed(res, "Outside");
    expect(pop.gate_logic).toBe("and");
    expect(pop.gate_refs[0].include).toBe(false);
    expect(membership(res, pop.population_id, [0.5, 1.5, 2.5])).toEqual([0, 1, 1]);
  });

  it("imports a complemented hierarchy population", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Inside">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:GatingHierarchy>
          <gating:PopulationGatePair gating:gate-ref="range-1" gating:complement="true">
            <gating:name>Outside</gating:name>
          </gating:PopulationGatePair>
        </gating:GatingHierarchy>
      </gating:Gating-ML>`;

    const res = importGatingML(xml, ["X"]);
    const pop = onlyPopulation(res);
    expect(pop.name).toBe("Outside");
    expect(pop.gate_refs[0].include).toBe(false);
    expect(membership(res, pop.population_id, [0.5, 1.5, 2.5])).toEqual([0, 1, 1]);
  });

  it("leaves an OR population out, names it, and imports the rest", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Low">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="range-2" gating:name="High">
          <gating:dimension gating:min="2" gating:max="3"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="or-1" gating:name="Low or high">
          <gating:or>
            <gating:gateReference gating:ref="range-1"/>
            <gating:gateReference gating:ref="range-2"/>
          </gating:or>
        </gating:BooleanGate>
        <gating:BooleanGate gating:id="and-1" gating:name="Low only">
          <gating:and>
            <gating:gateReference gating:ref="range-1"/>
            <gating:gateReference gating:ref="range-1"/>
          </gating:and>
        </gating:BooleanGate>
      </gating:Gating-ML>`;

    // Refusing the whole file for one OR population, as GateLab did until 2026-09, lost every
    // other population with it; the FlowJo workspace import already skipped an OrNode by name.
    const res = importGatingML(xml, ["X"]);
    expect(populationNames(res)).toEqual(["High", "Low", "Low only"]);
    const pop = populationNamed(res, "Low only");
    expect(membership(res, pop.population_id, [0.5, 1.5, 2.5])).toEqual([1, 0, 0]);
    expect(res.warnings).toEqual([
      '"Low or high" combines its references with OR, which GateLab cannot represent; it and anything below it were skipped.',
    ]);
  });

  it("leaves an OR population of an older GateLab file out with its subtree", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Low">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="range-2" gating:name="High">
          <gating:dimension gating:min="2" gating:max="3"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="or-1">
          <gating:or>
            <gating:gateReference gating:ref="range-1"/>
            <gating:gateReference gating:ref="range-2"/>
          </gating:or>
        </gating:BooleanGate>
        <gating:GatingHierarchy>
          <gating:PopulationGatePair gating:gate-ref="or-1">
            <gating:name>Low or high</gating:name>
            <gating:PopulationGatePair gating:gate-ref="range-2"><gating:name>High within</gating:name></gating:PopulationGatePair>
          </gating:PopulationGatePair>
          <gating:PopulationGatePair gating:gate-ref="range-1"><gating:name>Low</gating:name></gating:PopulationGatePair>
        </gating:GatingHierarchy>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["X"]);
    expect(onlyPopulation(res).name).toBe("Low");
    expect(res.warnings).toEqual([expect.stringMatching(/^"Low or high" combines its references with OR/)]);
  });

  it("applies De Morgan to a complemented AND population rather than rejecting it", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="range-1" gating:name="Low">
          <gating:dimension gating:min="0" gating:max="2"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="range-2" gating:name="High">
          <gating:dimension gating:min="1" gating:max="3"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="and-1" gating:name="Both">
          <gating:and>
            <gating:gateReference gating:ref="range-1"/>
            <gating:gateReference gating:ref="range-2"/>
          </gating:and>
        </gating:BooleanGate>
        <gating:GatingHierarchy>
          <gating:PopulationGatePair gating:gate-ref="and-1" gating:complement="true">
            <gating:name>Not both</gating:name>
          </gating:PopulationGatePair>
        </gating:GatingHierarchy>
      </gating:Gating-ML>`;

    // NOT (A AND B) is OR of the negated refs, which is a single-logic population
    // and therefore representable, unlike a genuinely mixed expression.
    const res = importGatingML(xml, ["X"]);
    const pop = onlyPopulation(res);
    expect(pop.gate_logic).toBe("or");
    expect(pop.gate_refs.map((r) => r.include)).toEqual([false, false]);
    // A is X in [0, 2], B is X in [1, 3], so A AND B is X in [1, 2].
    expect(membership(res, pop.population_id, [0.5, 1.5, 2.5, 3.5])).toEqual([1, 0, 1, 1]);
  });

  it("rejects a missing gate channel instead of weakening an AND population", () => {
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:RectangleGate gating:id="present-1" gating:name="Present gate">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        </gating:RectangleGate>
        <gating:RectangleGate gating:id="missing-1" gating:name="Missing gate">
          <gating:dimension gating:min="0" gating:max="1"><data-type:fcs-dimension data-type:name="Absent"/></gating:dimension>
        </gating:RectangleGate>
        <gating:BooleanGate gating:id="both-1" gating:name="Both gates">
          <gating:and>
            <gating:gateReference gating:ref="present-1"/>
            <gating:gateReference gating:ref="missing-1"/>
          </gating:and>
        </gating:BooleanGate>
      </gating:Gating-ML>`;

    expect(() => importGatingML(xml, ["X"])).toThrow(
      /Gate "Missing gate" \(missing-1\) references channel\(s\) not present in the loaded data: "Absent"/,
    );
    expect(() => importGatingML(xml, ["X"])).toThrow(
      /Partial Gating-ML imports are not allowed because dropping a gate can change population membership/,
    );
  });
});

// ── CyTOF Gaussian channels keep their declared arcsinh space ───────────────────────────────
//
// Cytobank exports a CyTOF WidthGate with its Width dimension in ARCSINH space
// (transformation-ref="Tr_Arcsinh_5", min 3.818 / max 4.560 ≈ raw 113–238, exactly where
// Gaussian data sits). Width matches isQcChannel by NAME, and the 0.7.0 per-gate-space rewrite
// used that generic test to strip the declared transform on import — the vertices were kept but
// the gate was stamped space:"raw", so the band evaluated and drew at raw 3.8–4.6, far below
// the data (nPhos4, "cytobank gates 36 pops.xml"). The instrument decides which channels are
// never transformed: for CyTOF only the true raw channels are, and the Gaussian parameters are
// displayed and gated in arcsinh exactly like the metals.
describe("CyTOF Gaussian channel import", () => {
  const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
  const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
  const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
  // The real nPhos4 WidthGate, verbatim values.
  const xml = `<gating:Gating-ML xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}">
    <transforms:transformation transforms:id="Tr_Arcsinh_5">
      <transforms:fasinh transforms:T="5.8760059682190064" transforms:M="0.43429448190325176" transforms:A="0" />
    </transforms:transformation>
    <gating:RectangleGate gating:id="Gate_1_V2lkdGhHYXRl">
      <data-type:custom_info><cytobank><name>WidthGate</name><id>1</id><gate_id>1</gate_id>
        <type>RectangleGate</type><definition>{}</definition></cytobank></data-type:custom_info>
      <gating:dimension gating:compensation-ref="FCS" gating:min="-57210.19889294151" gating:max="11589746.536096007">
        <data-type:fcs-dimension data-type:name="Time" />
      </gating:dimension>
      <gating:dimension gating:compensation-ref="FCS" gating:min="3.817958837656066" gating:max="4.55972465093369" gating:transformation-ref="Tr_Arcsinh_5">
        <data-type:fcs-dimension data-type:name="Width" />
      </gating:dimension>
    </gating:RectangleGate>
    <gating:BooleanGate gating:id="GateSet_1">
      <data-type:custom_info><cytobank><name>WidthGate</name><id>11</id><gate_set_id>1</gate_set_id>
        <definition>{"gates":[1],"negGates":[]}</definition></cytobank></data-type:custom_info>
      <gating:and>
        <gating:gateReference gating:ref="Gate_1_V2lkdGhHYXRl" />
        <gating:gateReference gating:ref="Gate_1_V2lkdGhHYXRl" />
      </gating:and>
    </gating:BooleanGate>
  </gating:Gating-ML>`;

  it("imports the Width axis as a display-space arcsinh gate, not raw", () => {
    const res = importGatingML(xml, ["Time", "Width"], {}, "cytof");
    expect(res.n_gates_imported).toBe(1);
    const g = Object.values(res.gates)[0] as {
      space?: string; transforms?: Record<string, { kind: string; cofactor?: number }>;
      vertices: [number, number][];
    };
    expect(g.space).toBe("display");
    expect(g.transforms?.["Width"]?.kind).toBe("asinh");
    expect(g.transforms?.["Width"]?.cofactor).toBeCloseTo(5, 6);
    // Vertices stay in the declared space — the transform is carried, not baked in.
    const ys = g.vertices.map((v) => v[1]);
    expect(Math.min(...ys)).toBeCloseTo(3.817958837656066, 9);
    expect(Math.max(...ys)).toBeCloseTo(4.55972465093369, 9);
  });

  it("selects Gaussian events where the data actually is", () => {
    const res = importGatingML(xml, ["Time", "Width"], {}, "cytof");
    // Width raw values around 150 sit INSIDE the band (asinh(150/5) ≈ 4.09); values around 4
    // — where the broken import put the gate — sit far outside it.
    const time = [1000, 1000, 1000, 1000];
    const width = [150, 238, 4, 500];
    const data = {
      n: 4,
      column: (ch: string) => (ch === "Time" ? time : ch === "Width" ? width : undefined),
    };
    // Evaluate through the gate-space machinery the app uses: transform raw -> the gate's own
    // space per axis, as columnsForGate does for a display-space gate.
    const g = Object.values(res.gates)[0] as {
      transforms?: Record<string, { cofactor?: number }>; vertices: [number, number][];
    };
    const cf = g.transforms?.["Width"]?.cofactor ?? NaN;
    const ys = g.vertices.map((v) => v[1]);
    const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
    const inside = width.map((w) => Math.asinh(w / cf) >= lo && Math.asinh(w / cf) <= hi);
    expect(inside).toEqual([true, true, false, false]);
    void data;
  });
});

describe("a population whose gate could not be imported", () => {
  // An ellipse with a ratio dimension (a Gating-ML new-dimension through fratio) cannot be
  // imported: GateLab has no ratio channel. Such a population used to be built anyway, without the
  // gate, and so held every event of its parent. (Until 2026-09 these tests used an ellipse on a
  // fasinh with M = 4, which GateLab now holds exactly.)
  const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
  const oddScale = `<transforms:transformation transforms:id="Rat">
      <transforms:fratio transforms:A="1" transforms:B="0" transforms:C="0">
        <data-type:fcs-dimension data-type:name="X"/><data-type:fcs-dimension data-type:name="Y"/>
      </transforms:fratio>
    </transforms:transformation>`;
  const range = (id: string, name: string, lo: number, hi: number, parent = "") =>
    `<gating:RectangleGate gating:id="${id}" gating:name="${name}"${parent ? ` gating:parent_id="${parent}"` : ""}>
      <gating:dimension gating:min="${lo}" gating:max="${hi}"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
    </gating:RectangleGate>`;
  const ellipse = (parent = "") =>
    `<gating:EllipsoidGate gating:id="E" gating:name="Odd ellipse"${parent ? ` gating:parent_id="${parent}"` : ""}>
      <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
      <gating:dimension><data-type:new-dimension data-type:transformation-ref="Rat"/></gating:dimension>
      <gating:mean><gating:coordinate data-type:value="0.5"/><gating:coordinate data-type:value="0.5"/></gating:mean>
      <gating:covarianceMatrix>
        <gating:row><gating:entry data-type:value="0.01"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="0"/><gating:entry data-type:value="0.01"/></gating:row>
      </gating:covarianceMatrix>
      <gating:distanceSquare data-type:value="1"/>
    </gating:EllipsoidGate>`;
  const xs = [0.5, 1.5, 2.5, 3.5];
  const names = (res: ReturnType<typeof importGatingML>) =>
    Object.values(res.populations).filter((p) => p.population_id !== res.root_population_id).map((p) => p.name).sort();

  it("leaves it out with everything beneath it, and names it (GateLab standard format)", () => {
    const pop = (id: string, name: string, refs: string[], parent = "") =>
      `<gating:BooleanGate gating:id="${id}"${parent ? ` gating:parent_id="${parent}"` : ""}>
        <data-type:custom_info><cytobank><name>${name}</name></cytobank></data-type:custom_info>
        <gating:and>${refs.map((r) => `<gating:gateReference gating:ref="${r}"/>`).join("")}</gating:and>
      </gating:BooleanGate>`;
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML ${NS}>
        <data-type:custom_info><gatelab_format>{"version":2,"logicle":"gating-ml","hierarchy":"parent_id"}</gatelab_format></data-type:custom_info>
        ${oddScale}
        ${range("A", "Wide", 0, 3)}
        ${range("B", "Low", 0, 1)}
        ${ellipse()}
        ${pop("P", "Wide", ["A", "A"])}
        ${pop("Q", "In the ellipse", ["E", "E"], "P")}
        ${pop("R", "Low in the ellipse", ["B", "B"], "Q")}
        ${pop("S", "Low", ["B", "B"], "P")}
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["X", "Y"]);
    expect(names(res)).toEqual(["Low", "Wide"]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/^"In the ellipse" uses the gate "Odd ellipse", which has the ratio dimension Rat, which GateLab cannot hold; it and anything below it were skipped\.$/);
    const low = Object.values(res.populations).find((p) => p.name === "Low")!;
    expect(membership(res, low.population_id, xs)).toEqual([1, 0, 0, 0]);
  });

  it("does not move what sits beneath the gate to the top level (parent_id on gates)", () => {
    // Standard Gating-ML as FlowJo and FlowKit write it: each gate is a population, placed by
    // its own parent_id. The ellipse's child used to land at the top level, measured against
    // every event.
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML ${NS}>
        ${oddScale}
        ${range("A", "Wide", 0, 3)}
        ${ellipse("A")}
        ${range("B", "Low", 0, 1, "E")}
        ${range("C", "Lower", 0, 2, "A")}
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["X", "Y"]);
    expect(names(res)).toEqual(["Lower", "Wide"]);
    expect(res.warnings).toEqual([expect.stringMatching(/^"Odd ellipse" has the ratio dimension Rat, which GateLab cannot hold; it and anything below it were skipped\.$/)]);
  });

  it("leaves it out in a Cytobank file, whose chains carry the gate", () => {
    const pop = (id: string, name: string, refs: string[]) =>
      `<gating:BooleanGate gating:id="${id}">
        <data-type:custom_info><cytobank><name>${name}</name></cytobank></data-type:custom_info>
        <gating:and>${(refs.length === 1 ? [refs[0], refs[0]] : refs).map((r) => `<gating:gateReference gating:ref="${r}"/>`).join("")}</gating:and>
      </gating:BooleanGate>`;
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML ${NS}>
        ${oddScale}
        ${range("A", "Wide", 0, 3)}
        ${range("B", "Low", 0, 1)}
        ${ellipse()}
        ${pop("P", "Wide", ["A"])}
        ${pop("Q", "In the ellipse", ["A", "E"])}
        ${pop("R", "Low in the ellipse", ["A", "E", "B"])}
        ${pop("S", "Low", ["A", "B"])}
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["X", "Y"]);
    expect(names(res)).toEqual(["Low", "Wide"]);
    expect(res.warnings).toHaveLength(2);
    const low = Object.values(res.populations).find((p) => p.name === "Low")!;
    expect(res.populations[low.parent_id!].name).toBe("Wide");
    expect(membership(res, low.population_id, xs)).toEqual([1, 0, 0, 0]);
  });
});

describe("an absent rectangle bound", () => {
  // Gating-ML leaves a bound out for "no bound". The importer held it as ±1e9, which is below
  // real raw values: the public S8 file reaches 2.15e9 on one channel, and an open range there
  // left those events out. A bound written as xs:double's INF is the same thing.
  const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
  const xs = [-3e38, -2.15e9, -5e8, 0, 5e8, 2.15e9, 3e38];
  const rangePop = (dim: string) => {
    const xml = `<?xml version="1.0"?><gating:Gating-ML ${NS}>
      <gating:RectangleGate gating:id="R" gating:name="Open"><gating:dimension ${dim}><data-type:fcs-dimension data-type:name="X"/></gating:dimension></gating:RectangleGate>
    </gating:Gating-ML>`;
    const res = importGatingML(xml, ["X"], {}, "flow");
    return membership(res, onlyPopulation(res).population_id, xs);
  };

  // The file names no writer, so its rectangle is read by Gating-ML 2.0's rule, min <= x < max
  // (models.ts, RectangleBounds): the value 0 lies on the upper bound, and is out.
  it("holds every value on the open side, however large", () => {
    expect(rangePop('gating:min="0"')).toEqual([0, 0, 0, 1, 1, 1, 1]);
    expect(rangePop('gating:max="0"')).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it("reads INF and -INF as no bound", () => {
    expect(rangePop('gating:min="-INF" gating:max="0"')).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(rangePop('gating:min="0" gating:max="INF"')).toEqual([0, 0, 0, 1, 1, 1, 1]);
  });
});

// Standard Gating-ML 2.0 as FlowKit and flowUtils/flowCore write it: every gate, geometric or
// Boolean, is a population placed by its own parent_id, and a Boolean gate's operands are gates
// whose membership includes their own parent chains. The importer read any file with a
// BooleanGate as Cytobank's flattened format, which ignored parent_id and every geometric
// population: a FlowKit file with Cells, CD4 and CD8 and an AND of the two came back as that AND
// alone, at the top level, holding 1,616 events where FlowKit counts 1,247 under Cells.
describe("a standard Gating-ML file with Boolean gates", () => {
  const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;
  const range = (id: string, ch: string, lo: number, hi: number, parent?: string) =>
    `<gating:RectangleGate gating:id="${id}"${parent ? ` gating:parent_id="${parent}"` : ""}>
      <gating:dimension gating:min="${lo}" gating:max="${hi}"><data-type:fcs-dimension data-type:name="${ch}"/></gating:dimension>
    </gating:RectangleGate>`;
  const bool = (id: string, op: "and" | "or" | "not", refs: (string | [string, true])[], parent?: string) =>
    `<gating:BooleanGate gating:id="${id}"${parent ? ` gating:parent_id="${parent}"` : ""}>
      <gating:${op}>${refs.map((r) => typeof r === "string"
        ? `<gating:gateReference gating:ref="${r}"/>`
        : `<gating:gateReference gating:ref="${r[0]}" gating:use-as-complement="true"/>`).join("")}</gating:${op}>
    </gating:BooleanGate>`;
  const doc = (...els: string[]) => `<?xml version="1.0"?><gating:Gating-ML ${NS}>${els.join("")}</gating:Gating-ML>`;
  // X decides Cells (X in [0, 10]); Y decides CD4 (Y in [0, 5]) and CD8 (Y in [3, 8]).
  const pts: [number, number][] = [[1, 1], [1, 4], [1, 7], [1, 9], [20, 4], [20, 1]];
  const mask = (res: ReturnType<typeof importGatingML>, name: string) => {
    const data = { n: pts.length, column: (ch: string) => (ch === "X" ? pts.map((p) => p[0]) : ch === "Y" ? pts.map((p) => p[1]) : undefined) };
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, data);
    const pop = Object.values(res.populations).find((p) => p.name === name);
    return pop ? Array.from(masks[pop.population_id]) : undefined;
  };
  const parentOf = (res: ReturnType<typeof importGatingML>, name: string) => {
    const pop = Object.values(res.populations).find((p) => p.name === name)!;
    return pop.parent_id === res.root_population_id ? null : res.populations[pop.parent_id!].name;
  };
  const tree = [range("Cells", "X", 0, 10), range("CD4", "Y", 0, 5, "Cells"), range("CD8", "Y", 3, 8, "Cells")];

  it("imports every gate as a population in its place, and an AND within its parent", () => {
    const res = importGatingML(doc(...tree, bool("CD4andCD8", "and", ["CD4", "CD8"], "Cells")), ["X", "Y"]);
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "CD4", "CD4andCD8", "CD8", "Cells"].sort());
    expect(parentOf(res, "CD4")).toBe("Cells");
    expect(parentOf(res, "CD4andCD8")).toBe("Cells");
    expect(mask(res, "CD4andCD8")).toEqual([0, 1, 0, 0, 0, 0]);
    expect(mask(res, "CD4")).toEqual([1, 1, 0, 0, 0, 0]);
    expect(res.warnings).toEqual([]);
  });

  it("leaves an OR out with what sits beneath it, by name, and keeps the rest", () => {
    const res = importGatingML(doc(...tree, bool("CD4orCD8", "or", ["CD4", "CD8"], "Cells"), range("Big", "X", 0.5, 10, "CD4orCD8"),
      bool("CD4andCD8", "and", ["CD4", "CD8"], "Cells")), ["X", "Y"]);
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "CD4", "CD4andCD8", "CD8", "Cells"].sort());
    expect(res.warnings).toEqual([expect.stringMatching(/^"CD4orCD8" combines its references with OR/)]);
  });

  it("reads NOT, exclusions and a Boolean operand, within the parent", () => {
    const res = importGatingML(doc(...tree, bool("notCD4", "not", ["CD4"], "Cells"),
      bool("CD8notCD4", "and", ["notCD4", "CD8"], "Cells"), bool("CD8butCD4", "and", ["CD8", ["CD4", true]], "Cells")), ["X", "Y"]);
    expect(mask(res, "notCD4")).toEqual([0, 0, 1, 1, 0, 0]);
    expect(mask(res, "CD8notCD4")).toEqual([0, 0, 1, 0, 0, 0]);
    expect(mask(res, "CD8butCD4")).toEqual([0, 0, 1, 0, 0, 0]);
    expect(parentOf(res, "CD8notCD4")).toBe("Cells");
  });

  it("leaves out, by name, a Boolean population GateLab cannot hold within one parent", () => {
    // At the top level, CD4's membership carries Cells, which an AND of gates at the top level
    // cannot say without it; and the NOT of an AND of two gates is an OR.
    const res = importGatingML(doc(...tree, bool("CD4atTop", "and", ["CD4", "CD4"]), range("Under", "X", 0, 5, "CD4atTop"),
      bool("both", "and", ["CD4", "CD8"], "Cells"), bool("notBoth", "not", ["both"], "Cells")), ["X", "Y"]);
    const names = Object.values(res.populations).map((p) => p.name);
    expect(names).not.toContain("CD4atTop");
    expect(names).not.toContain("Under");
    expect(names).not.toContain("notBoth");
    expect(mask(res, "both")).toEqual([0, 1, 0, 0, 0, 0]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^"CD4atTop" uses the gate "CD4", which sits beneath "Cells", not above "CD4atTop"/),
      expect.stringMatching(/^"notBoth" negates or combines gates in a way that is not one AND of gates/),
    ]);
  });

  it("still reads a Cytobank file's flattened chains when it carries Cytobank's custom_info", () => {
    const cb = (id: string, name: string, refs: string[]) =>
      `<gating:BooleanGate gating:id="${id}"><data-type:custom_info><cytobank><name>${name}</name></cytobank></data-type:custom_info>
        <gating:and>${refs.map((r) => `<gating:gateReference gating:ref="${r}"/>`).join("")}</gating:and></gating:BooleanGate>`;
    const res = importGatingML(doc(range("C", "X", 0, 10), range("F", "Y", 0, 5), cb("P", "Cells", ["C", "C"]), cb("Q", "CD4", ["C", "F"])), ["X", "Y"]);
    expect(Object.values(res.populations).map((p) => p.name).sort()).toEqual(["All Events", "CD4", "Cells"].sort());
    expect(parentOf(res, "CD4")).toBe("Cells");
  });
});

// An export exact in raw space can carry thousands of vertices in one polygon, three elements
// each. Every gate's marks were read off getElementsByTagName("*"), whose live collection jsdom
// indexes slowly, so such a file took 24 s to import in node (this suite, the headless harnesses)
// where its gates took a fraction of a second to evaluate.
describe("a polygon with thousands of vertices", () => {
  it("imports in about the time it takes to parse", () => {
    const m = 8000;
    const verts = Array.from({ length: m }, (_, k) => {
      const t = (2 * Math.PI * k) / m;
      return `<gating:vertex><gating:coordinate data-type:value="${50 + 40 * Math.cos(t)}"/><gating:coordinate data-type:value="${50 + 40 * Math.sin(t)}"/></gating:vertex>`;
    }).join("");
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <gating:PolygonGate gating:id="ring">
          <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
          <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
          ${verts}
        </gating:PolygonGate>
      </gating:Gating-ML>`;
    const t0 = performance.now();
    const res = importGatingML(xml, ["X", "Y"]);
    const ms = performance.now() - t0;
    expect(Object.values(res.gates)[0]).toMatchObject({ gate_type: "polygon" });
    expect((Object.values(res.gates)[0] as { vertices: unknown[] }).vertices).toHaveLength(m);
    expect(ms).toBeLessThan(3000);
  }, 120000);
});

// Gating-ML 2.0's fasinh is (asinh(x · sinh(M ln10) / T) + A ln10) / ((M + A) ln10), so its inverse
// is T / sinh(M ln10) · sinh(y (M + A) ln10 − A ln10). The raw fallback added A ln10 instead, and a
// FlowKit rectangle with A = 0.3 on the public DiVa file held 10,398 events against FlowKit's 27,398.
// fix/gatingml-transforms removed that fallback: every fasinh is held exactly, as GateLab's arcsinh
// with cofactor T / sinh(M ln10) through the affine map y (M + A) ln10 − A ln10, and the raw values
// its bounds stand for are checked here.
describe("a fasinh gate GateLab cannot hold as its own arcsinh", () => {
  const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"
    xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"`;
  const T = 262144;
  const M = 4.5;
  const fasinh = (x: number, A: number) =>
    (Math.asinh((x * Math.sinh(M * Math.LN10)) / T) + A * Math.LN10) / ((M + A) * Math.LN10);

  for (const A of [0.3, 1]) {
    it(`is held on raw values at the values the transform maps to its bounds (A = ${A})`, () => {
      const xml = `<?xml version="1.0"?><gating:Gating-ML ${NS}>
        <transforms:transformation transforms:id="Tr_A"><transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="${A}"/></transforms:transformation>
        <gating:RectangleGate gating:id="R_fasinh">
          <gating:dimension gating:min="0.5" gating:max="0.8" gating:transformation-ref="Tr_A"><data-type:fcs-dimension data-type:name="FITC-A"/></gating:dimension>
        </gating:RectangleGate></gating:Gating-ML>`;
      const res = importGatingML(xml, ["FITC-A"], {}, "flow");
      const g = Object.values(res.gates)[0] as Extract<Gate, { vertices: unknown }>;
      expect(res.n_gates_skipped).toBe(0);
      // fix/gatingml-transforms holds every fasinh exactly; a rectangle from another writer on a
      // fasinh other than GateLab's own asinh is held on raw values, as it was before, with each
      // edge the stored value from which on, or up to which, the transform puts a value inside.
      expect(g.space).toBe("raw");
      const xs = g.vertices.map((v) => v[0]);
      expect(fasinh(Math.min(...xs), A)).toBeCloseTo(0.5, 12);
      expect(fasinh(Math.max(...xs), A)).toBeCloseTo(0.8, 12);
    });
  }
});

// GateLab keeps one transform per channel on a gate. A polygon FlowKit writes with one channel on
// both axes under two logicle transforms (A = 0 on one, A = 1 on the other) was imported with the
// second on both, silently: 51,950 events on the public DiVa file where FlowKit counts none.
describe("a gate with one channel on both axes under two transforms", () => {
  const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"
    xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"`;
  const dim = (tr: string) =>
    `<gating:dimension gating:compensation-ref="uncompensated" gating:transformation-ref="${tr}"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>`;
  const file = (xTr: string, yTr: string) => `<?xml version="1.0"?><gating:Gating-ML ${NS}>
    <transforms:transformation transforms:id="a0"><transforms:logicle transforms:T="262144" transforms:W="0.5" transforms:M="4.5" transforms:A="0"/></transforms:transformation>
    <transforms:transformation transforms:id="a1"><transforms:logicle transforms:T="262144" transforms:W="0.5" transforms:M="4.5" transforms:A="1"/></transforms:transformation>
    <gating:PolygonGate gating:id="P_a0a1">${dim(xTr)}${dim(yTr)}
      ${[[0.3, 0.3], [0.9, 0.35], [0.85, 0.95], [0.35, 0.8]].map(([x, y]) =>
        `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`).join("")}
    </gating:PolygonGate>
    <gating:RectangleGate gating:id="Kept">
      <gating:dimension gating:min="0.2" gating:max="0.6" gating:transformation-ref="a0"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
    </gating:RectangleGate></gating:Gating-ML>`;

  it("is left out, by name, and the rest imported", () => {
    const res = importGatingML(file("a0", "a1"), ["PE-A"], {}, "flow");
    expect(populationNames(res)).toEqual(["Kept"]);
    expect(res.warnings).toEqual([expect.stringMatching(/^"P_a0a1" .*two different transforms.*; it and anything below it were skipped\.$/)]);
  });

  it("is imported when both axes share one transform", () => {
    const res = importGatingML(file("a1", "a1"), ["PE-A"], {}, "flow");
    expect(populationNames(res)).toEqual(["Kept", "P_a0a1"]);
    expect(res.warnings).toEqual([]);
  });
});
