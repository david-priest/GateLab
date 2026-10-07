// tourScript.ts — the walkthrough: one chapter per tab, each step telling the user what to do and
// knowing from the context when it is done. The words are built from the workspace in front of
// the user (the demo's own files, populations and gates), never from names written here, so the
// tutorial also runs on another workspace.

import { translateUi, type TranslationValues } from "../ui/i18n";
import type { TourChapter, TourContext, TourGate, TourNeeds, TourPopulation, TourStep, TourTarget, TourTargetSpec } from "./tourTypes";

export const DEMO_WORKSPACE_FILE = "gatelab-demo.gatelab";
/** Where a copy of GateLab keeps its demo workspace, relative to the page. */
export const DEMO_WORKSPACE_PATH = `demo/${DEMO_WORKSPACE_FILE}`;

/**
 * Where the demo workspace's gating strategy and records come from. The tutorial says so when
 * the demo opens and the Tutorial menu keeps it, since a demo made from published work names it.
 */
export const DEMO_WORKSPACE_CITATION = {
  authors: "Priest DG, Ebihara T, Tulyeu J, Søndergaard JN, Sakakibara S, Sugihara F, et al.",
  title: "Atypical and non-classical CD45RBlo memory B cells are the majority of circulating SARS-CoV-2 specific B cells following mRNA vaccination or COVID-19.",
  journal: "Nature Communications 15, 6811 (2024).",
  doi: "10.1038/s41467-024-50997-4",
  url: "https://doi.org/10.1038/s41467-024-50997-4",
  figure: "Supplementary Figure 10A",
  figureLegend: "Gating strategy for FACS sorting B cells for in vitro assay.",
  short: "Gating strategy of Priest et al., Nat Commun 15:6811 (2024), Supplementary Figure 10A.",
} as const;

export const TOUR_CHAPTERS: readonly TourChapter[] = [
  { id: "welcome", title: "Welcome" },
  { id: "gating", title: "Gating" },
  { id: "tree", title: "The tree" },
  { id: "gates", title: "Gates" },
  { id: "strategy", title: "Strategy" },
  { id: "illustration", title: "Illustration" },
  { id: "layout", title: "Layout" },
  { id: "plotting", title: "Plotting" },
  { id: "statistics", title: "Statistics" },
  { id: "metadata", title: "Metadata" },
  { id: "panel", title: "Panel" },
  { id: "scales", title: "Scales" },
  { id: "compensation", title: "Compensation" },
  { id: "finish", title: "Saving" },
];

// ── What the words are built from ───────────────────────────────────────────────────────────────

const loaded = (ctx: TourContext) => ctx.files.length > 0 && Object.keys(ctx.populations).length > 1;

// ── Where each step happens ─────────────────────────────────────────────────────────────────────

/** The tab each chapter happens on; null where a chapter belongs to no tab. */
const CHAPTER_TAB: Readonly<Record<string, string | null>> = {
  welcome: null,
  gating: "gating",
  tree: "gating",
  gates: "gating",
  strategy: "strategy",
  illustration: "illustration",
  layout: "layout",
  plotting: "proportions",
  statistics: "statistics",
  metadata: "metadata",
  panel: "panel",
  scales: "scales",
  compensation: "compensation",
  finish: null,
};
/** The steps before a workspace is open. */
const BEFORE_WORKSPACE: ReadonlySet<string> = new Set(["welcome", "open-demo"]);
/** A step whose task is to open a tab is done from wherever the user is. */
const ANY_TAB: TourNeeds = { tab: null };

/** What a step needs of the app: its chapter's tab and an open workspace, unless the step says otherwise. */
export function needsOf(step: TourStep): TourNeeds {
  return { tab: CHAPTER_TAB[step.chapter] ?? null, workspace: !BEFORE_WORKSPACE.has(step.id), ...step.needs };
}

/** The part of a step's needs the app does not meet now, or null when it meets them all. */
export function unmetNeeds(step: TourStep, ctx: TourContext): TourNeeds | null {
  const needs = needsOf(step);
  const unmet: TourNeeds = {};
  if (needs.workspace && !loaded(ctx)) unmet.workspace = true;
  if (needs.tab && ctx.activeTab !== needs.tab) unmet.tab = needs.tab;
  if (needs.compensationView && ctx.compensation.view !== needs.compensationView) unmet.compensationView = needs.compensationView;
  return Object.keys(unmet).length ? unmet : null;
}

/** The root's children in tree order, then theirs: the populations as the tree lists them. */
function treeOrder(ctx: TourContext): TourPopulation[] {
  const out: TourPopulation[] = [];
  const visit = (id: string) => {
    const pop = ctx.populations[id];
    if (!pop) return;
    if (id !== ctx.rootId) out.push(pop);
    for (const child of pop.children) visit(child);
  };
  if (ctx.rootId) visit(ctx.rootId);
  return out;
}

/** The first population under the root: the first gate of the strategy. */
const firstPopulation = (ctx: TourContext): TourPopulation | null => treeOrder(ctx)[0] ?? null;

function depthOf(ctx: TourContext, pop: TourPopulation): number {
  let depth = 0;
  for (let cur: TourPopulation | undefined = pop; cur?.parentId; cur = ctx.populations[cur.parentId]) depth++;
  return depth;
}

