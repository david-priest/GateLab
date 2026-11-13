// On reopening a hosted workspace each SCE sample gets the saved state with its own id, then one
// with its label; a saved sample with an id is never given to another sample by its place in the list.

import { describe, expect, it } from "vitest";
import type { GateLabHostDatasetDescriptor } from "./datasetContract";
import { readHostedWorkspace } from "./hostedWorkspace";
import type { GateLabHostWorkspaceEnvelope } from "./workspaceContract";

function dataset(samples: { id: string; label: string }[]): GateLabHostDatasetDescriptor {
  return {
    contractVersion: 1,
    id: "sce",
    label: "Test SCE",
    instrument: "cytof",
    eventCount: samples.length,
    channels: [
      { id: "142Nd_CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" },
      { id: "151Eu_CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
    ],
    assays: [{ id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
    defaultAssayId: "counts",
    samples: samples.map((s) => ({
      id: s.id, label: s.label, eventCount: 1, metadata: {}, assayByteLength: 8,
      eventIndexEncoding: "uint32-le", eventIndexByteLength: 4,
    })),
  } as GateLabHostDatasetDescriptor;
}

const legacyJson = JSON.stringify({
  gates: {},
  gate_order: [],
  populations: {
    root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: 2, percent_of_parent: 100 },
  },
  root_population_id: "root",
  gate_value_space: "display",
  global_scale_ranges: {},
  saved_at: "2026-11-11 12:00:00",
});

/** A saved workspace whose samples carry a donor each, as GateLab writes it into the SCE. */
async function savedWorkspace(samples: { id: string; label: string; donor: string }[]): Promise<string> {
  const restored = await readHostedWorkspace(
    { contractVersion: 1, datasetId: "sce", sourceFormat: "gatelabr-legacy", revision: 0, workspaceJson: legacyJson },
    dataset(samples),
  );
  const ws = restored.workspace;
  return JSON.stringify({ ...ws, samples: ws.samples.map((s, i) => ({ ...s, metadata: { donor: samples[i].donor } })) });
}

async function donorsOnReopening(runtime: { id: string; label: string }[]): Promise<Record<string, unknown>> {
  const json = await savedWorkspace([
    { id: "a", label: "S1", donor: "D1" },
    { id: "b", label: "S2", donor: "D2" },
  ]);
  const envelope: GateLabHostWorkspaceEnvelope = {
    contractVersion: 1, datasetId: "sce", sourceFormat: "gatelab-workspace", revision: 1, workspaceJson: json,
  };
  const restored = await readHostedWorkspace(envelope, dataset(runtime));
  return Object.fromEntries(restored.workspace.samples.map((s) => [s.sampleId, s.metadata?.donor]));
}

describe("saved and SCE samples paired on reopening a hosted workspace", () => {
  it("pairs by id when two samples have exchanged labels", async () => {
    expect(await donorsOnReopening([{ id: "a", label: "S2" }, { id: "b", label: "S1" }]))
      .toEqual({ "sce:a": "D1", "sce:b": "D2" });
  });

  it("pairs by id when the SCE lists the samples in another order", async () => {
    expect(await donorsOnReopening([{ id: "b", label: "S2" }, { id: "a", label: "S1" }]))
      .toEqual({ "sce:b": "D2", "sce:a": "D1" });
  });

  it("gives a sample with no saved state none, not the state saved at its place", async () => {
    const donors = await donorsOnReopening([{ id: "a", label: "S1" }, { id: "c", label: "S3" }]);
    expect(donors["sce:a"]).toBe("D1");
    expect(donors["sce:c"]).toBeUndefined();
  });
});
