// evaluate.ts — a GateLab workspace evaluated for a host such as GateLabR, which has no gating
// engine of its own: the workspace, what each sample is, and every population's membership, in the
// payload the host already stores after "Save to SCE".
//
// The workspace is opened by the headless runner's own steps (workspace.ts openWorkspaceState),
// and memberships are read the way the app reads them for an explicit hosted save
// (host/hostedMemberships.ts buildHostedMemberships): every population of every hierarchy, each
// sample gated under the tree it is assigned (the tree, its group's copy or its own tailored copy).
// Nothing here decides membership; the store's recompute does, as in the app.
//
// It runs in plain Node from the embed build (dist-embed/gatelab-embed.js), with no DOM: the
// .gatelab reader, the FCS reader and the store need none. Gating-ML and FlowJo files, which need
// a DOM parser, are not read here.

import { fileHierarchyId } from "../engine/hierarchies";
import { recomputeGating } from "../store";
import {
  buildHostedMemberships,
  gatingStateForTree,
  notEvaluatedNotes,
  type HierarchyTree,
  type HostedMembershipSample,
} from "../host/hostedMemberships";
import type { GateLabHostWorkspaceMemberships } from "../host/workspaceContract";
import { HeadlessError, type Refusal } from "./headless";
import { openWorkspaceState, type FcsInput } from "./workspace";

export const WORKSPACE_EVALUATION_FORMAT = "gatelab-workspace-evaluation" as const;
export const WORKSPACE_EVALUATION_VERSION = 1 as const;

type Bytes = Uint8Array | ArrayBuffer;

/** An FCS file given with a linked workspace: matched by name and recorded acquisition. */
export interface WorkspaceFcsFile {
  /** The file's name, as the workspace declares it (a basename). */
  name: string;
  bytes: Bytes;
  /** Where it was read from, for messages; the name when absent. */
  path?: string;
}

/**
 * What to evaluate: the bytes of a .gatelab file (a portable bundle, or a linked workspace with
 * its FCS files), or a workspace JSON with its FCS files.
 */
export type WorkspaceArchiveInput =
  | Bytes
  | {
      /** The .gatelab bytes, or the workspace JSON as text. */
      workspace: Bytes | string;
      /** The FCS files a linked workspace declares; none for a portable bundle. */
      fcs?: readonly WorkspaceFcsFile[];
      /** For messages: where the workspace came from. */
      path?: string;
    };

/** One column of a sample's FCS file, or a channel GateLab derived and saved with the workspace. */
export interface EvaluatedColumn {
  /** The channel key gates, scales and labels name; null for a column the app does not offer (a raw spectral detector of an unmixed file). */
  key: string | null;
  /** $PnN */
  pnn: string;
  /** $PnS, or null when the file states none. */
  pns: string | null;
  /** The Panel-tab label, where the workspace gives the channel one. */
  label?: string;
  /** 0-based column in the FCS file; null for a derived channel, which the FCS file does not hold. */
  fcsColumn: number | null;
  /** True for a channel GateLab computed and saved by value with the workspace. */
  derived?: true;
}

export interface EvaluatedSample {
  /** The id the workspace and the memberships know the sample by. */
  sampleId: string;
  fileName: string;
  /** Where a portable bundle holds the file, or the name a linked workspace declares. */
  dataPath: string;
  eventCount: number;
  instrument: "flow" | "cytof";
  /** Whether the gates are evaluated on compensated values for this sample. */
  compensation: boolean;
  /** The hierarchy the sample is gated under: the tree, its group's copy or its own tailored copy. */
  hierarchyId: string;
  columns: EvaluatedColumn[];
  /** As the headless runner records them per file (report.json files[].refusals). */
  refusals: Refusal[];
}

