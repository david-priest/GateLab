// figureStyle.tsx — the workspace's figure style in the interface: the context every tab reads it
// from, the line a tab shows in place of its own text-size and line-width inputs while it follows
// the style, and the one editor for it, opened from that line in any tab. The style is stored in
// px (engine/figureStyle.ts), as each tab stores its own; the editor shows points (1 pt = 4/3 px).
// The gates' line width and colour shown in the editor are the workspace's gate ink (gateInk.ts),
// the setting the Gating tab's Display and every other tab already share.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_FIGURE_STYLE, normalizeFigureStyle, type FigureStyle, type FigureStyleKey } from "../engine/figureStyle";
import { createDefaultLayoutWorkspace, LAYOUT_STYLE_RANGES, type LayoutPlotStyle, type LayoutWorkspace } from "../engine/layout";
import { DEFAULT_GATE_LINE_WIDTH, MAX_GATE_LINE_WIDTH, MIN_GATE_LINE_WIDTH, useGateInk, type GateInk } from "../plots/gateInk";
import { useI18n } from "./i18n";
import { NumberField } from "./NumberField";
import { ModalEscape } from "./useModalEscape";

/** CSS px in a point. */
export const PX_PER_PT = 4 / 3;
/** A size in px as points. */
export const ptFromPx = (px: number): number => px / PX_PER_PT;
/** A size in points as px, to 0.01 px. */
export const pxFromPt = (pt: number): number => Math.round(pt * PX_PER_PT * 100) / 100;
const formatPt = (pt: number): string => String(Math.round(pt * 100) / 100);

export interface FigureStyleContextValue {
  style: FigureStyle;
  setStyle: (next: FigureStyle) => void;
  /** Open the editor. */
  openEditor: () => void;
}

/** Outside the app (a component on its own, in a test) the style is the defaults and nothing is set. */
export const FigureStyleContext = createContext<FigureStyleContextValue>({
  style: DEFAULT_FIGURE_STYLE,
  setStyle: () => undefined,
  openEditor: () => undefined,
});

export function useFigureStyle(): FigureStyleContextValue {
  return useContext(FigureStyleContext);
}

/** What a Layout sheet that follows the style takes from the workspace: the style's sizes, and the gate ink's width and colour. */
export function figureLayoutFields(style: FigureStyle, ink: Pick<GateInk, "coloured" | "lineWidth">): Partial<LayoutPlotStyle> {
  return { ...style, gateLineWidth: ink.lineWidth, pubStyle: !ink.coloured };
}

/** figureLayoutFields of the workspace's style and gate ink. */
export function useFigureLayoutFields(): Partial<LayoutPlotStyle> {
  const { style } = useFigureStyle();
  const { coloured, lineWidth } = useGateInk();
  return useMemo(() => figureLayoutFields(style, { coloured, lineWidth }), [style, coloured, lineWidth]);
}

/** A new workspace's layout: one blank sheet, which uses the figure style. */
export function newFigureLayoutWorkspace(): LayoutWorkspace {
  const workspace = createDefaultLayoutWorkspace();
  for (const sheet of workspace.sheets) sheet.followFigureStyle = true;
  return workspace;
}

