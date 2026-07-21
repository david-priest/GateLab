// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { CompensationGlobalPairPreview } from "../engine/compensationGlobalInspector";

const { renderSurfaceMock } = vi.hoisted(() => ({ renderSurfaceMock: vi.fn() }));

vi.mock("./compensationDensityPlot", () => ({
  renderCompensationDensityBiplotSurface: (
    host: HTMLElement,
    options: Readonly<{ title: string; pointAlpha: number }>,
  ) => {
    renderSurfaceMock(options);
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "toDataURL", {
      configurable: true,
      value: () => "data:image/png;base64,AA==",
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.textContent = options.title;
    svg.appendChild(title);
    host.append(canvas, svg);
  },
}));

import {
  compensationComparisonDownloadName,
  compensationComparisonFileBase,
  compensationComparisonPageCount,
  composeCompensationComparisonPageSvg,
  type CompensationComparisonExportPair,
} from "./compensationComparisonExport";

const preview: CompensationGlobalPairPreview = {
  eventCount: 3,
  totalEvents: 10,
  eventSignature: "3:fixed",
  xRange: [0, 4],
  yRange: [0, 5],
  xTicks: null,
  yTicks: null,
  original: { x: [0, 1, 2], y: [0, 2, 4], zeroPile: { source: 1, receiver: 1, corner: 1 } },
  compensated: { x: [0, 1, 2], y: [0, 1, 3], zeroPile: { source: 1, receiver: 1, corner: 1 } },
};

const pair: CompensationComparisonExportPair = {
  pairKey: "source\u001freceiver",
  sourceLabel: "156Gd_CXCR4",
  receiverLabel: "157Gd_Tbet",
  coefficient: 0.029,
  relationship: "M+1",
  buildPreview: () => preview,
};

describe("compensation comparison export", () => {
  it("plans six paired comparisons per A4 page", () => {
    expect(compensationComparisonPageCount(0)).toBe(0);
    expect(compensationComparisonPageCount(1)).toBe(1);
    expect(compensationComparisonPageCount(6)).toBe(1);
    expect(compensationComparisonPageCount(7)).toBe(2);
    expect(compensationComparisonPageCount(60)).toBe(10);
  });

  it("uses direct single-page names and zipped multipage image names", () => {
    expect(compensationComparisonFileBase("portal bio/test 3.fcs", "Live cells"))
      .toBe("gatelab-compensation-portal-bio-test-3-Live-cells");
    expect(compensationComparisonDownloadName("test.fcs", "All Events", "pdf", 3))
      .toBe("gatelab-compensation-test-All-Events.pdf");
    expect(compensationComparisonDownloadName("test.fcs", "All Events", "png", 1))
      .toBe("gatelab-compensation-test-All-Events.png");
    expect(compensationComparisonDownloadName("test.fcs", "All Events", "svg", 2))
      .toBe("gatelab-compensation-test-All-Events-svg-pages.zip");
  });

  it("composes clean paired Original and Compensated panels with scientific context", () => {
    renderSurfaceMock.mockClear();
    const page = composeCompensationComparisonPageSvg([pair], {
      sampleName: "portal.bio test 3.fcs",
      profileName: "WingLab spill matrix",
      populationName: "Live cells",
      filterLabel: "Flagged for follow-up",
      densitySmoothing: 6,
      densityColorPower: 1.6,
      pointAlpha: 0.7,
    }, 0, 2);

    expect(page.querySelectorAll("image")).toHaveLength(2);
    expect(page.textContent).toContain("GateLab compensation comparison");
    expect(page.textContent).toContain("156Gd_CXCR4 → 157Gd_Tbet");
    expect(page.textContent).toContain("matrix 2.9% · M+1");
    expect(page.textContent).toContain("Original");
    expect(page.textContent).toContain("Compensated");
    expect(page.textContent).toContain("Page 1 of 2");
    expect(page.textContent).toContain("same frozen events, axes, transform, density scale");
    expect(renderSurfaceMock).toHaveBeenCalledTimes(2);
    expect(renderSurfaceMock.mock.calls.every(([options]) => options.pointAlpha === 0.7)).toBe(true);
  });
});
