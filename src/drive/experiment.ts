// experiment.ts — from the files a lab member picked to a workspace and the FCS it declares. The
// experiment folder is flat: the workspace file and its FCS side by side, so one selection of all
// its files gives GateLab both. Files are taken by Drive ID and checked against the folder, never by
// name alone: Drive allows two files of one name in a folder. The FCS a workspace declares are
// matched as a local relink matches them (planWorkspaceFcsRelink), the acquisition keywords of a
// same-named file read from its header by Range requests, so another acquisition is never taken.
//
// Each request to Drive takes 0.3 to 0.6 s, so the per-file requests run side by side: the files'
// details and their header reads at most CHECK_CONCURRENCY at a time, the downloads at most
// DOWNLOAD_CONCURRENCY. Every check is still made on every file.

import {
  extractNamedFcsDataSet,
  fcsTextSegmentEnd,
  parseFcsDataSetFileName,
  readFcsKeywords,
} from "../engine/fcs";
import { identityKeywords, type RecordedIdentity } from "../engine/fileIdentity";
import { migrateWorkspaceToV2, readWorkspaceEnvelope, type WorkspaceEnvelope } from "../engine/workspace";
import {
  describeRequirement,
  indistinguishableDuplicateNames,
  planWorkspaceFcsRelink,
  type WorkspaceFcsRequirement,
} from "../engine/workspaceRelink";
import { WORKSPACE_VERSION_3 } from "../engine/workspaceV3";
import {
  checkDriveId,
  DriveAuthError,
  DriveError,
  DriveNotFoundError,
  DriveTooLargeError,
  type DriveApi,
  type DriveFile,
} from "./api";
import type { PickedDoc } from "./picker";
import type { DriveResolvedFcs } from "./types";

