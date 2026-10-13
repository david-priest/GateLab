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
export function imageHandleKey(kind: "cvw", fcsName: string): string {
  return `${kind}:${fcsName}`;
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
