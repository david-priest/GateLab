// @vitest-environment jsdom
// A formatted Layout text block in the SVG export: each line one <text> with a <tspan> per run,
// superscripts smaller and raised with dy and the baseline returned after them, the line anchored
// by the block's alignment. A block without formatting keeps the plain export, tags and all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composeLayoutSVG } from "./layoutExport";
import { createLayoutSheet } from "../engine/layout";
import { RichTextContent } from "../ui/layout/LayoutTextFormat";

vi.mock("./gridExport", () => ({
  cellDataUrlAtDpi: () => "data:cell",
  rasterizeSvg: async () => ({}),
}));

function rect(el: Element, left: number, top: number, width: number, height: number) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** A sheet holding one text block drawn as the Layout tab draws it, at 100, 30 on the page. */
function page(text: string, rich: boolean, style: Partial<CSSStyleDeclaration> = {}) {
  const canvas = document.createElement("section");
  canvas.className = "gl-layout-canvas";
  rect(canvas, 0, 0, 1123, 794);
  const item = document.createElement("article");
  item.className = "gl-layout-item is-text";
  const surface = document.createElement("div");
  surface.className = "gl-layout-text-surface is-static";
  Object.assign(surface.style, { fontSize: "10px", padding: "2px", ...style });
  surface.innerHTML = renderToStaticMarkup(createElement(RichTextContent, { text, rich }));
  item.appendChild(surface);
  canvas.appendChild(item);
  rect(item, 100, 30, 200, 40);
  rect(surface, 100, 30, 200, 40);
  document.body.appendChild(canvas);
  return canvas;
}

const spans = (t: Element) => [...t.querySelectorAll("tspan")].map((s) => [s.textContent, s.getAttribute("dy"), s.getAttribute("font-size"), s.getAttribute("font-weight")]);

afterEach(() => {
  document.body.replaceChildren();
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
});

describe("A formatted text block in the export", () => {
  it("writes a line with a superscript as one <text> with tspans, raised and returned", () => {
    const { root } = composeLayoutSVG(page("<b>CD4</b><sup>+</sup> T cells", true), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const texts = root.querySelectorAll("text");
    expect(texts).toHaveLength(1);
    expect(texts[0].getAttribute("x")).toBe("102");
    expect(texts[0].getAttribute("y")).toBe(String(32 + 10 * 0.82));
    expect(texts[0].getAttribute("text-anchor")).toBeNull();
    expect(spans(texts[0])).toEqual([
      ["CD4", null, null, "bold"],
      ["+", "-3.3", "7", null],
      [" T cells", "3.3", null, null],
    ]);
  });

  it("anchors each line by the block's alignment, and draws its italic and colour", () => {
    const { root } = composeLayoutSVG(page("CD45RA<sub>lo</sub>\nB1", true, { textAlign: "center", fontStyle: "italic", color: "rgb(170, 51, 0)" }), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const texts = [...root.querySelectorAll("text")];
    expect(texts.map((t) => t.textContent)).toEqual(["CD45RAlo", "B1"]);
    expect(texts.map((t) => [t.getAttribute("x"), t.getAttribute("text-anchor"), t.getAttribute("font-style"), t.getAttribute("fill")])).toEqual([
      ["200", "middle", "italic", "rgb(170, 51, 0)"],
      ["200", "middle", "italic", "rgb(170, 51, 0)"],
    ]);
    expect(spans(texts[0])).toEqual([["CD45RA", null, null, null], ["lo", "2", "7", null]]);
    const right = composeLayoutSVG(page("D1", false, { textAlign: "right" }), createLayoutSheet("S"), { dpi: 300, zoom: 1 }).root.querySelector("text")!;
    expect([right.getAttribute("x"), right.getAttribute("text-anchor")]).toEqual(["298", "end"]);
  });

  it("wraps as the page does, a superscript at a line's end staying on its line", () => {
    // Characters 10 px wide, five to a line of 13 px; a superscript sits 3 px higher and is shorter.
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Range) {
        const parent = this.startContainer.parentElement!;
        const root = parent.closest(".gl-layout-text-surface") ?? parent;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let index = 0;
        for (let node = walker.nextNode(); node && node !== this.startContainer; node = walker.nextNode()) index += (node as Text).data.length;
        index += this.startOffset;
        const line = Math.floor(index / 5);
        const sup = !!this.startContainer.parentElement?.closest("sup");
        const top = line * 13 + (sup ? -3 : 0);
        return { left: (index % 5) * 10, top, width: 10, height: sup ? 8 : 12, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      },
    });
    const { root } = composeLayoutSVG(page("CD4<sup>+</sup> CD8<sup>+</sup>", true), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const texts = [...root.querySelectorAll("text")];
    expect(texts.map((t) => spans(t).map((s) => s[0]))).toEqual([["CD4", "+"], ["CD8", "+"]]);
    expect(texts.map((t) => t.getAttribute("y"))).toEqual([String(32 + 8.2), String(32 + 13 + 8.2)]);
  });

  it("keeps an older block's text literal: tags typed without the flag are words", () => {
    const { root } = composeLayoutSVG(page("a <b>tag</b> &amp; more", false), createLayoutSheet("S"), { dpi: 300, zoom: 1 });
    const texts = root.querySelectorAll("text");
    expect(texts).toHaveLength(1);
    expect(texts[0].textContent).toBe("a <b>tag</b> &amp; more");
    expect(texts[0].querySelector("tspan")).toBeNull();
    expect(texts[0].getAttribute("text-anchor")).toBeNull();
  });
});
