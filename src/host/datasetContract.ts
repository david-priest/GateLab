export const GATELAB_DATASET_CONTRACT_VERSION = 1 as const;

export type GateLabInstrument = "flow" | "cytof" | "unknown";
export type GateLabAssayRole =
  | "counts"
  | "transformed"
  | "compensated"
  | "other";
export type GateLabAssayCoordinateSpace = "linear" | "display";
export type GateLabHostScalar = string | number | boolean | null;

export interface GateLabHostChannelDescriptor {
  /** Stable channel key used by gates and assay payloads. */
  id: string;
  /** Human-readable marker/channel label. */
  label: string;
  /** Host-persisted display override, otherwise the UI falls back to $PnS/label. */
  displayLabel?: string;
  /** Original FCS $PnN identity when available. */
  pnn?: string;
  /** Original FCS $PnS marker description when available. */
  pns?: string;
}

export interface GateLabHostAssayDescriptor {
  id: string;
  label: string;
  role: GateLabAssayRole;
  /**
   * Linear assays can be consumed by GateLab's instrument transforms. Display
   * assays are already transformed and must never be transformed a second time.
   */
  coordinateSpace: GateLabAssayCoordinateSpace;
  /**
   * Monotonic revision supplied by the host. A changed revision invalidates
   * cached coordinates without requiring a new dataset identity.
   */
  revision: number;
  encoding: "channel-major-float32-le";
}

export interface GateLabHostCompensationMatrixDescriptor {
  /** Matrix semantics; source channels are rows and receiver channels are columns. */
  kind: "flow-spillover" | "cytof-spillover";
  /** Human-readable provenance shown in the compensation import/common path. */
  name: string;
  sourceChannels: readonly string[];
  receiverChannels: readonly string[];
  matrix: readonly (readonly number[])[];
}

export interface GateLabHostSampleDescriptor {
  id: string;
  label: string;
  eventCount: number;
  metadata: Readonly<Record<string, GateLabHostScalar>>;
  /** Byte length of this sample's payload for any assay in the dataset. */
  assayByteLength: number;
  /**
   * Zero-based original SCE column index for every event in this sample. This
   * maps browser-side masks back to colData without changing SCE event order.
   */
  eventIndexEncoding: "uint32-le";
  eventIndexByteLength: number;
}

export interface GateLabHostDatasetDescriptor {
  contractVersion: typeof GATELAB_DATASET_CONTRACT_VERSION;
  id: string;
  label: string;
  instrument: GateLabInstrument;
  eventCount: number;
  channels: readonly GateLabHostChannelDescriptor[];
  assays: readonly GateLabHostAssayDescriptor[];
  defaultAssayId: string;
  samples: readonly GateLabHostSampleDescriptor[];
  /** Optional matrix already stored by the host, without implying it was applied. */
  compensationMatrix?: GateLabHostCompensationMatrixDescriptor;
  /** Existing SCE colData names, used to surface overwrite collisions. */
  colDataColumns?: readonly string[];
  /** Monotonic revision guarding explicit SCE rowData panel writes. */
  rowDataRevision?: number;
}

export interface GateLabHostDatasetPort {
  listDatasets(): Promise<readonly GateLabHostDatasetDescriptor[]>;
  readAssay(
    datasetId: string,
    sampleId: string,
    assayId: string,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
  readEventIndex(
    datasetId: string,
    sampleId: string,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer>;
}

function isNativeLittleEndian(): boolean {
  const word = new Uint16Array([0x00ff]);
  return new Uint8Array(word.buffer)[0] === 0xff;
}

function assertByteLength(
  actual: number,
  itemCount: number,
  bytesPerItem: number,
  label: string,
): void {
  const expected = itemCount * bytesPerItem;
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || actual !== expected) {
    throw new Error(
      `${label} payload has ${actual} bytes; expected ${expected}.`,
    );
  }
}

/**
 * Decode R's channel-major Float32 assay stream.
 *
 * On ordinary little-endian browsers every channel is a zero-copy view into
 * the fetched ArrayBuffer. The uncommon big-endian fallback preserves the
 * contract by decoding through DataView.
 */
export function decodeChannelMajorFloat32(
  payload: ArrayBuffer,
  channelCount: number,
  eventCount: number,
): Float32Array[] {
  const itemCount = channelCount * eventCount;
  assertByteLength(payload.byteLength, itemCount, Float32Array.BYTES_PER_ELEMENT, "Assay");

  if (isNativeLittleEndian()) {
    const values = new Float32Array(payload);
    return Array.from(
      { length: channelCount },
      (_, channelIndex) => values.subarray(
        channelIndex * eventCount,
        (channelIndex + 1) * eventCount,
      ),
    );
  }

  const view = new DataView(payload);
  return Array.from({ length: channelCount }, (_, channelIndex) => {
    const channel = new Float32Array(eventCount);
    const offset = channelIndex * eventCount;
    for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
      channel[eventIndex] = view.getFloat32(
        (offset + eventIndex) * Float32Array.BYTES_PER_ELEMENT,
        true,
      );
    }
    return channel;
  });
}

/** Decode a sample payload's zero-based original SCE column indices. */
export function decodeEventIndexUint32(
  payload: ArrayBuffer,
  eventCount: number,
): Uint32Array {
  assertByteLength(
    payload.byteLength,
    eventCount,
    Uint32Array.BYTES_PER_ELEMENT,
    "Event-index",
  );

  if (isNativeLittleEndian()) return new Uint32Array(payload);

  const view = new DataView(payload);
  const result = new Uint32Array(eventCount);
  for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
    result[eventIndex] = view.getUint32(
      eventIndex * Uint32Array.BYTES_PER_ELEMENT,
      true,
    );
  }
  return result;
}
