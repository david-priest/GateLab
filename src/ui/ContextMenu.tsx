// ContextMenu.tsx — a menu at the pointer, opened by a right-click on a panel, an item or the
// page. It shares the header menus' items and look (MenuButton) and closes on a choice, on a
// click elsewhere, on Escape or on scrolling, so it never outlives what it was opened on.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MenuEntries, type MenuEntry } from "./MenuButton";

/** Sent on the window when what a menu was opened on goes out of view, such as a tab switch: every open context menu closes. */
export const DISMISS_MENUS_EVENT = "gatelab:dismiss-menus";

export interface ContextMenuState {
  x: number;
  y: number;
  items: readonly MenuEntry[];
  /** For the caller's own use, such as which panel or item the menu is about. */
  label?: string;
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  /** What had the keyboard when the menu opened, given it back when the menu closes. */
  const opener = useRef<HTMLElement | null>(null);
  // Kept on screen: a menu opened near the right or bottom edge is shifted back inside.
  useLayoutEffect(() => {
    if (!menu || !root.current) return;
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const rect = root.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4));
    setPosition({ left, top });
    root.current.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);
  // Closed by a choice, a click elsewhere or Escape, the menu returns the keyboard to where it was,
  // so Escape, Delete and the arrows that follow reach the page the menu was opened on.
  useEffect(() => {
    if (!menu) return;
    const menuRoot = root.current;
    return () => {
      const previous = opener.current;
      opener.current = null;
      const active = document.activeElement;
      const lost = !active || active === document.body || (menuRoot ? menuRoot.contains(active) : false);
      if (previous && previous.isConnected && lost) previous.focus({ preventScroll: true });
    };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // In the capture phase, so a control that stops its own pointer events still closes the menu.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    // The window losing focus, and a tab switch however it is made (DISMISS_MENUS_EVENT).
    window.addEventListener("blur", onClose);
    window.addEventListener(DISMISS_MENUS_EVENT, onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener(DISMISS_MENUS_EVENT, onClose);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  const moveFocus = (from: HTMLElement, step: 1 | -1) => {
    const enabled = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const at = enabled.indexOf(from as HTMLButtonElement);
    enabled[(at + step + enabled.length) % enabled.length]?.focus();
  };
  return (
    <div
      ref={root}
      role="menu"
      aria-label={menu.label}
      className="gl-menu-popover gl-context-menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuEntries
        items={menu.items}
        moveFocus={moveFocus}
        onPick={(item) => {
          onClose();
          item.onClick();
        }}
      />
    </div>
  );
}
