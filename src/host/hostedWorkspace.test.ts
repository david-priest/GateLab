import type { GateLabHostDatasetDescriptor } from "./datasetContract";
import {
  convertHostedGateSpace,
  readHostedWorkspace,
} from "./hostedWorkspace";
import type { GateLabHostWorkspaceEnvelope } from "./workspaceContract";
import { stampHostedWorkspace } from "../engine/workspaceFeatures";

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

// A workspace holding a gate on FlowJo's grid is saved to the SCE as a file is, version 4 with its
// features, so a GateLab that predates the grid refuses it by its version; this build reads it back.
describe("readHostedWorkspace and a version 4 workspace", () => {
  it("reads the SCE's copy of a workspace holding a grid gate, and refuses a feature it does not have", async () => {
    const legacy = await readHostedWorkspace(legacyEnvelope(), dataset);
    const grid = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } } as const;
    const gate = {
      gate_id: "gate-1", name: "CD3 positive", gate_type: "polygon" as const, x_channel: "142Nd_CD3", y_channel: "151Eu_CD19",
      vertices: [[10, 20], [200, 20], [100, 250]] as [number, number][], color: "#e41a1c", label_offset: null,
      space: "display" as const, transforms: { "142Nd_CD3": grid, "151Eu_CD19": grid },
    };
    const ws = { ...legacy.workspace, gating: { ...legacy.workspace.gating, gates: { "gate-1": gate } } };
    const hosted = JSON.parse(JSON.stringify(stampHostedWorkspace(ws)));
    expect(hosted.version).toBe(4);
    expect(hosted.requiredFeatures).toEqual(["flowjo-grid"]);
    const envelope = (json: unknown): GateLabHostWorkspaceEnvelope => ({
      contractVersion: 1, datasetId: "sce", sourceFormat: "gatelab-workspace", revision: 1, workspaceJson: JSON.stringify(json),
    });
    const restored = await readHostedWorkspace(envelope(hosted), dataset);
    expect(restored.workspace.version).toBe(2);
    expect(restored.workspace.gating.gates["gate-1"]).toEqual(gate);
    await expect(readHostedWorkspace(envelope({ ...hosted, requiredFeatures: ["something-later"] }), dataset)).rejects.toThrow(/needs something-later/);
  });
});

