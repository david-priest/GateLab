// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MenuButton } from "./MenuButton";
import { setKeyPlatform } from "./platformKeys";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MenuButton", () => {
  it("keeps its actions in the DOM while closed, opens on click, runs an action and closes", () => {
    const open = vi.fn();
    act(() => root.render(
      <MenuButton label="Workspace" items={[
        { label: "Open Workspace…", onClick: open },
        "separator",
        { label: "Save As…", onClick: vi.fn(), disabled: true },
      ]} />,
    ));
    const trigger = host.querySelector<HTMLButtonElement>(".gl-menu-trigger")!;
    const popover = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(popover.hidden).toBe(true);
    // Reachable by label even while closed, as the sidebar buttons were.
    const item = [...host.querySelectorAll("button")].find((b) => b.textContent === "Open Workspace…")!;
    expect(item).toBeDefined();
    act(() => trigger.click());
    expect(popover.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="separator"]')).not.toBeNull();
    expect([...host.querySelectorAll("button")].find((b) => b.textContent === "Save As…")!.disabled).toBe(true);
    act(() => item.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(popover.hidden).toBe(true);
  });

  it("closes on Escape and on a click outside", () => {
    act(() => root.render(<MenuButton label="Import" items={[{ label: "Import…", onClick: vi.fn() }]} />));
    const trigger = host.querySelector<HTMLButtonElement>(".gl-menu-trigger")!;
    const popover = host.querySelector<HTMLElement>('[role="menu"]')!;
    act(() => trigger.click());
    expect(popover.hidden).toBe(false);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(popover.hidden).toBe(true);
    act(() => trigger.click());
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(popover.hidden).toBe(true);
  });

  it("is inert when disabled", () => {
    act(() => root.render(<MenuButton label="Export" disabled items={[{ label: "Export FCS…", onClick: vi.fn() }]} />));
    const trigger = host.querySelector<HTMLButtonElement>(".gl-menu-trigger")!;
    expect(trigger.disabled).toBe(true);
  });

  it("draws sections, a shared tick column, right-aligned shortcuts and red destructive items", () => {
    setKeyPlatform("other");
    act(() => root.render(
      <MenuButton label="Workspace" items={[
        { section: "Files" },
        { label: "Save", shortcut: "⌘S", onClick: vi.fn() },
        { label: "Align gates", checked: true, onClick: vi.fn() },
        "separator",
        { label: "Clear…", danger: true, onClick: vi.fn() },
      ]} />,
    ));
    setKeyPlatform(null);
    const section = host.querySelector(".gl-menu-section")!;
    expect(section.textContent).toBe("Files");
    expect(section.getAttribute("role")).toBe("presentation");
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Save", "Align gates", "Clear…"]);
    // Every item keeps the tick column once one item has a tick, so the labels line up.
    expect(items.every((item) => item.querySelector(".gl-menu-check"))).toBe(true);
    expect(items[1].getAttribute("role")).toBe("menuitemcheckbox");
    expect(items[1].querySelector(".gl-menu-check svg")).not.toBeNull();
    expect(items[0].querySelector(".gl-menu-check svg")).toBeNull();
    expect(items[0].querySelector(".gl-menu-shortcut")!.getAttribute("data-shortcut")).toBe("Ctrl+S");
    expect(items[0].getAttribute("aria-keyshortcuts")).toBe("Control+S");
    expect(items[2].classList.contains("is-danger")).toBe(true);
    expect(items[0].classList.contains("is-danger")).toBe(false);
  });

  it("places its open list against the window: below, above when there is no room, inside the window", () => {
    const rect = (top: number, left: number, width: number, height: number) =>
      ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const place = (triggerTop: number, triggerLeft: number) => {
      act(() => root.render(<MenuButton label="Row" className="gate-row-menu" items={[{ label: "Delete…", danger: true, onClick: vi.fn() }]} />));
      const trigger = host.querySelector<HTMLButtonElement>(".gl-menu-trigger")!;
      const list = host.querySelector<HTMLElement>(".gate-row-menu [role='menu']")!;
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(triggerTop, triggerLeft, 30, 24));
      vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 150));
      act(() => trigger.click());
      const style = { top: parseFloat(list.style.top), left: parseFloat(list.style.left), position: list.style.position };
      act(() => trigger.click());
      return style;
    };
    // jsdom's window is 1024 × 768.
    expect(place(100, 50)).toEqual({ top: 128, left: 50, position: "fixed" }); // below
    expect(place(700, 50)).toEqual({ top: 546, left: 50, position: "fixed" }); // above: 700 − 4 − 150
    expect(place(100, 1000).left).toBe(816); // kept inside the window: 1024 − 8 − 200
  });

  it("closes on a scroll outside its list", () => {
    act(() => root.render(<MenuButton label="Row" items={[{ label: "Rename…", onClick: vi.fn() }]} />));
    const trigger = host.querySelector<HTMLButtonElement>(".gl-menu-trigger")!;
    act(() => trigger.click());
    expect(host.querySelector<HTMLElement>("[role='menu']")!.hidden).toBe(false);
    act(() => { document.body.dispatchEvent(new Event("scroll")); });
    expect(host.querySelector<HTMLElement>("[role='menu']")!.hidden).toBe(true);
  });
});

