// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreReducer, initialCoreState } from "../store";
import { FcsExportModal } from "./CrudModals";

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

describe("FCS export source scope", () => {
  it("names the blue file, recommends separate checked outputs, and blocks unsafe pooling", () => {
    const state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 5 });
    act(() => root.render(
      <FcsExportModal
        state={state}
        samples={[
          {
            id: "a",
            name: "donor-a.fcs",
            eventCount: 2,
            active: true,
            checked: true,
          },
          {
            id: "b",
            name: "donor-b.fcs",
            eventCount: 3,
            active: false,
            checked: true,
          },
        ]}
        combinedCompatibility={{
          compatible: false,
          reason: "donor-b.fcs has a different channel panel (missing CD3).",
        }}
        initialPopIds={[state.root_population_id!]}
        initialAssay="original"
        initialScope="split"
        onCancel={vi.fn()}
        onExport={vi.fn()}
      />,
    ));

    expect(host.textContent).toContain("Active file only — donor-a.fcs");
    expect(host.textContent).toContain("Checked files, kept separate — 2 FCS");
    expect(host.textContent).toContain("Recommended");
    expect(host.textContent).toContain("donor-b.fcs has a different channel panel");
    expect(host.querySelector<HTMLInputElement>('input[value="split"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[value="combined"]')?.disabled).toBe(true);
  });
});
