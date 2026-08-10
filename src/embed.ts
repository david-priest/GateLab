export {
  mountGateLab,
  type GateLabMountOptions,
  type MountedGateLab,
} from "./bootstrap";
export { createBrowserHost, type BrowserHostOptions } from "./host/browserHost";
export {
  createShinySceHost,
  type GateLabShinyManifest,
  type GateLabShinyResourceDescriptor,
  type ShinySceHostOptions,
} from "./host/shinySceHost";
export {
  loadHostedDataset,
  type GateLabHostedSample,
} from "./host/hostedSample";
export {
  GateLabHostProvider,
  useGateLabHost,
  useOptionalGateLabHost,
} from "./host/HostContext";
export {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
  type GateLabHostCapabilities,
  type GateLabHostKind,
  type GateLabHostLifecycle,
} from "./host/contracts";
export {
  GATELAB_DATASET_CONTRACT_VERSION,
  decodeChannelMajorFloat32,
  decodeEventIndexUint32,
  type GateLabAssayCoordinateSpace,
  type GateLabAssayRole,
  type GateLabHostAssayDescriptor,
  type GateLabHostChannelDescriptor,
  type GateLabHostDatasetDescriptor,
  type GateLabHostDatasetPort,
  type GateLabHostSampleDescriptor,
  type GateLabHostScalar,
  type GateLabInstrument,
} from "./host/datasetContract";
export {
  GATELAB_HOST_WORKSPACE_CONTRACT_VERSION,
  type GateLabHostWorkspaceEnvelope,
  type GateLabHostWorkspacePort,
  type GateLabHostWorkspaceSource,
} from "./host/workspaceContract";
export {
  GATELAB_HOST_ROWDATA_CONTRACT_VERSION,
  type GateLabHostChannelLabelChange,
  type GateLabHostRowDataPort,
  type GateLabHostRowDataWriteRequest,
  type GateLabHostRowDataWriteResult,
} from "./host/rowDataContract";
export {
  GATELAB_HOST_COLDATA_CONTRACT_VERSION,
  packMembershipBits,
  type GateLabHostCategoricalColumn,
  type GateLabHostCategoricalSampleValues,
  type GateLabHostCategoricalWriteRequest,
  type GateLabHostCategoricalWriteResult,
  type GateLabHostColDataPort,
  type GateLabHostColDataWriteRequest,
  type GateLabHostColDataWriteResult,
  type GateLabHostPopulationColumn,
  type GateLabHostPopulationSampleMask,
} from "./host/colDataContract";
export {
  convertHostedGateSpace,
  readHostedWorkspace,
  type HostedWorkspaceRestore,
} from "./host/hostedWorkspace";
