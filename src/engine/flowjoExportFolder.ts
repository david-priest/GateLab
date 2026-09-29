// flowjoExportFolder.ts — a FlowJo workspace written as a self-contained folder: the .wsp beside
// the FCS files it names, each file the bytes GateLab loaded, under its own name.
//
// Where the files go, and how the workspace names them. FlowJo 10.10 resolves a relative
// DataSet uri against the folder holding the .wsp after percent-decoding it, and reads a raw "#"
// as the start of a fragment; FlowKit's find_fcs_files_from_wsp joins the same relative path to
// the .wsp's folder and stops at a raw "#" or "?". So every path segment is written with
// encodeURIComponent after "file:". CytoML ignores the uri and searches the .wsp's folder
// recursively, pairing by $FIL and then $TOT, and FlowJo's own fallback searches beside the .wsp
// by keywords; both rely on the file keeping its name, which is why a name two files share is
// kept by putting the later ones in subfolders rather than by renaming them.
//
// A name Chrome will not write to disk (nameProblems) is the one exception: that file is written
// under a name it does write (writableName), which the DataSet uri and the SampleNode both give,
// so FlowJo and FlowKit find it by the uri and GateLab by the name. Its bytes are unchanged, and
// with them $FIL, $TOT, $DATE, $BTIM, $ETIM and GUID, which is what CytoML (the workspace's $FIL
// against each file's own, then $TOT) and FlowJo's search beside the .wsp pair it by.

import { writeHandleStream } from "./fsAccess";
import { writeStoredZip, type StreamZipWriteProgress, type ZipChunkSink } from "./workspaceArchiveStream";

/** One sample of the export, as the folder needs it. */
export interface FlowJoFolderSource {
  /** The file's name, which the workspace gives its sample. */
  readonly name: string;
  /** The bytes GateLab loaded, or null where it holds none (a sample the R host owns). */
  readonly bytes: Uint8Array | null;
}

/** Where one sample's file goes. */
export interface FlowJoFolderFile {
  readonly name: string;
  /**
   * Its place in the folder, relative to the workspace, "/"-separated: its own name, or
   * "<k>/<name>" for the k-th file of a name another file of the export already has. The name
   * there is the one written, which the workspace's sample carries.
   */
  readonly path: string;
  readonly bytes: Uint8Array | null;
  /** Why Chrome would not write the file's own name, where it is written under another; else empty. */
  readonly renamed: readonly FlowJoNameProblem[];
}

export interface FlowJoFolderPlan {
  /** The workspace file's name, at the top of the folder. */
  readonly workspaceName: string;
  /** One per source, in the order given. */
  readonly files: readonly FlowJoFolderFile[];
  /** Bytes of the FCS files written (those GateLab holds). */
  readonly fcsBytes: number;
}

/** What the export dialog says about a folder before anything is written. */
export interface FlowJoFolderPreview {
  /** The folder's name: the workspace's, without ".wsp". */
  readonly folderName: string;
  readonly workspaceName: string;
  /** FCS files written, and their bytes. */
  readonly fileCount: number;
  readonly fcsBytes: number;
  /** The .zip's size, the workspace counted at the size it was given (at most what it will be). */
  readonly zipBytes: number;
  /** Files written under their own name in a subfolder, because another file has the name, and where each goes. */
  readonly moved: readonly { name: string; path: string }[];
  /** Files written under another name, because Chrome will not write their own, where each goes and why. */
  readonly renamed: readonly { name: string; path: string; problems: readonly FlowJoNameProblem[] }[];
  /** Files whose bytes GateLab does not hold: named in the workspace, not written. */
  readonly missing: readonly string[];
}

