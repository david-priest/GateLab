import { useEffect } from "react";

/**
 * A popover built on <details class="gl-popover"> closes the way the menus do: on a click
 * anywhere outside it, and on Escape. The summary still toggles it. Mounted once, by the app;
 * it watches the document, so a popover needs no wiring of its own beyond the class.
 */
export function usePopoverDismissal(): void {
  useEffect(() => {
    const openPopovers = () => Array.from(document.querySelectorAll<HTMLDetailsElement>("details.gl-popover[open]"));
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      for (const details of openPopovers()) if (!target || !details.contains(target)) details.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const details of openPopovers()) details.open = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
