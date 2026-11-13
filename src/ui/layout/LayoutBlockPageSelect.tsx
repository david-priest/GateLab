/**
 * The Layout inspector's "Page" select for a block that draws one page of something with pages:
 * a figure block (the Illustration figure's pages) or a Plotting block (the chart's pages, by its
 * `pageBy`). The pages are listed by their labels, as the construction tab names them. With one
 * page or none there is nothing to choose, and nothing is shown.
 */
import { useMemo } from "react";
import type { DivisionProfileLike } from "../../engine/factors";
import { figureHierarchies, layoutFigure, type FigureSample } from "../../engine/figure";
import type { LayoutFigureRecipe, LayoutProportionsPanel, LayoutProportionsRecipe } from "../../engine/layout";
import type { CoreState } from "../../store";
import { useI18n } from "../i18n";
import { figureOfBlock } from "../LayoutFigure";
import { plottingBlockModels, proportionsSampleRefs } from "../LayoutProportions";
import { chartPageDimension, isPageSelector, panelDimensionText } from "../panelArrangement";
import { plottingFacetLevels, plottingGroupLevels } from "../plottingColours";
import { plottingPages } from "../plottingPanels";
import { proportionsFactorTitle } from "../ProportionsChart";

/** The labels of a figure block's pages, in the figure's order. */
export function figureBlockPageLabels(
  recipe: LayoutFigureRecipe,
  files: readonly FigureSample[],
  state: CoreState,
  columnLevels?: Readonly<Record<string, readonly string[]>>,
): string[] {
  try {
    const figure = figureOfBlock(recipe, files, state).figure;
    if (!figure) return [];
    return layoutFigure(figure, files, figureHierarchies(state), undefined, columnLevels).map((page) => page.label);
  } catch {
    return [];
  }
}

export function LayoutFigurePageSelect({
  recipe,
  files,
  state,
  columnLevels,
  onChange,
}: Readonly<{
  recipe: LayoutFigureRecipe;
  files: readonly FigureSample[];
  state: CoreState;
  columnLevels?: Readonly<Record<string, readonly string[]>>;
  /** The page chosen, 0-based. */
  onChange: (page: number) => void;
}>) {
  const { t } = useI18n();
  const labels = useMemo(() => figureBlockPageLabels(recipe, files, state, columnLevels), [recipe, files, state, columnLevels]);
  if (labels.length <= 1) return null;
  return (
    <label className="gl-field-inline" title={t("The page of the figure this block draws")}>
      {t("Page")}
      <select aria-label={t("Page")} value={Math.min(recipe.page, labels.length - 1)} onChange={(event) => onChange(Number(event.target.value))}>
        {labels.map((label, index) => (
          <option key={index} value={index}>{label || t("Page {n}", { n: index + 1 })}</option>
        ))}
      </select>
    </label>
  );
}

/** A Plotting block's pages, each with the label the Plotting tab's pager gives it; empty when the chart has no pages. */
export function chartBlockPages(
  recipe: LayoutProportionsRecipe,
  samples: readonly FigureSample[],
  state: CoreState,
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>,
  dataRevision: string | number,
  metadataLevels?: Readonly<Record<string, readonly string[]>>,
): { page: string; label: string }[] {
  const settings = recipe.settings;
  const { model, cellModel, channels } = plottingBlockModels(settings, samples, state, metadataById, divisionProfiles, dataRevision);
  const refs = proportionsSampleRefs(samples);
  const order = { groups: plottingGroupLevels(settings, refs, metadataById, metadataLevels), facets: plottingFacetLevels(settings, refs, metadataById, metadataLevels) };
  const keys = channels.length > 1 ? channels.map((part) => part.key) : undefined;
  const pages = plottingPages({ ...settings, ...(keys ? { channels: keys } : {}) }, cellModel ? null : model, cellModel, order);
  const dimension = chartPageDimension(settings, cellModel ? cellModel.hasFacet : model.hasFacet);
  const titles = { group: proportionsFactorTitle(settings.groupSel), facet: proportionsFactorTitle(settings.facetSel), channels: Object.fromEntries(channels.map((part) => [part.key, part.label])) };
  return pages.map((page) => ({ page, label: dimension ? panelDimensionText({ facet: page, group: page, population: page, channel: page }, dimension, titles) : page }));
}

/**
 * The page a Plotting block draws: one page of the chart, or the whole chart. Shown for a block of
 * the whole chart or of one page; a block of one panel or of the legend names that instead.
 */
export function LayoutProportionsPageSelect({
  recipe,
  samples,
  state,
  metadataById,
  divisionProfiles,
  dataRevision = "",
  metadataLevels,
  onChange,
}: Readonly<{
  recipe: LayoutProportionsRecipe;
  samples: readonly FigureSample[];
  state: CoreState;
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  dataRevision?: string | number;
  metadataLevels?: Readonly<Record<string, readonly string[]>>;
  /** The block's panel selector: a page, or none for the whole chart. */
  onChange: (panel: LayoutProportionsPanel | undefined) => void;
}>) {
  const { t } = useI18n();
  const eligible = !recipe.panel || isPageSelector(recipe.panel);
  const pages = useMemo(
    () => (eligible ? chartBlockPages(recipe, samples, state, metadataById, divisionProfiles, dataRevision, metadataLevels) : []),
    [eligible, recipe, samples, state, metadataById, divisionProfiles, dataRevision, metadataLevels],
  );
  if (pages.length <= 1) return null;
  const at = isPageSelector(recipe.panel) ? pages.findIndex((entry) => entry.page === (recipe.panel as { page: string }).page) : -1;
  return (
    <label className="gl-field-inline" title={t("The page of the chart this block draws, or the whole chart")}>
      {t("Page")}
      <select aria-label={t("Page")} value={at < 0 ? "" : String(at)} onChange={(event) => onChange(event.target.value === "" ? undefined : { page: pages[Number(event.target.value)].page })}>
        <option value="">{t("Whole chart")}</option>
        {pages.map((entry, index) => (
          <option key={entry.page} value={index}>{entry.label}</option>
        ))}
      </select>
    </label>
  );
}
