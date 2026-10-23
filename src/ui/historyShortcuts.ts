export type HistoryShortcutAction = "undo" | "redo";

export type WorkspaceShortcutAction = "save" | "open";

/**
 * Cmd-S saves the workspace and Cmd-O opens one (Ctrl on Windows and Linux), as the Workspace
 * menu shows. They act from a text field too, as Save does in any editor; the browser's own
 * Save Page and Open File are what they replace.
 */
export function workspaceShortcutAction(event: KeyboardEvent): WorkspaceShortcutAction | null {
  if (event.defaultPrevented || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return null;
  const key = event.key.toLocaleLowerCase();
  if (key === "s") return "save";
  if (key === "o") return "open";
  return null;
}

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isNativeTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target.isContentEditable ||
    target.contentEditable === "true" ||
    target.closest('[contenteditable="true"], [contenteditable=""]')
  ) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !NON_TEXT_INPUT_TYPES.has(target.type.toLocaleLowerCase());
}

/**
 * Resolve the application history shortcut while leaving a focused text editor's
 * native undo stack alone.
 */
export function historyShortcutAction(event: KeyboardEvent): HistoryShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    (!event.metaKey && !event.ctrlKey) ||
    isNativeTextEditingTarget(event.target)
  ) {
    return null;
  }
  const key = event.key.toLocaleLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  // Ctrl-Y is redo on Windows and Linux. Cmd-Y is left alone: on a Mac it is the browser's history.
  if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  return null;
}

/**
 * Delete or Backspace with no modifier, outside a text field: the key that deletes the selected
 * gate. A key some other handler has already used (a polygon losing its last vertex) is not it,
 * nor a held key repeating, which would carry on from the last vertex into the selected gate.
 */
export function isDeleteShortcut(event: KeyboardEvent): boolean {
  return (
    (event.key === "Delete" || event.key === "Backspace") &&
    !event.defaultPrevented &&
    !event.repeat &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isNativeTextEditingTarget(event.target)
  );
}
