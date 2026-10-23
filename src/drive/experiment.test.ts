// Matching a workspace's declared FCS to the files of a lab Drive experiment folder: by Drive ID and
// by the acquisition keywords read from each file's header, never by name alone. Synthetic names.

import { describe, expect, it } from "vitest";
import { identityKeywords } from "../engine/fileIdentity";
import { readFcsKeywords } from "../engine/fcs";
import { DriveAuthError, DriveError, DriveTooLargeError } from "./api";
import {
  confirmPicked,
  experimentCandidates,
  mapLimit,
  matchExperimentFcs,
  MAX_WORKSPACE_BYTES,
  readDriveWorkspace,
  readMatchedFcs,
  workspaceRequirements,
} from "./experiment";
import { createDriveSession, type OpenExperimentUi } from "./session";
import type { DriveFolderRequest } from "./types";
import { FAKE_CONFIG, FakeDrive, FakePicker, fakeAuth, SlowDrive, syntheticFcs } from "./testFakeDrive";

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
      askFolder: async () => true,
      ...answers,
    };
  }
  /** An experiment folder in the lab folder; reachable, as one this member's GateLab made or chose before. */
  const inLab = (drive: FakeDrive, id = FOLDER, name = "Experiment 1", reachable = true) =>
    drive.addFolder(id, FAKE_CONFIG.rootFolderId, name, { reachable });

  it("asks for the files still missing, picks them in the experiment folder, and opens", async () => {
    const drive = new FakeDrive();
    inLab(drive);
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
    inLab(drive);
    const picker = new FakePicker();
    const workspace = drive.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson([{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs" }]));
    picker.queue.push(drive.pick(workspace));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    expect(await session.openExperiment(ui({ askMissing: async () => false }))).toBeNull();
  });

  it("opens FCS picked without a workspace as a new workspace saved into their folder", async () => {
    const drive = new FakeDrive();
    inLab(drive);
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
    inLab(drive);
    const picker = new FakePicker();
    picker.queue.push(drive.pick(drive.addOutside(FOLDER, "notes.txt", new TextEncoder().encode("x"))));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    await expect(session.openExperiment(ui())).rejects.toBeInstanceOf(DriveError);
  });

  it("refuses files picked outside the lab folder, naming it, and reads none of them", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    drive.addFolder(FAKE_CONFIG.rootFolderId, "SHARED_DRIVE_01", "Lab", { reachable: true });
    // A folder of the member's own, at the top of their Drive.
    drive.addFolder(OTHER_FOLDER, "", "Elsewhere", { reachable: true });
    const id = drive.addOutside(OTHER_FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    picker.queue.push(() => drive.pick(id));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    await expect(session.openExperiment(ui())).rejects.toThrow(/The files picked are not in the lab folder "Lab"\. .*Nothing was opened/);
    expect(drive.calls.filter((call) => call.startsWith("download") || call.startsWith("range"))).toEqual([]);
  });

  it("asks once for a folder on the way up that it cannot read, then opens an experiment several folders down", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    // Lab / Project (made by hand: not readable until chosen) / Experiment 1 (chosen before).
    drive.addFolder("SOME_FOLDER_0001", FAKE_CONFIG.rootFolderId, "Project", { reachable: false });
    drive.addFolder(FOLDER, "SOME_FOLDER_0001", "Experiment 1", { reachable: true });
    const id = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    picker.folder = { id: "SOME_FOLDER_0001", name: "Project", mimeType: "application/vnd.google-apps.folder" };
    picker.onFolderPicked = (folder) => { drive.pick(folder.id); };
    const asked: DriveFolderRequest[] = [];
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    picker.queue.push(() => drive.pick(id));
    const opened = await session.openExperiment(ui({ askFolder: async (request) => { asked.push(request); return true; } }));
    expect(asked).toEqual([{ kind: "above", child: "Experiment 1" }]);
    expect(picker.folderTitles).toEqual(['Choose the folder that holds "Experiment 1" (it is in the lab folder, perhaps several folders down)']);
    expect(opened?.target).toMatchObject({ folderId: FOLDER, experiment: "Experiment 1" });
  });

  it("refuses a folder on the way up whose choice is cancelled, or another folder chosen for it", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    drive.addFolder("SOME_FOLDER_0001", FAKE_CONFIG.rootFolderId, "Project", { reachable: false });
    drive.addFolder(FOLDER, "SOME_FOLDER_0001", "Experiment 1", { reachable: true });
    const id = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    picker.queue.push(() => drive.pick(id));
    expect(await session.openExperiment(ui({ askFolder: async () => false }))).toBeNull();
    picker.folder = { id: FOLDER, name: "Experiment 1", mimeType: "application/vnd.google-apps.folder" };
    picker.queue.push(() => drive.pick(id));
    await expect(session.openExperiment(ui())).rejects.toThrow(/another folder than the one that holds "Experiment 1"/);
  });

  it("refuses without asking a folder in another Shared drive than the lab folder's", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    drive.addFolder(FAKE_CONFIG.rootFolderId, "LAB_DRIVE_ROOT_01", "Lab", { reachable: true, driveId: "LAB_DRIVE_ROOT_01" });
    drive.addFolder("SOME_FOLDER_0001", "OTHER_DRIVE_ROOT", "Elsewhere", { reachable: false, driveId: "OTHER_DRIVE_ROOT" });
    drive.addFolder(FOLDER, "SOME_FOLDER_0001", "Experiment 1", { reachable: true, driveId: "OTHER_DRIVE_ROOT" });
    const id = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }), { driveId: "OTHER_DRIVE_ROOT" });
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    picker.queue.push(() => drive.pick(id));
    await expect(session.openExperiment(ui({ askFolder: async () => { throw new Error("asked"); } })))
      .rejects.toThrow(/The files picked are not in the lab folder "Lab"/);
  });

  it("asks for a colleague's experiment folder to be chosen once, then opens it", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    // Made by another member's GateLab: this member's cannot read it until it is chosen.
    inLab(drive, FOLDER, "Experiment 1", false);
    const d1 = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    picker.folder = { id: FOLDER, name: "Experiment 1", mimeType: "application/vnd.google-apps.folder" };
    picker.onFolderPicked = (folder) => { drive.pick(folder.id); };
    const asked: string[][] = [];
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    picker.queue.push(() => drive.pick(d1));
    const opened = await session.openExperiment(ui({ askFolder: async (request) => {
      if (request.kind === "experiment") asked.push([...request.files]);
      return true;
    } }));
    expect(asked).toEqual([["D1_treated.fcs"]]);
    expect(picker.opened).toEqual(["experiment", "folder"]);
    expect(opened?.target).toMatchObject({ folderId: FOLDER, experiment: "Experiment 1" });

    // Chosen once: the next open asks nothing.
    picker.queue.push(() => drive.pick(d1));
    await session.openExperiment(ui({ askFolder: async () => { throw new Error("asked again"); } }));
    expect(picker.opened).toEqual(["experiment", "folder", "experiment"]);
  });

  it("saves only while the experiment folder is still in the lab folder", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    inLab(drive);
    const d1 = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    drive.writableFolders.add(FOLDER);
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker, writerId: "tab-1" });
    picker.queue.push(() => drive.pick(d1));
    const opened = await session.openExperiment(ui());
    if (opened?.kind !== "fcs") throw new Error("not opened");
    const sources = [{ name: "D1_treated.fcs", sourcePath: "Drive: Experiment 1/D1_treated.fcs" }];
    const saved = await session.save(opened.target, new TextEncoder().encode("{}"), sources);
    expect(saved.kind).toBe("saved");
    if (saved.kind !== "saved") return;

    // Moved out of the lab folder after it was opened: neither Save nor Save As a copy writes.
    drive.addFolder("OWN_FOLDER_0001", "", "Elsewhere", { reachable: true });
    drive.move(FOLDER, "OWN_FOLDER_0001");
    const before = drive.calls.length;
    await expect(session.save(saved.target, new TextEncoder().encode("{\"v\":2}"), sources)).rejects.toThrow(/still in the lab folder/);
    await expect(session.saveCopy(saved.target, new TextEncoder().encode("{\"v\":2}"), sources)).rejects.toThrow(/nothing was saved/);
    expect(drive.calls.slice(before).filter((call) => /^(update|create)/.test(call))).toEqual([]);
  });

  it("opens nothing when the folder is not chosen, and refuses another folder chosen", async () => {
    const drive = new FakeDrive();
    const picker = new FakePicker();
    inLab(drive, FOLDER, "Experiment 1", false);
    inLab(drive, OTHER_FOLDER, "Experiment 2", false);
    const d1 = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker });
    picker.queue.push(() => drive.pick(d1));
    expect(await session.openExperiment(ui({ askFolder: async () => false }))).toBeNull();
    picker.folder = { id: OTHER_FOLDER, name: "Experiment 2", mimeType: "application/vnd.google-apps.folder" };
    picker.queue.push(() => drive.pick(d1));
    await expect(session.openExperiment(ui())).rejects.toThrow(/another folder than the one that holds the files picked/);
  });
});

