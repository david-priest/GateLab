export const GATELAB_HOST_COLDATA_CONTRACT_VERSION = 1 as const;

export interface GateLabHostPopulationSampleMask {
  sampleId: string;
  eventCount: number;
  /** LSB-first packed membership bits, then base64 encoded. */
  membershipBitsBase64: string;
}

export interface GateLabHostPopulationColumn {
  populationId: string;
  populationName: string;
  columnName: string;
  inLabel: string;
  outLabel: string;
  sampleMasks: readonly GateLabHostPopulationSampleMask[];
}

export interface GateLabHostColDataWriteRequest {
  contractVersion: typeof GATELAB_HOST_COLDATA_CONTRACT_VERSION;
  datasetId: string;
  /** Memberships must correspond to this exact persisted gating revision. */
  workspaceRevision: number;
  overwrite: boolean;
  columns: readonly GateLabHostPopulationColumn[];
}

export interface GateLabHostColDataWriteResult {
  columns: readonly Readonly<{
    columnName: string;
    populationId: string;
    memberCount: number;
  }>[];
}

export interface GateLabHostCategoricalSampleValues {
  sampleId: string;
  eventCount: number;
  /**
   * One unsigned byte per event, base64 encoded. Values index `levels`;
   * 255 is reserved for a missing value.
   */
  codesBase64?: string;
  /** Compact alternative when every event in a sample has the same value. */
  constantCode?: number;
}

export interface GateLabHostCategoricalColumn {
  columnName: string;
  levels: readonly string[];
  sampleValues: readonly GateLabHostCategoricalSampleValues[];
}

export interface GateLabHostCategoricalWriteRequest {
  contractVersion: typeof GATELAB_HOST_COLDATA_CONTRACT_VERSION;
  datasetId: string;
  overwrite: boolean;
  columns: readonly GateLabHostCategoricalColumn[];
}

export interface GateLabHostCategoricalWriteResult {
  columns: readonly Readonly<{
    columnName: string;
    valueCounts: Readonly<Record<string, number>>;
    missingCount: number;
  }>[];
}

export interface GateLabHostColDataPort {
  writeColumns(
    request: GateLabHostColDataWriteRequest,
  ): Promise<GateLabHostColDataWriteResult>;
  writeCategoricalColumns(
    request: GateLabHostCategoricalWriteRequest,
  ): Promise<GateLabHostCategoricalWriteResult>;
}

/** Pack a full-data 0/1 mask into an LSB-first bitset for efficient R transfer. */
export function packMembershipBits(mask: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(mask.length / 8));
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] !== 0) {
      packed[index >> 3] |= 1 << (index & 7);
    }
  }
  return packed;
}
