// @vitest-environment jsdom
// Editing groups in the file list: drag files between groups, rename and reorder headers, the
// header's ⋯ and right-click menus, the colour picker. Synthetic files D1 to D4, groups Treated and
// Control; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SampleNavigator, type GroupAction, type SampleListItem } from "./SampleManager";
import type { MenuEntry } from "./MenuButton";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.removeItem("gatelab.fileList.foldedGroups");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const items: SampleListItem[] = [
  { id: "D1", name: "D1.fcs", eventCount: 100, channelCount: 2, group: "Treated", groupColour: "#7b3fa0" },
  { id: "D2", name: "D2.fcs", eventCount: 100, channelCount: 2, group: "Treated", groupColour: "#7b3fa0" },
  { id: "D3", name: "D3.fcs", eventCount: 100, channelCount: 2 },
  { id: "D4", name: "D4.fcs", eventCount: 100, channelCount: 2 },
];
const groups = [{ id: "g1", name: "Treated", colour: "#7b3fa0" }, { id: "g2", name: "Control", colour: "#e6820e" }];

function render(over: { excluded?: string[]; fileMenuOf?: (ids: readonly string[]) => MenuEntry[]; onSelectIds?: (ids: readonly string[]) => void } = {}) {
  const onGroupAction = vi.fn<(action: GroupAction) => void>();
  act(() => root.render(
    <SampleNavigator items={items} activeId="D1" excludedIds={new Set(over.excluded ?? ["D1", "D2", "D3", "D4"])} busy={false} importProgress={null}
      groups={groups} onGroupAction={onGroupAction} fileMenuOf={over.fileMenuOf} onSelectIds={over.onSelectIds}
      onOpenFiles={vi.fn()} onOpenFolder={vi.fn()} onManage={vi.fn()} onManageSample={vi.fn()}
      onActivate={vi.fn()} onToggleIncluded={vi.fn()} onIncludeAll={vi.fn()} onIncludeNone={vi.fn()} onInvertIncluded={vi.fn()} />,
  ));
  return onGroupAction;
}
const section = (name: string) => host.querySelector<HTMLElement>(`.gl-sample-group-section[aria-label="${name}"]`);
const row = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.querySelector(".gl-sample-name")?.textContent === name)!;
const fire = (el: Element, type: string, init: MouseEventInit = {}) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })); });

