// The lab build's preload (src/labPreload.ts) must name every part of GateLab that is fetched from
// the site on first use, or a tab left open past the lab site's login fails on that part. Every
// dynamic import() in the app's source and every worker script is checked against its lists.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const PRELOAD = join(SRC, "labPreload.ts");
/** Loaded at start-up in the lab build already: the Drive module, and the preload itself. */
const AT_START = new Set(["drive", "labPreload"]);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield path;
  }
}

/** A specifier as a path from src/ without extension, or the package name. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return relative(SRC, resolve(dirname(file), specifier.replace(/\?.*$/, ""))).replace(/\.tsx?$/, "").split("\\").join("/");
}

/** The import() calls of a file (not `import("x").Type` in a type), as targets. */
function dynamicImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) out.push(target(file, arg.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function workers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/new Worker\(\s*new URL\(\s*"([^"]+)",\s*import\.meta\.url\s*\)/g)].map((match) => target(file, match[1]));
}

describe("the lab build's preload", () => {
  const files = [...sources(SRC)];
  const preloaded = new Set(dynamicImports(PRELOAD));
  const preloadedWorkers = new Set([...readFileSync(PRELOAD, "utf8").matchAll(/from "([^"]+)\?worker&url"/g)].map((match) => target(PRELOAD, match[1])));

  it("loads every code-split part of the app", () => {
    const used = new Set(files.filter((file) => file !== PRELOAD).flatMap(dynamicImports).filter((name) => !AT_START.has(name)));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((name) => !preloaded.has(name)).sort()).toEqual([]);
    // And nothing that is no longer loaded on first use.
    expect([...preloaded].filter((name) => !used.has(name)).sort()).toEqual([]);
  });

  it("fetches every worker script", () => {
    const used = new Set(files.flatMap(workers));
    expect(used.size).toBe(2);
    expect([...used].sort()).toEqual([...preloadedWorkers].sort());
  });
});
