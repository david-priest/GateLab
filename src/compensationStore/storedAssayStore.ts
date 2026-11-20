// The compensated values of every matrix applied to a file in this session, so using one again
// installs its values instead of solving again, and a bundle can be saved with all of them
// (David, 2026-11-20: "if there are multiple matrices for cytof data, then the compensated data
// should be stored for each of them, not recomputed each time, and not recomputed upon re-opening
// the workspace"). The bundle format is src/engine/workspaceStoredAssays.ts.
//
// A layer is kept under the FCS file's SHA-256 and the signature of its binding
// (compensatedBindingSignature), the identity the compensation cache uses. Its columns are, in turn:
// - in memory, the very arrays the file holds while the matrix is in use (no copy);
// - on disk once another matrix replaces it, in the browser's private file storage (OPFS) for this
//   tab, or still in memory where the browser has none;
// - in an opened bundle, read from the bundle's File when needed.
// Installing a layer is the App's, through Sample.prepareCompensatedLayer, which checks the values
// against the binding again.

import type { Sha256Digest } from "../engine/compensationProfile";
import { compensatedBindingSignature, digestBytesSha256 } from "../engine/compensationCache";
import type { CompensatedLayerColumn, Sample } from "../engine/sample";
import type { PersistedCompensatedLayerBinding } from "../engine/workspaceCompensation";
import {
  decodeFloat32LittleEndian,
  float32ColumnBytes,
  readStoredAssayColumn,
  type StoredAssayArchive,
  type StoredAssayColumnManifest,
  type StoredAssayLayerSource,
} from "../engine/workspaceStoredAssays";

/** Where a stored layer's column is now. */
type ColumnSource =
  | Readonly<{ kind: "memory"; values: Float32Array }>
  | Readonly<{ kind: "disk"; name: string }>
  | Readonly<{ kind: "bundle"; archive: StoredAssayArchive; column: StoredAssayColumnManifest; eventCount: number }>;

export interface StoredColumn {
  readonly pnn: string;
  readonly fcsColumnIndex: number;
  readonly byteLength: number;
  digest: Sha256Digest | null;
  source: ColumnSource;
}

export interface StoredLayer {
  readonly fcsDigest: Sha256Digest;
  readonly eventCount: number;
  readonly profileId: string;
  readonly profileHash: Sha256Digest;
  readonly matrixHash: Sha256Digest;
  readonly bindingSignature: string;
  readonly columns: StoredColumn[];
  /** When the layer was last installed or recorded, for choosing what a full bundle leaves out. */
  lastUsed: number;
}

/** Files on disk for this tab's stored columns. */
export interface StoredColumnDisk {
  write(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string): Promise<Uint8Array>;
  remove(name: string): Promise<void>;
}

export function storedLayerKey(fcsDigest: string, bindingSignature: string): string {
  return `${fcsDigest}\n${bindingSignature}`;
}

/** The Float32 arrays of the layer a file holds now, by reference, in its binding's order. */
function installedColumns(sample: Sample, binding: PersistedCompensatedLayerBinding): CompensatedLayerColumn[] | null {
  if (sample.compensatedLayerStatus(binding).state !== "ready") return null;
  const columns: CompensatedLayerColumn[] = [];
  for (const expected of binding.channelBindings.filter(({ included }) => included)) {
    const index = sample.channels.findIndex(({ pnn, columnIndex }) => pnn === expected.pnn && columnIndex === expected.fcsColumnIndex);
    if (index < 0) return null;
    const values = sample.compensatedColumnData(index, binding);
    if (!(values instanceof Float32Array) || values.length !== sample.fcs.nEvents) return null;
    columns.push({ pnn: expected.pnn, fcsColumnIndex: expected.fcsColumnIndex, values });
  }
  return columns;
}

let diskNames = 0;

export class StoredAssayStore {
  private readonly layers = new Map<string, StoredLayer>();
  private clock = 0;

  constructor(private disk: StoredColumnDisk | null = null) {}

  /** Set once the tab's folder is open; layers held in memory until then move there at the next spill. */
  attachDisk(disk: StoredColumnDisk): void {
    this.disk ??= disk;
  }

  get size(): number {
    return this.layers.size;
  }