// The legacy converter moves the coordinates of a gate saved before gates stated their own space.
// A gate that states it (a FlowJo grid gate among them, its vertices on channels) is evaluated in
// that space whatever the sample's, so moving it would put its vertices somewhere else entirely.
describe("convertHostedGateSpace and a gate that states its own space", () => {
  it("moves a legacy gate and leaves one that states its space, a FlowJo grid gate included", async () => {
    const restored = await readHostedWorkspace(legacyEnvelope(), dataset);
    const grid = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } } as const;
    const legacy = restored.workspace.gating.gates["gate-1"];
    const stated = { ...legacy, gate_id: "gate-2", space: "display" as const, transforms: { "142Nd_CD3": grid, "151Eu_CD19": grid } };
    const workspace = {
      ...restored.workspace,
      gating: { ...restored.workspace.gating, gates: { ...restored.workspace.gating.gates, "gate-2": stated }, gate_order: ["gate-1", "gate-2"] },
    };
    const sample = {
      gatingSpace: "raw",
      displayToGating: (_channel: string, v: number) => v * 10,
      rawToDisplay: (_channel: string, v: number) => v / 10,
    } as unknown as Parameters<typeof convertHostedGateSpace>[1];
    const converted = convertHostedGateSpace(workspace, sample, "display");
    expect(converted.gating.gates["gate-2"]).toEqual(stated);
    const moved = (converted.gating.gates as Record<string, unknown>)["gate-1"] as { vertices: [number, number][] };
    expect(moved.vertices).toEqual((legacy as { vertices: [number, number][] }).vertices.map(([x, y]) => [x * 10, y * 10]));
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

  it("keeps a rectangle's edge rule, and states the closed rule of a rectangle stored without one", async () => {
    // models.ts, RectangleBounds: a rectangle GateLabR stored before rules existed was evaluated
    // closed, by GateLab and by GateLabR's own engine, so it stays closed and now says so.
    const halfOpen = await readHostedWorkspace(envelopeWithGate({ bounds: "half-open" }), dataset);
    expect((restoredGate(halfOpen.workspace) as { bounds?: string }).bounds).toBe("half-open");
    const closed = await readHostedWorkspace(envelopeWithGate({ bounds: "closed" }), dataset);
    expect((restoredGate(closed.workspace) as { bounds?: string }).bounds).toBe("closed");
    const plain = await readHostedWorkspace(legacyEnvelope(), dataset);
    expect((restoredGate(plain.workspace) as { bounds?: string }).bounds).toBe("closed");
    await expect(readHostedWorkspace(envelopeWithGate({ bounds: "open" }), dataset)).rejects.toThrow(/bounds/);
  });

  // FlowJo's gate grid (engine/flowjoGrid.ts) and FlowJo's biex table travel through the R host
  // like any other gate space: the grid spec whole, its axis object included, FlowJo's raw vertices
  // beside a grid polygon, the axes FlowJo saved beside a rule-imported rectangle, and a biex
  // spec's table resolution, whose absence means the older table.
  it("keeps a FlowJo grid polygon, FlowJo's raw vertices, a rectangle's FlowJo axes and a biex table", async () => {
    const grid = { kind: "flowjoChannels", channels: 256, axis: { kind: "biex", maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -10, channelRange: 256 } };
    const linearGrid = { kind: "flowjoChannels", channels: 256, axis: { kind: "linear", minRange: 0, maxRange: 262144 } };
    const polygon = await readHostedWorkspace(envelopeWithGate({
      gate_type: "polygon",
      vertices: [[10, 20], [200, 20], [100, 300]],
      space: "display",
      transforms: { "142Nd_CD3": grid, "151Eu_CD19": linearGrid },
      flowjo_vertices: [[-40, 20000], [150000, 20000], [900, 3e5]],
    }), dataset);
    const kept = restoredGate(polygon.workspace) as Record<string, unknown>;
    expect(kept.transforms).toEqual({ "142Nd_CD3": grid, "151Eu_CD19": linearGrid });
    const panel = await readHostedWorkspace(envelopeWithGate({
      gate_type: "polygon", vertices: [[10, 20], [200, 20], [100, 300]], flowjo_polygon: { quadId: 1, gateResolution: null },
    }), dataset);
    expect((restoredGate(panel.workspace) as Record<string, unknown>).flowjo_polygon).toEqual({ quadId: 1, gateResolution: null });
    expect(kept.flowjo_vertices).toEqual([[-40, 20000], [150000, 20000], [900, 3e5]]);

    const table = await readHostedWorkspace(
      envelopeWithGate({
        space: "display", transforms: { "142Nd_CD3": { ...BIEX, tableChannels: 4096 } }, flowjo_axes: { "151Eu_CD19": grid.axis },
        flowjo_bounds: { "151Eu_CD19": [-232.5, null] },
      }),
      dataset,
    );
    const rect = restoredGate(table.workspace) as Record<string, unknown>;
    expect(rect.transforms).toEqual({ "142Nd_CD3": { ...BIEX, tableChannels: 4096 } });
    expect(rect.flowjo_axes).toEqual({ "151Eu_CD19": grid.axis });
    // The bounds FlowJo saved where its rule opened one; export-only, so a malformed set is dropped.
    expect(rect.flowjo_bounds).toEqual({ "151Eu_CD19": [-232.5, null] });
    const malformed = await readHostedWorkspace(envelopeWithGate({ flowjo_bounds: { "151Eu_CD19": [-232.5] } }), dataset);
    expect((restoredGate(malformed.workspace) as Record<string, unknown>).flowjo_bounds).toBeUndefined();

    await expect(readHostedWorkspace(envelopeWithGate({
      space: "display", transforms: { "142Nd_CD3": { kind: "flowjoChannels", channels: 256, axis: { kind: "biex" } } },
    }), dataset)).rejects.toThrow(/invalid transform/);
    await expect(readHostedWorkspace(envelopeWithGate({
      space: "display", transforms: { "142Nd_CD3": { ...BIEX, tableChannels: 1.5 } },
    }), dataset)).rejects.toThrow(/invalid transform/);
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

  // A Gating-ML import holds Gating-ML's own flog (`standard`) and a transformation's boundMin
  // and boundMax (`bounds`) on the gate's transforms. Dropped on the way back from the SCE, the
  // flog gate is read with GateLab's older floor and the bounded one without its clamp: the same
  // coordinates then select other events.
  it("keeps a standard flog and a transformation's bounds", async () => {
    const flog = { kind: "flog", T: 262144, M: 4.5, standard: true, bounds: { min: 0.1 } };
    const asinh = { kind: "asinh", cofactor: 5, bounds: { min: -0.5, max: 7 } };
    const restored = await readHostedWorkspace(
      envelopeWithGate({ space: "display", transforms: { "142Nd_CD3": flog, "151Eu_CD19": asinh } }),
      dataset,
    );
    const gate = restoredGate(restored.workspace);

    expect(gate.transforms?.["142Nd_CD3"]).toEqual(flog);
    expect(gate.transforms?.["151Eu_CD19"]).toEqual(asinh);
  });

  it("keeps an older flog without `standard`, and refuses a malformed standard flag or bound", async () => {
    const older = { kind: "flog", T: 262144, M: 4.5 };
    const restored = await readHostedWorkspace(
      envelopeWithGate({ space: "display", transforms: { "142Nd_CD3": older } }),
      dataset,
    );
    expect(restoredGate(restored.workspace).transforms?.["142Nd_CD3"]).toEqual(older);

    await expect(readHostedWorkspace(envelopeWithGate({
      space: "display", transforms: { "142Nd_CD3": { ...older, standard: "yes" } },
    }), dataset)).rejects.toThrow(/transform/i);
    await expect(readHostedWorkspace(envelopeWithGate({
      space: "display", transforms: { "142Nd_CD3": { ...older, bounds: { min: "low" } } },
    }), dataset)).rejects.toThrow(/transform/i);
  });
});
