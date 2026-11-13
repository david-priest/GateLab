// @vitest-environment jsdom

// A Layout block and a figure's chart panel draw the legend as a key (2026-11-12): the Plotting
// tab's legend is a row of buttons that highlight what they name, which a sheet has no use for.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { ChartLegend } from "./ChartLegend";

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

const entries = [
  { index: 0, label: "control", color: "#111111" },
  { index: 1, label: "treated", color: "#222222" },
];

function draw(interactive: boolean) {
  const setHovered = vi.fn();
  const setPinned = vi.fn();
  act(() =>
    root.render(
      <I18nProvider>
        <ChartLegend entries={entries} title="condition" highlighted={null} pinned={null} setHovered={setHovered} setPinned={setPinned} hidden={false} ariaLabel="Groups" fontSize={11} columns={1} interactive={interactive} />
      </I18nProvider>,
    ),
  );
  return { setHovered, setPinned, items: [...host.querySelectorAll<HTMLElement>(".gl-prop-legend-item")] };
}

describe("ChartLegend", () => {
  it("is a row of buttons that highlight on the Plotting tab", () => {
    const { setPinned, items } = draw(true);
    expect(items.map((item) => item.tagName)).toEqual(["BUTTON", "BUTTON"]);
    act(() => items[1].click());
    expect(setPinned).toHaveBeenCalledTimes(1);
  });

  it("is a key alone when not interactive: the same title, swatches and labels, with nothing to press", () => {
    const { setHovered, setPinned, items } = draw(false);
    expect(items.map((item) => item.tagName)).toEqual(["SPAN", "SPAN"]);
    expect(items.map((item) => item.textContent)).toEqual(["control", "treated"]);
    expect(host.querySelector(".gl-prop-legend-title")?.textContent).toBe("condition");
    expect(host.querySelectorAll(".gl-prop-swatch")).toHaveLength(2);
    expect(host.querySelector("button, [aria-pressed], [title]")).toBeNull();
    act(() => {
      items[0].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      items[0].click();
    });
    expect(setHovered).not.toHaveBeenCalled();
    expect(setPinned).not.toHaveBeenCalled();
  });
});
