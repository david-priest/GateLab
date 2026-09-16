// @vitest-environment jsdom
//
// The interaction is copied from the channel picker the plot's axis labels open
// (cytof_plot.js `_showChannelPicker`). These tests pin the parts of it a user's fingers know:
// type to filter, Enter takes the first match, ArrowDown moves into the list, Escape closes.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchableSelect, type SearchableOption } from "./SearchableSelect";

const OPTIONS: SearchableOption[] = [
  { value: "none", label: "None" },
  { value: "population", label: "Population" },
  { value: "channel:FSC-A", label: "FSC-A", group: "Channel" },
  { value: "channel:CD4", label: "CD4", group: "Channel" },
  { value: "channel:CD45RA", label: "CD45RA", group: "Channel" },
  { value: "coldata:condition", label: "condition (2)", group: "colData" },
];

let root: Root;
let host: HTMLDivElement;
let chosen: string[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chosen = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function render(value = "none"): void {
  act(() => root.render(
    <SearchableSelect
      label="Colour by"
      value={value}
      options={OPTIONS}
      onChange={(next) => chosen.push(next)}
    />,
  ));
}

const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!;
const panel = () => host.querySelector<HTMLElement>(".gl-searchable-select-panel");
const input = () => host.querySelector<HTMLInputElement>(".gl-searchable-select-panel input")!;
const list = () => host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select");
const shown = () => [...(list()?.querySelectorAll("option") ?? [])].map((o) => o.textContent);

function open(): void {
  act(() => trigger().click());
}

function type(text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(el: Element, k: string): void {
  act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
}

describe("SearchableSelect", () => {
  it("shows the current selection and opens a search field over the options", () => {
    render("channel:CD4");
    expect(trigger().textContent).toBe("CD4");
    expect(panel()).toBeNull();
    open();
    expect(input().placeholder).toBe("Type to search…");
    expect(shown()).toContain("CD4");
    expect(shown()).toContain("None");
  });

  it("filters case-insensitively on any part of the name", () => {
    render();
    open();
    type("cd4");
    expect(shown()).toEqual(["CD4", "CD45RA"]);
    type("45");
    expect(shown()).toEqual(["CD45RA"]);
  });

  it("filters on the group heading too, so a category reaches its members", () => {
    render();
    open();
    type("channel");
    expect(shown()).toEqual(["FSC-A", "CD4", "CD45RA"]);
  });

  it("takes the best match on Enter, not merely the first one listed", () => {
    render();
    open();
    type("cd4");
    key(input(), "Enter");
    expect(chosen).toEqual(["channel:CD4"]);
    expect(panel()).toBeNull();
  });

  it("chooses the row that is already highlighted when it is clicked", () => {
    // After typing, the best match is the list's value; a click on it fires no change on a
    // sized select, so the click must choose it, and only once.
    render();
    open();
    type("cd4");
    const rows = list()!;
    expect(rows.value).toBe("channel:CD4");
    act(() => { rows.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    act(() => { rows.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(chosen).toEqual(["channel:CD4"]);
    expect(panel()).toBeNull();
  });

  it("chooses another row once, though its click fires change and click", () => {
    render();
    open();
    const rows = list()!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(rows, "population");
      rows.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { rows.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(chosen).toEqual(["population"]);
  });

  it("prefers an exact name over a longer one that merely contains it", () => {
    // CD45RA is listed after CD4 but before CD4 would be if order alone decided; typing the whole
    // of a channel's name and getting a different channel is the papercut this avoids.
    render();
    open();
    type("cd45ra");
    expect(list()!.value).toBe("channel:CD45RA");

    type("cd4");
    // Both still SHOWN, in the panel's own order — only the highlight is ranked.
    expect(shown()).toEqual(["CD4", "CD45RA"]);
    expect(list()!.value).toBe("channel:CD4");
  });

  it("prefers a prefix over a match buried in the middle of a name", () => {
    render();
    open();
    type("4");
    expect(shown()).toEqual(["CD4", "CD45RA"]);
    // "CD4" and "CD45RA" both merely contain "4"; list order decides between equals.
    expect(list()!.value).toBe("channel:CD4");
  });

  it("opens on the current value when nothing has been typed", () => {
    render("channel:CD45RA");
    open();
    expect(list()!.value).toBe("channel:CD45RA");
  });

  it("moves into the list on ArrowDown", () => {
    render();
    open();
    key(input(), "ArrowDown");
    expect(document.activeElement).toBe(list());
  });

  it("closes on Escape without choosing anything, and returns focus to the trigger", () => {
    render();
    open();
    type("cd4");
    key(input(), "Escape");
    expect(panel()).toBeNull();
    expect(chosen).toEqual([]);
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside click", () => {
    render();
    open();
    act(() => { document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(panel()).toBeNull();
    expect(chosen).toEqual([]);
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    render();
    open();
    type("nothing here");
    expect(list()).toBeNull();
    expect(panel()!.textContent).toContain("No matches");
    // Enter on no match must not choose the last thing that did match.
    key(input(), "Enter");
    expect(chosen).toEqual([]);
  });

  it("clears the query between openings, so the list is never filtered by a forgotten search", () => {
    render();
    open();
    type("cd4");
    key(input(), "Escape");
    open();
    expect(input().value).toBe("");
    expect(shown()).toContain("None");
  });
});
