// newExperiment.ts — Save as new experiment: a folder of its own under the lab folder, each FCS of
// the workspace uploaded into it (src/drive/upload.ts), and then the workspace file, written last
// so that an experiment folder holding a workspace is always complete.
//
// A save that stops part way (cancelled, a refusal, a sign-in that ran out) leaves the folder with
// the files sent so far and no workspace. Saving again under the same name goes on in that folder:
// a file it already holds is found by name, size and MD5 and not sent again. Only a folder this
// member's GateLab made for an experiment, holding no workspace yet, is gone on in; any other
// folder of the name is left alone and the name refused.

import { parseFcsDataSetFileName } from "../engine/fcs";
import { DriveError, DriveNotFoundError, FOLDER_MIME, type DriveApi, type DriveFile } from "./api";
import { driveSourcePath, isWorkspaceName } from "./experiment";
import { createOnce, createWorkspaceFile, DriveFolderAccessError, keep, SAVE_KEY, WRITER_KEY } from "./save";
import type { DriveTarget } from "./types";
import { pause, uploadFile, type UploadResult } from "./upload";

/** The appProperties of an experiment folder GateLab made: whose it is, so only they go on in it. */
export const EXPERIMENT_KEY = "gatelabExperiment";
export const CREATOR_KEY = "gatelabCreator";

/** A sample of the workspace, with the bytes that are uploaded for it. */
export interface ExperimentSample {
  readonly id: string;
  readonly name: string;
  /** The FCS the sample was read from; null when GateLab holds none (an SCE sample). */
  readonly bytes: Uint8Array | null;
  /** For one data set of a multi-data-set file: the whole file it was taken from, when held. */
  readonly dataSetFile?: Uint8Array | null;
}

/** One file to upload, and the samples read from it. */
export interface ExperimentUpload {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sampleIds: readonly string[];
}

export interface NewExperimentProgress {
  readonly phase: "folder" | "checking" | "uploading" | "verifying" | "workspace";
  /** The file being worked on, 1-based, of `count`. */
  readonly file: string | null;
  readonly index: number;
  readonly count: number;
  readonly sentBytes: number;
  readonly totalBytes: number;
}

export interface NewExperimentResult {
  readonly target: DriveTarget;
  /** Files this save sent. */
  readonly uploaded: number;
  /** Files the folder held already, from a save that stopped part way. */
  readonly already: number;
  /** A folder left by such a save was gone on in. */
  readonly resumed: boolean;
  readonly keepNote: string | null;
  /** Each sample's source path from now on: "Drive: <experiment>/<file>". */
  readonly sourcePaths: ReadonlyMap<string, string>;
}

/** A save that stopped after its experiment folder was made: the message says what the folder holds. */
export class DriveExperimentStoppedError extends DriveError {
  /** `reason` is what stopped it: a DriveAuthError is mended by a reconnect, and saving again goes on. */
  constructor(message: string, readonly cancelled: boolean, readonly reason: unknown = null) {
    super(message);
    this.name = "DriveExperimentStoppedError";
  }
}

/** The experiment's name as a folder name: no path separators or control characters, at most 120 characters. */
export function experimentName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.gatelab$/i, "").trim().slice(0, 120);
}

/**
 * The files to upload for the workspace's samples: each sample's FCS once, and for the data sets
 * of one multi-data-set file, that file once, under its own name, as the workspace names it.
 */
