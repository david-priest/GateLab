import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { isImagingFeature, resolveChannels } from "./channels";
import { FIXTURES_ROOT, XITOGEN_XTG1600 } from "../testFixtures";
import { parseFcs, type FcsFile, type FcsChannel } from "./fcs";

function mkFcs(
  instrument: "flow" | "cytof",
  chans: { name: string; marker: string | null; feature?: string }[],
): FcsFile {
  const channels: FcsChannel[] = chans.map((c, i) => ({
    index: i,
    name: c.name,
    marker: c.marker,
    bits: 32,
    range: 262144,
    ...(c.feature ? { feature: c.feature } : {}),
  }));
  return {
    version: "FCS3.1",
    nEvents: 1,
    instrument,
    keywords: {},
    spillover: null,
    channels,
    columns: chans.map(() => Float32Array.of(0)),
  };
}

describe("resolveChannels — spectral-unmixed flow", () => {
  it("keeps scatter + unmixed (renamed) + Time, drops raw detectors", () => {
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: "FSC-A" },
      { name: "SSC (Violet)-A", marker: "SSC (Violet)-A" },
      { name: "B1-A", marker: null }, // raw spectral detector → drop
      { name: "B2-A", marker: "" }, // raw spectral detector → drop
      { name: "V500-A", marker: "CD4-A" }, // unmixed → keep, renamed
      { name: "PE-A", marker: "CD25-A" }, // unmixed → keep, renamed
      { name: "Time", marker: null },
    ]);
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys).toEqual([
      "FSC-A",
      "SSC (Violet)-A",
      "CD4-A (V500-A)",
      "CD25-A (PE-A)",
      "Time",
    ]);
  });

  it("preserves $PnN on the renamed unmixed channels", () => {
    const fcs = mkFcs("flow", [
      { name: "B1-A", marker: null }, // raw detectors, two of them, so this file is genuinely unmixed
      { name: "B2-A", marker: null },
      { name: "V500-A", marker: "CD4-A" },
      { name: "PE-A", marker: "CD25-A" },
    ]);
    const r = resolveChannels(fcs);
    expect(r.map((c) => c.key)).toEqual(["CD4-A (V500-A)", "CD25-A (PE-A)"]);
    expect(r.map((c) => c.pnn)).toEqual(["V500-A", "PE-A"]);
  });
});

