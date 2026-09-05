import { newGateRef, newPopulation, newRootPopulation } from "./models";
import { describe, expect, it } from "vitest";
import type { Gate, PopulationMap } from "./models";
import {  } from "./models";
import {
  gatingMergeSpaceConflict,
  mergeGatingStrategies,
  type GatingStrategyGraph,
} from "./gatingMerge";

function rectangle(gateId: string, name: string): Gate {
  return {
    gate_id: gateId,
    name,
    gate_type: "rectangle",
    x_channel: "FSC-A",
    y_channel: "SSC-A",
    vertices: [[0, 0], [1, 1]],
    color: "#377eb8",
    label_offset: null,
  };
}

function populations(
  rootId: string,
  branchId: string,
  branchName: string,
  gateId: string,
  child?: { id: string; name: string; gateId: string },
): PopulationMap {
  return {
    [rootId]: {
      population_id: rootId,
      name: "All Events",
      gate_refs: [],
      gate_logic: "and",
      parent_id: null,
      children: [branchId],
      event_count: 100,
      percent_of_parent: 100,
    },
    [branchId]: {
      population_id: branchId,
      name: branchName,
      gate_refs: [{ gate_id: gateId, include: true }],
      gate_logic: "and",
      parent_id: rootId,
      children: child ? [child.id] : [],
      event_count: 50,
      percent_of_parent: 50,
      colorSlot: 0,
    },
    ...(child ? {
      [child.id]: {
        population_id: child.id,
        name: child.name,
        gate_refs: [{ gate_id: child.gateId, include: true }],
        gate_logic: "and" as const,
        parent_id: branchId,
        children: [],
        event_count: 25,
        percent_of_parent: 50,
        colorSlot: 1,
      },
    } : {}),
  };
}

describe("mergeGatingStrategies", () => {
  it("preserves the current graph and attaches a collision-safe imported hierarchy beneath its root", () => {
    const current: GatingStrategyGraph = {
      gates: { shared: rectangle("shared", "Existing gate") },
      gate_order: ["shared"],
      populations: populations("root", "shared-pop", "Existing population", "shared"),
      root_population_id: "root",
    };
    const imported: GatingStrategyGraph = {
      gates: {
        shared: rectangle("shared", "Imported gate"),
        imported_child_gate: rectangle("imported_child_gate", "Imported child gate"),
      },
      gate_order: ["shared", "imported_child_gate"],
      populations: populations(
        "import-root",
        "shared-pop",
        "Imported population",
        "shared",
        { id: "imported-child", name: "Imported child", gateId: "imported_child_gate" },
      ),
      root_population_id: "import-root",
    };

    const merged = mergeGatingStrategies(current, imported);
    const importedGateId = merged.gateIdMap.shared;
    const importedPopId = merged.populationIdMap["shared-pop"];
    const importedChildId = merged.populationIdMap["imported-child"];

    expect(merged.root_population_id).toBe("root");
    expect(merged.gates.shared.name).toBe("Existing gate");
    expect(importedGateId).toBe("shared-imported");
    expect(merged.gates[importedGateId].name).toBe("Imported gate");
    expect(merged.gate_order).toEqual(["shared", "shared-imported", "imported_child_gate"]);
    expect(importedPopId).toBe("shared-pop-imported");
    expect(merged.populations[importedPopId].parent_id).toBe("root");
    expect(merged.populations[importedChildId].parent_id).toBe(importedPopId);
    expect(merged.populations[importedPopId].gate_refs[0].gate_id).toBe(importedGateId);
    expect(merged.populations[importedChildId].gate_refs[0].gate_id).toBe("imported_child_gate");
    expect(merged.populations[current.root_population_id].children).toEqual(expect.arrayContaining(["shared-pop", importedPopId]));
    expect(merged.populations[importedPopId].event_count).toBeNull();
    expect(merged.populations[importedPopId].colorSlot).toBeUndefined();
    expect(imported.populations["shared-pop"].population_id).toBe("shared-pop");
    expect(imported.gates.shared.gate_id).toBe("shared");
  });

  it("rejects a dangling imported gate reference instead of changing population meaning", () => {
    const current: GatingStrategyGraph = {
      gates: {},
      gate_order: [],
      populations: populations("root", "existing", "Existing", "missing-current"),
      root_population_id: "root",
    };
    const imported: GatingStrategyGraph = {
      gates: {},
      gate_order: [],
      populations: populations("import-root", "imported", "Imported", "missing-imported"),
      root_population_id: "import-root",
    };
    expect(() => mergeGatingStrategies(current, imported)).toThrow(/dangling gate reference/i);
  });
});

