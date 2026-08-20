// @vitest-environment jsdom
//
// vendorImportMatrix.test.ts — FCS import across instruments, vendors and FCS versions.
//
// GateLab's import was originally exercised only on BD spectral files, which is the
// obvious objection to a cytometry paper. This locks in what the parser actually does
// on one file from each of thirteen instruments spanning FCS 2.0 to 3.2, so a
// regression in channel naming, instrument detection, transform assignment or
// $SPILLOVER parsing fails here rather than in someone else's data.
//
// The corpus is third-party and licensed (see the testing library README), so it is not
// committed. Set GATELAB_FIXTURES to relocate it. Run with GATELAB_EMIT_MATRIX=1 to
// print the matrix as a markdown table for the manuscript.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { FIXTURES_ROOT } from "../testFixtures";

const PUBLIC_DIR = join(FIXTURES_ROOT, "PUBLIC - Screenshot Safe");
const VENDOR_DIR = join(PUBLIC_DIR, "Vendor FCS import matrix", "source-fcs");
const CYTOF_DIR = join(PUBLIC_DIR, "Bodenmiller BCR-XL CyTOF benchmark", "source-fcs");

interface VendorCase {
  /** Instrument as reported by $CYT, or the deposit's own description where absent. */
  instrument: string;
  vendor: string;
  path: string;
  version: string;
  /** What detectInstrumentType() must conclude. */
  mode: "flow" | "cytof";
  events: number;
  channels: number;
  /** $CYT verbatim; null where the file carries none. */
  cyt: string | null;
  /** Channels in the embedded $SPILLOVER, 0 when there is none. */
  spilloverChannels: number;
  /** Channels routed to arcsinh (flow scatter, or every CyTOF channel). */
  asinh: number;
  /** Channels routed to logicle (flow fluorescence). */
  logicle: number;
  note?: string;
}

