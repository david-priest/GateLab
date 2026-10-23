// HelpHint.tsx — the small "?" beside a control or a pane's title (David, 2026-10-23: "That
// question mark … does nothing?"). A ghost icon button: a click opens its hint in a small popover,
// set out as a short list where the hint is "·"-separated, and Escape, a click outside or a second
// click closes it; hovering still shows the hint as the button's tooltip. Given `onClick` instead
// of a hint, it is the same button doing that one thing (a tab's "?" that brings its introduction
// back). It replaced three kinds of "?": a text "?" in a circle, a bare HelpIcon, and TabIntro's.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { HelpIcon } from "./icons";
import { useI18n } from "./i18n";

type Props = { className?: string } & (
  | { topic: string; text: string; onClick?: undefined; label?: undefined }
  | { onClick: () => void; label: string; tooltip?: string; topic?: undefined; text?: undefined }
);

export function HelpHint(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const hint = props.text;

  // The popover is placed against the window, so a pane's scroll box cannot clip it: below the
  // button, or above it with no room below, inside the window either way.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const button = root.current?.querySelector("button")?.getBoundingClientRect();
    const box = popover.current?.getBoundingClientRect();
    if (!button || !box) return;
    const margin = 8;
    let top = button.bottom + 4;
    if (top + box.height > window.innerHeight - margin && button.top - 4 - box.height >= margin) top = button.top - 4 - box.height;
    const left = Math.max(margin, Math.min(button.left, window.innerWidth - margin - box.width));
    setPlace({ position: "fixed", top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  if (props.onClick) {
    return (
      <button type="button" className={`gl-help-hint${props.className ? ` ${props.className}` : ""}`} aria-label={props.label} title={props.tooltip ?? props.label} onClick={props.onClick}>
        <HelpIcon size={14} />
      </button>
    );
  }
  const items = (hint ?? "").split(" · ").map((item) => item.trim()).filter(Boolean);
  return (
    <span ref={root} className={`gl-help-hint-anchor${props.className ? ` ${props.className}` : ""}`}>
      <button
        type="button"
        className="gl-help-hint"
        aria-label={t("Help: {topic}", { topic: props.topic })}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={hint}
        onClick={() => setOpen((was) => !was)}
      >
        <HelpIcon size={14} />
      </button>
      {open && (
        <div ref={popover} id={id} className="gl-help-hint-popover" role="dialog" aria-label={props.topic} style={place ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" }}>
          {items.length > 1 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{hint}</p>}
        </div>
      )}
    </span>
  );
}
