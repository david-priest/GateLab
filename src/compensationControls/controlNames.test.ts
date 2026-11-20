import { describe, expect, it } from "vitest";
import type { ControlChannel } from "./controlFile";
import { namedChannel, namedFmo, namedParticle, namedUnstained, nameTokens } from "./controlNames";

const channel = (pnn: string, marker: string | null = null): ControlChannel =>
  ({ key: marker ?? pnn, pnn, marker, range: 262144 });
const PANEL = ["FITC-A", "PE-A", "PE-Cy7-A", "PerCP-Cy5-5-A", "APC-A", "APC-Cy7-A", "BV421-A"].map((pnn) => channel(pnn));
const file = (fileName: string, labels: string[] = []) => ({ fileName, labels });

describe("nameTokens", () => {
  it("splits on anything that is not a letter or digit, lower-cased", () => {
    expect(nameTokens("Compensation Controls_PE-Cy7 Stained Control.fcs"))
      .toEqual(["compensation", "controls", "pe", "cy7", "stained", "control", "fcs"]);
  });
});

describe("namedChannel", () => {
  it("takes the longest channel name in the file name: PE-Cy7 is not PE", () => {
    expect(namedChannel(file("Compensation Controls_PE-Cy7 Stained Control.fcs"), PANEL).channel).toBe("PE-Cy7-A");
    expect(namedChannel(file("Compensation Controls_PE Stained Control.fcs"), PANEL).channel).toBe("PE-A");
    expect(namedChannel(file("APC-Cy7 beads.fcs"), PANEL).channel).toBe("APC-Cy7-A");
    expect(namedChannel(file("APC beads.fcs"), PANEL).channel).toBe("APC-A");
  });

  it("reads a name whatever separates its parts", () => {
    for (const name of ["PECy7.fcs", "PE_Cy7.fcs", "pe cy7 comp.fcs", "comp-PE-Cy7.fcs"]) {
      expect(namedChannel(file(name), PANEL).channel).toBe("PE-Cy7-A");
    }
    expect(namedChannel(file("BV 421.fcs"), PANEL).channel).toBe("BV421-A");
    expect(namedChannel(file("PerCP-Cy5.5 Stained Control.fcs"), PANEL).channel).toBe("PerCP-Cy5-5-A");
  });

  it("does not find a short name inside a longer word", () => {
    expect(namedChannel(file("Specimen_001_Tube_004.fcs"), PANEL)).toEqual({ channel: null, candidates: [] });
    expect(namedChannel(file("PerCP.fcs"), PANEL).channel).toBeNull();
  });

  it("reads the names the file carries for itself as well as the file name", () => {
    expect(namedChannel(file("Tube_003.fcs", ["FITC Stained Control"]), PANEL).channel).toBe("FITC-A");
  });

  it("prefers the detector name to a marker the panel puts on another channel", () => {
    const panel = [channel("FITC-A", "CD4"), channel("BV510-A", "CD45RA"), channel("PE-A", "CD8")];
    expect(namedChannel(file("CD45RA FITC.fcs"), panel).channel).toBe("FITC-A");
  });

  it("falls back to the marker where no detector is named", () => {
    const panel = [channel("B530/30-A", "CD4"), channel("YG582/15-A", "CD8")];
    expect(namedChannel(file("CD8 single stain.fcs"), panel).channel).toBe("YG582/15-A");
  });

  it("decides nothing where two channels fit equally", () => {
    const named = namedChannel(file("FITC and APC.fcs"), PANEL);
    expect(named.channel).toBeNull();
    expect(named.candidates).toEqual(["FITC-A", "APC-A"]);
  });
});

describe("namedUnstained", () => {
  it("finds the unstained control by its usual names", () => {
    for (const name of [
      "Compensation Controls_Unstained Control.fcs", "unstained.fcs", "Cells only.fcs", "No stain.fcs",
      "beads_only.fcs", "Negative control.fcs", "blank.fcs",
    ]) {
      expect(namedUnstained(file(name)), name).toBe(true);
    }
  });

  it("does not take a stained control for it", () => {
    for (const name of ["Compensation Controls_FITC Stained Control.fcs", "PE.fcs", "CD4 negative fraction PE.fcs"]) {
      expect(namedUnstained(file(name)), name).toBe(false);
    }
  });
});

describe("namedFmo", () => {
  it("finds a fluorescence-minus-one control, and the channel it leaves out", () => {
    for (const name of ["FMO PE-Cy7.fcs", "PE-Cy7 FMO.fcs", "Specimen_001_fmo_PE-Cy7.fcs", "PE-Cy7 fluorescence minus one.fcs"]) {
      expect(namedFmo(file(name)), name).toBe(true);
      expect(namedChannel(file(name), PANEL).channel, name).toBe("PE-Cy7-A");
    }
    for (const name of ["PE-Cy7 Stained Control.fcs", "CD4 minus fraction.fcs", "D1 treated.fcs"]) {
      expect(namedFmo(file(name)), name).toBe(false);
    }
  });
});

describe("namedParticle", () => {
  it("reads beads or cells from the name, and nothing where it says neither or both", () => {
    expect(namedParticle(file("FITC CompBeads.fcs"))).toBe("beads");
    expect(namedParticle(file("UltraComp PE.fcs"))).toBe("beads");
    expect(namedParticle(file("PBMC FITC.fcs"))).toBe("cells");
    expect(namedParticle(file("FITC.fcs"))).toBeNull();
    expect(namedParticle(file("cells and beads FITC.fcs"))).toBeNull();
  });
});