/** The cap on a workspace file, as for any workspace JSON GateLab reads. */
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
/** Files whose details or header are read at once. */
export const CHECK_CONCURRENCY = 4;
/** Files downloaded at once. */
export const DOWNLOAD_CONCURRENCY = 2;
/** How a sample read from the lab Drive names its source: "Drive: <experiment>/<file>". */
export const DRIVE_SOURCE_PREFIX = "Drive: ";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * `run` over `items`, at most `limit` at a time, with the results in the items' order. The first
 * failure is thrown, and no item not yet started is started after it.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index], index);
      } catch (cause) {
        failed = true;
        throw cause;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

export const isWorkspaceName = (name: string): boolean => /\.gatelab$/i.test(name);
export const isFcsName = (name: string): boolean => /\.fcs$/i.test(name);
export const driveSourcePath = (experiment: string, name: string): string => `${DRIVE_SOURCE_PREFIX}${experiment}/${name}`;
export const isDriveSourcePath = (path: string | null | undefined): boolean => !!path?.startsWith(DRIVE_SOURCE_PREFIX);

/** The picked files as Drive has them, in the one folder they share. */
export interface PickedExperiment {
  readonly folderId: string;
  readonly driveId: string | null;
  readonly workspaces: readonly DriveFile[];
  readonly fcs: readonly DriveFile[];
  /** Picked files that are neither (cell images are not read from the lab Drive yet). */
  readonly other: readonly DriveFile[];
}

/** Confirm each picked file with Drive and find the experiment folder they share. */
export async function confirmPicked(api: DriveApi, docs: readonly PickedDoc[], folderId?: string): Promise<PickedExperiment> {
  const ids = [...new Set(docs.map((doc) => checkDriveId(doc.id)))];
  const files = await mapLimit(ids, CHECK_CONCURRENCY, (id) => api.getMetadata(id));
  for (const file of files) {
    if (file.mimeType === FOLDER_MIME) {
      throw new DriveError(`"${file.name}" is a folder. Open the experiment folder in the picker and select the files inside it.`);
    }
    if (file.trashed) throw new DriveError(`"${file.name}" is in the Drive trash.`);
  }
  if (files.length === 0) throw new DriveError("Nothing was picked.");
  const folders = new Set(files.map((file) => file.parents[0] ?? ""));
  if (folders.has("") || folders.size > 1) {
    throw new DriveError("The files picked are not all in one folder. An experiment is one folder: open it in the picker and select its files.");
  }
  const parent = [...folders][0];
  if (folderId !== undefined && parent !== folderId) {
    throw new DriveError("The files picked are in another folder than the experiment's. Pick them from the experiment's own folder.");
  }
  const drives = new Set(files.map((file) => file.driveId));
  return Object.freeze({
    folderId: checkDriveId(parent, "folder"),
    driveId: drives.size === 1 ? [...drives][0] : null,
    workspaces: files.filter((file) => isWorkspaceName(file.name)),
    fcs: files.filter((file) => isFcsName(file.name)),
    other: files.filter((file) => !isWorkspaceName(file.name) && !isFcsName(file.name)),
  });
}

/** How many folders up from an experiment folder the lab folder is looked for. */
export const MAX_LAB_DEPTH = 8;

/**
 * Where a folder is, from Drive's record of its parents: in the lab folder (the folder itself, or
 * one whose parents lead up to it, at any depth), outside it (a folder at the top of a drive or of
 * another Shared drive, or too deep), or not known yet, at the first folder on the way up that
 * GateLab cannot read. Under drive.file a folder is read only once this member's GateLab made it
 * or the member chose it in the picker, so a folder made by hand or by a colleague is not read
 * until it is chosen once.
 */
export type LabPlacement =
  | {
      readonly kind: "inside";
      /** The folder asked about, when GateLab could read it (null for the lab folder itself). */
      readonly folder: DriveFile | null;
      /** The names of the folders from just inside the lab folder down to it; [] for the lab folder. */
      readonly path: readonly string[];
    }
  | { readonly kind: "outside" }
  | {
      readonly kind: "unknown";
      /** The folder GateLab cannot read yet. */
      readonly folderId: string;
      /** The folder below it that GateLab read, or null when the folder asked about is the one it cannot read. */
      readonly child: DriveFile | null;
    };

export async function labPlacement(api: DriveApi, folderId: string, labFolderId: string): Promise<LabPlacement> {
  let id = folderId;
  let first: DriveFile | null = null;
  let child: DriveFile | null = null;
  const names: string[] = [];
  for (let depth = 0; depth <= MAX_LAB_DEPTH; depth++) {
    if (id === labFolderId) return { kind: "inside", folder: first, path: names.reverse() };
    let folder: DriveFile;
    try {
      folder = await api.getMetadata(checkDriveId(id, "folder"));
    } catch (cause) {
      if (cause instanceof DriveNotFoundError) return { kind: "unknown", folderId: id, child };
      throw cause;
    }
    if (folder.mimeType !== FOLDER_MIME || folder.trashed) return { kind: "outside" };
    first ??= folder;
    names.push(folder.name);
    const parent = folder.parents[0];
    // At the top of a drive: My Drive's top level, or a Shared drive's (whose ID is the drive's).
    if (!parent || (parent === folder.driveId && parent !== labFolderId)) return { kind: "outside" };
    child = folder;
    id = parent;
  }
  return { kind: "outside" };
}

/** Why a folder is refused: not in the lab folder, as far as Drive's record of its parents shows. */
export function outsideLabMessage(what: "open" | "location", labName: string | null): string {
  const lab = labName ? `the lab folder "${labName}"` : "the lab folder (the folder Open experiment starts in)";
  return what === "open"
    ? `The files picked are not in ${lab}. GateLab opens an experiment only from a folder inside the lab folder, at any depth, ` +
        "as Drive's record of the folders' parents shows. Nothing was opened; the current workspace is unchanged."
    : `The folder chosen is not in ${lab}. GateLab makes a new experiment only in the lab folder or a folder inside it, at any ` +
        "depth, as Drive's record of the folders' parents shows. Nothing was saved.";
}

/** The FCS a workspace declares, as the local open reads them (App.tsx, openWorkspaceFromEnvelope). */
export function workspaceRequirements(raw: unknown): WorkspaceFcsRequirement[] {
  const version = raw != null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  const samples = version === WORKSPACE_VERSION_3
    ? (raw as { samples?: unknown }).samples
    : migrateWorkspaceToV2(raw).samples;
  if (!Array.isArray(samples) || samples.length === 0) throw new DriveError("The workspace declares no samples.");
  return samples.map((sample: { fileName?: unknown; dataPath?: unknown; identity?: RecordedIdentity }) => {
    if (typeof sample.fileName !== "string" || typeof sample.dataPath !== "string") {
      throw new DriveError("Invalid GateLab workspace: a sample declaration is malformed.");
    }
    return {
      dataPath: sample.dataPath,
      fileName: sample.fileName,
      ...(sample.identity ? { identity: sample.identity } : {}),
    };
  });
}

/** The workspace file, read and checked: a reference workspace of JSON, within the size cap. */
export async function readDriveWorkspace(api: DriveApi, file: DriveFile): Promise<WorkspaceEnvelope> {
  if (file.size === null) throw new DriveError(`"${file.name}" has no size in Drive, so it is not a workspace file.`);
  if (file.size > MAX_WORKSPACE_BYTES) {
    throw new DriveTooLargeError(`"${file.name}" is ${(file.size / 1048576).toFixed(0)} MiB; a workspace file is at most ${MAX_WORKSPACE_BYTES / 1048576} MiB.`);
  }
  const bytes = await api.download(file.id, { size: file.size, maxBytes: MAX_WORKSPACE_BYTES });
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new DriveError(`"${file.name}" is a self-contained workspace bundle. The lab Drive keeps workspaces as reference files beside their FCS; open the bundle from a copy on this computer instead.`);
  }
  return readWorkspaceEnvelope(bytes);
}

