// Saving to the lab Drive: Drive ignores If-Match, so GateLab reads the head revision before the
// write (refusing when it moved) and after it (reporting a save that overtook this one). Synthetic names.

import { describe, expect, it } from "vitest";
import {
  copyName,
  DriveFolderAccessError,
  SAVE_KEY,
  saveWorkspaceCopyToDrive,
  saveWorkspaceToDrive,
  WRITER_KEY,
} from "./save";
import { FakeDrive } from "./testFakeDrive";
import type { DriveTarget } from "./types";

const FOLDER = "EXPERIMENT_FOLDER_1";
const SOURCES = [
  { name: "D1_treated.fcs", sourcePath: "Drive: Experiment 1/D1_treated.fcs" },
  { name: "D2_control.fcs", sourcePath: "Drive: Experiment 1/D2_control.fcs" },
];
const json = (text: string) => new TextEncoder().encode(text);

function opened(drive: FakeDrive): DriveTarget {
  const id = drive.addOutside(FOLDER, "Experiment 1.gatelab", json("{\"v\":1}"));
  drive.pick(id);
  return { fileId: id, folderId: FOLDER, name: "Experiment 1.gatelab", experiment: "Experiment 1", headRevisionId: `${id}_rev1`, writerId: "tab-1" };
}

describe("saving to the lab Drive", () => {
  it("writes in place, marks the write as this tab's, and keeps the revision", async () => {
    const drive = new FakeDrive();
    const target = opened(drive);
    const result = await saveWorkspaceToDrive(drive, target, json("{\"v\":2}"), SOURCES);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(drive.text(target.fileId!)).toBe("{\"v\":2}");
    expect(result.target.headRevisionId).toBe(`${target.fileId}_rev2`);
    expect(result.overtakenBy).toBeNull();
    // Read before and after the write.
    expect(drive.calls).toEqual([
      `get ${target.fileId}`, `update ${target.fileId}`, `get ${target.fileId}`, `keep ${target.fileId} ${target.fileId}_rev2`,
    ]);
    const meta = await drive.getMetadata(target.fileId!);
    expect(meta.appProperties[WRITER_KEY]).toBe("tab-1");
    expect(meta.appProperties[SAVE_KEY]).toBeTruthy();
    expect(drive.kept).toEqual([`${target.fileId}_rev2`]);
  });

  it("refuses when another save moved the head revision, and writes nothing", async () => {
    const drive = new FakeDrive();
    const target = opened(drive);
    drive.externalWrite(target.fileId!, json("{\"v\":\"theirs\"}"));
    const result = await saveWorkspaceToDrive(drive, target, json("{\"v\":\"mine\"}"), SOURCES);
    expect(result).toMatchObject({ kind: "conflict", by: { name: "Member Two", email: "member2@lab.example.org" } });
    expect(drive.text(target.fileId!)).toBe("{\"v\":\"theirs\"}");
    expect(drive.calls.some((call) => call.startsWith("update"))).toBe(false);
  });

  it("reports a save that landed between this write and the read after it", async () => {
    const drive = new FakeDrive();
    const target = opened(drive);
    const update = drive.updateMedia.bind(drive);
    drive.updateMedia = async (fileId, meta, bytes) => {
      const written = await update(fileId, meta, bytes);
      drive.externalWrite(fileId, json("{\"v\":\"theirs\"}"));
      return written;
    };
    const result = await saveWorkspaceToDrive(drive, target, json("{\"v\":\"mine\"}"), SOURCES);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.overtakenBy).toMatchObject({ name: "Member Two" });
    // The revision recorded is this tab's own, so the next save here is refused, not written over theirs.
    expect(result.target.headRevisionId).toBe(`${target.fileId}_rev2`);
    expect((await saveWorkspaceToDrive(drive, result.target, json("{\"v\":3}"), SOURCES)).kind).toBe("conflict");
  });

  it("saves when keeping the revision forever fails, and says so", async () => {
    const drive = new FakeDrive();
    drive.failKeep = true;
    const result = await saveWorkspaceToDrive(drive, opened(drive), json("{\"v\":2}"), SOURCES);
    expect(result.kind === "saved" && result.keepNote).toMatch(/not kept forever.*200 revisions/);
  });

  it("refuses a workspace holding a file that is not in the lab Drive", async () => {
    const drive = new FakeDrive();
    await expect(saveWorkspaceToDrive(drive, opened(drive), json("{}"), [
      ...SOURCES, { name: "D3_treated.fcs", sourcePath: "Downloads/D3_treated.fcs" },
    ])).rejects.toThrow(/One file of this workspace is not in the lab Drive \(D3_treated\.fcs\)/);
    expect(drive.calls).toEqual([]);
  });

  it("creates the workspace file at the first save of FCS opened alone", async () => {
    const drive = new FakeDrive();
    drive.writableFolders.add(FOLDER);
    const target: DriveTarget = { fileId: null, folderId: FOLDER, name: "Experiment 1.gatelab", experiment: "Experiment 1", headRevisionId: null, writerId: "tab-1" };
    const result = await saveWorkspaceToDrive(drive, target, json("{\"v\":1}"), SOURCES);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.target.fileId).toBeTruthy();
    expect(drive.byName("Experiment 1.gatelab")[0].parents).toEqual([FOLDER]);
    expect(drive.byName("Experiment 1.gatelab")[0].appProperties[WRITER_KEY]).toBe("tab-1");
  });

  it("asks for the folder to be picked when GateLab may not create a file in it", async () => {
    const drive = new FakeDrive();
    const target: DriveTarget = { fileId: null, folderId: FOLDER, name: "Experiment 1.gatelab", experiment: "Experiment 1", headRevisionId: null, writerId: "tab-1" };
    await expect(saveWorkspaceToDrive(drive, target, json("{}"), SOURCES)).rejects.toBeInstanceOf(DriveFolderAccessError);
  });

  it("saves a copy beside the workspace, which becomes the one saved to", async () => {
    const drive = new FakeDrive();
    drive.writableFolders.add(FOLDER);
    const target = opened(drive);
    drive.externalWrite(target.fileId!, json("{\"v\":\"theirs\"}"));
    const result = await saveWorkspaceCopyToDrive(drive, target, json("{\"v\":\"mine\"}"), SOURCES);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.target.fileId).not.toBe(target.fileId);
    expect(result.target.name).toMatch(/^Experiment 1 copy \d{4}-\d{2}-\d{2} \d{4}\.gatelab$/);
    expect(drive.text(target.fileId!)).toBe("{\"v\":\"theirs\"}");
    expect(drive.text(result.target.fileId!)).toBe("{\"v\":\"mine\"}");
  });

  it("saves a copy under a name given, and refuses a name already in the folder", async () => {
    const drive = new FakeDrive();
    drive.writableFolders.add(FOLDER);
    const target = opened(drive);
    const result = await saveWorkspaceCopyToDrive(drive, target, json("{\"v\":\"copy\"}"), SOURCES, { name: "D1 gating.gatelab" });
    expect(result.kind === "saved" && result.target.name).toBe("D1 gating.gatelab");
    await expect(saveWorkspaceCopyToDrive(drive, target, json("{}"), SOURCES, { name: "D1 gating.gatelab" }))
      .rejects.toThrow(/D1 gating\.gatelab is already in the experiment folder/);
    await expect(saveWorkspaceCopyToDrive(drive, target, json("{}"), SOURCES, { name: "Experiment 1.gatelab" }))
      .rejects.toThrow(/already in the experiment folder/);
    expect(drive.byName("D1 gating.gatelab")).toHaveLength(1);
  });

  it("does not make the workspace file twice when Drive made it and answered 500", async () => {
    const drive = new FakeDrive();
    drive.writableFolders.add(FOLDER);
    drive.faults.push({ on: "file", status: 500, applied: true });
    const target = opened(drive);
    const result = await saveWorkspaceCopyToDrive(drive, target, json("{}"), SOURCES, { name: "D1 gating.gatelab", sleep: async () => undefined });
    expect(drive.byName("D1 gating.gatelab")).toHaveLength(1);
    expect(result.kind === "saved" && result.target.fileId).toBe(drive.byName("D1 gating.gatelab")[0].id);
  });

  it("names a copy by the date and time", () => {
    expect(copyName("Experiment 1.gatelab", new Date(2026, 9, 15, 14, 32))).toBe("Experiment 1 copy 2026-10-15 1432.gatelab");
  });
});