const MATRIX: VendorCase[] = [
  {
    instrument: "FACSDiscover S8", vendor: "BD",
    path: join(VENDOR_DIR, "bd_facsdiscover_s8__19221995__Zam36_YFP.fcs"),
    version: "FCS3.2", mode: "flow", events: 10000, channels: 440,
    cyt: "FACSDiscover S8", spilloverChannels: 78, asinh: 20, logicle: 419,
    note: "The format stress case: FCS 3.2, 440 parameters, a 78-channel spillover.",
  },
  {
    instrument: "ID7000", vendor: "Sony",
    path: join(VENDOR_DIR, "sony_id7000__7867212__G01_E12.5_WLSM.fcs"),
    version: "FCS3.1", mode: "flow", events: 50000, channels: 23,
    cyt: "ID7000", spilloverChannels: 0, asinh: 6, logicle: 16,
    note: "Names scatter 'FSC - Area', not 'FSC-A'. The six asinh channels are the "
      + "proof that spaced naming is still classified as scatter. Its $PnS for the "
      + "clock is 'Time Stamp', which is not a QC name — only its $PnN ('TIME') is, "
      + "so classifying on $PnN is what keeps a logicle off the timestamp.",
  },
  {
    instrument: "Aurora", vendor: "Cytek",
    path: join(VENDOR_DIR, "cytek_aurora__15723074__TEMRA_CD4+_T_cells_donor6.fcs"),
    version: "FCS3.1", mode: "flow", events: 518, channels: 33,
    cyt: "Aurora", spilloverChannels: 26, asinh: 6, logicle: 26,
  },
  {
    instrument: "Aurora-Evo", vendor: "Cytek",
    path: join(VENDOR_DIR, "cytek_aurora_evo__21643327__Negative_1_(Beads).fcs"),
    version: "FCS3.1", mode: "flow", events: 5000, channels: 40,
    cyt: "Aurora-Evo", spilloverChannels: 33, asinh: 6, logicle: 33,
  },
  {
    instrument: "xP5", vendor: "Cytek",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "Cytek_xP5.fcs"),
    version: "FCS3.0", mode: "flow", events: 23126, channels: 8,
    cyt: "Cytek xP5: NCSU CORE  xP5 Facscan", spilloverChannels: 0, asinh: 2, logicle: 5,
  },
  {
    instrument: "FACSDiva export", vendor: "BD",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "BD_FACSDiva.fcs"),
    version: "FCS3.0", mode: "flow", events: 83411, channels: 12,
    cyt: null, spilloverChannels: 8, asinh: 3, logicle: 8,
    note: "Carries no $CYT at all and still imports — instrument detection does not "
      + "depend on the keyword.",
  },
  {
    instrument: "LSRFortessa", vendor: "BD",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "BD_Fortessa.fcs"),
    version: "FCS3.0", mode: "flow", events: 11585, channels: 11,
    cyt: "LSRII", spilloverChannels: 4, asinh: 6, logicle: 4,
  },
  {
    instrument: "LSR II", vendor: "BD",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "BD_LSR-II.fcs"),
    version: "FCS3.0", mode: "flow", events: 14945, channels: 11,
    cyt: "LSRII", spilloverChannels: 4, asinh: 6, logicle: 4,
  },
  {
    instrument: "MACSQuant", vendor: "Miltenyi",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "Miltenyi_MACSQuant.fcs"),
    version: "FCS3.1", mode: "flow", events: 10000, channels: 19,
    cyt: "MACSQuant", spilloverChannels: 0, asinh: 6, logicle: 3,
  },
  {
    instrument: "CyFlow Cube 15", vendor: "Sysmex Partec",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "Sysmex_Partec_CyFlow.fcs"),
    version: "FCS3.0", mode: "flow", events: 725, channels: 10,
    cyt: "Cube_15", spilloverChannels: 0, asinh: 2, logicle: 7,
  },
  {
    instrument: "Muse", vendor: "Guava / Luminex",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "Guava_Muse.fcs"),
    version: "FCS3.0", mode: "flow", events: 108, channels: 10,
    cyt: "Guava Muse, Viacount 1.8", spilloverChannels: 0, asinh: 3, logicle: 6,
    note: "Its $PnS is prose — 'Forward Scatter (FSC-HLin)' — while $PnN is the "
      + "recognisable 'FSC-HLin'. This is the file that forced classification on $PnN "
      + "as well as the display key; before that its scatter got a logicle.",
  },
  {
    instrument: "FACSCalibur", vendor: "BD",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "BD_FACSCalibur_FCS2.0.fcs"),
    version: "FCS2.0", mode: "flow", events: 37395, channels: 8,
    cyt: "FACSCalibur", spilloverChannels: 0, asinh: 2, logicle: 5,
    note: "The FCS 2.0 floor. Together with the S8's FCS 3.2 this brackets the range "
      + "of the standard that the parser claims to read.",
  },
  {
    instrument: "MACSQuant (FCS 2.0 export)", vendor: "Miltenyi",
    path: join(VENDOR_DIR, "curated-from-fcsparser", "Miltenyi_MACSQuant_FCS2.0.fcs"),
    version: "FCS2.0", mode: "flow", events: 10000, channels: 16,
    cyt: "MACSQuant", spilloverChannels: 0, asinh: 6, logicle: 10,
    note: "Same instrument as the FCS 3.1 row above, exported at FCS 2.0 — isolates "
      + "the format version from the instrument.",
  },
  {
    instrument: "CytoFLEX", vendor: "Beckman Coulter",
    path: join(VENDOR_DIR, "beckman_cytoflex__14018551__PI_wt_Rho+_25.fcs"),
    version: "FCS3.0", mode: "flow", events: 100000, channels: 14,
    cyt: "CytoFLEX", spilloverChannels: 0, asinh: 4, logicle: 4,
    note: "Zenodo 14018551, CC-BY-4.0. Its $PnS carries the fluorochrome ('FITC-A') "
      + "over a positional $PnN ('FL1-A'), so the resolved key is 'FITC-A (FL1-A)' — the "
      + "channel-resolution path, not the raw $PnN, is what a gate ends up bound to. "
      + "Navios and DxFlex remain uncovered: the only deposit carrying them (Zenodo "
      + "17094078) is login-restricted despite its CC-BY label.",
  },
  {
    instrument: "CyTOF (Helios/CyTOF2)", vendor: "DVS / Fluidigm",
    path: join(CYTOF_DIR, "PBMC8_30min_patient1_BCR-XL.fcs"),
    version: "FCS3.0", mode: "cytof", events: 2838, channels: 35,
    cyt: "DVSSCIENCES-CYTOF-5.1.559", spilloverChannels: 0, asinh: 33, logicle: 0,
    note: "The only CyTOF row, and the one that proves instrument auto-detection "
      + "switches the whole transform regime: every signal channel is arcsinh, none "
      + "logicle. Bodenmiller BCR-XL benchmark.",
  },
];