/** A population at the end of a path: the deepest one, the first of them. */
function leafPopulation(ctx: TourContext): TourPopulation | null {
  let best: TourPopulation | null = null;
  let depth = -1;
  for (const pop of treeOrder(ctx)) {
    if (pop.children.length) continue;
    const d = depthOf(ctx, pop);
    if (d > depth) { best = pop; depth = d; }
  }
  return best;
}

/** The first population in tree order defined by this gate. */
const gatePopulation = (ctx: TourContext, gate: TourGate | null): TourPopulation | null =>
  gate ? treeOrder(ctx).find((pop) => pop.gateIds.includes(gate.id)) ?? null : null;

/** The first population in tree order that is not the active one: a row to click. */
const otherPopulation = (ctx: TourContext): TourPopulation | null =>
  treeOrder(ctx).find((pop) => pop.id !== ctx.activePopulationId) ?? null;

/**
 * A leaf to move and where to put it, one level up: its grandparent, else a sibling of its parent,
 * else the first population that is neither it nor its parent.
 */
function moveCandidates(ctx: TourContext): { leaf: TourPopulation; target: TourPopulation } | null {
  const leaf = leafPopulation(ctx);
  if (!leaf) return null;
  const parent = leaf.parentId ? ctx.populations[leaf.parentId] : null;
  const grandparent = parent?.parentId ? ctx.populations[parent.parentId] : null;
  const uncle = grandparent?.children.map((id) => ctx.populations[id]).find((pop) => pop && pop.id !== parent?.id) ?? null;
  const target =
    (grandparent && grandparent.id !== ctx.rootId ? grandparent : null) ??
    uncle ??
    treeOrder(ctx).find((pop) => pop.id !== leaf.id && pop.id !== leaf.parentId) ??
    null;
  return target ? { leaf, target } : null;
}

/** Every population's parent, as one string: equal while the tree keeps its shape. */
const treeShape = (ctx: TourContext) =>
  Object.values(ctx.populations).map((pop) => `${pop.id}>${pop.parentId ?? ""}`).sort().join("|");

/** Another gate than the one on the plot or selected, to click in the list: the second, else the first. */
const listGate = (ctx: TourContext) => {
  const all = Object.values(ctx.gates);
  return all.find((gate) => gate.id !== ctx.selectedGateId && gate.id !== plottedGate(ctx)?.id) ?? all[1] ?? all[0] ?? null;
};

/** The first gate drawn on the plot's two channels, in either orientation. */
const plottedGate = (ctx: TourContext) =>
  Object.values(ctx.gates).find(
    (gate) => (gate.x === ctx.axes.x && gate.y === ctx.axes.y) || (gate.x === ctx.axes.y && gate.y === ctx.axes.x),
  ) ?? null;

/** Every gate's geometry, as one string: it changes when any vertex or side moves. */
const gateShapes = (ctx: TourContext) => Object.values(ctx.gates).map((gate) => `${gate.id}:${gate.shape}`).join("|");

/** Whether both axes are linear wherever a linear scale is offered. */
const axesLinear = (ctx: TourContext) =>
  (!ctx.axes.xLinearOffered || ctx.axes.xScale === "linear") && (!ctx.axes.yLinearOffered || ctx.axes.yScale === "linear");
/** Whether both axes are arcsinh wherever a linear scale is offered: the other choice those axes have. */
const axesArcsinh = (ctx: TourContext) =>
  (!ctx.axes.xLinearOffered || ctx.axes.xScale === "arcsinh") && (!ctx.axes.yLinearOffered || ctx.axes.yScale === "arcsinh");
/** The Transforms select of the first axis not yet on this scale, X before Y; the Transforms block once both are. */
const scaleSelect = (ctx: TourContext, scale: "linear" | "arcsinh"): TourTargetSpec => {
  const axis = ctx.axes.xLinearOffered && ctx.axes.xScale !== scale ? "X" : ctx.axes.yLinearOffered && ctx.axes.yScale !== scale ? "Y" : null;
  return axis ? [`.gl-transforms select.gl-scatter-scale[aria-label^="${axis} "]`, ".gl-transforms"] : ".gl-transforms";
};

const isDemo = (ctx: TourContext) => ctx.workspaceName === DEMO_WORKSPACE_FILE;

/**
 * The tutorial speaks the interface's language: a step's words are source strings looked up as
 * the rest of the interface's are, with the names they mention filled in. English when the
 * context names no language, which is what the tests and the smoke driver read.
 */
const tr = (ctx: TourContext) => (source: string, values?: TranslationValues) => translateUi(ctx.language ?? "en", source, values);

/** A name quoted as the language quotes. */
const quote = (ctx: TourContext, text: string) => (ctx.language === "ja" ? `「${text}」` : `“${text}”`);

/** The entity's name, quoted; the fallback, translated, when there is none. */
const name = (ctx: TourContext, entity: { name: string } | null | undefined, fallback: string) =>
  entity ? quote(ctx, entity.name) : tr(ctx)(fallback);

/** A target by the text the interface shows for it, in its language. */
const labelled = (ctx: TourContext, selector: string, text: string, exact = false): TourTarget =>
  ({ selector, text: tr(ctx)(text), exact });

const tab = (id: string): TourTargetSpec => `[data-tour="tab-${id}"]`;

const otherFile = (ctx: TourContext) => ctx.files.find((file) => !file.viewed) ?? null;

