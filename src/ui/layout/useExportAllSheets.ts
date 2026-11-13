// useExportAllSheets.ts — "Export all sheets": each sheet with items is shown in turn, its pages
// drawn and left to settle, and composed as one sheet's export composes them (LayoutTab's
// exportSheet); then all are written at once (layoutExportAll.ts). The sheet, page, zoom, scroll
// and selection the user was on are restored after. Hidden items are not on the page, so they
// stay out, as for one sheet.

import { useRef, useState } from "react";
import type { LayoutWorkspace } from "../../engine/layout";
import type { LayoutPage as ExpandedPage } from "../../engine/layoutBatch";
import { composeSheetPages, type ComposedPage, type LayoutExportFormat } from "../../plots/layoutExport";
import { writeAllSheets, type ComposedSheet } from "./layoutExportAll";

interface ExportAllOptions {
  workspace: LayoutWorkspace;
  /** The shown sheet's pages (more than one only on a sheet saved with an iteration). */
  pages: readonly ExpandedPage[];
  pageIndex: number;
  setPageIndex: (index: number) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  canvas: HTMLElement | null;
  page: HTMLElement | null;
  /** Shows a sheet without making an undo step. */
  showSheet: (id: string) => void;
  /** Waits until the page's plots have drawn. */
  settle: () => Promise<void>;
  format: LayoutExportFormat;
  crop: { paddingMm: number } | undefined;
  exporting: boolean;
  setExporting: (exporting: boolean) => void;
  selectedIds: readonly string[];
  setSelectedIds: (ids: string[]) => void;
  onError: (message: string) => void;
  onExported?: () => void;
}

export function useExportAllSheets(options: ExportAllOptions) {
  const latest = useRef(options);
  latest.current = options;
  /** Which sheet is being drawn, for the button: "Sheet 2 of 5". */
  const [progress, setProgress] = useState<{ n: number; count: number } | null>(null);
  const exportable = options.workspace.sheets.filter((sheet) => sheet.items.length > 0);

  const exportAll = async () => {
    const start = latest.current;
    if (start.exporting || !start.page) return;
    const sheets = start.workspace.sheets.filter((sheet) => sheet.items.length > 0);
    if (!sheets.length) return;
    const back = {
      sheetId: start.workspace.activeSheetId,
      page: start.pageIndex,
      zoom: start.zoom,
      left: start.canvas?.scrollLeft ?? 0,
      top: start.canvas?.scrollTop ?? 0,
      selected: [...start.selectedIds],
    };
    start.setExporting(true);
    try {
      const composed: ComposedSheet[] = [];
      for (const [index, sheet] of sheets.entries()) {
        setProgress({ n: index + 1, count: sheets.length });
        if (latest.current.workspace.activeSheetId !== sheet.id) latest.current.showSheet(sheet.id);
        latest.current.setPageIndex(0);
        await latest.current.settle();
        const pages: ComposedPage[] = [];
        const expanded = latest.current.pages;
        for (let pageIndex = 0; pageIndex < Math.max(1, expanded.length); pageIndex++) {
          if (expanded.length > 1) {
            latest.current.setPageIndex(pageIndex);
            await latest.current.settle();
          }
          const now = latest.current;
          if (!now.page) throw new Error("The page went away during the export.");
          // A page of an iteration is named, in a zip, by what it is drawn for.
          const label = expanded[pageIndex]?.units.length === 1 ? expanded[pageIndex].units[0].name : undefined;
          pages.push(...composeSheetPages(now.page, sheet, { zoom: now.zoom, crop: now.crop }).map((page) => (label ? { ...page, label } : page)));
        }
        composed.push({ sheet, pages });
      }
      await writeAllSheets(composed, start.format);
      latest.current.onExported?.();
    } catch (error) {
      latest.current.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (latest.current.workspace.activeSheetId !== back.sheetId) latest.current.showSheet(back.sheetId);
      latest.current.setPageIndex(back.page);
      // Opening a sheet fits it to the window; the user's zoom and place are put back after.
      await latest.current.settle();
      latest.current.setZoom(back.zoom);
      await latest.current.settle();
      const canvas = latest.current.canvas;
      if (canvas) {
        canvas.scrollLeft = back.left;
        canvas.scrollTop = back.top;
      }
      latest.current.setSelectedIds(back.selected);
      setProgress(null);
      latest.current.setExporting(false);
    }
  };

  return { exportAll, progress, canExport: exportable.length > 0 };
}
