// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { CompensationTab } from "./CompensationTab";
import { clearPersistedTabState } from "./tabState";
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
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  vi.unstubAllGlobals();
});

describe("CompensationTab Sample revisions", () => {
  it("reflects external compensation changes without a manual React render", () => {
    const sample = compensatedFlowSample();
    const entries: SampleRevisionEntry[] = [{ id: "sample", sample }];

    function Harness() {
      useSampleDataRevisionKey(entries);
      return (
        <CompensationTab
          sample={sample}
          compensationOn={sample.compensationEnabled}
          stateKey="workspace:sample"
        />
      );
    }

    const activeLayer = () => host.querySelector<HTMLElement>(".gl-comp-summary")?.dataset.activeLayer;

    act(() => root.render(<Harness />));
    expect(activeLayer()).toBe("original");

    act(() => sample.setCompensation(true));
    expect(sample.dataRevision).toBe(1);
    expect(activeLayer()).toBe("compensated");

    act(() => sample.setCompensation(false));
    expect(sample.dataRevision).toBe(2);
    expect(activeLayer()).toBe("original");
  });
});
