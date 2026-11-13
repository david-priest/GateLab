// layoutTextExport.ts — a formatted Layout text block as SVG text: each line one <text>, anchored
// by the block's alignment, with a <tspan> per run of formatting. Superscripts and subscripts are
// smaller and raised or lowered with dy, which Illustrator and the PDF writer read, and the
// baseline is returned after them. Blocks without formatting are left to the plain path.

import { mergeRuns, SCRIPT_SCALE, SUB_DROP, SUP_RAISE, type RichRun } from "../ui/layout/richText";
import { marksAt } from "../ui/layout/richTextDom";
import { EXPORT_FONT } from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

interface FormattedLine { runs: RichRun[]; left: number; top: number }

/** Whether a text surface carries formatting the plain export does not draw. */
export function isFormattedText(surface: HTMLElement, style: CSSStyleDeclaration): boolean {
  return (
    !!surface.querySelector("b, i, sup, sub")
    || style.fontStyle === "italic"
    || style.textAlign === "center"
    || style.textAlign === "right"
  );
}

/** The characters under a surface with their formatting, in order, newlines included. */
function charsOf(root: HTMLElement): { ch: string; node: Text | null; index: number; run: RichRun }[] {
  const found: { ch: string; node: Text | null; index: number; run: RichRun }[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child as Text;
        const marks = marksAt(text, root);
        for (let i = 0; i < text.data.length; i++) found.push({ ch: text.data[i], node: text, index: i, run: { ...marks, text: text.data[i] } });
      } else if (child.nodeName === "BR") {
        if (!(child as HTMLElement).dataset?.tail && (child.nextSibling || child.parentNode !== root)) found.push({ ch: "\n", node: null, index: 0, run: { text: "\n" } });
      } else walk(child);
    }
  };
  walk(root);
  return found;
}

/**
 * The lines the block shows. A mirror of the block, the same width, font and alignment, is laid
 * out off screen and read character by character, so text that wraps on the page exports
 * wrapped; a character lower than the line's bottom starts the next line, so a raised or lowered
 * run stays in its own. Where nothing can be measured, the newlines alone decide.
 */
function formattedLines(surface: HTMLElement, style: CSSStyleDeclaration, fontSize: number): FormattedLine[] {
  const source = surface instanceof HTMLTextAreaElement ? null : surface;
  const fallback = (): FormattedLine[] => {
    const chars = source ? charsOf(source) : [...(surface as HTMLTextAreaElement).value].map((ch) => ({ run: { text: ch } as RichRun }));
    const lines: FormattedLine[] = [{ runs: [], left: 0, top: 0 }];
    for (const c of chars) {
      if (c.run.text === "\n") lines.push({ runs: [], left: 0, top: lines.length * fontSize * 1.3 });
      else lines[lines.length - 1].runs.push(c.run);
    }
    return lines;
  };
  if (typeof document.createRange !== "function") return fallback();
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return fallback();
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed", left: "-100000px", top: "0", visibility: "hidden",
    width: `${Math.max(1, surface.clientWidth - padding)}px`, boxSizing: "content-box",
    padding: "0", margin: "0", border: "0",
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign,
    whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak,
  } as Partial<CSSStyleDeclaration>);
  // The mirror takes the surface's class so the superscript and subscript rules apply to it.
  mirror.className = "gl-layout-text-surface";
  if (source) mirror.append(...Array.from(source.childNodes).map((node) => node.cloneNode(true)));
  else mirror.textContent = (surface as HTMLTextAreaElement).value;
  document.body.appendChild(mirror);
  try {
    const origin = mirror.getBoundingClientRect();
    const lines: (FormattedLine & { bottom: number })[] = [];
    let newline = true;
    for (const c of charsOf(mirror)) {
      if (c.ch === "\n" || !c.node) {
        newline = true;
        continue;
      }
      range.setStart(c.node, c.index);
      range.setEnd(c.node, c.index + 1);
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const top = r.top - origin.top;
      const centre = top + r.height / 2;
      const line = lines.at(-1);
      const script = c.run.sup || c.run.sub;
      if (line && !newline && centre < line.bottom) {
        line.runs.push(c.run);
        // The line's top and bottom are its plain characters' where it has any.
        if (!script && line.runs.every((run) => run === c.run || run.sup || run.sub)) {
          line.top = top;
          line.bottom = top + r.height;
        }
      } else {
        lines.push({ runs: [c.run], left: r.left - origin.left, top, bottom: top + r.height });
      }
      newline = false;
    }
    return lines.length ? lines : fallback();
  } finally {
    mirror.remove();
  }
}

/**
 * A formatted text block's lines under `parent`, each one <text> with its runs as <tspan>s.
 * `rect` is the surface in page pixels; `zoom` the item's own zoom, which the surface's computed
 * lengths do not include. False, and nothing written, for a block without formatting.
 */
export function formattedTextLines(parent: Element, surface: HTMLElement, rect: { left: number; top: number; width: number }, zoom: number): boolean {
  const style = getComputedStyle(surface);
  if (!isFormattedText(surface, style)) return false;
  const fontSize = (parseFloat(style.fontSize) || 14) * zoom;
  const padLeft = (parseFloat(style.paddingLeft) || 0) * zoom;
  const padRight = (parseFloat(style.paddingRight) || 0) * zoom;
  const padTop = (parseFloat(style.paddingTop) || 0) * zoom;
  const left = rect.left + padLeft;
  const width = Math.max(0, rect.width - padLeft - padRight);
  const align = style.textAlign === "center" ? "middle" : style.textAlign === "right" ? "end" : "start";
  const weight = style.fontWeight || "400";
  for (const line of formattedLines(surface, style, fontSize / zoom)) {
    // Spaces where a line wraps hang past its end on the page; they are not drawn.
    const runs = mergeRuns(line.runs);
    while (runs.length && /\s$/.test(runs[runs.length - 1].text)) {
      const last = runs[runs.length - 1];
      last.text = last.text.replace(/\s+$/, "");
      if (!last.text) runs.pop();
    }
    if (!runs.length) continue;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(align === "middle" ? left + width / 2 : align === "end" ? left + width : left + line.left * zoom));
    t.setAttribute("y", String(rect.top + padTop + line.top * zoom + fontSize * 0.82));
    t.setAttribute("font-size", String(fontSize));
    t.setAttribute("font-family", style.fontFamily || EXPORT_FONT);
    t.setAttribute("font-weight", weight);
    if (style.fontStyle === "italic") t.setAttribute("font-style", "italic");
    if (align !== "start") t.setAttribute("text-anchor", align);
    t.setAttribute("fill", style.color || "#1e293b");
    t.setAttribute("xml:space", "preserve");
    let shift = 0;
    for (const run of runs) {
      const span = document.createElementNS(SVG_NS, "tspan");
      if (run.bold) span.setAttribute("font-weight", "700");
      if (run.italic) span.setAttribute("font-style", "italic");
      const target = run.sup ? -SUP_RAISE * fontSize : run.sub ? SUB_DROP * fontSize : 0;
      if (target !== shift) span.setAttribute("dy", String(+(target - shift).toFixed(3)));
      shift = target;
      if (run.sup || run.sub) span.setAttribute("font-size", String(+(fontSize * SCRIPT_SCALE).toFixed(3)));
      span.textContent = run.text;
      t.appendChild(span);
    }
    parent.appendChild(t);
  }
  return true;
}
