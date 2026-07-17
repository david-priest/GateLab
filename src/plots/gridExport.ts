// gridExport.ts — export a mini-plot grid (Strategy / Illustration) as PNG or SVG.
// PNG reuses mini_plot.js's high-DPI rasterizer (CytofMiniPlot.exportGridPNG). SVG composes
// each cell as a vector overlay (axes + gates from the cell <svg>) over the point cloud
// embedded as a PNG <image> — a valid, editable .svg where labels/axes stay vector.

import { loadMiniPlots } from "./loadPlots";

const SVG_NS = "http://www.w3.org/2000/svg";

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** High-resolution PNG of the whole grid (mini_plot.js rasterizer). */
export function exportGridPNG(gridId: string, filename: string) {
  loadMiniPlots().exportGridPNG(gridId, filename);
}

/**
 * Re-render ONE cell's data layer offscreen at `dpi` (full resolution, gates/title/legend stripped —
 * those stay vector in the cloned cell <svg>), mirroring mini_plot's _buildPdfDataLayer via the
 * public renderMiniPlot. Falls back to the on-screen canvas if the cell has no cached cfg.
 */
function cellDataUrlAtDpi(cell: HTMLElement, dpi: number): string | null {
  const canvas = cell.querySelector("canvas");
  const cfg = (cell as unknown as { __miniPlotCfg?: Record<string, unknown> }).__miniPlotCfg;
  if (!cfg) return canvas ? canvas.toDataURL("image/png") : null;
  try {
    const cr = cell.getBoundingClientRect();
    const exportSize = Math.max(1, Math.round(cr.width || (cfg.plot_size as number) || 200));
    const exportCfg = {
      ...cfg,
      plot_size: exportSize,
      canvas_scale: Math.max(1, dpi / 96),
      gates: [],
      title: null,
      legend_entries: [],
    };
    const offscreen = document.createElement("div");
    loadMiniPlots().renderMiniPlot(offscreen, exportCfg);
    const ec = offscreen.querySelector("canvas");
    return ec ? ec.toDataURL("image/png") : canvas ? canvas.toDataURL("image/png") : null;
  } catch {
    return canvas ? canvas.toDataURL("image/png") : null;
  }
}

/** Compose the grid into a single SVG element (per-cell vector axes/gates over a data layer
 *  re-rendered at `dpi`). Shared by the SVG download and the PDF export. */
export function composeGridSVG(gridId: string, dpi: number): { root: SVGSVGElement; width: number; height: number } | null {
  const grid = document.getElementById(gridId);
  if (!grid) return null;
  const gridRect = grid.getBoundingClientRect();
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(Math.ceil(gridRect.width)));
  root.setAttribute("height", String(Math.ceil(gridRect.height)));

  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("width", "100%");
  bg.setAttribute("height", "100%");
  bg.setAttribute("fill", "#ffffff");
  root.appendChild(bg);

  // Text headers/titles that live in HTML (illustration row headers, strategy context title).
  grid.parentElement?.querySelectorAll<HTMLElement>(".strategy-context-title").forEach((h) => addHtmlText(root, h, gridRect));
  grid.querySelectorAll<HTMLElement>(".illustration-row-header").forEach((h) => addHtmlText(root, h, gridRect));

  grid.querySelectorAll<HTMLElement>(".mini-plot-cell").forEach((cell) => {
    const cr = cell.getBoundingClientRect();
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", `translate(${Math.round(cr.left - gridRect.left)},${Math.round(cr.top - gridRect.top)})`);

    const canvas = cell.querySelector("canvas");
    if (canvas) {
      const img = document.createElementNS(SVG_NS, "image");
      const w = canvas.clientWidth || cr.width;
      const h = canvas.clientHeight || cr.height;
      img.setAttribute("x", "0");
      img.setAttribute("y", "0");
      img.setAttribute("width", String(w));
      img.setAttribute("height", String(h));
      // Full-res data layer at the export DPI (not the capped on-screen canvas); axes/gates
      // stay vector in the cloned <svg> appended below.
      img.setAttribute("href", cellDataUrlAtDpi(cell, dpi) ?? canvas.toDataURL("image/png"));
      g.appendChild(img);
    }
    const svg = cell.querySelector("svg");
    if (svg) g.appendChild(svg.cloneNode(true));
    root.appendChild(g);
  });

  return { root, width: Math.ceil(gridRect.width), height: Math.ceil(gridRect.height) };
}

/** Composite SVG download: per-cell vector axes/gates over the data layer re-rendered at `dpi`. */
export function exportGridSVG(gridId: string, filename: string, dpi = 300) {
  const composed = composeGridSVG(gridId, dpi);
  if (!composed) return;
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(composed.root);
  downloadBlob(new Blob([xml], { type: "image/svg+xml" }), filename + ".svg");
}

/** PDF export: rasterize the composed grid SVG at the export DPI onto a single jsPDF page (uses only
 *  jsPDF's stable addImage — avoids the vendored form-object/Matrix path that isn't jsPDF-4
 *  compatible; axes/gates are high-res raster rather than true vector). */
export async function exportGridPDF(gridId: string, filename: string, dpi = 300) {
  const composed = composeGridSVG(gridId, dpi);
  if (!composed) return;
  const { width, height } = composed;
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(composed.root);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const scale = Math.max(1, Math.min(1200, dpi) / 96);
  const dataUrl: string = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = url;
  });
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: width >= height ? "landscape" : "portrait", unit: "pt", format: [width, height] });
  pdf.addImage(dataUrl, "PNG", 0, 0, width, height);
  pdf.save(filename + ".pdf");
}

function addHtmlText(root: SVGSVGElement, el: HTMLElement, gridRect: DOMRect) {
  const r = el.getBoundingClientRect();
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", String(Math.round(r.left - gridRect.left)));
  t.setAttribute("y", String(Math.round(r.top - gridRect.top + 12)));
  t.setAttribute("font-size", "12");
  t.setAttribute("font-family", "Arial, Helvetica, sans-serif");
  t.setAttribute("font-weight", "600");
  t.setAttribute("fill", "#334155");
  t.textContent = el.textContent ?? "";
  root.appendChild(t);
}
