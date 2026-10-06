import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostDatasetDescriptor,
  type GateLabHostDatasetPort,
} from "./datasetContract";
import { HostedAssayNotArcsinhError, chooseHostedAssay, drawableHostedAssay, loadHostedDataset } from "./hostedSample";
import { pairFile } from "../engine/fileIdentity";

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
      displayCofactor: 5,
      displayCofactorStated: true,
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
  // The host's default assay is drawn. This dataset's is exprs, in display space: it is drawn as
  // stored, every channel through the identity, and the linear assay is drawn when asked for.
  it("draws the host's default assay as stored when it is in display space, and the linear assay when asked", async () => {
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

    const [asStored] = await loadHostedDataset(port, dataset);
    expect(readAssay).toHaveBeenLastCalledWith("sce", "sample-0", "exprs", undefined);
    expect(asStored.assayId).toBe("exprs");
    expect(asStored.sample.hostedAssayId).toBe("exprs");
    expect(asStored.sample.hostedAssaySpace).toBe("display");
    // The stored asinh values are put back to nominal linear ones and drawn through arcsinh 5
    // again: the plot shows the stored value, and a gate drawn on counts, whose vertices record
    // arcsinh 5, is evaluated in the same space. The cofactor is the assay's, not a setting.
    expect(asStored.sample.transformSpec("CD19")).toEqual({ kind: "asinh", cofactor: 5 });
    asStored.sample.setCytofCofactor(10);
    expect(asStored.sample.arcsinhCofactor).toBe(5);
    const nominal = asStored.sample.originalColumnData(1);
    expect(nominal[0] / (5 * Math.sinh(20))).toBeCloseTo(1, 5); // Float32 at 1e9: relative, not absolute
    expect(asStored.sample.rawToDisplay("CD19", nominal[0])).toBeCloseTo(20, 4);

    const [loaded] = await loadHostedDataset(port, dataset, undefined, "counts");

    expect(readAssay).toHaveBeenLastCalledWith(
      "sce",
      "sample-0",
      "counts",
      undefined,
    );
    expect(loaded.assayId).toBe("counts");
    expect(loaded.sample.hostedAssayId).toBe("counts");
    expect(loaded.sample.hostedAssaySpace).toBe("linear");
    expect(loaded.sample.transformSpec("CD19")).toEqual({ kind: "asinh", cofactor: 5 });
    // One assay's axis frame is not the other's.
    expect(loaded.sample.workspaceScaleContextKey).not.toBe(asStored.sample.workspaceScaleContextKey);
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

  // A hosted sample's cell count is not an acquisition's $TOT. Written as one, it contradicted a
  // FlowJo sample of the same name recording the acquisition's count, and the .wsp import onto
  // it said "No sample in this workspace is ...".
  it("claims no acquisition identity it does not have", async () => {
    const port: GateLabHostDatasetPort = {
      async listDatasets() { return [dataset]; },
      async readAssay() { return bufferOf(new Float32Array([5, 10, 15, 20, 25, 30])); },
      async readEventIndex() { return bufferOf(new Uint32Array([4, 7, 9])); },
    };
    const [loaded] = await loadHostedDataset(port, dataset);
    expect(loaded.sample.fcs.nEvents).toBe(3);
    expect(loaded.sample.fcs.keywords["$TOT"]).toBeUndefined();
    const workspaceSample = { names: ["Donor A"], recorded: { $TOT: "9387", $BTIM: "10:48:03" } };
    const paired = pairFile({ name: "Donor A", keywords: loaded.sample.fcs.keywords }, [workspaceSample], (s) => s.names, (s) => s.recorded);
    expect(paired.kind).toBe("own");
  });

  it("draws a transformed-only dataset as stored, never through GateLab's transforms, and names an assay it lacks", async () => {
    const transformedOnly: GateLabHostDatasetDescriptor = {
      ...dataset,
      assays: [dataset.assays[0]],
    };
    const port: GateLabHostDatasetPort = {
      async listDatasets() {
        return [transformedOnly];
      },
      async readAssay() {
        return bufferOf(new Float32Array([1.5, 2.5, 3.5, 0.5, 4.5, 5.5]));
      },
      async readEventIndex() {
        return bufferOf(new Uint32Array([0, 1, 2]));
      },
    };

    const [loaded] = await loadHostedDataset(port, transformedOnly);
    expect(loaded.sample.transformSpec("142Nd_CD3")).toEqual({ kind: "asinh", cofactor: 5 });
    const shown = Array.from(loaded.sample.originalColumnData(0)).map((v) => loaded.sample.rawToDisplay("142Nd_CD3", v));
    expect(shown.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1.5, 2.5, 3.5]);
    await expect(loadHostedDataset(port, transformedOnly, undefined, "counts"))
      .rejects.toThrow("has no assay 'counts'");

    // A cofactor the host states is the one used; and a flow dataset's display assay, whose
    // transform the app cannot invert, is drawn through the identity in its own units.
    const [atTen] = await loadHostedDataset(port, { ...transformedOnly, assays: [{ ...transformedOnly.assays[0], displayCofactor: 10 }] });
    expect(atTen.sample.transformSpec("142Nd_CD3")).toEqual({ kind: "asinh", cofactor: 10 });
    expect(atTen.sample.rawToDisplay("142Nd_CD3", atTen.sample.originalColumnData(0)[1])).toBeCloseTo(2.5, 4);
    // Under flow the fluorescence channels go on arcsinh at the cofactor, so the plot shows the
    // stored values there too, and gates are in nominal linear units, as gates on counts are.
    const [flow] = await loadHostedDataset(port, { ...transformedOnly, instrument: "flow" });
    expect(flow.sample.hostedAssaySpace).toBe("display");
    expect(flow.sample.transformSpec("142Nd_CD3")).toEqual({ kind: "asinh", cofactor: 5 });
    expect(flow.sample.rawToDisplay("142Nd_CD3", flow.sample.originalColumnData(0)[0])).toBeCloseTo(1.5, 4);
    // A display assay whose arcsinh the host does not state cannot be drawn: the default falls
    // to the linear assay and naming it is refused.
    const noCofactor: GateLabHostDatasetDescriptor = {
      ...dataset,
      assays: [{ ...dataset.assays[0], displayCofactor: undefined, displayCofactorStated: undefined }, dataset.assays[1]],
    };
    expect(drawableHostedAssay(noCofactor.assays[0])).toBe(false);
    expect(chooseHostedAssay(noCofactor).id).toBe("counts");
    expect(() => chooseHostedAssay(noCofactor, "exprs")).toThrow("states no arcsinh cofactor");
    // Values no arcsinh gives (counts under a display name) are refused, naming the override.
    const big: GateLabHostDatasetPort = {
      ...port,
      async readAssay() { return bufferOf(new Float32Array([1, 2, 3, 100, 200, 300])); },
    };
    await expect(loadHostedDataset(big, transformedOnly)).rejects.toThrow(HostedAssayNotArcsinhError);
    await expect(loadHostedDataset(big, transformedOnly)).rejects.toThrow("gatelabr_assay_coordinate_spaces");
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

    const [loaded] = await loadHostedDataset(port, flowDataset, undefined, "counts");

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
