import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasUiTranslation } from "./i18n";

const COMPENSATION_UI_FILES = [
  "CompensationTab.tsx",
  "CompensationMatrixExportDialog.tsx",
  "CompensationComparisonExportDialog.tsx",
] as const;

function sourceFile(name: string): ts.SourceFile {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function literalTranslationKeys(node: ts.Expression): readonly string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literalTranslationKeys(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...literalTranslationKeys(node.whenTrue), ...literalTranslationKeys(node.whenFalse)];
  }
  return [];
}

function visibleLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map(({ literal }) => literal.text)].join("");
  }
  if (ts.isParenthesizedExpression(node)) return visibleLiteral(node.expression);
  return null;
}

describe("Compensation Japanese localization coverage", () => {
  it("does not leave static visible Compensation copy outside t()", () => {
    const hardcoded: string[] = [];
    for (const name of COMPENSATION_UI_FILES) {
      const source = sourceFile(name);
      const inspect = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.replace(/\s+/g, " ").trim();
          if (/[A-Za-z]/.test(text)) hardcoded.push(`${name}:${lineOf(source, node)} ${text}`);
        }
        if (
          ts.isJsxAttribute(node) &&
          ["aria-label", "title", "placeholder"].includes(node.name.getText(source))
        ) {
          const initializer = node.initializer;
          if (initializer && ts.isStringLiteral(initializer) && /[A-Za-z]/.test(initializer.text)) {
            hardcoded.push(`${name}:${lineOf(source, node)} ${initializer.text}`);
          } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            const text = visibleLiteral(initializer.expression);
            if (text && /[A-Za-z]/.test(text)) hardcoded.push(`${name}:${lineOf(source, node)} ${text}`);
          }
        }
        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
          const text = visibleLiteral(node.expression);
          if (text && /[A-Za-z]/.test(text)) hardcoded.push(`${name}:${lineOf(source, node)} ${text}`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(hardcoded).toEqual([]);
  });

  it("has an explicit Japanese entry for every literal Compensation t() key", () => {
    const missing: string[] = [];
    for (const name of COMPENSATION_UI_FILES) {
      const source = sourceFile(name);
      const inspect = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "t" &&
          node.arguments[0]
        ) {
          for (const key of literalTranslationKeys(node.arguments[0])) {
            if (!hasUiTranslation("ja", key)) missing.push(`${name}:${lineOf(source, node)} ${key}`);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(missing).toEqual([]);
  });

  it("translates every evidence-assessment label and explanation", () => {
    const source = readFileSync(new URL("../engine/compensationAttention.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile(
      "compensationAttention.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const missing: string[] = [];
    const inspect = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ["label", "detail"].includes(node.name.getText(parsed)) &&
        ts.isStringLiteral(node.initializer) &&
        !hasUiTranslation("ja", node.initializer.text)
      ) {
        missing.push(`compensationAttention.ts:${lineOf(parsed, node)} ${node.initializer.text}`);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(parsed);
    expect(missing).toEqual([]);
  });

  it("covers indirectly translated export format explanations", () => {
    for (const source of [
      "One multipage A4 landscape document.",
      "300 DPI numbered pages; multiple pages download as a ZIP.",
      "Vector text and axes with embedded high-resolution density layers; multiple pages download as a ZIP.",
    ]) {
      expect(hasUiTranslation("ja", source), source).toBe(true);
    }
  });
});
