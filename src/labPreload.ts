// labPreload.ts — the lab build loads, soon after start-up, every part of GateLab it would otherwise
// fetch from the site on first use: the code-split tabs and panels, the export libraries, and the
// worker scripts. The lab site sits behind Cloudflare Access, whose login lasts 24 hours; once it
// lapses, any later fetch from the site is sent to the login page and fails. Loaded here, a module
// is kept by the page for as long as it is open, and a worker script is kept in the browser's cache
// (the lab site's deploy serves the hashed /assets/* files as immutable for a year), so a tab left
// open past the login needs nothing more from the site, and saving to the lab Drive, which talks to
// Google only, still works. The public build never imports this module.
//
// Every dynamic import() in src/ and every worker must be listed here; labPreload.test.ts checks it.

import compensationWorkerUrl from "./workers/compensation.worker.ts?worker&url";
import cvwWorkerUrl from "./imaging/cvw.worker.ts?worker&url";

/** How long after start-up the preload begins, so it does not compete with the first paint. */
export const LAB_PRELOAD_DELAY_MS = 5000;

const CHUNKS: readonly (() => Promise<unknown>)[] = [
  () => import("./ui/CompensationTab"),
  () => import("./ui/LayoutTab"),
  () => import("./imaging/CellHoverProbe"),
  () => import("./imaging/CellInspector"),
  () => import("./imaging/CellMarker"),
  () => import("./imaging/ImagesTab"),
  () => import("./imaging/PlotThumbnails"),
  () => import("./imaging/imageService"),
  () => import("./imaging/attach"),
  () => import("./imaging/LayoutImageWall"),
  () => import("./imaging/LayoutCellPanel"),
  () => import("jspdf"),
  () => import("svg2pdf.js"),
];

const WORKERS: readonly string[] = [compensationWorkerUrl, cvwWorkerUrl];

/**
 * Load each chunk and fetch each worker script, one after another. A failure is passed over: the
 * first use of that part reports it as it always did.
 */
export async function preloadLabChunks(): Promise<{ loaded: number; failed: number }> {
  let loaded = 0;
  let failed = 0;
  for (const load of CHUNKS) {
    try {
      await load();
      loaded++;
    } catch {
      failed++;
    }
  }
  for (const url of WORKERS) {
    try {
      const response = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
      await response.arrayBuffer();
      if (response.ok) loaded++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { loaded, failed };
}

/** Start the preload LAB_PRELOAD_DELAY_MS after start-up. */
export function preloadLabChunksSoon(): void {
  window.setTimeout(() => void preloadLabChunks(), LAB_PRELOAD_DELAY_MS);
}
