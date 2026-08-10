import { supportsDirectoryAccess, supportsFileSystemAccess } from "../engine/fsAccess";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./contracts";

export interface BrowserHostOptions {
  fileSystemAccess?: boolean;
  directoryAccess?: boolean;
}

/** Create the default standalone/web host used by GateLab today. */
export function createBrowserHost(options: BrowserHostOptions = {}): GateLabHostAdapter {
  const fileSystemAccess = options.fileSystemAccess ?? supportsFileSystemAccess();
  const directoryAccess = options.directoryAccess ?? supportsDirectoryAccess();

  return {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "gatelab-browser",
    kind: "browser",
    label: "GateLab browser",
    capabilities: {
      dataSources: {
        fcsFiles: true,
        singleCellExperiment: false,
      },
      dataModel: {
        multipleAssays: true,
        sampleMetadata: true,
        writeBackColumns: false,
      },
      persistence: {
        workspaceFiles: true,
        hostObject: false,
        fileSystemAccess,
        directoryAccess,
      },
      compute: {
        location: "browser",
      },
    },
  };
}
