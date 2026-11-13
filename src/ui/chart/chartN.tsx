// chartN.tsx — the n a Plotting chart writes under each mark when "Show n" is on: the cells a
// violin or box draws (with its files, where it pools more than one), or the replicate units a
// box, bar or point summary stands on, and what those units are, once on the value axis's title.
// The numbers are those the tooltips and the chart's table give; they are counted here.

import { SAMPLE_ID_FIELD } from "../../engine/metadata";
import { PROPORTIONS_NO_FACTOR, PROPORTIONS_SAMPLE_FACTOR } from "../../engine/proportionsSettings";
import { longestLabelWidth, nLineHeight } from "./chartLayout";

/** A mark's n as written under it: "n = 265", with "(3 files)" on a second line where it pools files. */
export function nLines(n: number, files = 1): string[] {
  const count = `n = ${n.toLocaleString("en-US")}`;
  return files > 1 ? [count, `(${files} files)`] : [count];
}

/** A violin's or box's n: its cells and the files they come from. */
export function cellMarkN(mark: { values: ArrayLike<number>; files: readonly string[] }): string[] {
  return nLines(mark.values.length, mark.files.length);
}

/**
 * A violin's or box's n with the replicate units its replicate marks summarise: "(3 files, 2 Donor)"
 * on the second line. Where each file is its own unit the files already count the units.
 */
export function cellMarkNWithUnits(mark: { values: ArrayLike<number>; files: readonly string[] }, units: number, unitSel: string | undefined): string[] {
  if (!unitSel || unitSel === PROPORTIONS_SAMPLE_FACTOR || unitSel === PROPORTIONS_NO_FACTOR) return cellMarkN(mark);
  const files = mark.files.length;
  return [`n = ${mark.values.length.toLocaleString("en-US")}`, `(${files} ${files === 1 ? "file" : "files"}, ${units} ${nUnitName(unitSel)})`];
}

/** What a replicate unit is, for "n: files" or "n: Sample ID": files, or the Replicate unit's column. */
export function nUnitName(unitSel: string | undefined): string {
  if (!unitSel || unitSel === PROPORTIONS_SAMPLE_FACTOR || unitSel === PROPORTIONS_NO_FACTOR) return "files";
  if (unitSel === SAMPLE_ID_FIELD) return "Sample ID";
  return unitSel;
}

/** The value axis's title with what n counts at the end of its line. */
export function withNUnit(title: string, unitSel: string | undefined): string {
  return `${title} · n: ${nUnitName(unitSel)}`;
}

/** The lines of n a panel needs under its labels, and the width a slot needs to hold them. */
export function nRowSize(slots: readonly (readonly string[])[], tickFont: number): { rows: number; width: number } {
  const rows = Math.max(0, ...slots.map((lines) => lines.length));
  return { rows, width: rows ? longestLabelWidth(slots.flat(), tickFont) + 8 : 0 };
}

export interface ChartNRowProps {
  /** Each slot's centre and its lines of n; a slot without lines writes nothing. */
  ticks: readonly { x: number; lines: readonly string[] }[];
  /** The first line's baseline in the panel. */
  baseline: number;
  tickFont: number;
}

export function ChartNRow({ ticks, baseline, tickFont }: ChartNRowProps) {
  const line = nLineHeight(tickFont);
  return (
    <>
      {ticks.flatMap((tick, i) =>
        tick.lines.map((text, li) => (
          <text key={`n${i}-${li}`} className="gl-prop-n" x={tick.x} y={baseline + li * line} textAnchor="middle" fontSize={tickFont} fill="#475569">
            {text}
          </text>
        )),
      )}
    </>
  );
}
