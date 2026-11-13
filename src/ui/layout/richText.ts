// richText.ts — the inline formatting of a Layout text block. The text stays one string, so
// placeholders, "Reads from", "Write legend" and iteration read it as before; a block saved by
// the formatting editor (recipe flag `rich`) holds four tags, <b>, <i>, <sup> and <sub>, with
// &lt; and &amp; for the literal characters. Anything else is literal text, and a block without
// the flag is literal throughout.

import type { LayoutTextRecipe } from "../../engine/layout";

export type RichMark = "bold" | "italic" | "sup" | "sub";
export const RICH_MARKS: readonly RichMark[] = ["bold", "italic", "sup", "sub"];
export type RichMarks = Partial<Record<RichMark, true>>;
export interface RichRun extends RichMarks { text: string }

const TAG_MARK: Readonly<Record<string, RichMark>> = { b: "bold", i: "italic", sup: "sup", sub: "sub" };
const MARK_TAG: Readonly<Record<RichMark, string>> = { bold: "b", italic: "i", sup: "sup", sub: "sub" };

/** Superscript and subscript size, and how far each is raised or lowered, in ems of the block's font. */
export const SCRIPT_SCALE = 0.7;
export const SUP_RAISE = 0.33;
export const SUB_DROP = 0.2;

function sameMarks(a: RichMarks, b: RichMarks): boolean {
  return RICH_MARKS.every((mark) => !a[mark] === !b[mark]);
}

function marksOf(source: RichMarks): RichMarks {
  const marks: RichMarks = {};
  for (const mark of RICH_MARKS) if (source[mark]) marks[mark] = true;
  // A run is raised or lowered, not both: the later of the two wins where both are open.
  if (marks.sup && marks.sub) delete marks.sub;
  return marks;
}

/** Runs with neighbours of the same formatting joined and empty runs dropped. */
export function mergeRuns(runs: readonly RichRun[]): RichRun[] {
  const merged: RichRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const previous = merged.at(-1);
    if (previous && sameMarks(previous, run)) previous.text += run.text;
    else merged.push({ ...marksOf(run), text: run.text });
  }
  return merged;
}

/** The runs of a tagged string. Only the four tags and the two escapes are read; a closing tag with nothing open is dropped. */
export function parseRichText(source: string): RichRun[] {
  const runs: RichRun[] = [];
  const open: Record<RichMark, number> = { bold: 0, italic: 0, sup: 0, sub: 0 };
  let text = "";
  const flush = () => {
    if (!text) return;
    const marks: RichMarks = {};
    for (const mark of RICH_MARKS) if (open[mark] > 0) marks[mark] = true;
    runs.push({ ...marks, text });
    text = "";
  };
  const pattern = /<(\/?)(b|i|sup|sub)>|&(lt|amp);/g;
  let last = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    text += source.slice(last, match.index);
    last = pattern.lastIndex;
    if (match[3]) {
      text += match[3] === "lt" ? "<" : "&";
      continue;
    }
    const mark = TAG_MARK[match[2]];
    if (match[1] && open[mark] === 0) continue;
    flush();
    open[mark] += match[1] ? -1 : 1;
  }
  text += source.slice(last);
  flush();
  return mergeRuns(runs);
}