/** A stored ZIP's offsets and sizes are 32-bit: past this, writeStoredZip's archive is corrupt. */
export const ZIP_MAX_BYTES = 0xffffffff;
const ZIP_MAX_ENTRIES = 0xffff;
const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * A name folded at least as far as the file systems FlowJo runs on fold one. APFS ignores
 * normalisation and folds case fully (CaseFolding.txt, statuses C and F), so the micro sign and
 * Greek mu, "ß" and "ss", "ς" and "σ", "ſ" and "s", "ﬁ" and "fi" are each one name to it, where
 * toLowerCase alone keeps them apart. Lower, then upper, then lower case gives every such folding
 * ("ẞ" lowers to "ß", which uppers to "SS"), and decomposing first keeps a combining mark in the
 * order full folding leaves it. Compatibility normalisation folds further than any file system
 * (a full-width "２" is "2"); folding too much only puts a file in a subfolder, where folding too
 * little lets one file replace another.
 */
const foldName = (name: string): string => name.normalize("NFKD").toLowerCase().toUpperCase().toLowerCase().normalize("NFKC");

/**
 * Why Chrome will not write a name to a folder on disk: getFileHandle and getDirectoryHandle
 * throw "Name is not allowed." (Chromium's FileSystemAccessManagerImpl::IsSafePathComponent).
 */
export type FlowJoNameProblem =
  /** Characters no file name may hold: " * / : < > ? \ |, control and format characters, noncharacters. */
  | { readonly kind: "characters"; readonly characters: readonly string[] }
  /** A space, "." or "~" first (after one leading ".", which is allowed) or last. */
  | { readonly kind: "ends" }
  /** An extension Chrome refuses: .lnk, .scf and .url, a {CLSID}, or a type its download rules call dangerous. */
  | { readonly kind: "extension"; readonly extension: string }
  /** A DOS device name, with or without an extension (CON, AUX, COM1, …), or one of Windows's own. */
  | { readonly kind: "reserved" }
  /** A "~" in a name of the 8.3 form, which Chrome refuses on Windows. */
  | { readonly kind: "tilde" }
  /** Empty, ".", or "..". */
  | { readonly kind: "empty" };

// base::i18n::IsFilenameLegal: "[\"*/:<>?\\|][:Cc:][:Cf:]" and the noncharacters anywhere, and
// "[:WSpace:][.~]" at either end. A lone surrogate is refused too: the browser would write it as
// U+FFFD, a name the workspace does not give.
const REFUSED_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}"*/:<>?\\|]/gu;
const AT_ENDS = /[\p{White_Space}.~]/u;
// IsSafePathComponent's own list, and the extensions download_file_types.asciipb calls DANGEROUS
// on some system, "local" excepted as IsSafePathComponent excepts it. Refused on every system
// here: a folder written on one is opened on another.
const REFUSED_EXTENSIONS = new Set(["lnk", "scf", "url", "dll", "cfg", "ini", "manifest", "dng"]);
// base::IsReservedNameOnWindows, which IsSafePathComponent applies on every system.
const DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/;
const RESERVED_NAMES = new Set(["desktop.ini", "thumbs.db", "conin$", "conout$"]);

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function isReservedName(name: string): boolean {
  const trimmed = asciiLower(name).replace(/[ .]+$/, "");
  const dot = trimmed.indexOf(".");
  return DEVICE_NAMES.test(dot < 0 ? trimmed : trimmed.slice(0, dot)) || RESERVED_NAMES.has(trimmed);
}

/** The extension after the last ".", or null where there is none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : name.slice(dot + 1);
}

const refusedExtension = (extension: string | null): boolean =>
  extension !== null && (REFUSED_EXTENSIONS.has(asciiLower(extension)) || /^\{.*\}$/.test(extension));

/**
 * IllegalCharacters::CouldBeInvalidShortName: twelve UTF-16 units or fewer, a "~", none of the
 * characters an 8.3 name cannot hold, and at most one ".", after one to eight characters and
 * before at most three.
 */
