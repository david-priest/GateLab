import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { readZipFileEntries, writeStoredZip } from "./workspaceArchiveStream";

async function storedArchive(entries: { path: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  await writeStoredZip(entries, (chunk) => { parts.push(chunk.slice()); });
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
const asFile = (bytes: Uint8Array): File => new File([bytes as Uint8Array<ArrayBuffer>], "workspace.gatelab");

// 64 bytes of 16-bit little-endian data in which two adjacent values, 19280 and 2055, spell the
// four bytes of a ZIP data-descriptor signature (50 4B 07 08); the values after them are not zero.
function dataWithZipSignature(): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 32; i++) view.setUint16(i * 2, 1000 + i, true);
  view.setUint16(20, 19280, true);
  view.setUint16(22, 2055, true);
  return bytes;
}

describe("readZipFileEntries", () => {
  it("reads a stored entry whole when its bytes hold a ZIP signature", async () => {
    const data = dataWithZipSignature();
    const zip = await storedArchive([{ path: "data/S1.fcs", bytes: data }, { path: "workspace.json", bytes: strToU8("{}") }]);
    expect(unzipSync(zip)["data/S1.fcs"]).toEqual(data);
    const unhinted = await readZipFileEntries(asFile(zip), { select: () => true });
    expect(unhinted["data/S1.fcs"]).toEqual(data);
    expect(new TextDecoder().decode(unhinted["workspace.json"])).toBe("{}");
    const hinted = await readZipFileEntries(asFile(zip), { select: () => true, expectedSize: (path) => (path === "data/S1.fcs" ? 64 : undefined) });
    expect(hinted["data/S1.fcs"]).toEqual(data);
  });

  it("gives each entry to onEntry before the next is read, so a manifest can size what follows", async () => {
    const data = dataWithZipSignature();
    const zip = await storedArchive([{ path: "manifest.json", bytes: strToU8(JSON.stringify({ "data/S1.fcs": 64 })) }, { path: "data/S1.fcs", bytes: data }]);
    const sizes = new Map<string, number>();
    const asked: (number | undefined)[] = [];
    const files = await readZipFileEntries(asFile(zip), {
      select: () => true,
      expectedSize: (path) => { if (path === "data/S1.fcs") asked.push(sizes.get(path)); return sizes.get(path); },
      onEntry: (path, bytes) => { if (path === "manifest.json") for (const [k, v] of Object.entries(JSON.parse(new TextDecoder().decode(bytes)))) sizes.set(k, v as number); },
    });
    expect(asked).toEqual([64]);
    expect(files["data/S1.fcs"]).toEqual(data);
  });

  it("refuses an entry that is not the size declared for it", async () => {
    const zip = await storedArchive([{ path: "data/S1.fcs", bytes: dataWithZipSignature() }]);
    await expect(readZipFileEntries(asFile(zip), { select: () => true, expectedSize: () => 63 })).rejects.toThrow(/exceeds its declared byte length/);
    await expect(readZipFileEntries(asFile(zip), { select: () => true, expectedSize: () => 65 })).rejects.toThrow(/does not match its declared byte length/);
  });

  it("reads a deflated archive, and holds it to the entry and total limits", async () => {
    const text = strToU8("CD4_positive,".repeat(400));
    const zip = zipSync({ "workspace.json": text, "data/S1.fcs": dataWithZipSignature() }, { level: 6 });
    const files = await readZipFileEntries(asFile(zip), { select: () => true });
    expect(files["workspace.json"]).toEqual(text);
    expect(files["data/S1.fcs"]).toEqual(dataWithZipSignature());
    await expect(readZipFileEntries(asFile(zip), { select: () => true, unknownEntryLimit: 100 })).rejects.toThrow(/exceeds the safety limit/);
    await expect(readZipFileEntries(asFile(zip), { select: () => true, totalOutputLimit: 5000 })).rejects.toThrow(/aggregate decompressed-byte safety limit/);
  });

  it("skips entries that are not selected and refuses an unsafe path", async () => {
    const zip = zipSync({ "workspace.json": strToU8("{}"), "notes/readme.txt": strToU8("x"), "../outside.txt": strToU8("x") }, { level: 0 });
    const files = await readZipFileEntries(asFile(zip), { select: (path) => path === "workspace.json" });
    expect(Object.keys(files)).toEqual(["workspace.json"]);
    await expect(readZipFileEntries(asFile(zip), { select: () => true })).rejects.toThrow(/Unsafe or duplicate ZIP entry/);
  });

  it("falls back to the streamed reading when the archive has no directory to rely on", async () => {
    const zip = await storedArchive([{ path: "workspace.json", bytes: strToU8('{"a":1}') }]);
    // The end record removed: the entries are still there, in order.
    const cut = zip.slice(0, zip.length - 22);
    const files = await readZipFileEntries(asFile(cut), { select: () => true });
    expect(new TextDecoder().decode(files["workspace.json"])).toBe('{"a":1}');
  });
});
