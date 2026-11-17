// layoutHeadingExport.ts — the HTML headings of a figure or strategy block on a Layout page (the
// strategy's title, the figure grid's caption and its row and column headings) as SVG text, where
// the page shows them: each line the browser wraps to is one <text> at its own line box. Where line
// boxes cannot be measured, the heading is one line placed by its padding and alignment.

import { EXPORT_FONT } from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A rectangle, in client pixels or page pixels as the caller says. */
export interface HeadingBox { left: number; top: number; width: number; height: number }

/** One line of a heading as the browser lays it out: its text and its box, in client pixels. */
export interface HeadingLineBox extends HeadingBox { text: string }

/** What placing a heading needs from its element, in page pixels. */
export interface HeadingFrame {
  /** The heading's border box. */
  box: HeadingBox;
  /** Its padding. */
  padding: { left: number; right: number; top: number };
  align: string;
  fontSize: number;
}

export interface PlacedHeadingLine { text: string; x: number; y: number; anchor: "start" | "middle" | "end" }

/**
 * The heading's lines as the browser lays them out, read character by character from its text,
 * in client pixels; a line starts at its first character that is not a space. Null where line
 * boxes cannot be measured.
 */
export function headingLineBoxes(title: HTMLElement): HeadingLineBox[] | null {
  if (typeof document.createRange !== "function") return null;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return null;
  const lines: HeadingLineBox[] = [];
  const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const content = node.textContent ?? "";
    for (let i = 0; i < content.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const previous = lines.at(-1);
      if (previous && Math.abs(previous.top - r.top) < 1) {
        previous.text += content[i];
        previous.width = r.right - previous.left;
      } else if (content[i].trim()) lines.push({ text: content[i], left: r.left, top: r.top, width: r.width, height: r.height });
    }
  }
  return lines.length ? lines : null;
}

/**
 * Where each line of a heading is written, in page pixels: a measured line at its own box's left
 * edge, the baseline 0.82 em below the box's top, as the page's other text is written; `toPage`
 * takes a measured box from client to page pixels. Unmeasured, the heading is one line in its
 * content box, at the left, centre or right as its alignment says, below its top padding.
 */
export function placeHeadingLines(
  text: string,
  measured: readonly HeadingLineBox[] | null,
  frame: HeadingFrame,
  toPage: (box: HeadingBox) => HeadingBox,
): PlacedHeadingLine[] {
  const { box, padding, align, fontSize } = frame;
  if (measured?.length) {
    return measured.flatMap((line) => {
      const words = line.text.trim();
      if (!words) return [];
      const at = toPage(line);
      return [{ text: words, x: at.left, y: at.top + fontSize * 0.82, anchor: "start" as const }];
    });
  }
  const words = text.trim();
  if (!words) return [];
  const y = box.top + padding.top + fontSize * 0.82;
  if (align === "center") return [{ text: words, x: box.left + padding.left + (box.width - padding.left - padding.right) / 2, y, anchor: "middle" }];
  if (align === "right" || align === "end") return [{ text: words, x: box.left + box.width - padding.right, y, anchor: "end" }];
  return [{ text: words, x: box.left + padding.left, y, anchor: "start" }];
}

/** Write placed heading lines under `parent` in the heading's font and colour. */
export function writeHeadingLines(parent: Element, lines: readonly PlacedHeadingLine[], fontSize: number, style: CSSStyleDeclaration) {
  for (const line of lines) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(line.x));
    t.setAttribute("y", String(line.y));
    if (line.anchor !== "start") t.setAttribute("text-anchor", line.anchor);
    t.setAttribute("font-size", String(fontSize));
    t.setAttribute("font-family", style.fontFamily || EXPORT_FONT);
    t.setAttribute("font-weight", style.fontWeight || "400");
    t.setAttribute("fill", style.color || "#1e293b");
    t.textContent = line.text;
    parent.appendChild(t);
  }
}
