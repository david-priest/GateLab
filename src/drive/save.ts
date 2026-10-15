// save.ts — writing a reference workspace back to the lab Drive. Drive offers no conditional write
// (it ignores If-Match), so the guard is GateLab's own: the head revision is read before the write
// and the save is refused when it is not the one this tab opened or last saved; it is read again
// after the write, and a head that is not this tab's write (told by a mark in the file's
// appProperties) is reported. An explicit save keeps its revision forever, where Drive allows it.

import { DriveError, DriveNotFoundError, type DriveApi, type DriveFile } from "./api";
import { isDriveSourcePath, isWorkspaceName } from "./experiment";
import type { DriveSaveResult, DriveSaveSource, DriveTarget, DriveWriter } from "./types";
import { outcomeUnknown, pause } from "./upload";

/** The appProperties keys GateLab writes: which tab wrote the file, and which save of it. */
export const WRITER_KEY = "gatelabWriter";
export const SAVE_KEY = "gatelabSave";
export const WORKSPACE_MIME = "application/json";

/** Thrown when GateLab may not create a file in the experiment folder until the folder is picked once. */
export class DriveFolderAccessError extends DriveError {
  constructor(readonly folderId: string) {
    super(
      "GateLab may not create the workspace file in this experiment folder until the folder is chosen once in Google's file picker.",
      403,
    );
    this.name = "DriveFolderAccessError";
  }
}

export function writerOf(file: DriveFile): DriveWriter {
  return {
    name: file.lastModifyingUser?.displayName ?? null,
    email: file.lastModifyingUser?.emailAddress ?? null,
    at: file.modifiedTime,
  };
}

/** Every sample's FCS must be in the lab Drive: a local file named in a Drive workspace could not be reopened there. */
export function checkDriveSources(sources: readonly DriveSaveSource[]): void {
  const local = sources.filter((source) => !isDriveSourcePath(source.sourcePath));
  if (local.length > 0) {
    const names = local.slice(0, 5).map((source) => source.name).join(", ");
    throw new DriveError(
      `${local.length === 1 ? "One file" : `${local.length} files`} of this workspace ${local.length === 1 ? "is" : "are"} not in the lab Drive ` +
        `(${names}${local.length > 5 ? ", …" : ""}), so nobody could reopen it from there. Put the FCS in the experiment folder and open the ` +
        "experiment again, or keep this workspace on this computer with Save As….",
    );
  }
}

/**
 * Make a file or folder once. After an error that leaves unknown whether Drive made it (a 5xx, or
 * no answer: probe P6), the folder is listed for the nonce the new item was given before it is
 * made again, so a second copy is never made of one Drive kept.
 */
export async function createOnce(
  api: DriveApi,
  parentId: string,
  nonce: string,
  create: () => Promise<DriveFile>,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<DriveFile> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await create();
    } catch (cause) {
      if (!outcomeUnknown(cause) || attempt >= 3) throw cause;
      await sleep(2000 * attempt);
      const made = (await api.listChildren(parentId, null)).find((file) => file.appProperties[SAVE_KEY] === nonce && !file.trashed);
      if (made) return made;
    }
  }
}

export async function keep(api: DriveApi, file: DriveFile, keepForever: boolean): Promise<string | null> {
  if (!keepForever || !file.headRevisionId) return null;
  try {
    await api.setKeepForever(file.id, file.headRevisionId);
    return null;
  } catch (cause) {
    return `the revision was saved but not kept forever (${cause instanceof Error ? cause.message : String(cause)})`;
  }
}

/** Create the workspace file in the experiment folder. */
export async function createWorkspaceFile(
  api: DriveApi,
  folderId: string,
  name: string,
  bytes: Uint8Array,
  writerId: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ file: DriveFile; nonce: string }> {
  const nonce = crypto.randomUUID();
  try {
    const file = await createOnce(api, folderId, nonce, () => api.createFile({
      name,
      parentId: folderId,
      mimeType: WORKSPACE_MIME,
      appProperties: { [WRITER_KEY]: writerId, [SAVE_KEY]: nonce },
    }, bytes), sleep);
    return { file, nonce };
  } catch (cause) {
    if (cause instanceof DriveNotFoundError || (cause instanceof DriveError && cause.status === 403)) {
      throw new DriveFolderAccessError(folderId);
    }
    throw cause;
  }
}

