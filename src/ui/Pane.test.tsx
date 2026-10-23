// @vitest-environment jsdom
// A side-panel pane: its header (title, summary, actions, ⋯ menu) and a fold kept per viewer.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pane, usePaneCollapsed } from "./Pane";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem("gatelab.pane.gates.collapsed");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Folding() {
  const [collapsed, setCollapsed] = usePaneCollapsed("gates");
  return (
    <Pane id="gates" title="Gates" summary="3 gates" collapsed={collapsed} onToggleCollapsed={() => setCollapsed((was) => !was)}
      actions={<button type="button" className="probe-action">+</button>}
      menu={[{ label: "Sort A→Z", className: "probe-sort", onClick: vi.fn() }]}>
      <div className="probe-body">rows</div>
    </Pane>
  );
}

describe("Pane", () => {
  it("puts the title, summary, actions and ⋯ menu in one header row", () => {
    act(() => root.render(<Folding />));
    const pane = host.querySelector<HTMLElement>(".gl-pane.gl-pane-gates")!;
    expect(pane.getAttribute("aria-label")).toBe("Gates");
    const head = pane.querySelector(".gl-side-head")!;
    expect(head.querySelector(".gl-side-title")!.textContent).toBe("Gates");
    expect(head.querySelector(".gl-pane-summary")!.textContent).toBe("3 gates");
    expect(head.querySelector(".gl-pane-actions .probe-action")).not.toBeNull();
    const trigger = head.querySelector<HTMLButtonElement>(".gl-pane-menu-gates .gl-menu-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("Gates actions");
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  it("folds its body away and remembers the fold for the viewer", () => {
    act(() => root.render(<Folding />));
    const disclosure = () => host.querySelector<HTMLButtonElement>(".gl-side-disclosure")!;
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
    act(() => disclosure().click());
    expect(host.querySelector(".probe-body")).toBeNull();
    expect(localStorage.getItem("gatelab.pane.gates.collapsed")).toBe("1");
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Folding />));
    expect(host.querySelector(".probe-body")).toBeNull();
    expect(disclosure().getAttribute("aria-expanded")).toBe("false");
  });

  it("shows no ⋯ for an empty menu, and no fold without a handler", () => {
    act(() => root.render(<Pane id="populations" title="Populations" menu={[]}><div className="probe-body" /></Pane>));
    expect(host.querySelector(".gl-pane-menu")).toBeNull();
    expect(host.querySelector(".gl-side-disclosure")).toBeNull();
    expect(host.querySelector(".probe-body")).not.toBeNull();
  });

  it("turns its chevron with the fold every time, the first close after mounting included", () => {
    act(() => root.render(<Folding />));
    const disclosure = () => host.querySelector<HTMLButtonElement>(".gl-side-disclosure")!;
    const chevron = () => disclosure().querySelector(".gl-icon-chevron")!;
    // Open, then closed as the very first interaction, then back and forth.
    expect(chevron().classList.contains("is-open")).toBe(true);
    for (const expanded of [false, true, false, true, false]) {
      act(() => disclosure().click());
      expect(disclosure().getAttribute("aria-expanded")).toBe(String(expanded));
      expect(chevron().classList.contains("is-open")).toBe(expanded);
    }
  });
});

