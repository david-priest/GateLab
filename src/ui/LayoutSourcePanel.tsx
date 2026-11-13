// LayoutSourcePanel.tsx — where a Layout block's data comes from, shown three ways: under "Data"
// in the inspector for the selected block, as a note when the pointer rests on a block on the
// sheet (outside the sheet, so never exported), and, for a legend text block, the day it was
// written with a button that writes it again. The descriptions come from layoutSources.ts.

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FoldSummary } from "./FoldSummary";
import { useI18n } from "./i18n";
import { SOURCE_PLACEHOLDERS, sourcePlaceholderValues, sourceRows, type BlockSource } from "./layoutSources";
import "./layoutSources.css";

/** The rows of a block's Data list, as a definition list; a cut list has its full value in its title. */
function SourceList({ source }: Readonly<{ source: BlockSource }>) {
  const { t } = useI18n();
  return (
    <dl className="gl-layout-source-list">
      {sourceRows(source).map((row) => (
        <Fragment key={row.term}>
          <dt>{row.count === undefined ? t(row.term) : `${t(row.term)} (${row.count})`}</dt>
          <dd title={row.full}>{row.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** The inspector's "Data" section for the selected block, with the source placeholders its title and text may use. */
export function LayoutSourcePanel({ source }: Readonly<{ source: BlockSource | null }>) {
  const { t } = useI18n();
  if (!source) return null;
  const values = sourcePlaceholderValues(source);
  return (
    <section className="gl-layout-source" aria-label={t("Data")}>
      <strong>{t("Data")}</strong>
      <SourceList source={source} />
      <details className="gl-layout-source-placeholders">
        <FoldSummary>{t("Placeholders")}</FoldSummary>
        <p className="gl-hint">{t("This block's title, and a text block that reads from it, may use these. {n} stays the page number of an iteration.")}</p>
        <dl className="gl-layout-source-list">
          {SOURCE_PLACEHOLDERS.map(({ token, label }) => (
            <Fragment key={token}>
              <dt><code>{token}</code></dt>
              <dd title={t(label)}>{values[token.slice(1, -1)] || "–"}</dd>
            </Fragment>
          ))}
        </dl>
      </details>
    </section>
  );
}

/** How long the pointer rests on a block before its note shows, ms. */
export const SOURCE_HOVER_DELAY = 500;

/**
 * The note shown when the pointer rests on a block of the sheet for half a second: what the
 * inspector's Data list says. It is drawn on the document, outside the sheet, so an export never
 * takes it; a press, a drag or the wheel hides it. The block's own title tooltip is held back
 * while the note shows, so the two do not cover each other.
 */
export function LayoutSourceHover({
  container,
  describe,
}: Readonly<{
  /** The sheet whose `.gl-layout-item` blocks are watched. */
  container: HTMLElement | null;
  /** The description of a block by its page id; null for one that draws no data. */
  describe: (pageItemId: string) => BlockSource | null;
}>) {
  const [shown, setShown] = useState<{ source: BlockSource; x: number; y: number } | null>(null);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  useEffect(() => {
    if (!container) return;
    let timer = 0;
    let over: HTMLElement | null = null;
    let held: { element: HTMLElement; title: string } | null = null;
    const restore = () => {
      if (held) held.element.setAttribute("title", held.title);
      held = null;
    };
    const hide = () => {
      window.clearTimeout(timer);
      timer = 0;
      restore();
      setShown(null);
    };
    const onMove = (event: MouseEvent) => {
      if (event.buttons) {
        over = null;
        hide();
        return;
      }
      const element = (event.target as Element | null)?.closest?.<HTMLElement>(".gl-layout-item") ?? null;
      if (element === over) return;
      over = element;
      hide();
      const id = element?.dataset.itemId;
      if (!element || !id) return;
      const at = { x: event.clientX, y: event.clientY };
      timer = window.setTimeout(() => {
        timer = 0;
        const source = describeRef.current(id);
        if (!source) return;
        const title = element.getAttribute("title");
        if (title !== null) {
          held = { element, title };
          element.removeAttribute("title");
        }
        setShown({ source, ...at });
      }, SOURCE_HOVER_DELAY);
    };
    const onLeave = () => {
      over = null;
      hide();
    };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    container.addEventListener("mousedown", onLeave, true);
    container.addEventListener("wheel", onLeave, { passive: true });
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("mousedown", onLeave, true);
      container.removeEventListener("wheel", onLeave);
      window.clearTimeout(timer);
      restore();
    };
  }, [container]);
  if (!shown || typeof document === "undefined") return null;
  const width = 360;
  const left = Math.max(8, Math.min(shown.x + 14, (window.innerWidth || width + 16) - width - 8));
  return createPortal(
    <div className="gl-layout-source-tip" role="tooltip" style={{ left, top: shown.y + 16, maxWidth: width }}>
      <SourceList source={shown.source} />
    </div>,
    document.body,
  );
}

/**
 * The inspector's note on a legend text block: the day it was written and a button that writes it
 * again from the sheet as it is now, replacing its text after a confirmation. In the Japanese
 * interface it says the legend is written in English.
 */
export function LayoutLegendMark({ date, onRegenerate }: Readonly<{ date: string; onRegenerate: () => void }>) {
  const { t, language } = useI18n();
  return (
    <div className="gl-layout-legend-mark">
      <span>{t("Legend written {date}", { date })}</span>
      <button
        type="button"
        className="gl-mini-btn"
        title={t("Write this legend again from the sheet as it is now")}
        onClick={() => {
          if (window.confirm(t("Replace this legend's text with a new one written from the sheet? Edits made to it are lost; Undo brings them back."))) onRegenerate();
        }}
      >
        {t("Regenerate")}
      </button>
      {language !== "en" && <p className="gl-hint">{t("The legend is written in English, as journals take it.")}</p>}
    </div>
  );
}
