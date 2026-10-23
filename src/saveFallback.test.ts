// @vitest-environment jsdom
// A browser that hands GateLab a file handle and then refuses to write it: the bytes are
// downloaded under the chosen name, the empty file the dialog made is dealt with, and a refusal
// "not allowed in this context" sends later saves straight to a download.

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWritesRefused, resetHandleWritesRefused, saveToNewFile, saveToOpenFile } from "./saveFallback";
import { resetHandleReadsRefused, supportsFileSystemAccess } from "./engine/fsAccess";
import { resetPickerLocation } from "./engine/fsAccess";

const TARGET = {
  suggestedName: "D1.gatelab",
  accept: { "application/octet-stream": [".gatelab"] },
  description: "GateLab workspace",
  mime: "application/octet-stream",
};
const notAllowed = () =>
  new DOMException("The request is not allowed by the user agent or the platform in the current context.", "NotAllowedError");

interface FakeHandle {
  name: string;
  /** What the file holds; the dialog makes it empty. */
  bytes: Uint8Array;
  writes: Uint8Array[];
  aborted: number;
  createWritable: ReturnType<typeof vi.fn>;
  getFile: () => Promise<File>;
  queryPermission: () => Promise<PermissionState>;
  remove?: ReturnType<typeof vi.fn>;
}

/** A handle whose write fails at `failAt` ("open" for createWritable, else the nth write, or close). */
function fakeHandle(name: string, failAt: "open" | "close" | number | null, error: () => Error = notAllowed): FakeHandle {
  const handle: FakeHandle = {
    name,
    bytes: new Uint8Array(0),
    writes: [],
    aborted: 0,
    createWritable: vi.fn(async () => {
      if (failAt === "open") throw error();
      const pending: Uint8Array[] = [];
      return {
        write: async (data: Uint8Array) => {
          if (failAt === pending.length) throw error();
          pending.push(new Uint8Array(data));
        },
        close: async () => {
          if (failAt === "close") throw error();
          handle.writes = pending;
          handle.bytes = concat(pending);
        },
        abort: async () => { handle.aborted++; },
      };
    }),
    getFile: async () => new File([handle.bytes as BlobPart], name),
    queryPermission: async () => "granted",
  };
  return handle;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

function stubSavePicker(handle: FakeHandle | (() => never)) {
  const picker = vi.fn(async () => (typeof handle === "function" ? handle() : handle));
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: picker });
  return picker;
}

function downloads() {
  const got: { name: string; bytes: Promise<Uint8Array>; type: string }[] = [];
  const download = (name: string, blob: Blob) => {
    got.push({ name, type: blob.type, bytes: blob.arrayBuffer().then((b) => new Uint8Array(b)) });
  };
  return { got, download };
}

const CHUNKS = [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]), Uint8Array.from([6])];
const produceChunks = async (write: (chunk: Uint8Array) => Promise<void>) => {
  for (const chunk of CHUNKS) await write(chunk);
};

afterEach(() => {
  resetHandleWritesRefused();
  resetHandleReadsRefused();
  resetPickerLocation();
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
});

