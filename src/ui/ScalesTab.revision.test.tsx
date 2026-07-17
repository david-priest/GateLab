// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { ScalesTab } from "./ScalesTab";
import { useSampleDataRevisionKey, type SampleRevisionEntry } from "./useSampleDataRevisions";

function compensatedFlowSample(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400]),
      Float32Array.from([0, 20, 40, 60]),
      Float32Array.from([10, 20, 30, 40]),
    ],
    spillover: {
      channels: ["FL1-A", "FL2-A"],
      matrix: [[1, 0.5], [0, 1]],
    },
  };
  return new Sample(fcs);
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("ScalesTab Sample revisions", () => {
  it("reflects external compensation changes without a manual React render", () => {
    const sample = compensatedFlowSample();
    const entries: SampleRevisionEntry[] = [{ id: "sample", sample }];

    function Harness() {
      useSampleDataRevisionKey(entries);
      return (
        <ScalesTab
          sample={sample}
          compensationOn={sample.compensationEnabled}
          onToggleCompensation={(enabled) => sample.setCompensation(enabled)}
          globalScales={{}}
          onSetGlobalScale={() => {}}
        />
      );
    }

    act(() => root.render(<Harness />));
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);

    act(() => sample.setCompensation(true));
    expect(sample.dataRevision).toBe(1);
    expect(checkbox.checked).toBe(true);

    act(() => sample.setCompensation(false));
    expect(sample.dataRevision).toBe(2);
    expect(checkbox.checked).toBe(false);
  });
});
