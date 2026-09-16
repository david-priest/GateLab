// @vitest-environment jsdom
//
// An imaging GEOMETRY feature (Size, Eccentricity, the moments, Centre of Mass, Delta CoM,
// Correlation) is a fourth class of flow channel: linear by default, arcsinh on request, the
// reverse of scatter's default on the same control. The two intensity features are fluorescence.
// Flow gates live in raw space, so none of this moves an event in or out of a gate.

import { describe, it, expect } from "vitest";
import { Sample } from "./sample";
import { ChannelScales } from "./channelScales";
import { getGateMask } from "./gates";
import { exportGatingML } from "./gatingmlExport";
import { importGatingML, restoreGatingMLScaleState } from "./gatingml";
import {
  newRootPopulation, newPopulation, newGateRef, linkChildToParent,
  type Gate, type PopulationMap,
} from "./models";
import type { FcsFile } from "./fcs";

/** A slice of an S8 file with $PnFEATURE on every parameter and no raw detectors, so every
 *  channel is kept under its own name. Values are deterministic and span each feature's range. */
function s8Sample(): Sample {
  const n = 400;
  const col = (f: (i: number) => number) => Float32Array.from({ length: n }, (_, i) => f(i));
  const chans = [
    { name: "FSC-A", marker: "FSC-A", feature: "Area", range: 262144, values: col((i) => 20000 + (i * 7919) % 90000) },
    { name: "SSC-A", marker: "SSC-A", feature: "Area", range: 262144, values: col((i) => 5000 + (i * 104729) % 120000) },
    { name: "V500-A", marker: "CD4-A", feature: "Area", range: 262144, values: col((i) => ((i * 31) % 7000) - 200) },
    { name: "Size (FSC)", marker: "Size (FSC)", feature: "MaskSize", range: 10000, values: col((i) => 1100 + (i * 13) % 4900) },
    { name: "Eccentricity (FSC)", marker: "Eccentricity (FSC)", feature: "Eccentricity", range: 1.1, values: col((i) => (i % 5 === 0 ? 0 : ((i * 37) % 100) / 100)) },
    { name: "Total Intensity (FSC)", marker: "Total Intensity (FSC)", feature: "TotalIntensity", range: 20000000, values: col((i) => (i * 4241) % 3000000) },
    { name: "Time", marker: "Time", feature: "Time", range: 1024, values: col((i) => i) },
  ];
  const fcs: FcsFile = {
    version: "FCS3.2", nEvents: n, instrument: "flow", keywords: {}, spillover: null,
    channels: chans.map((c, index) => ({ index, name: c.name, marker: c.marker, bits: 32, range: c.range, feature: c.feature })),
    columns: chans.map((c) => c.values),
  };
  return new Sample(fcs);
}

const ROUND: Gate = {
  gate_id: "round", name: "Round", gate_type: "rectangle",
  x_channel: "Size (FSC)", y_channel: "Eccentricity (FSC)",
  vertices: [[1500, 0.1], [4000, 0.1], [4000, 0.8], [1500, 0.8]],
  color: "#e41a1c", label_offset: null,
};

function tree(gate: Gate) {
  const root = newRootPopulation();
  let populations: PopulationMap = { [root.population_id]: root };
  const pop = newPopulation(gate.name, [newGateRef(gate.gate_id, true)], root.population_id);
  populations[pop.population_id] = pop;
  populations = linkChildToParent(populations, pop.population_id, root.population_id);
  return { gates: { [gate.gate_id]: gate }, gate_order: [gate.gate_id], populations, root_population_id: root.population_id };
}

