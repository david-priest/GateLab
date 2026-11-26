// textSizeMenu.ts — text size from a right-click on a drawn plot (David, 2026-11-26: "if I right
// click on a gate label it should have the option to take me to be able to increase that font
// size", and "increase font size" / "decrease font size" for every item clicked on). The plot
// renderer (mini_plot.js) marks no text with its kind, but its markup places each kind apart: tick
// labels in the `.x-axis` / `.y-axis` groups, gate labels in `.gate-overlay-labels`, the plot title
// straight on the panel's svg, and the axis titles as the other plain texts of the plot's group.
// Display only: a size is a tab's or the workspace figure style's, never a gate's.

import { LAYOUT_STYLE_RANGES } from "../engine/layout";
import type { FigureStyle } from "../engine/figureStyle";
import type { MenuEntry } from "./MenuButton";
import { ptFromPx, pxFromPt, type TabTextSize } from "./figureStyle";

export type PlotTextKind = TabTextSize["key"];

/** What a right-click landed on in a drawn plot: the kind of text, or null for anything else. */
export function plotTextKind(target: EventTarget | null): PlotTextKind | null {
  if (!(target instanceof Element)) return null;
  const text = target.closest("text");
  if (!text) return null;
  if (text.closest(".x-axis, .y-axis")) return "fontTick";
  if (text.closest(".gate-overlay-labels")) return "fontGate";
  const parent = text.parentElement;
  if (!parent) return null;
  if (parent.tagName.toLowerCase() === "svg") return "fontTitle";
  // An axis title: a plain text in the plot's own group, which sits on the panel's svg.
  if (parent.tagName.toLowerCase() === "g" && !parent.getAttribute("class") && parent.parentElement?.tagName.toLowerCase() === "svg" && !text.querySelector("tspan")) return "fontAxis";
  return null;
}

/** The kind's name in a menu, after "Larger" or "Smaller". */
const KIND_NAME: Record<PlotTextKind, string> = {
  fontTick: "tick label text",
  fontAxis: "axis title text",
  fontTitle: "plot title text",
  fontGate: "gate label text",
  fontLegend: "legend text",
};

/** A size one step larger or smaller: a point on the workspace figure style, a pixel on a tab's own sizes, within the range. */
export function steppedTextSize(px: number, step: 1 | -1, following: boolean, range: readonly [number, number]): number {
  const next = following ? pxFromPt(Math.round(ptFromPx(px) * 2) / 2 + step) : Math.round(px) + step;
  return Math.min(range[1], Math.max(range[0], next));
}

export interface TextSizeMenuOptions {
  /** What the right-click landed on; null shows only the way to the sizes. */
  kind: PlotTextKind | null;
  /** The sizes the tab draws with, as its Typography shows them. */
  sizes: readonly TabTextSize[];
  /** The tab takes its sizes from the workspace figure style. */
  following: boolean;
  style: FigureStyle;
  setStyle: (next: FigureStyle) => void;
  /** Show the tab's text sizes, with the field for `kind` in focus. */
  onShowSizes: (kind: PlotTextKind | null) => void;
  t: (text: string, values?: Record<string, string>) => string;
}

/**
 * The menu entries for a right-click on a drawn plot: for text the tab sizes, "Larger …" and
 * "Smaller …", each one step; then "Text sizes…", which shows the tab's sizes.
 */
export function textSizeMenuEntries({ kind, sizes, following, style, setStyle, onShowSizes, t }: TextSizeMenuOptions): MenuEntry[] {
  const size = kind ? sizes.find((entry) => entry.key === kind) : undefined;
  const show: MenuEntry = {
    label: t("Text sizes…"),
    title: following ? t("The workspace figure style's text sizes, shared with the other tabs") : t("This tab's text sizes"),
    onClick: () => onShowSizes(size ? kind : null),
  };
  if (!kind || !size) return [show];
  const current = following ? style[kind] : size.value;
  const range: readonly [number, number] = following ? LAYOUT_STYLE_RANGES[kind] : [size.min, size.max];
  const shown = following ? `${Math.round(ptFromPx(current) * 10) / 10} pt` : `${Math.round(current)} px`;
  const apply = (step: 1 | -1) => {
    const next = steppedTextSize(current, step, following, range);
    if (next === current) return;
    if (following) setStyle({ ...style, [kind]: next });
    else size.onCommit(next);
  };
  const scope = following ? t("in every tab that uses the workspace figure style") : t("in this tab");
  return [
    {
      label: t("Larger {name}", { name: t(KIND_NAME[kind]) }),
      title: t("Now {size}; one step larger, {scope}", { size: shown, scope }),
      disabled: steppedTextSize(current, 1, following, range) === current,
      onClick: () => apply(1),
    },
    {
      label: t("Smaller {name}", { name: t(KIND_NAME[kind]) }),
      title: t("Now {size}; one step smaller, {scope}", { size: shown, scope }),
      disabled: steppedTextSize(current, -1, following, range) === current,
      onClick: () => apply(-1),
    },
    show,
  ];
}

/**
 * Brings a text size field into view and gives it the keyboard on the next frame, once the section
 * or dialog holding it is shown (`within` is read then): the field carries `data-text-size` with
 * its kind. Without one, the first size field.
 */
export function focusTextSizeField(within: () => ParentNode | null, kind: PlotTextKind | null): void {
  requestAnimationFrame(() => {
    const root = within();
    if (!root) return;
    const field =
      (kind && root.querySelector<HTMLElement>(`[data-text-size="${kind}"] input`)) ||
      root.querySelector<HTMLElement>("[data-text-size] input");
    if (!field) return;
    field.scrollIntoView({ block: "center" });
    field.focus({ preventScroll: true });
    if (field instanceof HTMLInputElement) field.select();
  });
}
