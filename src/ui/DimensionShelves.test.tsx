// @vitest-environment jsdom
// The Arrange dimensions shelves Illustration and the Plotting tab share: a chip moved by its
// placement menu from the keyboard, by a drop, and a fixed chip that does not move.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionShelves } from "./DimensionShelves";

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

function mount(onPlace: (chip: string, shelf: string) => void) {
  act(() =>
    root.render(
      <DimensionShelves
        dragType="text/test-dimension"
        shelves={[
          { id: "x", label: "Along x", chips: [{ id: "groups", label: "condition" }, { id: "stack", label: "Stack", fixed: true }] },
          { id: "columns", label: "Columns", chips: [{ id: "facet", label: "batch" }] },
          { id: "wrap", label: "Wrap", chips: [] },
        ]}
        places={[
          { value: "x", label: "Along x" },
          { value: "columns", label: "Columns" },
          { value: "wrap", label: "Wrap" },
        ]}
        canPlace={(chip, shelf) => !(chip === "facet" && shelf === "x")}
        onPlace={onPlace}
      />,
    ),
  );
}

describe("DimensionShelves", () => {
  it("moves a chip from the keyboard with its placement menu, offering only the shelves it may take", () => {
    const onPlace = vi.fn();
    mount(onPlace);
    const menu = host.querySelector<HTMLSelectElement>('select[aria-label="Place facet"]')!;
    // The menu is a control in the tab order, and names where the chip is.
    menu.focus();
    expect(document.activeElement).toBe(menu);
    expect(menu.value).toBe("columns");
    expect([...menu.options].map((o) => [o.value, o.disabled])).toEqual([["x", true], ["columns", false], ["wrap", false]]);
    act(() => {
      menu.value = "wrap";
      menu.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPlace).toHaveBeenCalledWith("facet", "wrap");
  });

  it("moves a dragged chip to the shelf it is dropped on, and never a fixed one", () => {
    const onPlace = vi.fn();
    mount(onPlace);
    const drop = (chip: string, shelf: string) => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      event.dataTransfer = { getData: (type: string) => (type === "text/test-dimension" ? chip : "") };
      act(() => host.querySelector(`[data-shelf="${shelf}"]`)!.dispatchEvent(event));
    };
    drop("groups", "wrap");
    expect(onPlace).toHaveBeenLastCalledWith("groups", "wrap");
    drop("stack", "wrap");
    drop("facet", "x");
    expect(onPlace).toHaveBeenCalledTimes(1);
    // The fixed chip has no menu and cannot be dragged.
    const fixed = [...host.querySelectorAll(".gl-figure-dimension")].find((chip) => chip.textContent === "Stack")!;
    expect(fixed.querySelector("select")).toBeNull();
    expect(fixed.getAttribute("draggable")).toBeNull();
  });
});
