// PlotRemoveButton.tsx — the × that removes one of the Gating tab's plots.
//
// It sits in the top-right corner of the plot card that is showing, not of the grid cell: a
// histogram's card is narrower than its cell, and a plot can be drawn at a size its cell has not
// caught up with, and a button pinned to the cell then stood outside the plot (David, 2026-11-20:
// "make sure x stays in top right corner"). Without a drawn card it keeps its place from the
// stylesheet (.gl-plot-remove).

import { useLayoutEffect, useRef } from "react";

/** The scatter plot's white square is drawn 5 px outside its container (styles.css, .gl-plot-grid.is-multi). */
const SCATTER_RING = 5;
/** The button's inset from the card's top and right edges. */
const INSET_TOP = 2;
const INSET_RIGHT = 4;

interface Box { left: number; top: number; right: number; bottom: number }

/** Where the button goes, in the cell's coordinates: the card's top-right corner, inset, and inside the cell. */
export function removeButtonPlace(cell: Box, card: Box, ring: number, buttonWidth: number): { left: number; top: number } {
  const cellWidth = cell.right - cell.left;
  const right = Math.min(card.right + ring - cell.left, cellWidth) - INSET_RIGHT;
  const top = Math.max(card.top - ring - cell.top, 0) + INSET_TOP;
  return { left: Math.max(0, Math.round(right - buttonWidth)), top: Math.round(top) };
}

/** The card the cell is showing: the histogram's, or the scatter plot's container. */
function shownCard(cell: HTMLElement): { element: HTMLElement; ring: number } | null {
  const histogram = cell.querySelector<HTMLElement>(":scope > .gl-histogram");
  if (histogram && histogram.offsetWidth > 0) return { element: histogram, ring: 0 };
  const scatter = cell.querySelector<HTMLElement>("[id^='cytof-plot-container']");
  if (scatter && scatter.offsetWidth > 0) return { element: scatter, ring: SCATTER_RING };
  return null;
}

interface Props {
  label: string;
  title: string;
  onClick: () => void;
}

export function PlotRemoveButton({ label, title, onClick }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = ref.current;
    const cell = button?.parentElement;
    if (!button || !cell || typeof ResizeObserver === "undefined") return;
    let observed: HTMLElement[] = [];
    const place = () => {
      const card = shownCard(cell);
      if (!card) {
        button.style.removeProperty("left");
        button.style.removeProperty("right");
        button.style.removeProperty("top");
        return;
      }
      const at = removeButtonPlace(cell.getBoundingClientRect(), card.element.getBoundingClientRect(), card.ring, button.offsetWidth);
      button.style.left = `${at.left}px`;
      button.style.right = "auto";
      button.style.top = `${at.top}px`;
    };
    const resize = new ResizeObserver(place);
    const watch = () => {
      for (const element of observed) resize.unobserve(element);
      observed = [cell, ...cell.querySelectorAll<HTMLElement>(":scope > .gl-histogram, [id^='cytof-plot-container']")];
      for (const element of observed) resize.observe(element);
      place();
    };
    // A histogram's card comes and goes as a child of the cell; the scatter plot's stays.
    const children = new MutationObserver(watch);
    children.observe(cell, { childList: true });
    watch();
    return () => {
      children.disconnect();
      resize.disconnect();
    };
  }, []);
  return (
    <button ref={ref} type="button" className="gl-plot-remove" aria-label={label} title={title} onClick={onClick}>
      ×
    </button>
  );
}
