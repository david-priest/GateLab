// @vitest-environment jsdom
//
// A tab left open across a deploy is running the old index, which names chunks the host no
// longer serves. Opening the Compensation tab then failed with "Failed to fetch dynamically
// imported module: .../CompensationTab-ZbMXZv-p.js" and the error boundary took over, which
// looks like a broken app rather than a stale page.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ChunkReloadHeldError, lazyChunk, setChunkReloadGuard } from "./lazyChunk";

const reload = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload }, writable: true, configurable: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setChunkReloadGuard(null);
});

const staleChunk = () =>
  new TypeError("Failed to fetch dynamically imported module: https://x/assets/CompensationTab-ZbMXZv-p.js");

describe("loading a code-split chunk after a deploy", () => {
  it("returns the module when the load succeeds", async () => {
    const load = lazyChunk("T", async () => ({ default: "module" }));
    await expect(load()).resolves.toEqual({ default: "module" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the page when the chunk is gone, rather than showing an error", async () => {
    const load = lazyChunk("T", async () => { throw staleChunk(); });
    let settled = false;
    void load().then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    // The promise must NOT settle: settling would flash the boundary before the reload lands.
    expect(settled).toBe(false);
  });

  it("reloads only once, so a genuinely missing chunk cannot loop", async () => {
    const load = lazyChunk("T", async () => { throw staleChunk(); });
    void load().catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    // Second attempt, same session: the error is allowed through.
    await expect(load()).rejects.toThrow(/dynamically imported module/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears its marker on success, so a LATER deploy can reload again", async () => {
    let fail = true;
    const load = lazyChunk("T", async () => {
      if (fail) throw staleChunk();
      return { default: "module" };
    });
    void load().catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    fail = false;
    await load();                       // the reload "happened"; the chunk now loads
    fail = true;
    void load().catch(() => {});        // a later deploy breaks it again
    await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the module itself throws", async () => {
    // A real fault inside the module must reach the error boundary, not be papered over.
    const load = lazyChunk("T", async () => { throw new Error("Cannot read properties of null"); });
    await expect(load()).rejects.toThrow(/Cannot read properties/);
    expect(reload).not.toHaveBeenCalled();
  });

  it("recognises the wording each browser uses", async () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/a.js",   // Chrome, Safari
      "error loading dynamically imported module: https://x/a.js",     // Firefox
      "Importing a module script failed.",                             // Safari, older
      "ChunkLoadError: Loading chunk 4 failed.",
      "Unable to preload CSS chunk for https://x/a.css",
    ]) {
      sessionStorage.clear();
      reload.mockClear();
      const load = lazyChunk("T", async () => { throw new TypeError(message); });
      void load().catch(() => {});
      await Promise.resolve(); await Promise.resolve();
      expect(reload, message).toHaveBeenCalledTimes(1);
    }
  });

  it("does not reload while the guard says reloading would lose work, and says why", async () => {
    let unsaved = true;
    setChunkReloadGuard(() => (unsaved ? "Save to the lab Drive first, then reload." : null));
    const load = lazyChunk("T", async () => { throw staleChunk(); });
    const held = await load().catch((error: unknown) => error);
    expect(held).toBeInstanceOf(ChunkReloadHeldError);
    expect((held as Error).message).toBe("Save to the lab Drive first, then reload.");
    expect(reload).not.toHaveBeenCalled();
    // The reload was held, not spent: once saved, it reloads as before.
    unsaved = false;
    void load().catch(() => {});
    await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not ask the guard about a module that loaded and then threw", async () => {
    const guard = vi.fn(() => "held");
    setChunkReloadGuard(guard);
    await expect(lazyChunk("T", async () => { throw new Error("a real fault"); })()).rejects.toThrow("a real fault");
    expect(guard).not.toHaveBeenCalled();
  });
});
