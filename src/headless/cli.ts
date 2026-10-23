// cli.ts — `npm run headless`: gate FCS files with GateLab's engine, without the app open.
//
// Run through tools/headless/gatelab-headless.mjs, which supplies the DOM parser the Gating-ML
// reader needs and bundles this file against the checkout's own engine. See docs/headless.md.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  openFcs,
  importGatingOnto,
  memberships,
  populationCounts,
  treePopulations,
  findPopulation,
  populationFcs,
  packMembership,
  fileIdentity,
  HeadlessError,
  type GatedFile,
  type ImportOptions,
  type OpenOptions,
  type PopulationCount,
} from "./headless";
import { openWorkspace } from "./workspace";
import { flowJo11WorkbenchToWorkspace, isFlowJo11WorkbenchBytes, readFlowJo11Workbench } from "../engine/flowjo11Workbench";
import { strategyFigure, figureSvg, figurePdf } from "./strategyFigure";
import type { FcsExportAssay } from "../engine/fcsExport";

export const USAGE = `Usage: npm run headless -- --gating <tree> --out <new directory> [options] [FCS files...]

Gates each FCS file with GateLab's engine, as the app imports the tree onto that file opened
alone, and writes every population's count. The tree is detected from its content:
  a Gating-ML 2.0 file (standard, or Cytobank's export with its custom_info), or
  a FlowJo workspace (.wsp) or FlowJo 11 workbench (.flowjo), each imported onto every FCS
  file given; or
  a GateLab workspace (.gatelab): a portable one carries its FCS files and takes none,
  a linked one takes the FCS files it declares, matched by name and recorded acquisition.

Options:
  --out DIR               where the outputs go; must not exist yet, or be empty
  --instrument MODE       auto (default, as the app detects it), flow or cytof
  --cytof-cofactor N      CyTOF arcsinh cofactor, where it is not 5
  --data-set N            for an FCS file holding several data sets: which (0-based)
  --matrix CHOICE         workspace (default) or file: the matrix a FlowJo workspace or a
                          Gating-ML file brings, or the FCS file's own, where they differ
  --wsp-sample S          the FlowJo workspace sample to import, by 1-based position or name,
                          in place of pairing each FCS file with its own sample
  --wsp-tree T            the sample's tree, by position or name, when it holds several
  --allow-partial         go on when the import left a population or gate out; each is
                          still named on stderr and in report.json. Without it the run stops.
  --membership FORMAT     per-event membership: csv (one 0/1 column per population) or
                          bits (report-style JSON, LSB-first base64 per population)
  --export-fcs SELECTOR   write the population's events as FCS (repeatable; "all" for every one)
  --fcs-assay ASSAY       original (default), compensated or display values in exported FCS
  --strategy SELECTOR     draw the gates from the root to the population (repeatable)
  --figure-format F       svg (default), pdf or both
  --help                  this text

A SELECTOR is a population's path ("Cells > B1") or a name only one population carries.

Outputs: counts.csv, counts.json, report.json; membership/, fcs/ and strategy/ when asked.
Exit status: 0 done; 1 an error, which report.json records; 2 the import left something out
and --allow-partial was not given, in which case nothing is counted and report.json names it.`;

export interface CliOptions {
  gating: string;
  out: string;
  fcs: string[];
  open: OpenOptions;
  import: ImportOptions;
  allowPartial: boolean;
  membership: "csv" | "bits" | null;
  exportFcs: string[];
  fcsAssay: FcsExportAssay;
  strategy: string[];
  figureFormat: "svg" | "pdf" | "both";
}

