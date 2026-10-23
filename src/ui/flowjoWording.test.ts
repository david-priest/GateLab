import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

// "FlowJo" is shown only where it names a file format the user opens or writes (David,
// 2026-10-23). Wording about GateLab's behaviour, scales or counts says what it means without
// the program's name: "Biexponential", "the recorded grid", "the counts the workspace recorded".
// A phrase below names a format; a sentence may name FlowJo only inside one of them.
const FORMAT_NAMES = [
  "FlowJo workspace",
  "FlowJo 11 workbench",
  "FlowJo .wsp",
  "FlowJo sample",
  "GatingML / FlowJo / FACSChorus",
] as const;

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function outsideFormatNames(text: string): boolean {
  return FORMAT_NAMES.reduce((rest, name) => rest.split(name).join(""), text).includes("FlowJo");
}

function literal(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

/** Every literal key of the translation tables, and every literal passed to a translating call. */
function translatedText(): { where: string; en: string; ja?: string }[] {
  const found: { where: string; en: string; ja?: string }[] = [];
  for (const path of sources(SRC)) {
    const name = path.slice(SRC.length);
    const source = ts.createSourceFile(name, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
      name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node: ts.Node) => `${name}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["JA", "TOUR_JA"].includes(node.name.text)
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const prop of node.initializer.properties) {
          const en = ts.isPropertyAssignment(prop) ? literal(prop.name) : null;
          if (en !== null) found.push({ where: at(prop), en, ja: literal((prop as ts.PropertyAssignment).initializer) ?? undefined });
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression) ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
        const arg = callee === "t" || callee === "say" ? node.arguments[0]
          : callee === "translateUi" ? node.arguments[1] : undefined;
        const en = literal(arg);
        if (en !== null) found.push({ where: at(node), en });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("FlowJo in the interface's wording", () => {
  const text = translatedText();

  it("finds the translation tables and the translated calls", () => {
    expect(text.filter((entry) => entry.ja !== undefined).length).toBeGreaterThan(1000);
    expect(text.some((entry) => entry.en === "Open FlowJo workspace")).toBe(true);
  });

  it("names FlowJo only as a file format", () => {
    expect(text.filter((entry) => outsideFormatNames(entry.en)).map((entry) => `${entry.where} ${entry.en}`)).toEqual([]);
  });

  it("names FlowJo in Japanese only where the English does", () => {
    expect(text.filter((entry) => entry.ja?.includes("FlowJo") && !entry.en.includes("FlowJo"))
      .map((entry) => `${entry.where} ${entry.ja}`)).toEqual([]);
  });

  it("refuses a sentence about GateLab's behaviour that names the program", () => {
    expect(outsideFormatNames("FlowJo biexponential")).toBe(true);
    expect(outsideFormatNames("Evaluate gates as FlowJo does")).toBe(true);
    expect(outsideFormatNames("Export FlowJo 11 workbench (.flowjo)…")).toBe(false);
  });
});