/**
 * The FCS GateLab can reach in the experiment folder: those picked, and those the folder lists,
 * which under drive.file are the files this member's GateLab made or picked before. Each is
 * checked to be in the folder.
 */
export async function experimentCandidates(api: DriveApi, picked: PickedExperiment, extra: readonly DriveFile[] = []): Promise<DriveFile[]> {
  const listed = await api.listChildren(picked.folderId, picked.driveId);
  const byId = new Map<string, DriveFile>();
  for (const file of [...picked.fcs, ...extra, ...listed]) {
    if (!isFcsName(file.name) || file.trashed || !file.parents.includes(picked.folderId)) continue;
    if (!byId.has(file.id)) byId.set(file.id, file);
  }
  return [...byId.values()];
}

/** An FCS file's acquisition keywords, from its HEADER and TEXT by two Range requests. */
export async function readDriveFcsIdentity(api: DriveApi, file: DriveFile): Promise<RecordedIdentity | null> {
  try {
    const head = await api.readRange(file.id, 0, 57);
    const end = fcsTextSegmentEnd(head.slice().buffer);
    if (end === null || end > 64 * 1024 * 1024) return null;
    const text = await api.readRange(file.id, 0, end - 1);
    const keywords = readFcsKeywords(text.slice().buffer);
    return keywords ? identityKeywords(keywords) : null;
  } catch (cause) {
    // A sign-in that ran out is not an unreadable header: the open stops for a reconnect.
    if (cause instanceof DriveAuthError) throw cause;
    return null;
  }
}

export interface ExperimentMatch {
  readonly matches: ReadonlyMap<string, DriveFile>;
  /** Declared files not found among those GateLab can reach. */
  readonly missing: readonly WorkspaceFcsRequirement[];
  /** Why the rest cannot be matched safely: another acquisition, or files the keywords cannot tell apart. */
  readonly problems: readonly string[];
}

