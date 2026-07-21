// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickDirectoryFiles,
  pickFile,
  pickFileSource,
  pickFiles,
  saveAsHandleStream,
  writeHandleStream,
} from "./fsAccess";

describe("pickFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens custom workspace sources without an unreliable native MIME filter on first open", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b])], "example.gatelab");
    const handle = { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });

    const picked = await pickFileSource(null, "GateLab workspace", { id: "gatelab-open-workspace" });

    expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
    expect(showOpenFilePicker).toHaveBeenCalledWith({
      multiple: false,
      id: "gatelab-open-workspace",
    });
    expect(picked?.name).toBe("example.gatelab");
    expect(picked?.file).toBe(file);
    expect(picked?.handle).toBe(handle);
  });

  it("returns null when the first picker is cancelled", async () => {
    const cancelled = new DOMException("Cancelled", "AbortError");
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: vi.fn().mockRejectedValue(cancelled),
    });

    await expect(pickFile({ "application/json": [".gatelab"] }, "GateLab workspace")).resolves.toBeNull();
  });

  it("can retain a single File source without eagerly reading its bytes", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "portable.gatelab");
    const handle = { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true,
      value: vi.fn().mockResolvedValue([handle]),
    });

    const picked = await pickFileSource(
      { "application/zip": [".gatelab"] },
      "GateLab workspace",
      { id: "gatelab-open-workspace" },
    );

    expect(picked).toMatchObject({ handle, file, name: "portable.gatelab" });
    expect(handle.getFile).toHaveBeenCalledTimes(1);
  });

  it("streams ordered chunks to existing and newly selected file handles", async () => {
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      createWritable: vi.fn().mockResolvedValue(writable),
    } as unknown as FileSystemFileHandle;

    await writeHandleStream(handle, async (write) => {
      await write(Uint8Array.from([1, 2]));
      await write(Uint8Array.from([3]));
    });
    expect(writable.write.mock.calls.map(([chunk]) => Array.from(chunk as Uint8Array)))
      .toEqual([[1, 2], [3]]);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();

    const secondWritable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const secondHandle = {
      createWritable: vi.fn().mockResolvedValue(secondWritable),
    } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showSaveFilePicker", {
      configurable: true,
      value: vi.fn().mockResolvedValue(secondHandle),
    });
    await expect(saveAsHandleStream(
      "portable.gatelab",
      { "application/zip": [".gatelab"] },
      "GateLab workspace",
      async (write) => write(Uint8Array.from([4, 5])),
    )).resolves.toBe(secondHandle);
    expect(secondWritable.write).toHaveBeenCalledTimes(1);
    expect(secondWritable.close).toHaveBeenCalledTimes(1);
  });

  it("aborts a partial streamed file when its producer fails", async () => {
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      createWritable: vi.fn().mockResolvedValue(writable),
    } as unknown as FileSystemFileHandle;

    await expect(writeHandleStream(handle, async (write) => {
      await write(Uint8Array.from([1, 2]));
      throw new Error("synthetic archive failure");
    })).rejects.toThrow("synthetic archive failure");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });

  it("requests and returns every file from the multi-file picker", async () => {
    const files = [
      new File([new Uint8Array([1])], "a.fcs"),
      new File([new Uint8Array([2])], "b.fcs"),
    ];
    const handles = files.map((file) => ({ getFile: vi.fn().mockResolvedValue(file) })) as unknown as FileSystemFileHandle[];
    const showOpenFilePicker = vi.fn().mockResolvedValue(handles);
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });

    const picked = await pickFiles(
      { "application/octet-stream": [".fcs"] },
      "FCS files",
      { id: "gatelab-open-fcs" },
    );

    expect(showOpenFilePicker).toHaveBeenCalledWith({
      types: [{ description: "FCS files", accept: { "application/octet-stream": [".fcs"] } }],
      multiple: true,
      id: "gatelab-open-fcs",
    });
    expect(picked?.map((file) => file.name)).toEqual(["a.fcs", "b.fcs"]);
    expect(picked?.map((file) => file.file)).toEqual(files);
  });

  it("enumerates FCS files recursively from a selected directory", async () => {
    const rootFile = new File([new Uint8Array([1])], "root.fcs");
    const nestedFile = new File([new Uint8Array([2])], "nested.FCS");
    const ignoredFile = new File([new Uint8Array([3])], "notes.txt");
    const rootFcsHandle = { kind: "file", name: "root.fcs", getFile: vi.fn().mockResolvedValue(rootFile) };
    const nestedFcsHandle = { kind: "file", name: "nested.FCS", getFile: vi.fn().mockResolvedValue(nestedFile) };
    const ignoredHandle = { kind: "file", name: "notes.txt", getFile: vi.fn().mockResolvedValue(ignoredFile) };
    const nestedDirectory = {
      kind: "directory",
      name: "batch",
      async *values() { yield nestedFcsHandle; },
    };
    const rootDirectory = {
      kind: "directory",
      name: "cytometry",
      async *values() {
        yield ignoredHandle;
        yield nestedDirectory;
        yield rootFcsHandle;
      },
    };
    const showDirectoryPicker = vi.fn().mockResolvedValue(rootDirectory);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: showDirectoryPicker });

    const picked = await pickDirectoryFiles([".fcs"], { id: "gatelab-open-fcs-folder" });

    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "read", id: "gatelab-open-fcs-folder" });
    expect(picked?.name).toBe("cytometry");
    expect(picked?.files.map((file) => file.relativePath)).toEqual(["batch/nested.FCS", "root.fcs"]);
  });
});