/** The truncated header-only stub shipped by fcsparser, kept under its misleading name. */
const TRUNCATED = join(VENDOR_DIR, "curated-from-fcsparser", "Cytek_NL2000.fcs");

function load(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const corpusPresent = existsSync(VENDOR_DIR) && existsSync(CYTOF_DIR);

describe.skipIf(!corpusPresent)("vendor FCS import matrix", () => {
  for (const c of MATRIX) {
    describe(`${c.vendor} ${c.instrument} (${c.version})`, () => {
      it("imports with the expected shape, instrument mode and transforms", () => {
        expect(existsSync(c.path), `missing fixture: ${c.path}`).toBe(true);
        const fcs = parseFcs(load(c.path));

        expect(fcs.version).toBe(c.version);
        expect(fcs.nEvents).toBe(c.events);
        expect(fcs.channels).toHaveLength(c.channels);
        expect(fcs.keywords["$CYT"] ?? null).toBe(c.cyt);
        expect(fcs.instrument).toBe(c.mode);
        expect(fcs.spillover?.channels.length ?? 0).toBe(c.spilloverChannels);

        const sample = new Sample(fcs);
        const kinds = sample.channels.map((_, i) => sample.transformKind(i));
        expect(kinds.filter((k) => k === "asinh")).toHaveLength(c.asinh);
        expect(kinds.filter((k) => k === "logicle")).toHaveLength(c.logicle);
      });

      it("yields finite gating values on every channel", () => {
        const sample = new Sample(parseFcs(load(c.path)));
        const data = sample.gatingData();
        for (const channel of sample.channels) {
          const column = data.column(channel.key);
          expect(column, `no gating column for ${channel.key}`).toBeDefined();
          expect(column!.length).toBe(c.events);
          // A parse that silently misreads offsets or endianness shows up here as
          // NaN/Infinity long before it shows up as a wrong gate.
          let nonFinite = 0;
          for (let i = 0; i < column!.length; i++) if (!Number.isFinite(column![i])) nonFinite++;
          expect(nonFinite, `${channel.key} has ${nonFinite} non-finite values`).toBe(0);
        }
      });
    });
  }

  // Guards the claim the paper makes, so the claim cannot quietly outgrow the corpus:
  // if a row is removed, the coverage assertion fails rather than the sentence in the
  // manuscript becoming false.
  it("covers both instrument modes, eight vendors, and every FCS version from 2.0 to 3.2", () => {
    expect(new Set(MATRIX.map((c) => c.mode))).toEqual(new Set(["flow", "cytof"]));
    expect(new Set(MATRIX.map((c) => c.vendor)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(MATRIX.map((c) => c.version))).toEqual(
      new Set(["FCS2.0", "FCS3.0", "FCS3.1", "FCS3.2"]),
    );
  });

  it("refuses a truncated file rather than importing garbage", () => {
    // 3,931 bytes on disk, but the header declares $BEGINDATA=5912, $ENDDATA=2165911,
    // $PAR=27, $TOT=20000 — 2.1 MB of data that is not there. Refusing is correct.
    // The current failure is a raw RangeError rather than a diagnosed message; this
    // asserts only that it refuses, so improving the message will not break the test.
    expect(existsSync(TRUNCATED)).toBe(true);
    expect(() => parseFcs(load(TRUNCATED))).toThrow();
  });

  it.runIf(process.env.GATELAB_EMIT_MATRIX)("emits the matrix for the manuscript", () => {
    const rows = MATRIX.map((c) =>
      `| ${c.vendor} | ${c.instrument} | ${c.version.replace("FCS", "")} | ${c.channels} | `
      + `${c.events.toLocaleString("en-US")} | ${c.mode} | ${c.spilloverChannels || "—"} |`,
    );
    console.log(
      "\n| Vendor | Instrument | FCS | Channels | Events | Detected | Spillover |\n"
      + "|---|---|---|---|---|---|---|\n" + rows.join("\n") + "\n",
    );
  });
});