export function parseArgs(argv: readonly string[]): CliOptions | "help" {
  const o: CliOptions = {
    gating: "", out: "", fcs: [], open: {}, import: {}, allowPartial: false, membership: null,
    exportFcs: [], fcsAssay: "original", strategy: [], figureFormat: "svg",
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new HeadlessError(`${flag} needs a value.`);
    return v;
  };
  const oneOf = <T extends string>(v: string, flag: string, allowed: readonly T[]): T => {
    if (!(allowed as readonly string[]).includes(v)) throw new HeadlessError(`${flag} must be one of ${allowed.join(", ")}; got "${v}".`);
    return v as T;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help": case "-h": return "help";
      case "--gating": o.gating = value(i, a); i++; break;
      case "--out": o.out = value(i, a); i++; break;
      case "--instrument": o.open.instrument = oneOf(value(i, a), a, ["auto", "flow", "cytof"] as const); i++; break;
      case "--cytof-cofactor": o.open.cytofCofactor = Number(value(i, a)); i++; break;
      case "--data-set": {
        const v = Number(value(i, a)); i++;
        if (!Number.isInteger(v) || v < 0) throw new HeadlessError("--data-set must be a whole number from 0.");
        o.open.dataSet = v;
        break;
      }
      case "--matrix": o.import.matrixChoice = oneOf(value(i, a), a, ["workspace", "file"] as const); i++; break;
      case "--wsp-sample": o.import.wspSample = value(i, a); i++; break;
      case "--wsp-tree": o.import.wspTree = value(i, a); i++; break;
      case "--allow-partial": o.allowPartial = true; break;
      case "--membership": o.membership = oneOf(value(i, a), a, ["csv", "bits"] as const); i++; break;
      case "--export-fcs": o.exportFcs.push(value(i, a)); i++; break;
      case "--fcs-assay": o.fcsAssay = oneOf(value(i, a), a, ["original", "compensated", "display"] as const); i++; break;
      case "--strategy": o.strategy.push(value(i, a)); i++; break;
      case "--figure-format": o.figureFormat = oneOf(value(i, a), a, ["svg", "pdf", "both"] as const); i++; break;
      default:
        if (a.startsWith("-")) throw new HeadlessError(`Unknown option ${a}.`);
        o.fcs.push(a);
    }
  }
  if (!o.gating) throw new HeadlessError("--gating is required: a Gating-ML file, a FlowJo workspace or a .gatelab workspace.");
  if (!o.out) throw new HeadlessError("--out is required.");
  return o;
}

