// Matching a workspace's declared FCS to the files of a lab Drive experiment folder: by Drive ID and
// by the acquisition keywords read from each file's header, never by name alone. Synthetic names.

import { describe, expect, it } from "vitest";
import { identityKeywords } from "../engine/fileIdentity";
import { readFcsKeywords } from "../engine/fcs";
import { DriveError, DriveTooLargeError } from "./api";
import {
  confirmPicked,
  experimentCandidates,
  matchExperimentFcs,
  MAX_WORKSPACE_BYTES,
  readDriveWorkspace,
  readMatchedFcs,
  workspaceRequirements,
} from "./experiment";
import { createDriveSession, type OpenExperimentUi } from "./session";
import { FAKE_CONFIG, FakeDrive, FakePicker, fakeAuth, syntheticFcs } from "./testFakeDrive";

const FOLDER = "EXPERIMENT_FOLDER_1";
const OTHER_FOLDER = "EXPERIMENT_FOLDER_2";

const identityOf = (bytes: Uint8Array) => identityKeywords(readFcsKeywords(bytes.slice().buffer));

function workspaceJson(samples: { fileName: string; dataPath: string; identity?: Record<string, string> }[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ format: "gatelab-workspace", version: 2, samples }));
}

describe("matching a lab Drive experiment", () => {
  it("matches the declared FCS to the picked files and reads them", async () => {
    const drive = new FakeDrive();
    const d1 = syntheticFcs({ btim: "10:00:00" });
    const d2 = syntheticFcs({ btim: "11:00:00" });
    const ids = [drive.addOutside(FOLDER, "D1_treated.fcs", d1), drive.addOutside(FOLDER, "D2_control.fcs", d2)];
    const picked = await confirmPicked(drive, drive.pick(...ids));
    expect(picked.folderId).toBe(FOLDER);
    const requirements = workspaceRequirements(JSON.parse(new TextDecoder().decode(workspaceJson([
      { fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(d1) },
      { fileName: "D2_control.fcs", dataPath: "data/D2_control.fcs", identity: identityOf(d2) },
    ]))));
    const match = await matchExperimentFcs(drive, requirements, await experimentCandidates(drive, picked));
    expect(match.missing).toEqual([]);
    expect(match.problems).toEqual([]);
    const resolved = await readMatchedFcs(drive, requirements, match.matches, "Experiment 1");
    expect([...resolved.get("data/D1_treated.fcs")!.bytes]).toEqual([...d1]);
    expect(resolved.get("data/D2_control.fcs")!.sourcePath).toBe("Drive: Experiment 1/D2_control.fcs");
    // The identity was read from the header by Range requests, not by downloading the file first.
    expect(drive.calls.filter((call) => call.startsWith("range"))).toHaveLength(4);
  });

  it("refuses a same-named file of another acquisition", async () => {
    const drive = new FakeDrive();
    const saved = syntheticFcs({ btim: "10:00:00" });
    const other = syntheticFcs({ btim: "14:30:00", date: "02-FEB-2026" });
    const picked = await confirmPicked(drive, drive.pick(drive.addOutside(FOLDER, "D1_treated.fcs", other)));
    const requirements = [{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(saved) }];
    const match = await matchExperimentFcs(drive, requirements, await experimentCandidates(drive, picked));
    expect(match.matches.size).toBe(0);
    expect(match.problems.join(" ")).toMatch(/another acquisition/);
  });

  it("tells two files of one name apart by the keywords each was saved with", async () => {
    const drive = new FakeDrive();
    const morning = syntheticFcs({ btim: "09:00:00" });
    const evening = syntheticFcs({ btim: "18:00:00" });
    // Drive allows two files of one name in a folder.
    const morningId = drive.addOutside(FOLDER, "D1_treated.fcs", morning);
    const eveningId = drive.addOutside(FOLDER, "D1_treated.fcs", evening);
    const picked = await confirmPicked(drive, drive.pick(morningId, eveningId));
    const requirements = [{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(evening) }];
    const match = await matchExperimentFcs(drive, requirements, await experimentCandidates(drive, picked));
    expect(match.problems).toEqual([]);
    expect(match.matches.get("data/D1_treated.fcs")!.id).toBe(eveningId);
  });

  it("will not guess between two files of one name when nothing saved tells them apart", async () => {
    const drive = new FakeDrive();
    const picked = await confirmPicked(drive, drive.pick(
      drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "09:00:00" })),
      drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "18:00:00" })),
    ));
    const match = await matchExperimentFcs(drive, [{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs" }], await experimentCandidates(drive, picked));
    expect(match.matches.size).toBe(0);
    expect(match.problems.join(" ")).toMatch(/2 files named D1_treated\.fcs/);
  });

  it("reports the declared files that were not picked", async () => {
    const drive = new FakeDrive();
    const d1 = syntheticFcs({ btim: "10:00:00" });
    const picked = await confirmPicked(drive, drive.pick(drive.addOutside(FOLDER, "D1_treated.fcs", d1)));
    // In the folder, but neither picked nor made by GateLab: not reachable under drive.file.
    drive.addOutside(FOLDER, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));
    const match = await matchExperimentFcs(drive, [
      { fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(d1) },
      { fileName: "D2_control.fcs", dataPath: "data/D2_control.fcs" },
    ], await experimentCandidates(drive, picked));
    expect(match.missing.map((r) => r.fileName)).toEqual(["D2_control.fcs"]);
  });

  it("takes files GateLab can reach in the folder, and none from another folder", async () => {
    const drive = new FakeDrive();
    const workspaceId = drive.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson([]));
    const inFolder = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const elsewhere = drive.addOutside(OTHER_FOLDER, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));
    drive.reachable.add(inFolder); // picked on an earlier day
    drive.reachable.add(elsewhere);
    const picked = await confirmPicked(drive, drive.pick(workspaceId));
    const candidates = await experimentCandidates(drive, picked, [await drive.getMetadata(elsewhere)]);
    expect(candidates.map((file) => file.id)).toEqual([inFolder]);
  });

  it("refuses picked files from more than one folder, a folder, and a trashed file", async () => {
    const drive = new FakeDrive();
    const a = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const b = drive.addOutside(OTHER_FOLDER, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));
    await expect(confirmPicked(drive, drive.pick(a, b))).rejects.toThrow(/not all in one folder/);
    const trashed = drive.addOutside(FOLDER, "D3_control.fcs", syntheticFcs({ btim: "12:00:00" }), { trashed: true });
    await expect(confirmPicked(drive, drive.pick(trashed))).rejects.toThrow(/trash/);
    await expect(confirmPicked(drive, drive.pick(a), OTHER_FOLDER)).rejects.toThrow(/another folder/);
  });

  it("checks a workspace file's size before reading it, and refuses a bundle", async () => {
    const drive = new FakeDrive();
    const id = drive.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson([]));
    drive.reachable.add(id);
    const huge = { ...(await drive.getMetadata(id)), size: MAX_WORKSPACE_BYTES + 1 };
    await expect(readDriveWorkspace(drive, huge)).rejects.toBeInstanceOf(DriveTooLargeError);
    expect(drive.calls.some((call) => call.startsWith("download"))).toBe(false);
    const bundle = drive.addOutside(FOLDER, "Bundle.gatelab", Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0]));
    drive.reachable.add(bundle);
    await expect(readDriveWorkspace(drive, await drive.getMetadata(bundle))).rejects.toThrow(/self-contained workspace bundle/);
  });
});

