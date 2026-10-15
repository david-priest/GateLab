// index.ts — the lab Drive workspace as the app loads it: by dynamic import, behind the build flag
// __GATELAB_DRIVE__, so that nothing here is in the public build.

export { DriveMenu, type DriveMenuProps } from "./DriveMenu";
export { DriveSaveAsDialog, DriveUploadDialog, type DriveSaveAsRequest } from "./DriveSaveDialogs";
export { readDriveConfig, type DriveConfig } from "./config";
export { createDriveSession, type DriveSession } from "./session";
export { copyName, DriveFolderAccessError } from "./save";
export {
  describeUploads,
  DriveExperimentStoppedError,
  experimentName,
  experimentUploads,
  type ExperimentSample,
  type NewExperimentProgress,
} from "./newExperiment";
export { isDriveSourcePath } from "./experiment";
