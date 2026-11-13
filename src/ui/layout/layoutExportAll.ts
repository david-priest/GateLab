// layoutExportAll.ts — every Layout sheet written at once: as PDF one file with every sheet's
// pages in sheet order; as SVG or PNG one zip holding a folder per sheet, named by the sheet, with
// that sheet's files named as its own export names them (plots/layoutExport.ts). The pages are composed
// sheet by sheet by the tab, as one sheet's export composes them.

import { zipSync, strToU8 } from "fflate";
import { rasterizeSvg } from "../../plots/gridExport";
import type { LayoutSheet } from "../../engine/layout";
import { sanitizeFilePart } from "../../engine/fcsExport";
import { nextTurn, pdfVectorPage, pngBlob } from "../../plots/exportSvg";
import type { ComposedPage, LayoutExportFormat } from "../../plots/layoutExport";

export interface ComposedSheet {
  sheet: LayoutSheet;
  pages: readonly ComposedPage[];
}

/** The name the file of all sheets takes. */
export const ALL_SHEETS_FILENAME = "layout-sheets";

const PT_PER_MM = 72 / 25.4;

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

/**
 * Each page's path in the zip: a folder per sheet, named by the sheet (two sheets of one name are
 * told apart by a number), and in it the sheet's name alone for one page, else its pages numbered
 * with what each is drawn for, as one sheet's zip names them.
 */
export function allSheetsPaths(sheets: readonly ComposedSheet[], extension: string): string[][] {
  const used = new Map<string, number>();
  return sheets.map(({ sheet, pages }) => {
    const base = sanitizeFilePart(sheet.name) || "layout";
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const folder = count > 1 ? `${base}-${count}` : base;
    if (pages.length === 1) return [`${folder}/${base}.${extension}`];
    return pages.map((page, index) => {
      const label = page.label ? sanitizeFilePart(page.label) : "";
      return `${folder}/${base}-p${index + 1}${label ? `-${label}` : ""}.${extension}`;
    });
  });
}

const serialize = (root: SVGSVGElement) => '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);

export async function writeAllSheets(sheets: readonly ComposedSheet[], format: LayoutExportFormat): Promise<void> {
  const written = sheets.filter(({ pages }) => pages.length > 0);
  if (!written.length) return;
  if (format === "svg" || format === "png") {
    const paths = allSheetsPaths(written, format);
    const files: Record<string, Uint8Array> = {};
    for (const [sheetIndex, { sheet, pages }] of written.entries()) {
      for (const [index, page] of pages.entries()) {
        const path = paths[sheetIndex][index];
        if (format === "svg") files[path] = strToU8(serialize(page.root));
        else {
          // One raster at a time, let go before the next is drawn.
          const raster = await rasterizeSvg(page, sheet.page.dpi);
          files[path] = new Uint8Array(await (await pngBlob(raster, sheet.page.dpi)).arrayBuffer());
          await nextTurn();
        }
      }
    }
    downloadBlob(new Blob([zipSync(files) as BlobPart], { type: "application/zip" }), `${ALL_SHEETS_FILENAME}.zip`);
    return;
  }
  // As one sheet's PDF is written (plots/layoutExport.ts): each page at its physical size, in points,
  // vector where the writer can take it and a raster at the sheet's dpi where it cannot.
  const pageSize = (page: ComposedPage) => {
    const width = page.widthMm * PT_PER_MM, height = page.heightMm * PT_PER_MM;
    return { width, height, orientation: width >= height ? "landscape" as const : "portrait" as const };
  };
  const { jsPDF } = await import("jspdf");
  const first = pageSize(written[0].pages[0]);
  const pdf = new jsPDF({ orientation: first.orientation, unit: "pt", format: [first.width, first.height], compress: true });
  let count = 0;
  for (const { sheet, pages } of written) {
    for (const page of pages) {
      const { width, height, orientation } = pageSize(page);
      if (count > 0) pdf.addPage([width, height], orientation);
      count += 1;
      if (!(await pdfVectorPage(pdf, page.root, { width, height }))) {
        const raster = await rasterizeSvg(page, sheet.page.dpi);
        pdf.addImage(raster, "PNG", 0, 0, width, height, undefined, "FAST");
      }
      await nextTurn();
    }
  }
  pdf.save(`${ALL_SHEETS_FILENAME}.pdf`);
}
