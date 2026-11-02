// saveWorkspace.ts — `--save-workspace`: the FCS files and the tree imported onto them, written as a
// GateLab workspace that opens in the app as one the app saved.
//
// The layout is the app's per-file import (App.tsx, the one-tree branch of applyGatingImport): one
// tree from the viewed file, every other file given it with its own coordinates on the gates they
// share, and a file-owned copy only where a file's coordinates differ. The store's own reducer
// builds it, and the records come from src/workspaceRecords.ts, which the app's Save writes too.
// The view settings the app keeps (Illustration, Layout, Plotting) are left out; the app opens
// such a workspace with its defaults, as it opens one saved before those panels existed.

import { coreReducer, initialCoreState, type CoreState } from "../store";
import { planOneTreeImport, describeDiffering } from "../engine/oneTreeImport";
import { templateNameFromOrigin, type TailoredFile } from "../engine/tailoredImport";
import { packWorkspace, packWorkspaceReference, type WorkspaceFile } from "../engine/workspace";
import { exportGatingML } from "../engine/gatingmlExport";
import { SAMPLE_ID_FIELD } from "../engine/metadata";
import {
  DEFAULT_CONTOUR_THRESHOLD, DEFAULT_DISPLAY_MODE, DEFAULT_MAX_EVENTS, workspaceGatingRecord, workspaceSampleRecord,
} from "../workspaceRecords";
import { findPopulation, HeadlessError, type GatedFile, type GatingTree } from "./headless";

export interface SaveWorkspaceOptions {
  /** Portable: the workspace with every FCS file in it. Linked: the workspace alone. */
  portable: boolean;
  /** The tree's name; else the FlowJo group every file shares, else "Imported strategy", as the app names it. */
  treeName?: string;
  /** Populations renamed in the saved tree, each by a selector as --export-fcs takes one. */
  renames: readonly { from: string; to: string }[];
  /** The version that wrote the file, as the app writes it ("GateLab 0.10.1"). */
  app: string;
}

export interface SavedWorkspace {
  bytes: Uint8Array;
  workspace: WorkspaceFile;
  /** The tree's name, the file that led it, and the files given a tailored copy. */
  tree: string;
  lead: string;
  tailored: string[];
  /** Files whose strategy differs in structure from the tree's, as the app's import reports them. */
  differing: string;
}

/** The populations' names as the user may type them: a Unicode minus as the ASCII one. */
const typed = (s: string) => s.replace(/−/g, "-");

/** A population by selector, as written, else with a Unicode minus read as the ASCII one. */
function renamedPopulation(tree: GatingTree, selector: string): string {
  try {
    return findPopulation(tree, selector);
  } catch (e) {
    const folded: GatingTree = {
      ...tree,
      populations: Object.fromEntries(Object.entries(tree.populations).map(([id, p]) => [id, { ...p, name: typed(p.name) }])),
    };
    try {
      return findPopulation(folded, typed(selector));
    } catch {
      throw e;
    }
  }
}

const newId = () => globalThis.crypto.randomUUID();

/**
 * The store as the app leaves it after opening the files together and importing the tree onto
 * them: the last file viewed, its strategy leading the tree, unless another file's coordinates are
 * shared by more of the files (planOneTreeImport).
 */
