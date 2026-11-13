// @vitest-environment jsdom
// Every Layout sheet written at once: one PDF with each sheet's pages in sheet order, or one zip
// with a folder per sheet named by the sheet. Synthetic sheets S1, S2 and "control"; the PDF writer
// is stood in for by a recorder.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLayoutSheet, defaultLayoutPage, type LayoutSheet } from "../../engine/layout";
import type { ComposedPage } from "../../plots/layoutExport";

const pdfs = vi.hoisted(() => ({
  made: [] as { first: number[]; added: number[][]; drawn: string[]; saved: string }[],
  zipped: null as Record<string, Uint8Array> | null,
}));
vi.mock("jspdf", () => ({
  jsPDF: class {
    record = { first: [] as number[], added: [] as number[][], drawn: [] as string[], saved: "" };
    constructor(options: { format: number[] }) {
      this.record.first = options.format;
      pdfs.made.push(this.record);
    }
    addPage(format: number[]) { this.record.added.push(format); }
    save(name: string) { this.record.saved = name; }
  },
}));
vi.mock("../../plots/exportSvg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plots/exportSvg")>()),
  pdfVectorPage: async (pdf: { record: { drawn: string[] } }, root: SVGSVGElement) => {
    pdf.record.drawn.push(root.getAttribute("data-page") ?? "");
    return true;
  },
}));
vi.mock("fflate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fflate")>()),
  zipSync: (files: Record<string, Uint8Array>) => {
    pdfs.zipped = files;
    return new Uint8Array();
  },
}));

const { allSheetsPaths, writeAllSheets } = await import("./layoutExportAll");

beforeEach(() => {
  pdfs.made = [];
  pdfs.zipped = null;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} }));
});
afterEach(() => vi.unstubAllGlobals());

function page(name: string, widthMm: number, label?: string): ComposedPage {
  const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  root.setAttribute("data-page", name);
  return { root, width: widthMm * 4, height: 400, widthMm, heightMm: 100, ...(label ? { label } : {}) };
}
function sheet(name: string): LayoutSheet {
  return createLayoutSheet(name, defaultLayoutPage());
}

describe("Export all sheets", () => {
  it("writes one PDF with every sheet's pages in sheet order", async () => {
    await writeAllSheets([
      { sheet: sheet("S1"), pages: [page("S1 p1", 100)] },
      { sheet: sheet("S2"), pages: [page("S2 p1", 200), page("S2 p2", 300)] },
      { sheet: sheet("empty"), pages: [] },
    ], "pdf");
    expect(pdfs.made).toHaveLength(1);
    const [pdf] = pdfs.made;
    expect(pdf.drawn).toEqual(["S1 p1", "S2 p1", "S2 p2"]);
    // Three pages: the first made with the document, two added, each at its own width.
    const pt = 72 / 25.4;
    expect(pdf.first[0]).toBeCloseTo(100 * pt);
    expect(pdf.added.map((size) => Math.round(size[0] / pt))).toEqual([200, 300]);
    expect(pdf.saved).toBe("layout-sheets.pdf");
  });

  it("writes one zip of SVGs with a folder per sheet, named by the sheet", async () => {
    await writeAllSheets([
      { sheet: sheet("S1"), pages: [page("S1 p1", 100)] },
      { sheet: sheet("S2"), pages: [page("S2 p1", 100, "D1"), page("S2 p2", 100, "D2")] },
      { sheet: sheet("S1"), pages: [page("S1 again", 100)] },
    ], "svg");
    expect(Object.keys(pdfs.zipped!)).toEqual([
      "S1/S1.svg",
      "S2/S2-p1-D1.svg",
      "S2/S2-p2-D2.svg",
      "S1-2/S1.svg",
    ]);
    expect(new TextDecoder().decode(pdfs.zipped!["S2/S2-p2-D2.svg"])).toContain('data-page="S2 p2"');
  });

  it("names the files as one sheet's zip names them", () => {
    expect(allSheetsPaths([{ sheet: sheet("control / treated"), pages: [page("a", 1), page("b", 1)] }], "png")[0])
      .toEqual(expect.arrayContaining([expect.stringMatching(/\/.+-p1\.png$/), expect.stringMatching(/\/.+-p2\.png$/)]));
    expect(allSheetsPaths([{ sheet: sheet(""), pages: [page("a", 1)] }], "svg")).toEqual([["layout/layout.svg"]]);
  });
});
