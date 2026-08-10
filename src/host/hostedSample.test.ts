import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostDatasetDescriptor,
  type GateLabHostDatasetPort,
} from "./datasetContract";
import { loadHostedDataset } from "./hostedSample";

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(
    values.byteOffset,
    values.byteOffset + values.byteLength,
  ) as ArrayBuffer;
}

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
  id: "sce",
  label: "Test SCE",
  instrument: "cytof",
  eventCount: 3,
  channels: [
    { id: "142Nd_CD3", label: "142Nd_CD3", pnn: "Nd142Di", pns: "CD3" },
    { id: "CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
  ],
  assays: [
    {
      id: "exprs",
      label: "exprs",
      role: "transformed",
      coordinateSpace: "display",
      revision: 0,
      encoding: "channel-major-float32-le",
    },
    {
      id: "counts",
      label: "counts",
      role: "counts",
      coordinateSpace: "linear",
      revision: 2,
      encoding: "channel-major-float32-le",
    },
  ],
  defaultAssayId: "exprs",
  samples: [{
    id: "sample-0",
    label: "Donor A",
    eventCount: 3,
    metadata: { batch: "one", stimulated: false },
    assayByteLength: 24,
    eventIndexEncoding: "uint32-le",
    eventIndexByteLength: 12,
  }],
};

describe("loadHostedDataset", () => {
  it("loads the linear assay as a native Sample and retains SCE event indices", async () => {
    const readAssay = vi.fn(async () => bufferOf(new Float32Array([
      5, 10, 15,
      20, 25, 30,
    ])));
    const port: GateLabHostDatasetPort = {
      async listDatasets() {
        return [dataset];
      },
      readAssay,
      async readEventIndex() {
        return bufferOf(new Uint32Array([4, 7, 9]));
      },
    };

    const [loaded] = await loadHostedDataset(port, dataset);

    expect(readAssay).toHaveBeenCalledWith(
      "sce",
      "sample-0",
      "counts",
      undefined,
    );
    expect(loaded.assayId).toBe("counts");
    expect(loaded.assayRevision).toBe(2);
    expect(loaded.sample.instrument).toBe("cytof");
    expect(loaded.sample.fcs.nEvents).toBe(3);
    expect(loaded.sample.channelNames()).toEqual(["142Nd_CD3", "CD19"]);
    expect(loaded.sample.channelLabel(0)).toBe("CD3");
    expect(loaded.sample.channels[0].pnn).toBe("Nd142Di");
    expect(Array.from(loaded.sample.originalColumnData(0))).toEqual([5, 10, 15]);
    expect(Array.from(loaded.eventIndex)).toEqual([4, 7, 9]);
    expect(loaded.metadata).toEqual({ batch: "one", stimulated: false });
  });

  it("rejects transformed-only data rather than applying GateLab transforms twice", async () => {
    const transformedOnly: GateLabHostDatasetDescriptor = {
      ...dataset,
      assays: [dataset.assays[0]],
    };
    const port: GateLabHostDatasetPort = {
      async listDatasets() {
        return [transformedOnly];
      },
      async readAssay() {
        throw new Error("must not read");
      },
      async readEventIndex() {
        throw new Error("must not read");
      },
    };

    await expect(loadHostedDataset(port, transformedOnly))
      .rejects.toThrow("no linear assay");
  });

  it("maps a hosted Flow matrix onto exact PnN identities without changing assay values", async () => {
    const flowDataset: GateLabHostDatasetDescriptor = {
      ...dataset,
      instrument: "flow",
      channels: [
        { id: "cd3", label: "CD3", pnn: "FL1-A", pns: "CD3" },
        { id: "cd19", label: "CD19", pnn: "FL2-A", pns: "CD19" },
      ],
      compensationMatrix: {
        kind: "flow-spillover",
        name: "metadata(sce)$spillover_matrix",
        sourceChannels: ["FL1-A", "FL2-A"],
        receiverChannels: ["FL2-A", "FL1-A"],
        matrix: [
          [0.05, 1],
          [1, 0.02],
        ],
      },
    };
    const originalValues = new Float32Array([
      5, 10, 15,
      20, 25, 30,
    ]);
    const port: GateLabHostDatasetPort = {
      async listDatasets() {
        return [flowDataset];
      },
      async readAssay() {
        return bufferOf(originalValues);
      },
      async readEventIndex() {
        return bufferOf(new Uint32Array([0, 1, 2]));
      },
    };

    const [loaded] = await loadHostedDataset(port, flowDataset);

    expect(loaded.sample.spillover).toEqual({
      channels: ["cd3", "cd19"],
      matrix: [
        [1, 0.05],
        [0.02, 1],
      ],
    });
    expect(Array.from(loaded.sample.originalColumnData(0))).toEqual([5, 10, 15]);
    expect(Array.from(loaded.sample.originalColumnData(1))).toEqual([20, 25, 30]);
    expect(loaded.sample.activeLayer).toBe("original");
  });
});
