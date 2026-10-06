// TourOverlay.tsx — what the tutorial shows: a marker around the element the step is about, a
// pointer that shows the gesture, and the card with the words. Nothing is dimmed: the marker is
// a band in the tutorial's own colour, which the card shares, so the app stays as it is and
// fully usable under it. Nothing here takes a click but the card.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "../ui/i18n";
import { platformKeys } from "../ui/platformKeys";
import { chapterOf, stepBody, stepTarget, unmetNeeds } from "./tourScript";
import type { TourContext, TourStep, TourTarget, TourTargetSpec } from "./tourTypes";

interface Rect { x: number; y: number; width: number; height: number; }

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The number an element shows: an input's value, else its text; none reads as the lowest. */
function numberShown(el: Element): number {
  const shown = el instanceof HTMLInputElement ? el.value : norm(el.textContent);
  const value = Number.parseFloat(shown);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** The first visible element the spec names (or, with `largest`, the one showing the largest number), or null. */
export function resolveTourTarget(spec: TourTargetSpec | null, root: ParentNode = document): Element | null {
  if (!spec) return null;
  const list = Array.isArray(spec) ? spec : [spec];
  for (const item of list as readonly (string | TourTarget)[]) {
    const target: TourTarget = typeof item === "string" ? { selector: item } : item;
    let elements: Element[];
    try {
      elements = [...root.querySelectorAll(target.selector)];
    } catch {
      continue;
    }
    const visible = elements.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const matched = target.text
      ? visible.filter((el) => (target.exact ? norm(el.textContent) === target.text : norm(el.textContent).includes(target.text!)))
      : visible;
    const el = target.largest
      ? matched.reduce<Element | null>((best, candidate) => (best === null || numberShown(candidate) > numberShown(best) ? candidate : best), null)
      : matched[target.index ?? 0];
    if (el) return el;
  }
  return null;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1);

const CARD_WIDTH = 340;
const CARD_MARGIN = 16;
const CARD_HEIGHT_GUESS = 260;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Follows an element's box on the page while it is there. */
function useTrackedRect(spec: TourTargetSpec | null, stepId: string): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    // Unset until the first look, so a step with nothing to mark clears the mark of the one before.
    let last: Rect | null | undefined;
    let shown = false;
    const tick = () => {
      const el = resolveTourTarget(spec);
      // A row far down a list, or a control scrolled away: brought into view once, when it is
      // first found, and left alone after that so the user's own scrolling is not fought.
      if (el && !shown) {
        shown = true;
        if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      const next = el ? rectOf(el) : null;
      if (last === undefined || !sameRect(last, next)) {
        last = next;
        setRect(next);
      }
    };
    tick();
    const timer = window.setInterval(tick, 150);
    window.addEventListener("scroll", tick, true);
    window.addEventListener("resize", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("scroll", tick, true);
      window.removeEventListener("resize", tick);
    };
    // The spec is compared by value; the step id restarts the tracking on a new step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, stepId]);
  return rect;
}

/** An arrow that moves to the target and taps, drags a box over it, or drags across it. */
function TourPointer({ kind, rect, from }: { kind: "click" | "drag" | "move"; rect: Rect; from: { x: number; y: number } }) {
  const cursor = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const key = `${kind}|${Math.round(rect.x)}|${Math.round(rect.y)}|${Math.round(rect.width)}|${Math.round(rect.height)}|${Math.round(from.x)}|${Math.round(from.y)}`;
  useEffect(() => {
    const el = cursor.current;
    if (!el || typeof el.animate !== "function" || reducedMotion()) return;
    const animations: Animation[] = [];
    const to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    if (kind === "click") {
      animations.push(el.animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px) scale(1)`, opacity: 0, offset: 0 },
          { transform: `translate(${from.x}px, ${from.y}px) scale(1)`, opacity: 1, offset: 0.1 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(0.8)`, opacity: 1, offset: 0.65 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(1)`, opacity: 1, offset: 0.75 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(1)`, opacity: 0, offset: 1 },
        ],
        { duration: 2600, iterations: Infinity, easing: "ease-in-out" },
      ));
    } else {
      // A box drawn corner to corner, or a drag across the target with nothing drawn.
      const a = kind === "drag"
        ? { x: rect.x + rect.width * 0.3, y: rect.y + rect.height * 0.3 }
        : { x: rect.x + rect.width * 0.12, y: rect.y + rect.height * 0.88 };
      const b = kind === "drag"
        ? { x: rect.x + rect.width * 0.68, y: rect.y + rect.height * 0.68 }
        : { x: rect.x + rect.width * 0.3, y: rect.y + rect.height * 0.72 };
      animations.push(el.animate(
        [
          { transform: `translate(${a.x}px, ${a.y}px)`, opacity: 0, offset: 0 },
          { transform: `translate(${a.x}px, ${a.y}px)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 1, offset: 0.7 },
          { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 1, offset: 0.85 },
          { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 0, offset: 1 },
        ],
        { duration: 3000, iterations: Infinity, easing: "ease-in-out" },
      ));
      const box = ghost.current;
      if (box) {
        animations.push(box.animate(
          [
            { left: `${a.x}px`, top: `${a.y}px`, width: "0px", height: "0px", opacity: 0, offset: 0 },
            { left: `${a.x}px`, top: `${a.y}px`, width: "0px", height: "0px", opacity: 1, offset: 0.12 },
            { left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px`, opacity: 1, offset: 0.7 },
            { left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px`, opacity: 1, offset: 0.85 },
            { left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px`, opacity: 0, offset: 1 },
          ],
          { duration: 3000, iterations: Infinity, easing: "ease-in-out" },
        ));
      }
    }
    return () => animations.forEach((animation) => animation.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <>
      {kind === "drag" && <div ref={ghost} className="gl-tour-ghost" aria-hidden="true" />}
      <div ref={cursor} className="gl-tour-cursor" aria-hidden="true">
        <svg width="22" height="26" viewBox="0 0 22 26">
          <path d="M3 2 L3 20 L8 15.5 L11.5 23 L15 21.5 L11.5 14 L18 14 Z" fill="#111827" stroke="#ffffff" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
    </>
  );
}

