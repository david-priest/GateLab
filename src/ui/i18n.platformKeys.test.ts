import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { translateUi } from "./i18n";
import { platformKeys, setKeyPlatform } from "./platformKeys";

afterEach(() => setKeyPlatform(null));

describe("the app's text names keys for the user's keyboard", () => {
  it("shows the Mac's names on a Mac, as the text is written", () => {
    setKeyPlatform("mac");
    expect(translateUi("en", "Undo the last gating change (⌘Z)")).toBe("Undo the last gating change (⌘Z)");
    expect(translateUi("en", "Undo the last layout edit (Cmd-Z)")).toBe("Undo the last layout edit (Cmd-Z)");
  });

  it("shows Ctrl and Alt elsewhere, in English and in Japanese", () => {
    setKeyPlatform("other");
    expect(translateUi("en", "Undo the last gating change (⌘Z)")).toBe("Undo the last gating change (Ctrl+Z)");
    expect(translateUi("en", "Redo the change undone (⇧⌘Z)")).toBe("Redo the change undone (Ctrl+Shift+Z)");
    expect(translateUi("en", "Undo the last layout edit (Cmd-Z)")).toBe("Undo the last layout edit (Ctrl-Z)");
    expect(translateUi("en", "Redo the undone edit (Shift-Cmd-Z)")).toBe("Redo the undone edit (Ctrl-Shift-Z)");
    expect(translateUi("en", "↑↓: view · Shift: range · Cmd/Ctrl: add or remove · Enter: inspect")).toBe("↑↓: view · Shift: range · Ctrl: add or remove · Enter: inspect");
    const japanese = translateUi("ja", "Undo the last layout edit (Cmd-Z)");
    expect(japanese).not.toContain("Cmd");
    expect(japanese).toContain("Ctrl-Z");
    // A placeholder's value is the user's own text and is shown as given, keys or not.
    expect(translateUi("en", "{count} files", { count: 3 })).toBe("3 files");
  });

  it("leaves no Mac key name in any string of the app once rewritten", () => {
    // Every string literal in the sources that names a Mac key: the English keys, the Japanese
    // values, and the few titles written outside the translation function.
    const mac = /⌘|⌥|\bCmd\b|\bOption(?![A-Za-z])/;
    const literals: string[] = [];
    for (const file of ["i18n.tsx", "FigureWorkspace.tsx", "LayoutTab.tsx", "PopulationTree.tsx", "SampleManager.tsx", "OrderList.tsx", "../App.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      for (const match of source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) if (mac.test(match[1])) literals.push(match[1]);
    }
    expect(literals.length).toBeGreaterThan(20);
    for (const literal of literals) {
      expect(platformKeys(literal, "other"), literal).not.toMatch(mac);
      expect(platformKeys(literal, "mac")).toBe(literal);
    }
  });
});
