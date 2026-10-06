import type { FcsChannel, FcsFile, SpilloverMatrix } from "../engine/fcs";
import { validateAndCanonicalizeCompensationMatrix } from "../engine/compensationProfile";
import { Sample } from "../engine/sample";
import { isScatterChannel } from "../engine/transforms";
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

/** The dataset's linear assay: the role-counts one, else the default when linear, else any. */
export function linearHostedAssay(
  dataset: GateLabHostDatasetDescriptor,
): GateLabHostAssayDescriptor {
  return chooseLinearAssay(dataset);
}

/** Whether the dataset has a linear assay at all. */
export function hasLinearHostedAssay(dataset: GateLabHostDatasetDescriptor): boolean {
  return dataset.assays.some(({ coordinateSpace }) => coordinateSpace === "linear");
}

/**
 * Whether an assay can be drawn: a linear one always; a display one only when the host states
 * the arcsinh its values are in, since drawing it as stored means putting them back to linear
 * values through that arcsinh.
 */
export function drawableHostedAssay(assay: GateLabHostAssayDescriptor): boolean {
  return assay.coordinateSpace === "linear" ||
    (typeof assay.displayCofactor === "number" && Number.isFinite(assay.displayCofactor) && assay.displayCofactor > 0);
}

/** A display assay that holds values no arcsinh gives: it was declared display-space by its name. */
export class HostedAssayNotArcsinhError extends Error {}

/**
 * The assay the samples are drawn from: the one named, else the host's default when it can be
 * drawn (an SCE's `exprs` is drawn as stored), else the linear assay.
 */
export function chooseHostedAssay(
  dataset: GateLabHostDatasetDescriptor,
  assayId?: string | null,
): GateLabHostAssayDescriptor {
  if (assayId) {
    const named = dataset.assays.find(({ id }) => id === assayId);
    if (!named) {
      throw new Error(`Dataset '${dataset.label}' has no assay '${assayId}'.`);
    }
    if (!drawableHostedAssay(named)) {
      throw new Error(
        `'${assayId}' cannot be drawn: it is in display space and the host states no arcsinh cofactor for it.`,
      );
    }
    return named;
  }
  const preferred = dataset.assays.find(({ id }) => id === dataset.defaultAssayId);
  return preferred && drawableHostedAssay(preferred) ? preferred : chooseLinearAssay(dataset);
}

/**
 * A sample built from a display assay, drawn as stored: under mass cytometry the instrument
 * arcsinh at the cofactor does it; under flow every fluorescence channel is put on arcsinh at
 * the cofactor, scatter and QC channels keeping their own scales.
 */
function asStoredSample(sample: Sample, nominal: { cofactor: number } | null): Sample {
  if (!nominal || sample.instrument === "cytof") return sample;
  const keys = sample.channels
    .filter((channel) => !isScatterChannel(channel.key) && !isScatterChannel(channel.pnn))
    .map((channel) => channel.key);
  sample.applyFluorArcsinhKeys(keys);
  for (const key of keys) {
    const index = sample.index(key);
    if (index !== undefined) sample.setFluorCofactor(index, nominal.cofactor);
  }
  return sample;
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
  // No $TOT. A hosted sample is an SCE's cells, not an acquisition, and its cell count is not the
  // event count a cytometer recorded: set as $TOT, it read as the acquisition's own, so a .wsp
  // sample recording $TOT 9,387 "contradicted" a hosted sample of 9,100 cells of the same name
  // and its tree was refused. The count is nEvents.
  const keywords: Record<string, string> = {
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
  assayId?: string | null,
): Promise<GateLabHostedSample[]> {
  if (dataset.contractVersion !== GATELAB_DATASET_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported dataset contract ${String(dataset.contractVersion)}.`,
    );
  }
  if (dataset.channels.length === 0) {
    throw new Error(`Dataset '${dataset.label}' has no channels.`);
  }
  const assay = chooseHostedAssay(dataset, assayId);

  return Promise.all(dataset.samples.map(async (sampleDescriptor) => {
    const [assayPayload, eventIndexPayload] = await Promise.all([
      port.readAssay(dataset.id, sampleDescriptor.id, assay.id, signal),
      port.readEventIndex(dataset.id, sampleDescriptor.id, signal),
    ]);
    const stored = decodeChannelMajorFloat32(
      assayPayload,
      dataset.channels.length,
      sampleDescriptor.eventCount,
    );
    // A display assay holds asinh(linear / cofactor). It is put back to nominal linear values
    // here and drawn through an arcsinh at that cofactor, which shows the stored values exactly
    // and puts a gate drawn on it in the same space as one drawn on counts (a gate records the
    // transform its vertices are in, and is evaluated through it). Under mass cytometry that is
    // the instrument transform; under flow every fluorescence channel is set to arcsinh at the
    // cofactor below. The cofactor is the host's: chooseHostedAssay admits no display assay
    // without one.
    const nominal = assay.coordinateSpace === "display"
      ? { cofactor: assay.displayCofactor as number }
      : null;
    if (nominal) {
      // asinh of any count a cytometer records is below 20; a larger value says the assay is
      // not an arcsinh at all (counts under another name, a log, a score), and sinh of it
      // overflows to Infinity, which no gate holds.
      const largest = stored.reduce((max, column) => Math.max(max, finiteRange(column)), 0);
      if (largest > 30) {
        throw new HostedAssayNotArcsinhError(
          `'${assay.id}' is in display space by its name but holds values up to ${Math.round(largest).toLocaleString()}, ` +
          "which an arcsinh assay cannot. Declare its space in R: " +
          `metadata(sce)$gatelabr_assay_coordinate_spaces <- list(${assay.id} = "linear").`,
        );
      }
    }
    const columns = nominal
      ? stored.map((column) => Float32Array.from(column, (value) => nominal.cofactor * Math.sinh(value)))
      : stored;
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
      sample: asStoredSample(
        new Sample(hostedFcs(dataset, sampleDescriptor, columns), {
          ...(nominal ? { cytofCofactor: nominal.cofactor } : {}),
          hostedAssay: { id: assay.id, space: assay.coordinateSpace },
        }),
        nominal,
      ),
      eventIndex,
      metadata: sampleDescriptor.metadata,
    };
  }));
}
