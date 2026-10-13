import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

describe("App bundle boundaries", () => {
  it("loads the Compensation UI only after its first visit", () => {
    const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const staticImports = source.statements.filter(ts.isImportDeclaration).filter((node) =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./ui/CompensationTab"
    );
    expect(staticImports).toHaveLength(1);
    expect(staticImports[0].importClause?.isTypeOnly).toBe(true);

    let hasDynamicImport = false;
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "./ui/CompensationTab"
      ) {
        hasDynamicImport = true;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    expect(hasDynamicImport).toBe(true);
  });

  it("loads the cell-image code only when a file has images", () => {
    // Everything under src/imaging/ reaches App.tsx through type-only or dynamic imports, so a
    // workspace without an S8 waveform file never fetches the decoder, the worker or the panels.
    const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const staticImports = source.statements.filter(ts.isImportDeclaration).filter((node) =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("./imaging/")
    );
    expect(staticImports.length).toBeGreaterThan(0);
    for (const node of staticImports) expect(node.importClause?.isTypeOnly).toBe(true);

    const dynamicImports: string[] = [];
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith("./imaging/")
      ) {
        dynamicImports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    for (const expected of ["./imaging/attach", "./imaging/imageService", "./imaging/CellHoverProbe", "./imaging/CellInspector", "./imaging/CellMarker", "./imaging/ImagesTab", "./imaging/PlotThumbnails"]) {
      expect(dynamicImports).toContain(expected);
    }
  });

  it("keeps the Layout editor out of the gating startup bundle", () => {
    const text = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const staticImports = source.statements.filter(ts.isImportDeclaration).filter((node) =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./ui/LayoutTab"
    );
    expect(staticImports).toHaveLength(0);

    let hasDynamicImport = false;
    const inspect = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "./ui/LayoutTab"
      ) {
        hasDynamicImport = true;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    expect(hasDynamicImport).toBe(true);
  });
});
