// testFixtures.ts — resolved paths to the real-instrument files used by the fidelity tests.
// Test-only: nothing in the app imports this.
//
// The files deliberately live OUTSIDE this repo. They are hundreds of megabytes of real
// instrument files, some under third-party licences that do not permit unconsidered
// redistribution, and some private. Where they sit is a fact about one machine, so the
// repository names no location: each is read at test time from the first of these that exists,
//
//   1. test-fixtures.local.json at the repository root (gitignored), for one checkout;
//   2. ~/.config/gatelab/test-fixtures.json, for every checkout and worktree on the machine,
//
// a JSON object whose keys are the FixtureKey names below and whose values are absolute paths.
// A key that is not set resolves to a path that cannot exist, so every test that needs it skips,
// exactly as on a clean CI runner. A real-fixture test that skips on a machine that holds its
// files therefore means a key is missing from that file.
//
// Set GATELAB_FIXTURES to relocate the testing library alone. If a test fails with ENOENT on a
// file you can see in Finder, and the library sits on a Google Drive mount, the likely cause is
// that Drive is holding it as a cloud-only placeholder rather than a local file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_KEYS = [
  /** The testing library: public vendor files, the ISAC conformance set, and more. */
  "root",
  /** The private instrument folder of the testing library. */
  "privateInstrumentDir",
  /** The published S6 sort: `diva-experiment/` and `flowjo-workspace/`. */
  "s6SourceDir",
  /** S8 recordings: `fcs/` and `flowjo-workspace/`. */
  "s8SourceDir",
  /** FlowRepository FR-FCM-Z2V4 and FR-FCM-Z2DR, one folder each. */
  "multiHierarchyDir",
  /** A native-R CyTOF spillover matrix, 46 sources by 61 receivers. */
  "cytofSpillMatrix",
  /** A reviewed CyTOF bead matrix, and an FCS file it applies to. */
  "cytofBeadMatrix",
  "cytofBeadFcs",
  /** A saved .gatelab workspace over a CyTOF file, that file, and a 50-source matrix for it. */
  "cytofWorkspace",
  "cytofWorkspaceFcs",
  "cytofWorkspaceMatrix",
] as const;
type FixtureKey = (typeof FIXTURE_KEYS)[number];

const CONFIG_FILES = [
  join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures.local.json"),
  join(homedir(), ".config", "gatelab", "test-fixtures.json"),
];

function readFixtureConfig(): Partial<Record<FixtureKey, string>> {
  const file = CONFIG_FILES.find((path) => existsSync(path));
  if (!file) return {};
  const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  // A misspelt key would otherwise skip its tests without a word.
  const unknown = Object.keys(config).filter((key) => !(FIXTURE_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) throw new Error(`${file}: unknown fixture keys ${unknown.join(", ")}`);
  return config;
}

const CONFIG = readFixtureConfig();

/** The configured location for `key`, or a path that cannot exist when it is not set. */
function fixturePath(key: FixtureKey): string {
  return CONFIG[key] ?? `/nonexistent/${key} (not set in a test-fixtures file)`;
}

/** Root of the manual-test corpus. Override with GATELAB_FIXTURES. */
export const FIXTURES_ROOT = process.env.GATELAB_FIXTURES ?? fixturePath("root");

/** The private instrument folder: the conventional set below and a large S8 spectral file. */
export const PRIVATE_INSTRUMENT_DIR = fixturePath("privateInstrumentDir");

/**
 * FlowJo 11 workbenches (.flowjo) David saved over the four S6 files in its `fcs/` folder (private;
 * LabNotes "GateLab — FlowJo 11 workbench (.flowjo) format, clean-room notes").
 */
export const FLOWJO11_WORKBENCH_DIR = `${PRIVATE_INSTRUMENT_DIR}/flowjo11-workbenches`;

/** FACSAria III / FACSymphony S6 conventional-compensation set (private). */
export const ARIA_III_DIR = `${PRIVATE_INSTRUMENT_DIR}/conventional_comp_AriaIII`;

/** The small Bmem purity file — the default single-sample fixture. */
export const ARIA_SMALL = `${ARIA_III_DIR}/sample_Bmem_purity_small.fcs`;

/** Spillover matrix exported from the acquisition software, with unnamed leading rows. */
export const ARIA_SPILLOVER_CSV = `${ARIA_III_DIR}/spillover_matrix_embedded.csv`;

/** Public, de-identified vendor corpus: one file per instrument, FCS 2.0-3.2. */
export const VENDOR_MATRIX_DIR =
  `${FIXTURES_ROOT}/PUBLIC - Screenshot Safe/Vendor FCS import matrix/source-fcs`;

/** Xitogen XTG-1600: a conventional 13-colour analyser that writes $PnN=FL1-A with
 *  $PnS=FITC-A, so every conjugate name carries the area suffix. Regression fixture for
 *  the unmixed-detection guard in channels.ts — this file must resolve all 32 channels.
 *  Public: FlowRepository FR-FCM-ZZTF (Asilomar Instrument Standardization). */
export const XITOGEN_XTG1600 =
  `${VENDOR_MATRIX_DIR}/xitogen_xtg1600__FR-FCM-ZZTF__SU-2B_APC-Cy7.fcs`;

/** FlowRepository FR-FCM-Z2V4 and FR-FCM-Z2DR: public FlowJo workspaces whose samples carry
 *  TAILORED gates -- the same population at different coordinates per file. Z2DR is the control,
 *  three of its four samples sharing one geometry. Both ISAC-licensed. */
export const MULTI_HIERARCHY_DIR = fixturePath("multiHierarchyDir");
export const Z2V4_WORKSPACE = `${MULTI_HIERARCHY_DIR}/FR-FCM-Z2V4/S_1.wsp`;
export const Z2DR_WORKSPACE = `${MULTI_HIERARCHY_DIR}/FR-FCM-Z2DR/Fig_1A.wsp`;

/** The published B cell sort of Priest et al. 2024: the FACSDiva experiment it was acquired in
 *  (`diva-experiment/`) and its FlowJo workspace (`flowjo-workspace/`). Private data. */
export const S6_SOURCE_DIR = fixturePath("s6SourceDir");

/** The published B cell sort strategy of Priest et al. 2024 (Supplementary Figure 10A) as a FlowJo
 *  10.9 workspace over a FACSDiva file: polygons and rectangles in biex space with FlowJo's own
 *  per-parameter width bases, two of the polygons reaching well below zero. Private data. */
export const S6_STRATEGY_DIR = `${S6_SOURCE_DIR}/flowjo-workspace`;
export const S6_WORKSPACE = `${S6_STRATEGY_DIR}/25-Sep-2023.wsp`;
export const S6_FCS = `${S6_STRATEGY_DIR}/Specimen_001_B cell presort.fcs`;

/** S8 sorter recordings (`fcs/`) and the FlowJo workspace that gates them (`flowjo-workspace/`).
 *  Private data. */
export const S8_SOURCE_DIR = fixturePath("s8SourceDir");

/** Local CyTOF compensation fixtures; see FIXTURE_KEYS. Private data. */
export const CYTOF_SPILL_MATRIX = fixturePath("cytofSpillMatrix");
export const CYTOF_BEAD_MATRIX = fixturePath("cytofBeadMatrix");
export const CYTOF_BEAD_FCS = fixturePath("cytofBeadFcs");
export const CYTOF_WORKSPACE = fixturePath("cytofWorkspace");
export const CYTOF_WORKSPACE_FCS = fixturePath("cytofWorkspaceFcs");
export const CYTOF_WORKSPACE_MATRIX = fixturePath("cytofWorkspaceMatrix");
