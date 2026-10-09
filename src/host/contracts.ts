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
 * Which build this is, as the host knows it, for the header and the About card. The app's
 * version does not change between embeds, so an installed GateLabR is told from a newer one
 * by the commit its core was built from.
 */
export interface GateLabHostBuild {
  /** The host package's version, e.g. GateLabR's "1.6.0". */
  readonly hostVersion?: string;
  /** The commit the host package was installed from, where its installer recorded one. */
  readonly hostCommit?: string;
  /** The GateLab commit the embedded core was built from. */
  readonly coreCommit?: string;
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
  readonly build?: Readonly<GateLabHostBuild>;
  readonly capabilities: Readonly<GateLabHostCapabilities>;
  readonly datasets?: GateLabHostDatasetPort;
  readonly workspaces?: GateLabHostWorkspacePort;
  readonly colData?: GateLabHostColDataPort;
  readonly rowData?: GateLabHostRowDataPort;
  readonly compensation?: GateLabHostCompensationPort;
  readonly lifecycle?: GateLabHostLifecycle;
}