export function oneTreeState(files: readonly GatedFile[], opts: Pick<SaveWorkspaceOptions, "treeName" | "renames">) {
  if (!files.length) throw new HeadlessError("--save-workspace needs at least one FCS file.");
  const ids = files.map(() => newId());
  const viewed = files.length - 1;
  const perFile: TailoredFile[] = files.map((g, i) => ({
    fileId: ids[i],
    fileName: g.file,
    tree: g.tree,
    origin: g.origin ?? null,
    detectors: Object.fromEntries(g.sample.channels.map((c) => [c.key, c.pnn])),
  }));
  let state: CoreState = coreReducer(initialCoreState(), { type: "loadSample", nEvents: files[viewed].sample.fcs.nEvents });
  const templateId = state.active_hierarchy_id;
  const treeName = opts.treeName?.trim();
  const plan = planOneTreeImport(perFile, {
    templateId, leadFileId: ids[viewed], existing: state.hierarchies,
    name: treeName || ((lead) => templateNameFromOrigin({ key: "", lead, files: perFile }, "Imported strategy")),
  });
  state = coreReducer(state, {
    type: "importGating",
    gates: plan.template.tree.gates,
    gate_order: plan.template.tree.gate_order,
    populations: plan.template.tree.populations,
    root_population_id: plan.template.tree.root_population_id,
    mode: "replace",
    clearHistory: true,
  });
  state = coreReducer(state, { type: "renameHierarchy", id: templateId, name: plan.template.name });
  state = plan.copies.length
    ? coreReducer(state, { type: "addHierarchyCopies", copies: plan.copies, activeHierarchyId: templateId, assignments: plan.assignments })
    : coreReducer(state, { type: "assignFileHierarchies", assignments: plan.assignments });
  if (opts.renames.length) {
    const tree: GatingTree = { gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: state.root_population_id! };
    const names: Record<string, string> = {};
    for (const { from, to } of opts.renames) {
      if (!to.trim()) throw new HeadlessError(`--rename "${from}=": the new name is empty.`);
      names[renamedPopulation(tree, from)] = to;
    }
    // The tree's copies follow it: the store carries a rename to every structure-locked copy.
    state = coreReducer(state, { type: "renamePopulations", names });
  }
  const fileName = (id: string) => perFile.find((f) => f.fileId === id)?.fileName ?? id;
  return {
    state,
    ids,
    viewed,
    tree: plan.template.name,
    lead: plan.lead.fileName,
    tailored: plan.copies.map((c) => fileName(c.owner_sample_id ?? "")),
    differing: describeDiffering(plan.differing),
  };
}

/** The workspace, packed as the app packs a version 2 workspace (engine/workspace.ts stamps it). */
export function saveWorkspace(files: readonly { gated: GatedFile; bytes: Uint8Array }[], opts: SaveWorkspaceOptions): SavedWorkspace {
  const gated = files.map((f) => f.gated);
  const built = oneTreeState(gated, opts);
  const { state, ids, viewed } = built;
  const active = gated[viewed].sample;
  const [dx, dy] = active.defaultChannelIndices();
  const workspace: WorkspaceFile = {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: newId(),
    savedAt: new Date().toISOString(),
    app: opts.app,
    samples: gated.map((g, i) => workspaceSampleRecord({ id: ids[i], name: g.file, sample: g.sample }, i, {
      hierarchyId: state.file_hierarchies[ids[i]],
      groupId: state.file_groups[ids[i]],
      compensationPending: false,
    })),
    activeSample: viewed,
    gating: workspaceGatingRecord(state),
    scales: { globalScales: {}, lockBetweenFiles: false, perSampleGlobalScales: Object.fromEntries(ids.map((id) => [id, {}])) },
    display: {
      xChannel: active.channels[dx].key,
      yChannel: active.channels[dy].key,
      mode: DEFAULT_DISPLAY_MODE,
      maxEvents: DEFAULT_MAX_EVENTS,
      contourThreshold: DEFAULT_CONTOUR_THRESHOLD,
    },
    illustrationPresets: [],
    metadataColumns: [{ name: SAMPLE_ID_FIELD }],
    populationMetadata: {},
    populationMetaColumns: [],
  };
  let bytes: Uint8Array;
  if (opts.portable) {
    const fcsByPath = Object.fromEntries(workspace.samples.map((s, i) => [s.dataPath, files[i].bytes]));
    // The tree as Gating-ML beside it, as the app bundles one (App.tsx, bundleGatingML).
    let gatingMl: string | undefined;
    try {
      gatingMl = exportGatingML({
        gates: state.gates, gate_order: state.gate_order, populations: state.populations,
        root_population_id: state.root_population_id!, sample: active, globalScales: {},
        format: "standard", allowQuadrantOmission: true,
      });
    } catch {
      gatingMl = undefined;
    }
    bytes = packWorkspace(workspace, fcsByPath, gatingMl);
  } else {
    bytes = packWorkspaceReference(workspace);
  }
  return { bytes, workspace, tree: built.tree, lead: built.lead, tailored: built.tailored, differing: built.differing };
}
