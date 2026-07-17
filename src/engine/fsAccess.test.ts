// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { pickFile } from "./fsAccess";

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
});
