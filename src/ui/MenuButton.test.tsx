// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MenuButton } from "./MenuButton";

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
});
