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

describe("ellipse gates through the legacy GateLabR path", () => {
  function ellipseEnvelope(): GateLabHostWorkspaceEnvelope {
    const envelope = legacyEnvelope();
    const parsed = JSON.parse(envelope.workspaceJson) as {
      gates: Record<string, Record<string, unknown>>;
    };
    parsed.gates["gate-1"] = {
      gate_id: "gate-1",
      name: "Blasts",
      gate_type: "ellipse",
      x_channel: "142Nd_CD3",
      y_channel: "151Eu_CD19",
      mean: [3, 4],
      covariance: [[4, 0], [0, 1]],
      distance_square: 1,
      // The R mirror also writes a sampled boundary. Reading it back must NOT rebuild the gate
      // from those points, or the covariance form silently becomes a fixed 64-gon.
      vertices: [[5, 4], [3, 5], [1, 4], [3, 3]],
      color: "#377eb8",
      label_offset: null,
    };
    return { ...envelope, workspaceJson: JSON.stringify(parsed) };
  }

  it("restores the covariance form rather than the sampled boundary", async () => {
    const restored = await readHostedWorkspace(ellipseEnvelope(), dataset);
    const gate = restored.workspace.gating.gates["gate-1"] as unknown as {
      gate_type: string;
      mean: [number, number];
      covariance: [[number, number], [number, number]];
      distance_square: number;
      vertices?: unknown;
    };

    expect(gate.gate_type).toBe("ellipse");
    expect(gate.mean).toEqual([3, 4]);
    expect(gate.covariance).toEqual([[4, 0], [0, 1]]);
    expect(gate.distance_square).toBe(1);
    expect(gate.vertices).toBeUndefined();
  });

  it("rejects an ellipse whose covariance is unusable rather than guessing one", async () => {
    const envelope = ellipseEnvelope();
    const parsed = JSON.parse(envelope.workspaceJson) as {
      gates: Record<string, Record<string, unknown>>;
    };
    parsed.gates["gate-1"].covariance = [[4, 0]];
    await expect(readHostedWorkspace(
      { ...envelope, workspaceJson: JSON.stringify(parsed) },
      dataset,
    )).rejects.toThrow(/covariance/i);
  });
});

// GateLabR stores the canonical workspace JSON verbatim, so a gate's space and the transforms it
// was drawn under survive the SCE untouched. Dropping them while reading the JSON back re-reads
// the gate in the sample's default space: the same coordinates then select a different event set,
// with nothing on screen to say so. An ellipse is always created in display space with its axis
// transforms captured, so it is hit systematically, but the fields belong to every gate type.
describe("gate space and transforms through the legacy GateLabR path", () => {
  const BIEX = {
    kind: "biex",
    maxValue: 262144,
    pos: 4.5,
    neg: 0,
    widthBasis: -10,
    channelRange: 4096,
  };

  function envelopeWithGate(gate: Record<string, unknown>): GateLabHostWorkspaceEnvelope {
    const envelope = legacyEnvelope();
    const parsed = JSON.parse(envelope.workspaceJson) as {
      gates: Record<string, Record<string, unknown>>;
    };
    parsed.gates["gate-1"] = { ...parsed.gates["gate-1"], ...gate };
    return { ...envelope, workspaceJson: JSON.stringify(parsed) };
  }

  function restoredGate(workspace: { gating: { gates: Record<string, unknown> } }) {
    return workspace.gating.gates["gate-1"] as {
      space?: string;
      transforms?: Record<string, { kind: string; widthBasis?: number }>;
    };
  }

  it("keeps a display-space ellipse's space and axis transforms", async () => {
    const restored = await readHostedWorkspace(envelopeWithGate({
      gate_type: "ellipse",
      mean: [3, 4],
      covariance: [[4, 0], [0, 1]],
      distance_square: 1,
      vertices: undefined,
      space: "display",
      transforms: { "142Nd_CD3": BIEX, "151Eu_CD19": { kind: "asinh", cofactor: 5 } },
    }), dataset);
    const gate = restoredGate(restored.workspace);

    expect(gate.space).toBe("display");
    expect(gate.transforms?.["142Nd_CD3"]).toEqual(BIEX);
    expect(gate.transforms?.["151Eu_CD19"]).toEqual({ kind: "asinh", cofactor: 5 });
  });

  it("keeps the space on a rectangle too, not only on an ellipse", async () => {
    const restored = await readHostedWorkspace(
      envelopeWithGate({ space: "display", transforms: { "142Nd_CD3": BIEX } }),
      dataset,
    );
    const gate = restoredGate(restored.workspace);

    expect(gate.space).toBe("display");
    expect(gate.transforms?.["142Nd_CD3"]).toEqual(BIEX);
  });

  it("leaves both fields absent when the stored gate predates them", async () => {
    const restored = await readHostedWorkspace(legacyEnvelope(), dataset);
    const gate = restoredGate(restored.workspace);

    expect(gate.space).toBeUndefined();
    expect(gate.transforms).toBeUndefined();
  });

  it("refuses a malformed transform rather than restoring the gate without one", async () => {
    await expect(readHostedWorkspace(envelopeWithGate({
      space: "display",
      // widthBasis missing: honouring this as though the axis were untransformed is exactly the
      // silent space mismatch this guards against.
      transforms: { "142Nd_CD3": { ...BIEX, widthBasis: undefined } },
    }), dataset)).rejects.toThrow(/transform/i);
  });

  it("refuses a gate space it does not understand", async () => {
    await expect(readHostedWorkspace(
      envelopeWithGate({ space: "screen" }),
      dataset,
    )).rejects.toThrow(/gate space/i);
  });
});
