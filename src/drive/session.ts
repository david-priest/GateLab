// session.ts — one lab member's lab Drive session in this tab: sign-in, the Open experiment flow and
// saving. The app reaches it only through src/drive/index.ts, loaded by dynamic import in the lab build.

import { parseFcsDataSetFileName } from "../engine/fcs";
import { createDriveApi, DriveError, type DriveApi, type DriveFile } from "./api";
import { createDriveAuth, type DriveAuth } from "./auth";
import type { DriveConfig } from "./config";
import {
  confirmPicked,
  driveSourcePath,
  experimentCandidates,
  matchExperimentFcs,
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
import { createDrivePicker, type DrivePicker } from "./picker";
import { saveWorkspaceCopyToDrive, saveWorkspaceToDrive } from "./save";
import type { DriveOpened, DriveSaveResult, DriveSaveSource, DriveTarget } from "./types";

/** What the Open experiment flow asks of the person opening. */
export interface OpenExperimentUi {
  progress(message: string): void;
  /** Several workspace files were picked: which one. */
  chooseWorkspace(files: readonly DriveFile[]): Promise<DriveFile | null>;
  /** Files the workspace declares were not among those picked: true to pick them now. */
  askMissing(names: readonly string[]): Promise<boolean>;
  /** FCS were picked without a workspace: the name of the workspace file to save them under. */
  nameNewWorkspace(fileCount: number, suggested: string): Promise<string | null>;
}

export interface DriveSession {
  readonly config: DriveConfig;
  readonly auth: DriveAuth;
  readonly api: DriveApi;
  readonly picker: DrivePicker;
  /** This tab's mark on what it writes. */
  readonly writerId: string;
  /** Pick an experiment's files and read them; null when cancelled. */
  openExperiment(ui: OpenExperimentUi): Promise<DriveOpened | null>;
  save(target: DriveTarget, bytes: Uint8Array, sources: readonly DriveSaveSource[]): Promise<DriveSaveResult>;
  /** A copy beside the workspace open, named `name` (a workspace file name), or "<name> copy <date>". */
  saveCopy(target: DriveTarget, bytes: Uint8Array, sources: readonly DriveSaveSource[], name?: string): Promise<DriveSaveResult>;
  /** Upload the samples' FCS into a new experiment folder under the lab folder, then the workspace. */
  saveAsNewExperiment(
    request: { readonly name: string; readonly samples: readonly ExperimentSample[]; readonly workspace: Uint8Array },
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

export function workspaceFileName(name: string): string {
  const clean = name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\.gatelab$/i, "").slice(0, 120);
  return `${clean || "workspace"}.gatelab`;
}

export function createDriveSession(config: DriveConfig, parts: DriveSessionParts = {}): DriveSession {
  const auth = parts.auth ?? createDriveAuth(config);
  const api = parts.api ?? createDriveApi(() => auth.token());
  const picker = parts.picker ?? createDrivePicker(config, () => auth.token());
  const writerId = parts.writerId ?? crypto.randomUUID();

  async function openExperiment(ui: OpenExperimentUi): Promise<DriveOpened | null> {
    const docs = await picker.pickExperimentFiles();
    if (!docs || docs.length === 0) return null;
    ui.progress("Opening from the lab Drive · checking the files picked");
    const picked = await confirmPicked(api, docs);
    const folder = await folderName(api, picked.folderId);

    if (picked.workspaces.length === 0) {
      if (picked.fcs.length === 0) throw new DriveError("No .gatelab workspace and no FCS file was picked.");
      const name = await ui.nameNewWorkspace(picked.fcs.length, folder ?? "workspace");
      if (!name) return null;
      const fileName = workspaceFileName(name);
      const experiment = folder ?? fileName.replace(/\.gatelab$/i, "");
      const files = [];
      for (let index = 0; index < picked.fcs.length; index++) {
        const file = picked.fcs[index];
        const bytes = await api.download(file.id, {
          size: file.size,
          onProgress: (loaded, total) => ui.progress(
            `Opening from the lab Drive · ${index + 1} / ${picked.fcs.length} · ${file.name}` +
              (total ? ` · ${Math.round(loaded / total * 100)}%` : ""),
          ),
        });
        files.push({ name: file.name, bytes, sourcePath: driveSourcePath(experiment, file.name) });
      }
      return {
        kind: "fcs",
        files,
        target: { fileId: null, folderId: picked.folderId, name: fileName, experiment, headRevisionId: null, writerId },
      };
    }

    const chosen = picked.workspaces.length === 1 ? picked.workspaces[0] : await ui.chooseWorkspace(picked.workspaces);
    if (!chosen) return null;
    // The revision recorded is read before the content, so a save made meanwhile is caught at the
    // next save here rather than written over.
    const current = await api.getMetadata(chosen.id);
    ui.progress(`Opening from the lab Drive · reading ${current.name}`);
    const envelope = await readDriveWorkspace(api, current);
    const experiment = folder ?? current.name.replace(/\.gatelab$/i, "");
    const requirements = workspaceRequirements(envelope.raw);
    let extra: DriveFile[] = [];
    for (;;) {
      ui.progress("Opening from the lab Drive · matching the workspace's FCS files");
      const candidates = await experimentCandidates(api, picked, extra);
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

  return {
    config,
    auth,
    api,
    picker,
    writerId,
    openExperiment,
    save: (target, bytes, sources) => saveWorkspaceToDrive(api, target, bytes, sources),
    saveCopy: (target, bytes, sources, name) =>
      saveWorkspaceCopyToDrive(api, target, bytes, sources, name === undefined ? {} : { name: workspaceFileName(name) }),
    async saveAsNewExperiment(request, ui = {}) {
      const account = auth.account();
      if (!account) throw new DriveError("Sign in to the lab Drive first (Lab Drive ▸ Sign in).");
      const uploads = experimentUploads(request.samples);
      return saveAsNewExperiment(api, config.rootFolderId, {
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