export function experimentUploads(samples: readonly ExperimentSample[]): ExperimentUpload[] {
  const uploads: { name: string; bytes: Uint8Array; sampleIds: string[] }[] = [];
  const problems: string[] = [];
  for (const sample of samples) {
    const dataSet = parseFcsDataSetFileName(sample.name);
    const name = dataSet?.fileName ?? sample.name;
    const bytes = dataSet ? sample.dataSetFile ?? null : sample.bytes;
    if (!bytes) {
      problems.push(dataSet
        ? `${sample.name} is one data set of ${name}, and GateLab does not hold the whole of ${name} here (a workspace opened from a portable copy, or reverted, holds its data sets apart). Open ${name} itself and save again.`
        : `${sample.name} has no FCS file in GateLab to upload.`);
      continue;
    }
    const same = uploads.find((upload) => upload.name === name && upload.bytes === bytes);
    if (same) same.sampleIds.push(sample.id);
    else uploads.push({ name, bytes, sampleIds: [sample.id] });
  }
  if (problems.length > 0) throw new DriveError(`${problems.join(" ")} Nothing was saved.`);
  if (uploads.length === 0) throw new DriveError("The workspace has no FCS files to save.");
  return uploads;
}

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MiB`;

export async function saveAsNewExperiment(
  api: DriveApi,
  /** The folder the experiment folder is made in: the lab folder, or a folder inside it. */
  rootFolderId: string,
  request: {
    readonly name: string;
    readonly uploads: readonly ExperimentUpload[];
    readonly workspace: Uint8Array;
    readonly writerId: string;
    /** The signed-in member: an unfinished folder is gone on in only by the member who made it. */
    readonly account: string;
  },
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: NewExperimentProgress) => void;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<NewExperimentResult> {
  const { signal, onProgress, sleep = pause } = options;
  const experiment = experimentName(request.name);
  if (!experiment) throw new DriveError("Name the experiment.");
  const workspaceName = `${experiment}.gatelab`;
  const count = request.uploads.length;
  const totalBytes = request.uploads.reduce((sum, upload) => sum + upload.bytes.length, 0);
  const report = (progress: Omit<NewExperimentProgress, "count" | "totalBytes">) => onProgress?.({ ...progress, count, totalBytes });
  report({ phase: "folder", file: null, index: 0, sentBytes: 0 });

  // A folder of this name already in the lab folder, as far as GateLab can see it.
  const listed = await api.listChildren(rootFolderId, null).catch((cause: unknown) => {
    // Under drive.file an unpicked lab folder may not be listed: then nothing in it is seen.
    if (cause instanceof DriveNotFoundError || (cause instanceof DriveError && cause.status === 403)) return [] as DriveFile[];
    throw cause;
  });
  let folder: DriveFile | null = null;
  for (const candidate of listed.filter((file) => file.name === experiment && !file.trashed)) {
    const mine = candidate.mimeType === FOLDER_MIME && candidate.appProperties[EXPERIMENT_KEY] === "1" &&
      candidate.appProperties[CREATOR_KEY] === request.account.toLowerCase();
    const finished = mine && (await api.listChildren(candidate.id, candidate.driveId)).some((file) => isWorkspaceName(file.name) && !file.trashed);
    if (!mine || finished) {
      throw new DriveError(`"${experiment}" is already in the lab Drive. Choose another name; nothing was saved.`);
    }
    folder ??= candidate;
  }
  const resumed = folder !== null;
  if (!folder) {
    const nonce = crypto.randomUUID();
    try {
      folder = await createOnce(api, rootFolderId, nonce, () => api.createFolder({
        name: experiment,
        parentId: rootFolderId,
        appProperties: {
          [SAVE_KEY]: nonce,
          [WRITER_KEY]: request.writerId,
          [EXPERIMENT_KEY]: "1",
          [CREATOR_KEY]: request.account.toLowerCase(),
        },
      }), sleep);
    } catch (cause) {
      if (cause instanceof DriveNotFoundError || (cause instanceof DriveError && cause.status === 403)) {
        throw new DriveFolderAccessError(rootFolderId);
      }
      throw cause;
    }
  }

  const results: UploadResult[] = [];
  let done = 0;
  const stopped = (cause: unknown): DriveExperimentStoppedError => {
    const cancelled = signal?.aborted === true;
    const held = results.length;
    const where = `The experiment folder "${experiment}" in the lab Drive holds ${held} of ${count} FCS file${count === 1 ? "" : "s"} and no workspace; ` +
      "Save as new experiment again under the same name to go on from there, without sending again the files already there.";
    const why = cancelled ? "Cancelled." : `${cause instanceof Error ? cause.message : String(cause)}`;
    return new DriveExperimentStoppedError(`${why} ${where}`, cancelled, cause);
  };
  try {
    for (let index = 0; index < count; index++) {
      signal?.throwIfAborted();
      const upload = request.uploads[index];
      let phase: NewExperimentProgress["phase"] = "checking";
      let sent = 0;
      const tell = () => report({ phase, file: upload.name, index: index + 1, sentBytes: done + sent });
      tell();
      const result = await uploadFile(api, { folderId: folder.id, driveId: folder.driveId }, upload, {
        ...(signal ? { signal } : {}),
        sleep,
        onPhase: (next) => { phase = next; tell(); },
        onProgress: (bytes) => { sent = bytes; tell(); },
      });
      results.push(result);
      done += upload.bytes.length;
    }
    signal?.throwIfAborted();
  } catch (cause) {
    throw stopped(cause);
  }

  report({ phase: "workspace", file: workspaceName, index: count, sentBytes: totalBytes });
  let file: DriveFile;
  try {
    ({ file } = await createWorkspaceFile(api, folder.id, workspaceName, request.workspace, request.writerId, sleep));
  } catch (cause) {
    throw stopped(cause);
  }
  const keepNote = await keep(api, file, true);
  const sourcePaths = new Map<string, string>();
  for (const upload of request.uploads) {
    for (const id of upload.sampleIds) sourcePaths.set(id, driveSourcePath(experiment, upload.name));
  }
  return {
    target: {
      fileId: file.id,
      folderId: folder.id,
      name: file.name,
      experiment,
      headRevisionId: file.headRevisionId,
      writerId: request.writerId,
    },
    uploaded: results.filter((result) => !result.already).length,
    already: results.filter((result) => result.already).length,
    resumed,
    keepNote,
    sourcePaths,
  };
}

/** "3 FCS files, 412 MiB": what a new experiment would upload. */
export function describeUploads(uploads: readonly ExperimentUpload[]): string {
  const bytes = uploads.reduce((sum, upload) => sum + upload.bytes.length, 0);
  return `${uploads.length} FCS file${uploads.length === 1 ? "" : "s"}, ${mib(bytes)}`;
}
