// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { historyShortcutAction, workspaceShortcutAction } from "./historyShortcuts";

function shortcut(
  init: KeyboardEventInit,
  target: HTMLElement | Window = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "z", cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("historyShortcutAction", () => {
  it("maps Command/Control-Z to undo and Shift-Z to redo", () => {
    expect(historyShortcutAction(shortcut({ metaKey: true }))).toBe("undo");
    expect(historyShortcutAction(shortcut({ ctrlKey: true }))).toBe("undo");
    expect(historyShortcutAction(shortcut({ metaKey: true, shiftKey: true }))).toBe("redo");
    expect(historyShortcutAction(shortcut({ ctrlKey: true, shiftKey: true }))).toBe("redo");
  });

  it("takes Control-Y for redo, as Windows and Linux do, and leaves Command-Y to the browser", () => {
    expect(historyShortcutAction(shortcut({ key: "y", ctrlKey: true }))).toBe("redo");
    expect(historyShortcutAction(shortcut({ key: "Y", ctrlKey: true }))).toBe("redo");
    expect(historyShortcutAction(shortcut({ key: "y", metaKey: true }))).toBeNull();
    expect(historyShortcutAction(shortcut({ key: "y", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(historyShortcutAction(shortcut({ key: "y" }))).toBeNull();
    // Not in a field, where Control-Y is the field's own redo.
    expect(historyShortcutAction(shortcut({ key: "y", ctrlKey: true }, document.createElement("input")))).toBeNull();
  });

  it("does not hijack native undo in text-editing controls", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editor = document.createElement("div");
    editor.contentEditable = "true";

    expect(historyShortcutAction(shortcut({ metaKey: true }, input))).toBeNull();
    expect(historyShortcutAction(shortcut({ metaKey: true }, textarea))).toBeNull();
    expect(historyShortcutAction(shortcut({ metaKey: true }, editor))).toBeNull();
  });

  it("ignores unrelated, modified, or already-handled shortcuts", () => {
    expect(historyShortcutAction(shortcut({}))).toBeNull();
    expect(historyShortcutAction(shortcut({ metaKey: true, altKey: true }))).toBeNull();
    expect(historyShortcutAction(new KeyboardEvent("keydown", { key: "x", metaKey: true }))).toBeNull();
    const handled = shortcut({ metaKey: true });
    handled.preventDefault();
    expect(historyShortcutAction(handled)).toBeNull();
  });
});

describe("workspaceShortcutAction", () => {
  it("maps Command/Control-S to save and Command/Control-O to open, from a text field too", () => {
    expect(workspaceShortcutAction(shortcut({ key: "s", metaKey: true }))).toBe("save");
    expect(workspaceShortcutAction(shortcut({ key: "S", ctrlKey: true }))).toBe("save");
    expect(workspaceShortcutAction(shortcut({ key: "o", metaKey: true }))).toBe("open");
    expect(workspaceShortcutAction(shortcut({ key: "s", metaKey: true }, document.createElement("input")))).toBe("save");
  });

  it("leaves other keys, Shift and Option variants and handled events alone", () => {
    expect(workspaceShortcutAction(shortcut({ key: "s" }))).toBeNull();
    expect(workspaceShortcutAction(shortcut({ key: "s", metaKey: true, shiftKey: true }))).toBeNull();
    expect(workspaceShortcutAction(shortcut({ key: "o", ctrlKey: true, altKey: true }))).toBeNull();
    expect(workspaceShortcutAction(shortcut({ key: "z", metaKey: true }))).toBeNull();
    const handled = shortcut({ key: "s", metaKey: true });
    handled.preventDefault();
    expect(workspaceShortcutAction(handled)).toBeNull();
  });
});
