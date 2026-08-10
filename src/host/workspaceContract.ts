export const GATELAB_HOST_WORKSPACE_CONTRACT_VERSION = 1 as const;

export type GateLabHostWorkspaceSource =
  | "gatelab-workspace"
  | "gatelabr-legacy";

/**
 * A workspace is small enough for Shiny's websocket, but it travels as an
 * explicit JSON string so R vector auto-unboxing cannot change one-item arrays
 * such as gate_order or population children.
 */
export interface GateLabHostWorkspaceEnvelope {
  contractVersion: typeof GATELAB_HOST_WORKSPACE_CONTRACT_VERSION;
  datasetId: string;
  sourceFormat: GateLabHostWorkspaceSource;
  /**
   * Monotonic host revision. Legacy GateLabR metadata starts at revision zero;
   * every successful React write increments it.
   */
  revision: number;
  workspaceJson: string;
}

export type GateLabHostWorkspaceWriteReason = "autosave" | "explicit";

export interface GateLabHostWorkspaceWriteRequest {
  datasetId: string;
  expectedRevision: number;
  clientRevision: number;
  reason: GateLabHostWorkspaceWriteReason;
  workspaceJson: string;
}

export interface GateLabHostWorkspaceWriteResult {
  revision: number;
  clientRevision: number;
  savedAt: string;
}

export interface GateLabHostWorkspacePort {
  readWorkspace(
    datasetId: string,
  ): Promise<GateLabHostWorkspaceEnvelope | null>;
  writeWorkspace(
    request: GateLabHostWorkspaceWriteRequest,
  ): Promise<GateLabHostWorkspaceWriteResult>;
}
