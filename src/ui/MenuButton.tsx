import { useEffect, useId, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  /** A class for tests and styling, put on the item's button. */
  className?: string;
}

export type MenuEntry = MenuItem | "separator";

/**
 * A header menu: one button that opens a list of actions. The items are always in the DOM,
 * hidden while the menu is closed, so a test can reach an action by its label without opening
 * the menu, as it could when the actions were buttons in the sidebar.
 */
export function MenuButton({ label, items, disabled = false, title, className }: {
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function moveFocus(from: HTMLElement, step: 1 | -1) {
    const enabled = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = enabled.indexOf(from as HTMLButtonElement);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    next?.focus();
  }

  return (
    <div ref={root} className={`gl-menu${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`gl-menu-trigger${open ? " is-open" : ""}`}
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
            setTimeout(() => root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus(), 0);
          }
        }}
      >
        {label} <span aria-hidden="true" className="gl-menu-caret">▾</span>
      </button>
      <div id={menuId} role="menu" aria-label={label} className="gl-menu-popover" hidden={!open}>
        {items.map((item, i) =>
          item === "separator" ? (
            <div key={`sep-${i}`} role="separator" className="gl-menu-separator" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`gl-menu-item${item.className ? ` ${item.className}` : ""}`}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); moveFocus(event.currentTarget, 1); }
                else if (event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.currentTarget, -1); }
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
