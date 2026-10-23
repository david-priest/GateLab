// index.ts — the lab Drive workspace as the app loads it: by dynamic import, behind the build flag
// __GATELAB_DRIVE__, so that nothing here is in the public build.

export { DriveMenu, type DriveMenuProps } from "./DriveMenu";
export { DriveSaveAsDialog, DriveUploadDialog, locationText, type DriveSaveAsRequest } from "./DriveSaveDialogs";
export { DriveReconnectDialog } from "./DriveReconnectDialog";
export { DriveAuthError, DriveNetworkError } from "./api";
export { tokenLive } from "./auth";
export { readDriveConfig, type DriveConfig } from "./config";
export { createDriveSession, type DriveSession } from "./session";
export { copyName, DRIVE_AUTOSAVE_MS, DriveFolderAccessError } from "./save";
export {
  describeUploads,
  DriveExperimentStoppedError,
  experimentName,
  experimentUploads,
  type ExperimentSample,
  type NewExperimentProgress,
} from "./newExperiment";
export { isDriveSourcePath } from "./experiment";
