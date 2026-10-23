// @vitest-environment jsdom
// The lab Drive workspace end to end, through the real Drive session over an in-memory Drive
// (src/drive/testFakeDrive.ts): FCS picked without a workspace open as a new one, a gate is
// imported, Save creates the workspace file in their folder, sign-out closes it, and reopening
// from Drive brings the gate back. A save after another member's is refused and saved as a copy.
// Throughout, nothing is checkpointed in this browser and persistent storage is never requested.
// Synthetic file, gate and account names.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_CONFIG, FakeDrive, FakePicker, fakeAuth, syntheticFcs } from "./drive/testFakeDrive";
import { md5Hex } from "./drive/md5";
import { writeFcs } from "./engine/fcsExport";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return {
    ...actual,
    listWorkspaceCheckpoints: vi.fn(async () => []),
    saveWorkspaceCheckpoint: vi.fn(async () => "saved"),
    requestPersistentWorkspaceHistory: vi.fn(async () => null),
  };
});

const FOLDER = "EXPERIMENT_FOLDER_1";
const drive = new FakeDrive();
const picker = new FakePicker();
const auth = fakeAuth();
/** The Drive autosave's wait: an hour, so it never fires, except in the test of it. */
let autosaveMs = 3600_000;
vi.mock("./drive", async () => {
  const actual = await vi.importActual<typeof import("./drive")>("./drive");
  return {
    ...actual,
    get DRIVE_AUTOSAVE_MS() { return autosaveMs; },
    readDriveConfig: () => FAKE_CONFIG,
    createDriveSession: (config: typeof FAKE_CONFIG) => actual.createDriveSession(config, { auth, api: drive, picker, writerId: "tab-1" }),
  };
});

vi.mock("./labPreload", () => ({ preloadLabChunksSoon: vi.fn() }));

import App from "./App";
import { preloadLabChunksSoon } from "./labPreload";
import { ChunkReloadHeldError, lazyChunk } from "./ui/lazyChunk";
import { requestPersistentWorkspaceHistory, saveWorkspaceCheckpoint } from "./engine/workspaceHistory";

