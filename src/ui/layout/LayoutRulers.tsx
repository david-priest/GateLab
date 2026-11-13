// LayoutRulers.tsx — the Layout tab's rulers along the top and left of the canvas pane, in mm from
// the first page's top-left corner, following scroll and zoom; a marker on each follows the pointer
// and the selection's extent is shaded. A drag from the top ruler onto the page makes a horizontal
// guide, from the left ruler a vertical one. The rulers sit outside the scrolling pane, in a
// zero-size box placed just before it, so they stay put while the page scrolls under them.

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { LayoutGuide } from "../../engine/layout";
import { contentBounds, type Box } from "../../engine/layoutArrange";
import { useI18n } from "../i18n";
import { RULER_SIZE, rulerTicks } from "./guideModel";
import "./layoutGuides.css";

interface View {
  width: number;
  height: number;
  /** Where the first page's corner is, in screen px from the pane's top-left corner. */
  originX: number;
  originY: number;
}

const sameView = (a: View, b: View) =>
  a.width === b.width && a.height === b.height && a.originX === b.originX && a.originY === b.originY;

export function LayoutRulers({
  scroller,
  page,
  zoom,
  selected,
  onAddGuide,
}: Readonly<{
  scroller: HTMLElement | null;
  page: HTMLElement | null;
  zoom: number;
  /** The selected items, in sheet px; their extent is shaded on both rulers. */
  selected: readonly Box[];
  onAddGuide: (guide: LayoutGuide) => void;
}>) {
  const { t } = useI18n();
  const selection = contentBounds(selected);
  const [view, setView] = useState<View>({ width: 0, height: 0, originX: 0, originY: 0 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  /** A guide being dragged out of a ruler: its axis and where it is, in pane px. */
  const [draft, setDraft] = useState<{ axis: LayoutGuide["axis"]; x: number; y: number } | null>(null);
  const latest = useRef({ scroller, page, zoom, onAddGuide });
  latest.current = { scroller, page, zoom, onAddGuide };

  const measure = () => {
    const { scroller: s, page: p } = latest.current;
    if (!s || !p) return;
    const box = s.getBoundingClientRect();
    const sheet = p.getBoundingClientRect();
    const next = {
      width: s.clientWidth || box.width,
      height: s.clientHeight || box.height,
      originX: sheet.left - box.left,
      originY: sheet.top - box.top,
    };
    setView((current) => (sameView(current, next) ? current : next));
  };
  // Measured after every render (a zoom, a page size, a sheet), and on scroll and resize.
  useLayoutEffect(measure);
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => measure();
    const onMove = (event: MouseEvent) => {
      const box = scroller.getBoundingClientRect();
      setPointer({ x: event.clientX - box.left, y: event.clientY - box.top });
    };
    const onLeave = () => setPointer(null);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("mousemove", onMove);
    scroller.addEventListener("mouseleave", onLeave);
    window.addEventListener("resize", onScroll);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("mousemove", onMove);
      scroller.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("resize", onScroll);
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller]);

  /** A press on a ruler: the guide follows the pointer and is made where it is let go on the pane. */
  const startGuide = (axis: LayoutGuide["axis"]) => (event: ReactMouseEvent) => {
    if (event.button !== 0 || !scroller) return;
    event.preventDefault();
    const at = (move: MouseEvent) => {
      const box = scroller.getBoundingClientRect();
      return { x: move.clientX - box.left, y: move.clientY - box.top };
    };
    const onMove = (move: MouseEvent) => setDraft({ axis, ...at(move) });
    const onUp = (up: MouseEvent) => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      setDraft(null);
      const { scroller: s, page: p, zoom: z, onAddGuide: add } = latest.current;
      if (!s || !p) return;
      const box = s.getBoundingClientRect();
      const width = s.clientWidth || box.width, height = s.clientHeight || box.height;
      const x = up.clientX - box.left, y = up.clientY - box.top;
      // Let go on its own ruler, or outside the pane, the guide is not made.
      const onPane = x >= 0 && y >= 0 && x <= width && y <= height && (axis === "y" ? y >= RULER_SIZE : x >= RULER_SIZE);
      if (!onPane) return;
      const sheet = p.getBoundingClientRect();
      add({ axis, at: axis === "y" ? (up.clientY - sheet.top) / z : (up.clientX - sheet.left) / z });
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    setDraft({ axis, ...at(event.nativeEvent) });
  };

  const scaled = (px: number) => px * zoom;
  const ruler = (axis: "top" | "left") => {
    const across = axis === "top";
    const length = across ? view.width : view.height;
    const origin = across ? view.originX : view.originY;
    const ticks = rulerTicks(origin, length, zoom);
    const shade = selection
      ? { from: origin + scaled(across ? selection.x : selection.y), size: scaled(across ? selection.width : selection.height) }
      : null;
    const mark = pointer ? (across ? pointer.x : pointer.y) : null;
    return (
      <div
        className={`gl-layout-ruler is-${axis}`}
        style={across ? { width: view.width, height: RULER_SIZE } : { width: RULER_SIZE, height: view.height }}
        title={across ? t("Drag onto the page to place a horizontal guide") : t("Drag onto the page to place a vertical guide")}
        onMouseDown={startGuide(across ? "y" : "x")}
      >
        <svg width={across ? view.width : RULER_SIZE} height={across ? RULER_SIZE : view.height} aria-hidden="true">
          {shade && (across
            ? <rect className="gl-layout-ruler-selection" x={shade.from} y={0} width={shade.size} height={RULER_SIZE} />
            : <rect className="gl-layout-ruler-selection" x={0} y={shade.from} width={RULER_SIZE} height={shade.size} />)}
          {ticks.map((tick) => {
            const reach = tick.major ? RULER_SIZE : tick.mm % 5 === 0 ?RULER_SIZE * 0.45 : RULER_SIZE * 0.3;
            return across
              ? <line key={tick.mm} x1={tick.at} x2={tick.at} y1={RULER_SIZE - reach} y2={RULER_SIZE} />
              : <line key={tick.mm} y1={tick.at} y2={tick.at} x1={RULER_SIZE - reach} x2={RULER_SIZE} />;
          })}
          {ticks.filter((tick) => tick.major).map((tick) => (across
            ? <text key={`l${tick.mm}`} x={tick.at + 2} y={9}>{tick.mm}</text>
            : <text key={`l${tick.mm}`} x={9} y={tick.at + 2} transform={`rotate(-90 9 ${tick.at + 2})`} textAnchor="end">{tick.mm}</text>))}
          {mark !== null && (across
            ? <line className="gl-layout-ruler-pointer" x1={mark} x2={mark} y1={0} y2={RULER_SIZE} />
            : <line className="gl-layout-ruler-pointer" y1={mark} y2={mark} x1={0} x2={RULER_SIZE} />)}
        </svg>
      </div>
    );
  };

  return (
    <div className="gl-layout-rulers" data-testid="layout-rulers">
      {ruler("top")}
      {ruler("left")}
      <div className="gl-layout-ruler-corner" title={t("Rulers in mm from the first page's top-left corner")}>mm</div>
      {draft && (draft.axis === "y"
        ? <div className="gl-layout-guide-draft is-y" style={{ top: draft.y, width: view.width }} />
        : <div className="gl-layout-guide-draft is-x" style={{ left: draft.x, height: view.height }} />)}
    </div>
  );
}

/** The toolbar's "Rulers" toggle, beside "Snap grid". */
export function LayoutRulersToggle({ on, onToggle }: Readonly<{ on: boolean; onToggle: () => void }>) {
  const { t } = useI18n();
  return (
    <button className="gl-mini-btn" type="button" aria-pressed={on} onClick={onToggle} title={t("Show rulers in mm along the top and left of the page; drag from a ruler to place a guide")}>
      {t("Rulers")}
    </button>
  );
}
