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
import { FakeDrive } from "./testFakeDrive";
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