describe("resolveChannels — imaging features of a spectral file", () => {
  it("keeps the features the instrument derived from its images, keyed by $PnFEATURE", () => {
    // A BD FACSDiscover S8 writes eleven features per imaging channel. Their $PnS equals $PnN
    // and their names start with the feature, so every earlier rule missed them and they
    // went out with the raw detectors: a 224-parameter file came in as 18 channels.
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: "FSC-A", feature: "Area" },
      { name: "FSC-T", marker: "FSC-T", feature: "Time to peak" }, // pulse timing → drop, as before
      { name: "LightLoss (Imaging)-A", marker: "LightLoss (Imaging)-A", feature: "Area" },
      { name: "Size (FSC)", marker: "Size (FSC)", feature: "MaskSize" },
      { name: "Eccentricity (SSC (Imaging))", marker: "Eccentricity (SSC (Imaging))", feature: "Eccentricity" },
      { name: "Center of Mass (X) (LightLoss (Imaging))", marker: "Center of Mass (X) (LightLoss (Imaging))", feature: "CenterOfMassX" },
      { name: "Delta CoM (SSC (Imaging)/FSC)", marker: "Delta CoM (SSC (Imaging)/FSC)", feature: "Delta CoM" },
      { name: "Blobness (FSC)", marker: "Blobness (FSC)", feature: "Blobness" }, // a feature this code has not heard of
      { name: "UV1 (375)-A", marker: "UV1 (375)-A", feature: "Area" }, // raw detectors → drop
      { name: "UV2 (390)-A", marker: "UV2 (390)-A", feature: "Area" },
      { name: "V500-A", marker: "CD4-A", feature: "Area" }, // unmixed → keep, renamed
      { name: "PE-A", marker: "CD25-A", feature: "Area" },
      { name: "Saturated", marker: "Saturated" }, // generic QC column, no feature → drop
      { name: "Time", marker: "Time", feature: "Time" },
    ]);
    expect(resolveChannels(fcs).map((c) => c.key)).toEqual([
      "FSC-A",
      "LightLoss (Imaging)-A",
      "Size (FSC)",
      "Eccentricity (SSC (Imaging))",
      "Center of Mass (X) (LightLoss (Imaging))",
      "Delta CoM (SSC (Imaging)/FSC)",
      "Blobness (FSC)",
      "CD4-A (V500-A)",
      "CD25-A (PE-A)",
      "Time",
    ]);
  });

  it("recognises the documented feature names when the file carries no $PnFEATURE", () => {
    // An export that kept the names and dropped the vendor keywords.
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: "FSC-A" },
      { name: "Size (FSC)", marker: "Size (FSC)" },
      { name: "Radial Moment (LightLoss (Imaging))", marker: "Radial Moment (LightLoss (Imaging))" },
      { name: "Total Intensity (SSC (Imaging))", marker: "Total Intensity (SSC (Imaging))" },
      { name: "UV1 (375)-A", marker: null },
      { name: "UV2 (390)-A", marker: null },
      { name: "V500-A", marker: "CD4-A" },
      { name: "PE-A", marker: "CD25-A" },
    ]);
    expect(resolveChannels(fcs).map((c) => c.key)).toEqual([
      "FSC-A",
      "Size (FSC)",
      "Radial Moment (LightLoss (Imaging))",
      "Total Intensity (SSC (Imaging))",
      "CD4-A (V500-A)",
      "CD25-A (PE-A)",
    ]);
  });

  it("does not count imaging features as the raw detectors that make a file spectral", () => {
    // Two unmixed markers and the imaging set, but no detector: a conventional file whose
    // marker labels end "-A", kept whole as the Xitogen and CytoFLEX cases are.
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: "FSC-A", feature: "Area" },
      { name: "FSC-W", marker: "FSC-W", feature: "Width" },
      { name: "Size (FSC)", marker: "Size (FSC)", feature: "MaskSize" },
      { name: "Eccentricity (FSC)", marker: "Eccentricity (FSC)", feature: "Eccentricity" },
      { name: "FL1-A", marker: "FITC-A", feature: "Area" },
      { name: "FL1-H", marker: "FITC-H", feature: "Height" },
      { name: "FL2-A", marker: "PE-A", feature: "Area" },
    ]);
    expect(resolveChannels(fcs)).toHaveLength(7);
  });

  it("tells a feature from a pulse by $PnFEATURE first and by name second", () => {
    expect(isImagingFeature("FSC-A", "Area")).toBe(false);
    expect(isImagingFeature("FSC-T", "Time to peak")).toBe(false);
    expect(isImagingFeature("Time", "Time")).toBe(false);
    expect(isImagingFeature("Size (FSC)", "MaskSize")).toBe(true);
    expect(isImagingFeature("Size (FSC)")).toBe(true);
    expect(isImagingFeature("Correlation (eGFP/eYFP)")).toBe(true);
    expect(isImagingFeature("UV1 (375)-A")).toBe(false);
    expect(isImagingFeature("Saturated", "")).toBe(false);
    // The keyword wins over the name: a channel someone called "Size (…)" that the
    // instrument says is a pulse area stays a pulse.
    expect(isImagingFeature("Size (FSC)", "Area")).toBe(false);
  });
});

describe("resolveChannels — conventional flow (no unmixed)", () => {
  it("keeps all channels; key = marker if present else $PnN", () => {
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: null },
      { name: "B530-A", marker: "CD3" }, // marker not ending -A → not 'unmixed'
      { name: "PE-A", marker: "" },
    ]);
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys).toEqual(["FSC-A", "CD3", "PE-A"]);
  });

  it("uses $PnN to preserve identity when marker labels repeat", () => {
    const fcs = mkFcs("flow", [
      { name: "FSC-A", marker: null },
      { name: "V1-A", marker: "CD3" },
      { name: "V2-A", marker: " CD3 " },
    ]);
    const resolved = resolveChannels(fcs);
    expect(resolved.map((c) => c.key)).toEqual(["FSC-A", "CD3 (V1-A)", "CD3 (V2-A)"]);
    expect(new Set(resolved.map((c) => c.key)).size).toBe(resolved.length);
    expect(resolved.map((c) => c.pnn)).toEqual(["FSC-A", "V1-A", "V2-A"]);
  });
});

