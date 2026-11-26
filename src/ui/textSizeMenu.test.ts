// @vitest-environment jsdom
// The right-click text size entries: which text a right-click landed on, read from markup shaped
// as mini_plot.js draws a panel, and one step larger or smaller on a tab's own sizes or on the
// workspace figure style. Synthetic labels throughout.

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FIGURE_STYLE } from "../engine/figureStyle";
import { LAYOUT_STYLE_RANGES } from "../engine/layout";
import type { MenuItem } from "./MenuButton";
import { pxFromPt } from "./figureStyle";
import { plotTextKind, steppedTextSize, textSizeMenuEntries } from "./textSizeMenu";

/** A panel as the renderer draws it: title on the svg, a plot group with axes, axis titles and a gate label. */
function panel(): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `
    <svg>
      <g transform="translate(40,20)">
        <g class="x-axis"><g class="tick"><text id="tick">20K</text></g></g>
        <g class="y-axis"><g class="tick"><text id="ytick">0</text></g></g>
        <text id="xtitle">CD4</text>
        <text id="ytitle" transform="rotate(-90)">CD8</text>
        <g class="gate-overlay-labels"><g><text id="gate"><tspan id="gate-name">CD4_positive</tspan><tspan>40.0%</tspan></text></g></g>
        <rect id="point"></rect>
      </g>
      <text id="title" style="font-weight:600">CD4_positive: 40.0%</text>
    </svg>`;
  document.body.appendChild(host);
  return host.querySelector("svg")!;
}

const t = (text: string, values?: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? "");
const items = (entries: ReturnType<typeof textSizeMenuEntries>) => entries.filter((e): e is MenuItem => typeof e === "object" && "onClick" in e);

describe("plotTextKind", () => {
  it("names each kind of text in a drawn panel, and nothing else", () => {
    const svg = panel();
    const at = (id: string) => plotTextKind(svg.querySelector(`#${id}`));
    expect([at("tick"), at("ytick"), at("xtitle"), at("ytitle"), at("gate"), at("gate-name"), at("title")]).toEqual([
      "fontTick", "fontTick", "fontAxis", "fontAxis", "fontGate", "fontGate", "fontTitle",
    ]);
    expect(at("point")).toBeNull();
    expect(plotTextKind(svg)).toBeNull();
    expect(plotTextKind(null)).toBeNull();
  });
});

describe("steppedTextSize", () => {
  it("steps a tab's own size by a pixel and the figure style by a point, within the range", () => {
    expect(steppedTextSize(12, 1, false, [6, 24])).toBe(13);
    expect(steppedTextSize(24, 1, false, [6, 24])).toBe(24);
    expect(steppedTextSize(pxFromPt(9), 1, true, [0, 100])).toBe(pxFromPt(10));
    expect(steppedTextSize(pxFromPt(9), -1, true, [0, 100])).toBe(pxFromPt(8));
  });
});

describe("textSizeMenuEntries", () => {
  const sizes = (onCommit = vi.fn()) => [{ key: "fontGate" as const, value: 12, min: 6, max: 24, onCommit }];

  it("on a tab's own sizes, steps the size of the text clicked and offers its field", () => {
    const onCommit = vi.fn();
    const onShowSizes = vi.fn();
    const entries = items(textSizeMenuEntries({ kind: "fontGate", sizes: sizes(onCommit), following: false, style: DEFAULT_FIGURE_STYLE, setStyle: vi.fn(), onShowSizes, t }));
    expect(entries.map((e) => e.label)).toEqual(["Larger gate label text", "Smaller gate label text", "Text sizes…"]);
    expect(entries[0].title).toBe("Now 12 px; one step larger, in this tab");
    entries[0].onClick();
    entries[1].onClick();
    expect(onCommit.mock.calls).toEqual([[13], [11]]);
    entries[2].onClick();
    expect(onShowSizes).toHaveBeenCalledWith("fontGate");
  });

  it("on the workspace figure style, steps the style by a point", () => {
    const setStyle = vi.fn();
    const onCommit = vi.fn();
    const entries = items(textSizeMenuEntries({ kind: "fontGate", sizes: sizes(onCommit), following: true, style: DEFAULT_FIGURE_STYLE, setStyle, onShowSizes: vi.fn(), t }));
    entries[0].onClick();
    expect(onCommit).not.toHaveBeenCalled();
    expect(setStyle).toHaveBeenCalledWith({ ...DEFAULT_FIGURE_STYLE, fontGate: steppedTextSize(DEFAULT_FIGURE_STYLE.fontGate, 1, true, LAYOUT_STYLE_RANGES.fontGate) });
    expect(entries[0].title).toContain("in every tab that uses the workspace figure style");
  });

  it("disables a step past the range", () => {
    const entries = items(textSizeMenuEntries({ kind: "fontGate", sizes: [{ key: "fontGate", value: 24, min: 6, max: 24, onCommit: vi.fn() }], following: false, style: DEFAULT_FIGURE_STYLE, setStyle: vi.fn(), onShowSizes: vi.fn(), t }));
    expect(entries.map((e) => !!e.disabled)).toEqual([true, false, false]);
  });

  it("offers only the sizes where nothing the tab sizes was clicked", () => {
    const onShowSizes = vi.fn();
    const none = items(textSizeMenuEntries({ kind: null, sizes: sizes(), following: false, style: DEFAULT_FIGURE_STYLE, setStyle: vi.fn(), onShowSizes, t }));
    expect(none.map((e) => e.label)).toEqual(["Text sizes…"]);
    none[0].onClick();
    expect(onShowSizes).toHaveBeenCalledWith(null);
    // A legend, which this tab does not size, likewise.
    expect(items(textSizeMenuEntries({ kind: "fontLegend", sizes: sizes(), following: false, style: DEFAULT_FIGURE_STYLE, setStyle: vi.fn(), onShowSizes, t })).map((e) => e.label)).toEqual(["Text sizes…"]);
  });
});
