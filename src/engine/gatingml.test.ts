// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { importGatingML, normalizeChannel } from "./gatingml";
import { applyGatingStrategy } from "./populations";

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

  it("inverts logicle vertices from flowCore [0,M] scale, not flowutils [0,1]", () => {
    // GateLabR exports logicle vertices in [0, M] (T→M=4.5). A vertex at 4.5 must
    // invert to ~T (846653), not blow up to ~1e23 (which happens if treated as [0,1]).
    const T = 846653.2;
    const xml = `<?xml version="1.0"?>
      <gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
        xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
        xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
        <transforms:transformation transforms:id="Tr_L">
          <transforms:logicle transforms:T="${T}" transforms:W="1.5" transforms:M="4.5" transforms:A="0"/>
        </transforms:transformation>
        <gating:RectangleGate gating:id="g1">
          <gating:dimension gating:min="0" gating:max="4.5" gating:transformation-ref="Tr_L"><data-type:fcs-dimension data-type:name="CD19"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="4.5" gating:transformation-ref="Tr_L"><data-type:fcs-dimension data-type:name="CD14"/></gating:dimension>
        </gating:RectangleGate>
      </gating:Gating-ML>`;
    const res = importGatingML(xml, ["CD19", "CD14"]);
    const g = Object.values(res.gates)[0];
    const verts = "vertices" in g ? g.vertices : [];
    const maxX = Math.max(...verts.map((v) => v[0]));
    // vertex at display 4.5 → raw ≈ T, comfortably within a real channel range
    expect(maxX).toBeGreaterThan(T * 0.5);
    expect(maxX).toBeLessThan(T * 3);
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

    expect(() => importGatingML(xml, ["X", "Y"])).toThrow(/EllipsoidGate ellipse-1 is not supported/);
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
    const pop = onlyPopulation(res);
    expect(pop.name).toBe("Outside");
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
    const pop = onlyPopulation(res);
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

  it("rejects OR logic and names the affected population", () => {
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
      </gating:Gating-ML>`;

    expect(() => importGatingML(xml, ["X"])).toThrow(/Population "Low or high" uses OR logic/);
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