describe("resolveChannels — conjugate names ending -A are not unmixed markers", () => {
  // An analyser whose $PnS is the conjugate ("FITC-A" for $PnN "FL1-A") satisfies the
  // marker half of the unmixed test on every channel, but carries no raw detectors at
  // all. Filtering it drops real data: the height partners and any spelled-out width.
  const conjugateNamed = () =>
    mkFcs("flow", [
      { name: "FSC-H", marker: "FSC-H" },
      { name: "FSC-A", marker: "FSC-A" },
      { name: "SSC-A", marker: "SSC-A" },
      { name: "FL1-H", marker: "FITC-H" },
      { name: "FL1-A", marker: "FITC-A" },
      { name: "FL2-H", marker: "PE-H" },
      { name: "FL2-A", marker: "PE-A" },
      { name: "FSC-Width", marker: "FSC-Width" },
      { name: "Time", marker: "Time" },
    ]);

  it("keeps every channel, including height partners and FSC-Width", () => {
    const resolved = resolveChannels(conjugateNamed());
    expect(resolved.map((c) => c.key)).toEqual([
      "FSC-H", "FSC-A", "SSC-A", "FITC-H", "FITC-A", "PE-H", "PE-A", "FSC-Width", "Time",
    ]);
  });

  it("treats a file as unmixed once raw detectors are present, and there are more than one", () => {
    const fcs = conjugateNamed();
    fcs.channels.push({ index: 9, name: "B1-A", marker: null, bits: 32, range: 262144 });
    fcs.channels.push({ index: 10, name: "B2-A", marker: null, bits: 32, range: 262144 });
    fcs.columns.push(Float32Array.of(0), Float32Array.of(0));
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys).not.toContain("B1-A");
    expect(keys).not.toContain("B2-A");
    expect(keys).toContain("FITC-A (FL1-A)");
  });

  it("keeps a conventional file whole when one fluorescence channel has no label", () => {
    // One unlabelled detector is an unstained or spare channel on a conventional analyser, not
    // a spectral detector bank. Treating it as one dropped every -H channel and changed the
    // gate channel identities between files of a panel that differed only in that label.
    const fcs = conjugateNamed();
    fcs.channels.push({ index: 9, name: "FL3-A", marker: null, bits: 32, range: 262144 });
    fcs.columns.push(Float32Array.of(0));
    expect(resolveChannels(fcs).map((c) => c.key)).toEqual([
      "FSC-H", "FSC-A", "SSC-A", "FITC-H", "FITC-A", "PE-H", "PE-A", "FSC-Width", "Time", "FL3-A",
    ]);
  });
});

describe("resolveChannels — CyTOF duplicate markers", () => {
  it("applies the same stable identity rule as flow", () => {
    const fcs = mkFcs("cytof", [
      { name: "Y89Di", marker: "CD3" },
      { name: "Nd144Di", marker: "CD3" },
      { name: "Time", marker: null },
    ]);
    expect(resolveChannels(fcs).map((c) => c.key)).toEqual([
      "CD3 (Y89Di)", "CD3 (Nd144Di)", "Time",
    ]);
  });
});

/** A 422-parameter S8 recording with a three-channel imaging set: 33 imaging features, 170
 *  raw detectors, 16 unmixed markers. Private; the test runs where the testing library is. */
const SPECTRAL = `${FIXTURES_ROOT}/PRIVATE - Wing Lab S6/LP1p PBMC large-file check/source-fcs/LP1p pbmc pre rec.fcs`;

describe.runIf(existsSync(SPECTRAL))("resolveChannels — real BD S8 spectral file", () => {
  it("keeps 66 of 422 channels: scatter, unmixed markers, Time and the 33 imaging features", () => {
    const b = readFileSync(SPECTRAL);
    const fcs = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(fcs.channels.length).toBe(422);
    expect(fcs.channels.find((c) => c.name === "Size (FSC)")?.feature).toBe("MaskSize");
    expect(fcs.channels.find((c) => c.name === "FSC-A")?.feature).toBe("Area");
    const r = resolveChannels(fcs);
    expect(r.length).toBe(66);
    const keys = r.map((c) => c.key);
    expect(keys).toContain("FSC-A");
    expect(keys).toContain("SSC (Violet)-A");
    expect(keys).toContain("CD4-A (V500-A)");
    expect(keys).toContain("CD25-A (PE-A)");
    expect(keys.filter((k) => isImagingFeature(k))).toHaveLength(33);
    for (const feature of ["Size", "Max Intensity", "Long Axis Moment", "Short Axis Moment", "Center of Mass (Y)", "Center of Mass (X)", "Total Intensity", "Radial Moment", "Eccentricity", "Diffusivity"]) {
      for (const channel of ["LightLoss (Imaging)", "FSC", "SSC (Imaging)"]) expect(keys).toContain(`${feature} (${channel})`);
    }
    expect(keys).toContain("Delta CoM (SSC (Imaging)/FSC)");
    // no raw detector keys survive (unmixed markers are all "-A (…)")
    expect(keys.some((k) => k === "B1-A" || /^UV\d/.test(k))).toBe(false);
  });
});

describe.runIf(existsSync(XITOGEN_XTG1600))("resolveChannels — real Xitogen XTG-1600", () => {
  it("resolves all 32 channels, keeping the 13 height partners and FSC-Width", () => {
    const b = readFileSync(XITOGEN_XTG1600);
    const fcs = parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    expect(fcs.channels.length).toBe(32);
    const keys = resolveChannels(fcs).map((c) => c.key);
    expect(keys.length).toBe(32);
    expect(keys).toContain("FSC-Width");
    expect(keys).toContain("FITC-H");
    expect(keys).toContain("BV785-H");
  });
});
