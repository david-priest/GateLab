#!/usr/bin/env node
// Launcher for GateLab's headless runner (src/headless/cli.ts; docs/headless.md).
//
// The engine is TypeScript written for a browser. Two things make it run in Node: a DOM parser
// for the Gating-ML and FlowJo readers, taken from jsdom as the interoperability tester takes it
// (tools/interop/run.mjs), and a bundle of the runner against this checkout's own src/, built with
// the esbuild that Vite installs. The bundle is written once per content to the system's temporary
// directory, never beside the data, so a run from a synced folder leaves nothing in it.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(ROOT, "package.json"));

let esbuild, JSDOM;
try {
  esbuild = require("esbuild");
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error(`gatelab-headless: run "npm ci" in ${ROOT} first (esbuild and jsdom come with GateLab's development install).`);
  process.exit(1);
}

const dom = new JSDOM("");
for (const k of ["DOMParser", "XMLSerializer", "Node", "document"]) globalThis[k] = dom.window[k];

const built = await esbuild.build({
  entryPoints: [join(ROOT, "src/headless/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  logLevel: "silent",
  // The runner's own CommonJS dependencies (jspdf's Node build) need require in an ES module.
  banner: { js: "import { createRequire as __glRequire } from 'node:module'; const require = __glRequire(import.meta.url);" },
});
const code = built.outputFiles[0].text;
const dir = join(tmpdir(), "gatelab-headless");
mkdirSync(dir, { recursive: true });
const file = join(dir, `cli-${createHash("sha256").update(code).digest("hex").slice(0, 16)}.mjs`);
if (!existsSync(file)) writeFileSync(file, code);

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const { main } = await import(pathToFileURL(file).href);
process.exitCode = await main(process.argv.slice(2), {
  version,
  revision: commit ? `${commit}${dirty ? "+modified" : ""}` : null,
});
