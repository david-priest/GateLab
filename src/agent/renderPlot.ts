// renderPlot.ts — the Gating plot as a PNG for an agent to look at: the point cloud's canvas with
// the axes and gates of the SVG laid over it, as on screen. Class-styled SVG keeps its look by
// having the computed values of a few properties written onto each element before it is drawn.

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
