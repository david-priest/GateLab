// workspaceRecords.ts — the parts of a saved workspace that describe the data and the gating: one
// record per sample and the gating with every hierarchy. The app's Save (App.tsx,
// buildWorkspaceFile) and the headless runner's --save-workspace (src/headless/saveWorkspace.ts)
// both write them from here, so a workspace written without the app opens in it as one the app
// wrote. The view settings (display, Illustration, Layout, Plotting) stay with the app.

import type { WorkspaceFile, WorkspaceSample } from "./engine/workspace";
import type { DisplayMode, Sample } from "./engine/sample";
import type { CellImageSource } from "./imaging/imageSource";
import { SAMPLE_ID_FIELD, sampleDisplayId } from "./engine/metadata";
import { identityKeywords } from "./engine/fileIdentity";
import { encodeDerivedChannel } from "./engine/derivedChannels";
import { switchedOnGateIds, type CoreState } from "./store";

/** The Gating plot's settings in a new session, and in a workspace written without the app. */
export const DEFAULT_DISPLAY_MODE: DisplayMode = "pseudocolor";
export const DEFAULT_MAX_EVENTS = 50000; // 0 = all (no downsampling)
export const DEFAULT_CONTOUR_THRESHOLD = 5; // outer contour % of peak

/** Where a portable workspace keeps a sample's FCS file. */
export const sampleDataPath = (name: string, i: number) =>
  `data/${i}_${(name || "sample.fcs").replace(/[^A-Za-z0-9._-]/g, "_")}`;

/** A loaded sample, as far as its record reads it. */
export interface WorkspaceSampleSource {
  id: string;
  name: string;
  sample: Sample;
  images?: CellImageSource;
}

/** What the record takes from outside the sample: the workspace's tables, by the sample's id. */
export interface WorkspaceSampleContext {
  metadata?: Record<string, string>;
  division?: WorkspaceSample["division"];
  hierarchyId?: string;
  groupId?: string;
  /** A FlowJo workspace's matrix still being installed: the file is to be compensated. */
  compensationPending: boolean;
}

export function workspaceSampleRecord(e: WorkspaceSampleSource, i: number, ctx: WorkspaceSampleContext): WorkspaceSample {
  return {
    sampleId: e.id,
    fileName: e.name,
    dataPath: sampleDataPath(e.name, i),
    logicleW: e.sample.logicleWOverrides(),
    scatterCofactor: e.sample.scatterCofactorOverrides(),
    scatterLinear: e.sample.scatterLinearKeys(),
    fluorArcsinh: e.sample.fluorArcsinhKeys(),
    fluorBiex: e.sample.fluorBiexEntries(),
    // Only where a biex axis was adjusted, so that a reset after reopening finds its origin.
    ...(Object.keys(e.sample.fluorBiexRecordedEntries()).length ? { fluorBiexRecorded: e.sample.fluorBiexRecordedEntries() } : {}),
    cytofCofactor: e.sample.arcsinhCofactor,
    compensationOn: e.sample.compensationEnabled ||
      (e.sample.spillover === null && ctx.compensationPending),
    instrumentMode: e.sample.instrumentMode,
    labels: e.sample.labelOverrides(),
    metadata: { ...ctx.metadata, [SAMPLE_ID_FIELD]: sampleDisplayId(e.name, ctx.metadata) },
    division: ctx.division,
    // Channels GateLab computed for the file, by value, so reopening needs no recount.
    ...(e.sample.derivedChannels().length ? { derived: e.sample.derivedChannels().map(encodeDerivedChannel) } : {}),
    ...(ctx.hierarchyId ? { hierarchyId: ctx.hierarchyId } : {}),
    ...(ctx.groupId ? { groupId: ctx.groupId } : {}),
    // What the file recorded about its acquisition, so relinking finds this file and not
    // another experiment's file of the same name.
    ...(Object.keys(identityKeywords(e.sample.fcs.keywords)).length
      ? { identity: identityKeywords(e.sample.fcs.keywords) }
      : {}),
    // A matrix that is not the file's own (a FlowJo workspace's) goes with the file, so the
    // reopened file is compensated with the matrix its gates were drawn under.
    ...(e.sample.externalSpillover ? { externalSpillover: e.sample.externalSpillover } : {}),
    // Attached cell images are linked by name and identity, never copied: the file stays
    // where the instrument exported it and is found again beside the FCS on reopening.
    ...(e.images
      ? {
          images: [
            e.images.kind === "tiff-folder"
              ? { kind: "tiff-folder" as const, fileName: e.images.fileName, eventCount: e.images.eventCount, naming: { ...e.images.naming } }
              : { kind: "cvw" as const, fileName: e.images.fileName, eventCount: e.images.eventCount, ...(e.images.recordingId ? { recordingId: e.images.recordingId } : {}) },
          ],
        }
      : {}),
  };
}

export function workspaceGatingRecord(state: CoreState): WorkspaceFile["gating"] {
  return {
    gates: state.gates,
    gate_order: state.gate_order,
    populations: state.populations,
    root_population_id: state.root_population_id,
    active_population_id: state.active_population_id,
    selected_gate_id: state.selected_gate_id && state.gates[state.selected_gate_id]
      ? state.selected_gate_id
      : null,
    hierarchies: state.hierarchies.map((h) => ({ ...h })),
    ...(state.groups.length ? { groups: state.groups.map((g) => ({ ...g })) } : {}),
    active_hierarchy_id: state.active_hierarchy_id,
    stored_hierarchies: Object.values(state.stored_hierarchies).map((h) => ({
      id: h.id,
      name: h.name,
      ...(h.owner_sample_id ? { owner_sample_id: h.owner_sample_id } : {}),
      ...(h.owner_group_id ? { owner_group_id: h.owner_group_id } : {}),
      ...(h.structure_locked !== undefined ? { structure_locked: h.structure_locked } : {}),
      ...(h.source_hierarchy_id ? { source_hierarchy_id: h.source_hierarchy_id } : {}),
      ...(h.source_gate_ids ? { source_gate_ids: h.source_gate_ids } : {}),
      ...(h.source_population_ids ? { source_population_ids: h.source_population_ids } : {}),
      ...(switchedOnGateIds(h).length ? { tailored_gate_ids: [...switchedOnGateIds(h)] } : {}),
      // Its own geometry travels with it. Without this a parked hierarchy would come back
      // pointing at gates that belong to whichever hierarchy happened to be active.
      gates: h.gates,
      gate_order: h.gate_order,
      populations: h.populations,
      root_population_id: h.root_population_id,
      active_population_id: h.active_population_id,
    })),
    // Every file is in a group, so the assignments always mean what they say.
    perFileHierarchies: true,
  };
}
