/**
 * The small menu the Illustration and Plotting tabs' "Add to Layout" and "Add panels to Layout"
 * open when the figure or chart has more than one page: "This page", or "Every page, one sheet
 * each". With one page, or no way to send every page, the button acts at once, as it always has.
 */
import { useCallback, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { ContextMenu, type ContextMenuState } from "../ContextMenu";
import { useI18n } from "../i18n";

export function useEveryPageMenu(): {
  /** From a button's click: with more than one page, the menu below the button; else `thisPage` at once. */
  open: (event: ReactMouseEvent<HTMLElement>, pageCount: number, thisPage: () => void, everyPage?: () => void) => void;
  /** The menu, rendered once by the tab. */
  menu: ReactElement;
} {
  const { t } = useI18n();
  const [state, setState] = useState<ContextMenuState | null>(null);
  const close = useCallback(() => setState(null), []);
  const open = (event: ReactMouseEvent<HTMLElement>, pageCount: number, thisPage: () => void, everyPage?: () => void) => {
    if (pageCount <= 1 || !everyPage) {
      thisPage();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setState({
      x: rect.left,
      y: rect.bottom + 2,
      label: event.currentTarget.textContent ?? undefined,
      items: [
        { label: t("This page"), title: t("The page shown, on the Layout tab's current sheet"), onClick: thisPage },
        {
          label: t("Every page, one sheet each ({count})", { count: pageCount }),
          title: t("A new sheet per page after the current sheet, named by the page, with the current sheet's page size, margins and style"),
          onClick: everyPage,
        },
      ],
    });
  };
  return { open, menu: <ContextMenu menu={state} onClose={close} /> };
}
