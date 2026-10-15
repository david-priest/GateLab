import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The lab build's Google Drive workspace (src/drive) is compiled in only when the build is given
 * its whole configuration, so the public build carries no Drive code and makes no Google request.
 * A configuration given in part is refused rather than built into a copy without its menu.
 */
const DRIVE_ENV = [
  "VITE_GATELAB_DRIVE_CLIENT_ID",
  "VITE_GATELAB_DRIVE_API_KEY",
  "VITE_GATELAB_DRIVE_APP_ID",
  "VITE_GATELAB_DRIVE_ROOT_ID",
  "VITE_GATELAB_DRIVE_DOMAIN",
] as const;

function driveFlag(mode: string, envDir: string): string {
  // Vitest makes a define of a plain value a global that a test may reassign, so a test file
  // switches the Drive code on with vi.stubGlobal("__GATELAB_DRIVE__", true) (App.driveWorkspace.test.tsx).
  if (mode === "test") return "false";
  const env = loadEnv(mode, envDir, "VITE_GATELAB_DRIVE_");
  const given = DRIVE_ENV.filter((name) => env[name]?.trim());
  if (given.length > 0 && given.length < DRIVE_ENV.length) {
    throw new Error(
      `The lab Drive configuration is incomplete: ${DRIVE_ENV.filter((name) => !given.includes(name)).join(", ")} not set.`,
    );
  }
  return JSON.stringify(given.length === DRIVE_ENV.length);
}

/**
 * The lab build's stamp in the header: the commit it was built from and the build date, so the
 * copy being used can be told from the next. The deploy workflow passes the commit in
 * GATELAB_BUILD_COMMIT; a lab build without it (a local one) says "local". The public build and
 * tests carry no stamp, and a value that is not a commit hash is ignored.
 */
function labBuildStamp(mode: string, drive: string): string {
  if (mode === "test" || drive !== "true") return JSON.stringify("");
  const commit = process.env.GATELAB_BUILD_COMMIT?.trim() ?? "";
  const date = new Date().toISOString().slice(0, 10);
  return JSON.stringify(`${/^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : "local"} · ${date}`);
}

/** Sets __GATELAB_DRIVE__ and __GATELAB_LAB_BUILD__ from the environment files of the build's own envDir. */
function labDrive(): Plugin {
  return {
    name: "gatelab-lab-drive",
    config(config, { mode }) {
      const root = resolve(config.root ?? process.cwd());
      const envDir = resolve(root, config.envDir ?? ".");
      const drive = driveFlag(mode, envDir);
      return { define: { __GATELAB_DRIVE__: drive, __GATELAB_LAB_BUILD__: labBuildStamp(mode, drive) } };
    },
  };
}

// Renderer-first scaffold. Electron main/preload + electron-builder are layered on
// once the D3 reuse is proven (build order step 1 → then Electron).
export default defineConfig({
  plugins: [react(), labDrive()],
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
