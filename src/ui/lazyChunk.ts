/**
 * Load a code-split chunk, surviving a deployment that happened while the page was open.
 *
 * Vite gives every chunk a content hash, and a static host serves exactly the chunks of the
 * build currently deployed. A tab opened before a deploy is still running the OLD index, which
 * names chunks that no longer exist, so the first time it opens a lazily-loaded tab the import
 * 404s and React shows the error boundary:
 *
 *   Failed to fetch dynamically imported module: .../assets/CompensationTab-ZbMXZv-p.js
 *
 * Nothing is wrong with the app — the page is simply stale — so the fix is to fetch the current
 * index and start again. Reported on the deployed build after the 0.7.0 brand-card redeploy.
 *
 * Reloading is guarded by a sessionStorage marker keyed to the chunk, because a chunk that is
 * genuinely missing (a bad deploy, a host serving a partial upload) would otherwise reload
 * forever. One reload, then the real error is allowed through to the boundary.
 */
export function lazyChunk<T>(name: string, load: () => Promise<T>): () => Promise<T> {
  const key = `gatelab.chunk-reload.${name}`;
  return async () => {
    try {
      const loaded = await load();
      // Made it. Clear the marker so a LATER deploy can reload again.
      try { sessionStorage.removeItem(key); } catch { /* private mode */ }
      return loaded;
    } catch (error) {
      if (!isStaleChunk(error)) throw error;
      let alreadyTried = true;
      try {
        alreadyTried = sessionStorage.getItem(key) === "1";
        if (!alreadyTried) sessionStorage.setItem(key, "1");
      } catch {
        // No sessionStorage (private mode, blocked storage). Reloading without a marker risks a
        // loop, so prefer showing the error over trapping the user in one.
        throw error;
      }
      if (alreadyTried) throw error;
      window.location.reload();
      // Never settles; the reload replaces the page. Returning would flash the error boundary.
      return await new Promise<T>(() => {});
    }
  };
}

/**
 * A failed chunk fetch, as opposed to a module that loaded and then threw.
 *
 * The message is the only signal browsers agree on, and they word it differently: Chrome and
 * Safari say "Failed to fetch dynamically imported module", Firefox reports a module-loading
 * error. A CSS chunk fails as a preload error. Anything else is a real fault in the module and
 * must not trigger a reload.
 */
function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch|ChunkLoadError|CSS chunk/i
    .test(message);
}
