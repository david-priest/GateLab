import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

// Renderer-first scaffold. Electron main/preload + electron-builder are layered on
// once the D3 reuse is proven (build order step 1 → then Electron).
export default defineConfig({
  plugins: [react()],
  // Electron loads from the filesystem, so assets must be relative, not root-absolute.
  base: "./",
  server: {
    port: 5173,
    // A git worktree keeps vendor/GateLabR as a symlink into the main checkout; the vendored
    // plot scripts are imported raw, and Vite's file-system guard (Vitest 4 enforces it too)
    // refuses a path outside the root unless it is allowed. In a normal clone the real path is
    // inside the root and this changes nothing.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(resolve("vendor/GateLabR"))] },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
