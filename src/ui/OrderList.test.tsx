// @vitest-environment jsdom
// The reorderable list: choosing rows, stepping and moving the choice, and sorting.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderList, moveChosenTo, stepChosen } from "./OrderList";

const id = (s: string) => s;

describe("order helpers", () => {
  it("moves the chosen items, in their order, to sit before the item at the index", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(moveChosenTo(items, new Set(["b", "d"]), id, 0)).toEqual(["b", "d", "a", "c", "e"]);
    expect(moveChosenTo(items, new Set(["a", "b"]), id, 5)).toEqual(["c", "d", "e", "a", "b"]);
    expect(moveChosenTo(items, new Set(["e"]), id, 1)).toEqual(["a", "e", "b", "c", "d"]);
    // Dropped inside the choice, the choice closes up around the point.
    expect(moveChosenTo(items, new Set(["b", "d"]), id, 3)).toEqual(["a", "c", "b", "d", "e"]);
    expect(moveChosenTo(items, new Set(), id, 2)).toEqual(items);
  });

  it("steps the chosen items one place, a run moving as one and stopping at the ends", () => {
    const items = ["a", "b", "c", "d"];
    expect(stepChosen(items, new Set(["b", "c"]), id, -1)).toEqual(["b", "c", "a", "d"]);
    expect(stepChosen(items, new Set(["b", "c"]), id, 1)).toEqual(["a", "d", "b", "c"]);
    expect(stepChosen(items, new Set(["a"]), id, -1)).toEqual(items);
    expect(stepChosen(items, new Set(["d"]), id, 1)).toEqual(items);
    expect(stepChosen(items, new Set(["a", "c"]), id, 1)).toEqual(["b", "a", "d", "c"]);
  });
});

describe("OrderList", () => {
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

  it("chooses rows with click, Cmd and Shift, and steps or sorts the choice", () => {
    const onReorder = vi.fn();
    const items = ["Naive", "Memory", "Plasma", "Germinal centre"];
    act(() =>
      root.render(
        <OrderList
          items={items}
          keyOf={id}
          labelOf={id}
          onReorder={onReorder}
          label="Population order"
          sorts={[{ label: "A→Z", apply: (list) => [...list].sort((a, b) => a.localeCompare(b)) }]}
        />,
      ),
    );
    const rows = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    const click = (row: HTMLElement, init: MouseEventInit = {}) => act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init })));
    click(rows()[1]);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    click(rows()[3], { metaKey: true });
    expect(host.textContent).toContain("2 chosen");
    click(rows()[2], { shiftKey: true });
    // Shift takes the range from the last click without Shift (row 3) to row 2, replacing the choice.
    expect(rows().map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "true"]);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Move the chosen population order earlier"]')!.click());
    expect(onReorder).toHaveBeenLastCalledWith(["Naive", "Plasma", "Germinal centre", "Memory"]);
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "A→Z")!.click());
    expect(onReorder).toHaveBeenLastCalledWith(["Germinal centre", "Memory", "Naive", "Plasma"]);
    // A plain click on the only chosen row lets it go.
    click(rows()[1]);
    click(rows()[1]);
    expect(host.textContent).toContain("Click to choose");
  });
});
