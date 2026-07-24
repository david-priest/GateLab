export type HistoryShortcutAction = "undo" | "redo";

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

function isNativeTextEditingTarget(target: EventTarget | null): boolean {
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
    event.key.toLocaleLowerCase() !== "z" ||
    isNativeTextEditingTarget(event.target)
  ) {
    return null;
  }
  return event.shiftKey ? "redo" : "undo";
}
