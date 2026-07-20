import { strToU8, zipSync } from "fflate";
import type { CompensationGlobalPairPreview } from "../engine/compensationGlobalInspector";
import {
  compensationDensitySmoothingRadiusForPlot,
  compensationSharedDensityCeiling,
} from "../engine/compensationGlobalInspector";
import { renderCompensationDensityBiplotSurface } from "./compensationDensityPlot";

const SVG_NS = "http://www.w3.org/2000/svg";

export const COMPENSATION_COMPARISON_PAIRS_PER_PAGE = 6;
export const COMPENSATION_COMPARISON_PAGE_WIDTH = 1123;
export const COMPENSATION_COMPARISON_PAGE_HEIGHT = 794;

export type CompensationComparisonExportFormat = "pdf" | "png" | "svg";

export interface CompensationComparisonExportPair {
  readonly pairKey: string;
  readonly sourceLabel: string;
  readonly receiverLabel: string;
  readonly coefficient: number;
  readonly relationship?: string | null;
  /** Built page-by-page so an export of thousands of pairs does not retain every plot array. */
  readonly buildPreview: () => CompensationGlobalPairPreview;
}

export interface CompensationComparisonExportMetadata {
  readonly sampleName: string;
  readonly profileName: string;
  readonly populationName: string;
  readonly filterLabel: string;
  readonly densitySmoothing: number;
  readonly densityColorPower: number;
}

export interface CompensationComparisonExportProgress {
  readonly completedPages: number;
  readonly totalPages: number;
}

export function compensationComparisonPageCount(pairCount: number): number {
  return Math.ceil(Math.max(0, Math.floor(pairCount)) / COMPENSATION_COMPARISON_PAIRS_PER_PAGE);
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sample";
}

export function compensationComparisonFileBase(
  sampleName: string,
  populationName: string,
): string {
  return `gatelab-compensation-${safeFilePart(sampleName.replace(/\.[^.]+$/, ""))}-${safeFilePart(populationName)}`;
}

export function compensationComparisonDownloadName(
  sampleName: string,
  populationName: string,
  format: CompensationComparisonExportFormat,
  pageCount: number,
): string {
  const base = compensationComparisonFileBase(sampleName, populationName);
  if (format === "pdf" || pageCount <= 1) return `${base}.${format}`;
  return `${base}-${format}-pages.zip`;
}

function addText(
  parent: SVGElement,
  content: string,
  x: number,
  y: number,
  options: Readonly<{
    size?: number;
    weight?: number;
    fill?: string;
    anchor?: "start" | "middle" | "end";
  }> = {},
): SVGTextElement {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y));
  text.setAttribute("font-family", "Arial, Helvetica, sans-serif");
  text.setAttribute("font-size", String(options.size ?? 10));
  text.setAttribute("font-weight", String(options.weight ?? 400));
  text.setAttribute("fill", options.fill ?? "#253247");
  if (options.anchor) text.setAttribute("text-anchor", options.anchor);
  text.textContent = content;
  parent.appendChild(text);
  return text;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function appendPlot(
  root: SVGSVGElement,
  pair: CompensationComparisonExportPair,
  preview: CompensationGlobalPairPreview,
  layer: "original" | "compensated",
  x: number,
  y: number,
  size: number,
  densitySmoothingRadius: number,
  densityColorCeiling: number,
  densityColorPower: number,
): void {
  const host = document.createElement("div");
  renderCompensationDensityBiplotSurface(host, {
    title: layer === "original" ? "Original" : "Compensated",
    panel: preview[layer],
    preview,
    sourceLabel: pair.sourceLabel,
    receiverLabel: pair.receiverLabel,
    size,
    densityColorCeiling,
    densitySmoothingRadius,
    densityColorPower,
    canvasScale: 300 / 96,
  });
  const canvas = host.querySelector("canvas");
  const overlay = host.querySelector("svg");
  if (!canvas || !overlay) throw new Error("GateLab could not render a compensation export panel.");

  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("transform", `translate(${x},${y})`);
  const image = document.createElementNS(SVG_NS, "image");
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", String(size));
  image.setAttribute("height", String(size));
  image.setAttribute("href", canvas.toDataURL("image/png"));
  group.appendChild(image);
  group.appendChild(overlay.cloneNode(true));
  root.appendChild(group);
}

