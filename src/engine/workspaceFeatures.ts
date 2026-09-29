// workspaceFeatures.ts — what a saved workspace needs of the GateLab that opens it.
//
// Some things a workspace can hold are read WRONGLY, not refused, by a GateLab that predates them:
// a gate on FlowJo's grid (`flowjoChannels`, flowjoGrid.ts) is read by 0.8.3 as an arcsinh axis,
// so its events score 0 to 8 against vertices on channels 0 to 255 (and the gate list's badge
// throws on it); a biex axis on FlowJo's 4096-channel table (`tableChannels`, biex.ts) is read on
// the 256-channel one, 100.83 channels instead of 94.26 at raw 500. Neither says a word.
//
// A file compensated with a matrix a FlowJo workspace supplied (WorkspaceSample.externalSpillover)
// is misread the same way: 0.8.3 compensates it with the file's own matrix, or not at all. So is a
// half-open rectangle (`bounds: "half-open"`, models.ts), which every rectangle drawn in GateLab
// is: 0.8.3 reads and keeps the key but evaluates the rectangle closed, so an event lying exactly
// on its max is counted inside.
//
// So a workspace holding any of these says so where an older GateLab looks, and is refused there:
//   - one of the version 2 layout is written as version 4, the same layout with a list of
//     `requiredFeatures`. GateLab 0.8.3 opens versions 1, 2 and 3 only, and says so.
//   - one of the version 3 layout (a saved compensation profile) keeps version 3 and gains the
//     `requiredFeatures` key, which 0.8.3's version 3 reader refuses as a key it does not know.
// A workspace holding none of them is written exactly as before. This build reads both forms and
// refuses a feature it does not know, so a later feature can be added the same way.
//
// A workspace saved to a GateLabR host (SCE metadata) is written the same way. The SCE's copy is
// opened by whichever GateLab the opening GateLabR embeds, and an older GateLabR embeds 0.8.3:
// written as version 2 with the `requiredFeatures` key beside it, 0.8.3 read it as version 2,
// ignored the key, and the gate badge threw on the first grid gate, which left the whole app
// blank. As version 4, 0.8.3 says it cannot open the version. GateLabR stores the JSON as written
// and, as of this build, checks that its version is 2 or 3 (R/host_bridge.R), so a GateLabR that
// embeds this build must accept version 4 as well (the version 2 layout); until it does, such a
// save is refused there with GateLabR's own message, and nothing is written wrong. A version 2
// workspace with `requiredFeatures`, which the hosted save wrote before, is still read.

/** Each feature, and what in the workspace needs it. */
export const WORKSPACE_FEATURES = {
  /** A gate axis on FlowJo's gate grid: a TransformSpec of kind "flowjoChannels". */
  flowjoGrid: "flowjo-grid",
  /** A biex axis on a stated table (FlowJo's 4096 channels): a biex TransformSpec with tableChannels. */
  flowjoBiexTable: "flowjo-biex-table",
  /**
   * A file compensated with a matrix that is not its own, recorded beside it
   * (WorkspaceSample.externalSpillover): a GateLab without the record compensates with the file's
   * matrix instead, and every fluorescence gate is evaluated on other values.
   */
  externalSpillover: "external-spillover",
  /**
   * A rectangle whose upper edges hold no event (`bounds: "half-open"`, Gating-ML's rule): a
   * GateLab without the rule evaluates it closed, and an event on a max is counted inside.
   */
  halfOpenRectangle: "half-open-rectangle",
} as const;

export type WorkspaceFeature = (typeof WORKSPACE_FEATURES)[keyof typeof WORKSPACE_FEATURES];

const KNOWN: ReadonlySet<string> = new Set(Object.values(WORKSPACE_FEATURES));

/** The version a workspace of the version 2 layout is written as when it needs a feature. */
export const WORKSPACE_VERSION_2_WITH_FEATURES = 4 as const;

/**
 * The features a workspace (or any part of one) needs, in a fixed order: every object in it is
 * looked at, so a transform held anywhere counts -- a gate in any hierarchy, a file's or a group's
 * copy, a figure.
 */
export function requiredWorkspaceFeatures(value: unknown): WorkspaceFeature[] {
  let grid = false;
  let table = false;
  let spillover = false;
  let halfOpen = false;
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === "object") stack.push(item);
      continue;
    }
    const o = v as Record<string, unknown>;
    if (o.kind === "flowjoChannels") grid = true;
    else if (o.kind === "biex" && o.tableChannels !== undefined) table = true;
    if (o.externalSpillover !== undefined) spillover = true;
    if (o.bounds === "half-open") halfOpen = true;
    for (const key in o) {
      const child = o[key];
      if (child && typeof child === "object") stack.push(child);
    }
    if (grid && table && spillover && halfOpen) break;
  }
  return [
    ...(grid ? [WORKSPACE_FEATURES.flowjoGrid] : []),
    ...(table ? [WORKSPACE_FEATURES.flowjoBiexTable] : []),
    ...(spillover ? [WORKSPACE_FEATURES.externalSpillover] : []),
    ...(halfOpen ? [WORKSPACE_FEATURES.halfOpenRectangle] : []),
  ];
}

/** Refuse a workspace naming a feature this GateLab does not have. */
export function assertKnownWorkspaceFeatures(features: unknown): void {
  if (features === undefined) return;
  if (!Array.isArray(features) || !features.every((f) => typeof f === "string")) {
    throw new Error("Invalid GateLab workspace: requiredFeatures must be a list of names.");
  }
  const unknown = features.filter((f) => !KNOWN.has(f));
  if (unknown.length) {
    throw new Error(
      `This workspace needs ${unknown.join(", ")}, which this version of GateLab does not have; open it in a later GateLab.`,
    );
  }
}

/**
 * A workspace of the version 2 layout as it is written: version 4 with its features when it needs
 * any, unchanged otherwise.
 */
export function stampWorkspaceV2<T extends { version: number }>(ws: T): T | (Omit<T, "version"> & { version: 4; requiredFeatures: WorkspaceFeature[] }) {
  const features = requiredWorkspaceFeatures(ws);
  if (!features.length) return ws;
  return { ...ws, version: WORKSPACE_VERSION_2_WITH_FEATURES, requiredFeatures: features };
}

/**
 * A workspace of the version 3 layout as it is written: its features listed when it needs any, the
 * key left out otherwise (and a stale one dropped).
 */
export function stampWorkspaceV3<T extends { version: number; requiredFeatures?: unknown }>(ws: T): T {
  const { requiredFeatures: _stale, ...rest } = ws;
  const features = requiredWorkspaceFeatures(rest);
  return (features.length ? { ...rest, requiredFeatures: features } : rest) as T;
}

/** Any workspace as it is written, by its layout's version. */
export function stampWorkspace<T extends { version: number; requiredFeatures?: unknown }>(ws: T): unknown {
  return ws.version === 3 ? stampWorkspaceV3(ws) : stampWorkspaceV2(ws);
}

/**
 * A workspace as it is written to a GateLabR host (SCE metadata): as a file is, so that a GateLab
 * that predates a feature refuses the SCE's copy by its version. See the header.
 */
export function stampHostedWorkspace<T extends { version: number; requiredFeatures?: unknown }>(ws: T): unknown {
  return stampWorkspace(ws);
}