/** Match a workspace's declared FCS to the experiment's files. */
export async function matchExperimentFcs(
  api: DriveApi,
  requirements: readonly WorkspaceFcsRequirement[],
  candidates: readonly DriveFile[],
): Promise<ExperimentMatch> {
  const duplicates = indistinguishableDuplicateNames(requirements);
  if (duplicates.length > 0) {
    throw new DriveError(
      `This workspace declares more than one FCS file named ${duplicates.join(", ")}, and nothing saved with them tells them apart.`,
    );
  }
  const normal = (name: string) => name.normalize("NFC").toLocaleLowerCase();
  const named = new Set(requirements.filter((r) => r.identity && !parseFcsDataSetFileName(r.fileName)).map((r) => normal(r.fileName)));
  const identities = new Map<string, RecordedIdentity>();
  const toRead = candidates.filter((file) => named.has(normal(file.name)));
  const read = await mapLimit(toRead, CHECK_CONCURRENCY, (file) => readDriveFcsIdentity(api, file));
  toRead.forEach((file, index) => { if (read[index]) identities.set(file.id, read[index]!); });
  const sources = candidates.map((file) => ({ name: file.name, relativePath: file.name, file }));
  const plan = planWorkspaceFcsRelink(requirements, sources, (source) => identities.get(source.file.id) ?? null);
  const problems: string[] = [];
  for (const { requirement } of plan.mismatched) {
    problems.push(`The folder's ${requirement.fileName} records another acquisition than the one ${describeRequirement(requirement, requirements)} was saved with.`);
  }
  for (const { requirement, candidates: several } of plan.ambiguous) {
    problems.push(`${several.length || "Several"} files named ${requirement.fileName} are in the folder, and nothing saved with the workspace says which is ${describeRequirement(requirement, requirements)}.`);
  }
  // Taken over another file of its name without the keywords confirming it: in a lab folder that
  // is a duplicate to tidy, not a guess to make.
  for (const { requirement } of plan.unconfirmed) {
    problems.push(`More than one file named ${requirement.fileName} is in the folder, and the keywords saved with the workspace do not confirm which is ${describeRequirement(requirement, requirements)}.`);
  }
  const matches = new Map<string, DriveFile>();
  const unconfirmed = new Set(plan.unconfirmed.map((u) => u.requirement.dataPath));
  for (const [dataPath, source] of plan.matches) if (!unconfirmed.has(dataPath)) matches.set(dataPath, source.file);
  return { matches, missing: plan.missing, problems };
}

/**
 * Download files, DOWNLOAD_CONCURRENCY at a time, with one progress line for them all; the bytes in
 * the files' order.
 */
export async function downloadFiles(
  api: DriveApi,
  files: readonly DriveFile[],
  progress: (message: string) => void = () => undefined,
): Promise<Uint8Array[]> {
  const loaded = new Array<number>(files.length).fill(0);
  const sized = files.every((file) => file.size !== null);
  const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  let finished = 0;
  const tell = () => progress(
    `Opening from the lab Drive · ${finished} / ${files.length} FCS file${files.length === 1 ? "" : "s"} read` +
      (sized && total > 0 ? ` · ${Math.round(loaded.reduce((sum, bytes) => sum + bytes, 0) / total * 100)}%` : ""),
  );
  tell();
  return mapLimit(files, DOWNLOAD_CONCURRENCY, async (file, index) => {
    const bytes = await api.download(file.id, {
      size: file.size,
      onProgress: (bytesLoaded) => {
        loaded[index] = bytesLoaded;
        tell();
      },
    });
    finished++;
    tell();
    return bytes;
  });
}

/** Download each matched file once, taking a data set out of its file as a local relink does. */
export async function readMatchedFcs(
  api: DriveApi,
  requirements: readonly WorkspaceFcsRequirement[],
  matches: ReadonlyMap<string, DriveFile>,
  experiment: string,
  progress: (message: string) => void = () => undefined,
): Promise<Map<string, DriveResolvedFcs>> {
  for (const requirement of requirements) {
    if (!matches.get(requirement.dataPath)) throw new DriveError(`${requirement.fileName} was not matched.`);
  }
  const toRead = [...new Map(requirements.map((requirement) => {
    const file = matches.get(requirement.dataPath)!;
    return [file.id, file] as const;
  })).values()];
  const read = await downloadFiles(api, toRead, progress);
  const files = new Map(toRead.map((file, index) => [file.id, read[index]] as const));
  const resolved = new Map<string, DriveResolvedFcs>();
  for (const requirement of requirements) {
    const file = matches.get(requirement.dataPath)!;
    const whole = files.get(file.id)!;
    const dataSet = parseFcsDataSetFileName(requirement.fileName);
    const bytes = dataSet ? extractNamedFcsDataSet(whole.slice().buffer, dataSet.index, dataSet.count) : whole;
    resolved.set(requirement.dataPath, {
      bytes,
      handle: null,
      sourcePath: driveSourcePath(experiment, file.name),
      ...(dataSet ? { dataSetFile: whole } : {}),
    });
  }
  return resolved;
}
