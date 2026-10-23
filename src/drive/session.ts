// session.ts — one lab member's lab Drive session in this tab: sign-in, the Open experiment flow and
// saving. The app reaches it only through src/drive/index.ts, loaded by dynamic import in the lab build.

import { parseFcsDataSetFileName } from "../engine/fcs";
import { checkDriveId, createDriveApi, DriveError, DriveNotFoundError, type DriveApi, type DriveFile } from "./api";
import { createDriveAuth, type DriveAuth } from "./auth";
import type { DriveConfig } from "./config";
import {
  confirmPicked,
  downloadFiles,
  driveSourcePath,
  experimentCandidates,
  labPlacement,
  matchExperimentFcs,
  MAX_LAB_DEPTH,
  outsideLabMessage,
  type PickedExperiment,
  readDriveWorkspace,
  readMatchedFcs,
  workspaceRequirements,
} from "./experiment";
import {
  experimentUploads,
  saveAsNewExperiment,
  type ExperimentSample,
  type NewExperimentProgress,
  type NewExperimentResult,
} from "./newExperiment";
import { createDrivePicker, type DrivePicker, type PickedDoc } from "./picker";
import { saveWorkspaceCopyToDrive, saveWorkspaceToDrive } from "./save";
import type { DriveFolderRequest, DriveLocation, DriveOpened, DriveSaveResult, DriveSaveSource, DriveTarget } from "./types";

/** What the Open experiment flow asks of the person opening. */
export interface OpenExperimentUi {
  progress(message: string): void;
  /** Several workspace files were picked: which one. */
  chooseWorkspace(files: readonly DriveFile[]): Promise<DriveFile | null>;
  /** Files the workspace declares were not among those picked: true to pick them now. */
  askMissing(names: readonly string[]): Promise<boolean>;
  /** FCS were picked without a workspace: the name of the workspace file to save them under. */
  nameNewWorkspace(fileCount: number, suggested: string): Promise<string | null>;
  /**
   * GateLab cannot read a folder on the way up to the lab folder (the folder of the files picked,
   * or one above it), so cannot see where it is: true to choose that folder once in the picker,
   * after which it can.
   */
  askFolder(request: DriveFolderRequest): Promise<boolean>;
  /** The files picked, so an open stopped for a reconnect can go on with them rather than pick again. */
  picked?(docs: readonly PickedDoc[]): void;
}

export interface DriveSession {
  readonly config: DriveConfig;
  readonly auth: DriveAuth;
  readonly api: DriveApi;
  readonly picker: DrivePicker;
  /** This tab's mark on what it writes. */
  readonly writerId: string;
  /** Pick an experiment's files, or take those `picked` before, and read them; null when cancelled. */
  openExperiment(ui: OpenExperimentUi, picked?: readonly PickedDoc[]): Promise<DriveOpened | null>;
  /** An Open experiment is under way: an autosave waits for it. */
  opening(): boolean;
  /**
   * Save in place, once the experiment folder is confirmed still in the lab folder. An autosave
   * passes keepForever false: only an explicit save keeps its revision.
   */
  save(target: DriveTarget, bytes: Uint8Array, sources: readonly DriveSaveSource[], options?: { readonly keepForever: boolean }): Promise<DriveSaveResult>;
  /** A copy beside the workspace open, named `name` (a workspace file name), or "<name> copy <date>". */
  saveCopy(target: DriveTarget, bytes: Uint8Array, sources: readonly DriveSaveSource[], name?: string): Promise<DriveSaveResult>;
  /**
   * Where a new experiment goes: a folder chosen in the picker, which opens in the lab folder,
   * confirmed to be the lab folder or inside it at any depth (a folder on the way that GateLab
   * cannot read is asked for once). Null when cancelled; a folder outside is refused.
   */
  chooseLocation(ui: { askFolder(request: DriveFolderRequest): Promise<boolean> }): Promise<DriveLocation | null>;
  /**
   * Upload the samples' FCS into a new experiment folder in `location` (the lab folder when
   * absent), then the workspace.
   */
  saveAsNewExperiment(
    request: {
      readonly name: string;
      readonly samples: readonly ExperimentSample[];
      readonly workspace: Uint8Array;
      readonly location?: DriveLocation | null;
    },
    ui?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: NewExperimentProgress) => void },
  ): Promise<NewExperimentResult>;
  /**
   * Pick a folder once, so GateLab may create a file in it: the experiment's folder, or the lab
   * folder for a new experiment. False when the picker was cancelled.
   */
  grantFolder(folderId: string): Promise<boolean>;
}