describe("editing groups in the file list", () => {
  it("shows an empty group's header, so files can be dragged into it", () => {
    render();
    expect([...host.querySelectorAll(".gl-sample-group-section")].map((s) => s.getAttribute("aria-label"))).toEqual(["Treated", "Control", "No group"]);
    expect(section("Control")!.querySelector(".gl-sample-group-head-count")!.textContent).toBe("0");
  });

  it("moves a dragged file into the group it is dropped on, and out to No group", () => {
    const onGroupAction = render();
    fire(row("D3.fcs"), "dragstart");
    fire(section("Control")!.querySelector(".gl-sample-group-head")!, "dragover");
    expect(section("Control")!.classList.contains("is-drop-target")).toBe(true);
    fire(section("Control")!.querySelector(".gl-sample-group-head")!, "drop");
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "assign", groupId: "g2", fileIds: ["D3"] });
    fire(row("D1.fcs"), "dragstart");
    fire(row("D4.fcs"), "dragover");
    fire(row("D4.fcs"), "drop");
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "remove", fileIds: ["D1"] });
  });

  it("drags the checked files together when the dragged row is one of them", () => {
    const onGroupAction = render({ excluded: ["D1"] });
    fire(row("D2.fcs"), "dragstart");
    fire(section("Control")!, "dragover");
    fire(section("Control")!, "drop");
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "assign", groupId: "g2", fileIds: ["D2", "D3", "D4"] });
  });

  it("shows an empty No group while files are dragged, as a place to drop them", () => {
    const one: SampleListItem[] = items.map((item) => ({ ...item, group: "Treated", groupColour: "#7b3fa0" }));
    const onGroupAction = vi.fn<(action: GroupAction) => void>();
    act(() => root.render(
      <SampleNavigator items={one} activeId="D1" excludedIds={new Set(["D1", "D2", "D3", "D4"])} busy={false} importProgress={null}
        groups={groups} onGroupAction={onGroupAction}
        onOpenFiles={vi.fn()} onOpenFolder={vi.fn()} onManage={vi.fn()} onManageSample={vi.fn()}
        onActivate={vi.fn()} onToggleIncluded={vi.fn()} onIncludeAll={vi.fn()} onIncludeNone={vi.fn()} onInvertIncluded={vi.fn()} />,
    ));
    expect(section("No group")).toBeNull();
    fire(row("D1.fcs"), "dragstart");
    expect(section("No group")).not.toBeNull();
    fire(section("No group")!, "dragover");
    fire(section("No group")!, "drop");
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "remove", fileIds: ["D1"] });
    expect(section("No group")).toBeNull();
  });

  it("reorders a dragged header before the one it is dropped on; No group takes no header", () => {
    const onGroupAction = render();
    fire(section("Control")!.querySelector(".gl-sample-group-headrow")!, "dragstart");
    fire(section("Treated")!, "dragover");
    fire(section("Treated")!, "drop");
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "reorder", ids: ["g2", "g1"] });
    onGroupAction.mockClear();
    fire(section("Treated")!.querySelector(".gl-sample-group-headrow")!, "dragstart");
    fire(section("No group")!, "dragover");
    fire(section("No group")!, "drop");
    expect(onGroupAction).not.toHaveBeenCalled();
  });

  it("renames a group in its header on double-click; Enter keeps it, Escape drops it", () => {
    const onGroupAction = render();
    fire(section("Treated")!.querySelector(".gl-sample-group-head")!, "dblclick");
    let input = section("Treated")!.querySelector<HTMLInputElement>(".gl-sample-group-name-input")!;
    expect(input.value).toBe("Treated");
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Treated B1"); });
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "rename", groupId: "g1", name: "Treated B1" });
    expect(host.querySelector(".gl-sample-group-name-input")).toBeNull();
    onGroupAction.mockClear();
    fire(section("Control")!.querySelector(".gl-sample-group-head")!, "dblclick");
    input = section("Control")!.querySelector<HTMLInputElement>(".gl-sample-group-name-input")!;
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.querySelector(".gl-sample-group-name-input")).toBeNull();
    expect(onGroupAction).not.toHaveBeenCalled();
  });

  it("offers the same header actions in its ⋯ menu and on right-click", () => {
    const onSelectIds = vi.fn();
    const onGroupAction = render({ onSelectIds });
    const labels = (root: Element) => [...root.querySelectorAll("[role^='menuitem'], [role='separator']")].map((el) => el.getAttribute("role") === "separator" ? "—" : el.textContent);
    const dots = section("Treated")!.querySelector(".gl-sample-group-menu")!;
    expect(labels(dots)).toEqual(["Rename…", "Colour…", "Collapse", "Select its files", "—", "Delete group…"]);
    fire(section("Treated")!.querySelector(".gl-sample-group-headrow")!, "contextmenu", { clientX: 20, clientY: 20 });
    expect(labels(document.querySelector(".gl-context-menu")!)).toEqual(["Rename…", "Colour…", "Collapse", "Select its files", "—", "Delete group…"]);
    act(() => document.querySelector<HTMLButtonElement>(".gl-context-menu .gl-group-menu-select")!.click());
    expect(onSelectIds).toHaveBeenCalledWith(["D1", "D2"]);
    act(() => dots.querySelector<HTMLButtonElement>(".gl-group-menu-delete")!.click());
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "delete", groupId: "g1" });
    act(() => dots.querySelector<HTMLButtonElement>(".gl-group-menu-fold")!.click());
    expect(section("Treated")!.querySelectorAll(".gl-sample-row")).toHaveLength(0);
    // No group: fold and select only.
    expect(labels(section("No group")!.querySelector(".gl-sample-group-menu")!)).toEqual(["Collapse", "Select its files"]);
  });

  it("picks a group's colour from the palette or any colour", () => {
    const onGroupAction = render();
    act(() => section("Control")!.querySelector<HTMLButtonElement>(".gl-group-menu-colour")!.click());
    const pop = section("Control")!.querySelector(".gl-group-colour-pop")!;
    expect(pop.querySelector(".gl-group-colour-swatch.is-current")?.getAttribute("aria-label")).toBe("#e6820e");
    act(() => pop.querySelector<HTMLButtonElement>('.gl-group-colour-swatch[aria-label="#1f9e89"]')!.click());
    expect(onGroupAction).toHaveBeenLastCalledWith({ kind: "colour", groupId: "g2", colour: "#1f9e89" });
    expect(section("Control")!.querySelector(".gl-group-colour-pop")).toBeNull();
  });

  it("asks the app for a file row's right-click menu: the checked files when the row is one of them, else the row", () => {
    const fileMenuOf = vi.fn((_ids: readonly string[]): MenuEntry[] => [{ label: "Add to Control", onClick: vi.fn() }]);
    render({ excluded: ["D1", "D2"], fileMenuOf });
    fire(row("D3.fcs"), "contextmenu", { clientX: 10, clientY: 10 });
    expect(fileMenuOf).toHaveBeenLastCalledWith(["D3", "D4"]);
    expect(document.querySelector(".gl-context-menu")?.textContent).toContain("Add to Control");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    fire(row("D1.fcs"), "contextmenu", { clientX: 10, clientY: 10 });
    expect(fileMenuOf).toHaveBeenLastCalledWith(["D1"]);
  });
});