  find(fcsDigest: string, bindingSignature: string): StoredLayer | undefined {
    return this.layers.get(storedLayerKey(fcsDigest, bindingSignature));
  }

  all(): readonly StoredLayer[] {
    return [...this.layers.values()];
  }

  touch(layer: StoredLayer): void {
    layer.lastUsed = ++this.clock;
  }

  /**
   * Records the layer a file is compensated with now. Its arrays are the file's own, so nothing is
   * copied while it is in use; a layer already stored is only marked used.
   */
  recordInstalled(fcsDigest: Sha256Digest, sample: Sample, binding: PersistedCompensatedLayerBinding): boolean {
    const signature = compensatedBindingSignature(binding);
    const existing = this.find(fcsDigest, signature);
    if (existing) {
      this.touch(existing);
      return true;
    }
    const columns = installedColumns(sample, binding);
    if (!columns) return false;
    this.layers.set(storedLayerKey(fcsDigest, signature), {
      fcsDigest,
      eventCount: sample.fcs.nEvents,
      profileId: binding.profileId,
      profileHash: binding.profileHash,
      matrixHash: binding.matrixHash,
      bindingSignature: signature,
      columns: columns.map(({ pnn, fcsColumnIndex, values }) => ({
        pnn,
        fcsColumnIndex,
        byteLength: values.byteLength,
        digest: null,
        source: { kind: "memory", values },
      })),
      lastUsed: ++this.clock,
    });
    return true;
  }

  /** Registers an opened bundle's stored layers; a layer already held here is kept as it is. */
  addBundle(archive: StoredAssayArchive): number {
    let added = 0;
    for (const layer of archive.manifest.layers) {
      const key = storedLayerKey(layer.fcsDigest, layer.bindingSignature);
      if (this.layers.has(key)) continue;
      this.layers.set(key, {
        fcsDigest: layer.fcsDigest,
        eventCount: layer.eventCount,
        profileId: layer.profileId,
        profileHash: layer.profileHash,
        matrixHash: layer.matrixHash,
        bindingSignature: layer.bindingSignature,
        columns: layer.columns.map((column) => ({
          pnn: column.pnn,
          fcsColumnIndex: column.fcsColumnIndex,
          byteLength: column.byteLength,
          digest: column.digest,
          source: { kind: "bundle", archive, column, eventCount: layer.eventCount },
        })),
        lastUsed: 0,
      });
      added++;
    }
    return added;
  }

  /**
   * After a bundle was written to the file the store reads from: its layers are read from the new
   * File from now on (the old one may no longer be readable), and the columns held on disk or in
   * memory that the bundle now holds are let go there.
   */
  async rebindToBundle(archive: StoredAssayArchive): Promise<void> {
    for (const manifestLayer of archive.manifest.layers) {
      const layer = this.find(manifestLayer.fcsDigest, manifestLayer.bindingSignature);
      if (!layer || layer.columns.length !== manifestLayer.columns.length) continue;
      for (let index = 0; index < layer.columns.length; index++) {
        const column = layer.columns[index];
        const written = manifestLayer.columns[index];
        if (column.digest !== null && column.digest !== written.digest) continue;
        // A column in memory is a file's own while its matrix is in use: it stays in memory.
        if (column.source.kind === "memory") continue;
        const previous = column.source;
        column.source = { kind: "bundle", archive, column: written, eventCount: manifestLayer.eventCount };
        column.digest = written.digest;
        if (previous.kind === "disk") await this.disk?.remove(previous.name).catch(() => undefined);
      }
    }
  }

  /**
   * Moves to disk each layer held in memory that no file is compensated with now (`installed`
   * holds the keys of those that are), so a matrix that was replaced does not stay in memory.
   * Without a disk the layer stays in memory.
   */
  async spill(installed: ReadonlySet<string>): Promise<void> {
    if (!this.disk) return;
    for (const [key, layer] of this.layers) {
      if (installed.has(key)) continue;
      for (const column of layer.columns) {
        if (column.source.kind !== "memory") continue;
        const bytes = float32ColumnBytes(column.source.values);
        column.digest ??= await digestBytesSha256(bytes);
        const name = `${Date.now().toString(36)}-${(++diskNames).toString(36)}.f32`;
        try {
          await this.disk.write(name, bytes);
          column.source = { kind: "disk", name };
        } catch {
          // Kept in memory: the disk is full or unavailable.
        }
      }
    }
  }

