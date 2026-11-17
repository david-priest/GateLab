// LayoutGuides.tsx — a sheet's guides drawn on the Layout page: thin coloured lines across the
// sheet, above the items and below the selection handles, never printed or exported. A guide is
// dragged to move it; dragged back onto its ruler, or selected and Delete pressed, it is removed;
// a double-click opens a field to type its position in mm, from the edge of the page it is on
// (as the rulers count). Each change is one commit, so one undo
// step. The presses are taken here, before the page's marquee (Selecto listens on the pane).

import { useEffect, useRef, useState } from "react";
import type { LayoutGuide, LayoutPage } from "../../engine/layout";
import { useI18n } from "../i18n";
import { pageOriginAt } from "../layoutPlacement";
import { pxToUnit, unitToPx } from "./layoutGeometry";
import { overOwnRuler } from "./guideModel";
import "./layoutGuides.css";

/** A guide's grab area, in screen px either side of its line. */
const GRAB_PX = 4;

/** The edge of the page a guide at `at` is on, in sheet px: a position shown is measured from it. */
const pageEdge = (pages: LayoutPage, axis: LayoutGuide["axis"], at: number) =>
  axis === "x" ? pageOriginAt(pages, at, 0).x : pageOriginAt(pages, 0, at).y;

export function LayoutGuides({
  guides,
  width,
  height,
  pages,
  zoom,
  scroller,
  onMove,
  onRemove,
}: Readonly<{
  guides: readonly LayoutGuide[];
  /** The sheet in px: a guide runs across all of it. */
  width: number;
  height: number;
  /** The sheet's page size and grid: a guide's position is shown from the edge of its page. */
  pages: LayoutPage;
  zoom: number;
  /** The canvas pane, whose top and left bands are the rulers a guide is dragged back onto. */
  scroller: HTMLElement | null;
  onMove: (index: number, at: number) => void;
  onRemove: (index: number) => void;
}>) {
  const { t } = useI18n();
  const layerRef = useRef<HTMLDivElement>(null);
  /** A guide being dragged, where it is now, in sheet px. */
  const [draft, setDraft] = useState<{ index: number; at: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const latest = useRef({ guides, zoom, scroller, onMove, onRemove });
  latest.current = { guides, zoom, scroller, onMove, onRemove };

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const onDown = (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(".gl-layout-guide");
      if (!target || event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      target.focus({ preventScroll: true });
      const index = Number(target.dataset.guideIndex);
      const guide = latest.current.guides[index];
      if (!guide) return;
      const start = { x: event.clientX, y: event.clientY };
      const atOf = (move: MouseEvent) => {
        const rect = layer.getBoundingClientRect();
        const z = latest.current.zoom;
        return guide.axis === "x" ? (move.clientX - rect.left) / z : (move.clientY - rect.top) / z;
      };
      const moved = (move: MouseEvent) => Math.hypot(move.clientX - start.x, move.clientY - start.y) >= 3;
      const onMoveEvent = (move: MouseEvent) => { if (moved(move)) setDraft({ index, at: atOf(move) }); };
      const onUp = (up: MouseEvent) => {
        window.removeEventListener("mousemove", onMoveEvent, true);
        window.removeEventListener("mouseup", onUp, true);
        setDraft(null);
        if (!moved(up)) return;
        const pane = latest.current.scroller?.getBoundingClientRect();
        if (pane && overOwnRuler(guide.axis, pane, up.clientX, up.clientY)) latest.current.onRemove(index);
        else latest.current.onMove(index, atOf(up));
      };
      window.addEventListener("mousemove", onMoveEvent, true);
      window.addEventListener("mouseup", onUp, true);
    };
    const stop = (event: Event) => {
      if ((event.target as HTMLElement).closest(".gl-layout-guide, .gl-layout-guide-field")) event.stopPropagation();
    };
    layer.addEventListener("mousedown", onDown);
    layer.addEventListener("pointerdown", stop);
    layer.addEventListener("touchstart", stop);
    return () => {
      layer.removeEventListener("mousedown", onDown);
      layer.removeEventListener("pointerdown", stop);
      layer.removeEventListener("touchstart", stop);
    };
  }, []);

  const grab = (GRAB_PX * 2 + 1) / zoom;
  return (
    <div ref={layerRef} className="gl-layout-guides" aria-label={t("Guides")}>
      {guides.map((guide, index) => {
        const at = draft?.index === index ? draft.at : guide.at;
        const mm = pxToUnit(at - pageEdge(pages, guide.axis, at), "mm");
        return (
          <div
            key={index}
            className={`gl-layout-guide is-${guide.axis}`}
            data-guide-index={index}
            role="separator"
            aria-orientation={guide.axis === "x" ? "vertical" : "horizontal"}
            aria-label={guide.axis === "x" ? t("Vertical guide at {mm} mm", { mm }) : t("Horizontal guide at {mm} mm", { mm })}
            title={t("Drag to move; drag onto its ruler or press Delete to remove; double-click to type its position")}
            tabIndex={0}
            style={guide.axis === "x"
              ? { left: at - grab / 2, top: 0, width: grab, height }
              : { top: at - grab / 2, left: 0, height: grab, width }}
            onDoubleClick={(event) => { event.stopPropagation(); setEditing(index); }}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                event.stopPropagation();
                onRemove(index);
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                setEditing(index);
              }
            }}
          />
        );
      })}
      {editing !== null && guides[editing] && (
        <GuideField
          guide={guides[editing]}
          edge={pageEdge(pages, guides[editing].axis, guides[editing].at)}
          zoom={zoom}
          onCommit={(at) => { setEditing(null); if (at !== guides[editing].at) onMove(editing, at); }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** The field a double-click opens on a guide: its position in mm, from `edge`, its page's edge in sheet px. */
function GuideField({ guide, edge, zoom, onCommit, onCancel }: Readonly<{
  guide: LayoutGuide;
  edge: number;
  zoom: number;
  onCommit: (at: number) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const done = useRef(false);
  const finish = (raw: string) => {
    if (done.current) return;
    done.current = true;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) onCancel();
    else onCommit(edge + unitToPx(value, "mm"));
  };
  const place = guide.axis === "x" ? { left: guide.at + 4 / zoom, top: 4 / zoom } : { top: guide.at + 4 / zoom, left: 4 / zoom };
  return (
    <label className="gl-layout-guide-field" style={{ ...place, transform: `scale(${1 / zoom})` }}>
      {guide.axis === "x" ? t("X (mm)") : t("Y (mm)")}
      <input
        type="number"
        step={0.1}
        autoFocus
        aria-label={t("Guide position (mm)")}
        defaultValue={pxToUnit(guide.at - edge, "mm")}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") finish(event.currentTarget.value);
          else if (event.key === "Escape") { done.current = true; onCancel(); }
        }}
        onBlur={(event) => finish(event.currentTarget.value)}
      />
    </label>
  );
}

/** The Page tab's "Clear guides": removes every guide on the sheet, as one undo step. */
export function LayoutClearGuidesButton({ count, onClear }: Readonly<{ count: number; onClear: () => void }>) {
  const { t } = useI18n();
  return (
    <button type="button" className="gl-mini-btn" onClick={onClear} disabled={!count} title={t("Remove every guide on this sheet")}>
      {t("Clear guides")}
    </button>
  );
}
