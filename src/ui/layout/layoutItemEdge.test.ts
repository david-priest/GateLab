// A Layout item's edge (its hover, selection and frame line) takes no room in the item: drawn as a
// border of 1/zoom px, it moved the item's contents by that much, so the export, which reads their
// places from the page, shifted with the on-screen zoom.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sheets = ["src/styles.css", ...readdirSync("src/ui/layout").filter((name) => name.endsWith(".css")).map((name) => join("src/ui/layout", name))];

describe("a Layout item's edge", () => {
  it("is never a border on the item itself", () => {
    const found = sheets.flatMap((path) =>
      [...readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
        // Rules whose subject is the item: the last compound selector names .gl-layout-item.
        .filter(([, selector]) => selector.split(",").some((part) => /\.gl-layout-item(?![-\w])[^\s>+~]*$/.test(part.trim())))
        .filter(([, , body]) => [...body.matchAll(/(?:^|[;\s])border(?:-width|-top|-right|-bottom|-left)?\s*:\s*([^;]*)/g)].some(([, value]) => !/^0(px)?$/.test(value.trim())))
        .map(([, selector, body]) => `${path}: ${selector.trim()} { ${body.trim()} }`));
    expect(found).toEqual([]);
  });
});
