// layoutFollow.ts — whether blocks added to a Layout sheet from another tab follow the sheet's
// iteration, as a block added from the Layout tab's own toolbar does.

import { isPlotLikeRecipe, type LayoutPlotRecipe, type LayoutRecipe, type LayoutSheet, type LayoutStrategyRecipe } from "../engine/layout";

/**
 * Recipes added together to a sheet, marked to follow its iteration as a plot added from the
 * Layout toolbar is, from whichever tab they come. Plots that differ in what the iteration
 * varies (several files under a file or metadata iteration, several populations under a
 * population iteration) keep their own, since following would draw them all alike; a pooled
 * plot keeps its pool under a file iteration, which draws one file per page.
 */
export function followSheetIteration<R extends LayoutRecipe>(sheet: Pick<LayoutSheet, "iteration">, recipes: readonly R[]): R[] {
  const mode = sheet.iteration?.mode ?? "off";
  if (mode === "off") return [...recipes];
  const plotLike = recipes.filter((recipe) => isPlotLikeRecipe(recipe)) as (LayoutPlotRecipe | LayoutStrategyRecipe)[];
  const varies = mode === "populations" ? new Set(plotLike.map((r) => r.populationId)).size > 1 : new Set(plotLike.map((r) => r.sampleId)).size > 1;
  if (varies) return [...recipes];
  return recipes.map((recipe) => {
    if (!isPlotLikeRecipe(recipe)) return recipe;
    if (mode === "files" && recipe.kind !== "strategy" && recipe.pool && recipe.pool.sampleIds.length > 1) return recipe;
    return { ...recipe, iterated: true };
  });
}
