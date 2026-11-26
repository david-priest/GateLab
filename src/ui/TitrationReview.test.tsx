// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { TitrationSeries } from "../compensationControls/titration";
import { TitrationReview } from "./TitrationReview";

it("draws unequal dilution steps on a quantitative axis and keeps every replicate selectable", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    const files = ["D1", "D2", "D3", "D4"].map((id, i) => ({
      id, name: id, detectors: [{ id: "FL1-A", label: "FL1", range: 1024 }], populations: [],
      values: () => [1, 2, 3, 80 + i, 90 + i, 100 + i], mask: () => null,
    }));
    const series: TitrationSeries = {
      id: "S1", clone: "C1", lot: "L1", conjugate: "FL1", detector: "FL1-A", unit: "", chosenDose: null, note: "",
      tubes: files.map((file, i) => ({ fileId: file.id, dose: ["1:100", "1:50", "1:10", "1:50"][i],
        replicate: i === 3 ? "B" : "A", populationId: null, negativeLower: null, negativeUpper: 20, positiveLower: 20, positiveUpper: null })),
    };
    act(() => root.render(<TitrationReview files={files} series={[series]} onClose={vi.fn()} onSave={vi.fn()} />));
    const point = (file: string) => host.querySelector<SVGGElement>(`.tit-plot g[aria-label^="${file},"]`)!;
    const x = (file: string) => Number(point(file).querySelector("circle")!.getAttribute("cx"));
    expect(host.querySelectorAll(".tit-plot g[role=button]")).toHaveLength(4);
    expect(x("D2")).toBe(x("D4"));
    expect((x("D2") - x("D1")) / (x("D3") - x("D1"))).toBeCloseTo(Math.log10(2), 6);
    act(() => point("D4").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(host.querySelector(".tit-inspector h3")!.textContent).toBe("D4");
    const unit = [...host.querySelectorAll("label")].find((l) => l.textContent === "Dose unit")!.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(unit, "µg/mL");
      unit.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".tit-plot")).toBeNull();
    expect(host.textContent).toContain("convert all doses to the same concentration unit");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
