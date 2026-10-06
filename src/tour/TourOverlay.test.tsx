// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setKeyPlatform } from "../ui/platformKeys";
import { resolveTourTarget, TourOverlay } from "./TourOverlay";
import { TOUR_STEPS } from "./tourScript";
import type { TourContext } from "./tourTypes";

let host: HTMLDivElement;
let root: Root;
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
  setKeyPlatform(null);
});

const ctx: TourContext = {
  host: "browser", activeTab: "gating", workspaceName: "", files: [], pooled: false, rootId: null, populations: {}, gates: {},
  activePopulationId: null, selectedGateId: null, axes: { x: null, y: null, xScale: null, yScale: null, xLinearOffered: false, yLinearOffered: false, rangeKey: "[]" }, displayMode: "pseudocolor", maxEvents: 50000,
  strategy: null, illustration: null, layout: { items: 0, sheets: 1, allEvents: false }, proportions: { populations: 0 },
  metadataColumns: [], divisionProfiles: 0, assayLayer: "original", compensation: { pairSelected: false, view: "matrix", galleryLayer: "compensated", matrixKey: "[]" },
  scales: { adjusted: [], fitted: [], locked: false },
  signals: { layoutExports: 0, statsDownloads: 0, workspaceSaves: 0 },
};

describe("resolveTourTarget", () => {
  it("takes the first visible match, by text and index, and the first spec that has one", () => {
    const page = document.createElement("div");
    page.innerHTML = `<button class="a">Open</button><button class="a">Save</button><button class="b">Save As</button>`;
    document.body.appendChild(page);
    const visible = (el: Element, on: boolean) => {
      (el as HTMLElement).getBoundingClientRect = () => ({ x: 0, y: 0, width: on ? 10 : 0, height: on ? 10 : 0, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) } as DOMRect);
    };
    const [open, save, saveAs] = [...page.querySelectorAll("button")];
    visible(open, true); visible(save, true); visible(saveAs, true);
    expect(resolveTourTarget("button.a", page)).toBe(open);
    expect(resolveTourTarget({ selector: "button", text: "Save", exact: true }, page)).toBe(save);
    expect(resolveTourTarget({ selector: "button", text: "Save" }, page)).toBe(save);
    expect(resolveTourTarget({ selector: "button", text: "Save", index: 1 }, page)).toBe(saveAs);
    visible(open, false);
    expect(resolveTourTarget(["button.a", "button.b"], page)).toBe(save);
    expect(resolveTourTarget(["button.none", "button.b"], page)).toBe(saveAs);
    expect(resolveTourTarget("button.none", page)).toBeNull();
    expect(resolveTourTarget(null, page)).toBeNull();
    page.remove();
  });

  it("with largest, takes the match showing the largest number: the cell with the most spill, never the diagonal", () => {
    const page = document.createElement("div");
    // A 3 x 3 matrix as the Compensation tab draws it: 100 on the diagonal, blank where nothing spills.
    page.innerHTML = `
      <button class="cell diagonal">100.0</button><button class="cell">0.5</button><button class="cell"></button>
      <button class="cell">7.9</button><button class="cell diagonal">100.0</button><button class="cell">51.3</button>
      <button class="cell">2.9</button><button class="cell">12.5</button><button class="cell diagonal">100.0</button>
      <input class="field" value="3.5" /><input class="field" value="40" /><input class="field" value="" />`;
    document.body.appendChild(page);
    for (const el of page.querySelectorAll("button, input")) {
      (el as HTMLElement).getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) } as DOMRect);
    }
    const cells = [...page.querySelectorAll("button")];
    // The first match is the diagonal's 100: what the step pointed at before.
    expect(resolveTourTarget(".cell", page)).toBe(cells[0]);
    expect(resolveTourTarget(".cell:not(.diagonal)", page)).toBe(cells[1]);
    expect(resolveTourTarget({ selector: ".cell:not(.diagonal)", largest: true }, page)).toBe(cells[5]);
    expect(resolveTourTarget({ selector: ".cell:not(.diagonal)", largest: true }, page)!.textContent).toBe("51.3");
    // An editable matrix holds its numbers in inputs.
    expect((resolveTourTarget({ selector: ".field", largest: true }, page) as HTMLInputElement).value).toBe("40");
    // Nothing numeric to compare: the first match, as without it.
    for (const cell of cells) cell.textContent = "";
    expect(resolveTourTarget({ selector: ".cell:not(.diagonal)", largest: true }, page)).toBe(cells[1]);
    expect(resolveTourTarget({ selector: ".none", largest: true }, page)).toBeNull();
    page.remove();
  });
});