export interface WorkspaceEvaluation {
  format: typeof WORKSPACE_EVALUATION_FORMAT;
  version: typeof WORKSPACE_EVALUATION_VERSION;
  storage: "bundle" | "reference";
  /** The workspace JSON as saved, as text, so a host can store it without re-encoding. */
  workspaceJson: string;
  /** Saved channel keys the files now read differently, restated as the app restates them on open. */
  channelKeyRemap: Record<string, string>;
  samples: EvaluatedSample[];
  /** Every population of every hierarchy over every sample, as GateLabR stores it. */
  memberships: GateLabHostWorkspaceMemberships;
  /** What the opening said that is not a refusal, and each population not evaluated for a sample. */
  notes: string[];
}

const asBytes = (b: Bytes): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));

function isBytes(v: unknown): v is Bytes {
  return v instanceof Uint8Array || v instanceof ArrayBuffer;
}

/**
 * Open a .gatelab workspace with GateLab's engine and return the workspace, each sample's columns,
 * and every population's membership for every hierarchy, packed LSB-first as GateLabR stores them.
 *
 * Refused, with the headless runner's message, where the runner refuses: a linked workspace whose
 * FCS files are not all given or cannot be told apart, FCS files given with a portable bundle, and
 * a sample gated on a compensated layer kept by reference to a compensation profile, which the app
 * recomputes on a worker (a portable bundle that carries the compensated values is evaluated).
 */
export async function evaluateWorkspaceArchive(input: WorkspaceArchiveInput): Promise<WorkspaceEvaluation> {
  let bytes: Uint8Array;
  let fcs: FcsInput[] = [];
  let path = "the workspace";
  if (isBytes(input)) {
    bytes = asBytes(input);
  } else if (input && typeof input === "object" && "workspace" in input) {
    bytes = typeof input.workspace === "string" ? new TextEncoder().encode(input.workspace) : asBytes(input.workspace);
    fcs = (input.fcs ?? []).map((f) => ({ name: f.name, path: f.path ?? f.name, bytes: asBytes(f.bytes) }));
    if (input.path) path = input.path;
  } else {
    throw new HeadlessError("evaluateWorkspaceArchive takes the bytes of a .gatelab file, or { workspace, fcs }.");
  }

  const opened = await openWorkspaceState(bytes, path, fcs);
  const { workspace, state, samples, fileIds } = opened;

  const hostSamples: HostedMembershipSample[] = samples.map((sample, index) => ({
    sampleId: fileIds[index],
    eventCount: sample.fcs.nEvents,
    name: workspace.samples[index].fileName,
    hierarchyId: fileHierarchyId(state.file_hierarchies[fileIds[index]], state.hierarchies),
    gatingFor: (tree: HierarchyTree) => recomputeGating(sample, gatingStateForTree(state, tree)),
  }));
  const memberships = buildHostedMemberships(state, hostSamples);

  const evaluated: EvaluatedSample[] = samples.map((sample, index) => {
    const wss = workspace.samples[index];
    const resolved = new Map(sample.channels.map((c) => [c.columnIndex, c]));
    const columns: EvaluatedColumn[] = sample.fcs.channels.map((column) => {
      const channel = resolved.get(column.index);
      return {
        key: channel?.key ?? null,
        pnn: column.name,
        pns: column.marker ?? null,
        ...(channel?.label !== undefined ? { label: channel.label } : {}),
        fcsColumn: column.derived ? null : column.index,
        ...(column.derived ? { derived: true as const } : {}),
      };
    });
    return {
      sampleId: fileIds[index],
      fileName: wss.fileName,
      dataPath: wss.dataPath,
      eventCount: sample.fcs.nEvents,
      instrument: sample.instrument,
      compensation: sample.compensationEnabled,
      hierarchyId: hostSamples[index].hierarchyId,
      columns,
      refusals: [],
    };
  });

  const notEvaluated = notEvaluatedNotes(memberships.populations.flatMap((p) => p.sampleMasks));
  return {
    format: WORKSPACE_EVALUATION_FORMAT,
    version: WORKSPACE_EVALUATION_VERSION,
    storage: opened.storage,
    workspaceJson: JSON.stringify(opened.saved),
    channelKeyRemap: Object.fromEntries(opened.channelKeyRemap),
    samples: evaluated,
    memberships,
    notes: [...opened.notes, ...notEvaluated],
  };
}
