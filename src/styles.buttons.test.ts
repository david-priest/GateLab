// A button class written in the source and absent from the stylesheet leaves the button drawn
// as the browser draws one. Seen on gl-btn-primary, which four buttons carried with no rule
// behind it; two of them show only inside GateLabR, so the browser app never showed the fault.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sources(path);
  return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
});

describe("button classes", () => {
  const styles = readFileSync("src/styles.css", "utf8");
  const used = new Set<string>();
  for (const path of sources("src")) {
    for (const match of readFileSync(path, "utf8").matchAll(/\bgl-(?:mini-btn|btn)(?:-[a-z]+)*\b/g)) used.add(match[0]);
  }

  it("are all given a rule by the stylesheet", () => {
    expect(used.size).toBeGreaterThan(3);
    const unstyled = [...used].filter((name) => !new RegExp(`\\.${name}(?![a-z-])`).test(styles));
    expect(unstyled).toEqual([]);
  });

  it("draw the primary button as the filled button", () => {
    expect(styles).toMatch(/\.gl-btn, \.gl-btn-primary \{\s*background: var\(--accent\);/);
    expect(styles).toMatch(/\.gl-btn:disabled, \.gl-btn-primary:disabled \{/);
  });
});