describe("TourOverlay", () => {
  it("shows the step's words and place, waits on a watched step, and calls back from its buttons", () => {
    const onNext = vi.fn(), onBack = vi.fn(), onEnd = vi.fn();
    const welcome = TOUR_STEPS[0];
    act(() => root.render(<TourOverlay step={welcome} index={0} total={TOUR_STEPS.length} reached={false} ctx={ctx} onNext={onNext} onBack={onBack} onEnd={onEnd} />));
    expect(host.textContent).toContain("A walk through GateLab");
    expect(host.textContent).toContain(`Step 1 of ${TOUR_STEPS.length}`);
    expect(host.textContent).toContain("Tutorial · Welcome");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((b) => b.textContent === "Back")!.disabled).toBe(true);
    act(() => buttons.find((b) => b.textContent === "Next")!.click());
    expect(onNext).toHaveBeenCalledTimes(1);
    act(() => buttons.find((b) => b.textContent === "End tutorial")!.click());
    expect(onEnd).toHaveBeenCalledTimes(1);

    const open = TOUR_STEPS[1];
    act(() => root.render(<TourOverlay step={open} index={1} total={TOUR_STEPS.length} reached={false} ctx={ctx} onNext={onNext} onBack={onBack} onEnd={onEnd} />));
    expect(host.textContent).toContain("Open the demo workspace");
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Waiting for you to do this…");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Skip")).toBe(true);
    act(() => root.render(<TourOverlay step={open} index={1} total={TOUR_STEPS.length} reached={true} ctx={ctx} onNext={onNext} onBack={onBack} onEnd={onEnd} />));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Done");
  });
});

