// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PICKER_ID,
  lastPickerLocation,
  pickDirectoryFiles,
  pickFile,
  pickFileSource,
  pickFiles,
  pickFilesOrInput,
  readFromHandleIfPermitted,
  resetPickerLocation,
  saveAsHandle,
  saveAsHandleStream,
  writeHandleStream,
} from "./fsAccess";

describe("pickFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPickerLocation();
  });

  it("opens custom workspace sources without an unreliable native MIME filter on first open", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b])], "example.gatelab");
    const handle = { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });

    const picked = await pickFileSource(null, "GateLab workspace", { id: "gatelab" });

    expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
    expect(showOpenFilePicker).toHaveBeenCalledWith({
      multiple: false,
      id: PICKER_ID,
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
      { id: "gatelab" },
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
      { id: "gatelab" },
    );

    expect(showOpenFilePicker).toHaveBeenCalledWith({
      types: [{ description: "FCS files", accept: { "application/octet-stream": [".fcs"] } }],
      multiple: true,
      id: PICKER_ID,
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

    const picked = await pickDirectoryFiles([".fcs"], { id: "gatelab" });

    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "read", id: PICKER_ID });
    expect(picked?.name).toBe("cytometry");
    expect(picked?.files.map((file) => file.relativePath)).toEqual(["batch/nested.FCS", "root.fcs"]);
  });

  it("can start workspace relinking beside the workspace file", async () => {
    const workspaceHandle = { kind: "file", name: "analysis.gatelab" } as FileSystemFileHandle;
    const rootDirectory = {
      kind: "directory",
      name: "analysis",
      async *values() {},
    };
    const showDirectoryPicker = vi.fn().mockResolvedValue(rootDirectory);
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: showDirectoryPicker,
    });

    await pickDirectoryFiles([".fcs"], {
      id: "gatelab",
      startIn: workspaceHandle,
    });

    expect(showDirectoryPicker).toHaveBeenCalledWith({
      mode: "read",
      id: PICKER_ID,
      startIn: workspaceHandle,
    });
  });

  it("does not request permission separately for every remembered FCS handle", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    const getFile = vi.fn();
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("prompt"),
      requestPermission,
      getFile,
    } as unknown as FileSystemFileHandle;

    await expect(readFromHandleIfPermitted(handle)).resolves.toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
  });

  it("silently reuses a remembered FCS handle when permission is already granted", async () => {
    const bytes = Uint8Array.from([70, 67, 83]);
    const file = testFileWithArrayBuffer("remembered.fcs", bytes);
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      requestPermission: vi.fn(),
      getFile: vi.fn().mockResolvedValue(file),
    } as unknown as FileSystemFileHandle;

    await expect(readFromHandleIfPermitted(handle)).resolves.toEqual({
      bytes,
      name: "remembered.fcs",
    });
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });
});

function testFileWithArrayBuffer(name: string, bytes: Uint8Array): File {
  const file = new File([bytes.slice().buffer as ArrayBuffer], name);
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes.slice().buffer,
  });
  return file;
}

describe("every picker starts where the last one ended", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetPickerLocation();
  });

  it("passes the last opened handle as startIn to the next open, folder and save pickers", async () => {
    const file = new File([new Uint8Array([1])], "run1.fcs");
    const fcsHandle = { kind: "file", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    const showOpenFilePicker = vi.fn().mockResolvedValue([fcsHandle]);
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });
    expect(lastPickerLocation()).toBeNull();
    await pickFiles({ "application/octet-stream": [".fcs"] }, "FCS files");
    expect(showOpenFilePicker).toHaveBeenLastCalledWith(expect.objectContaining({ id: PICKER_ID }));
    expect(showOpenFilePicker.mock.calls[0][0]).not.toHaveProperty("startIn");
    expect(lastPickerLocation()).toBe(fcsHandle);

    // A different button, a different picker kind: same id, and it opens beside the last file.
    const csvHandle = { kind: "file", getFile: vi.fn().mockResolvedValue(new File(["a,b"], "scheme.csv")) } as unknown as FileSystemFileHandle;
    showOpenFilePicker.mockResolvedValue([csvHandle]);
    await pickFileSource({ "text/csv": [".csv"] }, "Barcode scheme table");
    expect(showOpenFilePicker).toHaveBeenLastCalledWith({ types: [{ description: "Barcode scheme table", accept: { "text/csv": [".csv"] } }], multiple: false, id: PICKER_ID, startIn: fcsHandle });
    expect(lastPickerLocation()).toBe(csvHandle);

    const dirHandle = { kind: "directory", name: "exp", values: async function* () {} } as unknown as FileSystemDirectoryHandle;
    const showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: showDirectoryPicker });
    await pickDirectoryFiles([".fcs"]);
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "read", id: PICKER_ID, startIn: csvHandle });
    expect(lastPickerLocation()).toBe(dirHandle);

    const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    const savedHandle = { kind: "file", createWritable: vi.fn().mockResolvedValue(writable) } as unknown as FileSystemFileHandle;
    const showSaveFilePicker = vi.fn().mockResolvedValue(savedHandle);
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: showSaveFilePicker });
    await saveAsHandle("ws.gatelab", { "application/zip": [".gatelab"] }, "GateLab workspace", new Uint8Array([1]));
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: "ws.gatelab",
      types: [{ description: "GateLab workspace", accept: { "application/zip": [".gatelab"] } }],
      id: PICKER_ID,
      startIn: dirHandle,
    });
    expect(lastPickerLocation()).toBe(savedHandle);
  });

  it("an explicit startIn wins for that picker only, and a cancelled picker changes nothing", async () => {
    const wsHandle = { kind: "file" } as unknown as FileSystemFileHandle;
    const dirHandle = { kind: "directory", name: "exp", values: async function* () {} } as unknown as FileSystemDirectoryHandle;
    const showDirectoryPicker = vi.fn().mockResolvedValue(dirHandle);
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: showDirectoryPicker });
    await pickDirectoryFiles([".fcs"], { startIn: wsHandle });
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: "read", id: PICKER_ID, startIn: wsHandle });
    const cancelled = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: cancelled });
    expect(await pickFile(null, "Anything")).toBeNull();
    expect(lastPickerLocation()).toBe(dirHandle);
  });

  it("pickFilesOrInput uses the picker when available and the hidden input otherwise", async () => {
    const input = document.createElement("input");
    input.type = "file";
    const click = vi.spyOn(input, "click");
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
    expect(await pickFilesOrInput(input, { "text/csv": [".csv"] }, "Table")).toBeNull();
    expect(click).toHaveBeenCalledTimes(1);

    const file = new File(["a"], "t.csv");
    const handle = { kind: "file", getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: vi.fn().mockResolvedValue([handle]) });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: vi.fn() });
    expect(await pickFilesOrInput(input, { "text/csv": [".csv"] }, "Table")).toEqual([file]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(lastPickerLocation()).toBe(handle);
  });
});
