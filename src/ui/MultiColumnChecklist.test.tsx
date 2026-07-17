// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MultiColumnChecklist } from "./MultiColumnChecklist";

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

describe("MultiColumnChecklist", () => {
  it("fills hierarchy columns from the left and keeps checkbox interactions", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `pop-${index + 1}`,
      label: `Population ${index + 1}`,
      depth: index === 0 ? 0 : 1,
    }));
    const onToggle = vi.fn();

    act(() => root.render(
      <MultiColumnChecklist
        items={items}
        ariaLabel="Test populations"
        selected={({ id }) => id === "pop-2"}
        onToggle={onToggle}
        getKey={({ id }) => id}
        getLabel={({ label }) => label}
        getDepth={({ depth }) => depth}
        distribution="fill-first"
        visibleRows={5}
      />,
    ));

    const columns = [...host.querySelectorAll<HTMLElement>(".gl-multi-picker-column")];
    expect(columns).toHaveLength(4);
    expect(columns.map((column) => column.querySelectorAll("label").length)).toEqual([5, 5, 0, 0]);
    expect(columns[0].textContent).toContain("Population 1");
    expect(columns[0].textContent).toContain("Population 5");
    expect(columns[1].textContent).toContain("Population 6");
    expect(columns[1].textContent).toContain("Population 10");

    const secondCheckbox = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    expect(secondCheckbox.checked).toBe(true);
    act(() => secondCheckbox.click());
    expect(onToggle).toHaveBeenCalledWith(items[1]);
  });
});
