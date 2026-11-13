// chartXAxis.ts — what a per-cell or statistic chart lays along x: the populations with a panel
// per group, the groups with a panel per population, or ("together") the groups with every
// population side by side at each group in one panel (settings.populationsTogether).

import type { ProportionsSettings } from "../../engine/proportionsSettings";

export type ChartXAxis = ProportionsSettings["xAxis"] | "together";

/** The chart's layout along x from its settings: "together" with the groups along x and populationsTogether set. */
export function chartXAxis(settings: Pick<ProportionsSettings, "xAxis"> & Partial<Pick<ProportionsSettings, "populationsTogether">>): ChartXAxis {
  return settings.xAxis === "groups" && settings.populationsTogether ? "together" : settings.xAxis;
}

/** The settings a layout along x stands for, as chartPanelDimensions and chartPageDimension read them. */
export function xAxisFields(xAxis: ChartXAxis): Pick<ProportionsSettings, "xAxis" | "populationsTogether"> {
  return xAxis === "together" ? { xAxis: "groups", populationsTogether: true } : { xAxis };
}
