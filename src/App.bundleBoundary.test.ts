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
});