const gatingMl = (name: string) => `<?xml version="1.0"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="g-${name}" gating:name="${name}">
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FL2-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__GATELAB_DRIVE__", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}
/** Wait for the page to reach a state: the Drive module loads by dynamic import, slower under a full run. */
async function until(reached: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !reached(); waited += 60) {
    if (waited > 10_000) throw new Error(`Timed out waiting for ${what}`);
    await settle();
  }
}
const shows = (text: string) => () => (document.body.textContent ?? "").includes(text);
async function click(selector: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(selector) ?? document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`No ${selector} on the page`);
  await act(async () => { button.click(); });
  await settle();
}
async function clickText(text: RegExp): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => text.test(b.textContent ?? ""));
  if (!button) throw new Error(`No dialog button ${text}`);
  await act(async () => { button.click(); });
  await settle();
}
async function importGates(name: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.flowjo,.cef"]')!;
  const file = new File([gatingMl(name)], `${name}.xml`);
  Object.defineProperty(file, "text", { value: async () => gatingMl(name) });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  const importButton = [...host.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => /^Import/.test(b.textContent ?? ""));
  if (importButton) {
    await act(async () => { importButton.click(); });
    await settle();
  }
}

/** Set a text field as typing would. */
async function typeInto(selector: string, value: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(selector);
  if (!field) throw new Error(`No ${selector} on the page`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function fileOf(name: string, bytes: Uint8Array): File {
  const file = new File([bytes as BlobPart], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.slice().buffer });
  return file;
}
async function openHere(files: File[]): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type=file][accept=".fcs"][multiple]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
}

/** One FCS file holding two data sets (wells A01 and A02), chained by $NEXTDATA. */
function twoDataSetFcs(): Uint8Array {
  const dataSet = (well: string, extra: [string, string][] = []) => writeFcs(
    [Float32Array.from([1000, 1010, 1020]), Float32Array.from([100, 150, 200]), Float32Array.from([50, 70, 90])],
    [{ name: "FSC-A", desc: "" }, { name: "FL1-A", desc: "CD3" }, { name: "FL2-A", desc: "CD19" }],
    { keywords: [["$DATE", "01-JAN-2026"], ["$BTIM", "09:00:00"], ["$ETIM", "23:59:00"], ["$WELLID", well], ...extra] },
  );
  // The writer sets $NEXTDATA to 0; a same-length keyword of its own is swapped in for it and given the offset.
  const first = dataSet("A01", [["ZNEXTDATA", "00000000"]]);
  const text = new TextDecoder("latin1").decode(first);
  const put = (at: number, value: string) => { for (let i = 0; i < value.length; i++) first[at + i] = value.charCodeAt(i); };
  const own = text.indexOf("$NEXTDATA");
  const swapped = text.indexOf("ZNEXTDATA");
  put(own, "ZZEXTDATA");
  put(swapped, "$NEXTDATA");
  put(swapped + 10, String(first.length).padStart(8, "0"));
  const second = dataSet("A02");
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}

describe("a lab Drive workspace", () => {
  it("opens from Drive, saves back, reopens, and refuses to write over another member's save", async () => {
    // An experiment folder in the lab folder, one this member chose before.
    drive.addFolder(FOLDER, FAKE_CONFIG.rootFolderId, "Experiment 1", { reachable: true });
    const d1 = drive.addOutside(FOLDER, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const d2 = drive.addOutside(FOLDER, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));
    // GateLab may create a file in it.
    drive.writableFolders.add(FOLDER);

    act(() => root.render(<App />));
    await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
    expect(host.querySelector(".gl-agent-menu")).not.toBeNull();

    // FCS picked without a workspace: a new workspace, named for the file it will be saved as.
    picker.queue.push(() => drive.pick(d1, d2));
    await click(".gl-drive-open");
    await until(() => document.querySelector(".gl-drive-name-ok") !== null, "the new-workspace name");
    const nameField = document.querySelector<HTMLInputElement>(".gl-modal-field input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameField, "Experiment 1");
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(".gl-drive-name-ok");
    await until(shows("D2_control.fcs"), "the FCS opened from Drive");
    expect(host.textContent).toContain("D1_treated.fcs");
    expect(host.textContent).toContain("D2_control.fcs");
    expect(host.textContent).toContain("Experiment 1.gatelab");
    // Drive mode: the agent link is off.
    expect(host.querySelector(".gl-agent-menu")).toBeNull();

    await importGates("CD4_positive");
    await until(shows("CD4_positive"), "the imported gate");

    // Save creates the workspace file in the experiment folder.
    await click(".gl-side-save");
    await until(shows("Saved to the lab Drive"), "the save");
    const [saved] = drive.byName("Experiment 1.gatelab");
    expect(saved?.parents).toEqual([FOLDER]);
    expect(saved.appProperties.gatelabWriter).toBe("tab-1");
    const json = JSON.parse(drive.text(saved.id)) as { samples: { fileName: string }[]; gating: { gates: Record<string, { name: string }> } };
    expect(json.samples.map((sample) => sample.fileName)).toEqual(["D1_treated.fcs", "D2_control.fcs"]);
    expect(Object.values(json.gating.gates).map((gate) => gate.name)).toEqual(["CD4_positive"]);
    expect(host.textContent).toContain("Saved to the lab Drive");

    // Sign-out closes the Drive workspace.
    await click(".gl-drive-sign-out");
    await until(shows("Signed out of the lab Drive"), "the sign-out");
    expect(host.textContent).not.toContain("D1_treated.fcs");
    expect(host.textContent).toContain("Signed out of the lab Drive");
    expect(host.querySelector(".gl-agent-menu")).not.toBeNull();

    // Reopened from Drive, the gate is back.
    await click(".gl-drive-sign-in");
    picker.queue.push(() => drive.pick(saved.id, d1, d2));
    await click(".gl-drive-open");
    await until(shows("Opened Experiment 1.gatelab"), "the workspace reopened from Drive");
    expect(host.textContent).toContain("CD4_positive");
    expect(host.textContent).toContain("D2_control.fcs");

    // Another member saves; a save here is refused, and saved as a copy instead.
    drive.externalWrite(saved.id, new TextEncoder().encode(drive.text(saved.id)));
    await importGates("CD8_positive");
    await until(shows("CD8_positive"), "the second gate");
    await click(".gl-side-save");
    await until(shows("Not saved: the workspace changed in the lab Drive"), "the refusal");
    expect(document.body.textContent).toContain("Member Two");
    expect(JSON.parse(drive.text(saved.id)).gating.gates).not.toHaveProperty("g-CD8_positive");
    // "Save as a copy…" is Save As, set to a copy beside the workspace under a dated name.
    await clickText(/Save as a copy/);
    await until(() => document.querySelector(".gl-drive-save-as-ok") !== null, "the Save As dialog");
    expect(document.querySelector<HTMLInputElement>(".gl-drive-save-as-copy")!.checked).toBe(true);
    await click(".gl-drive-save-as-ok");
    await until(shows("Saved a copy to the lab Drive"), "the copy");
    const copies = [...drive.files.values()].map((stored) => stored.meta).filter((meta) => / copy /.test(meta.name));
    expect(copies).toHaveLength(1);
    expect(copies[0].parents).toEqual([FOLDER]);
    expect(drive.text(copies[0].id)).toContain("CD8_positive");
    expect(host.textContent).toContain("Saved a copy to the lab Drive");

    // Nothing of the Drive workspace was kept in this browser.
    expect(vi.mocked(saveWorkspaceCheckpoint)).not.toHaveBeenCalled();
    expect(vi.mocked(requestPersistentWorkspaceHistory)).not.toHaveBeenCalled();
  }, 30_000);

  it("saves FCS opened here as a new experiment, Save As copies within the lab Drive, and a cancelled upload goes on when saved again", async () => {
    const ROOT = FAKE_CONFIG.rootFolderId;
    auth.signedIn = true;
    const d1 = syntheticFcs({ btim: "08:00:00" });
    const plate = twoDataSetFcs();
    act(() => root.render(<App />));
    await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
    await openHere([fileOf("D1_treated.fcs", d1), fileOf("plate.fcs", plate)]);
    await until(shows("plate (data set 2 of 2, A02).fcs"), "the FCS opened on this computer");
    expect(host.textContent).toContain("plate (data set 1 of 2, A01).fcs");
    expect(host.querySelector(".gl-save-local-copy")).toBeNull();

    // Save as new experiment. GateLab may not create in the lab folder until it is picked once.
    picker.folder = { id: ROOT, name: "Lab", mimeType: "application/vnd.google-apps.folder" };
    picker.onFolderPicked = (folder) => drive.writableFolders.add(folder.id);
    await click(".gl-drive-save-new");
    await until(() => document.querySelector(".gl-drive-save-as-ok") !== null, "the new experiment dialog");
    expect(document.querySelector(".gl-drive-save-as-copy")).toBeNull();
    expect(document.body.textContent).toContain("2 FCS files");
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 2");
    await click(".gl-drive-save-as-ok");
    await until(shows("Choose the lab folder"), "the request to pick the lab folder");
    await clickText(/Choose the lab folder/);
    await until(shows("Saved as new experiment"), "the new experiment");
    expect(picker.opened).toContain("lab folder");

    const [folder] = drive.folders(ROOT, "Experiment 2");
    expect(drive.inFolder(folder.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "plate.fcs", "Experiment 2.gatelab"]);
    // The file of two data sets went up once, as it was.
    expect(drive.inFolder(folder.id).find((file) => file.name === "plate.fcs")!.md5Checksum).toBe(md5Hex(plate));
    expect(drive.inFolder(folder.id).find((file) => file.name === "D1_treated.fcs")!.md5Checksum).toBe(md5Hex(d1));
    expect(host.textContent).toContain("Saved as new experiment · Experiment 2/Experiment 2.gatelab · 2 FCS files uploaded");
    // Drive mode from here on: no agent link; the local save is labelled as a copy.
    expect(host.querySelector(".gl-agent-menu")).toBeNull();
    expect(host.querySelector(".gl-save-local-copy")?.textContent).toBe("Save a copy on this computer…");

    // Save writes in place: every sample is now in the lab Drive.
    await importGates("CD4_positive");
    await until(shows("CD4_positive"), "the imported gate");
    await click(".gl-side-save");
    await until(shows("Saved to the lab Drive · Experiment 2/Experiment 2.gatelab"), "the save in place");
    const workspace = drive.inFolder(folder.id).find((file) => file.name === "Experiment 2.gatelab")!;
    const saved = JSON.parse(drive.text(workspace.id)) as { samples: { fileName: string }[] };
    expect(saved.samples.map((sample) => sample.fileName))
      .toEqual(["D1_treated.fcs", "plate (data set 1 of 2, A01).fcs", "plate (data set 2 of 2, A02).fcs"]);

    // Save As while a Drive workspace is open: a copy beside it in the lab Drive, by default.
    await click(".gl-save-as");
    await until(() => document.querySelector(".gl-drive-save-as-ok") !== null, "the Save As dialog");
    expect(document.querySelector<HTMLInputElement>(".gl-drive-save-as-copy")!.checked).toBe(true);
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 2 alt");
    await click(".gl-drive-save-as-ok");
    await until(shows("Saved a copy to the lab Drive · Experiment 2/Experiment 2 alt.gatelab"), "the copy");
    expect(drive.inFolder(folder.id).map((file) => file.name)).toContain("Experiment 2 alt.gatelab");

    // Save As a new experiment, cancelled while its first file is being sent.
    let release: () => void = () => undefined;
    drive.beforeChunk = () => new Promise<void>((resolve) => { release = resolve; });
    await click(".gl-save-as");
    await until(() => document.querySelector(".gl-drive-save-as-experiment") !== null, "the Save As dialog");
    await click(".gl-drive-save-as-experiment");
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 3");
    await click(".gl-drive-save-as-ok");
    await until(() => document.querySelector(".gl-drive-upload-cancel") !== null && shows("File 1 of 2")(), "the upload under way");
    expect(document.querySelector<HTMLProgressElement>(".gl-drive-upload-progress")!.max).toBe(d1.length + plate.length);
    await click(".gl-drive-upload-cancel");
    drive.beforeChunk = null;
    release();
    await until(shows("Cancelled. The experiment folder \"Experiment 3\" in the lab Drive holds 0 of 2 FCS files"), "the cancel");
    expect(document.querySelector(".gl-drive-upload")).toBeNull();
    const [third] = drive.folders(ROOT, "Experiment 3");
    expect(drive.inFolder(third.id)).toEqual([]);
    // The workspace open is still the copy in Experiment 2.
    await click(".gl-side-save");
    await until(shows("Saved to the lab Drive · Experiment 2/Experiment 2 alt.gatelab"), "a save to the copy");

    // Saved again under the same name, it goes on in the same folder.
    await click(".gl-save-as");
    await until(() => document.querySelector(".gl-drive-save-as-experiment") !== null, "the Save As dialog");
    await click(".gl-drive-save-as-experiment");
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 3");
    await click(".gl-drive-save-as-ok");
    await until(shows("Saved as new experiment · Experiment 3/Experiment 3.gatelab"), "the second new experiment");
    expect(drive.folders(ROOT, "Experiment 3")).toHaveLength(1);
    expect(drive.inFolder(third.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "plate.fcs", "Experiment 3.gatelab"]);

    // Reopened from the lab Drive, the file of two data sets opens as its two samples again.
    await click(".gl-drive-sign-out");
    await until(shows("Signed out of the lab Drive"), "the sign-out");
    await click(".gl-drive-sign-in");
    const [ws3, d13, plate3] = ["Experiment 3.gatelab", "D1_treated.fcs", "plate.fcs"]
      .map((name) => drive.inFolder(third.id).find((file) => file.name === name)!.id);
    picker.queue.push(() => drive.pick(ws3, d13, plate3));
    await click(".gl-drive-open");
    await until(shows("Opened Experiment 3.gatelab"), "the new experiment reopened");
    expect(host.textContent).toContain("plate (data set 2 of 2, A02).fcs");
    expect(host.textContent).toContain("CD4_positive");
  }, 60_000);

  it("asks to reconnect once the sign-in has run out, autosaves without asking, and asks before the page is left unsaved", async () => {
    const folder = drive.addFolder("EXPERIMENT_FOLDER_4", FAKE_CONFIG.rootFolderId, "Experiment 4", { reachable: true });
    auth.signedIn = true;
    auth.expired = false;
    const d1 = drive.addOutside(folder, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const d2 = drive.addOutside(folder, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));
    drive.writableFolders.add(folder);
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const gatesIn = (id: string) => Object.values((JSON.parse(drive.text(id)) as { gating: { gates: Record<string, { name: string }> } }).gating.gates)
      .map((gate) => gate.name);
    const workspaceFile = () => drive.inFolder(folder).find((file) => file.name === "Experiment 4.gatelab")!;

    act(() => root.render(<App />));
    await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
    picker.queue.push(() => drive.pick(d1, d2));
    await click(".gl-drive-open");
    await until(() => document.querySelector(".gl-drive-name-ok") !== null, "the new-workspace name");
    await typeInto(".gl-modal-field input", "Experiment 4");
    await click(".gl-drive-name-ok");
    await until(shows("D2_control.fcs"), "the FCS opened from Drive");
    await importGates("CD4_positive");
    await until(shows("CD4_positive"), "the imported gate");
    // Unsaved changes to a Drive workspace: leaving the page asks first.
    expect(leave()).toBe(true);

    // The sign-in runs out. Save asks to reconnect, writes nothing until then, and goes on after it.
    auth.expire();
    await click(".gl-side-save");
    await until(() => document.querySelector(".gl-drive-reconnect-dialog") !== null, "the reconnect prompt");
    expect(document.body.textContent).toContain("Reconnect to lab Drive");
    expect(document.body.textContent).toContain("Experiment 4.gatelab stays as it is, with its unsaved changes");
    expect(drive.byName("Experiment 4.gatelab")).toEqual([]);
    expect(host.textContent).toContain("CD4_positive");
    await click(".gl-drive-reconnect-ok");
    await until(shows("Saved to the lab Drive · Experiment 4/Experiment 4.gatelab"), "the save after the reconnect");
    expect(auth.reconnects).toBe(1);
    expect(document.querySelector(".gl-drive-reconnect-dialog")).toBeNull();
    expect(gatesIn(workspaceFile().id)).toEqual(["CD4_positive"]);
    // An explicit save keeps its revision forever.
    expect(drive.kept).toContain(workspaceFile().headRevisionId);
    expect(leave()).toBe(false);

    // Autosave: a change is written back once the wait is over, through the revision check, and
    // its revision is not kept forever.
    autosaveMs = 300;
    await importGates("CD8_positive");
    await until(shows("Autosaved to the lab Drive · Experiment 4/Experiment 4.gatelab"), "the autosave");
    expect(gatesIn(workspaceFile().id)).toEqual(["CD8_positive"]);
    expect(drive.kept).not.toContain(workspaceFile().headRevisionId);
    expect(leave()).toBe(false);

    // Another member saves: the autosave stops with a line in the status bar, asks nothing, and
    // writes nothing over theirs.
    const theirs = drive.text(workspaceFile().id);
    drive.externalWrite(workspaceFile().id, new TextEncoder().encode(theirs));
    await importGates("CD19_positive");
    await until(shows("Autosave to the lab Drive stopped · Member Two"), "the autosave stopped by the conflict");
    expect(document.querySelector(".gl-modal")).toBeNull();
    expect(drive.text(workspaceFile().id)).toBe(theirs);
    expect(host.querySelector(".gl-drive-autosave-note")?.textContent).toContain("Autosave to the lab Drive stopped");
    expect(leave()).toBe(true);

    // Saved as a copy, the autosave goes on with the copy; then the sign-in runs out, and it stops
    // with a line in the status bar instead of asking.
    await click(".gl-side-save");
    await until(shows("Not saved: the workspace changed in the lab Drive"), "the refusal");
    await clickText(/Save as a copy/);
    await until(() => document.querySelector(".gl-drive-save-as-ok") !== null, "the Save As dialog");
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 4 mine");
    await click(".gl-drive-save-as-ok");
    await until(shows("Saved a copy to the lab Drive · Experiment 4/Experiment 4 mine.gatelab"), "the copy");
    expect(host.querySelector(".gl-drive-autosave-note")).toBeNull();
    auth.expire();
    await importGates("CD56_positive");
    await until(shows("Autosave to the lab Drive stopped · the sign-in has run out"), "the autosave stopped by the sign-in");
    expect(document.querySelector(".gl-drive-reconnect-dialog")).toBeNull();
    const copy = drive.inFolder(folder).find((file) => file.name === "Experiment 4 mine.gatelab")!;
    expect(gatesIn(copy.id)).not.toContain("CD56_positive");

    // Open experiment asks to reconnect too, and the picker opens once reconnected; cancelled there,
    // the workspace open is unchanged.
    const opened = picker.opened.length;
    await click(".gl-drive-open");
    await until(() => document.querySelector(".gl-drive-reconnect-dialog") !== null, "the reconnect prompt for Open");
    expect(document.body.textContent).toContain("Open experiment goes on");
    expect(picker.opened.length).toBe(opened);
    await click(".gl-drive-reconnect-ok");
    await until(() => document.querySelector(".gl-drive-discard") !== null, "the unsaved-changes question");
    await click(".gl-drive-discard");
    await until(() => picker.opened.length === opened + 1, "the picker");
    await until(shows("Open experiment cancelled"), "the cancelled open");
    expect(host.textContent).toContain("CD56_positive");
    // The reconnect let the autosave go on: the copy is written back.
    await until(shows("Autosaved to the lab Drive · Experiment 4/Experiment 4 mine.gatelab"), "the autosave after the reconnect");
    expect(gatesIn(copy.id)).toContain("CD56_positive");
    autosaveMs = 3600_000;
  }, 60_000);

  it("opens a colleague's experiment once its folder is chosen, and refuses files from outside the lab folder", async () => {
    auth.signedIn = true;
    auth.expired = false;
    // Made by another member's GateLab: this member's cannot read the folder until it is chosen.
    const folder = drive.addFolder("EXPERIMENT_FOLDER_5", FAKE_CONFIG.rootFolderId, "Experiment 5");
    const d1 = drive.addOutside(folder, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    // A folder of the member's own, outside the lab folder.
    const elsewhere = drive.addFolder("OWN_FOLDER_0001", "", "Elsewhere", { reachable: true });
    const outside = drive.addOutside(elsewhere, "D2_control.fcs", syntheticFcs({ btim: "11:00:00" }));

    act(() => root.render(<App />));
    await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
    picker.queue.push(() => drive.pick(outside));
    await click(".gl-drive-open");
    await until(shows("The files picked are not in the lab folder"), "the refusal");
    expect(host.textContent).not.toContain("D2_control.fcs");

    picker.queue.push(() => drive.pick(d1));
    picker.folder = { id: folder, name: "Experiment 5", mimeType: "application/vnd.google-apps.folder" };
    picker.onFolderPicked = (chosen) => { drive.pick(chosen.id); };
    await click(".gl-drive-open");
    await until(() => document.querySelector(".gl-drive-pick-folder") !== null, "the request to choose the folder");
    expect(document.body.textContent).toContain("D1_treated.fcs");
    await click(".gl-drive-pick-folder");
    await until(() => document.querySelector(".gl-drive-name-ok") !== null, "the new-workspace name");
    expect(document.querySelector<HTMLInputElement>(".gl-modal-field input")!.value).toBe("Experiment 5");
    await click(".gl-drive-name-ok");
    await until(shows("D1_treated.fcs"), "the FCS opened from Drive");
  }, 30_000);

  it("preloads the app's parts, and holds a chunk's reload while a Drive workspace has unsaved changes", async () => {
    auth.signedIn = true;
    auth.expired = false;
    const folder = drive.addFolder("EXPERIMENT_FOLDER_6", FAKE_CONFIG.rootFolderId, "Experiment 6", { reachable: true });
    const d1 = drive.addOutside(folder, "D1_treated.fcs", syntheticFcs({ btim: "10:00:00" }));
    const reload = vi.fn();
    const location = window.location;
    Object.defineProperty(window, "location", { value: { ...location, reload }, writable: true, configurable: true });
    try {
      act(() => root.render(<App />));
      await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
      await until(() => vi.mocked(preloadLabChunksSoon).mock.calls.length > 0, "the preload");

      picker.queue.push(() => drive.pick(d1));
      await click(".gl-drive-open");
      await until(() => document.querySelector(".gl-drive-name-ok") !== null, "the new-workspace name");
      await click(".gl-drive-name-ok");
      await until(shows("D1_treated.fcs"), "the FCS opened from Drive");
      await importGates("CD4_positive");
      await until(shows("CD4_positive"), "the imported gate");

      // A chunk fetched after the lab site's login lapsed fails as a stale chunk would.
      const failing = lazyChunk("CompensationTab", async () => {
        throw new TypeError("Failed to fetch dynamically imported module: https://lab.example.org/assets/CompensationTab-abc.js");
      });
      let held: unknown = null;
      await act(async () => { held = await failing().catch((error: unknown) => error); });
      expect(held).toBeInstanceOf(ChunkReloadHeldError);
      expect(reload).not.toHaveBeenCalled();
      await until(shows("Part of GateLab could not be loaded from the lab site"), "the message");
      expect(host.textContent).toContain("CD4_positive");
    } finally {
      Object.defineProperty(window, "location", { value: location, writable: true, configurable: true });
    }
  }, 30_000);

  it("saves a new experiment into a folder several folders inside the lab folder", async () => {
    auth.signedIn = true;
    auth.expired = false;
    const ROOT = FAKE_CONFIG.rootFolderId;
    drive.writableFolders.add(ROOT);
    drive.addFolder("DAVID_FOLDER_0001", ROOT, "David");
    drive.addFolder("TESTING_FOLDER_01", "DAVID_FOLDER_0001", "For testing");
    const folder = "application/vnd.google-apps.folder";
    picker.folders.push(
      { id: "TESTING_FOLDER_01", name: "For testing", mimeType: folder },
      { id: "DAVID_FOLDER_0001", name: "David", mimeType: folder },
    );
    picker.onFolderPicked = (chosen) => {
      drive.pick(chosen.id);
      drive.writableFolders.add(chosen.id);
    };
    act(() => root.render(<App />));
    await until(() => host.querySelector(".gl-drive-menu") !== null, "the Lab Drive menu");
    await openHere([fileOf("D1_treated.fcs", syntheticFcs({ btim: "08:30:00" }))]);
    await until(shows("D1_treated.fcs"), "the FCS opened on this computer");

    await click(".gl-drive-save-new");
    await until(() => document.querySelector(".gl-drive-location-choose") !== null, "the location");
    expect(document.querySelector(".gl-drive-location-path")?.textContent).toBe("Lab folder");
    await typeInto(".gl-drive-save-as .gl-modal-field input", "Experiment 7");
    await click(".gl-drive-location-choose");
    await until(() => document.querySelector(".gl-drive-location-above") !== null, "the question about the folder above");
    expect(document.body.textContent).toContain("Choose the folder that holds \"For testing\"");
    await click(".gl-drive-location-above");
    await until(() => document.querySelector(".gl-drive-location-path")?.textContent === "Lab folder / David / For testing", "the location chosen");
    expect(document.body.textContent).toContain("A new folder in Lab folder / David / For testing holds the workspace");
    await click(".gl-drive-save-as-ok");
    await until(shows("Saved as new experiment · Experiment 7/Experiment 7.gatelab in Lab folder / David / For testing"), "the new experiment");
    const [made] = drive.folders("TESTING_FOLDER_01", "Experiment 7");
    expect(drive.inFolder(made.id).map((file) => file.name)).toEqual(["D1_treated.fcs", "Experiment 7.gatelab"]);
    expect(drive.folders(ROOT, "Experiment 7")).toEqual([]);
  }, 30_000);
});
