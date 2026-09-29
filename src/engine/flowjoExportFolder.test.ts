// @vitest-environment jsdom
//
// A FlowJo export written as a self-contained folder: where each file goes, the uri the workspace
// names it by, the bytes written, and the .zip where the browser cannot write a folder.
// Synthetic file names and bytes throughout.

import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import {
  fitsInZip,
  flowJoFolderUri,
  formatByteSize,
  nameProblems,
  planFlowJoFolder,
  previewFlowJoFolder,
  storedZipBytes,
  writableName,
  writeFlowJoFolder,
  writeFlowJoZip,
  ZIP_MAX_BYTES,
} from "./flowjoExportFolder";
import { writeStoredZip } from "./workspaceArchiveStream";
import { apfsFold, asDirectory, MemoryDirectoryHandle, type MemoryFileHandle } from "../testDirectory";

/**
 * Chrome's refusal of a name written to disk, as a test folder applies it, written out here apart
 * from nameProblems so the two are not one rule tested against itself: characters, ends, a
 * reserved device name and the extensions the tests use.
 */
const chromeRefuses = (name: string): boolean =>
  /["*/:<>?\\|\u0000-\u001f]/.test(name) ||
  /^[\s.~]/.test(name.startsWith(".") ? name.slice(1) : name) || /[\s.~]$/.test(name) ||
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ||
  /\.(lnk|url|scf|ini)$/i.test(name) ||
  name === "" || name === "." || name === "..";

const bytes = (...values: number[]) => Uint8Array.from(values);
const paths = (sources: { name: string; bytes: Uint8Array | null }[], workspace = "export.wsp") =>
  planFlowJoFolder(sources, workspace).files.map((f) => f.path);

describe("where each file goes", () => {
  it("puts every file at the top under its own name when no two share one", () => {
    expect(paths([{ name: "D1.fcs", bytes: bytes(1) }, { name: "D2 run #3.fcs", bytes: bytes(2) }])).toEqual(["D1.fcs", "D2 run #3.fcs"]);
  });

  it("puts the k-th file of a name in subfolder k, under the same name, case and normalisation folded", () => {
    const sources = [
      { name: "D1.fcs", bytes: bytes(1) },
      { name: "d1.FCS", bytes: bytes(2) },
      { name: "D2.fcs", bytes: bytes(3) },
      { name: "D1.fcs", bytes: bytes(4) },
      { name: "Ü.fcs", bytes: bytes(5) },
      { name: "Ü.fcs", bytes: bytes(6) },
    ];
    const expected = ["D1.fcs", "2/d1.FCS", "D2.fcs", "3/D1.fcs", "Ü.fcs", "2/Ü.fcs"];
    expect(paths(sources)).toEqual(expected);
    // The same files in the same order always go to the same places.
    expect(paths(sources)).toEqual(expected);
  });

  it("folds names as APFS compares them, full case folding included, so no two files at one level are one name to it", () => {
    // Each group is one name to APFS: the micro sign and Greek mu; ß, "SS" and ẞ, whose lower case
    // is ß; final and medial sigma; long s and s; the ligature ﬁ and "fi"; ŉ and ʼn.
    const names = [
      "D1 1\u00b5g.fcs", "D1 1\u03bcg.fcs", "D2\u00df.fcs", "D2SS.fcs", "D2\u1e9e.fcs", "D3\u03c2.fcs", "D3\u03c3.fcs",
      "D4\u017f.fcs", "D4s.fcs", "D5 \ufb01x.fcs", "D5 fix.fcs", "D6\u0149.fcs", "D6\u02bcn.fcs",
    ];
    const got = paths(names.map((name, i) => ({ name, bytes: bytes(i) })));
    expect(got).toEqual([
      names[0], `2/${names[1]}`, names[2], `2/${names[3]}`, `3/${names[4]}`, names[5], `2/${names[6]}`,
      names[7], `2/${names[8]}`, names[9], `2/${names[10]}`, names[11], `2/${names[12]}`,
    ]);
    expect(new Set(got.map(apfsFold)).size).toBe(got.length);
  });

  it("never renames a file into a name APFS takes to be another file's", () => {
    // "a:ß.fcs" is written as "a_ß.fcs", which APFS takes to be "a_ss.fcs".
    expect(paths([{ name: "a:\u00df.fcs", bytes: bytes(1) }, { name: "a_ss.fcs", bytes: bytes(2) }])).toEqual(["a_\u00df 2.fcs", "a_ss.fcs"]);
  });

  it("counts the workspace's own name as taken", () => {
    expect(paths([{ name: "export.wsp", bytes: bytes(1) }])).toEqual(["2/export.wsp"]);
  });

  it("gives a subfolder a \"_\" where a file at the top already has its name", () => {
    expect(paths([{ name: "A.fcs", bytes: bytes(1) }, { name: "A.fcs", bytes: bytes(2) }, { name: "2", bytes: bytes(3) }]))
      .toEqual(["A.fcs", "2_/A.fcs", "2"]);
  });

  it("writes a file renamed because Chrome refuses its name under a name no other file of the export has", () => {
    const plan = planFlowJoFolder([
      { name: "a:b.fcs", bytes: bytes(1) },
      { name: "a_b.fcs", bytes: bytes(2) },
      { name: "a*b.fcs", bytes: bytes(3) },
      { name: "a:b.fcs", bytes: bytes(4) },
      { name: "D1.fcs ", bytes: bytes(5) },
    ], "export.wsp");
    // The file whose own name Chrome writes keeps it; each renamed name is its own, and two files
    // of one refused name share their new one, the second in a subfolder as any shared name is.
    expect(plan.files.map((f) => f.path)).toEqual(["a_b 2.fcs", "a_b.fcs", "a_b 3.fcs", "2/a_b 2.fcs", "D1.fcs"]);
    expect(plan.files.map((f) => f.renamed.map((p) => p.kind))).toEqual([["characters"], [], ["characters"], ["characters"], ["ends"]]);
  });

  it("never renames a file into the workspace's name", () => {
    expect(paths([{ name: "export.wsp.", bytes: bytes(1) }])).toEqual(["export 2.wsp"]);
  });

  it("names, before writing, each file renamed and why, apart from the files moved into a subfolder", () => {
    const plan = planFlowJoFolder([
      { name: "D1.fcs", bytes: bytes(1) },
      { name: "D1.fcs", bytes: bytes(2) },
      { name: "CON.fcs", bytes: bytes(3) },
    ], "export.wsp");
    const preview = previewFlowJoFolder(plan, "export", 12);
    expect(preview.moved).toEqual([{ name: "D1.fcs", path: "2/D1.fcs" }]);
    expect(preview.renamed).toEqual([{ name: "CON.fcs", path: "_CON.fcs", problems: [{ kind: "reserved" }] }]);
  });

  it("places a file whose bytes GateLab does not hold, and says it is missing", () => {
    const plan = planFlowJoFolder([{ name: "D1.fcs", bytes: bytes(1, 2, 3) }, { name: "hosted", bytes: null }, { name: "D1.fcs", bytes: bytes(4) }], "D1_and_2_more.wsp");
    expect(plan.files.map((f) => f.path)).toEqual(["D1.fcs", "hosted", "2/D1.fcs"]);
    expect(plan.fcsBytes).toBe(4);
    const preview = previewFlowJoFolder(plan, "D1_and_2_more", 0);
    expect(preview.fileCount).toBe(2);
    expect(preview.missing).toEqual(["hosted"]);
    expect(preview.moved).toEqual([{ name: "D1.fcs", path: "2/D1.fcs" }]);
  });
});

describe("the names Chrome will not write to disk", () => {
  // Chromium's FileSystemAccessManagerImpl::IsSafePathComponent, which getFileHandle and
  // getDirectoryHandle apply to a folder on disk: base::i18n::IsFilenameLegal after one leading
  // ".", the extensions it refuses, a trailing ".", and base::IsReservedNameOnWindows.
  const kinds = (name: string) => nameProblems(name).map((p) => p.kind);

  it("lets through the names it writes, a leading \".\" among them", () => {
    for (const name of [
      "D1.fcs", "D2 run #3.fcs", "a&b%c'd[1];e=f+g,h.fcs", "Ü.fcs", ".hidden.fcs", "D1 (data set 2 of 3, A02).fcs",
      "D1~1 long name.fcs", "con_run.fcs", "COM10.fcs", "sample.local", "D1.fcs.gz", "1", "_",
    ]) expect([name, kinds(name)]).toEqual([name, []]);
  });

  it("refuses the characters it never writes, visible or not", () => {
    expect(nameProblems("a:b.fcs")).toEqual([{ kind: "characters", characters: [":"] }]);
    expect(nameProblems('x"y*z?<a>|b.fcs')).toEqual([{ kind: "characters", characters: ['"', "*", "?", "<", ">", "|"] }]);
    expect(nameProblems("run/1\\D1.fcs")).toEqual([{ kind: "characters", characters: ["/", "\\"] }]);
    for (const invisible of ["\t", "\u0000", "\u007f", "\u0085", "\u200b", "\u200e", "\ufeff", "\ufdd0", "\uffff", "\ud800"]) {
      expect(nameProblems(`D1${invisible}x.fcs`)).toEqual([{ kind: "characters", characters: [invisible] }]);
    }
  });

  it("refuses a space, \".\" or \"~\" at either end, after one leading \".\"", () => {
    for (const name of [" D1.fcs", "D1.fcs ", "D1.fcs.", "~D1 run.fcs", "D1.fcs~", "..D1.fcs", ". D1.fcs", "D1.fcs\u00a0", "\u3000D1.fcs", "..."]) {
      expect([name, kinds(name)]).toEqual([name, ["ends"]]);
    }
  });

  it("refuses the names Windows reserves for devices, on every system", () => {
    for (const name of ["CON", "con.fcs", "Aux.FCS", "nul.x.fcs", "COM1.fcs", "lpt9", "clock$.fcs", "CONIN$", "conout$", "Thumbs.db", "con ", "con."]) {
      expect(kinds(name)).toContain("reserved");
    }
    expect(kinds("desktop.ini")).toEqual(["extension", "reserved"]);
  });

  it("refuses the extensions it will not write", () => {
    for (const ext of ["lnk", "URL", "scf", "dll", "cfg", "ini", "manifest", "dng", "{0AFACED1-E828-11D1-9187-B532F1E9575D}"]) {
      expect(nameProblems(`D1.${ext}`)).toEqual([{ kind: "extension", extension: ext }]);
    }
  });

  it("refuses a \"~\" in a name of the 8.3 form, as Chrome does on Windows", () => {
    for (const name of ["AB~1.fcs", "D1~2", "ABCDEFG~.X", ".A~1.fcs"]) expect([name, kinds(name)]).toEqual([name, ["tilde"]]);
    for (const name of ["ABCDEFGH~1.fcs", "A~1.fcss", "A B~1.fcs", "A~1.b.fcs"]) expect([name, kinds(name)]).toEqual([name, []]);
  });

  it("refuses an empty name and the names of the folder and its parent", () => {
    for (const name of ["", ".", ".."]) expect(kinds(name)).toEqual(["empty"]);
  });
});

describe("the name a refused name is written under", () => {
  it("replaces each refused character with \"_\", drops what Chrome refuses at the end, and marks the start", () => {
    expect(writableName("a:b.fcs")).toBe("a_b.fcs");
    expect(writableName("run/1\\D1.fcs")).toBe("run_1_D1.fcs");
    expect(writableName("D1\u0000.fcs")).toBe("D1_.fcs");
    expect(writableName("lone\ud800.fcs")).toBe("lone_.fcs");
    // The end is dropped so the extension stays the last thing in the name.
    expect(writableName("D1.fcs ")).toBe("D1.fcs");
    expect(writableName("D1.fcs.")).toBe("D1.fcs");
    expect(writableName("D1.fcs~")).toBe("D1.fcs");
    expect(writableName(" D1.fcs")).toBe("_D1.fcs");
    expect(writableName("~D1.fcs")).toBe("_D1.fcs");
    expect(writableName("..D1.fcs")).toBe("_D1.fcs");
  });

  it("adds .fcs after an extension it refuses, and \"_\" before a reserved name", () => {
    expect(writableName("D1.lnk")).toBe("D1.lnk.fcs");
    expect(writableName("desktop.ini")).toBe("desktop.ini.fcs");
    expect(writableName("CON.fcs")).toBe("_CON.fcs");
    expect(writableName("Thumbs.db")).toBe("_Thumbs.db");
    expect(writableName("AB~1.fcs")).toBe("AB_1.fcs");
    for (const name of ["", ".", "..", "...", " ", "~"]) expect(writableName(name)).toBe("_");
  });

  it("keeps every name Chrome writes, and makes every other one a name it writes", () => {
    const names = [
      "D1.fcs", ".hidden.fcs", "a:b.fcs", "..D1.fcs.", " ~con.fcs", "con .fcs", "CON", "com1.lnk", "LPT1.fcs ",
      "x.{1}", "AB~1.fcs", ".A~1", "D1.fcs\u00a0", "\u200bD1.fcs", "a\ud800b", "desktop.ini", "conin$", "~",
      "D1 (data set 2 of 3, A02).fcs", "Ü:ü.fcs", "\t", "aux.fcs.", "AUX .fcs",
    ];
    for (const name of names) {
      const written = writableName(name);
      expect([name, nameProblems(written)]).toEqual([name, []]);
      expect([name, chromeRefuses(written)]).toEqual([name, false]);
      if (!nameProblems(name).length) expect(written).toBe(name);
    }
  });
});

describe("the uri the workspace names a file by", () => {
  it("is file: and each segment percent-encoded, a raw # or ? or & never left in it", () => {
    expect(flowJoFolderUri("D1 #2&x?.fcs")).toBe("file:D1%20%232%26x%3F.fcs");
    expect(flowJoFolderUri("2/D1 run.fcs")).toBe("file:2/D1%20run.fcs");
    expect(flowJoFolderUri("D2_ü.fcs")).toBe("file:D2_%C3%BC.fcs");
    expect(flowJoFolderUri("plate (data set 2 of 3, A02).fcs")).toBe("file:plate%20(data%20set%202%20of%203%2C%20A02).fcs");
  });
});

describe("sizes", () => {
  it("are stated in decimal units, as Finder states them", () => {
    expect(formatByteSize(1)).toBe("1 byte");
    expect(formatByteSize(999)).toBe("999 bytes");
    expect(formatByteSize(1000)).toBe("1.0 kB");
    expect(formatByteSize(999_960)).toBe("1.0 MB");
    expect(formatByteSize(1_834_000_000)).toBe("1.8 GB");
    expect(formatByteSize(ZIP_MAX_BYTES)).toBe("4.3 GB");
  });

  it("of a stored .zip are what writeStoredZip writes, byte for byte", async () => {
    const entries = [
      { path: "f/f.wsp", bytes: Uint8Array.from(new TextEncoder().encode("<Workspace/>")) },
      { path: "f/D1 run.fcs", bytes: new Uint8Array(3000).fill(7) },
      { path: "f/2/Dü.fcs", bytes: new Uint8Array(0) },
    ];
    let written = 0;
    await writeStoredZip(entries, (chunk) => { written += chunk.byteLength; });
    expect(storedZipBytes(entries.map((e) => ({ path: e.path, byteLength: e.bytes.byteLength })))).toBe(written);
  });
});

describe("writing the folder", () => {
  const source = [
    { name: "D1.fcs", bytes: Uint8Array.from({ length: 50 }, (_, i) => i) },
    { name: "D1.fcs", bytes: Uint8Array.from({ length: 23 }, (_, i) => 200 - i) },
    { name: "hosted", bytes: null },
    { name: "D2 & #1.fcs", bytes: bytes(9, 8, 7) },
  ];

  it("writes each file's bytes as they are, in chunks, under a new folder, and the workspace last", async () => {
    const parent = new MemoryDirectoryHandle("Desktop");
    const plan = planFlowJoFolder(source, "D1_and_3_more.wsp");
    const progress: string[] = [];
    const { folder, written } = await writeFlowJoFolder(asDirectory(parent), "D1_and_3_more", plan, "<Workspace/>", {
      chunkBytes: 16,
      onProgress: (n, total, path) => progress.push(`${n}/${total} ${path}`),
    });
    expect(folder.name).toBe("D1_and_3_more");
    expect(written).toBe(3);
    const files = parent.files();
    expect([...files.keys()]).toEqual(["D1_and_3_more/D1.fcs", "D1_and_3_more/2/D1.fcs", "D1_and_3_more/D2 & #1.fcs", "D1_and_3_more/D1_and_3_more.wsp"]);
    expect(files.get("D1_and_3_more/D1.fcs")).toEqual(source[0].bytes);
    expect(files.get("D1_and_3_more/2/D1.fcs")).toEqual(source[1].bytes);
    expect(files.get("D1_and_3_more/D2 & #1.fcs")).toEqual(source[3].bytes);
    expect(new TextDecoder().decode(files.get("D1_and_3_more/D1_and_3_more.wsp"))).toBe("<Workspace/>");
    // The workspace closes after every FCS file.
    expect(parent.log[parent.log.length - 1]).toBe("D1_and_3_more/D1_and_3_more.wsp");
    const first = (parent.entries.get("D1_and_3_more") as MemoryDirectoryHandle).entries.get("D1.fcs") as MemoryFileHandle;
    expect(first.writes).toBe(4);
    expect(progress).toEqual(["1/3 D1.fcs", "2/3 2/D1.fcs", "3/3 D2 & #1.fcs"]);
  });

  it("never writes into a folder or over a file already there", async () => {
    const parent = new MemoryDirectoryHandle("Desktop");
    await parent.getDirectoryHandle("export", { create: true });
    parent.put("export 2", bytes(1));
    const { folder } = await writeFlowJoFolder(asDirectory(parent), "export", planFlowJoFolder(source.slice(0, 1), "export.wsp"), "<Workspace/>");
    expect(folder.name).toBe("export 3");
    expect([...parent.files().keys()]).toEqual(["export 2", "export 3/D1.fcs", "export 3/export.wsp"]);
  });

  it("writes a file whose name Chrome refuses under the name the plan gives it, which Chrome writes", async () => {
    // A folder refusing names as Chrome does (chromeRefuses above); every file still lands.
    const parent = new MemoryDirectoryHandle("Desktop", [], "", { refuse: chromeRefuses });
    const refused = [
      { name: "D1 1:2.fcs", bytes: bytes(1) },
      { name: "aux.fcs", bytes: bytes(2) },
      { name: "D3.fcs.", bytes: bytes(3) },
      { name: "D4.lnk", bytes: bytes(4) },
    ];
    expect(refused.map((r) => chromeRefuses(r.name))).toEqual([true, true, true, true]);
    await writeFlowJoFolder(asDirectory(parent), "export", planFlowJoFolder(refused, "export.wsp"), "<Workspace/>");
    const files = parent.files();
    expect([...files.keys()]).toEqual(["export/D1 1_2.fcs", "export/_aux.fcs", "export/D3.fcs", "export/D4.lnk.fcs", "export/export.wsp"]);
    expect(["D1 1_2.fcs", "_aux.fcs", "D3.fcs", "D4.lnk.fcs"].map((name) => files.get(`export/${name}`))).toEqual(refused.map((r) => r.bytes));
  });

  it("writes both of two files whose names APFS takes to be one, each byte for byte", async () => {
    // A folder comparing names as APFS does: the second file at the top would open the first.
    const parent = new MemoryDirectoryHandle("Desktop", [], "", { fold: apfsFold });
    const folded = [{ name: "D1 1\u00b5g.fcs", bytes: bytes(1, 2) }, { name: "D1 1\u03bcg.fcs", bytes: bytes(3, 4, 5) }];
    await writeFlowJoFolder(asDirectory(parent), "export", planFlowJoFolder(folded, "export.wsp"), "<Workspace/>");
    const files = parent.files();
    expect([...files.keys()]).toEqual(["export/D1 1\u00b5g.fcs", "export/2/D1 1\u03bcg.fcs", "export/export.wsp"]);
    expect(files.get("export/D1 1\u00b5g.fcs")).toEqual(folded[0].bytes);
    expect(files.get("export/2/D1 1\u03bcg.fcs")).toEqual(folded[1].bytes);
    expect(new TextDecoder().decode(files.get("export/export.wsp"))).toBe("<Workspace/>");
  });

  /** The message writeFlowJoFolder stops with, or "" where it does not stop. */
  const stoppedWith = (parent: MemoryDirectoryHandle, plan: ReturnType<typeof planFlowJoFolder>) =>
    writeFlowJoFolder(asDirectory(parent), "export", plan, "<Workspace/>").then(() => "", (e: Error) => e.message);

  it("stops, rather than write over it, where the disk takes a file's name to be one already written", async () => {
    // A disk folding names further than GateLab knows of: to it, D1.fcs and D2.fcs are one name.
    const parent = new MemoryDirectoryHandle("Desktop", [], "", { fold: (name) => name.replace(/\d/g, "#") });
    const plan = planFlowJoFolder([{ name: "D1.fcs", bytes: bytes(1) }, { name: "D2.fcs", bytes: bytes(2) }], "export.wsp");
    expect(await stoppedWith(parent, plan)).toBe(
      "Stopped at D2.fcs: The disk takes its name to be that of a file already in the folder, which writing it would replace. " +
        "The folder export in Desktop is incomplete: it holds 1 of the 2 FCS files and no workspace.",
    );
    expect([...parent.files()]).toEqual([["export/D1.fcs", bytes(1)]]);
  });

  it("stops, rather than write the workspace over it, where the disk takes an FCS file's name to be the workspace's", async () => {
    const parent = new MemoryDirectoryHandle("Desktop", [], "", { fold: (name) => name.replace(/\.(fcs|wsp)$/, "") });
    const plan = planFlowJoFolder([{ name: "export.fcs", bytes: bytes(1, 2) }], "export.wsp");
    expect(await stoppedWith(parent, plan)).toBe(
      "Stopped at export.wsp: The disk takes its name to be that of a file already in the folder, which writing it would replace. " +
        "The folder export in Desktop is incomplete: it holds the FCS file and no workspace.",
    );
    // The FCS file stays as written: it is not taken away as an empty workspace would be.
    expect([...parent.files()]).toEqual([["export/export.fcs", bytes(1, 2)]]);
  });

  /** A folder that fails, as a full disk does, where `fail` says. */
  const failing = (fail: (path: string, step: "directory" | "file" | "write") => boolean) =>
    new MemoryDirectoryHandle("Desktop", [], "", { fail });
  const plan = () => planFlowJoFolder(source, "export.wsp");

  it("says, where a file cannot be written, that the folder is incomplete and which file it stopped at", async () => {
    const parent = failing((path, step) => path === "export/2/D1.fcs" && step === "write");
    await expect(writeFlowJoFolder(asDirectory(parent), "export", plan(), "<Workspace/>")).rejects.toThrow(
      "Stopped at 2/D1.fcs: The disk is full. The folder export in Desktop is incomplete: it holds 1 of the 3 FCS files and no workspace. Export again.",
    );
    // No workspace in it, so nothing reads it as one.
    expect([...parent.files().keys()].filter((path) => path.endsWith(".wsp"))).toEqual([]);
  });

  it("says so too where a subfolder cannot be made, naming the file that was to go in it", async () => {
    const parent = failing((path, step) => path === "export/2" && step === "directory");
    await expect(writeFlowJoFolder(asDirectory(parent), "export", plan(), "<Workspace/>")).rejects.toThrow(
      "Stopped at 2/D1.fcs: The disk is full. The folder export in Desktop is incomplete: it holds 1 of the 3 FCS files and no workspace. Export again.",
    );
  });

  it("leaves no workspace file where the workspace itself cannot be written", async () => {
    const parent = failing((path, step) => path === "export/export.wsp" && step === "write");
    await expect(writeFlowJoFolder(asDirectory(parent), "export", plan(), "<Workspace/>")).rejects.toThrow(
      "Stopped at export.wsp: The disk is full. The folder export in Desktop is incomplete: it holds all 3 FCS files and no workspace. Export again.",
    );
    // The browser had made the file empty before the write failed; it is taken away again.
    expect([...parent.files().keys()]).toEqual(["export/D1.fcs", "export/2/D1.fcs", "export/D2 & #1.fcs"]);
  });

  it("says so where the empty workspace file cannot be taken away again", async () => {
    const parent = failing((path, step) => path === "export/export.wsp" && step === "write");
    const made = parent.getDirectoryHandle.bind(parent);
    parent.getDirectoryHandle = async (name, options) => {
      const dir = await made(name, options);
      dir.removeEntry = async () => { throw new DOMException("Not allowed.", "NotAllowedError"); };
      return dir;
    };
    await expect(writeFlowJoFolder(asDirectory(parent), "export", plan(), "<Workspace/>")).rejects.toThrow(
      "it holds all 3 FCS files and an empty export.wsp, which is not a workspace. Export again.",
    );
  });

  it("says nothing was written where the folder itself cannot be made", async () => {
    const parent = failing((path, step) => path === "export" && step === "directory");
    await expect(writeFlowJoFolder(asDirectory(parent), "export", plan(), "<Workspace/>")).rejects.toThrow(
      "Could not make the folder export in Desktop: The disk is full. Nothing was written.",
    );
    expect(parent.entries.size).toBe(0);
  });
});

describe("the .zip", () => {
  it("holds the folder, stored, every file byte for byte", async () => {
    const plan = planFlowJoFolder([
      { name: "D1.fcs", bytes: Uint8Array.from({ length: 40 }, (_, i) => i * 3) },
      { name: "D1.fcs", bytes: bytes(5, 6) },
      { name: "hosted", bytes: null },
    ], "D1_and_2_more.wsp");
    const chunks: Uint8Array[] = [];
    await writeFlowJoZip("D1_and_2_more", plan, "<Workspace/>", (chunk) => { chunks.push(chunk); });
    const zip = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) { zip.set(c, offset); offset += c.byteLength; }
    const entries = unzipSync(zip);
    expect(Object.keys(entries)).toEqual(["D1_and_2_more/D1_and_2_more.wsp", "D1_and_2_more/D1.fcs", "D1_and_2_more/2/D1.fcs"]);
    expect(entries["D1_and_2_more/D1.fcs"]).toEqual(plan.files[0].bytes);
    expect(entries["D1_and_2_more/2/D1.fcs"]).toEqual(plan.files[1].bytes);
    // Every local header says "stored" (compression method 0).
    const view = new DataView(zip.buffer);
    for (let i = 0; i + 4 <= zip.byteLength; i++) {
      if (view.getUint32(i, true) === 0x04034b50) expect(view.getUint16(i + 8, true)).toBe(0);
    }
    // The size stated before writing counts the workspace given it.
    expect(previewFlowJoFolder(plan, "D1_and_2_more", "<Workspace/>".length).zipBytes).toBe(zip.byteLength);
  });

  it("is handed over as views of the bytes GateLab holds, the only new bytes its headers and the workspace", async () => {
    const fcs = [Uint8Array.from({ length: 5000 }, (_, i) => i % 251), new Uint8Array(3000).fill(9)];
    const plan = planFlowJoFolder([{ name: "D1.fcs", bytes: fcs[0] }, { name: "D2.fcs", bytes: fcs[1] }], "export.wsp");
    const chunks: Uint8Array[] = [];
    await writeFlowJoZip("export", plan, "<Workspace/>", (chunk) => { chunks.push(chunk); });
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const copied = chunks.filter((c) => !fcs.some((f) => c.buffer === f.buffer)).reduce((n, c) => n + c.byteLength, 0);
    // A Blob made of these holds the archive once; the FCS bytes are not copied into the parts.
    expect(copied).toBe(total - 8000);
    expect(copied).toBe(storedZipBytes([{ path: "export/export.wsp", byteLength: 12 }, { path: "export/D1.fcs", byteLength: 0 }, { path: "export/D2.fcs", byteLength: 0 }]));
    const whole = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    const entries = unzipSync(whole);
    expect(entries["export/D1.fcs"]).toEqual(fcs[0]);
    expect(entries["export/D2.fcs"]).toEqual(fcs[1]);
  });

  it("is refused in the dialog where the workspace takes it past 4 GB", () => {
    const fcsBytes = ZIP_MAX_BYTES - 1000;
    const plan = planFlowJoFolder([{ name: "D1.fcs", bytes: { byteLength: fcsBytes } as Uint8Array }], "export.wsp");
    expect(fitsInZip(previewFlowJoFolder(plan, "export", 0))).toBe(true);
    expect(fitsInZip(previewFlowJoFolder(plan, "export", 5000))).toBe(false);
  });

  it("is refused before a byte is written where it would pass 4 GB", async () => {
    const large = { byteLength: 3_000_000_000 } as Uint8Array;
    const plan = planFlowJoFolder([{ name: "D1.fcs", bytes: large }, { name: "D2.fcs", bytes: large }], "export.wsp");
    let written = 0;
    await expect(writeFlowJoZip("export", plan, "<Workspace/>", () => { written++; })).rejects.toThrow(/more than one \.zip can hold/);
    expect(written).toBe(0);
  });
});