export interface DriveSessionParts {
  readonly auth?: DriveAuth;
  readonly api?: DriveApi;
  readonly picker?: DrivePicker;
  readonly writerId?: string;
}

/** The folder's name when GateLab may read it; under drive.file an unpicked folder is not reachable. */
async function folderName(api: DriveApi, folderId: string): Promise<string | null> {
  try {
    return (await api.getMetadata(folderId)).name || null;
  } catch {
    return null;
  }
}

/** A request started now and awaited later: its failure is held until then, never left unhandled. */
function later<T>(promise: Promise<T>): () => Promise<T> {
  const held = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return async () => {
    const result = await held;
    if (!result.ok) throw result.error;
    return result.value;
  };
}

export function workspaceFileName(name: string): string {
  const clean = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.gatelab$/i, "").slice(0, 120);
  return `${clean || "workspace"}.gatelab`;
}

export function createDriveSession(config: DriveConfig, parts: DriveSessionParts = {}): DriveSession {
  const auth = parts.auth ?? createDriveAuth(config);
  const api = parts.api ?? createDriveApi(() => auth.token());
  const picker = parts.picker ?? createDrivePicker(config, () => auth.token());
  const writerId = parts.writerId ?? crypto.randomUUID();

  /** The lab folder's drive (null for My Drive), or undefined when GateLab cannot read the lab folder. */
  async function labDriveId(): Promise<string | null | undefined> {
    try {
      return (await api.getMetadata(config.rootFolderId)).driveId;
    } catch (cause) {
      if (cause instanceof DriveNotFoundError) return undefined;
      throw cause;
    }
  }

  /**
   * The folder is in the lab folder, at any depth, by Drive's record of the parents of every folder
   * on the way up. A folder on the way that GateLab cannot read yet is asked for once (`first` when
   * it is the folder itself) and chosen in the picker; one in another drive than the lab folder's is
   * outside without asking. Null when a question or the picker is cancelled.
   */
  async function confirmInLab(
    folderId: string,
    folderDriveId: string | null | undefined,
    ask: (request: DriveFolderRequest) => Promise<boolean>,
    first: DriveFolderRequest | null,
  ): Promise<{ folder: DriveFile | null; path: readonly string[]; asked: boolean } | "outside" | null> {
    let asked = false;
    let lab: Promise<string | null | undefined> | null = null;
    for (let picks = 0; picks <= MAX_LAB_DEPTH; picks++) {
      const placement = await labPlacement(api, folderId, config.rootFolderId);
      if (placement.kind === "inside") return { folder: placement.folder, path: placement.path, asked };
      if (placement.kind === "outside") return "outside";
      const drive = placement.child ? placement.child.driveId : folderDriveId;
      const labDrive = await (lab ??= labDriveId());
      if (labDrive !== undefined && drive !== undefined && drive !== labDrive) return "outside";
      const request: DriveFolderRequest | null = placement.child ? { kind: "above", child: placement.child.name } : first;
      if (!request) return "outside";
      if (!(await ask(request))) return null;
      asked = true;
      const chosen = await picker.pickFolder("experiment", request.kind === "above"
        ? `Choose the folder that holds "${request.child}" (it is in the lab folder, perhaps several folders down)`
        : undefined);
      if (!chosen) return null;
      if (chosen.id !== placement.folderId) {
        throw new DriveError(request.kind === "above"
          ? `That is another folder than the one that holds "${request.child}". Choose that one, or cancel.`
          : "That is another folder than the one that holds the files picked. Choose their own folder; nothing was opened.");
      }
    }
    return "outside";
  }

  /** The experiment folder of the files picked is in the lab folder; its name when GateLab can read it. Null when cancelled. */
  async function inLabFolder(picked: PickedExperiment, ui: OpenExperimentUi): Promise<{ name: string | null; asked: boolean } | null> {
    const files = [...picked.workspaces, ...picked.fcs, ...picked.other].map((file) => file.name);
    const placed = await confirmInLab(picked.folderId, picked.driveId, (request) => ui.askFolder(request), { kind: "experiment", files });
    if (placed === null) return null;
    if (placed === "outside") throw new DriveError(outsideLabMessage("open", await folderName(api, config.rootFolderId)));
    return { name: placed.folder?.name || null, asked: placed.asked };
  }

  /** At a save: the folder is still in the lab folder, so a folder moved out since it was opened or chosen is not written to. */
  async function stillInLabFolder(folderId: string, what: string): Promise<void> {
    if ((await labPlacement(api, folderId, config.rootFolderId)).kind === "inside") return;
    const lab = await folderName(api, config.rootFolderId);
    throw new DriveError(
      `GateLab cannot confirm that ${what} is still in the lab folder${lab ? ` "${lab}"` : ""}, so nothing was saved. ` +
        "Open the experiment, or choose the location, again from the lab folder; or keep this workspace with Save a copy on this computer.",
    );
  }

  async function openExperiment(ui: OpenExperimentUi, pickedBefore?: readonly PickedDoc[]): Promise<DriveOpened | null> {
    const docs = pickedBefore ?? await picker.pickExperimentFiles();
    if (!docs || docs.length === 0) return null;
    ui.picked?.(docs);
    ui.progress("Opening from the lab Drive · checking the files picked");
    const picked = await confirmPicked(api, docs);
    // A single workspace file's revision is read beside the lab-folder check; nothing of any file's
    // content is read until the check has passed.
    const single = picked.workspaces.length === 1 ? picked.workspaces[0] : null;
    const singleRevision = single ? later(api.getMetadata(single.id)) : null;
    const placed = await inLabFolder(picked, ui);
    if (!placed) return null;
    const folder = placed.name;

    if (picked.workspaces.length === 0) {
      if (picked.fcs.length === 0) throw new DriveError("No .gatelab workspace and no FCS file was picked.");
      const name = await ui.nameNewWorkspace(picked.fcs.length, folder ?? "workspace");
      if (!name) return null;
      const fileName = workspaceFileName(name);
      const experiment = folder ?? fileName.replace(/\.gatelab$/i, "");
      const read = await downloadFiles(api, picked.fcs, ui.progress);
      const files = picked.fcs.map((file, index) => ({ name: file.name, bytes: read[index], sourcePath: driveSourcePath(experiment, file.name) }));
      return {
        kind: "fcs",
        files,
        target: { fileId: null, folderId: picked.folderId, name: fileName, experiment, headRevisionId: null, writerId },
      };
    }

    const chosen = picked.workspaces.length === 1 ? picked.workspaces[0] : await ui.chooseWorkspace(picked.workspaces);
    if (!chosen) return null;
    // The revision recorded is read before the content, so a save made meanwhile is caught at the
    // next save here rather than written over; read again when the folder was chosen in between.
    // The folder is listed while the workspace file downloads.
    const current = chosen === single && singleRevision && !placed.asked ? await singleRevision() : await api.getMetadata(chosen.id);
    ui.progress(`Opening from the lab Drive · reading ${current.name}`);
    const [envelope, listed] = await Promise.all([readDriveWorkspace(api, current), experimentCandidates(api, picked)]);
    const experiment = folder ?? current.name.replace(/\.gatelab$/i, "");
    const requirements = workspaceRequirements(envelope.raw);
    let extra: DriveFile[] = [];
    for (let first = true; ; first = false) {
      ui.progress("Opening from the lab Drive · matching the workspace's FCS files");
      const candidates = first ? listed : await experimentCandidates(api, picked, extra);
      const match = await matchExperimentFcs(api, requirements, candidates);
      if (match.problems.length > 0) {
        throw new DriveError(`${match.problems.join(" ")} Nothing was opened; the current workspace is unchanged.`);
      }
      if (match.missing.length === 0) {
        const resolved = await readMatchedFcs(api, requirements, match.matches, experiment, ui.progress);
        return {
          kind: "workspace",
          envelope,
          resolved,
          target: {
            fileId: current.id,
            folderId: picked.folderId,
            name: current.name,
            experiment,
            headRevisionId: current.headRevisionId,
            writerId,
          },
        };
      }
      const names = [...new Set(match.missing.map((r) => parseFcsDataSetFileName(r.fileName)?.fileName ?? r.fileName))];
      if (!(await ui.askMissing(names))) return null;
      const more = await picker.pickMissing(picked.folderId, names);
      if (!more || more.length === 0) return null;
      const added = await confirmPicked(api, more, picked.folderId);
      extra = [...extra, ...added.fcs];
    }
  }

  let openings = 0;
  return {
    config,
    auth,
    api,
    picker,
    writerId,
    async openExperiment(ui, picked) {
      openings++;
      try {
        return await openExperiment(ui, picked);
      } finally {
        openings--;
      }
    },
    opening: () => openings > 0,
    async save(target, bytes, sources, options) {
      await stillInLabFolder(target.folderId, `the folder of ${target.name}`);
      return saveWorkspaceToDrive(api, target, bytes, sources, options);
    },
    async saveCopy(target, bytes, sources, name) {
      await stillInLabFolder(target.folderId, `the folder of ${target.name}`);
      return saveWorkspaceCopyToDrive(api, target, bytes, sources, name === undefined ? {} : { name: workspaceFileName(name) });
    },
    async chooseLocation(ui) {
      const chosen = await picker.pickFolder("location");
      if (!chosen) return null;
      const folderId = checkDriveId(chosen.id, "folder");
      if (folderId === config.rootFolderId) return { folderId, path: [] };
      const placed = await confirmInLab(folderId, undefined, (request) => ui.askFolder(request), null);
      if (placed === null) return null;
      if (placed === "outside") throw new DriveError(outsideLabMessage("location", await folderName(api, config.rootFolderId)));
      return { folderId, path: placed.path };
    },
    async saveAsNewExperiment(request, ui = {}) {
      const account = auth.account();
      if (!account) throw new DriveError("Sign in to the lab Drive first (Lab Drive ▸ Sign in).");
      const uploads = experimentUploads(request.samples);
      const parentId = request.location?.folderId ?? config.rootFolderId;
      if (parentId !== config.rootFolderId) await stillInLabFolder(parentId, `the folder chosen for the new experiment`);
      return saveAsNewExperiment(api, parentId, {
        name: request.name,
        uploads,
        workspace: request.workspace,
        writerId,
        account: account.email,
      }, ui);
    },
    async grantFolder(folderId) {
      const lab = folderId === config.rootFolderId;
      const folder = await picker.pickFolder(lab ? "lab" : "experiment");
      if (!folder) return false;
      if (folder.id !== folderId) {
        throw new DriveError(lab
          ? "That is another folder than the lab folder. Choose the lab folder itself, the one that holds the experiment folders."
          : "That is another folder than the experiment's. Choose the folder that holds the experiment's FCS files.");
      }
      return true;
    },
  };
}