describe("imaging geometry features", () => {
  it("are a class of their own; the intensities stay fluorescence", () => {
    const s = s8Sample();
    const size = s.index("Size (FSC)")!;
    const ecc = s.index("Eccentricity (FSC)")!;
    const total = s.index("Total Intensity (FSC)")!;
    expect(s.isImagingFeatureAxis(size)).toBe(true);
    expect(s.isImagingFeatureAxis(ecc)).toBe(true);
    for (const key of ["Total Intensity (FSC)", "FSC-A", "CD4-A", "Time"]) {
      expect(s.isImagingFeatureAxis(s.index(key)!), key).toBe(false);
    }
    expect(s.isFluorChannel(size)).toBe(false);
    expect(s.isFluorChannel(ecc)).toBe(false);
    expect(s.isFluorChannel(total)).toBe(true);
    expect(s.isFluorChannel(s.index("CD4-A")!)).toBe(true);
    expect(s.isScatterAxis(size)).toBe(false);
  });

  it("are linear by default, so display equals raw, while an intensity keeps the fluorescence default", () => {
    const s = s8Sample();
    expect(s.featureScale(s.index("Size (FSC)")!)).toBe("linear");
    expect(s.transformKind(s.index("Eccentricity (FSC)")!)).toBe("identity");
    expect(s.rawToDisplay("Eccentricity (FSC)", 0.73)).toBeCloseTo(0.73, 9);
    expect(s.rawToDisplay("Size (FSC)", 2345)).toBeCloseTo(2345, 6);
    expect(s.transformSpec("Size (FSC)")).toEqual({ kind: "identity" });
    expect(s.transformKind(s.index("Total Intensity (FSC)")!)).not.toBe("identity");
  });

  it("switch to arcsinh at the scatter cofactor and back, moving no gate", () => {
    const s = s8Sample();
    const before = Array.from(getGateMask(ROUND, s.gatingData()));
    const nIn = before.reduce((acc, v) => acc + v, 0);
    expect(nIn).toBeGreaterThan(0);
    expect(nIn).toBeLessThan(before.length);

    const ecc = s.index("Eccentricity (FSC)")!;
    s.setFeatureScale(ecc, "arcsinh");
    expect(s.featureScale(ecc)).toBe("arcsinh");
    expect(s.transformKind(ecc)).toBe("asinh");
    expect(s.rawToDisplay("Eccentricity (FSC)", 0.5)).toBeCloseTo(Math.asinh(0.5 / 150), 9);
    expect(s.transformSpec("Eccentricity (FSC)")).toEqual({ kind: "asinh", cofactor: 150 });
    expect(Array.from(getGateMask(ROUND, s.gatingData()))).toEqual(before);

    s.setScatterCofactor(ecc, 10);
    expect(s.rawToDisplay("Eccentricity (FSC)", 0.5)).toBeCloseTo(Math.asinh(0.5 / 10), 9);
    expect(s.transformSpec("Eccentricity (FSC)")).toEqual({ kind: "asinh", cofactor: 10 });
    expect(Array.from(getGateMask(ROUND, s.gatingData()))).toEqual(before);

    s.setFeatureScale(ecc, "linear");
    expect(s.transformKind(ecc)).toBe("identity");

    // The control reaches no other class.
    const fsc = s.index("FSC-A")!;
    s.setFeatureScale(fsc, "arcsinh");
    expect(s.fluorArcsinhKeys()).toEqual([]);
    expect(s.featureScale(fsc)).toBe("linear");
  });

  it("label a linear axis evenly and an arcsinh axis in raw decades", () => {
    const s = s8Sample();
    const ecc = s.index("Eccentricity (FSC)")!;
    const linear = s.channelTicks(ecc, [0, 1])!;
    expect(linear).not.toBeNull();
    expect(linear.major_labels).toHaveLength(11);
    expect(linear.major_labels[0]).toBe("0");
    expect(linear.major_labels).toContain("0.5");
    expect(linear.major_labels[10]).toBe("1");
    s.setFeatureScale(ecc, "arcsinh");
    const asinh = s.channelTicks(ecc, [0, Math.asinh(1 / 150)])!;
    expect(asinh).not.toBeNull();
    expect(asinh.major_labels).toContain("0");
    expect(asinh.major_labels).not.toEqual(linear.major_labels);
  });

  it("keep the choice in the workspace's arcsinh keys and share it across files", () => {
    const s = s8Sample();
    s.setFeatureScale(s.index("Eccentricity (FSC)")!, "arcsinh");
    expect(s.fluorArcsinhKeys()).toEqual(["Eccentricity (FSC)"]);
    const fresh = s8Sample();
    fresh.applyFluorArcsinhKeys(["Eccentricity (FSC)"]);
    expect(fresh.featureScale(fresh.index("Eccentricity (FSC)")!)).toBe("arcsinh");

    const scales = new ChannelScales();
    const a = s8Sample();
    const b = s8Sample();
    a.attachChannelScales(scales);
    b.attachChannelScales(scales);
    a.setFeatureScale(a.index("Size (FSC)")!, "arcsinh");
    expect(b.featureScale(b.index("Size (FSC)")!)).toBe("arcsinh");
    expect(b.transformKind(b.index("Size (FSC)")!)).toBe("asinh");
    expect(b.fluorArcsinhKeys()).toEqual(["Size (FSC)"]);
  });

  it("round-trip an arcsinh choice through the Gating-ML scale state", () => {
    const s = s8Sample();
    const ecc = s.index("Eccentricity (FSC)")!;
    s.setFeatureScale(ecc, "arcsinh");
    s.setScatterCofactor(ecc, 20);
    const xml = exportGatingML({ ...tree(ROUND), sample: s, timestamp: "2026-09-15T00:00:00" });
    const back = importGatingML(
      xml,
      s.channels.map((c) => c.key),
      Object.fromEntries(s.channels.map((c) => [c.pnn, c.key])),
      "flow",
    );
    expect(back.scales?.["Eccentricity (FSC)"]?.cofactor).toBe(20);
    expect(back.scales?.["Eccentricity (FSC)"]?.w).toBeUndefined();
    expect(back.scales?.["Size (FSC)"]?.cofactor).toBeUndefined();

    const dest = s8Sample();
    const restored = restoreGatingMLScaleState(dest, back.scales, back.cytof_cofactor);
    expect(restored.transformsChanged).toBe(true);
    expect(dest.featureScale(dest.index("Eccentricity (FSC)")!)).toBe("arcsinh");
    expect(dest.currentScatterCofactor(dest.index("Eccentricity (FSC)")!)).toBe(20);
    expect(dest.featureScale(dest.index("Size (FSC)")!)).toBe("linear");
    // The gate itself came back where it was: raw is raw on a linear axis.
    const gate = Object.values(back.gates)[0] as { vertices?: [number, number][] };
    expect(gate.vertices?.map((v) => v.map((x) => Math.round(x * 1000) / 1000))).toEqual(ROUND.vertices);
  });
});

describe("imaging features and the spillover matrix", () => {
  it("every image-derived feature is recognised, the intensities included", () => {
    const s = s8Sample();
    for (const key of ["Size (FSC)", "Eccentricity (FSC)", "Total Intensity (FSC)"]) {
      expect(s.isImagingFeatureChannel(s.index(key)!), key).toBe(true);
    }
    for (const key of ["FSC-A", "CD4-A", "Time"]) {
      expect(s.isImagingFeatureChannel(s.index(key)!), key).toBe(false);
    }
  });
});

