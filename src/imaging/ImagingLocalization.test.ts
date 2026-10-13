// Every string the cell-image panels show goes through t() and has a Japanese entry, as the
// Compensation tab's coverage test requires of its files.

import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { hasUiTranslation } from "../ui/i18n";

const IMAGING_UI_FILES = ["CellInspector.tsx", "CellMarker.tsx", "CellHoverProbe.tsx", "ImagesTab.tsx", "PlotThumbnails.tsx"] as const;

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

describe("cell-image panels Japanese localization coverage", () => {
  it("does not leave static visible copy outside t()", () => {
    const hardcoded: string[] = [];
    for (const name of IMAGING_UI_FILES) {
      const source = sourceFile(name);
      const inspect = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.text.replace(/\s+/g, " ").trim();
          if (/[A-Za-z]/.test(text)) hardcoded.push(`${name}:${lineOf(source, node)} ${text}`);
        }
        if (ts.isJsxAttribute(node) && ["aria-label", "title", "placeholder"].includes(node.name.getText(source))) {
          const initializer = node.initializer;
          if (initializer && ts.isStringLiteral(initializer) && /[A-Za-z]/.test(initializer.text)) {
            hardcoded.push(`${name}:${lineOf(source, node)} ${initializer.text}`);
          } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
            const text = visibleLiteral(initializer.expression);
            if (text && /[A-Za-z]/.test(text)) hardcoded.push(`${name}:${lineOf(source, node)} ${text}`);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
    expect(hardcoded).toEqual([]);
  });

  it("has a Japanese entry for every literal t() key", () => {
    const missing: string[] = [];
    for (const name of IMAGING_UI_FILES) {
      const source = sourceFile(name);
      const inspect = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments.length > 0) {
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
});