/** The style and its editor, for the tabs within. */
export function FigureStyleProvider({ style, onChange, children }: Readonly<{ style: FigureStyle; onChange: (next: FigureStyle) => void; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  const value = useMemo<FigureStyleContextValue>(
    () => ({ style, setStyle: (next) => onChange(normalizeFigureStyle(next)), openEditor: () => setOpen(true) }),
    [style, onChange],
  );
  return (
    <FigureStyleContext.Provider value={value}>
      {children}
      {open && <FigureStyleEditor onClose={() => setOpen(false)} />}
    </FigureStyleContext.Provider>
  );
}

const TEXT_FIELDS: readonly { key: FigureStyleKey; label: string }[] = [
  { key: "fontTick", label: "Tick" },
  { key: "fontAxis", label: "Axis" },
  { key: "fontTitle", label: "Title" },
  { key: "fontLegend", label: "Legend" },
  { key: "fontGate", label: "Gate label" },
];

/** The workspace's figure style: text sizes and line widths in points, and the gates' colour. */
export function FigureStyleEditor({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useI18n();
  const { style, setStyle } = useFigureStyle();
  const ink = useGateInk();
  const set = (key: FigureStyleKey, pt: number) => setStyle({ ...style, [key]: pxFromPt(pt) });
  const ptRange = (key: FigureStyleKey) => LAYOUT_STYLE_RANGES[key].map(ptFromPx) as [number, number];
  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={onClose} />
      <div className="gl-modal gl-figure-style-editor" role="dialog" aria-modal="true" aria-label={t("Figure style")} style={{ maxWidth: 460 }}>
        <div className="gl-modal-title">{t("Figure style")}</div>
        <div className="gl-modal-note">{t("Every Layout sheet, Plotting chart, Illustration figure and Strategy view that uses the workspace figure style is drawn with these sizes.")}</div>
        <fieldset className="gl-figure-style-fields">
          <legend>{t("Text sizes (pt)")}</legend>
          {TEXT_FIELDS.map(({ key, label }) => (
            <label key={key} className="gl-field-inline">
              {t(label)}
              <NumberField aria-label={t(label)} value={ptFromPx(style[key])} min={ptRange(key)[0]} max={ptRange(key)[1]} step={0.5} format={formatPt} onCommit={(pt) => set(key, pt)} />
            </label>
          ))}
        </fieldset>
        <fieldset className="gl-figure-style-fields">
          <legend>{t("Line widths (pt)")}</legend>
          <label className="gl-field-inline">
            {t("Histogram line width")}
            <NumberField aria-label={t("Histogram line width")} value={ptFromPx(style.histLineWidth)} min={ptRange("histLineWidth")[0]} max={ptRange("histLineWidth")[1]} step={0.25} format={formatPt} onCommit={(pt) => set("histLineWidth", pt)} />
          </label>
          <label className="gl-field-inline">
            {t("Gate line width")}
            <NumberField aria-label={t("Gate line width")} value={ptFromPx(ink.lineWidth)} min={ptFromPx(MIN_GATE_LINE_WIDTH)} max={ptFromPx(MAX_GATE_LINE_WIDTH)} step={0.25} format={formatPt} onCommit={(pt) => ink.setLineWidth(pxFromPt(pt))} />
          </label>
        </fieldset>
        <label className="gl-check">
          <input type="checkbox" className="gl-coloured-gates-mirror" checked={ink.coloured} onChange={(event) => ink.setColoured(event.target.checked)} />
          {t("Coloured gates")}
        </label>
        <div className="gl-modal-note">{t("The gate line width and colour are the workspace's gate settings, shared with the Gating tab's Display.")}</div>
        <div className="gl-modal-actions">
          <button
            type="button"
            className="gl-btn-ghost"
            onClick={() => {
              setStyle({ ...DEFAULT_FIGURE_STYLE });
              ink.setLineWidth(DEFAULT_GATE_LINE_WIDTH);
              ink.setColoured(false);
            }}
          >
            {t("Reset to defaults")}
          </button>
          <button type="button" className="gl-btn" onClick={onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * In a tab's style section: while the tab follows the workspace's figure style, the line that
 * stands in for its own text-size and line-width inputs, with the button that opens the editor;
 * otherwise the button that makes it follow.
 */
export function FigureStyleFollow({ following, onFollow }: Readonly<{ following: boolean; onFollow: (follow: boolean) => void }>) {
  const { t } = useI18n();
  const { openEditor } = useFigureStyle();
  return following ? (
    <div className="gl-figure-style-follow">
      <span>{t("Using the workspace figure style")}</span>
      <button type="button" className="gl-mini-btn" onClick={openEditor}>{t("Edit figure style")}</button>
      <button type="button" className="gl-mini-btn" title={t("Set the text sizes and line widths in this tab instead")} onClick={() => onFollow(false)}>{t("Set in this tab")}</button>
    </div>
  ) : (
    <div className="gl-figure-style-follow">
      <button type="button" className="gl-mini-btn" title={t("Take the text sizes and line widths from the workspace figure style, shared with the other tabs")} onClick={() => onFollow(true)}>{t("Use the workspace figure style")}</button>
    </div>
  );
}
