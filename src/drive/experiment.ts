// experiment.ts — from the files a lab member picked to a workspace and the FCS it declares. The
// experiment folder is flat: the workspace file and its FCS side by side, so one selection of all
// its files gives GateLab both. Files are taken by Drive ID and checked against the folder, never by
// name alone: Drive allows two files of one name in a folder. The FCS a workspace declares are
// matched as a local relink matches them (planWorkspaceFcsRelink), the acquisition keywords of a
// same-named file read from its header by Range requests, so another acquisition is never taken.

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
import { checkDriveId, DriveError, DriveTooLargeError, type DriveApi, type DriveFile } from "./api";
import type { PickedDoc } from "./picker";
import type { DriveResolvedFcs } from "./types";

/** The cap on a workspace file, as for any workspace JSON GateLab reads. */
export const MAX_WORKSPACE_BYTES = 64 * 1024 * 1024;
/** How a sample read from the lab Drive names its source: "Drive: <experiment>/<file>". */
export const DRIVE_SOURCE_PREFIX = "Drive: ";
const FOLDER_MIME = "application/vnd.google-apps.folder";

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
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const file = await api.getMetadata(checkDriveId(doc.id));
    if (file.mimeType === FOLDER_MIME) {
      throw new DriveError(`"${file.name}" is a folder. Open the experiment folder in the picker and select the files inside it.`);
    }
    if (file.trashed) throw new DriveError(`"${file.name}" is in the Drive trash.`);
    files.push(file);
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
  } catch {
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
  for (const file of candidates) {
    if (!named.has(normal(file.name))) continue;
    const identity = await readDriveFcsIdentity(api, file);
    if (identity) identities.set(file.id, identity);
  }
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

/** Download each matched file once, taking a data set out of its file as a local relink does. */
export async function readMatchedFcs(
  api: DriveApi,
  requirements: readonly WorkspaceFcsRequirement[],
  matches: ReadonlyMap<string, DriveFile>,
  experiment: string,
  progress: (message: string) => void = () => undefined,
): Promise<Map<string, DriveResolvedFcs>> {
  const files = new Map<string, Uint8Array>();
  const resolved = new Map<string, DriveResolvedFcs>();
  const toRead = [...new Set([...matches.values()])];
  for (const requirement of requirements) {
    const file = matches.get(requirement.dataPath);
    if (!file) throw new DriveError(`${requirement.fileName} was not matched.`);
    let whole = files.get(file.id);
    if (!whole) {
      const index = toRead.indexOf(file) + 1;
      whole = await api.download(file.id, {
        size: file.size,
        onProgress: (loaded, total) => progress(
          `Opening from the lab Drive · ${index} / ${toRead.length} · ${file.name}` +
            (total ? ` · ${Math.round(loaded / total * 100)}%` : ""),
        ),
      });
      files.set(file.id, whole);
    }
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