/** Save over the workspace file, or create it at the first save of a workspace opened from FCS alone. */
export async function saveWorkspaceToDrive(
  api: DriveApi,
  target: DriveTarget,
  bytes: Uint8Array,
  sources: readonly DriveSaveSource[],
  options: { keepForever: boolean } = { keepForever: true },
): Promise<DriveSaveResult> {
  checkDriveSources(sources);
  if (target.fileId === null) {
    const { file } = await createWorkspaceFile(api, target.folderId, target.name, bytes, target.writerId);
    const keepNote = await keep(api, file, options.keepForever);
    return { kind: "saved", target: { ...target, fileId: file.id, name: file.name, headRevisionId: file.headRevisionId }, keepNote, overtakenBy: null };
  }

  const before = await api.getMetadata(target.fileId);
  if (before.trashed) throw new DriveError(`${before.name} is in the Drive trash; restore it, or save a copy.`);
  if (!before.parents.includes(target.folderId)) {
    throw new DriveError(`${before.name} is no longer in the experiment folder it was opened from; open the experiment again.`);
  }
  if (before.headRevisionId !== target.headRevisionId) return { kind: "conflict", by: writerOf(before) };

  const nonce = crypto.randomUUID();
  const written = await api.updateMedia(target.fileId, {
    mimeType: before.mimeType && !before.mimeType.startsWith("application/vnd.google-apps.") ? before.mimeType : WORKSPACE_MIME,
    appProperties: { [WRITER_KEY]: target.writerId, [SAVE_KEY]: nonce },
  }, bytes);
  // Read again: a write from elsewhere between the check and this one is not stopped by Drive.
  const after = await api.getMetadata(target.fileId);
  const overtakenBy = after.headRevisionId !== written.headRevisionId || after.appProperties[SAVE_KEY] !== nonce
    ? writerOf(after)
    : null;
  const keepNote = await keep(api, written, options.keepForever);
  // The revision recorded is the one written here: when another save overtook it, the next save
  // here is refused rather than writing over that one.
  return { kind: "saved", target: { ...target, headRevisionId: written.headRevisionId }, keepNote, overtakenBy };
}

/** "<name> copy 2026-10-15 1432.gatelab": a copy beside the workspace, named apart from it. */
export function copyName(name: string, at: Date = new Date()): string {
  const stem = name.replace(/\.gatelab$/i, "");
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${stem} copy ${when}.gatelab`;
}

/**
 * Save as a new workspace file beside the one open, named `name` (by default "<name> copy <date>"),
 * which becomes the file saved to from now on. A name already taken in the folder is refused:
 * Drive would allow two, and nobody could tell them apart in the picker.
 */
export async function saveWorkspaceCopyToDrive(
  api: DriveApi,
  target: DriveTarget,
  bytes: Uint8Array,
  sources: readonly DriveSaveSource[],
  options: { keepForever?: boolean; name?: string; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DriveSaveResult> {
  checkDriveSources(sources);
  const name = options.name ?? copyName(target.name);
  if (!isWorkspaceName(name)) throw new DriveError(`A workspace file's name ends in .gatelab; "${name}" does not.`);
  const taken = (await api.listChildren(target.folderId, null)).some((file) => file.name === name && !file.trashed);
  if (taken) throw new DriveError(`${name} is already in the experiment folder. Choose another name; nothing was saved.`);
  const { file } = await createWorkspaceFile(api, target.folderId, name, bytes, target.writerId, options.sleep);
  const keepNote = await keep(api, file, options.keepForever ?? true);
  return { kind: "saved", target: { ...target, fileId: file.id, name: file.name, headRevisionId: file.headRevisionId }, keepNote, overtakenBy: null };
}
