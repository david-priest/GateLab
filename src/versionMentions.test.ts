// A GateLab version named in the application's own text or comments is one that has been
// released. The next release's number is decided when it is cut (AGENTS.md, the release flow), so
// a message that says "saved before GateLab 0.8.4" before then names a release that may never
// carry that number, and tells a user of that build nothing true.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname);
const released = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;

const parts = (v: string): number[] => v.split(".").map(Number);
const after = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__fixtures__" && name !== "node_modules") out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("GateLab versions named in the source", () => {
  it(`name no release after the current one (${released})`, () => {
    const later: string[] = [];
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, "utf8");
      // GateLab's own numbers are 0.x.y; other programs' (FlowJo 10.x, GateLabR 1.x) are not read.
      for (const m of text.matchAll(/\b0\.\d+\.\d+\b/g)) {
        if (after(m[0], released)) {
          const line = text.slice(0, m.index).split("\n").length;
          later.push(`${file.slice(ROOT.length + 1)}:${line} ${m[0]}`);
        }
      }
    }
    expect(later).toEqual([]);
  });
});