describe("opening an experiment over a slow Drive", () => {
  // Each request takes LATENCY_MS, as each request to the real Drive takes 0.3 to 0.6 s.
  const LATENCY_MS = 40;

  /** Open a workspace and `count` FCS, all picked, and time it. */
  async function timedOpen(count: number) {
    const inner = new FakeDrive();
    inner.addFolder(FOLDER, FAKE_CONFIG.rootFolderId, "Experiment 1", { reachable: true });
    const fcs = Array.from({ length: count }, (_, i) => syntheticFcs({ btim: `10:${String(i).padStart(2, "0")}:00` }));
    const names = fcs.map((_, i) => `D${i + 1}_${i % 2 ? "control" : "treated"}.fcs`);
    const workspace = inner.addOutside(FOLDER, "Experiment 1.gatelab", workspaceJson(fcs.map((bytes, i) => ({
      fileName: names[i], dataPath: `data/${names[i]}`, identity: identityOf(bytes),
    }))));
    const ids = fcs.map((bytes, i) => inner.addOutside(FOLDER, names[i], bytes));
    const drive = new SlowDrive(inner, LATENCY_MS);
    const picker = new FakePicker();
    picker.queue.push(() => inner.pick(workspace, ...ids));
    const session = createDriveSession(FAKE_CONFIG, { auth: fakeAuth(), api: drive, picker, writerId: "tab-1" });
    const started = performance.now();
    const opened = await session.openExperiment({
      progress: () => undefined,
      chooseWorkspace: async (files) => files[0],
      askMissing: async () => true,
      nameNewWorkspace: async (_, suggested) => suggested,
      askFolder: async () => true,
    });
    const ms = performance.now() - started;
    if (opened?.kind !== "workspace") throw new Error("not opened");
    for (let i = 0; i < count; i++) expect([...opened.resolved.get(`data/${names[i]}`)!.bytes]).toEqual([...fcs[i]]);
    return { ms, requests: drive.requests, peak: drive.peak, roundTrips: ms / LATENCY_MS };
  }

  // Measured on 2026-10-15 at 40 ms a request, before the requests ran side by side: a workspace
  // and 3 FCS took 17 requests in 17.5 round trips, and with 12 FCS 53 requests in 54.3.
  it("reads the files' details and headers 4 at a time and downloads 2 at a time", async () => {
    for (const [count, most] of [[3, 9], [12, 22]] as const) {
      const result = await timedOpen(count);
      console.info(`open of a workspace and ${count} FCS: ${result.requests} requests, ${result.ms.toFixed(0)} ms at ${LATENCY_MS} ms each ` +
        `(${result.roundTrips.toFixed(1)} round trips), most in flight ${JSON.stringify(result.peak)}`);
      // Every request is still made.
      expect(result.requests).toBe(5 + 4 * count);
      expect(result.peak.get).toBeLessThanOrEqual(4);
      expect(result.peak.range).toBeLessThanOrEqual(4);
      expect(result.peak.download).toBe(2);
      expect(result.roundTrips).toBeLessThan(most);
    }
  }, 30_000);
});

describe("running Drive requests side by side", () => {
  it("keeps the items' order and runs no more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([30, 10, 20, 5, 15, 1], 3, async (ms, index) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return `${index}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:5", "4:15", "5:1"]);
    expect(most).toBe(3);
  });

  it("throws the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(mapLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (item === 2) throw new DriveError("refused");
      return item;
    })).rejects.toThrow("refused");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual([1, 2, 3]);
  });

  it("stops matching for a reconnect when the sign-in runs out during a header read", async () => {
    const drive = new FakeDrive();
    const d1 = syntheticFcs({ btim: "10:00:00" });
    const picked = await confirmPicked(drive, drive.pick(drive.addOutside(FOLDER, "D1_treated.fcs", d1)));
    drive.readRange = async () => { throw new DriveAuthError(); };
    const requirements = [{ fileName: "D1_treated.fcs", dataPath: "data/D1_treated.fcs", identity: identityOf(d1) }];
    await expect(matchExperimentFcs(drive, requirements, await experimentCandidates(drive, picked))).rejects.toBeInstanceOf(DriveAuthError);
  });
});
