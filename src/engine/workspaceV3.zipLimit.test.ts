// A portable workspace bundle that would come to more than one .zip can hold (4 GB) is refused,
// by name, before a byte is written: the writer has no ZIP64, so such an archive could not be reopened.

import { describe, expect, it } from "vitest";
import { writePortableWorkspaceV3Archive, type PortableWorkspaceV3ArchivePlan } from "./workspaceV3";

/** An entry that reports `byteLength` and fails the test if its bytes are ever read. */
function hugeEntry(byteLength: number, onRead: () => void): Uint8Array {
  const fake = Object.create(Uint8Array.prototype) as Uint8Array;
  Object.defineProperty(fake, "byteLength", { value: byteLength });
  Object.defineProperty(fake, "length", { value: byteLength });
  Object.defineProperty(fake, "subarray", {
    value: () => {
      onRead();
      throw new Error("the FCS bytes were read");
    },
  });
  return fake;
}

describe("a portable workspace bundle past 4 GB", () => {
  it("is refused before a byte is written", async () => {
    let read = false;
    const chunks: Uint8Array[] = [];
    const fcsBytes = 2 ** 32 + 100_000_000;
    const plan: PortableWorkspaceV3ArchivePlan = {
      entries: [
        { path: "workspace.json", bytes: new TextEncoder().encode("{}") },
        { path: "data/0_S1.fcs", bytes: hugeEntry(fcsBytes, () => { read = true; }) },
      ],
      payloadByteLength: 2 + fcsBytes,
      embeddedAssayCount: 0,
    };
    await expect(writePortableWorkspaceV3Archive(plan, (chunk) => { chunks.push(chunk); }))
      .rejects.toThrow(/workspace bundle comes to 4\.4 GB in 2 files, more than one \.zip can hold .*nothing was written/);
    expect(read).toBe(false);
    expect(chunks).toHaveLength(0);
  });

  it("is written when it fits", async () => {
    const chunks: Uint8Array[] = [];
    const plan: PortableWorkspaceV3ArchivePlan = {
      entries: [{ path: "workspace.json", bytes: new TextEncoder().encode("{}") }],
      payloadByteLength: 2,
      embeddedAssayCount: 0,
    };
    await writePortableWorkspaceV3Archive(plan, (chunk) => { chunks.push(chunk); });
    expect(chunks.reduce((n, c) => n + c.length, 0)).toBeGreaterThan(0);
  });
});
