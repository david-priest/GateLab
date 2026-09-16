import { describe, expect, it } from "vitest";
import {
  cloneLayoutWorkspace,
  createDefaultLayoutWorkspace,
  normalizeLayoutWorkspace,
  nextLayoutItemPosition,
} from "./layout";

describe("layout workspace persistence", () => {
  it("creates a renameable blank sheet with a stable active identity", () => {
    const workspace = createDefaultLayoutWorkspace();
    expect(workspace.version).toBe(1);
    expect(workspace.sheets).toHaveLength(1);
    expect(workspace.activeSheetId).toBe(workspace.sheets[0].id);
    expect(workspace.sheets[0].items).toEqual([]);
  });

  it("normalizes persisted recipes while retaining sample and population bindings", () => {
    const normalized = normalizeLayoutWorkspace({
      version: 1,
      activeSheetId: "sheet-b",
      sheets: [
        {
          id: "sheet-a",
          name: "Overview",
          width: 900,
          height: 700,
          items: [],
        },
        {
          id: "sheet-b",
          name: "B cells",
          width: 1200,
          height: 800,
          items: [{
            id: "plot-1",
            x: 32,
            y: 40,
            width: 280,
            height: 300,
            z: 2,
            recipe: {
              kind: "biplot",
              sampleId: "sample-stable-id",
              populationId: "pop-stable-id",
              xChannel: "FSC-A",
              yChannel: "SSC-A",
              displayMode: "contour",
            },
          }],
        },
      ],
    });
    expect(normalized.activeSheetId).toBe("sheet-b");
    expect(normalized.sheets[1].items[0].recipe).toEqual({
      kind: "biplot",
      sampleId: "sample-stable-id",
      populationId: "pop-stable-id",
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      displayMode: "contour",
      title: undefined,
    });
  });

  it("recovers malformed presentation state without touching scientific workspace data", () => {
    const normalized = normalizeLayoutWorkspace({ version: 99, sheets: "broken" });
    expect(normalized.version).toBe(1);
    expect(normalized.sheets).toHaveLength(1);
    expect(normalized.sheets[0].items).toEqual([]);
  });

  it("clones recipes deeply and places new items without overlap in the initial row", () => {
    const workspace = createDefaultLayoutWorkspace();
    const first = nextLayoutItemPosition(workspace.sheets[0]);
    workspace.sheets[0].items.push({
      id: "one",
      ...first,
      recipe: {
        kind: "histogram",
        sampleId: "sample",
        populationId: "pop",
        xChannel: "CD3",
        yChannel: null,
        displayMode: "pseudocolor",
      },
    });
    const second = nextLayoutItemPosition(workspace.sheets[0]);
    expect(second.x).toBeGreaterThan(first.x);

    const cloned = cloneLayoutWorkspace(workspace);
    const clonedRecipe = cloned.sheets[0].items[0].recipe;
    if (clonedRecipe.kind !== "histogram") throw new Error("Expected histogram recipe");
    clonedRecipe.xChannel = "CD19";
    expect(workspace.sheets[0].items[0].recipe).toMatchObject({ xChannel: "CD3" });
  });
});
