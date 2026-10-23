// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { main, parseArgs } from "./cli";
import { parseFcs } from "../engine/fcs";
import { fixtureFcs, fixtureGatingMl, fixtureExpected } from "./__fixtures__/syntheticCytobank";

let dir = "";
const quiet = { log: () => {}, warn: () => {} };

function readCsv(path: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gatelab-headless-test-"));
  writeFileSync(join(dir, "D1.fcs"), fixtureFcs("D1.fcs"));
  writeFileSync(join(dir, "D2.fcs"), fixtureFcs("D2.fcs"));
  writeFileSync(join(dir, "tree.xml"), fixtureGatingMl({ tailorFor: "D2.fcs" }));
  writeFileSync(join(dir, "or.xml"), fixtureGatingMl().replace(
    /(<gating:BooleanGate gating:id="GateSet_9">[\s\S]*?)<gating:and>([\s\S]*?)<\/gating:and>/, "$1<gating:or>$2</gating:or>"));
});

describe("gatelab-headless CLI", () => {
  it("counts every population of every file, each under its own tailoring", async () => {
    const out = join(dir, "run1");
    const status = await main(["--gating", join(dir, "tree.xml"), "--out", out, join(dir, "D1.fcs"), join(dir, "D2.fcs")], quiet);
    expect(status).toBe(0);
    const exp = fixtureExpected();
    const rows = readCsv(join(out, "counts.csv"));
    const get = (file: string, path: string) => rows.find((r) => r.file === file && r.path === path);
    expect(get("D1.fcs", "Time")?.events).toBe(String(exp.time));
    expect(get("D1.fcs", "Time > Cells")?.events).toBe(String(exp.cells));
    expect(get("D1.fcs", "Time > Cells > B1")?.events).toBe(String(exp.B1));
    expect(get("D1.fcs", "Time > Cells > B1")?.parent_events).toBe(String(exp.cells));
    expect(get("D1.fcs", "Time > Cells > B2")?.events).toBe(String(exp.B2));
    expect(get("D2.fcs", "Time > Cells")?.events).toBe("0");
    const json = JSON.parse(readFileSync(join(out, "counts.json"), "utf8"));
    expect(json.find((r: { file: string; path: string[] }) => r.file === "D1.fcs" && r.path.join("/") === "Time/Cells/B1").events).toBe(exp.B1);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.status).toBe("done");
    expect(report.inputs.fcs).toHaveLength(2);
    expect(report.files[1].notes.join(" ")).toMatch(/tailored/);
  });

  it("stops before counting when the import leaves a population out, and says which", async () => {
    const out = join(dir, "run2");
    const warnings: string[] = [];
    const status = await main(["--gating", join(dir, "or.xml"), "--out", out, join(dir, "D1.fcs")], { log: () => {}, warn: (l) => warnings.push(l) });
    expect(status).toBe(2);
    expect(existsSync(join(out, "counts.csv"))).toBe(false);
    expect(warnings.join("\n")).toMatch(/LEFT OUT.*B2/);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.status).toBe("refused");
    expect(report.files[0].refusals[0].message).toMatch(/B2/);
  });

  it("counts what was imported with --allow-partial, still naming what was left out", async () => {
    const out = join(dir, "run3");
    const status = await main(["--gating", join(dir, "or.xml"), "--out", out, "--allow-partial", join(dir, "D1.fcs")], quiet);
    expect(status).toBe(0);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.status).toBe("partial");
    expect(report.files[0].refusals.length).toBeGreaterThan(0);
    expect(readCsv(join(out, "counts.csv")).some((r) => r.population === "B2")).toBe(false);
  });

  it("fails on a channel the file lacks, and on a selector that names nothing", async () => {
    writeFileSync(join(dir, "lacks.xml"), fixtureGatingMl().replace(/Pd108Di/g, "Pd110Di"));
    expect(await main(["--gating", join(dir, "lacks.xml"), "--out", join(dir, "run4"), join(dir, "D1.fcs")], quiet)).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "run4", "report.json"), "utf8")).error).toMatch(/Pd110Di/);
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", join(dir, "run5"), "--export-fcs", "B3", join(dir, "D1.fcs")], quiet)).toBe(1);
    expect(existsSync(join(dir, "run5", "counts.csv"))).toBe(false);
  });

  it("refuses an output directory that already holds files", async () => {
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", join(dir, "run1"), join(dir, "D1.fcs")], quiet)).toBe(1);
  });

  it("writes membership, population FCS files and a strategy figure", async () => {
    const out = join(dir, "run6");
    const status = await main([
      "--gating", join(dir, "tree.xml"), "--out", out, "--membership", "csv",
      "--export-fcs", "Time > Cells > B1", "--strategy", "B1", "--figure-format", "both", join(dir, "D1.fcs"),
    ], quiet);
    expect(status).toBe(0);
    const exp = fixtureExpected();
    const membership = readFileSync(join(out, "membership", "D1.csv"), "utf8").trim().split("\n");
    expect(membership).toHaveLength(exp.total + 1);
    expect(membership[0]).toBe("event,Time,Time > Cells,Time > Cells > B1,Time > Cells > B2");
    const b1Column = membership.slice(1).map((l) => l.split(",")[3]);
    expect(b1Column.filter((v) => v === "1")).toHaveLength(exp.B1);
    const fcs = readFileSync(join(out, "fcs", "D1", "Time__Cells__B1.fcs"));
    expect(parseFcs(fcs.buffer.slice(fcs.byteOffset, fcs.byteOffset + fcs.byteLength) as ArrayBuffer).nEvents).toBe(exp.B1);
    const svg = readFileSync(join(out, "strategy", "D1", "Time__Cells__B1.svg"), "utf8");
    expect(svg).toMatch(/^<\?xml/);
    for (const gate of ["Time", "DNA", "104+106+", "108-"]) expect(svg).toContain(`>${gate}</text>`);
    expect(svg).toContain(`${exp.B1.toLocaleString("en-US")} of`);
    expect(readFileSync(join(out, "strategy", "D1", "Time__Cells__B1.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("writes packed membership bits", async () => {
    const out = join(dir, "run7");
    expect(await main(["--gating", join(dir, "tree.xml"), "--out", out, "--membership", "bits", join(dir, "D1.fcs")], quiet)).toBe(0);
    const m = JSON.parse(readFileSync(join(out, "membership.json"), "utf8"));
    const b1 = m.files[0].populations.find((p: { path: string }) => p.path === "Time > Cells > B1");
    const bytes = Uint8Array.from(atob(b1.membershipBitsBase64), (c) => c.charCodeAt(0));
    let n = 0;
    for (const byte of bytes) for (let k = 0; k < 8; k++) n += (byte >> k) & 1;
    expect(n).toBe(fixtureExpected().B1);
  });

  it("parses its options strictly", () => {
    expect(parseArgs(["--help"])).toBe("help");
    expect(() => parseArgs(["--out", "x"])).toThrow(/--gating/);
    expect(() => parseArgs(["--gating", "t", "--out", "x", "--matrix", "both"])).toThrow(/--matrix/);
    expect(() => parseArgs(["--gating", "t", "--out", "x", "--frobnicate"])).toThrow(/Unknown option/);
  });
});

describe("the npm launcher", () => {
  it("bundles the runner against this checkout and runs it in plain Node", () => {
    const root = resolve(__dirname, "../..");
    const out = join(dir, "launcher");
    const stdout = execFileSync(process.execPath, [join(root, "tools/headless/gatelab-headless.mjs"),
      "--gating", join(dir, "tree.xml"), "--out", out, join(dir, "D1.fcs")], { encoding: "utf8" });
    expect(stdout).toMatch(/D1\.fcs: 420 events, 4 populations/);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    expect(report.gatelab.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.gatelab.revision).toMatch(/^[0-9a-f]{40}/);
    expect(readdirSync(out).sort()).toEqual(["counts.csv", "counts.json", "report.json"]);
  }, 60000);
});