describe("TourOverlay, the marker and the place", () => {
  const stepOf = (id: string) => TOUR_STEPS.find((candidate) => candidate.id === id)!;
  const at = (id: string) => TOUR_STEPS.findIndex((candidate) => candidate.id === id);
  // The demo open on the Gating tab, as the tutorial sees it.
  const open: TourContext = {
    ...ctx,
    files: [{ id: "D1", name: "D1.fcs", checked: true, viewed: true }],
    rootId: "root",
    populations: {
      root: { id: "root", name: "All Events", parentId: null, children: ["cells"], gateCount: 0, gateIds: [] },
      cells: { id: "cells", name: "Cells", parentId: "root", children: [], gateCount: 1, gateIds: ["g1"] },
    },
  };
  const noop = () => {};
  /** A control on the page for a step to mark, with a box. */
  function control(html: string): HTMLElement {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const el = holder.firstElementChild as HTMLElement;
    el.getBoundingClientRect = () => ({ x: 100, y: 40, width: 80, height: 24, top: 40, left: 100, right: 180, bottom: 64, toJSON: () => ({}) } as DOMRect);
    document.body.appendChild(el);
    return el;
  }

  it("marks the element with a band and dims nothing", () => {
    const tabButton = control(`<button data-tour="tab-strategy">Strategy</button>`);
    const step = stepOf("tab-strategy");
    act(() => root.render(<TourOverlay step={step} index={at("tab-strategy")} total={TOUR_STEPS.length} reached={false} ctx={open} onNext={noop} onBack={noop} onEnd={noop} />));
    // No shade over the app: the old overlay drew one with a hole.
    expect(host.querySelector(".gl-tour-shade")).toBeNull();
    expect(host.querySelector("svg mask")).toBeNull();
    const ring = host.querySelector<HTMLElement>(".gl-tour-ring")!;
    expect(ring).not.toBeNull();
    expect(ring.querySelector(".gl-tour-band")).not.toBeNull();
    expect(ring.querySelector(".gl-tour-ripple")).not.toBeNull();
    // Around the control, six pixels out.
    expect(ring.style.left).toBe("94px");
    expect(ring.style.top).toBe("34px");
    expect(ring.style.width).toBe("92px");
    // A step with a pointer has no runner; the card shows how far through the tutorial is.
    expect(host.querySelector(".gl-tour-runner")).toBeNull();
    const bar = host.querySelector<HTMLElement>(".gl-tour-progress > span")!;
    expect(parseFloat(bar.style.width)).toBeCloseTo(((at("tab-strategy") + 1) / TOUR_STEPS.length) * 100, 3);
    // Done: the band turns, and the ripple stops.
    act(() => root.render(<TourOverlay step={step} index={at("tab-strategy")} total={TOUR_STEPS.length} reached={true} ctx={open} onNext={noop} onBack={noop} onEnd={noop} />));
    expect(host.querySelector(".gl-tour-ring")!.className).toContain("is-reached");
    expect(host.querySelector(".gl-tour-ripple")).toBeNull();
    tabButton.remove();
  });

  it("drops the marker when the next step has nothing to mark", () => {
    const menu = control(`<div class="gl-tour-workspace-menu"><button>Workspace</button></div>`);
    (menu.querySelector("button") as HTMLElement).getBoundingClientRect = menu.getBoundingClientRect;
    const props = { total: TOUR_STEPS.length, reached: false, ctx: open, onNext: noop, onBack: noop, onEnd: noop };
    act(() => root.render(<TourOverlay step={stepOf("save-workspace")} index={at("save-workspace")} {...props} />));
    expect(host.querySelector(".gl-tour-ring")).not.toBeNull();
    // "That is the tour" marks nothing: the Workspace menu's mark must not stay.
    act(() => root.render(<TourOverlay step={stepOf("finish")} index={at("finish")} {...props} />));
    expect(host.querySelector(".gl-tour-ring")).toBeNull();
    menu.remove();
  });

  it("keeps the marker inside the window around a panel that runs to its edge", () => {
    const panel = control(`<div class="gl-tab-panel">The panel</div>`);
    // From near the top to the very bottom of the window, and off its right side.
    panel.getBoundingClientRect = () => ({ x: 300, y: 70, width: window.innerWidth, height: window.innerHeight - 70, top: 70, left: 300, right: 300 + window.innerWidth, bottom: window.innerHeight, toJSON: () => ({}) } as DOMRect);
    const step = stepOf("panel-info");
    act(() => root.render(<TourOverlay step={step} index={at("panel-info")} total={TOUR_STEPS.length} reached={false} ctx={{ ...open, activeTab: "panel" }} onNext={noop} onBack={noop} onEnd={noop} />));
    const ring = host.querySelector<HTMLElement>(".gl-tour-ring")!;
    expect(ring.style.left).toBe("294px");
    expect(ring.style.top).toBe("64px");
    expect(parseFloat(ring.style.left) + parseFloat(ring.style.width)).toBe(window.innerWidth - 3);
    expect(parseFloat(ring.style.top) + parseFloat(ring.style.height)).toBe(window.innerHeight - 3);
    panel.remove();
  });

  it("runs a dot from the card to a look-only step's marker", () => {
    const table = control(`<table class="gl-scales-table"><tbody><tr><td>FSC-A</td></tr></tbody></table>`);
    const step = stepOf("scales-info");
    act(() => root.render(<TourOverlay step={step} index={at("scales-info")} total={TOUR_STEPS.length} reached={false} ctx={{ ...open, activeTab: "scales" }} onNext={noop} onBack={noop} onEnd={noop} />));
    const runner = host.querySelector<HTMLElement>(".gl-tour-runner")!;
    expect(runner).not.toBeNull();
    // It ends at the middle of the table.
    expect(runner.style.getPropertyValue("--tx")).toBe("140px");
    expect(runner.style.getPropertyValue("--ty")).toBe("52px");
    expect(host.querySelector(".gl-tour-ring")!.className).toContain("is-late");
    table.remove();
  });

  it("says where a step happens when the app is elsewhere, and offers to go there", () => {
    const onArrive = vi.fn();
    const step = stepOf("strategy-full-path");
    const render = (extra: Partial<Parameters<typeof TourOverlay>[0]>) =>
      act(() => root.render(<TourOverlay step={step} index={at("strategy-full-path")} total={TOUR_STEPS.length} reached={false} ctx={open} tabLabels={{ strategy: "Strategy" }} onNext={noop} onBack={noop} onEnd={noop} onArrive={onArrive} {...extra} />));
    // On the Gating tab, for a step on the Strategy tab.
    render({});
    const place = host.querySelector(".gl-tour-place")!;
    expect(place.textContent).toContain("This step is on the Strategy tab.");
    const go = [...place.querySelectorAll("button")].find((b) => b.textContent === "Take me there")!;
    act(() => go.click());
    expect(onArrive).toHaveBeenCalledTimes(1);
    // The waiting line gives way to the place.
    expect(host.querySelector('[role="status"]')!.textContent).toBe("");
    // On its way there, and once there: no offer.
    render({ arriving: true });
    expect(host.querySelector(".gl-tour-place")).toBeNull();
    render({ ctx: { ...open, activeTab: "strategy" } });
    expect(host.querySelector(".gl-tour-place")).toBeNull();
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Waiting for you to do this…");
    // With nothing open, the offer is the demo.
    render({ ctx });
    expect(host.querySelector(".gl-tour-place")!.textContent).toContain("This step needs a workspace open.");
    expect(host.querySelector(".gl-tour-place button")!.textContent).toBe("Open the demo workspace");
  });

  it("shows a step gone back to as done already, with Next rather than Skip", () => {
    const step = stepOf("tab-strategy");
    act(() => root.render(<TourOverlay step={step} index={at("tab-strategy")} total={TOUR_STEPS.length} reached={false} held={true} ctx={{ ...open, activeTab: "strategy" }} onNext={noop} onBack={noop} onEnd={noop} />));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Already done");
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Next");
    expect(labels).not.toContain("Skip");
  });

  it("names the keys of the reader's own keyboard", () => {
    const undo = stepOf("undo-vertex");
    const move = stepOf("move-population");
    const tree: TourContext = {
      ...open,
      populations: {
        root: { id: "root", name: "All Events", parentId: null, children: ["cells"], gateCount: 0, gateIds: [] },
        cells: { id: "cells", name: "Cells", parentId: "root", children: ["singlets", "debris"], gateCount: 1, gateIds: ["g1"] },
        singlets: { id: "singlets", name: "Singlets", parentId: "cells", children: ["bcells"], gateCount: 1, gateIds: ["g2"] },
        debris: { id: "debris", name: "Debris", parentId: "cells", children: [], gateCount: 1, gateIds: ["g-debris"] },
        bcells: { id: "bcells", name: "B cells", parentId: "singlets", children: [], gateCount: 1, gateIds: ["g-b-cells"] },
      },
    };
    const show = (step: typeof undo, context: TourContext) =>
      act(() => root.render(<TourOverlay step={step} index={at(step.id)} total={TOUR_STEPS.length} reached={false} ctx={context} onNext={noop} onBack={noop} onEnd={noop} />));
    setKeyPlatform("mac");
    show(undo, open);
    expect(host.textContent).toContain("Press Undo (⌘Z, or the arrow above the plot)");
    show(move, tree);
    expect(host.textContent).toContain("Option-drag copies it");
    setKeyPlatform("other");
    show(undo, open);
    expect(host.textContent).toContain("Press Undo (Ctrl+Z, or the arrow above the plot)");
    expect(host.textContent).not.toContain("⌘");
    show(move, tree);
    expect(host.textContent).toContain("Alt-drag copies it");
    expect(host.textContent).not.toContain("Option-drag");
  });
});
