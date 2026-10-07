import { describe, expect, it } from "vitest";
import { chapterOf, needsOf, stepBody, stepTarget, stepTitle, TOUR_CHAPTERS, TOUR_STEPS, unmetNeeds } from "./tourScript";
import type { TourContext } from "./tourTypes";
import { hasUiTranslation } from "../ui/i18n";

/** An empty app, then the demo as the tutorial sees it: two files, All Events › Cells › Singlets. */
function emptyContext(): TourContext {
  return {
    host: "browser",
    activeTab: "gating",
    workspaceName: "",
    files: [],
    pooled: false,
    rootId: null,
    populations: {},
    gates: {},
    activePopulationId: null,
    selectedGateId: null,
    axes: { x: null, y: null, xScale: null, yScale: null, xLinearOffered: false, yLinearOffered: false, rangeKey: "[]" },
    displayMode: "pseudocolor",
    maxEvents: 50000,
    strategy: null,
    illustration: null,
    layout: { items: 0, sheets: 1, allEvents: false },
    proportions: { populations: 0 },
    metadataColumns: [],
    divisionProfiles: 0,
    assayLayer: "original",
    compensation: { pairSelected: false, view: "matrix", galleryLayer: "compensated", matrixKey: "[]" },
    scales: { adjusted: [], fitted: [], locked: false },
    signals: { layoutExports: 0, statsDownloads: 0, workspaceSaves: 0 },
  };
}
function demoContext(): TourContext {
  return {
    ...emptyContext(),
    workspaceName: "gatelab-demo.gatelab",
    files: [
      { id: "D1", name: "D1.fcs", checked: true, viewed: true },
      { id: "D2", name: "D2.fcs", checked: true, viewed: false },
    ],
    rootId: "root",
    populations: {
      root: { id: "root", name: "All Events", parentId: null, children: ["cells"], gateCount: 0, gateIds: [] },
      cells: { id: "cells", name: "Cells", parentId: "root", children: ["singlets", "debris"], gateCount: 1, gateIds: ["g1"] },
      singlets: { id: "singlets", name: "Singlets", parentId: "cells", children: ["bcells"], gateCount: 1, gateIds: ["g2"] },
      debris: { id: "debris", name: "Debris", parentId: "cells", children: [], gateCount: 1, gateIds: ["g-debris"] },
      bcells: { id: "bcells", name: "B cells", parentId: "singlets", children: [], gateCount: 1, gateIds: ["g-b-cells"] },
    },
    gates: {
      g1: { id: "g1", name: "Cells gate", type: "polygon", x: "FSC-A", y: "SSC-A", shape: "[[0,0],[1,1]]", onFlowJoGrid: true },
      g2: { id: "g2", name: "Singlets (FSC-A/H)", type: "polygon", x: "FSC-A", y: "FSC-H", shape: "[[2,2],[3,3]]", onFlowJoGrid: true },
    },
    activePopulationId: "root",
    axes: { x: "FSC-A", y: "SSC-A", xScale: "linear", yScale: "linear", xLinearOffered: true, yLinearOffered: true, rangeKey: "[null,null,null,null]" },
  };
}
/** The demo with both scatter axes switched to arcsinh. */
function arcsinhContext(): TourContext {
  const demo = demoContext();
  return { ...demo, axes: { ...demo.axes, xScale: "arcsinh", yScale: "arcsinh" } };
}
const step = (id: string) => {
  const found = TOUR_STEPS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

describe("the tutorial script", () => {
  it("has unique steps, every chapter named, and words for every step on an empty app and on the demo", () => {
    const ids = TOUR_STEPS.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const candidate of TOUR_STEPS) {
      expect(TOUR_CHAPTERS.some((chapter) => chapter.id === candidate.chapter)).toBe(true);
      expect(chapterOf(candidate).title.length).toBeGreaterThan(0);
      for (const ctx of [emptyContext(), demoContext()]) {
        expect(stepBody(candidate, ctx).length).toBeGreaterThan(10);
        stepTarget(candidate, ctx);
      }
    }
    // The first and last steps wait for Next; the ones between mostly watch the app.
    expect(step("welcome").done).toBeUndefined();
    expect(step("finish").done).toBeUndefined();
    // The last card invites bug reports and points at the header's issue link.
    expect(stepBody(step("finish"), demoContext())).toContain("Bug reports and suggestions are welcome");
    expect(stepTarget(step("finish"), demoContext())).toBe('[data-tour="issues-link"]');
    expect(TOUR_STEPS.filter((candidate) => candidate.done).length).toBeGreaterThan(20);
  });

  it("speaks Japanese when the interface does: every title, body and chapter, with the demo's names quoted its way and the labels it points at as shown", () => {
    const japanese = /[\u3040-\u30ff\u4e00-\u9fff]/;
    const contexts = [emptyContext(), demoContext(), arcsinhContext(), { ...demoContext(), scales: { adjusted: ["FSC-A", "SSC-A"], fitted: ["CD4"], locked: true } }];
    // A chapter is named as its tab is; the Plotting tab keeps its English name in Japanese.
    for (const chapter of TOUR_CHAPTERS) expect(hasUiTranslation("ja", chapter.title) || chapter.title === "Plotting", chapter.title).toBe(true);
    for (const step of TOUR_STEPS) {
      expect(hasUiTranslation("ja", step.title), step.title).toBe(true);
      if (typeof step.body === "string") expect(hasUiTranslation("ja", step.body), step.id).toBe(true);
      for (const ctx of contexts) {
        const ja = { ...ctx, language: "ja" as const };
        expect(stepTitle(step, ja), step.id).toMatch(japanese);
        const body = stepBody(step, ja);
        expect(body, step.id).toMatch(japanese);
        expect(body, step.id).not.toBe(stepBody(step, ctx));
        // Nothing left in English: a sentence of the source would carry its spaces between words.
        // A control is named as the interface shows it, quoted, and the demo's citation is its own.
        if (step.id !== "about-demo") expect(body.replace(/「[^」]*」/g, ""), `${step.id}: ${body}`).not.toMatch(/[a-z]{3,} [a-z]{3,} [a-z]{3,}/);
      }
    }
    const ja = { ...demoContext(), language: "ja" as const };
    expect(stepBody(step("view-file"), ja)).toContain("「D2.fcs」");
    expect(stepBody(step("move-population"), ja)).toContain("「B cells」を「Cells」の上に");
    expect(stepBody(step("scales-info"), { ...ja, scales: { adjusted: ["FSC-A", "SSC-A"], fitted: [], locked: true } })).toContain("FSC-A、SSC-Aが青い");
    expect(stepBody(step("scales-info"), { ...ja, scales: { adjusted: ["A", "B", "C", "D", "E"], fitted: [], locked: true } })).toContain("A、B、C、他2件が青い");
    // The step points at the label the Japanese interface shows, not the English one.
    expect(stepTarget(step("pool-files"), ja)).toEqual([{ selector: ".gl-pool-toolbar button", text: "選択したファイルをプール", exact: false }, ".gl-pool-toolbar"]);
    expect(stepTarget(step("strategy-full-path"), ja)).toEqual({ selector: "label.gl-check", text: "ルートからの全パス", exact: false });
    expect(stepTarget(step("layout-export"), ja)).toEqual([{ selector: "button", text: "PDF を書き出す", exact: true }, { selector: "button", text: "書き出し", exact: true }]);
    expect(stepTarget(step("layout-export"), demoContext())).toEqual([{ selector: "button", text: "Export PDF", exact: true }, { selector: "button", text: "Export", exact: true }]);
    // The data's own names are matched as they are.
    expect(stepTarget(step("view-file"), ja)).toEqual({ selector: '.gl-sample-list [role="option"]', text: "D2.fcs" });
    // English is untouched.
    expect(stepTitle(step("welcome"), demoContext())).toBe("A walk through GateLab");
    expect(stepTarget(step("pool-files"), demoContext())).toEqual([{ selector: ".gl-pool-toolbar button", text: "Pool selected", exact: false }, ".gl-pool-toolbar"]);
  });

  it("names the demo's own files, populations and gates", () => {
    const ctx = demoContext();
    expect(stepBody(step("view-file"), ctx)).toContain("“D2.fcs”");
    expect(stepTarget(step("view-file"), ctx)).toEqual({ selector: '.gl-sample-list [role="option"]', text: "D2.fcs" });
    expect(stepBody(step("click-population"), ctx)).toContain("“Cells”");
    expect(stepTarget(step("click-population"), ctx)).toEqual({ selector: ".pop-row-name", text: "Cells", exact: true });
    expect(stepBody(step("click-gate"), ctx)).toContain("“Singlets (FSC-A/H)”");
    expect(stepBody(step("select-gate"), ctx)).toContain("“Cells gate”");
    expect(stepBody(step("about-demo"), ctx)).toContain("Supplementary Figure 10A");
    expect(stepBody(step("about-demo"), ctx)).toContain("10.1038/s41467-024-50997-4");
    expect(stepBody(step("about-demo"), { ...ctx, workspaceName: "other.gatelab" })).toContain("goes on with the workspace you opened");
    expect(stepBody(step("gate-edges"), ctx)).toContain("FlowJo's 256-channel grid");
    expect(stepBody(step("gate-edges"), ctx)).toContain("Here the two coincide");
    expect(stepBody(step("gate-edges"), arcsinhContext())).toContain("the plot is on arcsinh");
    // The gate on the plot defines "Cells": the stepping step names it, and the tree step then names another row.
    expect(stepBody(step("gate-population"), ctx)).toContain("click “Cells”");
    expect(stepBody(step("gate-population"), ctx)).toContain("FlowJo's 256-channel grid");
    expect(stepTarget(step("gate-population"), ctx)).toEqual({ selector: ".pop-row-name", text: "Cells", exact: true });
    expect(stepBody(step("pan-stretch"), ctx)).toContain("the steps of the grid come into view");
    expect(stepBody(step("click-population"), { ...ctx, activePopulationId: "cells" })).toContain("Click “Singlets”");
    expect(stepBody(step("strategy-full-path"), ctx)).toContain("“B cells”");
    expect(stepBody(step("open-demo"), ctx)).toContain("gatelab-demo.gatelab");
    expect(stepBody(step("rename-population"), ctx)).toContain("“Cells”");
    // One level up: the deepest leaf onto its grandparent.
    expect(stepBody(step("move-population"), ctx)).toContain("drag “B cells” onto “Cells”");
    expect(stepBody(step("move-population"), ctx)).toContain("Option-drag copies it");
  });

  it("knows when the tree steps are done, against what it saw on entry", () => {
    const demo = demoContext();
    const rename = step("rename-population");
    const renameMemo = rename.enter!(demo);
    expect(rename.done!(demo, renameMemo)).toBe(false);
    expect(rename.done!({ ...demo, populations: { ...demo.populations, cells: { ...demo.populations.cells, name: "Live cells" } } }, renameMemo)).toBe(true);

    const move = step("move-population");
    const moveMemo = move.enter!(demo);
    expect(move.done!(demo, moveMemo)).toBe(false);
    const moved = { ...demo, populations: { ...demo.populations, bcells: { ...demo.populations.bcells, parentId: "cells" } } };
    expect(move.done!(moved, moveMemo)).toBe(true);

    const undo = step("undo-move");
    const undoMemo = undo.enter!(moved);
    expect(undo.done!(moved, undoMemo)).toBe(false);
    expect(undo.done!(demo, undoMemo)).toBe(true);
  });

  it("knows when each Gating step is done, against what it saw on entry", () => {
    const empty = emptyContext();
    const demo = demoContext();
    expect(step("open-demo").done!(empty, undefined)).toBe(false);
    expect(step("open-demo").done!(demo, undefined)).toBe(true);

    const view = step("view-file");
    const viewMemo = view.enter!(demo);
    expect(view.done!(demo, viewMemo)).toBe(false);
    const switched = { ...demo, files: demo.files.map((file) => ({ ...file, viewed: file.id === "D2" })) };
    expect(view.done!(switched, viewMemo)).toBe(true);

    // Then back to the first file, which the rest of the tutorial uses.
    const back = step("view-file-back");
    expect(stepBody(back, switched)).toContain("“D1.fcs”");
    expect(back.done!(switched, back.enter!(switched))).toBe(false);
    expect(back.done!(demo, back.enter!(switched))).toBe(true);
    expect(back.done!({ ...demo, files: [demo.files[0]] }, back.enter!(demo))).toBe(true);

    // The gate's own population, then any other row than the active one.
    const gatePop = step("gate-population");
    expect(gatePop.done!(demo, undefined)).toBe(false);
    expect(gatePop.done!({ ...demo, activePopulationId: "cells" }, undefined)).toBe(true);
    const clickPop = step("click-population");
    expect(clickPop.done!(demo, clickPop.enter!(demo))).toBe(false);
    expect(clickPop.done!({ ...demo, activePopulationId: "cells" }, clickPop.enter!(demo))).toBe(true);
    const onCells = { ...demo, activePopulationId: "cells" };
    expect(stepTarget(clickPop, onCells)).toEqual({ selector: ".pop-row-name", text: "Singlets", exact: true });
    expect(clickPop.done!({ ...demo, activePopulationId: "singlets" }, clickPop.enter!(onCells))).toBe(true);
    const listed = step("click-gate");
    expect(listed.done!({ ...demo, selectedGateId: "g1" }, listed.enter!(demo))).toBe(false);
    expect(listed.done!({ ...demo, selectedGateId: "g2" }, listed.enter!(demo))).toBe(true);

    // The plot's opening steps: select the gate, move a vertex and undo, move the data, go linear.
    expect(step("select-gate").done!(demo, undefined)).toBe(false);
    expect(step("select-gate").done!({ ...demo, selectedGateId: "g1" }, undefined)).toBe(true);
    const vertex = step("move-vertex");
    const moved = { ...demo, gates: { ...demo.gates, g1: { ...demo.gates.g1, shape: "[[0,0],[1,2]]" } } };
    expect(vertex.done!(demo, vertex.enter!(demo))).toBe(false);
    expect(vertex.done!(moved, vertex.enter!(demo))).toBe(true);
    const undoVertex = step("undo-vertex");
    expect(undoVertex.done!(demo, undoVertex.enter!(moved))).toBe(true);
    const pan = step("pan-stretch");
    expect(pan.done!(demo, pan.enter!(demo))).toBe(false);
    expect(pan.done!({ ...demo, axes: { ...demo.axes, rangeKey: "[[0,5],null,null,null]" } }, pan.enter!(demo))).toBe(true);
    // Scatter opens linear; the lesson switches both axes to arcsinh and then back.
    const arcsinh = step("arcsinh-scales");
    expect(arcsinh.done!(demo, undefined)).toBe(false);
    expect(arcsinh.done!({ ...demo, axes: { ...demo.axes, xScale: "arcsinh" } }, undefined)).toBe(false);
    expect(arcsinh.done!(arcsinhContext(), undefined)).toBe(true);
    const bowed = arcsinhContext();
    const linear = step("linear-scales");
    expect(linear.done!(bowed, undefined)).toBe(false);
    expect(linear.done!({ ...bowed, axes: { ...bowed.axes, xScale: "linear" } }, undefined)).toBe(false);
    expect(linear.done!(demo, undefined)).toBe(true);
    // Axes that offer no linear scale do not hold the tutorial up, in either direction.
    const fixed = { ...demo, axes: { ...demo.axes, xScale: "logicle", yScale: "logicle", xLinearOffered: false, yLinearOffered: false } };
    expect(arcsinh.done!(fixed, undefined)).toBe(true);
    expect(linear.done!(fixed, undefined)).toBe(true);
    expect(stepBody(arcsinh, fixed)).toContain("These axes offer none");
    expect(stepBody(arcsinh, demo)).toContain("set X and Y to Arcsinh");
    expect(stepBody(linear, bowed)).toContain("set X and Y back to Linear");

    const axis = step("change-axis");
    const axisMemo = axis.enter!(demo);
    expect(axis.done!(demo, axisMemo)).toBe(false);
    expect(axis.done!({ ...demo, axes: { ...demo.axes, x: "FSC-H" } }, axisMemo)).toBe(true);

    const draw = step("draw-rectangle");
    const drawMemo = draw.enter!(demo);
    expect(draw.done!(demo, drawMemo)).toBe(false);
    expect(draw.done!({ ...demo, gates: { ...demo.gates, g3: { id: "g3", name: "Tutorial", type: "rectangle", x: "FSC-A", y: "SSC-A", shape: "[[0,0],[9,9]]", onFlowJoGrid: false } } }, drawMemo)).toBe(true);

    expect(step("check-all-files").done!(demo, undefined)).toBe(true);
    expect(step("check-all-files").done!({ ...demo, files: demo.files.map((file, i) => ({ ...file, checked: i === 0 })) }, undefined)).toBe(false);
    expect(step("pool-files").done!({ ...demo, pooled: true }, undefined)).toBe(true);
    expect(step("display-contour").done!({ ...demo, displayMode: "contour" }, undefined)).toBe(true);
    expect(step("return-single").done!(demo, undefined)).toBe(true);
  });

  it("follows the tabs and what each holds", () => {
    const demo = demoContext();
    expect(step("tab-strategy").done!(demo, undefined)).toBe(false);
    expect(step("tab-strategy").done!({ ...demo, activeTab: "strategy" }, undefined)).toBe(true);
    expect(step("strategy-full-path").done!({ ...demo, strategy: { fullPath: true, back: false, mode: "single" } }, undefined)).toBe(true);
    expect(step("strategy-back").done!({ ...demo, strategy: { fullPath: true, back: true, mode: "single" } }, undefined)).toBe(true);
    expect(step("illustration-pool").done!({ ...demo, illustration: { composition: "pool", populations: 1 } }, undefined)).toBe(true);
    const toLayout = step("illustration-to-layout");
    expect(toLayout.done!({ ...demo, layout: { items: 1, sheets: 1, allEvents: false } }, toLayout.enter!(demo))).toBe(true);
    expect(step("layout-all-events").done!({ ...demo, layout: { items: 1, sheets: 1, allEvents: true } }, undefined)).toBe(true);
    const pick = step("plotting-pick");
    expect(pick.done!({ ...demo, proportions: { populations: 2 } }, pick.enter!({ ...demo, proportions: { populations: 2 } }))).toBe(false);
    expect(pick.done!({ ...demo, proportions: { populations: 3 } }, pick.enter!({ ...demo, proportions: { populations: 2 } }))).toBe(true);
    expect(pick.done!({ ...demo, proportions: { populations: 1 } }, pick.enter!({ ...demo, proportions: { populations: 2 } }))).toBe(true);
    const column = step("metadata-add-column");
    expect(column.done!({ ...demo, metadataColumns: ["donor"] }, column.enter!(demo))).toBe(true);
    expect(step("tab-gating-again").done!({ ...demo, activeTab: "gating" }, undefined)).toBe(true);
    const choose = step("illustration-populations");
    expect(choose.done!({ ...demo, illustration: { composition: "separate", populations: 2 } }, choose.enter!({ ...demo, illustration: { composition: "separate", populations: 1 } }))).toBe(true);
    const exported = step("layout-export");
    expect(exported.done!({ ...demo, signals: { ...demo.signals, layoutExports: 1 } }, exported.enter!(demo))).toBe(true);
    expect(exported.done!(demo, exported.enter!(demo))).toBe(false);
    const csv = step("statistics-download");
    expect(csv.done!({ ...demo, signals: { ...demo.signals, statsDownloads: 1 } }, csv.enter!(demo))).toBe(true);
    expect(step("compensation-pair").done!({ ...demo, compensation: { ...demo.compensation, pairSelected: true } }, undefined)).toBe(true);
    // The pair to click is off the diagonal, and the one with the most spill.
    expect(stepTarget(step("compensation-pair"), demo)).toEqual([{ selector: ".gl-comp-cell:not(.diagonal)", largest: true }, ".gl-center"]);
    expect(stepBody(step("compensation-pair"), demo)).toContain("off the diagonal");
    expect(step("compensation-global").done!(demo, undefined)).toBe(false);
    expect(step("compensation-global").done!({ ...demo, compensation: { ...demo.compensation, view: "global" } }, undefined)).toBe(true);
    // The inspector's own switch, not the header's Assay menu.
    const toggle = step("compensation-toggle");
    expect(stepTarget(toggle, demo)).toBe(".gl-comp-layer-toggle");
    expect(toggle.done!(demo, toggle.enter!(demo))).toBe(false);
    expect(toggle.done!({ ...demo, compensation: { ...demo.compensation, galleryLayer: "original" } }, toggle.enter!(demo))).toBe(true);
    expect(TOUR_STEPS.some((candidate) => candidate.id === "assay-switch")).toBe(false);
    // Scales comes before Compensation, as the tabs do.
    const at = (id: string) => TOUR_STEPS.findIndex((candidate) => candidate.id === id);
    expect(at("tab-scales")).toBeLessThan(at("tab-compensation"));
    const save = step("save-workspace");
    expect(save.done!({ ...demo, signals: { ...demo.signals, workspaceSaves: 1 } }, save.enter!(demo))).toBe(true);
    expect(TOUR_STEPS.some((candidate) => candidate.chapter === "division")).toBe(false);
  });

  it("says which Scales rows are blue and who adjusted them", () => {
    const demo = demoContext();
    const rows = step("scales-info");
    // Every case says what blue means, and that a range is a view.
    for (const scales of [
      { adjusted: [], fitted: [], locked: false },
      { adjusted: ["FSC-A", "SSC-A"], fitted: [], locked: false },
      { adjusted: ["FSC-A"], fitted: ["CD4", "CD8"], locked: false },
    ]) {
      const body = stepBody(rows, { ...demo, scales });
      expect(body).toContain("A row in blue holds a range that was adjusted after the file was read.");
      expect(body).toContain("A range changes the view only");
    }
    // Nothing adjusted: how to make a row blue. Under the scale lock the ranges are not one file's.
    const none = stepBody(rows, demo);
    expect(none).toContain("You have adjusted none on this file yet");
    const noneLocked = stepBody(rows, { ...demo, scales: { adjusted: [], fitted: [], locked: true } });
    expect(noneLocked).toContain("You have adjusted none yet");
    expect(noneLocked).not.toContain("on this file");
    expect(none).not.toContain("GateLab adjusted");
    // The user's own, from moving the data on the Gating tab.
    const two = stepBody(rows, { ...demo, scales: { adjusted: ["FSC-A", "SSC-A"], fitted: [], locked: false } });
    expect(two).toContain("FSC-A and SSC-A are blue: moving, stretching or rescaling a plot on the Gating tab writes its range here");
    expect(two).not.toContain("GateLab adjusted");
    expect(two).not.toContain("adjusted none");
    // One channel reads in the singular; ranges GateLab fitted itself are named apart.
    const mixed = stepBody(rows, { ...demo, scales: { adjusted: ["FSC-A"], fitted: ["CD4", "CD8"], locked: false } });
    expect(mixed).toContain("FSC-A is blue: moving, stretching or rescaling a plot");
    expect(mixed).toContain("GateLab adjusted CD4 and CD8 itself, to keep the gates in view the first time their plot was shown.");
    // A long list is cut to three names and a count.
    const many = stepBody(rows, { ...demo, scales: { adjusted: ["FSC-A", "FSC-H", "SSC-A", "SSC-H", "CD4"], fitted: ["CD8"], locked: false } });
    expect(many).toContain("FSC-A, FSC-H, SSC-A and 2 more are blue");
    expect(many).toContain("GateLab adjusted CD8 itself, to keep the gates in view the first time its plot was shown.");
    expect(stepTarget(rows, demo)).toEqual([".gl-scales-table", ".gl-tab-panel"]);
    expect(rows.done).toBeUndefined();

    // The tab's ranges are the viewed file's, or every file's under the lock.
    expect(stepBody(step("tab-scales"), demo)).toContain("for the file you are viewing");
    expect(stepBody(step("tab-scales"), { ...demo, scales: { ...demo.scales, locked: true } })).toContain("shared by every file while the scale lock is on");
  });

  it("knows where each step happens, so Next can take the app there", () => {
    // The tabs as the app names them; a step can only be sent to one of these.
    const tabs = ["gating", "strategy", "illustration", "layout", "proportions", "statistics", "metadata", "panel", "scales", "compensation"];
    for (const candidate of TOUR_STEPS) {
      const needs = needsOf(candidate);
      if (needs.tab) expect(tabs, `${candidate.id} is sent to ${needs.tab}`).toContain(needs.tab);
      // Only the two steps before the demo is open do without a workspace.
      expect(needs.workspace, candidate.id).toBe(candidate.id !== "welcome" && candidate.id !== "open-demo");
    }
    // A chapter's steps happen on its tab; the step that opens a tab is done from any tab.
    expect(needsOf(step("strategy-full-path")).tab).toBe("strategy");
    expect(needsOf(step("plotting-pick")).tab).toBe("proportions");
    expect(needsOf(step("rename-population")).tab).toBe("gating");
    expect(needsOf(step("draw-rectangle")).tab).toBe("gating");
    for (const id of ["tab-strategy", "tab-illustration", "tab-layout", "tab-plotting", "tab-statistics", "tab-metadata", "tab-panel", "tab-scales", "tab-compensation", "tab-gating-again"]) {
      expect(needsOf(step(id)).tab, id).toBeNull();
    }
    expect(needsOf(step("compensation-pair")).compensationView).toBe("matrix");
    expect(needsOf(step("compensation-toggle")).compensationView).toBe("global");
    expect(needsOf(step("compensation-toggle")).tab).toBe("compensation");

    const empty = emptyContext();
    const demo = demoContext();
    // Nothing open: the step after the demo is skipped needs a workspace, the first two do not.
    expect(unmetNeeds(step("welcome"), empty)).toBeNull();
    expect(unmetNeeds(step("open-demo"), empty)).toBeNull();
    expect(unmetNeeds(step("about-demo"), empty)).toEqual({ workspace: true });
    expect(unmetNeeds(step("about-demo"), demo)).toBeNull();
    // Skipped past "Open the Strategy tab" while still on Gating.
    expect(unmetNeeds(step("strategy-full-path"), demo)).toEqual({ tab: "strategy" });
    expect(unmetNeeds(step("strategy-full-path"), { ...demo, activeTab: "strategy" })).toBeNull();
    // The step that opens the tab needs nothing, from wherever it is entered.
    expect(unmetNeeds(step("tab-strategy"), { ...demo, activeTab: "scales" })).toBeNull();
    // The Compensation tab's own view, once on the tab and before.
    const onCompensation = { ...demo, activeTab: "compensation" };
    expect(unmetNeeds(step("compensation-toggle"), onCompensation)).toEqual({ compensationView: "global" });
    expect(unmetNeeds(step("compensation-toggle"), { ...onCompensation, compensation: { ...demo.compensation, view: "global" } })).toBeNull();
    expect(unmetNeeds(step("compensation-toggle"), demo)).toEqual({ tab: "compensation", compensationView: "global" });
    expect(unmetNeeds(step("compensation-pair"), { ...onCompensation, compensation: { ...demo.compensation, view: "global" } })).toEqual({ compensationView: "matrix" });
  });

  it("points the scale steps at the axis still to change, and the vertex step at the gate when none is selected", () => {
    const demo = demoContext();
    const bowed = arcsinhContext();
    const X = ['.gl-transforms select.gl-scatter-scale[aria-label^="X "]', ".gl-transforms"];
    const Y = ['.gl-transforms select.gl-scatter-scale[aria-label^="Y "]', ".gl-transforms"];
    const arcsinh = step("arcsinh-scales");
    expect(stepTarget(arcsinh, demo)).toEqual(X);
    // X done: the pointer moves on to Y.
    expect(stepTarget(arcsinh, { ...demo, axes: { ...demo.axes, xScale: "arcsinh" } })).toEqual(Y);
    expect(stepTarget(arcsinh, bowed)).toBe(".gl-transforms");
    const linear = step("linear-scales");
    expect(stepTarget(linear, bowed)).toEqual(X);
    expect(stepTarget(linear, { ...bowed, axes: { ...bowed.axes, xScale: "linear" } })).toEqual(Y);
    expect(stepTarget(linear, demo)).toBe(".gl-transforms");
    // An axis with no linear scale on offer is passed over.
    expect(stepTarget(linear, { ...bowed, axes: { ...bowed.axes, xLinearOffered: false } })).toEqual(Y);

    const vertex = step("move-vertex");
    expect(stepBody(vertex, demo)).toContain("Click the gate on the plot to show its round handles, then drag one a little way.");
    expect(stepBody(vertex, { ...demo, selectedGateId: "g1" })).toContain("Drag one of the gate's round handles a little way.");
    // The grey edge is redrawn on release, and only on a scale the gate was not drawn on.
    expect(stepBody(vertex, demo)).not.toContain("grey edge");
    expect(stepBody(vertex, bowed)).toContain("the grey edge is drawn again through the new vertex");
  });
});
