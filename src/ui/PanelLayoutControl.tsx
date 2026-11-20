// PanelLayoutControl.tsx — how a Plotting chart lays out its panels, as two plain questions: what
// is drawn inside each panel (the populations or the groups, one of which always is), and where
// the panels for each other dimension go (columns, rows, wrapped or pages). A line under them says
// what the chart will draw. It replaces the drag-and-drop shelves, whose chips moved one another
// without saying so (David, 2026-11-20).

import type { ReactNode } from "react";
import { useI18n } from "./i18n";
import type { ChartDimension, ChartShelf, ChartShelves } from "./plottingShelves";

/** Where a panel dimension can go, in the order the menus list them. */
export const PANEL_PLACES = ["columns", "rows", "wrap", "pages"] as const satisfies readonly ChartShelf[];
export type PanelPlace = (typeof PANEL_PLACES)[number];

/** Each panel dimension and where it sits, in the order the chart nests them. */
export function panelPlacements(shelves: ChartShelves): { dimension: ChartDimension; place: PanelPlace }[] {
  return [
    ...shelves.columns.map((dimension) => ({ dimension, place: "columns" as const })),
    ...shelves.rows.map((dimension) => ({ dimension, place: "rows" as const })),
    ...shelves.wrap.map((dimension) => ({ dimension, place: "wrap" as const })),
    ...shelves.pages.map((dimension) => ({ dimension, place: "pages" as const })),
  ];
}

/**
 * The dimensions whose place changed between two arrangements, other than the one moved: what a
 * move did besides what was asked, said under the control so nothing moves unseen.
 */
export function movedAlong(before: ChartShelves, after: ChartShelves, moved: ChartDimension): { dimension: ChartDimension; place: PanelPlace | "x" }[] {
  const placeIn = (shelves: ChartShelves) => {
    const out = new Map<ChartDimension, PanelPlace | "x">(panelPlacements(shelves).map(({ dimension, place }) => [dimension, place]));
    for (const dimension of shelves.x) out.set(dimension, "x");
    return out;
  };
  const was = placeIn(before);
  const now = placeIn(after);
  return [...now].filter(([dimension, place]) => dimension !== moved && was.has(dimension) && was.get(dimension) !== place).map(([dimension, place]) => ({ dimension, place }));
}

function listed(names: string[], and: string): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`;
}

/**
 * One sentence saying what the arrangement draws: the panels by column, row, wrap and page, and
 * the marks inside each panel. `noun` names a dimension's values in the singular ("population",
 * "file", "condition"); `mark` is what each value inside a panel is drawn as ("a ridge").
 */
export function panelLayoutSummary(
  shelves: ChartShelves,
  noun: (dimension: ChartDimension) => string,
  mark: string,
  panelsPerRow: number,
  t: (text: string, values?: Record<string, string>) => string,
  /** Every population in one panel, side by side at each group. */
  together = false,
): string {
  const and = t("and");
  const names = (dimensions: ChartDimension[]) => listed(dimensions.map(noun), and);
  const parts: string[] = [];
  if (shelves.columns.length) parts.push(t("a column per {name}", { name: names(shelves.columns) }));
  if (shelves.rows.length) parts.push(t("a row per {name}", { name: names(shelves.rows) }));
  if (shelves.wrap.length) {
    // With Columns set the wrapped panels run down the rows, with Rows alone across the columns.
    if (shelves.columns.length) parts.push(t("the panels for each {name} down the rows", { name: names(shelves.wrap) }));
    else if (shelves.rows.length) parts.push(t("the panels for each {name} across the columns", { name: names(shelves.wrap) }));
    else parts.push(t("a panel per {name}, {count} to a row", { name: names(shelves.wrap), count: String(panelsPerRow) }));
  }
  if (shelves.pages.length) parts.push(t("a page per {name}, one shown at a time", { name: names(shelves.pages) }));
  const panels = parts.length ? listed(parts, and) : t("one panel");
  const inside = together
    ? t("in each panel, {mark} per population at each {name}", { mark, name: names(shelves.x) })
    : shelves.stack
      ? t("in each panel, a bar per {name}, its populations stacked", { name: names(shelves.x) })
      : t("in each panel, {mark} per {name}", { mark, name: names(shelves.x) });
  const sentence = `${panels}; ${inside}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface PanelLayoutControlProps {
  shelves: ChartShelves;
  /** A dimension's name in the control ("Populations", "Sample ID"). */
  label: (dimension: ChartDimension) => string;
  /** The dimensions that may be drawn inside each panel; two make a choice, one is shown fixed. */
  insideChoices: readonly ChartDimension[];
  /** How the inside dimension runs: "Along the x axis." or "As ridges, top to bottom." */
  insideHint: string;
  canPlace: (dimension: ChartDimension, place: ChartShelf) => boolean;
  onPlace: (dimension: ChartDimension, place: ChartShelf) => void;
  /** What the last move did besides what was asked; null when nothing else moved. */
  note: string | null;
  summary: string;
  /** The Per row field, shown while a dimension is wrapped. */
  perRow: ReactNode;
}

export function PanelLayoutControl({ shelves, label, insideChoices, insideHint, canPlace, onPlace, note, summary, perRow }: PanelLayoutControlProps) {
  const { t } = useI18n();
  const placeLabel: Record<PanelPlace, string> = { columns: t("In columns"), rows: t("In rows"), wrap: t("Wrapped"), pages: t("On pages") };
  const inside = shelves.x[0];
  const placements = panelPlacements(shelves);
  return (
    <div className="gl-prop-arrange" role="group" aria-labelledby="prop-arrange-heading">
      <h3 id="prop-arrange-heading">{t("Panels")}</h3>
      <div className="gl-prop-arrange-inside" role="radiogroup" aria-label={t("Inside each panel")}>
        <span className="gl-prop-arrange-label">{t("Inside each panel")}</span>
        {insideChoices.length > 1 ? (
          insideChoices.map((dimension) => (
            <label key={dimension} className="gl-check">
              <input type="radio" name="prop-inside" value={dimension} checked={inside === dimension} onChange={() => onPlace(dimension, "x")} />
              {label(dimension)}
            </label>
          ))
        ) : (
          <strong className="gl-prop-arrange-fixed">{label(inside)}</strong>
        )}
        <p className="gl-hint">{insideHint}</p>
      </div>
      <div className="gl-prop-arrange-panels">
        <span className="gl-prop-arrange-label">{t("One panel per value of")}</span>
        {placements.length === 0 && <p className="gl-hint">{t("Nothing: the chart is one panel.")}</p>}
        {placements.map(({ dimension, place }) => (
          <label key={dimension} className="gl-field-inline gl-prop-arrange-row" data-dimension={dimension}>
            <span>{label(dimension)}</span>
            <select aria-label={`Place ${label(dimension)}`} value={place} onChange={(event) => onPlace(dimension, event.target.value as ChartShelf)}>
              {PANEL_PLACES.map((option) => (
                <option key={option} value={option} disabled={option !== place && !canPlace(dimension, option)}>
                  {placeLabel[option]}
                </option>
              ))}
            </select>
          </label>
        ))}
        {shelves.wrap.length > 0 && perRow}
      </div>
      {note && <p className="gl-hint gl-prop-arrange-note" role="status">{note}</p>}
      <p className="gl-prop-arrange-summary" aria-live="polite">{summary}</p>
    </div>
  );
}
