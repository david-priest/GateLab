// sidecarNames.ts — pair the FCS files in a picked folder or drop with the files that travel
// beside them. A FACSDiscover S8 export writes `<tube>.fcs`, `<tube>.zip` and, when images were
// recorded, `<tube>.cvw` into one Tubes folder, so the waveform file of an FCS is the file of the
// same name in the same folder with the other extension. Small and dependency-free, since the
// open paths in App.tsx import it statically; the imaging code itself loads on demand.

export const CVW_EXTENSION = ".cvw";
export const FCS_EXTENSION = ".fcs";

export interface NamedSource {
  readonly name: string;
  /** Path below the picked folder; just the name for a file picker or a drop. */
  readonly relativePath?: string;
}

export interface PairedSources<T extends NamedSource> {
  /** The FCS files, in the order given. */
  readonly fcs: T[];
  /** The `.cvw` beside each FCS that has one. */
  readonly sidecarOf: Map<T, T>;
}

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

const stem = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 ? name.slice(0, dot) : name).normalize("NFC").toLocaleLowerCase();
};

const folderOf = (source: NamedSource): string => {
  const path = source.relativePath ?? source.name;
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash).normalize("NFC").toLocaleLowerCase() : "";
};

/** The IndexedDB key under which the handle of a sample's image source is remembered. */
export function imageHandleKey(kind: "cvw" | "tiff", fcsName: string): string {
  return `${kind}:${fcsName}`;
}

/**
 * The tube an extracted-image folder belongs to: the BD CellView Image Extractor names the
 * folder `<tube>_images_<yyyymmdd_hhmm_ss>` beside the tube's FCS, and FlowJo names it after
 * the FCS file. Null for a folder named neither way.
 */
export function imageFolderStem(folderName: string): string | null {
  const m = /^(.*?)_images(?:_[\d_]+)?$/i.exec(folderName.trim());
  if (m && m[1]) return m[1];
  return null;
}

const stemOf = (name: string): string => name.replace(/\.[^.]*$/, "").normalize("NFC").toLocaleLowerCase();

/** Each FCS name's extracted-image folder, by the tube's name; an FCS without one is absent. */
export function pairImageFolders<T extends { readonly name: string }>(fcsNames: readonly string[], folders: readonly T[]): Map<string, T> {
  const byStem = new Map<string, T>();
  for (const folder of folders) {
    const stem = imageFolderStem(folder.name) ?? folder.name;
    byStem.set(stem.normalize("NFC").toLocaleLowerCase(), folder);
  }
  const out = new Map<string, T>();
  for (const name of fcsNames) {
    const hit = byStem.get(stemOf(name));
    if (hit) out.set(name, hit);
  }
  return out;
}

/** The name of the waveform file that would sit beside an FCS. */
export function sidecarNameFor(fcsName: string): string {
  const dot = fcsName.lastIndexOf(".");
  return (dot >= 0 ? fcsName.slice(0, dot) : fcsName) + CVW_EXTENSION;
}

export function isSidecarName(name: string): boolean {
  return extensionOf(name) === CVW_EXTENSION;
}

/** Split a list of picked files into the FCS files and the `.cvw` of each, matched by folder and stem. */
export function pairSidecars<T extends NamedSource>(sources: readonly T[]): PairedSources<T> {
  const fcs: T[] = [];
  const sidecars = new Map<string, T>();
  for (const source of sources) {
    const extension = extensionOf(source.name);
    if (extension === FCS_EXTENSION) fcs.push(source);
    else if (extension === CVW_EXTENSION) sidecars.set(`${folderOf(source)}\u0000${stem(source.name)}`, source);
  }
  const sidecarOf = new Map<T, T>();
  for (const file of fcs) {
    const sidecar = sidecars.get(`${folderOf(file)}\u0000${stem(file.name)}`);
    if (sidecar) sidecarOf.set(file, sidecar);
  }
  return { fcs, sidecarOf };
}
