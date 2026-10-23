// ColourPopover.tsx — a small palette at a point on the page, with a free colour picker: a gate's
// colour from its right-click or row menu. Closes on a choice, on Done, on Escape or on a click
// elsewhere, as the context menu it was opened from does.

import { useEffect, useRef } from "react";
import { useI18n } from "./i18n";

export function ColourPopover({
  x, y, label, value, palette, onPick, onClose,
}: {
  x: number;
  y: number;
  /** Names what is being coloured, for screen readers: "Colour of Cells". */
  label: string;
  value: string;
  palette: readonly string[];
  /** A swatch picks and closes; the free picker picks as it moves and stays open. */
  onPick: (colour: string, close: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const left = Math.max(4, Math.min(x, window.innerWidth - 180));
  const top = Math.max(4, Math.min(y, window.innerHeight - 110));
  return (
    <div ref={root} className="gl-colour-popover gl-group-colour-pop" role="dialog" aria-label={label} style={{ position: "fixed", left, top, right: "auto" }}>
      {palette.map((colour) => (
        <button
          key={colour}
          type="button"
          className={"gl-group-colour-swatch" + (colour.toLowerCase() === value.toLowerCase() ? " is-current" : "")}
          style={{ background: colour }}
          aria-label={colour}
          aria-pressed={colour.toLowerCase() === value.toLowerCase()}
          onClick={() => onPick(colour, true)}
        />
      ))}
      <input
        type="color"
        className="gl-group-colour-custom"
        aria-label={t("Another colour")}
        defaultValue={value}
        onChange={(event) => onPick(event.currentTarget.value, false)}
      />
      <button type="button" className="gl-mini-btn" onClick={onClose}>{t("Done")}</button>
    </div>
  );
}
