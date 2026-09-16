import { describe, expect, it } from "vitest";
import { filesToHold, perFilePrimary } from "./flowjoOpen";
import type { FlowJoFileResolution, FlowJoSampleSummary } from "./flowjoWorkspace";

const file = (name: string) => ({ name, file: new File([], name) });

describe("filesToHold", () => {
  it("skips files already loaded or already held, and holds the rest once", () => {
    const held = [file("b1.fcs")];
    const loaded = ["A1.fcs"];
    const incoming = [file("a1.fcs"), file("B1.fcs"), file("c1.fcs"), file("C1.fcs"), file("d1.fcs")];
    expect(filesToHold(held, loaded, incoming).map((f) => f.name)).toEqual(["c1.fcs", "d1.fcs"]);
  });

  it("holds everything when nothing is loaded or held", () => {
    expect(filesToHold([], [], [file("x.fcs")]).map((f) => f.name)).toEqual(["x.fcs"]);
  });
});

describe("perFilePrimary", () => {
  const sample = (index: number): FlowJoSampleSummary =>
    ({ index, name: `sample ${index}`, candidateFileNames: [`s${index}.fcs`], gateCount: 1 }) as unknown as FlowJoSampleSummary;
  const samples = [sample(0), sample(1), sample(2)];
  const resolutions: FlowJoFileResolution[] = [
    { sampleIndex: 0, fileName: null, matchedName: null },
    { sampleIndex: 1, fileName: "s1.fcs", matchedName: "s1.fcs" },
    { sampleIndex: 2, fileName: "s2.fcs", matchedName: "s2.fcs" },
  ] as unknown as FlowJoFileResolution[];

  it("keeps the selected sample when its file was found", () => {
    expect(perFilePrimary(samples, resolutions, 2)?.index).toBe(2);
  });

  it("falls back to the first found sample when the selected one has no file, or nothing is selected", () => {
    expect(perFilePrimary(samples, resolutions, 0)?.index).toBe(1);
    expect(perFilePrimary(samples, resolutions, null)?.index).toBe(1);
  });

  it("is undefined when no file was found at all", () => {
    const none = resolutions.map((r) => ({ ...r, fileName: null }));
    expect(perFilePrimary(samples, none, 1)).toBeUndefined();
  });
});