function couldBeShortName(s: string): boolean {
  if (s.length > 12 || !s.includes("~") || /[\p{White_Space}"\\/[\]:+|<>=;?,*]/u.test(s)) return false;
  const dot = s.indexOf(".");
  if (dot < 0) return s.length <= 8;
  return dot === s.lastIndexOf(".") && dot > 0 && dot <= 8 && dot + 4 >= s.length;
}

/** Why Chrome will not write `name` to a folder on disk; empty where it will. */
export function nameProblems(name: string): FlowJoNameProblem[] {
  if (name === "" || name === "." || name === "..") return [{ kind: "empty" }];
  const problems: FlowJoNameProblem[] = [];
  const characters = [...new Set(name.match(REFUSED_CHARACTERS) ?? [])];
  if (characters.length) problems.push({ kind: "characters", characters });
  // One leading "." is allowed (".git"); what follows it is held to the rule for a name's ends.
  const rest = name.startsWith(".") ? name.slice(1) : name;
  const codePoints = [...rest];
  if (codePoints.length && (AT_ENDS.test(codePoints[0]) || AT_ENDS.test(codePoints[codePoints.length - 1]))) problems.push({ kind: "ends" });
  const extension = extensionOf(name);
  if (refusedExtension(extension)) problems.push({ kind: "extension", extension: extension! });
  if (isReservedName(name)) problems.push({ kind: "reserved" });
  if (couldBeShortName(rest)) problems.push({ kind: "tilde" });
  return problems;
}

/**
 * The name a file is written under where Chrome will not write its own: each refused character
 * "_"; a space, "." or "~" at the end dropped, so the extension stays last, and at the start
 * (beyond one ".") one "_"; ".fcs" after a refused extension; "_" before a reserved name; a "~"
 * of an 8.3 name "_". A name Chrome writes is returned as it is.
 */
export function writableName(name: string): string {
  if (!nameProblems(name).length) return name;
  let s = name.replace(REFUSED_CHARACTERS, "_").replace(/[\p{White_Space}.~]+$/u, "");
  if (/^\.?[\p{White_Space}.~]/u.test(s)) s = s.replace(/^[\p{White_Space}.~]+/u, "_");
  if (s === "") s = "_";
  if (refusedExtension(extensionOf(s))) s += ".fcs";
  if (isReservedName(s)) s = `_${s}`;
  if (couldBeShortName(s.startsWith(".") ? s.slice(1) : s)) s = s.replace(/~/g, "_");
  if (nameProblems(s).length) throw new Error(`No name Chrome writes was found for ${JSON.stringify(name)}.`);
  return s;
}

/** A name with " n" before its extension, for the n-th distinct name renamed to the same one. */
function numbered(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
}

/** The DataSet uri of a file at `path` relative to the workspace: "file:" and each segment percent-encoded. */
export function flowJoFolderUri(path: string): string {
  return `file:${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Where each file goes. The first file of a name (folded by foldName, at least as far as macOS
 * and Windows fold one) sits at the top under that name; the k-th goes in a subfolder named k,
 * under the same name, so every file keeps the name its $FIL and the workspace's sample carry. The
 * workspace's own name counts as taken, and a subfolder whose name a file at the top already has
 * gains a "_".
 *
 * A file whose name Chrome will not write takes writableName's name instead, numbered (" 2",
 * " 3", …) where a file written under its own name, the workspace, or another refused name has
 * it; files sharing a refused name share the new one, and go in subfolders as any shared name.
 */
export function planFlowJoFolder(sources: readonly FlowJoFolderSource[], workspaceName: string): FlowJoFolderPlan {
  const problemsOf = sources.map((source) => nameProblems(source.name));
  // The names written as they are come first: a renamed file never takes one of them.
  const taken = new Set([foldName(workspaceName), ...sources.filter((_, i) => !problemsOf[i].length).map((s) => foldName(s.name))]);
  // The number each refused name (folded) is written with, 1 for none.
  const numberOf = new Map<string, number>();
  const placed = sources.map((source, i) => {
    let entry = source.name;
    if (problemsOf[i].length) {
      const key = foldName(source.name);
      let n = numberOf.get(key);
      if (n === undefined) {
        n = 1;
        while (taken.has(foldName(numbered(writableName(source.name), n)))) n++;
        taken.add(foldName(numbered(writableName(source.name), n)));
        numberOf.set(key, n);
      }
      // Each spelling of the name its own, as a name written as it is keeps its own spelling.
      entry = numbered(writableName(source.name), n);
    }
    return { source, entry, problems: problemsOf[i] };
  });
  const count = new Map<string, number>([[foldName(workspaceName), 1]]);
  const withK = placed.map((p) => {
    const key = foldName(p.entry);
    const k = (count.get(key) ?? 0) + 1;
    count.set(key, k);
    return { ...p, k };
  });
  // Every name at the top, before a subfolder is named: a later file at the top named "2" would
  // otherwise meet a subfolder "2" chosen earlier.
  const top = new Set([foldName(workspaceName), ...withK.filter((p) => p.k === 1).map((p) => foldName(p.entry))]);
  const subfolder = (k: number): string => {
    let dir = String(k);
    while (top.has(foldName(dir))) dir += "_";
    return dir;
  };
  const files = withK.map(({ source, entry, k, problems }) => ({
    name: source.name,
    path: k === 1 ? entry : `${subfolder(k)}/${entry}`,
    bytes: source.bytes,
    renamed: problems,
  }));
  const fcsBytes = files.reduce((n, f) => n + (f.bytes?.byteLength ?? 0), 0);
  return { workspaceName, files, fcsBytes };
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

/**
 * The size of the stored ZIP writeStoredZip writes (fflate's streamed layout): for each entry a
 * 30-byte local header and its name, the data and a 16-byte data descriptor; for each a 46-byte
 * central record and its name again; and the 22-byte end record.
 */
export function storedZipBytes(entries: readonly { path: string; byteLength: number }[]): number {
  return entries.reduce((n, e) => n + 30 + 16 + 46 + 2 * utf8Length(e.path) + e.byteLength, 22);
}

/** The entries of the folder's .zip, each under the folder's name, the workspace first. */
function zipEntries(folderName: string, plan: FlowJoFolderPlan, workspace: Uint8Array): { path: string; bytes: Uint8Array }[] {
  return [
    { path: `${folderName}/${plan.workspaceName}`, bytes: workspace },
    ...plan.files.flatMap((f) => (f.bytes ? [{ path: `${folderName}/${f.path}`, bytes: f.bytes }] : [])),
  ];
}

/**
 * What the dialog states before anything is written. `workspaceBytes` is the size the .zip counts
 * the workspace at: flowJoWorkspaceBytesAtMost's, which is never less than the file written, since
 * the counts it will carry are not known until the export evaluates every population.
 */
export function previewFlowJoFolder(plan: FlowJoFolderPlan, folderName: string, workspaceBytes: number): FlowJoFolderPreview {
  const entries = zipEntries(folderName, plan, { byteLength: workspaceBytes } as Uint8Array);
  return {
    folderName,
    workspaceName: plan.workspaceName,
    fileCount: entries.length - 1,
    fcsBytes: plan.fcsBytes,
    zipBytes: storedZipBytes(entries.map((e) => ({ path: e.path, byteLength: e.bytes.byteLength }))),
    moved: plan.files.filter((f) => !f.renamed.length && f.path !== f.name).map((f) => ({ name: f.name, path: f.path })),
    renamed: plan.files.filter((f) => f.renamed.length).map((f) => ({ name: f.name, path: f.path, problems: f.renamed })),
    missing: plan.files.filter((f) => !f.bytes).map((f) => f.name),
  };
}

/** Whether the folder fits in one stored ZIP. */
export function fitsInZip(preview: Pick<FlowJoFolderPreview, "zipBytes" | "fileCount">): boolean {
  return preview.zipBytes <= ZIP_MAX_BYTES && preview.fileCount + 1 <= ZIP_MAX_ENTRIES;
}

/** A byte count as Finder states one: decimal units, one decimal place above a kilobyte. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.95 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// Copied into this realm's Uint8Array: writeStoredZip checks the type, and a test's TextEncoder
// can answer with another realm's.
const asBytes = (workspace: string | Uint8Array): Uint8Array =>
  typeof workspace === "string" ? new Uint8Array(new TextEncoder().encode(workspace)) : workspace;

/** A DOMException is an Error in a browser, not always in a test's DOM. */
const reasonOf = (e: unknown): string =>
  typeof (e as { message?: unknown } | null)?.message === "string" ? (e as Error).message : String(e);

/** The reason as a sentence of its own: browsers end some messages with "." and not others. */
const reasonSentence = (e: unknown): string => `${reasonOf(e).trim().replace(/\.+$/, "")}.`;

/**
 * A new folder named `name` inside `parent`, or "<name> 2", "<name> 3", … where that is taken. An
 * existing folder is never written into: the files there could be the very ones being copied.
 */
export async function createExportFolder(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    try {
      await parent.getDirectoryHandle(candidate);
      continue;
    } catch (e) {
      const kind = (e as DOMException | null)?.name;
      // A file of that name is taken as surely as a folder.
      if (kind === "TypeMismatchError") continue;
      if (kind !== "NotFoundError") throw e;
    }
    return parent.getDirectoryHandle(candidate, { create: true });
  }
}

export interface FlowJoFolderWriteOptions {
  /** Bytes per write; the file's bytes are never copied whole. */
  readonly chunkBytes?: number;
  /** After each FCS file: how many are written, of how many, and the one just written. */
  readonly onProgress?: (written: number, total: number, path: string) => void;
}

/** Why the export stopped before writing a file: the disk opens another file for its name. */
class NameTaken extends Error {
  constructor() {
    super("The disk takes its name to be that of a file already in the folder, which writing it would replace.");
  }
}

/**
 * Whether `dir` holds an entry the disk opens for `name`. The folder is new, so an entry there is
 * one this export wrote, under a name the disk compares as the same though foldName does not.
 */
async function holds(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    const kind = (e as DOMException | null)?.name;
    if (kind === "NotFoundError") return false;
    if (kind === "TypeMismatchError") return true;
    throw e;
  }
}

async function writeInChunks(handle: FileSystemFileHandle, bytes: Uint8Array, chunkBytes: number): Promise<void> {
  await writeHandleStream(handle, async (write) => {
    for (let start = 0; start < bytes.byteLength; start += chunkBytes) {
      await write(bytes.subarray(start, Math.min(bytes.byteLength, start + chunkBytes)));
    }
  });
}

/**
 * Write the folder into a new folder inside `parent`: every FCS file GateLab holds, one at a
 * time and in chunks, then the workspace last, so a folder holding the .wsp holds its files.
 *
 * A failure anywhere, a subfolder included, stops the export with an error that names the file it
 * stopped at and says the folder is incomplete and holds no workspace. The browser writes each
 * file to a temporary file and moves it into place only when the write closes, so a file whose
 * write failed is empty; the workspace's, made empty by getFileHandle before the write, is taken
 * away again, so no folder is left with a .wsp that its files do not all stand beside.
 *
 * Before each file, the workspace's included, the folder is asked for the name without creating
 * it: getFileHandle with create opens a file already there, so a disk comparing two names as one
 * where planFlowJoFolder did not would have the second file replace the first. The export stops
 * there instead, with the same error, and without "Export again", since it would stop there again.
 */
export async function writeFlowJoFolder(
  parent: FileSystemDirectoryHandle,
  folderName: string,
  plan: FlowJoFolderPlan,
  workspace: string | Uint8Array,
  options: FlowJoFolderWriteOptions = {},
): Promise<{ folder: FileSystemDirectoryHandle; written: number }> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  let folder: FileSystemDirectoryHandle;
  try {
    folder = await createExportFolder(parent, folderName);
  } catch (e) {
    throw new Error(`Could not make the folder ${folderName} in ${parent.name}: ${reasonSentence(e)} Nothing was written.`);
  }
  const files = plan.files.filter((f): f is FlowJoFolderFile & { bytes: Uint8Array } => f.bytes !== null);
  const held = (written: number): string => {
    const total = files.length;
    if (written === 0) return total <= 1 ? "no FCS file" : `none of the ${total} FCS files`;
    if (written === total) return total === 1 ? "the FCS file" : `all ${total} FCS files`;
    return `${written} of the ${total} FCS files`;
  };
  const incomplete = (path: string, e: unknown, written: number, emptyWorkspace = false) => new Error(
    `Stopped at ${path}: ${reasonSentence(e)} The folder ${folder.name} in ${parent.name} is incomplete: it holds ` +
      `${held(written)} and ${emptyWorkspace ? `an empty ${plan.workspaceName}, which is not a workspace` : "no workspace"}.` +
      (e instanceof NameTaken ? "" : " Export again."),
  );
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const segments = file.path.split("/");
    try {
      let dir = folder;
      for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
      const name = segments[segments.length - 1];
      if (await holds(dir, name)) throw new NameTaken();
      await writeInChunks(await dir.getFileHandle(name, { create: true }), file.bytes, chunkBytes);
    } catch (e) {
      throw incomplete(file.path, e, i);
    }
    options.onProgress?.(i + 1, files.length, file.path);
  }
  let made = false;
  try {
    if (await holds(folder, plan.workspaceName)) throw new NameTaken();
    const handle = await folder.getFileHandle(plan.workspaceName, { create: true });
    made = true;
    await writeInChunks(handle, asBytes(workspace), chunkBytes);
  } catch (e) {
    // The folder held nothing the disk opens for the workspace's name, so the file of that name is
    // the empty one made just now.
    const left = made && !(await folder.removeEntry(plan.workspaceName).then(() => true, () => false));
    throw incomplete(plan.workspaceName, e, files.length, left);
  }
  return { folder, written: files.length };
}

/**
 * The folder as one stored (uncompressed) ZIP, streamed through fflate to `sink`, every entry
 * under the folder's name. Refused before a byte is written where it would not fit: fflate
 * writes no ZIP64, so an archive past 4 GB would be corrupt.
 *
 * The sink is handed each FCS file's bytes as views of the bytes GateLab holds, not copies, and
 * the headers fflate makes: a Blob made of the chunks is the only copy of the archive, where
 * collecting copies and then the Blob held it twice beside the bytes GateLab already holds.
 */
export async function writeFlowJoZip(
  folderName: string,
  plan: FlowJoFolderPlan,
  workspace: string | Uint8Array,
  sink: ZipChunkSink,
  onProgress?: (progress: StreamZipWriteProgress) => void,
): Promise<void> {
  const entries = zipEntries(folderName, plan, asBytes(workspace));
  const size = storedZipBytes(entries.map((e) => ({ path: e.path, byteLength: e.bytes.byteLength })));
  if (!fitsInZip({ zipBytes: size, fileCount: entries.length - 1 })) {
    throw new Error(
      `The folder comes to ${formatByteSize(size)} in ${entries.length} files, more than one .zip can hold ` +
        `(${formatByteSize(ZIP_MAX_BYTES)}, ${ZIP_MAX_ENTRIES} files); nothing was written.`,
    );
  }
  await writeStoredZip(entries, sink, { chunkBytes: DEFAULT_CHUNK_BYTES, borrowChunks: true, ...(onProgress ? { onProgress } : {}) });
}
