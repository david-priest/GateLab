import { describe, expect, it } from "vitest";
import type { Gate, PopulationMap } from "./models";
import {
  parsePopulationEditTable,
  serializePopulationEditTemplate,
  type PopulationTableState,
} from "./populationTable";

function rectangle(gateId: string, name: string): Gate {
  return {
    gate_id: gateId,
    name,
    gate_type: "rectangle",
    x_channel: "X",
    y_channel: "Y",
    vertices: [[0, 0], [1, 1]],
    color: "#123456",
    label_offset: null,
  };
}

function state(): PopulationTableState {
  const gates: Record<string, Gate> = {
    g1: rectangle("g1", "CD3+"),
    g2: rectangle("g2", "Live"),
    q1: {
      gate_id: "q1",
      name: "Quadrants",
      gate_type: "quadrant",
      x_channel: "X",
      y_channel: "Y",
      center: [0, 0],
      color: "#654321",
      label_offset: null,
    },
  };
  const populations: PopulationMap = {
    root: {
      population_id: "root",
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: ["p1", "p2"],
      event_count: null,
      percent_of_parent: 100,
    },
    p1: {
      population_id: "p1",
      name: "Cells",
      gate_refs: [
        { gate_id: "g1", include: true },
        { gate_id: "g2", include: true },
      ],
      gate_logic: "and",
      parent_id: "root",
      children: [],
      event_count: null,
      percent_of_parent: null,
    },
    p2: {
      population_id: "p2",
      name: "Q2",
      gate_refs: [{ gate_id: "q1", include: true, quadrant: 2 }],
      gate_logic: "and",
      parent_id: "root",
      children: [],
      event_count: null,
      percent_of_parent: null,
    },
  };
  return {
    populations,
    gates,
    rootPopulationId: "root",
  };
}

describe("population edit CSV", () => {
  it("round-trips names, positive AND gate lists, and quadrant references", () => {
    const fixture = state();
    const csv = serializePopulationEditTemplate(fixture);
    expect(csv).toContain("population_id,current_population,new_population,gate_names");
    expect(csv).toContain('"CD3+, Live"');
    expect(csv).toContain("Quadrants [Q2]");

    const preview = parsePopulationEditTable(csv, fixture);
    expect(preview).toMatchObject({
      rowCount: 3,
      renameCount: 0,
      gateDefinitionCount: 0,
      unchangedCount: 3,
      omittedCount: 0,
      legacyRenameOnly: false,
    });
    expect(preview.updates.find(({ popId }) => popId === "p1")?.gateRefs).toEqual(
      fixture.populations.p1.gate_refs,
    );
  });

  it("previews a rename, replacement gate list, quadrant change, and explicit clear", () => {
    const fixture = state();
    const preview = parsePopulationEditTable(
      [
        "population_id,current_population,new_population,gate_names",
        "root,All Events,All Events,",
        'p1,Cells,T cells,"Live, CD3+"',
        "p2,Q2,Q2,",
      ].join("\n"),
      fixture,
    );

    expect(preview.renameCount).toBe(1);
    expect(preview.gateDefinitionCount).toBe(2);
    expect(preview.updates.find(({ popId }) => popId === "p1")).toMatchObject({
      name: "T cells",
      gateRefs: [
        { gate_id: "g2", include: true },
        { gate_id: "g1", include: true },
      ],
    });
    expect(preview.updates.find(({ popId }) => popId === "p2")?.gateRefs).toEqual([]);
  });

  it("uses escaped commas and gate ids to round-trip otherwise ambiguous gate names", () => {
    const fixture = state();
    fixture.gates.g1.name = "Marker, positive";
    fixture.gates.g3 = rectangle("g3", "Marker, positive");
    const csv = serializePopulationEditTemplate(fixture);
    expect(csv).toContain("Marker\\, positive {g1}");
    expect(parsePopulationEditTable(csv, fixture).gateDefinitionCount).toBe(0);

    expect(() => parsePopulationEditTable(
      [
        "population_id,current_population,new_population,gate_names",
        'p1,Cells,Cells,"Marker\\, positive"',
      ].join("\n"),
      fixture,
    )).toThrow(/ambiguous/);
  });

  it("rejects any invalid row before returning a partial update", () => {
    const fixture = state();
    expect(() => parsePopulationEditTable(
      [
        "population_id,current_population,new_population,gate_names",
        "p1,Cells,T cells,Live",
        "p2,Q2,Q2,Missing gate",
      ].join("\n"),
      fixture,
    )).toThrow(/Row 3: Unknown gate name "Missing gate"/);

    expect(() => parsePopulationEditTable(
      [
        "population_id,current_population,new_population,gate_names",
        "root,All Events,All Events,Live",
      ].join("\n"),
      fixture,
    )).toThrow(/root population cannot contain gate definitions/);

    expect(() => parsePopulationEditTable(
      [
        "population_id,current_population,new_population,gate_names",
        "p2,Q2,Q2,Quadrants",
      ].join("\n"),
      fixture,
    )).toThrow(/needs a suffix such as \[Q1\]/);
  });

  it("keeps legacy old_population,new_population rename files working", () => {
    const fixture = state();
    const preview = parsePopulationEditTable(
      "old_population,new_population\nCells,Live cells\nQ2,Q2\n",
      fixture,
    );
    expect(preview.legacyRenameOnly).toBe(true);
    expect(preview.renameCount).toBe(1);
    expect(preview.gateDefinitionCount).toBe(0);
    expect(preview.updates.find(({ popId }) => popId === "p1")?.gateRefs).toEqual(
      fixture.populations.p1.gate_refs,
    );
  });
});
