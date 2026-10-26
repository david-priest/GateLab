import { describe, it, expect } from "vitest";
import { packWorkspaceReference, readWorkspaceBytes, type WorkspaceFile } from "../engine/workspace";
import { isEmptyMiflowcytAuthor, MIFLOWCYT_AUTHOR_FIELD, readMiflowcytAuthor, splitKeywords } from "./miflowcytAuthor";

function workspace(extra: Record<string, unknown>): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [{ sampleId: "s1", fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false }],
    activeSample: 0,
    gating: {
      gates: {},
      gate_order: [],
      populations: { root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: 100 } },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FSC-A", yChannel: "SSC-A", mode: "contour", maxEvents: 20000, contourThreshold: 10, densityColorPower: 1.8, fontSizes: { tick: 12, axis: 14, title: 11, gate: 12 } },
    ...extra,
  } as unknown as WorkspaceFile;
}

describe("readMiflowcytAuthor", () => {
  it("survives a workspace save and read unchanged", () => {
    const author = { purpose: "Synthetic check", keywords: ["B cells", "flow cytometry"], organism: "Homo sapiens" };
    const bytes = packWorkspaceReference(workspace({ [MIFLOWCYT_AUTHOR_FIELD]: author }));
    const { ws } = readWorkspaceBytes(bytes);
    expect(readMiflowcytAuthor(ws)).toEqual(author);
  });

  it("reads a workspace without the field as empty, and drops values of the wrong type", () => {
    expect(readMiflowcytAuthor(workspace({}))).toEqual({});
    expect(readMiflowcytAuthor({ [MIFLOWCYT_AUTHOR_FIELD]: { purpose: 3, contact: "D1 lab", keywords: "a,b", other: "x" } })).toEqual({ contact: "D1 lab" });
    expect(readMiflowcytAuthor({ [MIFLOWCYT_AUTHOR_FIELD]: ["purpose"] })).toEqual({});
    expect(readMiflowcytAuthor(null)).toEqual({});
  });

  it("tells an empty set of items from one with content", () => {
    expect(isEmptyMiflowcytAuthor({})).toBe(true);
    expect(isEmptyMiflowcytAuthor({ purpose: "  ", keywords: [] })).toBe(true);
    expect(isEmptyMiflowcytAuthor({ contact: "D1 lab" })).toBe(false);
  });

  it("splits keywords on commas and drops empty ones", () => {
    expect(splitKeywords("B cells, , flow cytometry,")).toEqual(["B cells", "flow cytometry"]);
  });
});
