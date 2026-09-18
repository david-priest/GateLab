// ContextMenu.tsx — a menu at the pointer, opened by a right-click on a panel, an item or the
// page. It shares the header menus' items and look (MenuButton) and closes on a choice, on a
// click elsewhere, on Escape or on scrolling, so it never outlives what it was opened on.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuEntry } from "./MenuButton";

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
  // Kept on screen: a menu opened near the right or bottom edge is shifted back inside.
  useLayoutEffect(() => {
    if (!menu || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4));
    setPosition({ left, top });
    root.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  const moveFocus = (from: HTMLElement, step: 1 | -1) => {
    const enabled = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
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
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={`separator-${i}`} className="gl-menu-separator" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`gl-menu-item${item.className ? ` ${item.className}` : ""}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              onClose();
              item.onClick();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
              if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
