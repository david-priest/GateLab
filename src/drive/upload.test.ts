// Resumable upload into the lab Drive, against the in-memory Drive: 8 MiB chunks; a 5xx answered by
// asking the session what it holds; a 500 on a file Drive stored is not uploaded again, whether the
// session says so or only the folder's MD5 does; a dropped session is replaced only after the folder
// is checked; cancel stops it; a file that arrived altered is refused. Synthetic names.

import { describe, expect, it } from "vitest";
import { md5Hex } from "./md5";
import { FakeDrive } from "./testFakeDrive";
import { UPLOAD_CHUNK_BYTES, UPLOAD_KEY, uploadFile } from "./upload";

const FOLDER = "EXPERIMENT_FOLDER_1";
const MiB = 1024 * 1024;
const noWait = async () => undefined;

function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 9)) & 255;
  return out;
}
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));

function setup() {
  const drive = new FakeDrive();
  drive.writableFolders.add(FOLDER);
  return { drive, target: { folderId: FOLDER, driveId: "SHARED_DRIVE_01" } };
}

/** The upload requests made, without the listings and metadata reads around them. */
const uploadCalls = (drive: FakeDrive) => drive.calls.filter((call) => /^(start|chunk|query) /.test(call));

describe("uploading an FCS file to the lab Drive", () => {
  it("sends the file in 8 MiB chunks and confirms Drive's MD5", async () => {
    const { drive, target } = setup();
    const size = 2 * UPLOAD_CHUNK_BYTES + 123;
    const bytes = bytesOf(size);
    const progress: number[] = [];
    const result = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait, onProgress: (sent) => progress.push(sent) });
    expect(UPLOAD_CHUNK_BYTES).toBe(8 * MiB);
    expect(uploadCalls(drive)).toEqual([
      "start D1_treated.fcs",
      `chunk D1_treated.fcs 0-${8 * MiB}`,
      `chunk D1_treated.fcs ${8 * MiB}-${16 * MiB}`,
      `chunk D1_treated.fcs ${16 * MiB}-${size}`,
    ]);
    expect(result.already).toBe(false);
    expect(result.file.md5Checksum).toBe(md5Hex(bytes));
    expect(same(drive.files.get(result.file.id)!.bytes, bytes)).toBe(true);
    expect(result.file.appProperties[UPLOAD_KEY]).toBeTruthy();
    expect(progress.at(-1)).toBe(size);
    expect(progress).toContain(8 * MiB);
  });

  it("asks the session after a 5xx and sends again only what Drive does not hold", async () => {
    const { drive, target } = setup();
    const size = 2 * UPLOAD_CHUNK_BYTES + 5;
    const bytes = bytesOf(size, 2);
    // The second chunk is refused unread; the third is kept although Drive answers 503.
    drive.faults.push({ on: "chunk", status: 503, when: ({ start }) => start === 8 * MiB });
    drive.faults.push({ on: "chunk", status: 502, applied: true, when: ({ start, end }) => start === 8 * MiB && end === 16 * MiB });
    const result = await uploadFile(drive, target, { name: "D2_control.fcs", bytes }, { sleep: noWait });
    expect(uploadCalls(drive)).toEqual([
      "start D2_control.fcs",
      `chunk D2_control.fcs 0-${8 * MiB}`,
      `chunk D2_control.fcs ${8 * MiB}-${16 * MiB}`,
      "query D2_control.fcs",
      `chunk D2_control.fcs ${8 * MiB}-${16 * MiB}`,
      "query D2_control.fcs",
      `chunk D2_control.fcs ${16 * MiB}-${size}`,
    ]);
    expect(same(drive.files.get(result.file.id)!.bytes, bytes)).toBe(true);
  });

  it("takes the file a 500 stored, when the session says it is complete: no duplicate", async () => {
    const { drive, target } = setup();
    const bytes = bytesOf(3 * MiB, 3);
    drive.faults.push({ on: "chunk", status: 500, applied: true });
    const result = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait });
    expect(uploadCalls(drive)).toEqual(["start D1_treated.fcs", `chunk D1_treated.fcs 0-${3 * MiB}`, "query D1_treated.fcs"]);
    expect(drive.byName("D1_treated.fcs")).toHaveLength(1);
    expect(result.file.id).toBe(drive.byName("D1_treated.fcs")[0].id);
    expect(result.already).toBe(false);
  });

  it("finds the file a 500 stored by its MD5 in the folder when the session cannot say: no duplicate", async () => {
    const { drive, target } = setup();
    const bytes = bytesOf(3 * MiB, 4);
    drive.faults.push({ on: "chunk", status: 500, applied: true });
    drive.faults.push({ on: "query", status: 404 });
    const result = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait });
    expect(uploadCalls(drive)).toEqual(["start D1_treated.fcs", `chunk D1_treated.fcs 0-${3 * MiB}`, "query D1_treated.fcs"]);
    // The folder was listed again before any new session, and the stored file was taken.
    expect(drive.calls.filter((call) => call.startsWith("list "))).toHaveLength(2);
    expect(drive.byName("D1_treated.fcs")).toHaveLength(1);
    expect(result.file.md5Checksum).toBe(md5Hex(bytes));
  });

  it("starts a new session when Drive drops one, after checking the folder", async () => {
    const { drive, target } = setup();
    const size = UPLOAD_CHUNK_BYTES + 10;
    const bytes = bytesOf(size, 5);
    drive.faults.push({ on: "chunk", status: 404, when: ({ start }) => start === 8 * MiB });
    const result = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait });
    expect(drive.calls.filter((call) => /^(list|start|chunk|query) /.test(call))).toEqual([
      `list ${FOLDER}`,
      "start D1_treated.fcs",
      `chunk D1_treated.fcs 0-${8 * MiB}`,
      `chunk D1_treated.fcs ${8 * MiB}-${size}`,
      `list ${FOLDER}`,
      "start D1_treated.fcs",
      `chunk D1_treated.fcs 0-${8 * MiB}`,
      `chunk D1_treated.fcs ${8 * MiB}-${size}`,
    ]);
    expect(drive.byName("D1_treated.fcs")).toHaveLength(1);
    expect(same(drive.files.get(result.file.id)!.bytes, bytes)).toBe(true);
  });

  it("asks the session after no answer at all, and goes on when the Range header cannot be read", async () => {
    const { drive, target } = setup();
    drive.rangeHidden = true;
    const size = 2 * UPLOAD_CHUNK_BYTES + 1;
    const bytes = bytesOf(size, 6);
    drive.faults.push({ on: "chunk", status: 0, when: ({ start }) => start === 16 * MiB });
    const result = await uploadFile(drive, target, { name: "D2_control.fcs", bytes }, { sleep: noWait });
    expect(same(drive.files.get(result.file.id)!.bytes, bytes)).toBe(true);
    expect(drive.byName("D2_control.fcs")).toHaveLength(1);
  });

  it("does not send a file the folder already holds, and does send one of the same name and other content", async () => {
    const { drive, target } = setup();
    const bytes = bytesOf(2 * MiB, 7);
    const first = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait });
    drive.calls.length = 0;
    const again = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, { sleep: noWait });
    expect(again).toMatchObject({ already: true, file: { id: first.file.id } });
    expect(uploadCalls(drive)).toEqual([]);
    const other = bytesOf(2 * MiB, 8);
    const second = await uploadFile(drive, target, { name: "D1_treated.fcs", bytes: other }, { sleep: noWait });
    expect(second.already).toBe(false);
    expect(drive.byName("D1_treated.fcs")).toHaveLength(2);
  });

  it("stops when cancelled, and nothing is stored", async () => {
    const { drive, target } = setup();
    const controller = new AbortController();
    const bytes = bytesOf(3 * UPLOAD_CHUNK_BYTES, 9);
    const upload = uploadFile(drive, target, { name: "D1_treated.fcs", bytes }, {
      sleep: noWait,
      signal: controller.signal,
      onProgress: (sent) => { if (sent >= UPLOAD_CHUNK_BYTES) controller.abort(); },
    });
    await expect(upload).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(uploadCalls(drive)).toEqual(["start D1_treated.fcs", `chunk D1_treated.fcs 0-${8 * MiB}`]);
    expect(drive.byName("D1_treated.fcs")).toHaveLength(0);
  });

  it("refuses a file that arrived altered", async () => {
    const { drive, target } = setup();
    drive.alterUploads = true;
    await expect(uploadFile(drive, target, { name: "D1_treated.fcs", bytes: bytesOf(MiB, 10) }, { sleep: noWait }))
      .rejects.toThrow(/arrived in the lab Drive altered/);
  });

  it("refuses a 4xx without asking the session", async () => {
    const { drive, target } = setup();
    drive.faults.push({ on: "chunk", status: 400 });
    await expect(uploadFile(drive, target, { name: "D1_treated.fcs", bytes: bytesOf(MiB, 11) }, { sleep: noWait }))
      .rejects.toThrow(/HTTP 400/);
    expect(uploadCalls(drive)).toEqual(["start D1_treated.fcs", `chunk D1_treated.fcs 0-${MiB}`]);
  });
});
