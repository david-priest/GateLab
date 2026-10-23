// Save as new experiment, against the in-memory Drive: the folder under the lab folder, each FCS
// once (a multi-data-set file once for all its data sets), the workspace written last; a lab
// folder GateLab may not create in; a name already in the lab Drive refused; cancel, and going on
// from where it stopped; a 500 on a folder or workspace Drive made is not made twice. Synthetic names.

import { describe, expect, it } from "vitest";
import { FOLDER_MIME } from "./api";
import { md5Hex } from "./md5";
import {
  CREATOR_KEY,
  DriveExperimentStoppedError,
  EXPERIMENT_KEY,
  experimentName,
  experimentUploads,
  saveAsNewExperiment,
  type ExperimentUpload,
} from "./newExperiment";
import { DriveFolderAccessError, SAVE_KEY, WRITER_KEY } from "./save";
import { createDriveSession } from "./session";
import { FAKE_CONFIG, FakeDrive, FakePicker, fakeAuth } from "./testFakeDrive";
import type { DriveFolderRequest } from "./types";
import { UPLOAD_CHUNK_BYTES } from "./upload";

const ROOT = "ROOT_FOLDER_0001";
const ACCOUNT = "member1@lab.example.org";
const noWait = async () => undefined;
const json = (text: string) => new TextEncoder().encode(text);

function bytesOf(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 13 + seed * 101 + (i >> 8)) & 255;
  return out;
}

function lab() {
  const drive = new FakeDrive();
  drive.writableFolders.add(ROOT);
  const uploads: ExperimentUpload[] = [
    { name: "D1_treated.fcs", bytes: bytesOf(UPLOAD_CHUNK_BYTES + 100, 1), sampleIds: ["s1"] },
    { name: "D2_control.fcs", bytes: bytesOf(2000, 2), sampleIds: ["s2"] },
  ];
  const request = { name: "Experiment 1", uploads, workspace: json("{\"v\":1}"), writerId: "tab-1", account: ACCOUNT };
  return { drive, uploads, request };
}

describe("the files a new experiment uploads", () => {
  it("are each sample's FCS once, and a multi-data-set file once for all its data sets", () => {
    const plate = bytesOf(500, 3);
    const uploads = experimentUploads([
      { id: "a", name: "D1_treated.fcs", bytes: bytesOf(10, 4) },
      { id: "b", name: "plate (data set 1 of 2, A01).fcs", bytes: bytesOf(5, 5), dataSetFile: plate },
      { id: "c", name: "plate (data set 2 of 2, A02).fcs", bytes: bytesOf(5, 6), dataSetFile: plate },
      { id: "d", name: "D1_treated.fcs", bytes: bytesOf(12, 7) },
    ]);
    expect(uploads.map((upload) => [upload.name, upload.bytes.length, upload.sampleIds])).toEqual([
      ["D1_treated.fcs", 10, ["a"]],
      ["plate.fcs", 500, ["b", "c"]],
      ["D1_treated.fcs", 12, ["d"]],
    ]);
  });

  it("are refused when a data set's whole file is not held, or a sample has no FCS", () => {
    expect(() => experimentUploads([{ id: "b", name: "plate (data set 1 of 2, A01).fcs", bytes: bytesOf(5, 5) }]))
      .toThrow(/one data set of plate\.fcs.*Nothing was saved/);
    expect(() => experimentUploads([{ id: "a", name: "D1_treated.fcs", bytes: null }])).toThrow(/no FCS file/);
  });

  it("name the folder without path separators", () => {
    expect(experimentName("  D1/D2: treated  ")).toBe("D1-D2- treated");
    expect(experimentName("Experiment 1.gatelab")).toBe("Experiment 1");
  });
});

