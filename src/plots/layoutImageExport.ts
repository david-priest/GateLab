// layoutImageExport.ts — a placed image in the exported page. A placed SVG is written as vector
// art, a nested <svg> with its viewBox, made safe again here from the page's <img> (scripts,
// foreignObject, handlers and outside references removed), its ids prefixed and its style rules
// confined to it so that nothing in it reaches the rest of the page. A PNG or JPEG is an <image>
// of its data URL. The PDF writer draws the first as paths and embeds the second; the PNG export
// rasterises both with the page.

import { sanitizePlacedSvg, svgTextOfSrc } from "../ui/layout/placedImage";
import { exportTurn, setTurnTransform, unturnedBox } from "./layoutRotationExport";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Write the image `item` draws, if it is a placed image, into `root` at `frame` (page px,
 * relative to the page being written), with the group's id `id`. False when the item is not a
 * placed image.
 */
export function writeLayoutImage(
  root: Element,
  item: HTMLElement,
  frame: { left: number; top: number; width: number; height: number },
  id: string,
): boolean {
  const img = item.querySelector<HTMLImageElement>("img.gl-layout-placed-image");
  if (!img) return false;
  const src = img.getAttribute("src") ?? "";
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", id);
  // A turned image is placed upright in its frame turned back, and the group turns it (layoutRotationExport.ts).
  const turn = exportTurn(item);
  setTurnTransform(g, frame, turn);
  const box = unturnedBox(frame, frame, turn);
  const place = (element: Element) => {
    element.setAttribute("x", String(round(box.left)));
    element.setAttribute("y", String(round(box.top)));
    element.setAttribute("width", String(round(box.width)));
    element.setAttribute("height", String(round(box.height)));
    g.appendChild(element);
  };
  const text = svgTextOfSrc(src);
  if (text !== null) {
    const svg = sanitizePlacedSvg(text, { idPrefix: `${id}-`, scope: `${id}-art` });
    if (svg) place(document.importNode(svg, true));
  } else if (/^data:image\/(png|jpeg);base64,/.test(src)) {
    const image = document.createElementNS(SVG_NS, "image");
    image.setAttribute("href", src);
    image.setAttribute("preserveAspectRatio", "none");
    place(image);
  }
  root.appendChild(g);
  return true;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