describe("saveToNewFile", () => {
  it("downloads the bytes under the chosen name when createWritable is refused, and removes the empty file", async () => {
    const handle = fakeHandle("chosen name.gatelab", "open");
    handle.remove = vi.fn(async () => undefined);
    stubSavePicker(handle);
    const { got, download } = downloads();

    const outcome = await saveToNewFile(TARGET, { data: Uint8Array.from([7, 8, 9]) }, download);

    expect(outcome.kind).toBe("downloaded");
    expect(got.map((d) => d.name)).toEqual(["chosen name.gatelab"]);
    expect(await got[0].bytes).toEqual(Uint8Array.from([7, 8, 9]));
    expect(got[0].type).toBe("application/octet-stream");
    expect(handle.remove).toHaveBeenCalledTimes(1);
    expect(outcome.kind === "downloaded" && outcome.message).toBe(
      "This browser would not let GateLab write to the file you chose, so it was downloaded instead: chosen name.gatelab. " +
        "The empty file the save dialog made there was removed.",
    );
    expect(handleWritesRefused()).toBe(true);
    // Opening goes through the ordinary file chooser from then on too.
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn() });
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it("says the file where the user chose is empty when the browser will not remove it either", async () => {
    const handle = fakeHandle("chosen.gatelab", "open");
    handle.remove = vi.fn(async () => { throw notAllowed(); });
    stubSavePicker(handle);
    const { got, download } = downloads();

    const outcome = await saveToNewFile(TARGET, { data: Uint8Array.from([1]) }, download);

    expect(got.map((d) => d.name)).toEqual(["chosen.gatelab"]);
    expect(outcome.kind === "downloaded" && outcome.message).toContain(
      "The file chosen.gatelab where you chose is empty; the download holds what was saved.",
    );
  });

  it("downloads every chunk a producer makes when a write fails part way, and does not remove a file that is not empty", async () => {
    const handle = fakeHandle("bundle.gatelab", 1, () => new Error("The disk is full."));
    handle.bytes = Uint8Array.from([42]); // a file already there, which the browser left as it was
    handle.remove = vi.fn(async () => undefined);
    stubSavePicker(handle);
    const { got, download } = downloads();

    const outcome = await saveToNewFile({ ...TARGET, mime: "application/zip" }, { produce: produceChunks }, download);

    expect(handle.aborted).toBe(1);
    expect(await got[0].bytes).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    expect(got[0].type).toBe("application/zip");
    expect(handle.remove).not.toHaveBeenCalled();
    expect(outcome.kind === "downloaded" && outcome.message).toContain("The file bundle.gatelab where you chose was not changed.");
    // A full disk is this file's trouble, not the browser's: the next save still asks where.
    expect(handleWritesRefused()).toBe(false);
  });

  it("falls back when close fails", async () => {
    const handle = fakeHandle("chosen.gatelab", "close");
    stubSavePicker(handle);
    const { got, download } = downloads();
    const outcome = await saveToNewFile(TARGET, { data: Uint8Array.from([5]) }, download);
    expect(outcome.kind).toBe("downloaded");
    expect(await got[0].bytes).toEqual(Uint8Array.from([5]));
    // No remove() in this browser: the empty file is named, not removed.
    expect(outcome.kind === "downloaded" && outcome.message).toContain("is empty");
  });

  it("downloads without a save dialog once the browser has refused a write as not allowed", async () => {
    const first = fakeHandle("first.gatelab", "open");
    const picker = stubSavePicker(first);
    const { got, download } = downloads();
    await saveToNewFile(TARGET, { data: Uint8Array.from([1]) }, download);

    const outcome = await saveToNewFile(TARGET, { data: Uint8Array.from([2]) }, download);

    expect(picker).toHaveBeenCalledTimes(1);
    expect(got.map((d) => d.name)).toEqual(["first.gatelab", "D1.gatelab"]);
    expect(await got[1].bytes).toEqual(Uint8Array.from([2]));
    expect(outcome).toEqual({
      kind: "downloaded",
      name: "D1.gatelab",
      message: "This browser would not let GateLab write to a file earlier in this session, so this was downloaded instead: D1.gatelab.",
    });
  });

  it("writes and returns the handle when the browser allows it, with nothing downloaded", async () => {
    const handle = fakeHandle("ok.gatelab", null);
    stubSavePicker(handle);
    const { got, download } = downloads();
    const outcome = await saveToNewFile(TARGET, { produce: produceChunks }, download);
    expect(outcome).toEqual({ kind: "written", handle });
    expect(handle.bytes).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    expect(got).toEqual([]);
  });

  it("is cancelled when the dialog is dismissed", async () => {
    stubSavePicker(() => { throw new DOMException("", "AbortError"); });
    const { got, download } = downloads();
    expect(await saveToNewFile(TARGET, { data: Uint8Array.from([1]) }, download)).toEqual({ kind: "cancelled" });
    expect(got).toEqual([]);
  });
});

describe("saveToOpenFile", () => {
  it("downloads under the open file's name and leaves the file as it was", async () => {
    const handle = fakeHandle("open.gatelab", "open");
    handle.bytes = Uint8Array.from([9, 9]);
    const { got, download } = downloads();

    const outcome = await saveToOpenFile(handle as unknown as FileSystemFileHandle, { data: Uint8Array.from([3, 4]) }, "application/octet-stream", download);

    expect(got.map((d) => d.name)).toEqual(["open.gatelab"]);
    expect(await got[0].bytes).toEqual(Uint8Array.from([3, 4]));
    expect(handle.bytes).toEqual(Uint8Array.from([9, 9]));
    expect(outcome.kind === "downloaded" && outcome.message).toBe(
      "This browser would not let GateLab write to open.gatelab, so it was downloaded instead: open.gatelab. The file you opened was not changed.",
    );
    expect(handleWritesRefused()).toBe(true);
  });

  it("downloads a producer's chunks when the streamed write fails", async () => {
    const handle = fakeHandle("open.gatelab", 2, () => new Error("locked"));
    const { got, download } = downloads();
    const outcome = await saveToOpenFile(handle as unknown as FileSystemFileHandle, { produce: produceChunks }, "application/zip", download);
    expect(outcome.kind).toBe("downloaded");
    expect(await got[0].bytes).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    expect(handleWritesRefused()).toBe(false);
  });

  it("writes in place when the browser allows it", async () => {
    const handle = fakeHandle("open.gatelab", null);
    const { got, download } = downloads();
    const outcome = await saveToOpenFile(handle as unknown as FileSystemFileHandle, { data: Uint8Array.from([3]) }, "application/octet-stream", download);
    expect(outcome.kind).toBe("written");
    expect(handle.bytes).toEqual(Uint8Array.from([3]));
    expect(got).toEqual([]);
  });
});
