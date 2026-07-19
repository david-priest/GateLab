// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { pickDirectoryFiles, pickFile, pickFiles } from "./fsAccess";

describe("pickFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a stable picker id and the complete workspace accept map on first open", async () => {
    const accept = {
      "application/json": [".gatelab"],
      "application/zip": [".gatelab"],
    };
    const file = new File([new Uint8Array([0x50, 0x4b])], "example.gatelab");
    const handle = { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle;
    const showOpenFilePicker = vi.fn().mockResolvedValue([handle]);
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: showOpenFilePicker });

    const picked = await pickFile(accept, "GateLab workspace", { id: "gatelab-open-workspace" });

    expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
    expect(showOpenFilePicker).toHaveBeenCalledWith({
      types: [{ description: "GateLab workspace", accept }],
      multiple: false,
      id: "gatelab-open-workspace",
    });
    expect(picked?.name).toBe("example.gatelab");
    expect(Array.from(picked?.bytes ?? [])).toEqual([0x50, 0x4b]);
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
