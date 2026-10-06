// tourTypes.ts — the walkthrough tutorial's contract: what the app tells it about itself
// (TourContext), what one step asks for (TourStep), and where the user is (TourProgress).
// The tutorial never reaches into the app's state directly: the app reads a context for it,
// and a step says it is done by looking at that context.

export type TourHost = "browser" | "sce";

export interface TourPopulation {
  id: string;
  name: string;
  parentId: string | null;
  children: string[];
  gateCount: number;
  /** The gates the population is defined by, in the tree's order. */
  gateIds: string[];
}

export interface TourGate {
  id: string;
  name: string;
  type: string;
  x: string;
  y: string;
  /** The gate's geometry as one string: it changes when a vertex or a side moves. */
  shape: string;
  /** A polygon tested on FlowJo's channel grid rather than by its drawn edge. */
  onFlowJoGrid: boolean;
}

/** What the app looks like right now, read fresh each time a step is checked. */
export interface TourContext {
  host: TourHost;
  activeTab: string;
  workspaceName: string;
  files: { id: string; name: string; checked: boolean; viewed: boolean }[];
  pooled: boolean;
  rootId: string | null;
  populations: Record<string, TourPopulation>;
  gates: Record<string, TourGate>;
  activePopulationId: string | null;
  selectedGateId: string | null;
  /**
   * The Gating tab's axes: the channel keys, the scale each is shown on ("linear", "arcsinh",
   * "logicle", or "fixed" where there is no choice), and the view's ranges as one string, which
   * changes when the data is moved or stretched.
   */
  axes: {
    x: string | null;
    y: string | null;
    xScale: string | null;
    yScale: string | null;
    /** Whether the axis offers a linear scale (scatter and imaging features do). */
    xLinearOffered: boolean;
    yLinearOffered: boolean;
    rangeKey: string;
  };
  displayMode: string;
  maxEvents: number;
  strategy: { fullPath: boolean; back: boolean; mode: "single" | "multi" } | null;
  illustration: { composition: string | null; populations: number } | null;
  layout: { items: number; sheets: number; allEvents: boolean };
  proportions: { populations: number };
  metadataColumns: string[];
  divisionProfiles: number;
  /** The assay layer the plots draw from. */
  assayLayer: string | null;
  /** The Compensation tab: whether a pair is selected, which of its views is open, and the matrix as a key. */
  compensation: { pairSelected: boolean; view: string; galleryLayer: string; matrixKey: string };
  /**
   * The Scales tab's blue rows for the file being viewed: the channels, by the label the tab
   * shows, whose range is held instead of automatic. `adjusted` were set by the user (a plot
   * moved, stretched, refitted or rescaled, or a range typed in the tab); `fitted` were set by
   * GateLab when it fitted a plot to its gates the first time it was shown.
   */
  scales: { adjusted: string[]; fitted: string[]; locked: boolean };
  /** Things done that leave no other trace, counted: exports and saves. */
  signals: { layoutExports: number; statsDownloads: number; workspaceSaves: number };
}

/**
 * Where a step happens: what the app must show for the step's target to be on screen. When a
 * step is entered by a button (Next, Skip, Back, Resume) the app is taken there, and when the
 * user wanders off during a step the card offers to take them back.
 */
export interface TourNeeds {
  /** The tab the step happens on; null for a step that is done from any tab. */
  tab?: string | null;
  /** A workspace is open; the demo is opened when none is. */
  workspace?: boolean;
  /** The view the Compensation tab shows. */
  compensationView?: "matrix" | "global";
}

/** An element on the page: the first visible match of the selector, by text and index. */
export interface TourTarget {
  selector: string;
  /** Keep only elements whose text holds this (or equals it, with `exact`). */
  text?: string;
  exact?: boolean;
  index?: number;
  /**
   * Of the matches, take the one showing the largest number (its text, or its value where it is
   * an input) instead of the first: the matrix cell with the most spill. The first when none
   * shows a number.
   */
  largest?: boolean;
}
export type TourTargetSpec = string | TourTarget | readonly (string | TourTarget)[];

/** How the pointer shows what to do: tap the target, drag a box over it, drag across it, or stay away. */
export type TourPointer = "click" | "drag" | "move" | "none";

export interface TourStep {
  id: string;
  chapter: string;
  title: string;
  /** What to do, as text or built from the context (the demo's own population and file names). */
  body: string | ((ctx: TourContext) => string);
  /** What to spotlight; of several, the first that is visible. None: the card alone. */
  target?: TourTargetSpec | ((ctx: TourContext) => TourTargetSpec | null);
  pointer?: TourPointer;
  /** Where the pointer acts when that is not the marked element (a drag on the plot while the tool is marked). */
  pointerTarget?: TourTargetSpec;
  /** Where the step happens, where that is not its chapter's tab with a workspace open. */
  needs?: TourNeeds;
  /** Remembered when the step is entered, so `done` can tell a change: a gate drawn, a column added. */
  enter?: (ctx: TourContext) => unknown;
  /** The step is done when this is true; a step without it waits for Next. */
  done?: (ctx: TourContext, memo: unknown) => boolean;
}

export interface TourChapter {
  id: string;
  title: string;
}

export interface TourProgress {
  stepId: string;
  /** Active: the card is shown. Paused: ended by the user, resumable here. Done: the last step was passed. */
  status: "active" | "paused" | "done";
  updatedAt: number;
}
