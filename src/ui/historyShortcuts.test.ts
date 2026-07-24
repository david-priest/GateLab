// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { historyShortcutAction } from "./historyShortcuts";

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
