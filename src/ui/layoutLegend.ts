// layoutLegend.ts — a figure legend written from a Layout sheet's blocks: one sentence group per
// block, in reading order, each saying what the block shows, its files or groups with n and what
// n counts, the centre and spread drawn, and the test with its p values. Always English, as
// journals take it; the text is ordinary text once placed.

import type { LayoutTextRecipe } from "../engine/layout";
import { sizesText, testSentence, type BlockSource } from "./layoutSources";
import { fitLayoutText } from "./layoutTextFit";

/** The frame reading order needs. */
interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Items in reading order: top to bottom, then left to right. Items whose tops lie within half the
 * shorter one's height of a row's first item read as one row, left to right.
 */
export function readingOrder<T extends Placed>(items: readonly T[]): T[] {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const item of byTop) {
    const row = rows[rows.length - 1];
    const lead = row?.[0];
    if (lead && item.y - lead.y < Math.min(lead.height, item.height) / 2) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** The label a block without a panel letter starts with: "Panel 1", "Panel 2". */
export function legendLabel(index: number): string {
  return `Panel ${index + 1}.`;
}

/** Panel letters in their own order: A … Z, then AA, AB …, either case. */
function letterRank(a: string, b: string): number {
  return a.length - b.length || a.toUpperCase().localeCompare(b.toUpperCase());
}

/** One block's sentences. */
export function legendSentences(source: BlockSource): string {
  const sizes = sizesText(source);
  const grouped = source.groupTitle ? `, grouped by ${source.groupTitle}` : "";
  const panel = source.panel ? ` (panel ${source.panel})` : source.page ? ` (page ${source.page})` : "";
  const parts = [`${source.shows}${panel}${grouped}${sizes ? ` (${sizes})` : ""}.`];
  if (source.follows) parts.push("Drawn for each unit of the sheet's iteration; this page is shown.");
  if (source.centre) parts.push(source.centre);
  const test = testSentence(source);
  if (test) parts.push(test);
  return parts.join(" ");
}

/** The legend of blocks given in reading order: a line per block, each starting with its label. */
export function writeLegend(sources: readonly BlockSource[]): string {
  return sources.map((source, i) => `${legendLabel(i)} ${legendSentences(source)}`).join("\n");
}

/**
 * The legend of a page's items: every block that draws data, in reading order. Text blocks, image
 * walls and cell panels draw no counted data and are left out. A block with a panel letter
 * (`letterOf`) is named by it, "A.", and the lettered blocks come first, in their letters' order,
 * so the legend reads as the sheet is lettered; the blocks without one follow as "Panel 1." ….
 */
export function legendForItems<T extends Placed>(items: readonly T[], describe: (item: T) => BlockSource | null, letterOf?: (item: T) => string | undefined): string {
  const described = readingOrder(items).flatMap((item) => {
    const source = describe(item);
    return source && source.kind !== "legend" ? [{ source, letter: letterOf?.(item) }] : [];
  });
  const lettered = described.filter((entry) => entry.letter).sort((a, b) => letterRank(a.letter!, b.letter!));
  const rest = described.filter((entry) => !entry.letter);
  return [
    ...lettered.map(({ source, letter }) => `${letter}. ${legendSentences(source)}`),
    ...rest.map(({ source }, i) => `${legendLabel(i)} ${legendSentences(source)}`),
  ].join("\n");
}

/** Today's date as the legend block records it, YYYY-MM-DD in local time. */
export function legendDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Where a legend block goes: under everything on the sheet, at the left of the content, as wide
 * as the content (at least 320 px). A sheet with nothing on it puts it at the margin.
 */
export function legendFrame(items: readonly Placed[], inset: number): { x: number; y: number; width: number } {
  if (!items.length) return { x: inset, y: inset, width: 480 };
  const left = Math.min(...items.map((item) => item.x));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { x: left, y: bottom + 12, width: Math.max(320, right - left) };
}

/** The font size a written legend takes, px. */
export const LEGEND_FONT_SIZE = 10;

/**
 * A legend text block for a page's items: its recipe, dated today, and its frame under the
 * content, tall enough for its lines. Null when nothing on the page draws data.
 */
export function legendTextBlock<T extends Placed>(
  items: readonly T[],
  describe: (item: T) => BlockSource | null,
  inset: number,
  now: Date = new Date(),
  /** Each item's panel letter, when it has one. */
  letterOf?: (item: T) => string | undefined,
): { recipe: LayoutTextRecipe; frame: { x: number; y: number; width: number; height: number } } | null {
  const text = legendForItems(items, describe, letterOf);
  if (!text) return null;
  const { x, y, width } = legendFrame(items, inset);
  const fitted = fitLayoutText(text, LEGEND_FONT_SIZE, width);
  // Without a layout engine to measure with, about half the font size a character, 1.4 lines.
  const lines = text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil((line.length * LEGEND_FONT_SIZE * 0.5) / width)), 0);
  const height = Math.max(20, fitted ? fitted.height : Math.ceil(lines * LEGEND_FONT_SIZE * 1.4) + 8);
  return {
    recipe: { kind: "text", text, fontSize: LEGEND_FONT_SIZE, legendGenerated: legendDate(now) },
    frame: { x, y, width, height },
  };
}