/** What the tree file is, from its content. */
function treeKind(bytes: Uint8Array): "workspace" | "text" {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "workspace";
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
  if (head.startsWith("{") && /"format"\s*:\s*"gatelab-workspace"/.test(new TextDecoder().decode(bytes))) return "workspace";
  return "text";
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A file-system-safe name, kept readable. */
function slug(s: string): string {
  const out = s.normalize("NFC").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/\s+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return out || "_";
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pct(a: number, b: number): number | null {
  return b > 0 ? (100 * a) / b : null;
}

function countsCsv(rows: readonly PopulationCount[], withFlowJo: boolean): string {
  const head = ["file", "hierarchy", "population_id", "population", "path", "depth", "parent_id", "events", "parent_events", "total_events", "pct_parent", "pct_total", ...(withFlowJo ? ["flowjo_events"] : [])];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      r.file, r.hierarchy ?? "", r.populationId, r.population, r.path.join(" > "), r.path.length, r.parentId ?? "",
      r.events, r.parentEvents, r.totalEvents, pct(r.events, r.parentEvents), pct(r.events, r.totalEvents),
      ...(withFlowJo ? [r.flowJoEvents ?? ""] : []),
    ].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Header names for one file's populations: their paths, told apart by id where two coincide. */
function columnNames(g: GatedFile): { id: string; name: string }[] {
  const pops = treePopulations(g.tree);
  const seen = new Map<string, number>();
  for (const p of pops) seen.set(p.path.join(" > "), (seen.get(p.path.join(" > ")) ?? 0) + 1);
  return pops.map((p) => {
    const path = p.path.join(" > ");
    return { id: p.id, name: (seen.get(path) ?? 0) > 1 ? `${path} [${p.id}]` : path };
  });
}

function writeMembershipCsv(path: string, g: GatedFile, masks: Record<string, Uint8Array>): void {
  const cols = columnNames(g);
  const fd = openSync(path, "w");
  try {
    writeSync(fd, ["event", ...cols.map((c) => c.name)].map(csvCell).join(",") + "\n");
    const n = g.sample.fcs.nEvents;
    const columns = cols.map((c) => masks[c.id]);
    let chunk: string[] = [];
    for (let i = 0; i < n; i++) {
      let line = String(i + 1);
      for (const m of columns) line += m && m[i] ? ",1" : ",0";
      chunk.push(line);
      if (chunk.length === 20000) {
        writeSync(fd, chunk.join("\n") + "\n");
        chunk = [];
      }
    }
    if (chunk.length) writeSync(fd, chunk.join("\n") + "\n");
  } finally {
    closeSync(fd);
  }
}

export interface RunInfo {
  /** The GateLab version and source revision the run used, for the report. */
  version?: string;
  revision?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Run the CLI. Returns the exit status; writes report.json whatever happens after --out is made. */
export async function main(argv: readonly string[], info: RunInfo = {}): Promise<number> {
  const log = info.log ?? ((l: string) => console.log(l));
  const warn = info.warn ?? ((l: string) => console.error(l));
  let o: CliOptions | "help";
  try {
    o = parseArgs(argv);
  } catch (e) {
    warn(`gatelab-headless: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 1;
  }
  if (o === "help") {
    log(USAGE);
    return 0;
  }
  const out = resolve(o.out);
  if (existsSync(out) && readdirSync(out).length) {
    warn(`gatelab-headless: ${out} is not empty; give a new or empty directory, so no output from an earlier run is mistaken for this one's.`);
    return 1;
  }
  mkdirSync(out, { recursive: true });

  const report: Record<string, unknown> = {
    format: "gatelab-headless-report",
    version: 1,
    gatelab: { version: info.version ?? null, revision: info.revision ?? null },
    startedAt: new Date().toISOString(),
    arguments: [...argv],
    status: "running",
  };
  const writeReport = () => writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1) + "\n");

  const opts = o;
  try {
    const treeBytes = new Uint8Array(readFileSync(opts.gating));
    const fcsInputs: { path: string; sha256: string }[] = [];
    report.inputs = { gating: { path: opts.gating, sha256: sha256(treeBytes) }, fcs: fcsInputs };

    // The files, gated. A workspace's are opened together, as the app opens them. A tree imported
    // onto FCS files is put on one file at a time, and the files are gone through twice (every
    // file checked, then counted), so that only one file's events are held at once.
    let gatedFiles: () => Iterable<GatedFile>;
    const flowJo11 = isFlowJo11WorkbenchBytes(treeBytes);
    if (!flowJo11 && treeKind(treeBytes) === "workspace") {
      const inputs = opts.fcs.map((p) => {
        const bytes = new Uint8Array(readFileSync(p));
        fcsInputs.push({ path: p, sha256: sha256(bytes) });
        return { name: basename(p), path: p, bytes };
      });
      const files = await openWorkspace(treeBytes, opts.gating, inputs, opts.open);
      gatedFiles = () => files;
    } else {
      if (!opts.fcs.length) throw new HeadlessError("No FCS files were given to put the tree on.");
      // A FlowJo 11 workbench is read as the FlowJo workspace it is rewritten into (flowjo11Workbench.ts).
      const text = flowJo11 ? flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(treeBytes)) : new TextDecoder().decode(treeBytes);
      gatedFiles = function* () {
        for (const p of opts.fcs) {
          const bytes = new Uint8Array(readFileSync(p));
          if (fcsInputs.length < opts.fcs.length) fcsInputs.push({ path: p, sha256: sha256(bytes) });
          yield importGatingOnto(openFcs(bytes, basename(p), opts.open), basename(p), text, opts.gating, opts.import);
        }
      };
    }

    // Population ids are made when a tree is imported, so a selector is resolved in each file, in
    // the first pass to stop on a typo before anything is written, and again when it is used.
    const resolveAll = (selectors: readonly string[], g: GatedFile): string[] =>
      selectors.includes("all") ? treePopulations(g.tree).map((p) => p.id) : selectors.map((s) => findPopulation(g.tree, s));

    const fileReports: unknown[] = [];
    let refused = 0;
    let withFlowJo = false;
    for (const g of gatedFiles()) {
      fileReports.push({
        file: g.file,
        hierarchy: g.hierarchy,
        source: g.source,
        events: g.sample.fcs.nEvents,
        instrument: g.sample.instrument,
        compensation: g.compensation,
        identity: fileIdentity(g.sample),
        notes: g.notes,
        refusals: g.refusals,
      });
      report.files = fileReports;
      for (const note of g.notes) log(`${g.file}: ${note}`);
      for (const r of g.refusals) warn(`${g.file}: LEFT OUT (${r.kind}): ${r.message}`);
      if (g.refusals.length) refused++;
      if (g.flowJoCounts) withFlowJo = true;
      resolveAll(opts.exportFcs, g);
      resolveAll(opts.strategy, g);
    }
    if (refused && !opts.allowPartial) {
      report.status = "refused";
      warn(`gatelab-headless: the import left something out of ${refused} file(s), named above. ` +
        "Nothing was counted. Fix the tree, or pass --allow-partial to count what was imported.");
      return 2;
    }

    const stems = new Map<string, number>();
    const stemOf = (name: string) => {
      const base = slug(name.replace(/\.fcs$/i, ""));
      const k = (stems.get(base) ?? 0) + 1;
      stems.set(base, k);
      return k === 1 ? base : `${base}-${k}`;
    };

    const rows: PopulationCount[] = [];
    const bits: unknown[] = [];
    const written: string[] = [];
    for (const g of gatedFiles()) {
      const stem = stemOf(g.file);
      const pathOf = new Map(treePopulations(g.tree).map((p) => [p.id, p.path]));
      const masks = memberships(g);
      const counts = populationCounts(g, masks);
      rows.push(...counts);
      log(`${g.file}: ${g.sample.fcs.nEvents.toLocaleString("en-US")} events, ${counts.length} populations` +
        `${g.hierarchy ? ` under "${g.hierarchy}"` : ""} (${g.source.detail})`);
      if (opts.membership === "csv") {
        mkdirSync(join(out, "membership"), { recursive: true });
        const p = join(out, "membership", `${stem}.csv`);
        writeMembershipCsv(p, g, masks);
        written.push(p);
      } else if (opts.membership === "bits") {
        bits.push({
          file: g.file,
          eventCount: g.sample.fcs.nEvents,
          populations: columnNames(g).map((c) => ({ populationId: c.id, path: c.name, membershipBitsBase64: packMembership(masks[c.id] ?? new Uint8Array(g.sample.fcs.nEvents)) })),
        });
      }
      for (const id of resolveAll(opts.exportFcs, g)) {
        const dir = join(out, "fcs", stem);
        mkdirSync(dir, { recursive: true });
        const p = join(dir, `${slug(pathOf.get(id)!.join("__"))}.fcs`);
        writeFileSync(p, populationFcs(g, masks[id], opts.fcsAssay));
        written.push(p);
      }
      for (const id of resolveAll(opts.strategy, g)) {
        const fig = strategyFigure(g, id);
        if (!fig) {
          warn(`${g.file}: "${g.tree.populations[id]?.name}" has no gate on its path; no figure drawn.`);
          continue;
        }
        const dir = join(out, "strategy", stem);
        mkdirSync(dir, { recursive: true });
        const base = join(dir, slug(pathOf.get(id)!.join("__")));
        if (opts.figureFormat !== "pdf") { writeFileSync(`${base}.svg`, figureSvg(fig)); written.push(`${base}.svg`); }
        if (opts.figureFormat !== "svg") { writeFileSync(`${base}.pdf`, figurePdf(fig)); written.push(`${base}.pdf`); }
      }
    }
    writeFileSync(join(out, "counts.csv"), countsCsv(rows, withFlowJo));
    writeFileSync(join(out, "counts.json"), JSON.stringify(rows.map((r) => ({
      ...r, pctParent: pct(r.events, r.parentEvents), pctTotal: pct(r.events, r.totalEvents),
    })), null, 1) + "\n");
    if (opts.membership === "bits") {
      writeFileSync(join(out, "membership.json"), JSON.stringify({ format: "gatelab-headless-membership", version: 1, bitOrder: "lsb-first", eventOrder: "as-stored", files: bits }) + "\n");
      written.push(join(out, "membership.json"));
    }
    report.outputs = ["counts.csv", "counts.json", ...written.map((p) => p.slice(out.length + 1))];
    report.status = refused ? "partial" : "done";
    if (refused) warn(`gatelab-headless: counted with --allow-partial; ${refused} file(s) are missing what is named above.`);
    log(`Wrote ${join(out, "counts.csv")}`);
    return 0;
  } catch (e) {
    report.status = "error";
    report.error = e instanceof Error ? e.message : String(e);
    warn(`gatelab-headless: ${report.error}`);
    if (!(e instanceof HeadlessError) && e instanceof Error && e.stack) warn(e.stack);
    return 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport();
  }
}
