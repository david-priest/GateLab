// testDirectory.ts — an in-memory folder standing in for the File System Access API's directory
// and file handles, for tests that write a folder and read it back. Test-only: nothing in the app
// imports this.

/** A File whose bytes jsdom's File serves through arrayBuffer, text and stream alike. */
export function memoryFile(name: string, bytes: Uint8Array): File {
  const data = bytes.slice();
  const file = new File([data as BlobPart], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => data.slice().buffer });
  Object.defineProperty(file, "text", { value: async () => new TextDecoder().decode(data) });
  Object.defineProperty(file, "stream", {
    value: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data.slice()); controller.close(); } }),
  });
  Object.defineProperty(file, "slice", {
    value: (start?: number, end?: number) => memoryFile(name, data.slice(start, end)),
  });
  return file;
}

const toBytes = async (data: unknown): Promise<Uint8Array> => {
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") return new Uint8Array((data as ArrayBuffer).slice(0));
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(await (data as Blob).arrayBuffer());
};

/**
 * What a test folder refuses, as the browser would: a name Chrome will not write (it throws a
 * TypeError, "Name is not allowed."), and a folder, file or write that fails as a full disk does.
 * Shared by a folder and everything made in it.
 */
export interface MemoryFolderRules {
  refuse?: (name: string) => boolean;
  /** `path` is relative to the root folder. */
  fail?: (path: string, step: "directory" | "file" | "write") => boolean;
  /**
   * Names as the disk compares them: a name whose fold an entry's name has opens that entry, which
   * keeps the name it was made with, as APFS does. Names are compared exactly where this is absent.
   */
  fold?: (name: string) => string;
}

// Full case folding (CaseFolding.txt, statuses C and F) of the characters the tests use, where it
// differs from toLowerCase of the one character.
const FULL_FOLDS: Record<string, string> = {
  "\u00b5": "\u03bc", "\u00df": "ss", "\u1e9e": "ss", "\u03c2": "\u03c3", "\u017f": "s", "\ufb01": "fi", "\u0149": "\u02bcn",
};

/**
 * A name as APFS compares it, for the characters the tests use: canonical decomposition and full
 * case folding, so the micro sign is Greek mu, "ß" is "ss" and "ﬁ" is "fi". Written out apart
 * from the export's own fold, so the two are not one rule tested against itself.
 */
export const apfsFold = (name: string): string =>
  [...name.normalize("NFD")].map((c) => FULL_FOLDS[c] ?? c.toLowerCase()).join("").normalize("NFD");

const diskFull = () => new DOMException("The disk is full.", "QuotaExceededError");

export class MemoryFileHandle {
  readonly kind = "file" as const;
  bytes = new Uint8Array(0);
  /** Every write call made to this file. */
  writes = 0;
  constructor(
    readonly name: string,
    private readonly log: string[],
    private readonly path: string,
    private readonly rules: MemoryFolderRules = {},
  ) {}
  async queryPermission(): Promise<PermissionState> { return "granted"; }
  async requestPermission(): Promise<PermissionState> { return "granted"; }
  async getFile(): Promise<File> { return memoryFile(this.name, this.bytes); }
  // As Chrome's: the bytes written reach the file only when the write closes, so a write that
  // fails leaves the file as it was, empty where it was just made.
  async createWritable() {
    const chunks: Uint8Array[] = [];
    return {
      write: async (data: unknown) => {
        this.writes++;
        if (this.rules.fail?.(this.path, "write")) throw diskFull();
        chunks.push(await toBytes(data));
      },
      close: async () => {
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
        this.bytes = out;
        this.log.push(this.path);
      },
      abort: async () => undefined,
    };
  }
}

/**
 * A folder: names compared exactly, or as `rules.fold` folds them, entries listed in the order
 * made. `log` records each file's path, relative to the root, as its write closes.
 */
export class MemoryDirectoryHandle {
  readonly kind = "directory" as const;
  readonly entries = new Map<string, MemoryDirectoryHandle | MemoryFileHandle>();
  constructor(
    readonly name: string,
    readonly log: string[] = [],
    private readonly path = "",
    readonly rules: MemoryFolderRules = {},
  ) {}
  private child(name: string): string { return this.path ? `${this.path}/${name}` : name; }
  private check(name: string): void {
    if (this.rules.refuse?.(name)) throw new TypeError("Name is not allowed.");
  }
  /** The entry the disk opens for `name`, and the name it has. */
  private find(name: string): [string, MemoryDirectoryHandle | MemoryFileHandle] | undefined {
    const fold = this.rules.fold;
    if (!fold) {
      const found = this.entries.get(name);
      return found && [name, found];
    }
    const key = fold(name);
    return [...this.entries].find(([entry]) => fold(entry) === key);
  }
  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryDirectoryHandle> {
    this.check(name);
    const found = this.find(name)?.[1];
    if (found) {
      if (found.kind !== "directory") throw new DOMException(`${name} is a file`, "TypeMismatchError");
      return found;
    }
    if (!options.create) throw new DOMException(`${name} was not found`, "NotFoundError");
    if (this.rules.fail?.(this.child(name), "directory")) throw diskFull();
    const made = new MemoryDirectoryHandle(name, this.log, this.child(name), this.rules);
    this.entries.set(name, made);
    return made;
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFileHandle> {
    this.check(name);
    const found = this.find(name)?.[1];
    if (found) {
      if (found.kind !== "file") throw new DOMException(`${name} is a folder`, "TypeMismatchError");
      return found;
    }
    if (!options.create) throw new DOMException(`${name} was not found`, "NotFoundError");
    if (this.rules.fail?.(this.child(name), "file")) throw diskFull();
    const made = new MemoryFileHandle(name, this.log, this.child(name), this.rules);
    this.entries.set(name, made);
    return made;
  }
  async removeEntry(name: string): Promise<void> {
    const found = this.find(name);
    if (!found) throw new DOMException(`${name} was not found`, "NotFoundError");
    this.entries.delete(found[0]);
  }
  async queryPermission(): Promise<PermissionState> { return "granted"; }
  async requestPermission(): Promise<PermissionState> { return "granted"; }
  async *values(): AsyncIterableIterator<MemoryDirectoryHandle | MemoryFileHandle> {
    for (const entry of this.entries.values()) yield entry;
  }
  /** A file already there, as a test puts one. */
  put(name: string, bytes: Uint8Array): MemoryFileHandle {
    const file = new MemoryFileHandle(name, this.log, this.child(name), this.rules);
    file.bytes = bytes.slice();
    this.entries.set(name, file);
    return file;
  }
  /** Every file below this folder, by its path relative to it. */
  files(prefix = ""): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [name, entry] of this.entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "file") out.set(path, entry.bytes);
      else for (const [p, b] of entry.files(path)) out.set(p, b);
    }
    return out;
  }
}

/** The handle as the app's code types it. */
export const asDirectory = (dir: MemoryDirectoryHandle): FileSystemDirectoryHandle => dir as unknown as FileSystemDirectoryHandle;
