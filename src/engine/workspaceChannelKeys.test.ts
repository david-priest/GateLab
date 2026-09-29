// Channel keys a saved workspace names, against the files as GateLab reads them now.
// Synthetic channels and names throughout.

import { describe, expect, it } from "vitest";
import { resolveChannels } from "./channels";
import type { FcsFile } from "./fcs";
import type { Gate } from "./models";
import type { WorkspaceFile } from "./workspace";
import {
  formerChannelKeys,
  gateChannelKeys,
  gatesMissingChannels,
  planChannelKeyRemap,
  remapGateChannels,
  savedFileTreeGates,
} from "./workspaceChannelKeys";

function file(channels: [string, string | null][]): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 0,
    channels: channels.map(([name, marker], index) => ({ index, name, marker, bits: 32, range: 1024 })),
    keywords: {},
    columns: channels.map(() => new Float32Array(0)),
    spillover: null,
    instrument: "flow",
  };
}

const rect = (id: string, x: string, y: string, extra: Partial<Gate> = {}): Gate => ({
  gate_id: id, name: id, gate_type: "rectangle", x_channel: x, y_channel: y,
  vertices: [[0, 0], [1, 1]], color: "#000000", label_offset: null, ...extra,
} as Gate);

describe("planChannelKeyRemap", () => {
  // A MACSQuant FCS 3.1 export as read since 2026-09: a conventional file, keyed by $PnS.
  const macs = resolveChannels(file([
    ["FSC-A", null], ["FL2-A", "V2-A"], ["Time", "HDR-T"], ["HDR-CE", "HDR-CE"],
  ]));

  it("restates the spectral-rule key and the $PnN key as the same parameter's key now", () => {
    expect(macs.map((c) => c.key)).toEqual(["FSC-A", "V2-A", "HDR-T", "HDR-CE"]);
    const remap = planChannelKeyRemap(["V2-A (FL2-A)", "Time", "FSC-A", "FL9-A"], [macs]);
    expect([...remap]).toEqual([["V2-A (FL2-A)", "V2-A"], ["Time", "HDR-T"]]);
  });

  it("restates a label read as Latin-1 before TEXT was read as UTF-8", () => {
    const utf = resolveChannels(file([["FL1-A", "IFN-γ"], ["FL3-A", "TCRγδ"]]));
    const remap = planChannelKeyRemap(["IFN-Î³", "TCRÎ³Î´"], [utf]);
    expect([...remap]).toEqual([["IFN-Î³", "IFN-γ"], ["TCRÎ³Î´", "TCRγδ"]]);
  });

  it("leaves a key some file still has, and one the files do not agree on", () => {
    const d1 = resolveChannels(file([["FL1-A", "M1"], ["FL2-A", null]]));
    const d2 = resolveChannels(file([["FL1-A", "M2"], ["FL2-A", null]]));
    const d3 = resolveChannels(file([["FL1-A", null], ["FL2-A", null]]));
    // "FL1-A" is still a key in D3, so no file loses it.
    expect(planChannelKeyRemap(["FL1-A"], [d1, d3]).size).toBe(0);
    // In D1 and D2 the same $PnN is now named differently: which name is not for GateLab to pick.
    expect(planChannelKeyRemap(["FL1-A"], [d1, d2]).size).toBe(0);
    expect([...planChannelKeyRemap(["FL1-A"], [d1])]).toEqual([["FL1-A", "M1"]]);
  });

  it("leaves a key that names two channels of one file", () => {
    const channels = [
      { key: "M1", pnn: "FL1-A", marker: "M1" },
      { key: "FL1-A [2]", pnn: "FL1-A", marker: null },
    ];
    expect(formerChannelKeys(channels[0])).toContain("FL1-A");
    expect(planChannelKeyRemap(["FL1-A"], [channels]).size).toBe(0);
  });
});

describe("remapGateChannels", () => {
  it("restates both axes and the transforms recorded under them, and leaves other gates alone", () => {
    const logicle = { kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 } as const;
    const gates = {
      g1: rect("g1", "V2-A (FL2-A)", "Time", { space: "display", transforms: { "V2-A (FL2-A)": logicle } }),
      g2: rect("g2", "FSC-A", "SSC-A"),
    };
    const out = remapGateChannels(gates, new Map([["V2-A (FL2-A)", "V2-A"], ["Time", "HDR-T"]]));
    expect(out.g1.x_channel).toBe("V2-A");
    expect(out.g1.y_channel).toBe("HDR-T");
    expect(out.g1.transforms).toEqual({ "V2-A": logicle });
    expect(out.g2).toBe(gates.g2);
    expect(gates.g1.x_channel).toBe("V2-A (FL2-A)");
    expect(remapGateChannels(gates, new Map([["FL9-A", "M9"]]))).toBe(gates);
    expect([...gateChannelKeys(gates)].sort()).toEqual(["FSC-A", "SSC-A", "Time", "V2-A (FL2-A)"]);
  });
});

describe("savedFileTreeGates", () => {
  const root = { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: 100 };
  const gating = {
    gates: { g1: rect("g1", "FSC-A", "SSC-A") },
    gate_order: ["g1"],
    populations: { root },
    root_population_id: "root",
    active_population_id: "root",
    selected_gate_id: null,
    hierarchies: [{ id: "main", name: "Main" }, { id: "panel-b", name: "Panel B" }],
    active_hierarchy_id: "main",
    stored_hierarchies: [{
      id: "panel-b", name: "Panel B", gates: { g9: rect("g9", "FL9-A", "SSC-A") }, gate_order: ["g9"],
      populations: { root }, root_population_id: "root", active_population_id: "root",
    }],
    perFileHierarchies: true,
  } as unknown as WorkspaceFile["gating"];

  it("gives each file the gates of the tree it is gated under, so a second panel's gates warn no one", () => {
    expect(Object.keys(savedFileTreeGates(gating, undefined))).toEqual(["g1"]);
    expect(Object.keys(savedFileTreeGates(gating, "panel-b"))).toEqual(["g9"]);
    expect(Object.keys(savedFileTreeGates({ ...gating, perFileHierarchies: false }, "panel-b"))).toEqual(["g1"]);
    expect(gatesMissingChannels(savedFileTreeGates(gating, undefined), new Set(["FSC-A", "SSC-A"]))).toEqual([]);
    expect(gatesMissingChannels(savedFileTreeGates(gating, "panel-b"), new Set(["FSC-A", "SSC-A"]))).toEqual(["g9"]);
  });
});
