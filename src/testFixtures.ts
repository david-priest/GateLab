// testFixtures.ts — resolved paths to the real-instrument FCS corpus used by the
// fidelity tests. Test-only: nothing in the app imports this.
//
// The corpus deliberately lives OUTSIDE this repo. It is hundreds of megabytes of real
// instrument files, some under third-party licences that do not permit unconsidered
// redistribution, and the Wing Lab Aria III data is not public. It moved on 2026-08-15
// from ~/code/gatelabr-test-fcs into the GateLab Paper project's testing library, which
// is where every GateLab test asset now lives.
//
// Set GATELAB_FIXTURES to relocate the corpus — another machine, a CI runner, or a local
// copy kept off the Google Drive mount. The default path sits on a DriveFS mount, so if
// a test fails with ENOENT on a file you can see in Finder, the likely cause is that
// Drive is holding it as a cloud-only placeholder rather than a local file.

const DEFAULT_FIXTURES_ROOT =
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/" +
  "Large Projects/GateLab Paper/testing-library";

/** Root of the manual-test corpus. Override with GATELAB_FIXTURES. */
export const FIXTURES_ROOT = process.env.GATELAB_FIXTURES ?? DEFAULT_FIXTURES_ROOT;

/** Wing Lab FACSAria III / FACSymphony S6 conventional-compensation set (private). */
export const ARIA_III_DIR = `${FIXTURES_ROOT}/PRIVATE - Wing Lab S6/conventional_comp_AriaIII`;

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
export const MULTI_HIERARCHY_DIR =
  `${FIXTURES_ROOT}/../GateLab-2026-08-15-B flowjo-and-cytobank-concordance/` +
  "data/flowrepo-multi-hierarchy";
export const Z2V4_WORKSPACE = `${MULTI_HIERARCHY_DIR}/FR-FCM-Z2V4/S_1.wsp`;
export const Z2DR_WORKSPACE = `${MULTI_HIERARCHY_DIR}/FR-FCM-Z2DR/Fig_1A.wsp`;
