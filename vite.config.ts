import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer-first scaffold. Electron main/preload + electron-builder are layered on
// once the D3 reuse is proven (build order step 1 → then Electron).
export default defineConfig({
  plugins: [react()],
  // Electron loads from the filesystem, so assets must be relative, not root-absolute.
  base: "./",
  server: { port: 5173 },
  test: {
    globals: true,
    environment: "node",
  },
});
