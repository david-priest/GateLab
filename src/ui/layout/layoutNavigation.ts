// layoutNavigation.ts — moving about the Layout page: Space-drag and middle-button drag pan the
// view, and Cmd/Ctrl-0, -1, -2, -= and -- fit the page, show it at 100 %, frame the selection and
// step the zoom. The zoom itself stays LayoutTab's; this reads and sets it.

import { useEffect, useLayoutEffect, useRef } from "react";
import "./layoutNavigation.css";

export type ZoomShortcut = "fit" | "actual" | "selection" | "in" | "out";

/** Cmd/Ctrl-0 fits the page, -1 is 100 %, -2 frames the selection, -= and -- step in and out. */
export function zoomShortcut(event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">): ZoomShortcut | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const { key, code } = event;
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "fit";
  if (key === "1" || code === "Digit1" || code === "Numpad1") return "actual";
  if (key === "2" || code === "Digit2" || code === "Numpad2") return "selection";
  if (key === "=" || key === "+" || code === "Equal" || code === "NumpadAdd") return "in";
  if (key === "-" || key === "_" || code === "Minus" || code === "NumpadSubtract") return "out";
  return null;
}

export interface Box { x: number; y: number; width: number; height: number }

/** The box around the items, in page pixels; null for none. */
export function itemsBox(items: readonly Box[]): Box | null {
  if (!items.length) return null;
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** The zoom at which the box fills the view, with the same 36 px of room Fit leaves; the toolbar's limits, 10 % to 400 %. */
export function frameZoom(box: Box, view: { width: number; height: number }): number | null {
  const available = { width: view.width - 36, height: view.height - 36 };
  if (available.width <= 0 || available.height <= 0) return null;
  const next = Math.min(available.width / box.width, available.height / box.height);
  return Math.max(0.1, Math.min(4, Math.floor(next * 100) / 100));
}

/** Whether a key went to something that types: a field, or a text block's editor. */
function typesText(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") || el.isContentEditable === true;
}

const isSpace = (event: KeyboardEvent) => event.key === " " || event.code === "Space";

interface NavigationOptions {
  /** The scrolling element round the page. */
  canvasEl: HTMLElement | null;
  zoom: number;
  setZoom: (zoom: number) => void;
  fitZoom: () => void;
  stepZoom: (direction: 1 | -1) => void;
  /** The items on the page now. */
  items: readonly (Box & { id: string; templateId: string })[];
  /** The template ids selected. */
  selected: readonly string[];
}

export function useLayoutNavigation({ canvasEl, zoom, setZoom, fitZoom, stepZoom, items, selected }: NavigationOptions) {
  /** Where the view is to scroll once a new zoom has been drawn: the page point to centre. */
  const pendingCentre = useRef<{ x: number; y: number } | null>(null);
  const zoomTo = (ids: readonly string[]) => {
    if (!canvasEl) return;
    const chosen = ids.length ? items.filter((item) => ids.includes(item.templateId)) : items;
    const box = itemsBox(chosen);
    if (!box) {
      fitZoom();
      return;
    }
    const next = frameZoom(box, { width: canvasEl.clientWidth, height: canvasEl.clientHeight });
    if (next === null) return;
    pendingCentre.current = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (next === zoom) centre();
    else setZoom(next);
  };
  const centre = () => {
    const point = pendingCentre.current;
    if (!canvasEl || !point) return;
    pendingCentre.current = null;
    // The page's place inside the scrolled content: the scaled wrapper can sit inset by padding.
    const scaled = canvasEl.querySelector<HTMLElement>(".gl-layout-zoom");
    const outer = canvasEl.getBoundingClientRect();
    const inner = scaled?.getBoundingClientRect();
    const offsetX = inner ? inner.left - outer.left + canvasEl.scrollLeft : 0;
    const offsetY = inner ? inner.top - outer.top + canvasEl.scrollTop : 0;
    canvasEl.scrollLeft = Math.max(0, offsetX + point.x * zoom - canvasEl.clientWidth / 2);
    canvasEl.scrollTop = Math.max(0, offsetY + point.y * zoom - canvasEl.clientHeight / 2);
  };
  useLayoutEffect(centre, [zoom, canvasEl]);

  const latest = useRef({ zoomTo, selected, setZoom, fitZoom, stepZoom });
  latest.current = { zoomTo, selected, setZoom, fitZoom, stepZoom };

  // The zoom keys, while the page or its inspector has the keyboard. The browser's own zoom is
  // kept from them there.
  useEffect(() => {
    if (!canvasEl) return;
    const onKey = (event: KeyboardEvent) => {
      const action = zoomShortcut(event);
      if (!action) return;
      const target = event.target as HTMLElement | null;
      const tab = canvasEl.closest(".gl-layout-tab");
      const area = target?.closest?.(".gl-layout-canvas-scroll, .gl-layout-controls");
      if (!area || (tab && !tab.contains(area))) return;
      event.preventDefault();
      event.stopPropagation();
      const now = latest.current;
      if (action === "fit") now.fitZoom();
      else if (action === "actual") now.setZoom(1);
      else if (action === "selection") now.zoomTo(now.selected);
      else now.stepZoom(action === "in" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [canvasEl]);

  // Space held over the page turns the pointer into a hand, and a drag then scrolls the view;
  // a middle-button drag does the same. The presses are taken on the window before anything on
  // the page sees them, so nothing is selected, moved or drawn while panning.
  useEffect(() => {
    if (!canvasEl) return;
    let over = false;
    let held = false;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    let swallowClick = false;
    const mark = () => {
      if (drag) canvasEl.dataset.pan = "active";
      else if (held) canvasEl.dataset.pan = "ready";
      else delete canvasEl.dataset.pan;
    };
    const inside = (target: EventTarget | null) => target instanceof Node && canvasEl.contains(target);
    const onOver = (event: MouseEvent) => { over = inside(event.target); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpace(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typesText(event.target)) return;
      if (!held && !over && !inside(event.target)) return;
      // Not the page's scroll, nor a click of the focused button.
      event.preventDefault();
      event.stopPropagation();
      if (!held) {
        held = true;
        mark();
      }
    };
    const release = () => {
      held = false;
      drag = null;
      mark();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSpace(event) || !held) return;
      event.preventDefault();
      event.stopPropagation();
      held = false;
      mark();
    };
    const onPointerDown = (event: Event) => {
      if (!inside(event.target)) return;
      if (held || (event as MouseEvent).button === 1) event.stopPropagation();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (!inside(event.target) || !(held || event.button === 1)) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { x: event.clientX, y: event.clientY, left: canvasEl.scrollLeft, top: canvasEl.scrollTop };
      mark();
    };
    const onMouseMove = (event: MouseEvent) => {
      onOver(event);
      if (!drag) return;
      event.preventDefault();
      canvasEl.scrollLeft = drag.left - (event.clientX - drag.x);
      canvasEl.scrollTop = drag.top - (event.clientY - drag.y);
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!drag) return;
      event.preventDefault();
      event.stopPropagation();
      drag = null;
      swallowClick = true;
      window.setTimeout(() => { swallowClick = false; }, 0);
      mark();
    };
    // While the hand is shown a click or double-click on the page does nothing.
    const onClick = (event: MouseEvent) => {
      if ((held || swallowClick) && inside(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        swallowClick = false;
      }
    };
    window.addEventListener("mouseover", onOver, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("dblclick", onClick, true);
    window.addEventListener("auxclick", onClick, true);
    return () => {
      window.removeEventListener("mouseover", onOver, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("dblclick", onClick, true);
      window.removeEventListener("auxclick", onClick, true);
      delete canvasEl.dataset.pan;
    };
  }, [canvasEl]);

  return { zoomToSelection: zoomTo };
}
