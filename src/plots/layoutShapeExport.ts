// layoutShapeExport.ts — a Layout line or shape in the exported page: the elements its SVG draws on
// the page (<line>, <path>, <rect>, <ellipse>; an arrowhead is a filled <path>, which the PDF
// writer draws as the browser does), copied as vector art at the item's place on the page.

import { exportId } from "./exportSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Write the shape `item` draws, if it is one, into `root` at `frame` (page px, relative to the
 * page being written), scaled by the item's zoom as it is on the page. False when the item is
 * not a shape.
 */
export function writeLayoutShape(
  root: Element,
  item: HTMLElement,
  frame: { left: number; top: number },
  index: number,
  heading: string,
): boolean {
  const art = item.querySelector("svg.gl-layout-shape > .gl-layout-shape-art");
  if (!art) return false;
  const zoom = Number(item.dataset.zoom) || 1;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("id", exportId("shape", index, heading));
  g.setAttribute("transform", `translate(${round(frame.left)},${round(frame.top)})${zoom === 1 ? "" : ` scale(${zoom})`}`);
  for (const element of [...art.children]) {
    const copy = element.cloneNode(true) as Element;
    copy.removeAttribute("class");
    g.appendChild(copy);
  }
  root.appendChild(g);
  return true;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
