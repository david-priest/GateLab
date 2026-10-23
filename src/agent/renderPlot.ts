// renderPlot.ts — the Gating plot as a PNG for an agent to look at: the point cloud's canvas with
// the axes and gates of the SVG laid over it, as on screen. Class-styled SVG keeps its look by
// having the computed values of a few properties written onto each element before it is drawn.
// The Strategy tab's grid is drawn as its exports compose it.

import { composeGridSVG, rasterizeSvg } from "../plots/gridExport";

const INLINED = ["stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linejoin", "fill", "fill-opacity", "opacity", "font-size", "font-family", "font-weight", "text-anchor", "visibility"] as const;

/** A copy of the SVG with the computed values of the properties the look depends on set inline. */
export function inlineSvgStyles(svg: SVGSVGElement): SVGSVGElement {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const sources = svg.querySelectorAll<SVGElement>("*");
  const targets = copy.querySelectorAll<SVGElement>("*");
  sources.forEach((source, i) => {
    const target = targets[i];
    if (!target) return;
    const computed = getComputedStyle(source);
    for (const property of INLINED) {
      const value = computed.getPropertyValue(property);
      if (value && !target.getAttribute(property)) target.setAttribute(property, value);
    }
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return copy;
}

export interface PlotImage {
  png: string;
  width: number;
  height: number;
}

/**
 * Rasterise the plot in `area`: its canvas under its SVG, at the plot's own size or scaled to a
 * requested width or height (one of them; the aspect is kept).
 */
export async function renderPlotPng(area: HTMLElement, options: { width?: number; height?: number } = {}): Promise<PlotImage> {
  const canvas = area.querySelector("canvas");
  const svg = area.querySelector("svg");
  if (!svg) throw new Error("There is no plot to render.");
  const plotWidth = Number(svg.getAttribute("width")) || svg.clientWidth || canvas?.width || 0;
  const plotHeight = Number(svg.getAttribute("height")) || svg.clientHeight || canvas?.height || 0;
  if (!(plotWidth > 0 && plotHeight > 0)) throw new Error("The plot has no size yet.");
  const scale = options.width ? options.width / plotWidth : options.height ? options.height / plotHeight : 1;
  if (!(scale > 0 && scale <= 8)) throw new Error("The requested size must be positive and at most eight times the plot.");
  const width = Math.round(plotWidth * scale), height = Math.round(plotHeight * scale);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("No 2-D context for the render.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  if (canvas) ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, width, height);
  const markup = new XMLSerializer().serializeToString(inlineSvgStyles(svg));
  const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("The plot's SVG could not be drawn."));
      img.src = url;
    });
    ctx.drawImage(image, 0, 0, plotWidth, plotHeight, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
  return { png: out.toDataURL("image/png"), width, height };
}

/**
 * A mini-plot grid (the Strategy tab's) as a PNG, composed as its SVG and PDF exports compose it:
 * each panel's events under its vector axes and gates, with the arrows and the title. `container`
 * carries the tab's drawing state in data-state; this waits while it is "drawing" or "preparing"
 * (a pooled strategy prepares its files first), up to `timeoutMs`, and refuses an empty grid with
 * the tab's own status line.
 */
export async function renderGridPng(container: HTMLElement, gridId: string, options: { width?: number; height?: number; timeoutMs?: number } = {}): Promise<PlotImage> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const busy = () => ["drawing", "preparing"].includes(container.dataset.state ?? "");
  while (busy()) {
    if (Date.now() > deadline) throw new Error("The Strategy grid is still being drawn; try the render again.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const panel = container.parentElement;
  const note = (role: string) => panel?.querySelector(`[role="${role}"]`)?.textContent?.trim() || "";
  if (container.dataset.state !== "drawn") throw new Error(`The Strategy grid has nothing drawn: ${note("alert") || note("status") || "no panels"}`);
  const grid = document.getElementById(gridId);
  if (!grid) throw new Error("The Strategy grid has nothing drawn.");
  // The size the composition takes: the grid's box, as composeGridSVG measures it.
  const box = grid.getBoundingClientRect();
  const gridWidth = Math.ceil(box.width), gridHeight = Math.ceil(box.height);
  if (!(gridWidth > 0 && gridHeight > 0)) throw new Error("The Strategy grid has no size yet.");
  const scale = options.width ? options.width / gridWidth : options.height ? options.height / gridHeight : 1;
  if (!(scale > 0 && scale <= 8)) throw new Error("The requested size must be positive and at most eight times the grid.");
  // The events re-rendered at the output's resolution where it is larger than the screen's.
  const dpi = 96 * Math.max(1, scale);
  const composed = composeGridSVG(gridId, dpi);
  if (!composed) throw new Error("The Strategy grid has nothing drawn.");
  const raster = await rasterizeSvg(composed, dpi);
  const width = Math.round(composed.width * scale), height = Math.round(composed.height * scale);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("No 2-D context for the render.");
  ctx.drawImage(raster, 0, 0, width, height);
  return { png: out.toDataURL("image/png"), width, height };
}
