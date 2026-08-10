import type { FcsChannel, FcsFile, SpilloverMatrix } from "../engine/fcs";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import { Sample } from "../engine/sample";
import { detectInstrumentType } from "../engine/transforms";
import {
  GATELAB_DATASET_CONTRACT_VERSION,
  decodeChannelMajorFloat32,
  decodeEventIndexUint32,
  type GateLabHostAssayDescriptor,
  type GateLabHostDatasetDescriptor,
  type GateLabHostDatasetPort,
  type GateLabHostSampleDescriptor,
  type GateLabHostScalar,
} from "./datasetContract";

export interface GateLabHostedSample {
  datasetId: string;
  sampleId: string;
  name: string;
  assayId: string;
  assayRevision: number;
  sample: Sample;
  eventIndex: Uint32Array;
  metadata: Readonly<Record<string, GateLabHostScalar>>;
}

function chooseLinearAssay(
  dataset: GateLabHostDatasetDescriptor,
): GateLabHostAssayDescriptor {
  const defaultAssay = dataset.assays.find(
    ({ id }) => id === dataset.defaultAssayId,
  );
  const counts = dataset.assays.find(
    ({ role, coordinateSpace }) =>
      role === "counts" && coordinateSpace === "linear",
  );
  const assay = counts ??
    (defaultAssay?.coordinateSpace === "linear" ? defaultAssay : undefined) ??
    dataset.assays.find(({ coordinateSpace }) => coordinateSpace === "linear");
  if (!assay) {
    throw new Error(
      `Dataset '${dataset.label}' has no linear assay. GateLab will not ` +
      "transform an already transformed SCE assay a second time.",
    );
  }
  return assay;
}

function finiteRange(values: Float32Array): number {
  let maximum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value) && value > maximum) maximum = value;
  }
  return maximum;
}

function fcsChannels(
  dataset: GateLabHostDatasetDescriptor,
  columns: readonly Float32Array[],
): FcsChannel[] {
  return dataset.channels.map((channel, index) => {
    const name = channel.pnn?.trim() || channel.id;
    const label = channel.pns?.trim() ||
      (channel.label.trim() !== name ? channel.label.trim() : "");
    return {
      index,
      name,
      marker: label || null,
      bits: 32,
      range: finiteRange(columns[index]),
      appKey: channel.id,
      appLabel: channel.displayLabel?.trim() ||
        channel.pns?.trim() ||
        channel.label.trim() ||
        channel.id,
    };
  });
}

function hostedFcs(
  dataset: GateLabHostDatasetDescriptor,
  sampleDescriptor: GateLabHostSampleDescriptor,
  columns: Float32Array[],
): FcsFile {
  const channels = fcsChannels(dataset, columns);
  const detected = detectInstrumentType(
    channels.map(({ name, marker }) => marker || name),
  );
  const instrument = dataset.instrument === "unknown"
    ? detected
    : dataset.instrument;
  const keywords: Record<string, string> = {
    "$TOT": String(sampleDescriptor.eventCount),
    "$PAR": String(channels.length),
    "$DATATYPE": "F",
    "$BYTEORD": "1,2,3,4",
    "$SRC": sampleDescriptor.label,
  };
  channels.forEach((channel, index) => {
    keywords[`$P${index + 1}N`] = channel.name;
    if (channel.marker) keywords[`$P${index + 1}S`] = channel.marker;
    keywords[`$P${index + 1}B`] = "32";
    keywords[`$P${index + 1}R`] = String(channel.range);
  });
  const hostedMatrix = dataset.compensationMatrix;
  let spillover: SpilloverMatrix | null = null;
  if (hostedMatrix?.kind === "flow-spillover") {
    const validated = validateAndCanonicalizeCompensationMatrix(
      hostedMatrix,
      "flow-spillover",
    );
    if (validated.ok) {
      const receiverPositions = validated.value.sourceChannels.map(
        (channel) => validated.value.receiverChannels.indexOf(channel),
      );
      spillover = {
        channels: Array.from(validated.value.sourceChannels),
        matrix: validated.value.matrix.map((row) =>
          receiverPositions.map((receiverIndex) => row[receiverIndex])),
      };
    }
  }
  return {
    version: "SCE1.0",
    nEvents: sampleDescriptor.eventCount,
    channels,
    keywords,
    columns,
    spillover,
    instrument,
  };
}

/**
 * Materialise one SCE dataset as native GateLab Samples.
 *
 * Payloads are fetched one sample at a time, so GateLab never receives or
 * browser-splits one monolithic multi-sample SCE matrix.
 */
export async function loadHostedDataset(
  port: GateLabHostDatasetPort,
  dataset: GateLabHostDatasetDescriptor,
  signal?: AbortSignal,
): Promise<GateLabHostedSample[]> {
  if (dataset.contractVersion !== GATELAB_DATASET_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported dataset contract ${String(dataset.contractVersion)}.`,
    );
  }
  if (dataset.channels.length === 0) {
    throw new Error(`Dataset '${dataset.label}' has no channels.`);
  }
  const assay = chooseLinearAssay(dataset);

  return Promise.all(dataset.samples.map(async (sampleDescriptor) => {
    const [assayPayload, eventIndexPayload] = await Promise.all([
      port.readAssay(dataset.id, sampleDescriptor.id, assay.id, signal),
      port.readEventIndex(dataset.id, sampleDescriptor.id, signal),
    ]);
    const columns = decodeChannelMajorFloat32(
      assayPayload,
      dataset.channels.length,
      sampleDescriptor.eventCount,
    );
    const eventIndex = decodeEventIndexUint32(
      eventIndexPayload,
      sampleDescriptor.eventCount,
    );
    return {
      datasetId: dataset.id,
      sampleId: sampleDescriptor.id,
      name: sampleDescriptor.label,
      assayId: assay.id,
      assayRevision: assay.revision,
      sample: new Sample(hostedFcs(dataset, sampleDescriptor, columns)),
      eventIndex,
      metadata: sampleDescriptor.metadata,
    };
  }));
}
