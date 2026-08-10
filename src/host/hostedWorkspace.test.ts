import type { GateLabHostDatasetDescriptor } from "./datasetContract";
import {
  convertHostedGateSpace,
  readHostedWorkspace,
} from "./hostedWorkspace";
import type { GateLabHostWorkspaceEnvelope } from "./workspaceContract";

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: 1,
  id: "sce",
  label: "Test SCE",
  instrument: "cytof",
  eventCount: 3,
  channels: [
    { id: "142Nd_CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" },
    { id: "151Eu_CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
  ],
  assays: [{
    id: "counts",
    label: "counts",
    role: "counts",
    coordinateSpace: "linear",
    revision: 0,
    encoding: "channel-major-float32-le",
  }],
  defaultAssayId: "counts",
  samples: [
    {
      id: "sample-0",
      label: "Donor A",
      eventCount: 2,
      metadata: {},
      assayByteLength: 16,
      eventIndexEncoding: "uint32-le",
      eventIndexByteLength: 8,
    },
    {
      id: "sample-1",
      label: "Donor B",
      eventCount: 1,
      metadata: {},
      assayByteLength: 8,
      eventIndexEncoding: "uint32-le",
      eventIndexByteLength: 4,
    },
  ],
};

function legacyEnvelope(): GateLabHostWorkspaceEnvelope {
  return {
    contractVersion: 1,
    datasetId: "sce",
    sourceFormat: "gatelabr-legacy",
    revision: 0,
    workspaceJson: JSON.stringify({
      gates: {
        "gate-1": {
          gate_id: "gate-1",
          name: "CD3 positive",
          gate_type: "rectangle",
          x_channel: "142Nd_CD3",
          y_channel: "151Eu_CD19",
          vertices: [[1, 2], [3, 4]],
          color: "#e41a1c",
          label_offset: null,
        },
      },
      // jsonlite auto-unboxes one-item character vectors.
      gate_order: "gate-1",
      populations: {
        root: {
          population_id: "root",
          name: "All Events",
          gate_refs: [],
          gate_logic: "and",
          parent_id: null,
          children: "child",
          event_count: 3,
          percent_of_parent: 100,
        },
        child: {
          population_id: "child",
          name: "CD3+",
          gate_refs: { gate_id: "gate-1", include: true },
          gate_logic: "and",
          parent_id: "root",
          children: [],
          event_count: 2,
          percent_of_parent: 66.7,
        },
      },
      root_population_id: "root",
      gate_value_space: "display",
      global_scale_ranges: {
        "142Nd_CD3": [0, 8],
        "151Eu_CD19": [0, 7],
      },
      saved_at: "2026-07-25 12:00:00",
    }),
  };
}

describe("readHostedWorkspace", () => {
  it("normalizes legacy R scalar arrays and binds the graph to hosted samples", async () => {
    const restored = await readHostedWorkspace(legacyEnvelope(), dataset);

    expect(restored.sourceGateSpace).toBe("display");
    expect(restored.workspace.samples.map(({ sampleId }) => sampleId)).toEqual([
      "sce:sample-0",
      "sce:sample-1",
    ]);
    expect(restored.workspace.gating.gate_order).toEqual(["gate-1"]);
    expect(restored.workspace.gating.populations.root.children).toEqual(["child"]);
    expect(restored.workspace.gating.populations.child.gate_refs).toEqual([
      { gate_id: "gate-1", include: true },
    ]);
    expect(restored.workspace.scales.globalScales["142Nd_CD3"]).toEqual([0, 8]);
  });

  it("leaves matching CyTOF display-space gate coordinates unchanged", async () => {
    const restored = await readHostedWorkspace(legacyEnvelope(), dataset);
    const sample = {
      gatingSpace: "display",
    } as Parameters<typeof convertHostedGateSpace>[1];

    expect(convertHostedGateSpace(
      restored.workspace,
      sample,
      restored.sourceGateSpace,
    )).toBe(restored.workspace);
  });
});