export interface TourOverlayProps {
  step: TourStep;
  index: number;
  total: number;
  reached: boolean;
  /** Gone back to and already done: the card says so and waits for Next. */
  held?: boolean;
  /** The app is on its way to where the step happens. */
  arriving?: boolean;
  ctx: TourContext;
  /** The tabs' names, for "This step is on the … tab". */
  tabLabels?: Readonly<Record<string, string>>;
  onNext: () => void;
  onBack: () => void;
  onEnd: () => void;
  /** Take the app to where the step happens. */
  onArrive?: () => void;
}

export function TourOverlay({ step, index, total, reached, held = false, arriving = false, ctx, tabLabels, onNext, onBack, onEnd, onArrive }: TourOverlayProps) {
  const { t } = useI18n();
  const spec = stepTarget(step, ctx);
  const specKey = JSON.stringify(spec);
  // Where the step happens, when the app is somewhere else and is not on its way there.
  const unmet = arriving || reached ? null : unmetNeeds(step, ctx);
  const place = !unmet
    ? null
    : unmet.workspace
      ? { text: t("This step needs a workspace open."), action: t("Open the demo workspace") }
      : unmet.tab
        ? { text: t("This step is on the {tab} tab.", { tab: tabLabels?.[unmet.tab] ?? unmet.tab }), action: t("Take me there") }
        : { text: t("This step is on the Compensation tab's {view} view.", { view: unmet.compensationView === "global" ? t("Global inspector") : t("Matrix") }), action: t("Take me there") };
  const rect = useTrackedRect(spec, step.id);
  const pointerRect = useTrackedRect(step.pointerTarget ?? null, step.id) ?? rect;
  const chapter = chapterOf(step);
  // The script names keys as a Mac does; the card names them for the keyboard in front of the reader.
  const title = platformKeys(step.title);
  const body = platformKeys(stepBody(step, ctx));
  // The card sits bottom right unless the target is there, then bottom left.
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
  const cardAtRight = !rect || !(
    rect.x + rect.width > viewportWidth - CARD_WIDTH - CARD_MARGIN * 2 &&
    rect.y + rect.height > viewportHeight - CARD_HEIGHT_GUESS - CARD_MARGIN * 2
  );
  const cardFrom = {
    x: cardAtRight ? viewportWidth - CARD_WIDTH / 2 - CARD_MARGIN : CARD_WIDTH / 2 + CARD_MARGIN,
    y: viewportHeight - CARD_HEIGHT_GUESS / 2 - CARD_MARGIN,
  };
  const pad = 6;
  // The marker stands a little outside the element, and inside the window: around a panel that
  // runs to the window's edge the band would otherwise be drawn off screen.
  const edge = 3;
  const marker = rect
    ? (() => {
        const left = Math.max(edge, rect.x - pad);
        const top = Math.max(edge, rect.y - pad);
        const right = Math.min(viewportWidth - edge, rect.x + rect.width + pad);
        const bottom = Math.min(viewportHeight - edge, rect.y + rect.height + pad);
        return right - left >= 8 && bottom - top >= 8
          ? { left, top, width: right - left, height: bottom - top }
          : { left: rect.x - pad, top: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
      })()
    : null;
  const pointer = step.pointer ?? (step.done ? "click" : "none");
  // The card can be dragged by its head out of the way of what the step is about; it stays
  // where it was put for the rest of the tutorial.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; fromX: number; fromY: number } | null>(null);
  // A look-only step has no pointer travelling to it, so a dot runs from the card to the marker
  // once, to carry the eye there.
  const runs = pointer === "none" && !!rect && !reached;
  const runnerStyle = rect
    ? ({
        "--fx": `${cardFrom.x}px`,
        "--fy": `${cardFrom.y}px`,
        "--tx": `${rect.x + rect.width / 2}px`,
        "--ty": `${rect.y + rect.height / 2}px`,
      } as CSSProperties)
    : undefined;
  return (
    <div className="gl-tour" data-tour-step={step.id}>
      {runs && <div key={`${step.id}|${specKey}|runner`} className="gl-tour-runner" aria-hidden="true" style={runnerStyle} />}
      {marker && (
        <div
          key={`${step.id}|${specKey}`}
          className={"gl-tour-ring" + (reached ? " is-reached" : "") + (runs ? " is-late" : "")}
          aria-hidden="true"
          style={marker}
        >
          <span className="gl-tour-band" />
          {!reached && <span className="gl-tour-ripple" />}
        </div>
      )}
      {pointerRect && pointer !== "none" && !reached && (
        <TourPointer kind={pointer} rect={pointerRect} from={cardFrom} />
      )}
      <aside
        className={"gl-tour-card" + (cardAtRight ? "" : " is-left")}
        role="dialog"
        aria-label={t("Tutorial")}
        aria-live="polite"
        style={offset.x || offset.y ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
      >
        <div className="gl-tour-progress" aria-hidden="true"><span style={{ width: `${((index + 1) / total) * 100}%` }} /></div>
        <div
          className="gl-tour-card-head"
          title={t("Drag to move the card")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, fromX: offset.x, fromY: offset.y };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const held = drag.current;
            if (!held || held.pointerId !== event.pointerId) return;
            setOffset({ x: held.fromX + event.clientX - held.startX, y: held.fromY + event.clientY - held.startY });
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId === event.pointerId) drag.current = null;
          }}
          onPointerCancel={() => { drag.current = null; }}
        >
          <span>{t("Tutorial")} · {t(chapter.title)}</span>
          <span>{t("Step {index} of {total}", { index: index + 1, total })}</span>
        </div>
        <h4>{title}</h4>
        <p>{body}</p>
        {place && (
          <p className="gl-tour-place">
            <span>{place.text}</span>
            <button type="button" className="gl-mini-btn" onClick={onArrive}>{place.action}</button>
          </p>
        )}
        <p className={"gl-tour-status" + (reached || held ? " is-reached" : "")} role="status">
          {reached ? t("Done") : held ? t("Already done") : step.done && !place ? t("Waiting for you to do this…") : ""}
        </p>
        <div className="gl-tour-card-actions">
          <button type="button" className="gl-mini-btn" onClick={onBack} disabled={index === 0}>{t("Back")}</button>
          <button type="button" className="gl-mini-btn" onClick={onNext}>{step.done && !held ? t("Skip") : index + 1 === total ? t("Finish") : t("Next")}</button>
          <span className="gl-tour-card-spacer" />
          <button type="button" className="gl-mini-btn gl-tour-end" onClick={onEnd}>{t("End tutorial")}</button>
        </div>
      </aside>
    </div>
  );
}
