// Every place the interface shows a gate's colour goes through gateInk.ts (displayGateColour,
// useGateColour, useGateSwatch or inkedForDisplay), so "Coloured gates" off reaches it. A direct read of a
// gate's `.color` in interface code is either listed here, with why it keeps the stored colour, or
// it is a new site that would still show colour with gates set to black.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
/** Reads that are meant to see the stored colour, by file and the text of the line. */
const ALLOWED: readonly { file: string; has: string; why: string }[] = [
  { file: "App.tsx", has: "gate_id: `${gid}::reference`, color: drawn.gate.color", why: "a reference copy for the plot's payload, inked with the rest by inkedForDisplay" },
  { file: "ui/strategyArrows.ts", has: "color: gate.color", why: "Strategy's arrows; drawn #444 under publication style, which black gates are" },
  { file: "agent/handler.ts", has: "color: gate.color", why: "the gate as the agent reads it: data, not display" },
  { file: "plots/gatePayload.ts", has: "color: gate.color", why: "the plot payload, inked in App's displayed memo" },
];
/** The renderer patches and the helper itself. */
const SKIPPED = new Set(["plots/loadPlots.ts", "plots/gateInk.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "engine" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "store.ts" ? [path] : [];
  });
}

describe("gate colours shown through gateInk", () => {
  it("leaves no direct read of a gate's colour in interface code outside the listed ones", () => {
    const found: string[] = [];
    for (const path of sources(ROOT)) {
      const file = relative(ROOT, path);
      if (SKIPPED.has(file)) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        if (!/\b[A-Za-z_.]*(gate|Gate|g)\.color\b/.test(line) || /gateColour\(|gateSwatch\(|displayGateColour\(/.test(line)) return;
        if (ALLOWED.some((a) => a.file === file && line.includes(a.has))) return;
        found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("finds every listed read still in its file, so the list does not outlive the code", () => {
    for (const a of ALLOWED) expect(readFileSync(join(ROOT, a.file), "utf8"), a.file).toContain(a.has);
  });
});
