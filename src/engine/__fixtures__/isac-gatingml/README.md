# ISAC Gating-ML 2.0 compliance data

The Gating-ML 2.0 part of the ISAC compliance suite, from the Bioconductor data package `gatingMLData` 2.38.0 (J. Spidlen, N. Gopalakrishnan), used only by `isacGatingML.test.ts` through `isacGatingML.harness.ts`. Nothing here is in the production bundle.

Source: https://bioconductor.org/packages/3.16/data/experiment/src/contrib/gatingMLData_2.38.0.tar.gz (sha256 `d3bb9293055c255bbd5ce7930562196f05e18c65850050aee9c007982d2215b6`). The package was deprecated and then removed from Bioconductor at release 3.17.

## Licence

The package's DESCRIPTION says `License: GPL`, which R reads as the GNU General Public License, version 2 or version 3. These files are redistributed under that licence; its texts are `LICENSE-GPL-2` and `LICENSE-GPL-3` here (copied from R's `share/licenses`). GateLab's own code is MIT-licensed; these test files are not, and they are not part of any GateLab build.

## What is here

| File | From the package | Changed |
|---|---|---|
| `gates1.xml` to `gates5.xml` | `inst/extdata/Gml2/Gating-MLFiles/` | no |
| `data1.fcs.gz`, `data2.fcs.gz`, `9399_1_3_NKR.fcs.gz` | `inst/extdata/Gml2/FCSFiles/` | gzip only (`gzip -9 -n`); the FCS bytes are unchanged |
| `expected-set1.json.gz` to `expected-set5.json.gz` | `inst/extdata/Gml2/ExpectedResults/set_1` to `set_5` | repacked: each `Results_<gate>.txt` (one 0 or 1 per event, in FCS event order) as bits, event i in bit (i mod 8) of byte floor(i / 8), base64, keyed by gate id, gzipped. No value changed. |

`ExpectedResults/set_6` is left out: the package carries no Gating-ML file for it.

## Changes

The GPL asks a modified copy to say what was changed and when (version 2, section 2a; version 3, section 5a). Changed for GateLab:

- `data1.fcs.gz`, `data2.fcs.gz`, `9399_1_3_NKR.fcs.gz`: on 2026-09-25, the package's `data1.fcs`, `data2.fcs` and `9399_1_3_NKR.fcs` compressed with `gzip -9 -n`. The FCS bytes are unchanged.
- `expected-set1.json.gz`, `expected-set2.json.gz`, `expected-set3.json.gz`, `expected-set4.json.gz`, `expected-set5.json.gz`: on 2026-09-25, the package's `ExpectedResults/set_1` to `set_5` repacked as described above. No value changed.

`gates1.xml` to `gates5.xml` and the licence texts are as the package and R carry them.

The suite's reference, flowUtils (`inst/RUnitGml2Script_Files/runit.0N.setN.R`), reads each FCS file with flowCore's `read.FCS(transformation = "linearize-with-PnG-scaling")`, which divides a linearly amplified channel by its `$PnG`. `data1.fcs` carries `$P1G = 3.67` and `$P2G = 8`; the harness divides those two columns the same way (`isacSample`).