describe("the Open experiment flow", () => {
  function ui(answers: Partial<OpenExperimentUi> = {}): OpenExperimentUi {
    return {
      progress: () => undefined,
      chooseWorkspace: async (files) => files[0],
      askMissing: async () => true,
      nameNewWorkspace: async (_, suggested) => suggested,
      ...answers,
    };
  }

  it("asks for the files still missing, picks them in the experiment folder, and opens", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    const d1 = syntheticFcs({ btim: "10:00:00" });
    const d2 = syntheticFcs({ btim: "11:00:00" });
    const workspace = drive.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson([
      { fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(d1) },
      { fileName: "D2_control.fcs", dataPath: "data/D2_control.fcs", identity: identityOf(d2) },
    ]));
    const d1Id = drive.addOutside(FOLDER, "D1_treated.fcs", d1);
    const d2Id = drive.addOutside(FOLDER, "D2_control.fcs", d2);
    picker.queue.push(() => drive.pick(workspace, d1Id), () => drive.pick(d2Id));
    const asked: string[][] = [];
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker, writerId: "tab-1" });
    const opened = await session.openExperiment(ui({ askMissing: async (names) => { asked.push([...names]); return true; } }));
    expect(asked).toEqual([["D2_control.fcs"]]);
    expect(picker.opened).toEqual(["experiment", `missing ${FOLDER} D2_control.fcs`]);
    expect(opened?.kind).toBe("workspace");
    if (opened?.kind !== "workspace") return;
    expect(opened.target).toMatchObject({ fileId: workspace, folderId: FOLDER, name: "Experiment 1.gatelab", headRevisionId: `${workspace}_rev1`, writerId: "tab-1" });
    expect([...opened.resolved.keys()]).toEqual(["data/D1_treated.fcs", "data/D2_control.fcs"]);
  });

  it("opens nothing when the missing files are not picked", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    const workspace = drive.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson([{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs" }]));
    picker.queue.push(drive.pick(workspace));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    expect(await session.openExperiment(ui({ askMissing: async () => false }))).toBeNull();
  });

  it("opens FCS picked without a workspace as a new workspace saved into their folder", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    picker.queue.push(drive.pick(
      drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" })),
      drive.addOutside(FOLDER, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" })),
    ));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker, writerId: "tab-1" });
    const opened = await session.openExperiment(ui({ nameNewWorkspace: async () => "Experiment 1" }));
    expect(opened?.kind).toBe("fcs");
    if (opened?.kind !== "fcs") return;
    expect(opened.target).toMatchObject({ fileId: null, folderId: FOLDER, name: "Experiment 1.gatelab", headRevisionId: null });
    expect(opened.files.map((file) => file.sourcePath)).toEqual(["Drive: Experiment 1/D1_treated.fcs", "Drive: Experiment 1/D2_control.fcs"]);
  });

  it("refuses a pick with no workspace and no FCS", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    picker.queue.push(drive.pick(drive.addOutside(FOLDER, "notes.txt", new TextEncoder().encode("x"))));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    await expect(session.openExperiment(ui())).rejects.toBeInstanceOf(DriveError);
  });
});