const popRow = (pop: TourPopulation | null | undefined): TourTargetSpec =>
  pop ? { selector: ".pop-row-name", text: pop.name, exact: true } : ".pop-row-name";

/** "A", "A and B", "A, B and C"; past four names, the first three and how many more. */
function listOf(ctx: TourContext, names: readonly string[]): string {
  const t = tr(ctx);
  const shown = names.length > 4 ? [...names.slice(0, 3), t("{count} more", { count: names.length - 3 })] : [...names];
  if (ctx.language === "ja") return shown.join("、");
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────────

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    chapter: "welcome",
    title: "A walk through GateLab",
    body:
      "This tutorial goes through every tab with the demo workspace: a published B cell sort strategy with its FCS records and compensation. Each step says what to do and moves on when you have done it; Skip moves on without. End tutorial keeps your place, and the Tutorial menu brings you back to it.",
  },
  {
    id: "open-demo",
    chapter: "welcome",
    title: "Open the demo workspace",
    body: (ctx) =>
      loaded(ctx)
        ? tr(ctx)("A workspace is open ({name}); the tutorial goes on with it.", { name: ctx.workspaceName || ctx.files.map((file) => file.name).join(", ") })
        : tr(ctx)("Open the Workspace menu and choose “Open the demo workspace”. The demo is the FCS records, their compensation and the gating tree, bundled as one .gatelab file."),
    target: ['[role="menuitem"].gl-open-demo', ".gl-tour-workspace-menu > button"],
    pointer: "click",
    done: loaded,
  },

  {
    id: "about-demo",
    chapter: "welcome",
    title: "The demo workspace",
    body: (ctx) => {
      const c = DEMO_WORKSPACE_CITATION;
      const reference = `${c.authors} ${c.title} ${c.journal} doi:${c.doi}`;
      return isDemo(ctx)
        ? tr(ctx)("The demo is the gating strategy of {figure} of {reference} (“{legend}”), on its presort record and companion records. The Tutorial menu keeps this reference under “About the demo workspace”.", { figure: c.figure, reference, legend: c.figureLegend })
        : tr(ctx)("The tutorial goes on with the workspace you opened. It was written for the demo: the gating strategy of {figure} of {reference}", { figure: c.figure, reference });
    },
  },

  // ── Gating ──
  {
    id: "select-gate",
    chapter: "gating",
    title: "The plot and its gate",
    body: (ctx) => {
      const gate = plottedGate(ctx);
      return gate
        ? tr(ctx)("The plot shows the active population on two channels, with the gates drawn on them. Click the gate {name} on the plot, or its card in the gate list on the right, to select it: its round handles appear.", { name: quote(ctx, gate.name) })
        : tr(ctx)("The plot shows the active population on two channels, with the gates drawn on them. Click the gate on the plot, or its card in the gate list on the right, to select it: its round handles appear.");
    },
    target: (ctx) => {
      const gate = plottedGate(ctx);
      return [".gl-plot-area svg .saved-gate .gate-hit", ".gl-plot-area svg .saved-gate", gate ? { selector: ".gate-card", text: gate.name } : ".gate-card"];
    },
    pointer: "click",
    done: (ctx) => ctx.selectedGateId !== null,
  },
  {
    id: "arcsinh-scales",
    chapter: "gating",
    title: "The same gate on arcsinh",
    body: (ctx) =>
      tr(ctx)(ctx.axes.xLinearOffered || ctx.axes.yLinearOffered
        ? "Scatter opens on linear axes, and this gate was drawn on them. Under Transforms, set X and Y to Arcsinh: the gate is redrawn on the new scale, and a thin grey line appears beside its red sides."
        : "Where an axis offers a choice of scale (scatter does), Transforms sets it, and a gate shown on another scale than it was drawn on bows along its sides. These axes offer none, so the tutorial goes on."),
    // The axis still to change: X first, then Y once X is arcsinh.
    target: (ctx) => scaleSelect(ctx, "arcsinh"),
    pointer: "click",
    done: axesArcsinh,
  },
  {
    id: "gate-edges",
    chapter: "gating",
    title: "Two lines for one gate",
    body: (ctx) => {
      const gate = (ctx.selectedGateId ? ctx.gates[ctx.selectedGateId] : null) ?? plottedGate(ctx);
      const bowed = !axesLinear(ctx);
      const t = tr(ctx);
      return [
        t("The red polygon joins the gate's vertices with straight sides, to work with. The thin grey line is the gate's own edge on these axes."),
        t(bowed
          ? "They differ because the gate was drawn on linear axes and the plot is on arcsinh: a side that is straight on one scale bows on another."
          : "Here the two coincide: these are the axes the gate was drawn on. Shown on another scale, a straight side bows."),
        t("GateLab keeps a gate in the space it was drawn in, so changing a scale redraws the gate and never moves an event in or out of it."),
        gate?.onFlowJoGrid
          ? t("The F on this gate's badge says it came from FlowJo and is tested on FlowJo's 256-channel grid, as FlowJo tests it, so GateLab takes the events FlowJo takes.")
          : "",
      ].filter(Boolean).join(sentenceGap(ctx));
    },
    target: [".gl-plot-area svg .saved-gate", ".gl-plot-area svg .plot-bg"],
    pointer: "none",
  },
  {
    id: "move-vertex",
    chapter: "gating",
    title: "Move a vertex",
    body: (ctx) => {
      const t = tr(ctx);
      return [
        t(ctx.selectedGateId ? "Drag one of the gate's round handles a little way." : "Click the gate on the plot to show its round handles, then drag one a little way."),
        t(axesLinear(ctx)
          ? "The red side follows the handle; when you let go, the count on the label changes as events cross."
          : "The red side follows the handle; when you let go, the grey edge is drawn again through the new vertex and the count on the label changes as events cross."),
      ].join(sentenceGap(ctx));
    },
    target: [".gl-plot-area svg circle.vh", ".gl-plot-area svg .saved-gate"],
    pointer: "click",
    enter: (ctx) => gateShapes(ctx),
    done: (ctx, memo) => gateShapes(ctx) !== memo,
  },
  {
    id: "gate-population",
    chapter: "gating",
    title: "The events the gate takes",
    body: (ctx) => {
      const gate = plottedGate(ctx);
      const pop = gatePopulation(ctx, gate);
      const t = tr(ctx);
      return [
        t("In the tree on the right, click {name}: the plot keeps these axes and shows only the events inside the gate, with the gate drawn around them.", { name: name(ctx, pop, "the population this gate defines") }),
        t(gate?.onFlowJoGrid
          ? "Along the grey edge the events end in steps: a gate from FlowJo is tested on FlowJo's 256-channel grid, so events are taken a channel at a time, and a few lie across the line."
          : "The events end at the grey edge: that line, not the red one, is where the gate falls."),
      ].join(sentenceGap(ctx));
    },
    target: (ctx) => popRow(gatePopulation(ctx, plottedGate(ctx))),
    pointer: "click",
    done: (ctx) => {
      const pop = gatePopulation(ctx, plottedGate(ctx));
      return !!pop && ctx.activePopulationId === pop.id;
    },
  },
  {
    id: "pan-stretch",
    chapter: "gating",
    title: "Move and stretch the data",
    body: (ctx) => {
      const t = tr(ctx);
      return [
        t("With the arrow tool, drag the plot's background to move the data. Hold Shift while dragging to stretch it: the axes' lower ends stay where they are and the point you hold follows the pointer."),
        plottedGate(ctx)?.onFlowJoGrid ? t("Stretch the view along the gate's edge and the steps of the grid come into view.") : "",
        t("“Fit data + gates” above the plot brings the view back."),
      ].filter(Boolean).join(sentenceGap(ctx));
    },
    target: ".gl-plot-area svg .plot-bg",
    pointer: "move",
    enter: (ctx) => ctx.axes.rangeKey,
    done: (ctx, memo) => ctx.axes.rangeKey !== memo,
  },
  {
    id: "undo-vertex",
    chapter: "gating",
    title: "Undo",
    body: "Press Undo (⌘Z, or the arrow above the plot) to put the vertex back. Every change to the gates and the tree can be undone, and redone.",
    target: '.gl-history-tools button[data-tour="undo"]',
    pointer: "click",
    enter: (ctx) => gateShapes(ctx),
    done: (ctx, memo) => gateShapes(ctx) !== memo,
  },
  {
    id: "linear-scales",
    chapter: "gating",
    title: "The gate on its own axes",
    body: (ctx) =>
      tr(ctx)(ctx.axes.xLinearOffered || ctx.axes.yLinearOffered
        ? "Under Transforms, set X and Y back to Linear. The grey edge straightens onto the red sides: these are the axes the gate was drawn on, and scatter opens on them. Nothing was regated; only the picture changed. That is how GateLab holds every gate: in the space it was drawn in, shown through whichever scale you choose."
        : "Where an axis offers a linear scale (scatter does), Transforms sets it, and a gate drawn on linear axes then shows its sides straight. These axes offer none, so the tutorial goes on."),
    // The axis still to change: X first, then Y once X is linear.
    target: (ctx) => scaleSelect(ctx, "linear"),
    pointer: "click",
    done: axesLinear,
  },
  {
    id: "view-file",
    chapter: "gating",
    title: "The file list",
    body: (ctx) =>
      tr(ctx)("The left panel lists the files. The blue one is viewed on the plot; the checkboxes choose files for pooling and for the other tabs. Click {name} to view it.", { name: name(ctx, otherFile(ctx), "another file") }),
    target: (ctx) => {
      const other = otherFile(ctx);
      return other ? { selector: '.gl-sample-list [role="option"]', text: other.name } : '.gl-sample-list [role="option"]';
    },
    pointer: "click",
    enter: (ctx) => ctx.files.find((file) => file.viewed)?.id ?? null,
    done: (ctx, memo) => {
      const viewed = ctx.files.find((file) => file.viewed)?.id ?? null;
      return viewed !== null && viewed !== memo;
    },
  },
  {
    id: "view-file-back",
    chapter: "gating",
    title: "Back to the first file",
    body: (ctx) =>
      tr(ctx)("Each file is gated by the same tree, so its counts and plots are its own. Click {name} to view it again; the tutorial goes on with it.", { name: name(ctx, otherFile(ctx), "the first file") }),
    target: (ctx) => {
      const other = otherFile(ctx);
      return other ? { selector: '.gl-sample-list [role="option"]', text: other.name } : '.gl-sample-list [role="option"]';
    },
    pointer: "click",
    enter: (ctx) => ctx.files.find((file) => file.viewed)?.id ?? null,
    done: (ctx, memo) => {
      const viewed = ctx.files.find((file) => file.viewed)?.id ?? null;
      // One file alone has nothing to go back to.
      return ctx.files.length < 2 || (viewed !== null && viewed !== memo);
    },
  },
  {
    id: "click-population",
    chapter: "gating",
    title: "The population tree",
    body: (ctx) =>
      tr(ctx)("The tree holds the populations, each defined by its gates, and the active one is highlighted. Clicking another makes it active: the plot shows its events, on the axes of the gates drawn on it. Click {name}.", { name: name(ctx, otherPopulation(ctx), "another population") }),
    target: (ctx) => popRow(otherPopulation(ctx)),
    pointer: "click",
    enter: (ctx) => otherPopulation(ctx)?.id ?? null,
    done: (ctx, memo) => typeof memo === "string" && ctx.activePopulationId === memo,
  },

  // ── The tree ──
  {
    id: "rename-population",
    chapter: "tree",
    title: "Rename a population",
    body: (ctx) =>
      tr(ctx)("Double-click the name of {name}, type a new name and press Enter. The name is the tree's; its gates and counts stay as they are.", { name: name(ctx, firstPopulation(ctx), "a population") }),
    target: (ctx) => popRow(firstPopulation(ctx)),
    pointer: "click",
    enter: (ctx) => {
      const pop = firstPopulation(ctx);
      return pop ? { id: pop.id, name: pop.name } : null;
    },
    done: (ctx, memo) => {
      const was = memo as { id: string; name: string } | null;
      return !!was && !!ctx.populations[was.id] && ctx.populations[was.id].name !== was.name;
    },
  },
  {
    id: "move-population",
    chapter: "tree",
    title: "Move a population",
    body: (ctx) => {
      const move = moveCandidates(ctx);
      return move
        ? tr(ctx)("Rows can be dragged. Dropped onto another population, a population becomes its child and its gates apply to that parent's events: drag {leaf} onto {target}; the counts follow. Dropped between rows, it only changes its place among its siblings; Option-drag copies it.", { leaf: name(ctx, move.leaf, "a leaf"), target: name(ctx, move.target, "another population") })
        : tr(ctx)("Rows can be dragged. Dropped onto another population, a population becomes its child and its gates apply to that parent's events; dropped between rows, it only changes its place among its siblings. Nothing here to move, so Skip.");
    },
    target: (ctx) => popRow(moveCandidates(ctx)?.leaf),
    pointer: "click",
    enter: (ctx) => {
      const move = moveCandidates(ctx);
      return move ? { leafId: move.leaf.id, targetId: move.target.id } : null;
    },
    done: (ctx, memo) => {
      const was = memo as { leafId: string; targetId: string } | null;
      return !!was && ctx.populations[was.leafId]?.parentId === was.targetId;
    },
  },
  {
    id: "undo-move",
    chapter: "tree",
    title: "Undo",
    body: "Every change to the gates and the tree can be undone: press Undo (⌘Z, or the arrow above the plot) to put the population back where it was.",
    target: '.gl-history-tools button[data-tour="undo"]',
    pointer: "click",
    // The tree's shape as entered; the undo is seen as any population changing parent.
    enter: (ctx) => treeShape(ctx),
    done: (ctx, memo) => typeof memo === "string" && treeShape(ctx) !== memo,
  },

  // ── Gates ──
  {
    id: "click-gate",
    chapter: "gates",
    title: "The gate list",
    body: (ctx) =>
      tr(ctx)("Above the tree, the gates: each card names its gate, its channels, its badge and its count in the active population. Click {name} to select it; the plot switches to that gate's channels and shows it.", { name: name(ctx, listGate(ctx), "another gate") }),
    target: (ctx) => {
      const gate = listGate(ctx);
      return gate ? { selector: ".gate-card", text: gate.name } : ".gate-card";
    },
    pointer: "click",
    enter: (ctx) => listGate(ctx)?.id ?? null,
    done: (ctx, memo) => typeof memo === "string" && ctx.selectedGateId === memo,
  },
  {
    id: "change-axis",
    chapter: "gates",
    title: "The axes",
    body:
      "The plot's axes are chosen on the plot itself. Click the x-axis label under the plot and pick another channel from the list.",
    target: ".cytof-xlabel",
    pointer: "click",
    enter: (ctx) => ctx.axes.x,
    done: (ctx, memo) => ctx.axes.x !== null && ctx.axes.x !== memo,
  },
  {
    id: "draw-rectangle",
    chapter: "gates",
    title: "Draw a gate",
    body:
      "Choose the Rectangle tool, then drag a box on the plot. In the dialog that opens, name the gate, keep “Create population” ticked and press Create: the gate joins the list and its population the tree, under the active population.",
    target: '.gl-draw-tools button[data-tool="draw-rect"]',
    pointer: "drag",
    pointerTarget: ".gl-plot-area svg .plot-bg",
    enter: (ctx) => Object.keys(ctx.gates).length,
    done: (ctx, memo) => Object.keys(ctx.gates).length > (memo as number),
  },
  {
    id: "check-all-files",
    chapter: "gates",
    title: "Check every file",
    body: "Several files can be drawn as one cloud. First tick every file: press All above the file list, or tick the boxes one by one.",
    target: (ctx) => [labelled(ctx, ".gl-left button", "All", true), ".gl-sample-list"],
    pointer: "click",
    done: (ctx) => ctx.files.length > 0 && ctx.files.every((file) => file.checked),
  },
  {
    id: "pool-files",
    chapter: "gates",
    title: "Pool the files",
    body:
      "Press “Pool selected files”: the plot pools the checked files' events, and the counts on the gates and in the tree pool with it. A file whose channels differ from the viewed file's is named above the plot and left out.",
    target: (ctx) => [labelled(ctx, ".gl-pool-toolbar button", "Pool selected"), ".gl-pool-toolbar"],
    pointer: "click",
    done: (ctx) => ctx.pooled,
  },
  {
    id: "display-contour",
    chapter: "gates",
    title: "How the events are drawn",
    body:
      "The Display popover above the plot sets the plot mode, how many events are drawn (All events for every one), the point size and the fonts. Open it and switch the mode to Contour.",
    target: "details.gl-display-popover > summary",
    pointer: "click",
    done: (ctx) => ctx.displayMode === "contour",
  },
  {
    id: "return-single",
    chapter: "gates",
    title: "Back to one file",
    body: "Press “Return to single file” to view one file again; the checked files stay checked for the other tabs.",
    target: (ctx) => [labelled(ctx, ".gl-pool-toolbar button", "Return to single"), ".gl-pool-toolbar"],
    pointer: "click",
    done: (ctx) => !ctx.pooled,
  },

  // ── Strategy ──
  {
    id: "tab-strategy",
    chapter: "strategy",
    title: "The Strategy tab",
    body: "Open the Strategy tab. It traces the active population's gating path, one plot per gate, each showing the events before that gate with its percentage.",
    target: tab("strategy"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "strategy",
  },
  {
    id: "strategy-full-path",
    chapter: "strategy",
    title: "The whole path",
    body: (ctx) =>
      tr(ctx)("Choose {name} in the Population list, then tick “Full path from root” to see every gate from All Events down to it.", { name: name(ctx, leafPopulation(ctx), "a population at the end of a path") }),
    target: (ctx) => labelled(ctx, "label.gl-check", "Full path from root"),
    pointer: "click",
    done: (ctx) => !!ctx.strategy?.fullPath,
  },
  {
    id: "strategy-back",
    chapter: "strategy",
    title: "Back-gating",
    body: "Tick “Back-gated” to overlay the final population's events on every step in orange, which shows where they sat before each gate. Pool checked files draws the steps from the pooled files; the PNG, SVG and PDF buttons export the grid.",
    target: (ctx) => labelled(ctx, "label.gl-check", "Back-gated"),
    pointer: "click",
    done: (ctx) => !!ctx.strategy?.back,
  },

  // ── Illustration ──
  {
    id: "tab-illustration",
    chapter: "illustration",
    title: "The Illustration tab",
    body: "Open the Illustration tab. It lays out a figure of panels: populations by files by channel pairs, with the gates drawn and the percentages labelled.",
    target: tab("illustration"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "illustration",
  },
  {
    id: "illustration-populations",
    chapter: "illustration",
    title: "Choose what to show",
    body: "Under Data, the Populations list sets which populations the figure shows. Tick or untick one in the list (None clears them, Leaves takes every population at the end of a path); the grid follows.",
    target: (ctx) => [labelled(ctx, "button", "Leaves", true), labelled(ctx, "button", "Use checked populations")],
    pointer: "click",
    enter: (ctx) => ctx.illustration?.populations ?? 0,
    done: (ctx, memo) => (ctx.illustration?.populations ?? 0) !== (memo as number),
  },
  {
    id: "illustration-pool",
    chapter: "illustration",
    title: "Pooled panels",
    body: "In the Style section, set Composition to Pool: each panel draws the checked files' events together, and a gate is drawn where every file holds it alike, with the pooled percentage.",
    target: (ctx) => labelled(ctx, "label", "Composition"),
    pointer: "click",
    done: (ctx) => ctx.illustration?.composition === "pool",
  },
  {
    id: "illustration-to-layout",
    chapter: "illustration",
    title: "Send a panel to Layout",
    body: "Right-click a panel and choose “Add this panel to the Layout tab”: the Layout tab gets a plot it keeps drawing from the live gates. The same menu sends a row, a column or the selected panels, and opens a panel on the Gating tab.",
    target: (ctx) => [
      labelled(ctx, '[role="menuitem"]', "Add this panel to the Layout tab"),
      labelled(ctx, '[role="menuitem"]', "Add the figure to the Layout tab"),
      "td[data-figure-panel]",
    ],
    pointer: "click",
    enter: (ctx) => ctx.layout.items,
    done: (ctx, memo) => ctx.layout.items > (memo as number),
  },

  // ── Layout ──
  {
    id: "tab-layout",
    chapter: "layout",
    title: "The Layout tab",
    body: "Open the Layout tab: a page of plots, text and figures, arranged by hand and exported as PDF, SVG or PNG.",
    target: tab("layout"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "layout",
  },
  {
    id: "layout-add-biplot",
    chapter: "layout",
    title: "Add a plot",
    body: "Press “+ Biplot” to add a plot of the active population on the Gating tab's axes. The inspector on the left sets its file, population, channels and whether it pools files.",
    target: (ctx) => labelled(ctx, "button", "+ Biplot", true),
    pointer: "click",
    enter: (ctx) => ctx.layout.items,
    done: (ctx, memo) => ctx.layout.items > (memo as number),
  },
  {
    id: "layout-all-events",
    chapter: "layout",
    title: "The sheet's style",
    body: "Open Style and tick “All events”: every plot on the sheet draws every event rather than a sample of them. Iterate draws the sheet once per file, population or metadata value.",
    target: (ctx) => [labelled(ctx, "label.gl-check", "All events"), labelled(ctx, "button", "Style", true)],
    pointer: "click",
    done: (ctx) => ctx.layout.allEvents,
  },
  {
    id: "layout-export",
    chapter: "layout",
    title: "Export the page",
    body: "Press “Export PDF” to write the sheet as a PDF; the format under Page can be SVG with editable text, or PNG. The file goes to your downloads.",
    // The toolbar's button is worded from the format chosen under Page.
    target: (ctx) => [{ selector: "button", text: tr(ctx)("Export {format}", { format: "PDF" }), exact: true }, labelled(ctx, "button", "Export", true)],
    pointer: "click",
    enter: (ctx) => ctx.signals.layoutExports,
    done: (ctx, memo) => ctx.signals.layoutExports > (memo as number),
  },

  // ── Plotting ──
  {
    id: "tab-plotting",
    chapter: "plotting",
    title: "The Plotting tab",
    body: "Open the Plotting tab. It charts population proportions across files, grouped by a metadata column.",
    target: tab("proportions"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "proportions",
  },
  {
    id: "plotting-pick",
    chapter: "plotting",
    title: "Choose populations",
    body: "The Populations panel on the right chooses what is charted: the parent, and beneath it the populations whose shares of it are shown for each checked file. Tick or untick one; the chart follows.",
    target: 'aside[aria-label="Populations"]',
    pointer: "click",
    enter: (ctx) => ctx.proportions.populations,
    done: (ctx, memo) => ctx.proportions.populations !== (memo as number),
  },

  // ── Statistics ──
  {
    id: "tab-statistics",
    chapter: "statistics",
    title: "The Statistics tab",
    body: "Open the Statistics tab: counts, percentages of parent and of total, and medians per population and file.",
    target: tab("statistics"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "statistics",
  },
  {
    id: "statistics-download",
    chapter: "statistics",
    title: "The table",
    body: "The table covers the checked files. Press “Download CSV” to write it out, or Skip.",
    target: (ctx) => labelled(ctx, "button", "Download CSV", true),
    pointer: "click",
    enter: (ctx) => ctx.signals.statsDownloads,
    done: (ctx, memo) => ctx.signals.statsDownloads > (memo as number),
  },

  // ── Metadata ──
  {
    id: "tab-metadata",
    chapter: "metadata",
    title: "The Metadata tab",
    body: "Open the Metadata tab. Columns of values per file (donor, condition, day) feed the Plotting tab's grouping and the Layout tab's iteration.",
    target: tab("metadata"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "metadata",
  },
  {
    id: "metadata-add-column",
    chapter: "metadata",
    title: "Add a column",
    body: "Press “+ Field” to add a column, then give each file a value. The file list then offers the values as chips that check the files carrying them.",
    target: (ctx) => [labelled(ctx, "button", "+ Field", true), ".gl-center"],
    pointer: "click",
    enter: (ctx) => ctx.metadataColumns.length,
    done: (ctx, memo) => ctx.metadataColumns.length > (memo as number),
  },

  // ── Panel ──
  {
    id: "tab-panel",
    chapter: "panel",
    title: "The Panel tab",
    body: "Open the Panel tab: the channels of the files, their markers from the FCS, and the display names the plots use.",
    target: tab("panel"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "panel",
  },
  {
    id: "panel-info",
    chapter: "panel",
    title: "Display names",
    body: "A display name renames a channel everywhere it is drawn without touching the file. Next to go on.",
    target: ".gl-tab-panel",
    pointer: "none",
  },

  // ── Scales ──
  {
    id: "tab-scales",
    chapter: "scales",
    title: "The Scales tab",
    body: (ctx) =>
      tr(ctx)(ctx.scales.locked
        ? "Open the Scales tab: the range each channel's axis is drawn on, shared by every file while the scale lock is on."
        : "Open the Scales tab: the range each channel's axis is drawn on, for the file you are viewing."),
    target: tab("scales"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "scales",
  },
  {
    id: "scales-info",
    chapter: "scales",
    title: "The rows in blue",
    body: (ctx) => {
      const { adjusted, fitted } = ctx.scales;
      const one = (names: readonly string[]) => names.length === 1;
      const t = tr(ctx);
      return [
        t("A row in blue holds a range that was adjusted after the file was read. The other rows are automatic, and their grey numbers are the range GateLab draws."),
        // The mechanism, not a claim that the reader did it: a workspace saved with its scales
        // locked, as the demo is, opens with the ranges it was saved with.
        adjusted.length
          ? t(one(adjusted)
              ? "{names} is blue: moving, stretching or rescaling a plot on the Gating tab writes its range here, as the earlier steps of this tutorial do, and a Min or Max typed here does the same."
              : "{names} are blue: moving, stretching or rescaling a plot on the Gating tab writes its range here, as the earlier steps of this tutorial do, and a Min or Max typed here does the same.", { names: listOf(ctx, adjusted) })
          : t(ctx.scales.locked
              ? "You have adjusted none yet: move or stretch a plot on the Gating tab, or type a Min or Max here, and its row turns blue."
              : "You have adjusted none on this file yet: move or stretch a plot on the Gating tab, or type a Min or Max here, and its row turns blue."),
        fitted.length
          ? t(one(fitted)
              ? "GateLab adjusted {names} itself, to keep the gates in view the first time its plot was shown."
              : "GateLab adjusted {names} itself, to keep the gates in view the first time their plot was shown.", { names: listOf(ctx, fitted) })
          : "",
        t("A range changes the view only: gates live in raw space, so no event moves in or out of one. Next to go on."),
      ].filter(Boolean).join(sentenceGap(ctx));
    },
    target: [".gl-scales-table", ".gl-tab-panel"],
    pointer: "none",
  },

  // ── Compensation ──
  {
    id: "tab-compensation",
    chapter: "compensation",
    title: "The Compensation tab",
    body: "Open the Compensation tab: the spillover matrix the demo carries, applied to a compensated assay, with a review of each channel pair.",
    target: tab("compensation"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "compensation",
  },
  {
    id: "compensation-pair",
    chapter: "compensation",
    title: "Select a pair",
    body: "Each cell of the matrix is the spill of a source channel (rows) into a receiver (columns), in percent; the diagonal is a channel into itself. Click a cell off the diagonal (the one shown holds the most spill): the Selected coefficient panel draws that pair before and after compensation, from one frozen set of events, with the residual statistics beneath.",
    // Never a diagonal cell: it is a channel into itself, and selects nothing.
    target: [{ selector: ".gl-comp-cell:not(.diagonal)", largest: true }, ".gl-center"],
    pointer: "click",
    needs: { compensationView: "matrix" },
    done: (ctx) => ctx.compensation.pairSelected,
  },
  {
    id: "compensation-global",
    chapter: "compensation",
    title: "Every pair at once",
    body: "Open “Global inspector” above the matrix: every pair as a small biplot, ranked by how much attention it needs, with Flagged keeping the ones you mark for follow-up. Where a matrix can be edited, the Selected coefficient panel also carries an editor: stage a value, then Apply revised matrix recomputes the compensated assay.",
    target: (ctx) => labelled(ctx, '[role="tab"]', "Global inspector", true),
    pointer: "click",
    done: (ctx) => ctx.compensation.view === "global",
  },
  {
    id: "compensation-toggle",
    chapter: "compensation",
    title: "Compensated and uncompensated",
    body: "The switch at the top right of the inspector shows every plot in compensated or uncompensated data, without changing a frame. Click it to see what the matrix does to each pair, and again to come back. (The Assay menu in the header is a different thing: it sets what every tab draws from.)",
    target: ".gl-comp-layer-toggle",
    pointer: "click",
    needs: { compensationView: "global" },
    enter: (ctx) => ctx.compensation.galleryLayer,
    done: (ctx, memo) => ctx.compensation.galleryLayer !== memo,
  },

  // ── Finish ──
  {
    id: "tab-gating-again",
    chapter: "finish",
    title: "Back to Gating",
    body: "Open the Gating tab again.",
    target: tab("gating"),
    pointer: "click",
    needs: ANY_TAB,
    done: (ctx) => ctx.activeTab === "gating",
  },
  {
    id: "save-workspace",
    chapter: "finish",
    title: "Saving your work",
    body: "The Workspace menu saves: “Save Portable Copy” writes one .gatelab file with the FCS data, the compensation and the gating inside, which opens anywhere. Save a copy, or Skip. Import brings in FlowJo and FACSChorus gates and Gating-ML; Export writes them back out.",
    target: (ctx) => [labelled(ctx, '[role="menuitem"]', "Save Portable Copy"), ".gl-tour-workspace-menu > button"],
    pointer: "click",
    enter: (ctx) => ctx.signals.workspaceSaves,
    done: (ctx, memo) => ctx.signals.workspaceSaves > (memo as number),
  },
  {
    id: "finish",
    chapter: "finish",
    title: "That is the tour",
    body: "You have seen every tab. The Tutorial menu starts it again from the beginning whenever you like. Bug reports and suggestions are welcome on the repository: the link at the top right, “please leave an issue at the repo”, opens its issue tracker.",
    target: '[data-tour="issues-link"]',
    pointer: "none",
  },
];

export const TOUR_STEP_COUNT = TOUR_STEPS.length;

export function chapterOf(step: TourStep): TourChapter {
  return TOUR_CHAPTERS.find((chapter) => chapter.id === step.chapter) ?? { id: step.chapter, title: step.chapter };
}

/** The sentences of a step's body, joined as the language joins sentences. */
const sentenceGap = (ctx: TourContext) => (ctx.language === "ja" ? "" : " ");

/** The step's title in the interface's language. */
export function stepTitle(step: TourStep, ctx: TourContext): string {
  return tr(ctx)(step.title);
}

/** The step's body in the interface's language, built from the context where it names the demo's own gates and files. */
export function stepBody(step: TourStep, ctx: TourContext): string {
  return typeof step.body === "function" ? step.body(ctx) : tr(ctx)(step.body);
}

export function stepTarget(step: TourStep, ctx: TourContext): TourTargetSpec | null {
  if (!step.target) return null;
  return typeof step.target === "function" ? step.target(ctx) : step.target;
}