  /** Drops the layers of profiles the workspace no longer holds, and their files on disk. */
  async retainProfiles(profileIds: ReadonlySet<string>): Promise<void> {
    for (const [key, layer] of [...this.layers]) {
      if (profileIds.has(layer.profileId)) continue;
      this.layers.delete(key);
      for (const column of layer.columns) {
        if (column.source.kind === "disk") await this.disk?.remove(column.source.name).catch(() => undefined);
      }
    }
  }

  /** A column's little-endian Float32 bytes. */
  async columnBytes(column: StoredColumn): Promise<Uint8Array> {
    const source = column.source;
    if (source.kind === "memory") return float32ColumnBytes(source.values);
    if (source.kind === "disk") {
      if (!this.disk) throw new Error("The stored values are no longer on disk.");
      return this.disk.read(source.name);
    }
    return float32ColumnBytes(await readStoredAssayColumn(source.archive, source.column, source.eventCount));
  }

  /** A layer's values, as new arrays a file can be given, in its binding's order. */
  async readColumns(layer: StoredLayer): Promise<CompensatedLayerColumn[]> {
    const columns: CompensatedLayerColumn[] = [];
    for (const column of layer.columns) {
      const source = column.source;
      const values = source.kind === "memory"
        ? source.values
        : source.kind === "bundle"
          ? await readStoredAssayColumn(source.archive, source.column, source.eventCount)
          : decodeFloat32LittleEndian(await this.columnBytes(column), layer.eventCount);
      columns.push({ pnn: column.pnn, fcsColumnIndex: column.fcsColumnIndex, values });
    }
    this.touch(layer);
    return columns;
  }

  /** The layer as the bundle writer takes it, its digests worked out first. */
  async bundleSource(layer: StoredLayer, dataPath: string): Promise<StoredAssayLayerSource> {
    for (const column of layer.columns) column.digest ??= await digestBytesSha256(await this.columnBytes(column));
    return {
      dataPath,
      fcsDigest: layer.fcsDigest,
      eventCount: layer.eventCount,
      profileId: layer.profileId,
      profileHash: layer.profileHash,
      matrixHash: layer.matrixHash,
      bindingSignature: layer.bindingSignature,
      columns: layer.columns.map((column) => ({
        pnn: column.pnn,
        fcsColumnIndex: column.fcsColumnIndex,
        byteLength: column.byteLength,
        digest: column.digest!,
        read: () => this.columnBytes(column),
      })),
    };
  }
}

const OPFS_ROOT = "gatelab-stored-assays";

/**
 * This tab's folder in the browser's private file storage, or null where the browser has none.
 * Each tab holds a lock on its folder while it is open; a folder whose lock no tab holds is left
 * from a closed tab and is removed.
 */
export async function openStoredColumnDisk(): Promise<StoredColumnDisk | null> {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    if (!storage?.getDirectory || !locks?.request) return null;
    const root = await (await storage.getDirectory()).getDirectoryHandle(OPFS_ROOT, { create: true });
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await new Promise<void>((held) => {
      void locks.request(`${OPFS_ROOT}:${id}`, () => {
        held();
        return new Promise<never>(() => undefined);
      });
    });
    const folder = await root.getDirectoryHandle(id, { create: true });
    // Folders of closed tabs, in the background.
    void (async () => {
      const entries = (root as unknown as { keys(): AsyncIterable<string> }).keys();
      for await (const name of entries) {
        if (name === id) continue;
        await locks.request(`${OPFS_ROOT}:${name}`, { ifAvailable: true }, async (lock) => {
          if (lock) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
        });
      }
    })().catch(() => undefined);
    return {
      async write(name, bytes) {
        const handle = await folder.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes as unknown as FileSystemWriteChunkType);
          await writable.close();
        } catch (cause) {
          await writable.abort().catch(() => undefined);
          throw cause;
        }
      },
      async read(name) {
        const file = await (await folder.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      },
      async remove(name) {
        await folder.removeEntry(name);
      },
    };
  } catch {
    return null;
  }
}