export function composeCompensationComparisonPageSvg(
  pagePairs: readonly CompensationComparisonExportPair[],
  metadata: CompensationComparisonExportMetadata,
  pageIndex: number,
  pageCount: number,
): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, "svg");
  root.setAttribute("xmlns", SVG_NS);
  root.setAttribute("width", String(COMPENSATION_COMPARISON_PAGE_WIDTH));
  root.setAttribute("height", String(COMPENSATION_COMPARISON_PAGE_HEIGHT));
  root.setAttribute("viewBox", `0 0 ${COMPENSATION_COMPARISON_PAGE_WIDTH} ${COMPENSATION_COMPARISON_PAGE_HEIGHT}`);

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", "#ffffff");
  root.appendChild(background);

  addText(root, "GateLab compensation comparison", 28, 23, { size: 15, weight: 700 });
  addText(
    root,
    truncate(`${metadata.sampleName} · ${metadata.populationName} · ${metadata.profileName} · ${metadata.filterLabel}`, 150),
    28,
    41,
    { size: 9, fill: "#5f6d80" },
  );
  addText(root, `Page ${pageIndex + 1} of ${pageCount}`, COMPENSATION_COMPARISON_PAGE_WIDTH - 28, 23, {
    size: 9,
    fill: "#5f6d80",
    anchor: "end",
  });

  const marginX = 28;
  const columnGap = 18;
  const contentTop = 53;
  const contentBottom = 771;
  const columnWidth = (COMPENSATION_COMPARISON_PAGE_WIDTH - marginX * 2 - columnGap) / 2;
  const rowHeight = (contentBottom - contentTop) / 3;
  const plotSize = 204;
  const plotGap = 12;
  const plotsWidth = plotSize * 2 + plotGap;

  pagePairs.forEach((pair, index) => {
    const preview = pair.buildPreview();
    const smoothingRadius = compensationDensitySmoothingRadiusForPlot(metadata.densitySmoothing, plotSize);
    const densityColorCeiling = compensationSharedDensityCeiling(
      preview,
      0.95,
      smoothingRadius,
      metadata.densityColorPower,
    );
    const column = index % 2;
    const row = Math.floor(index / 2);
    const cardX = marginX + column * (columnWidth + columnGap);
    const cardY = contentTop + row * rowHeight;
    const plotsX = cardX + (columnWidth - plotsWidth) / 2;
    const plotY = cardY + 25;
    const relationship = pair.relationship && pair.relationship !== "other"
      ? ` · ${pair.relationship}`
      : "";
    addText(
      root,
      truncate(`${pair.sourceLabel} → ${pair.receiverLabel}`, 58),
      cardX + 5,
      cardY + 14,
      { size: 10.5, weight: 700 },
    );
    addText(
      root,
      `matrix ${(pair.coefficient * 100).toFixed(1)}%${relationship}`,
      cardX + columnWidth - 5,
      cardY + 14,
      { size: 8.5, fill: "#5f6d80", anchor: "end" },
    );
    appendPlot(root, pair, preview, "original", plotsX, plotY, plotSize, smoothingRadius, densityColorCeiling, metadata.densityColorPower);
    appendPlot(root, pair, preview, "compensated", plotsX + plotSize + plotGap, plotY, plotSize, smoothingRadius, densityColorCeiling, metadata.densityColorPower);

    if (row < 2) {
      const divider = document.createElementNS(SVG_NS, "line");
      divider.setAttribute("x1", String(cardX));
      divider.setAttribute("x2", String(cardX + columnWidth));
      divider.setAttribute("y1", String(cardY + rowHeight - 3));
      divider.setAttribute("y2", String(cardY + rowHeight - 3));
      divider.setAttribute("stroke", "#e6eaf0");
      divider.setAttribute("stroke-width", "1");
      root.appendChild(divider);
    }
  });

  addText(
    root,
    "Paired panels use the same frozen events, axes, transform, density scale, and off-scale edge piling.",
    28,
    786,
    { size: 8, fill: "#718096" },
  );
  return root;
}

