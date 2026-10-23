import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { keyPlatform, platformKeys } from "./platformKeys";

export interface MenuItem {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  /** A class for tests and styling, put on the item's button. */
  className?: string;
  /** A setting the item switches: shown with a tick while on, announced as a checkbox. */
  checked?: boolean;
  /** An action that removes something: drawn in red, and placed last, after a separator. */
  danger?: boolean;
  /** Its keyboard shortcut, written with the Mac's key names (⌘S); shown right-aligned, named for the user's keyboard. */
  shortcut?: string;
}

/** A label heading a group of items in a long menu. Not an action. */
export interface MenuSection {
  section: string;
}

export type MenuEntry = MenuItem | MenuSection | "separator";

/**
 * A menu's entries, as the header menus and the right-click menus alike draw them: items with a
 * tick column when any item switches a setting, section labels, separators, right-aligned
 * shortcuts and red destructive items. `onPick` runs the item and closes the menu.
 */
export function MenuEntries({ items, onPick, moveFocus }: {
  items: readonly MenuEntry[];
  onPick: (item: MenuItem) => void;
  moveFocus: (from: HTMLElement, step: 1 | -1) => void;
}) {
  // One column for the ticks, kept for every item when any has one, so the labels line up.
  const ticks = items.some((item) => typeof item === "object" && "label" in item && item.checked !== undefined);
  return (
    <>
      {items.map((item, i) => {
        if (item === "separator") return <div key={`sep-${i}`} role="separator" className="gl-menu-separator" />;
        if ("section" in item) return <div key={`section-${i}`} role="presentation" className="gl-menu-section">{item.section}</div>;
        return (
          <button
            key={item.label}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked === undefined ? undefined : item.checked}
            aria-keyshortcuts={item.shortcut ? ariaShortcut(item.shortcut) : undefined}
            className={`gl-menu-item${item.danger ? " is-danger" : ""}${item.className ? ` ${item.className}` : ""}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onPick(item)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
              else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
            }}
          >
            {ticks && <span className="gl-menu-check" aria-hidden="true">{item.checked ? <CheckIcon /> : null}</span>}
            <span className="gl-menu-label">{item.label}</span>
            {/* Drawn from the attribute, so the item's text stays its label (tests and the tutorial find items by it); aria-keyshortcuts announces it. */}
            {item.shortcut && <span className="gl-menu-shortcut" aria-hidden="true" data-shortcut={platformKeys(item.shortcut)} />}
          </button>
        );
      })}
    </>
  );
}

/** ⌘S as aria-keyshortcuts writes it: Meta+S. */
function ariaShortcut(shortcut: string): string {
  const keys = { "⌘": keyPlatform() === "mac" ? "Meta" : "Control", "⇧": "Shift", "⌥": "Alt", "⌃": "Control" } as const;
  const parts = [...shortcut].map((c) => keys[c as keyof typeof keys] ?? c.toUpperCase());
  return parts.join("+");
}

/**
 * A header menu: one button that opens a list of actions. The items are always in the DOM,
 * hidden while the menu is closed, so a test can reach an action by its label without opening
 * the menu, as it could when the actions were buttons in the sidebar.
 */
export function MenuButton({ label, items, disabled = false, title, className, icon }: {
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean;
  title?: string;
  className?: string;
  /** Shown in place of the label and its caret, the label then naming the button for assistive technology: a header's or a row's ⋯. */
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const menuId = useId();
  // The open list is placed against the window (position: fixed), so a pane's scroll box cannot
  // clip it (a gate row's ⋯ on the last row, say). It stays where it is in the document, so
  // everything that finds an item through its row, pane or header still does.
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const trigger = root.current?.querySelector(".gl-menu-trigger")?.getBoundingClientRect();
    const menu = popover.current?.getBoundingClientRect();
    if (!trigger || !menu) return;
    const margin = 8;
    const gap = 4;
    // Below the trigger, or above it when there is no room below; inside the window either way.
    let top = trigger.bottom + gap;
    if (top + menu.height > window.innerHeight - margin && trigger.top - gap - menu.height >= margin) top = trigger.top - gap - menu.height;
    top = Math.max(margin, Math.min(top, window.innerHeight - margin - menu.height));
    // Left edges aligned; an icon's ⋯, at the end of its row, opens leftward from its right edge,
    // as does any menu that would cross the window's right edge.
    let left = icon || trigger.left + menu.width > window.innerWidth - margin ? trigger.right - menu.width : trigger.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - menu.width));
    setPlace({ position: "fixed", top, left, right: "auto", maxHeight: window.innerHeight - 2 * margin, overflowY: "auto" });
  }, [open, icon]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      !!target && ((root.current?.contains(target as Node) ?? false) || (popover.current?.contains(target as Node) ?? false));
    const onDown = (event: MouseEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // A list placed against the window would be left behind by a scroll or a resize: close it, as
    // the right-click menus do. Scrolling the list itself is not that.
    const onScroll = (event: Event) => {
      if (!popover.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function moveFocus(from: HTMLElement, step: 1 | -1) {
    const enabled = [...(popover.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const at = enabled.indexOf(from as HTMLButtonElement);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    next?.focus();
  }

  const list = (
    <div
      ref={popover}
      id={menuId}
      role="menu"
      aria-label={label}
      className="gl-menu-popover"
      hidden={!open}
      // Hidden until placed, so it never shows for a frame where the CSS alone would put it.
      style={open ? (place ?? { position: "fixed", top: 0, left: 0, right: "auto", visibility: "hidden" }) : undefined}
    >
      <MenuEntries
        items={items}
        moveFocus={moveFocus}
        onPick={(item) => {
          setOpen(false);
          item.onClick();
        }}
      />
    </div>
  );

  return (
    <div ref={root} className={`gl-menu${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`gl-menu-trigger${open ? " is-open" : ""}${icon ? " gl-menu-trigger-icon" : ""}`}
        aria-label={icon ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
            setTimeout(() => popover.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus(), 0);
          }
        }}
      >
        {icon ?? <>{label}<span aria-hidden="true" className="gl-menu-caret"><ChevronDownIcon size={12} /></span></>}
      </button>
      {list}
    </div>
  );
}
