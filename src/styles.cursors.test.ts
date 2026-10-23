// The cursor policy (David, 2026-10-23: "The cursor style should not change to a question mark
// ever. Please limit the number of cursor style changes in the app."). The chrome uses the arrow:
// no help, not-allowed or wait anywhere, and the hand only on a real link, which the browser gives.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string, pattern: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return files(path, pattern);
  return pattern.test(name) && !/\.test\./.test(name) ? [path] : [];
});

describe("cursors", () => {
  const sources = [...files("src", /\.css$/), ...files("src", /\.tsx?$/)];

  it("never ask for help, not-allowed or wait", () => {
    const found = sources.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/cursor\s*[:,]\s*['"]?(help|not-allowed|wait)\b/g)].map((m) => `${path}: ${m[0]}`));
    expect(found).toEqual([]);
  });

  it("show the hand only on a link", () => {
    const found = sources.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/cursor\s*[:,]\s*['"]?pointer\b/g)].map((m) => `${path}: ${m[0]}`))
      // The tailored-gate mark inside the plot sets it, but every plot node inherits the
      // container's cursor (#cytof-plot-container *), so it never shows.
      .filter((hit) => !hit.startsWith(join("src", "plots", "loadPlots.ts")));
    expect(found).toEqual([]);
  });

  it("keep the plot's cursor on its container, which every renderer node inherits", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/#cytof-plot-container \* \{ cursor: inherit !important; \}/);
  });
});
