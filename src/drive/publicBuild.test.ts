// The public build carries none of src/drive, nor the lab build's preload: built without the lab
// Drive configuration, no module of them is in the bundle and no Google address is either. Built with a configuration (synthetic
// values here), the same checks find it, so they are not passing for want of looking.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, type Rollup } from "vite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// A folder with no .env files: a .env.local kept in the checkout for hand testing is not read.
const NO_ENV_FILES = fileURLToPath(new URL(".", import.meta.url));

const LAB_ENV: Record<string, string> = {
  VITE_GATELAB_DRIVE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  VITE_GATELAB_DRIVE_API_KEY: "AIzaFakeFakeFakeFakeFakeFake",
  VITE_GATELAB_DRIVE_APP_ID: "123456789",
  VITE_GATELAB_DRIVE_ROOT_ID: "ROOT_FOLDER_0001",
  VITE_GATELAB_DRIVE_DOMAIN: "lab.example.org",
};
const MARKERS = [
  "accounts.google.com",
  "apis.google.com",
  "googleapis.com/drive",
  "gatelabWriter",
  "Open experiment",
];

// The deploy workflow passes the commit it builds; the header shows its first seven characters.
const BUILD_COMMIT = "0123abcdef4567890123abcdef4567890123abcd";
const ENV_KEYS = [...Object.keys(LAB_ENV), "GATELAB_BUILD_COMMIT"];

async function bundle(env: Record<string, string>): Promise<{ modules: string[]; code: string }> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    const result = await build({
      root: ROOT,
      configFile: `${ROOT}vite.config.ts`,
      mode: "production",
      envDir: NO_ENV_FILES,
      logLevel: "silent",
      build: { write: false, reportCompressedSize: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    const files = outputs.flatMap((output) => output.output);
    return {
      modules: files.flatMap((file) => (file.type === "chunk" ? Object.keys(file.modules) : [])),
      code: files.map((file) => (file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : "")).join("\n"),
    };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("the lab Drive code in the build", () => {
  it("is absent from the public build", async () => {
    const { modules, code } = await bundle({});
    expect(modules.length).toBeGreaterThan(100);
    expect(modules.filter((id) => id.includes("/src/drive/") || id.includes("/src/labPreload"))).toEqual([]);
    for (const marker of MARKERS) expect(code, marker).not.toContain(marker);
    expect(code).not.toContain("lab build");
  }, 180_000);

  it("is present in a build given the lab configuration", async () => {
    const { modules, code } = await bundle({ ...LAB_ENV, GATELAB_BUILD_COMMIT: BUILD_COMMIT });
    expect(modules.filter((id) => id.includes("/src/drive/")).length).toBeGreaterThan(5);
    expect(modules.filter((id) => id.includes("/src/labPreload")).length).toBe(1);
    for (const marker of MARKERS) expect(code, marker).toContain(marker);
    // The header's stamp: the commit's first seven characters and the build date.
    expect(code).toContain(`0123abc · ${new Date().toISOString().slice(0, 10)}`);
    expect(code).toContain("lab build");
  }, 180_000);

  it("stamps a lab build without a commit as local", async () => {
    const { code } = await bundle(LAB_ENV);
    expect(code).toContain(`local · ${new Date().toISOString().slice(0, 10)}`);
  }, 180_000);
});
