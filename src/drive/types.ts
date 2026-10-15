// types.ts — what the lab Drive workspace hands the app, and what the app keeps of it. The app
// imports these as types only, so they add nothing to the public build.

import type { WorkspaceEnvelope } from "../engine/workspace";

/**
 * Where a workspace opened from, or saved to, the lab Drive is written back: the reference
 * workspace file in its experiment folder. Its presence puts the app in Drive mode.
 */
export interface DriveTarget {
  /** The workspace file; null until the first save creates it in the folder. */
  readonly fileId: string | null;
  /** The experiment folder that holds the workspace and its FCS files. */
  readonly folderId: string;
  /** The workspace file's name, `<experiment>.gatelab` by the lab's layout. */
  readonly name: string;
  /** The experiment, as shown in a sample's source path: "Drive: <experiment>/<file>". */
  readonly experiment: string;
  /** The revision opened or last saved here; a save is refused when Drive's head has moved on. */
  readonly headRevisionId: string | null;
  /** This tab's mark on what it writes (the file's appProperties), so its own save is told from another's. */
  readonly writerId: string;
}

/** One FCS read from the lab Drive, ready for the app to load. */
export interface DriveResolvedFcs {
  readonly bytes: Uint8Array;
  readonly handle: null;
  readonly sourcePath: string;
  /** For one data set of a multi-data-set file: the whole file, kept to upload it as it was. */
  readonly dataSetFile?: Uint8Array;
}

/** A workspace file from the lab Drive with every FCS it declares, matched and read. */
export interface DriveOpenedWorkspace {
  readonly kind: "workspace";
  /** The workspace as `readWorkspaceEnvelope` reads it: reference JSON only. */
  readonly envelope: WorkspaceEnvelope;
  /** Each declared sample's FCS, by the workspace's dataPath. */
  readonly resolved: ReadonlyMap<string, DriveResolvedFcs>;
  readonly target: DriveTarget;
}

/** FCS files picked without a workspace: opened as a new workspace saved into their folder. */
export interface DriveOpenedFcs {
  readonly kind: "fcs";
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array; readonly sourcePath: string }[];
  readonly target: DriveTarget;
}

export type DriveOpened = DriveOpenedWorkspace | DriveOpenedFcs;

/** A sample of the workspace being saved, to check that its FCS is in the experiment folder. */
export interface DriveSaveSource {
  readonly name: string;
  readonly sourcePath: string | null;
}

export type DriveSaveResult =
  | {
      readonly kind: "saved";
      readonly target: DriveTarget;
      /** Set when the revision could not be kept forever (Drive keeps 200 per file). */
      readonly keepNote: string | null;
      /** Set when Drive's head, read again after the write, is another writer's save. */
      readonly overtakenBy: DriveWriter | null;
    }
  | {
      /** Drive's head moved on since this tab opened or last saved: nothing was written. */
      readonly kind: "conflict";
      readonly by: DriveWriter;
    };

export interface DriveWriter {
  readonly name: string | null;
  readonly email: string | null;
  /** ISO time of the revision. */
  readonly at: string | null;
}
