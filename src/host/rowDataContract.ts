export const GATELAB_HOST_ROWDATA_CONTRACT_VERSION = 1 as const;

export interface GateLabHostChannelLabelChange {
  /** Stable GateLab/SCE channel identity from the dataset descriptor. */
  channelId: string;
  /** Empty string removes GateLabR's explicit display-label override. */
  label: string;
}

export interface GateLabHostRowDataWriteRequest {
  contractVersion: typeof GATELAB_HOST_ROWDATA_CONTRACT_VERSION;
  datasetId: string;
  /** Reject a write made against an older rowData view. */
  expectedRevision: number;
  changes: readonly GateLabHostChannelLabelChange[];
}

export interface GateLabHostRowDataWriteResult {
  revision: number;
  changedChannelIds: readonly string[];
}

export interface GateLabHostRowDataPort {
  writeChannelLabels(
    request: GateLabHostRowDataWriteRequest,
  ): Promise<GateLabHostRowDataWriteResult>;
}