function escapeRich(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** The tagged string of runs: each run's tags opened and closed around it, b outside i outside sup or sub. */
export function serializeRichText(runs: readonly RichRun[]): string {
  return mergeRuns(runs).map((run) => {
    const tags = RICH_MARKS.filter((mark) => run[mark]).map((mark) => MARK_TAG[mark]);
    return tags.map((tag) => `<${tag}>`).join("") + escapeRich(run.text) + [...tags].reverse().map((tag) => `</${tag}>`).join("");
  }).join("");
}

/** A block's runs: the tags read when the block is rich, its text whole and literal when not. */
export function richRunsOf(text: string, rich: boolean | undefined): RichRun[] {
  return rich ? parseRichText(text) : text ? [{ text }] : [];
}

export function plainOfRuns(runs: readonly RichRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** A block's words without its tags. */
export function plainTextOf(recipe: Pick<LayoutTextRecipe, "text" | "rich">): string {
  return recipe.rich ? plainOfRuns(parseRichText(recipe.text)) : recipe.text;
}

export function hasRichMarks(runs: readonly RichRun[]): boolean {
  return runs.some((run) => RICH_MARKS.some((mark) => run[mark]));
}

/**
 * What a block saves for its runs: the tagged string, rich, when any run is formatted; the words
 * as plain text otherwise, so a block nobody formatted stays literal.
 */
export function textOfRuns(runs: readonly RichRun[]): { text: string; rich: boolean } {
  return hasRichMarks(runs) ? { text: serializeRichText(runs), rich: true } : { text: plainOfRuns(runs), rich: false };
}

interface RichChar { ch: string; marks: RichMarks }

function charsOf(runs: readonly RichRun[]): RichChar[] {
  return runs.flatMap((run) => [...run.text].map((ch) => ({ ch, marks: marksOf(run) })));
}

function runsOfChars(chars: readonly RichChar[]): RichRun[] {
  return mergeRuns(chars.map((c) => ({ ...c.marks, text: c.ch })));
}

/**
 * Which marks hold over a range of characters (UTF-16 offsets into the words): a mark is on
 * when every character in the range carries it. An empty range reads the character before it,
 * or after it at the start, which is what typing there continues.
 */
export function marksInRange(runs: readonly RichRun[], start: number, end: number): Record<RichMark, boolean> {
  const chars = charsAt(runs);
  const lo = Math.min(start, end), hi = Math.max(start, end);
  const span = lo === hi ? chars.filter((c) => c.at === (lo > 0 ? lo - 1 : 0)) : chars.filter((c) => c.at >= lo && c.at < hi);
  const state = { bold: false, italic: false, sup: false, sub: false };
  if (!span.length) return state;
  for (const mark of RICH_MARKS) state[mark] = span.every((c) => c.marks[mark] === true);
  return state;
}

/** Characters with their UTF-16 offset, so ranges from a text field's selection apply. */
function charsAt(runs: readonly RichRun[]): (RichChar & { at: number })[] {
  let at = 0;
  return charsOf(runs).map((c) => {
    const placed = { ...c, at };
    at += c.ch.length;
    return placed;
  });
}

function setMark(marks: RichMarks, mark: RichMark, on: boolean): RichMarks {
  const next = { ...marks };
  if (on) {
    next[mark] = true;
    if (mark === "sup") delete next.sub;
    if (mark === "sub") delete next.sup;
  } else delete next[mark];
  return next;
}

/** A mark switched over a range: off where every character carries it, on for all of them otherwise. */
export function toggleMark(runs: readonly RichRun[], start: number, end: number, mark: RichMark): RichRun[] {
  const lo = Math.min(start, end), hi = Math.max(start, end);
  if (lo === hi) return mergeRuns(runs);
  const on = !marksInRange(runs, lo, hi)[mark];
  return runsOfChars(charsAt(runs).map((c) => (c.at >= lo && c.at < hi ? { ch: c.ch, marks: setMark(c.marks, mark, on) } : c)));
}

/** The marks a pending switch gives what is typed next at a point. */
export function marksWithPending(base: Record<RichMark, boolean>, pending: readonly RichMark[]): RichMarks {
  let marks: RichMarks = {};
  for (const mark of RICH_MARKS) if (base[mark]) marks[mark] = true;
  for (const mark of pending) marks = setMark(marks, mark, !marks[mark]);
  return marks;
}

/** Text put in place of a range, with the marks given. */
export function insertRichText(runs: readonly RichRun[], start: number, end: number, text: string, marks: RichMarks): RichRun[] {
  const lo = Math.min(start, end), hi = Math.max(start, end);
  const chars = charsAt(runs);
  const before = chars.filter((c) => c.at < lo);
  const after = chars.filter((c) => c.at >= hi);
  return runsOfChars([...before, ...[...text].map((ch) => ({ ch, marks: marksOf(marks) })), ...after]);
}

/** Signs that follow a marker name, compared with the Unicode minus read as "-". */
const WORD_SIGNS = ["bright", "dim", "int", "hi", "lo"];

/**
 * The marker signs set as superscripts: a +, - or Unicode minus, or hi, lo, dim, bright or int,
 * directly after a marker name (letters and digits, holding a letter and a capital or a digit).
 * A word sign must follow a capital or a digit (CD45RAhi, PD1int, not "print"); a - must end the
 * word (so HLA-DR keeps its hyphen); a + may run into the next marker (CD4+CD8+).
 */
export function superscriptMarkerSigns(runs: readonly RichRun[]): RichRun[] {
  const chars = charsAt(runs);
  const plain = chars.map((c) => c.ch).join("");
  const raise = new Set<number>();
  const isName = (name: string) => /[A-Za-z]/.test(name) && /[A-Z0-9]/.test(name);
  for (const match of plain.matchAll(/[A-Za-z0-9]+/g)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    const word = WORD_SIGNS.find((sign) => token.endsWith(sign) && token.length > sign.length);
    if (word) {
      const name = token.slice(0, -word.length);
      if (/[A-Z0-9]$/.test(name) && isName(name)) for (let i = end - word.length; i < end; i++) raise.add(i);
    }
    const sign = plain[end] === "−" ? "-" : plain[end];
    if ((sign === "+" || sign === "-") && isName(token)) {
      const next = plain[end + 1];
      const free = next === undefined || !/[A-Za-z0-9]/.test(next) || (sign === "+" && /[A-Z]/.test(next));
      if (free) raise.add(end);
    }
  }
  return runsOfChars(chars.map((c) => (raise.has(c.at) ? { ch: c.ch, marks: setMark(c.marks, "sup", true) } : c)));
}