function serializeSvg(root: SVGSVGElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}`;
}

async function svgToPngBlob(svg: string, dpi = 300): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("GateLab could not rasterize the compensation export page."));
      candidate.src = url;
    });
    const scale = Math.max(1, dpi / 96);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(COMPENSATION_COMPARISON_PAGE_WIDTH * scale);
    canvas.height = Math.round(COMPENSATION_COMPARISON_PAGE_HEIGHT * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas export is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, COMPENSATION_COMPARISON_PAGE_WIDTH, COMPENSATION_COMPARISON_PAGE_HEIGHT);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("GateLab could not encode the PNG export.")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function pageFileName(base: string, pageIndex: number, pageCount: number, extension: "png" | "svg"): string {
  const width = Math.max(2, String(pageCount).length);
  return `${base}-page-${String(pageIndex + 1).padStart(width, "0")}.${extension}`;
}

/** Export the currently filtered Global-inspector pairs as locked Original/Compensated pages. */
export async function exportCompensationComparison(
  pairs: readonly CompensationComparisonExportPair[],
  metadata: CompensationComparisonExportMetadata,
  format: CompensationComparisonExportFormat,
  onProgress?: (progress: CompensationComparisonExportProgress) => void,
): Promise<void> {
  const pageCount = compensationComparisonPageCount(pairs.length);
  if (pageCount === 0) throw new Error("No compensation pairs are available to export.");
  const base = compensationComparisonFileBase(metadata.sampleName, metadata.populationName);

  if (format === "pdf") {
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      if (pageIndex > 0) pdf.addPage("a4", "landscape");
      const pagePairs = pairs.slice(
        pageIndex * COMPENSATION_COMPARISON_PAIRS_PER_PAGE,
        (pageIndex + 1) * COMPENSATION_COMPARISON_PAIRS_PER_PAGE,
      );
      const svg = serializeSvg(composeCompensationComparisonPageSvg(pagePairs, metadata, pageIndex, pageCount));
      const png = await svgToPngBlob(svg);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("GateLab could not read an export page."));
        reader.readAsDataURL(png);
      });
      pdf.addImage(dataUrl, "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
      onProgress?.({ completedPages: pageIndex + 1, totalPages: pageCount });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    pdf.save(compensationComparisonDownloadName(metadata.sampleName, metadata.populationName, format, pageCount));
    return;
  }

  const archiveFiles: Record<string, Uint8Array> = {};
  let singlePageBlob: Blob | null = null;
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const pagePairs = pairs.slice(
      pageIndex * COMPENSATION_COMPARISON_PAIRS_PER_PAGE,
      (pageIndex + 1) * COMPENSATION_COMPARISON_PAIRS_PER_PAGE,
    );
    const svg = serializeSvg(composeCompensationComparisonPageSvg(pagePairs, metadata, pageIndex, pageCount));
    const fileName = pageFileName(base, pageIndex, pageCount, format);
    if (format === "svg") {
      const bytes = strToU8(svg);
      archiveFiles[fileName] = bytes;
      if (pageCount === 1) singlePageBlob = new Blob([bytes as BlobPart], { type: "image/svg+xml" });
    } else {
      const png = await svgToPngBlob(svg);
      const bytes = new Uint8Array(await png.arrayBuffer());
      archiveFiles[fileName] = bytes;
      if (pageCount === 1) singlePageBlob = png;
    }
    onProgress?.({ completedPages: pageIndex + 1, totalPages: pageCount });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const downloadName = compensationComparisonDownloadName(
    metadata.sampleName,
    metadata.populationName,
    format,
    pageCount,
  );
  if (pageCount === 1 && singlePageBlob) {
    downloadBlob(singlePageBlob, downloadName);
  } else {
    downloadBlob(new Blob([zipSync(archiveFiles, { level: 6 }) as BlobPart], { type: "application/zip" }), downloadName);
  }
}
