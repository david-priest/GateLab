// @vitest-environment jsdom
// --save-workspace: the files and the tree written as a workspace the app opens, laid out as the
// app's per-file import lays it out, and counting what the import counted.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { main, parseArgs } from "./cli";
import { openFcs, importGatingOnto } from "./headless";
import { oneTreeState } from "./saveWorkspace";
import { fixtureFcs, fixtureGatingMl, fixtureExpected } from "./__fixtures__/syntheticCytobank";

let dir = "";
const quiet = { log: () => {}, warn: () => {} };

function readCsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}
const counts = (out: string) => readCsv(join(out, "counts.csv")).map((r) => `${r.file}|${r.path}|${r.events}`).sort();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gatelab-headless-save-"));
  writeFileSync(join(dir, "D1.fcs"), fixtureFcs("D1.fcs"));
  writeFileSync(join(dir, "D2.fcs"), fixtureFcs("D2.fcs"));
  writeFileSync(join(dir, "tree.xml"), fixtureGatingMl({ tailorFor: "D2.fcs" }));
});

describe("--save-workspace", () => {
  it("writes one tree, a tailored copy for the file whose gates differ from it, and counts as the import did", async () => {
    const ws = join(dir, "linked.gatelab");
    const out = join(dir, "save1");
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", out, "--save-workspace", ws, "--tree-name", "Panel", join(dir, "D1.fcs"), join(dir, "D2.fcs")], quiet)).toBe(0);
    const saved = JSON.parse(readFileSync(ws, "utf8"));
    expect(saved.format).toBe("gatelab-workspace");
    expect(saved.samples.map((s: { fileName: string }) => s.fileName)).toEqual(["D1.fcs", "D2.fcs"]);
    const [d1, d2] = saved.samples;
    const { hierarchies, active_hierarchy_id } = saved.gating;
    expect(hierarchies.find((h: { id: string }) => h.id === active_hierarchy_id).name).toBe("Panel");
    // The file opened last is the one in view, and its strategy leads the tree, as in the app.
    expect(d2.hierarchyId).toBe(active_hierarchy_id);
    const copy = hierarchies.find((h: { id: string }) => h.id === d1.hierarchyId);
    expect(copy).toMatchObject({ name: "D1.fcs · Panel", owner_sample_id: d1.sampleId, structure_locked: true, source_hierarchy_id: active_hierarchy_id });
    expect(saved.gating.stored_hierarchies.map((h: { id: string }) => h.id)).toEqual([copy.id]);
    expect(saved.activeSample).toBe(1);
    expect(saved.display).toMatchObject({ mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 });
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.workspace).toMatchObject({ path: ws, kind: "linked", tree: "Panel", lead: "D2.fcs", tailored: ["D1.fcs"] });

    // Read back, it gates each file as the import did: D1 under its own coordinates.
    const back = join(dir, "save1-back");
    expect(await main(["--gating", ws, "--out", back, join(dir, "D1.fcs"), join(dir, "D2.fcs")], quiet)).toBe(0);
    expect(counts(back)).toEqual(counts(out));
    expect(readCsv(join(back, "counts.csv")).find((r) => r.file === "D1.fcs" && r.path === "Time > Cells > B1")?.events).toBe(String(fixtureExpected().B1));
  });

  it("renames populations in the tree and its copies, and a portable workspace carries its files", async () => {
    const ws = join(dir, "portable.gatelab");
    const out = join(dir, "save2");
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", out, "--save-workspace", ws, "--portable", "--rename", "Time > Cells > B1=Bcells", "--rename", "B2=Other",
      join(dir, "D1.fcs"), join(dir, "D2.fcs")], quiet)).toBe(0);
    const zip = unzipSync(new Uint8Array(readFileSync(ws)));
    expect(Object.keys(zip).sort()).toEqual(["data/0_D1.fcs", "data/1_D2.fcs", "gates.gatingml.xml", "workspace.json"]);
    expect(zip["data/0_D1.fcs"]).toEqual(new Uint8Array(readFileSync(join(dir, "D1.fcs"))));
    const saved = JSON.parse(strFromU8(zip["workspace.json"]));
    const names = (pops: Record<string, { name: string }>) => Object.values(pops).map((p) => p.name).sort();
    expect(names(saved.gating.populations)).toEqual(["All Events", "Bcells", "Cells", "Other", "Time"].sort());
    expect(names(saved.gating.stored_hierarchies[0].populations)).toEqual(names(saved.gating.populations));
    // The import's own names stay in counts.csv; the saved tree, read back, has the new ones.
    expect(readCsv(join(out, "counts.csv")).some((r) => r.path === "Time > Cells > B1")).toBe(true);
    const back = join(dir, "save2-back");
    expect(await main(["--gating", ws, "--out", back], quiet)).toBe(0);
    expect(counts(back)).toEqual(counts(out).map((r) => r.replace("Cells > B1|", "Cells > Bcells|").replace("Cells > B2|", "Cells > Other|")).sort());
  });

  it("names the tree after the FlowJo group every file shares, else as the app does", () => {
    const files = ["D1.fcs", "D2.fcs"].map((n) => importGatingOnto(openFcs(fixtureFcs(n), n), n, fixtureGatingMl({ tailorFor: "D2.fcs" }), "tree.xml"));
    expect(oneTreeState(files, { renames: [] }).tree).toBe("Imported strategy");
    expect(oneTreeState(files.map((g) => ({ ...g, origin: "Panel A" })), { renames: [] }).tree).toBe("Panel A");
  });

  it("refuses what it cannot write as asked", async () => {
    expect(() => parseArgs(["--gating", "t.xml", "--out", "o", "--portable", "--rename", "A=B"])).toThrow(/--portable, --rename apply only with --save-workspace/);
    expect(() => parseArgs(["--gating", "t.xml", "--out", "o", "--save-workspace", "w.gatelab", "--rename", "AB"])).toThrow(/OLD=NEW/);
    const warnings: string[] = [];
    const warn = { log: () => {}, warn: (l: string) => warnings.push(l) };
    // An existing file is not replaced.
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", join(dir, "save3"), "--save-workspace", join(dir, "D1.fcs"), join(dir, "D1.fcs")], warn)).toBe(1);
    expect(warnings.join("\n")).toMatch(/exists already/);
    // A GateLab workspace is one already.
    expect(await main(["--gating", join(dir, "linked.gatelab"), "--out", join(dir, "save4"), "--save-workspace", join(dir, "again.gatelab"), join(dir, "D1.fcs"), join(dir, "D2.fcs")], warn)).toBe(1);
    expect(warnings.join("\n")).toMatch(/GateLab workspace already/);
    expect(existsSync(join(dir, "again.gatelab"))).toBe(false);
    // A selector naming no population stops the save.
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", join(dir, "save5"), "--save-workspace", join(dir, "typo.gatelab"), "--rename", "B9=X", join(dir, "D1.fcs")], warn)).toBe(1);
    expect(warnings.join("\n")).toMatch(/No population "B9"/);
    expect(existsSync(join(dir, "typo.gatelab"))).toBe(false);
  });
});