describe("gatingMergeSpaceConflict", () => {
  const common = {
    hasExistingStrategy: true,
    isFlow: true,
    currentCompensation: false,
    importedCompensationTarget: false,
    currentCytofCofactor: 5,
    importedCytofCofactor: 5,
  };

  it("blocks compensation and CyTOF-cofactor changes when existing gates would be reinterpreted", () => {
    expect(gatingMergeSpaceConflict({ ...common, importedCompensationTarget: true })).toMatch(/compensation/i);
    expect(gatingMergeSpaceConflict({
      ...common,
      isFlow: false,
      importedCompensationTarget: null,
      importedCytofCofactor: 7.5,
    })).toMatch(/cofactor/i);
  });

  it("allows compatible spaces and empty current strategies", () => {
    expect(gatingMergeSpaceConflict(common)).toBeNull();
    expect(gatingMergeSpaceConflict({
      ...common,
      hasExistingStrategy: false,
      importedCompensationTarget: true,
    })).toBeNull();
  });
});

describe("mergeGatingStrategies attach point", () => {
  it("attaches the imported root's children under the named population instead of the root", () => {
    const current: GatingStrategyGraph = {
      gates: { g1: rectangle("g1", "Cells") },
      gate_order: ["g1"],
      populations: populations("root", "cells", "Cells", "g1"),
      root_population_id: "root",
    };
    const imported: GatingStrategyGraph = {
      gates: { b1: rectangle("b1", "89+") },
      gate_order: ["b1"],
      populations: populations("iroot", "s1", "01", "b1"),
      root_population_id: "iroot",
    };
    const merged = mergeGatingStrategies(current, imported, "cells");
    const s1 = Object.values(merged.populations).find((p) => p.name === "01")!;
    expect(s1.parent_id).toBe("cells");
    expect(merged.populations.cells.children).toContain(s1.population_id);
    expect(merged.populations.root.children).toEqual(["cells"]);
    expect(() => mergeGatingStrategies(current, imported, "gone")).toThrow("no longer exists");
  });
});

describe("mergeGatingStrategies with references to gates the workspace already holds", () => {
  it("keeps a reference to an existing gate rather than treating it as dangling", () => {
    const gate = (id: string, name: string) => ({
      gate_id: id, name, gate_type: "rectangle" as const, x_channel: "FSC-A", y_channel: "SSC-A",
      vertices: [[0, 0], [1, 1]] as [number, number][], color: "#000", label_offset: null,
    });
    const currentRoot = newRootPopulation();
    const current = {
      gates: { shared: gate("shared", "Shared") },
      gate_order: ["shared"],
      populations: { [currentRoot.population_id]: currentRoot },
      root_population_id: currentRoot.population_id,
    };
    const importedRoot = newRootPopulation();
    const pop = newPopulation("Uses shared and new", [newGateRef("shared", true), newGateRef("fresh", true)], importedRoot.population_id);
    importedRoot.children.push(pop.population_id);
    const imported = {
      gates: { fresh: gate("fresh", "Fresh") },
      gate_order: ["fresh"],
      populations: { [importedRoot.population_id]: importedRoot, [pop.population_id]: pop },
      root_population_id: importedRoot.population_id,
    };
    const merged = mergeGatingStrategies(current, imported);
    expect(Object.keys(merged.gates).sort()).toEqual(["fresh", "shared"]);
    const target = Object.values(merged.populations).find((p) => p.name === "Uses shared and new")!;
    expect(target.gate_refs.map((r) => r.gate_id).sort()).toEqual(["fresh", "shared"]);
    // A reference to a gate in neither graph is still refused.
    const dangling = { ...imported, populations: { ...imported.populations, [pop.population_id]: { ...pop, gate_refs: [newGateRef("nowhere", true)] } } };
    expect(() => mergeGatingStrategies(current, dangling)).toThrow(/dangling/);
  });
});
