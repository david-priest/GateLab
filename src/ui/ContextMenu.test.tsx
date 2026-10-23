// @vitest-environment jsdom
// The context menu takes the keyboard while it is open and gives it back when it closes.

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, DISMISS_MENUS_EVENT, type ContextMenuState } from "./ContextMenu";

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

function Harness({ onChoice }: { onChoice: () => void }) {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  return (
    <>
      <div tabIndex={0} data-testid="page" onContextMenu={(event) => { event.preventDefault(); setMenu({ x: 10, y: 10, items: [{ label: "Choose", onClick: onChoice }, { label: "Other", onClick: () => {} }] }); }}>page</div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  );
}

describe("ContextMenu", () => {
  it("focuses its first item when opened from the page, and returns the keyboard to the page when closed", () => {
    const onChoice = vi.fn();
    act(() => root.render(<Harness onChoice={onChoice} />));
    const page = host.querySelector<HTMLElement>('[data-testid="page"]')!;
    act(() => page.focus());
    expect(document.activeElement).toBe(page);
    act(() => { page.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const first = host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(document.activeElement).toBe(first);
    // Escape closes it: the page has the keyboard again.
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(page);
    // A choice closes it the same way.
    act(() => { page.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    act(() => host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(onChoice).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(page);
  });

  it("closes on a press outside it even where the control stops the event, on window blur, and when the app dismisses menus", () => {
    act(() => root.render(<Harness onChoice={vi.fn()} />));
    const page = host.querySelector<HTMLElement>('[data-testid="page"]')!;
    const open = () => act(() => { page.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    const isOpen = () => !!host.querySelector(".gl-context-menu");
    // A control that swallows its own presses (a tab strip, a plot) still closes the menu.
    const greedy = document.createElement("button");
    greedy.addEventListener("pointerdown", (event) => event.stopPropagation());
    greedy.addEventListener("mousedown", (event) => event.stopPropagation());
    document.body.appendChild(greedy);
    open(); expect(isOpen()).toBe(true);
    act(() => { greedy.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(isOpen()).toBe(false);
    open(); expect(isOpen()).toBe(true);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(isOpen()).toBe(false);
    open(); expect(isOpen()).toBe(true);
    act(() => { window.dispatchEvent(new Event(DISMISS_MENUS_EVENT)); });
    expect(isOpen()).toBe(false);
    // A press inside it does not.
    open();
    act(() => { host.querySelector(".gl-context-menu")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(isOpen()).toBe(true);
    greedy.remove();
  });
});