describe("saving as a new experiment", () => {
  it("makes the folder, uploads each FCS into it, and writes the workspace last", async () => {
    const { drive, request, uploads } = lab();
    const phases: string[] = [];
    const result = await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait, onProgress: (p) => phases.push(p.phase) });
    const [folder] = drive.folders(ROOT, "Experiment 1");
    expect(folder.appProperties).toMatchObject({ [EXPERIMENT_KEY]: "1", [CREATOR_KEY]: ACCOUNT, [WRITER_KEY]: "tab-1" });
    expect(drive.inFolder(folder.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "D2_control.fcs", "Experiment 1.gatelab"]);
    for (const upload of uploads) expect(drive.byName(upload.name)[0].md5Checksum).toBe(md5Hex(upload.bytes));
    expect(drive.calls.filter((call) => /^(folder|start|create) /.test(call))).toEqual([
      "folder Experiment 1", "start D1_treated.fcs", "start D2_control.fcs", "create Experiment 1.gatelab",
    ]);
    expect(result).toMatchObject({
      uploaded: 2,
      already: 0,
      resumed: false,
      target: { folderId: folder.id, name: "Experiment 1.gatelab", experiment: "Experiment 1", writerId: "tab-1" },
    });
    expect(drive.text(result.target.fileId!)).toBe("{\"v\":1}");
    expect(drive.kept).toEqual([result.target.headRevisionId]);
    expect([...result.sourcePaths]).toEqual([["s1", "Drive: Experiment 1/D1_treated.fcs"], ["s2", "Drive: Experiment 1/D2_control.fcs"]]);
    expect(phases[0]).toBe("folder");
    expect(phases.at(-1)).toBe("workspace");
    expect(phases).toContain("uploading");
  });

  it("asks for the lab folder to be picked when GateLab may not create in it", async () => {
    const { drive, request } = lab();
    drive.writableFolders.delete(ROOT);
    const refused = await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait }).catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(DriveFolderAccessError);
    expect((refused as DriveFolderAccessError).folderId).toBe(ROOT);
    expect(drive.calls.some((call) => call.startsWith("start "))).toBe(false);
  });

  it("refuses a name already in the lab Drive: a finished experiment, another member's, or a folder GateLab did not make", async () => {
    const { drive, request } = lab();
    await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait });
    await expect(saveAsNewExperiment(drive, ROOT, request, { sleep: noWait })).rejects.toThrow(/"Experiment 1" is already in the lab Drive/);
    await drive.createFolder({ name: "Experiment 2", parentId: ROOT, appProperties: { [EXPERIMENT_KEY]: "1", [CREATOR_KEY]: "member2@lab.example.org" } });
    await expect(saveAsNewExperiment(drive, ROOT, { ...request, name: "Experiment 2" }, { sleep: noWait })).rejects.toThrow(/already in the lab Drive/);
    await drive.createFolder({ name: "Experiment 3", parentId: ROOT });
    await expect(saveAsNewExperiment(drive, ROOT, { ...request, name: "Experiment 3" }, { sleep: noWait })).rejects.toThrow(/already in the lab Drive/);
    expect(drive.inFolder(drive.folders(ROOT, "Experiment 2")[0].id)).toEqual([]);
    expect(drive.inFolder(drive.folders(ROOT, "Experiment 3")[0].id)).toEqual([]);
  });

  it("stops when cancelled, says what the folder holds, and goes on from there when saved again", async () => {
    const { drive, request } = lab();
    const controller = new AbortController();
    const stopped = await saveAsNewExperiment(drive, ROOT, request, {
      sleep: noWait,
      signal: controller.signal,
      onProgress: (progress) => { if (progress.index === 2 && progress.phase === "checking") controller.abort(); },
    }).catch((cause: unknown) => cause);
    expect(stopped).toBeInstanceOf(DriveExperimentStoppedError);
    expect((stopped as DriveExperimentStoppedError).cancelled).toBe(true);
    expect((stopped as Error).message).toMatch(/^Cancelled\. The experiment folder "Experiment 1" in the lab Drive holds 1 of 2 FCS files and no workspace/);
    const [folder] = drive.folders(ROOT, "Experiment 1");
    expect(drive.inFolder(folder.id).map((file) => file.name)).toEqual(["D1_treated.fcs"]);

    drive.calls.length = 0;
    const result = await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait });
    expect(result).toMatchObject({ resumed: true, uploaded: 1, already: 1, target: { folderId: folder.id } });
    expect(drive.calls.filter((call) => /^(folder|start|create) /.test(call))).toEqual(["start D2_control.fcs", "create Experiment 1.gatelab"]);
    expect(drive.inFolder(folder.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "D2_control.fcs", "Experiment 1.gatelab"]);
  });

  it("does not make the folder or the workspace twice when Drive made them and answered 500", async () => {
    const { drive, request } = lab();
    drive.faults.push({ on: "folder", status: 500, applied: true });
    drive.faults.push({ on: "file", status: 503, applied: true });
    const result = await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait });
    expect(drive.folders(ROOT, "Experiment 1")).toHaveLength(1);
    expect(drive.byName("Experiment 1.gatelab")).toHaveLength(1);
    expect(result.target.fileId).toBe(drive.byName("Experiment 1.gatelab")[0].id);
    expect(drive.byName("Experiment 1.gatelab")[0].appProperties[SAVE_KEY]).toBeTruthy();
  });

  it("makes the folder again when Drive answered 500 and had not made it", async () => {
    const { drive, request } = lab();
    drive.faults.push({ on: "folder", status: 500 });
    await saveAsNewExperiment(drive, ROOT, request, { sleep: noWait });
    expect(drive.calls.filter((call) => call.startsWith("folder "))).toHaveLength(2);
    expect(drive.folders(ROOT, "Experiment 1")).toHaveLength(1);
    expect(drive.folders(ROOT, "Experiment 1")[0].mimeType).toBe(FOLDER_MIME);
  });

  it("says what the folder holds when a refusal stops it", async () => {
    const { drive, request } = lab();
    drive.faults.push({ on: "start", status: 403, when: ({ name }) => name === "D2_control.fcs" });
    await expect(saveAsNewExperiment(drive, ROOT, request, { sleep: noWait }))
      .rejects.toThrow(/HTTP 403.*holds 1 of 2 FCS files and no workspace/);
    expect(drive.byName("Experiment 1.gatelab")).toHaveLength(0);
  });
});

