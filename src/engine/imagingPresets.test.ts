import { describe, expect, it } from "vitest";
import { imagingPlotPresets, splitImagingFeature } from "./imagingPresets";

const labels = [
  "FSC-A", "SSC-A", "Time",
  "Size (LightLoss (Imaging))", "Size (FSC)", "Eccentricity (LightLoss (Imaging))", "Eccentricity (FSC)",
  "Radial Moment (FSC)", "Radial Moment (LightLoss (Imaging))",
  "Max Intensity (Imaging_BP/534/46/LP/505)", "Diffusivity (Imaging_BP/534/46/LP/505)", "Diffusivity (SSC (Imaging))",
  "Correlation (Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570)", "Delta CoM (Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570)",
  "Delta CoM (SSC (Imaging)/FSC)",
];

describe("imagingPlotPresets", () => {
  it("splits a feature label into the feature and its channel", () => {
    expect(splitImagingFeature("Size (FSC)")).toEqual(["Size", "FSC"]);
    expect(splitImagingFeature("Delta CoM (SSC (Imaging)/FSC)")).toEqual(["Delta CoM", "SSC (Imaging)/FSC"]);
    expect(splitImagingFeature("FSC-A")).toBeNull();
    expect(splitImagingFeature("Center of Mass (X) (FSC)")).toBeNull();
  });
  it("offers the doublet and size plots on LightLoss first, the spread plot per fluorescence image, and co-localisation per pair", () => {
    const presets = imagingPlotPresets(labels);
    expect(presets.map((p) => [p.id, labels[p.x], labels[p.y]])).toEqual([
      ["doublets", "Radial Moment (LightLoss (Imaging))", "Eccentricity (LightLoss (Imaging))"],
      ["size-shape", "Size (LightLoss (Imaging))", "Eccentricity (LightLoss (Imaging))"],
      ["spread:Imaging_BP/534/46/LP/505", "Max Intensity (Imaging_BP/534/46/LP/505)", "Diffusivity (Imaging_BP/534/46/LP/505)"],
      ["coloc:Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570", "Correlation (Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570)", "Delta CoM (Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570)"],
    ]);
    expect(presets.every((p) => p.title && p.note)).toBe(true);
    expect(presets[0].vars).toEqual({ channel: "LightLoss (Imaging)" });
    expect(presets[2].vars).toEqual({ channel: "Imaging_BP/534/46/LP/505" });
    expect(presets[3].vars).toEqual({ pair: "Imaging_BP/534/46/LP/505/Imaging_BP/598/60/LP/570" });
  });
  it("falls back to FSC when LightLoss lacks a feature, and offers nothing without image features", () => {
    const fscOnly = labels.filter((l) => !/LightLoss/.test(l));
    const presets = imagingPlotPresets(fscOnly);
    expect(presets.find((p) => p.id === "doublets")).toMatchObject({ x: fscOnly.indexOf("Radial Moment (FSC)"), y: fscOnly.indexOf("Eccentricity (FSC)") });
    expect(presets.find((p) => p.id === "size-shape")).toMatchObject({ x: fscOnly.indexOf("Size (FSC)"), y: fscOnly.indexOf("Eccentricity (FSC)") });
    expect(imagingPlotPresets(["FSC-A", "SSC-A", "CD4-A"])).toEqual([]);
  });
});
