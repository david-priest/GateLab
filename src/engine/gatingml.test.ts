// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { importGatingML, normalizeChannel } from "./gatingml";

const GATELABR = "vendor/GateLabR/Gates from GateLabR.xml";
const CYTOBANK = "vendor/GateLabR/Gates from Cytobank.xml";

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