describe("where a new experiment goes", () => {
  const FOLDER = "application/vnd.google-apps.folder";
  const samples = [
    { id: "s1", name: "D1_treated.fcs", bytes: bytesOf(UPLOAD_CHUNK_BYTES + 100, 1) },
    { id: "s2", name: "D2_control.fcs", bytes: bytesOf(2000, 2) },
  ];
  /** Lab / David (made by hand, not readable until chosen) / For testing. */
  function nested() {
    const drive = new FakeDrive();
    drive.writableFolders.add(ROOT);
    drive.addFolder(ROOT, "SHARED_DRIVE_01", "Lab");
    drive.addFolder("DAVID_FOLDER_0001", ROOT, "David");
    drive.addFolder("TESTING_FOLDER_01", "DAVID_FOLDER_0001", "For testing");
    const picker = new FakePicker();
    // A folder chosen in the picker becomes readable, and GateLab may create in it.
    picker.onFolderPicked = (folder) => {
      drive.pick(folder.id);
      drive.writableFolders.add(folder.id);
    };
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker, writerId: "tab-1" });
    return { drive, picker, session };
  }

  it("is the lab folder, or a folder inside it several folders down, each folder on the way confirmed", async () => {
    const { drive, picker, session } = nested();
    picker.folders.push(
      { id: "TESTING_FOLDER_01", name: "For testing", mimeType: FOLDER },
      { id: "DAVID_FOLDER_0001", name: "David", mimeType: FOLDER },
    );
    const asked: DriveFolderRequest[] = [];
    const location = await session.chooseLocation({ askFolder: async (request) => { asked.push(request); return true; } });
    expect(picker.opened).toEqual(["location", "folder"]);
    expect(asked).toEqual([{ kind: "above", child: "For testing" }]);
    expect(location).toEqual({ folderId: "TESTING_FOLDER_01", path: ["David", "For testing"] });

    const result = await session.saveAsNewExperiment({ name: "Experiment 1", samples, workspace: json("{\"v\":1}"), location });
    const [made] = drive.folders("TESTING_FOLDER_01", "Experiment 1");
    expect(result.target.folderId).toBe(made.id);
    expect(drive.inFolder(made.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "D2_control.fcs", "Experiment 1.gatelab"]);
    expect(drive.folders(ROOT, "Experiment 1")).toEqual([]);

    // Chosen once: the next choice of the same place asks nothing, and the lab folder itself is a place too.
    picker.folders.push({ id: "TESTING_FOLDER_01", name: "For testing", mimeType: FOLDER });
    expect(await session.chooseLocation({ askFolder: async () => { throw new Error("asked again"); } }))
      .toEqual({ folderId: "TESTING_FOLDER_01", path: ["David", "For testing"] });
    picker.folders.push({ id: ROOT, name: "Lab", mimeType: FOLDER });
    expect(await session.chooseLocation({ askFolder: async () => true })).toEqual({ folderId: ROOT, path: [] });
  });

  it("refuses a folder outside the lab folder, saying so", async () => {
    const { drive, picker, session } = nested();
    drive.addFolder("OWN_FOLDER_0001", "", "Elsewhere");
    picker.folders.push({ id: "OWN_FOLDER_0001", name: "Elsewhere", mimeType: FOLDER });
    await expect(session.chooseLocation({ askFolder: async () => true }))
      .rejects.toThrow(/^The folder chosen is not in the lab folder .*GateLab makes a new experiment only in the lab folder or a folder inside it, at any depth/);
    // In another Shared drive, below a folder GateLab cannot read: refused without asking.
    drive.addFolder(ROOT, "LAB_DRIVE_ROOT_01", "Lab", { reachable: true, driveId: "LAB_DRIVE_ROOT_01" });
    drive.addFolder("OTHER_PARENT_0001", "OTHER_DRIVE_ROOT", "Other", { driveId: "OTHER_DRIVE_ROOT" });
    drive.addFolder("OTHER_FOLDER_0001", "OTHER_PARENT_0001", "Other experiments", { driveId: "OTHER_DRIVE_ROOT" });
    picker.folders.push({ id: "OTHER_FOLDER_0001", name: "Other experiments", mimeType: FOLDER });
    await expect(session.chooseLocation({ askFolder: async () => { throw new Error("asked"); } }))
      .rejects.toThrow(/The folder chosen is not in the lab folder "Lab"/);
    // A choice cancelled is no location, and nothing is made.
    picker.folders.push(null);
    expect(await session.chooseLocation({ askFolder: async () => true })).toBeNull();
    expect(drive.calls.filter((call) => /^(folder|create|start) /.test(call))).toEqual([]);
  });

  it("goes on in the same subfolder after a save that stopped, and refuses a place moved out of the lab folder", async () => {
    const { drive, picker, session } = nested();
    picker.folders.push(
      { id: "TESTING_FOLDER_01", name: "For testing", mimeType: FOLDER },
      { id: "DAVID_FOLDER_0001", name: "David", mimeType: FOLDER },
    );
    const location = await session.chooseLocation({ askFolder: async () => true });
    const controller = new AbortController();
    const request = { name: "Experiment 1", samples, workspace: json("{\"v\":1}"), location };
    const stopped = await session.saveAsNewExperiment(request, {
      signal: controller.signal,
      onProgress: (progress) => { if (progress.index === 2 && progress.phase === "checking") controller.abort(); },
    }).catch((cause: unknown) => cause);
    expect(stopped).toBeInstanceOf(DriveExperimentStoppedError);
    const [made] = drive.folders("TESTING_FOLDER_01", "Experiment 1");
    expect(drive.inFolder(made.id).map((file) => file.name)).toEqual(["D1_treated.fcs"]);

    const result = await session.saveAsNewExperiment(request);
    expect(result).toMatchObject({ resumed: true, uploaded: 1, already: 1, target: { folderId: made.id } });
    expect(drive.folders("TESTING_FOLDER_01", "Experiment 1")).toHaveLength(1);
    expect(drive.inFolder(made.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "D2_control.fcs", "Experiment 1.gatelab"]);

    // Moved out of the lab folder after it was chosen: nothing is made there.
    drive.addFolder("OWN_FOLDER_0001", "", "Elsewhere", { reachable: true });
    drive.move("DAVID_FOLDER_0001", "OWN_FOLDER_0001");
    await expect(session.saveAsNewExperiment({ ...request, name: "Experiment 2" })).rejects.toThrow(/still in the lab folder, so nothing was saved/);
    expect(drive.folders("TESTING_FOLDER_01", "Experiment 2")).toEqual([]);
  });
});
