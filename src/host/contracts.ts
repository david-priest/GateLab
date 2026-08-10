import type { GateLabHostDatasetPort } from "./datasetContract";
import type { GateLabHostColDataPort } from "./colDataContract";
import type { GateLabHostCompensationPort } from "./compensationContract";
import type { GateLabHostRowDataPort } from "./rowDataContract";
import type { GateLabHostWorkspacePort } from "./workspaceContract";

export type GateLabHostKind = "browser" | "r-sce";

export const GATELAB_HOST_CONTRACT_VERSION = 1 as const;

/**
 * Host capabilities describe genuine product differences without forking the
 * GateLab UI. Components can progressively reveal SCE-specific controls while
 * retaining the same gating, plotting, population, and illustration surfaces.
 */
export interface GateLabHostCapabilities {
  dataSources: {
    fcsFiles: boolean;
    singleCellExperiment: boolean;
  };
  dataModel: {
    multipleAssays: boolean;
    sampleMetadata: boolean;
    writeBackColumns: boolean;
  };
  persistence: {
    workspaceFiles: boolean;
    hostObject: boolean;
    fileSystemAccess: boolean;
    directoryAccess: boolean;
  };
  compute: {
    location: "browser" | "host";
  };
}

export interface GateLabHostLifecycle {
  mounted?(): void;
  unmounted?(): void;
}

/**
 * The narrow shell contract implemented by the ordinary browser build and,
 * later, the GateLabR Shiny/SCE bridge.
 */
export interface GateLabHostAdapter {
  readonly contractVersion: typeof GATELAB_HOST_CONTRACT_VERSION;
  readonly id: string;
  readonly kind: GateLabHostKind;
  readonly label: string;
  readonly capabilities: Readonly<GateLabHostCapabilities>;
  readonly datasets?: GateLabHostDatasetPort;
  readonly workspaces?: GateLabHostWorkspacePort;
  readonly colData?: GateLabHostColDataPort;
  readonly rowData?: GateLabHostRowDataPort;
  readonly compensation?: GateLabHostCompensationPort;
  readonly lifecycle?: GateLabHostLifecycle;
}
