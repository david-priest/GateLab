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
    const rootPopulationId = state.root_population_id!;
    const onExport = vi.fn();
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
            populationEventCounts: { [rootPopulationId]: 2 },
          },
          {
            id: "b",
            name: "donor-b.fcs",
            eventCount: 3,
            active: false,
            checked: true,
            populationEventCounts: { [rootPopulationId]: 3 },
          },
        ]}
        combinedCompatibility={{
          compatible: false,
          reason: "donor-b.fcs has a different channel panel (missing CD3).",
        }}
        initialPopIds={[rootPopulationId]}
        initialAssay="original"
        initialScope="split"
        initialMinimumEvents={0}
        onCancel={vi.fn()}
        onExport={onExport}
      />,
    ));

    expect(host.textContent).toContain("Active file only — donor-a.fcs");
    expect(host.textContent).toContain("Checked files, kept separate — 2 FCS");
    expect(host.textContent).toContain("Recommended");
    expect(host.textContent).toContain("donor-b.fcs has a different channel panel");
    expect(host.querySelector<HTMLInputElement>('input[value="split"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[value="combined"]')?.disabled).toBe(true);
    expect(host.textContent).toContain("FCS outputs to write: 2");

    const threshold = host.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum events for each population and FCS combination"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        .call(threshold, "2");
      threshold.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("FCS outputs to write: 1");
    expect(host.textContent).toContain("skipped: 1 (≤ 2 events)");

    const review = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Review export")!;
    act(() => review.click());
    expect(host.textContent).toContain("Confirm separate FCS export");
    expect(host.textContent).toContain("donor-a.fcs");
    expect(host.textContent).toContain("Skip");
    expect(host.textContent).toContain("donor-b.fcs");
    expect(host.textContent).toContain("Write");

    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Export 1 FCS")!;
    act(() => confirm.click());
    expect(onExport).toHaveBeenCalledWith([rootPopulationId], "original", "split", 2);
  });
});
