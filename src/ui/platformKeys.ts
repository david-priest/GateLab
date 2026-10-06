// platformKeys.ts — the modifier keys by the names on the user's own keyboard.
//
// The app's text is written with the Mac's names (⌘Z, Cmd-D, Option-drag). The handlers have
// always taken Ctrl for Cmd and Alt for Option, so on Windows and Linux the keys work and only
// the words are wrong. This rewrites the words where they are shown.

export type KeyPlatform = "mac" | "other";

let forced: KeyPlatform | null = null;

/** For tests, and for nothing else: pin the platform, or null to read it from the browser again. */
export function setKeyPlatform(platform: KeyPlatform | null): void {
  forced = platform;
}

/** Whose keyboard this is. A browser that does not say is taken for a Mac, whose names the text carries. */
export function keyPlatform(): KeyPlatform {
  if (forced) return forced;
  if (typeof navigator === "undefined") return "mac";
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const platform = hinted || navigator.platform || "";
  if (!platform) return "mac";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "mac" : "other";
}

/**
 * The same sentence with the keys named for the platform. On a Mac it is returned as written.
 * Elsewhere: ⌘Z becomes Ctrl+Z, Cmd-D becomes Ctrl-D, Shift-Cmd-G becomes Ctrl-Shift-G, and
 * Option becomes Alt. Text that already names both ("Cmd/Ctrl", "Cmd or Ctrl") keeps the one
 * that applies.
 */
export function platformKeys(text: string, platform: KeyPlatform = keyPlatform()): string {
  if (platform === "mac" || !/[⌘⌥]|Cmd|Option/.test(text)) return text;
  return text
    .replace(/Cmd-click \(Ctrl on Windows\)/g, "Ctrl-click")
    .replace(/Cmd\s*\/\s*Ctrl/g, "Ctrl")
    .replace(/Cmd or Ctrl/g, "Ctrl")
    .replace(/Option\s*\/\s*Alt/g, "Alt")
    .replace(/Option \(Alt\)/g, "Alt")
    .replace(/Shift-Cmd-/g, "Ctrl-Shift-")
    .replace(/⇧⌘\s*/g, "Ctrl+Shift+")
    .replace(/⌘\s*/g, "Ctrl+")
    .replace(/⌥\s*/g, "Alt+")
    .replace(/\bCmd-/g, "Ctrl-")
    .replace(/\bCmd\b/g, "Ctrl")
    // "Option-drag", "Option-scroll", the key named on its own, and "Optionで" where Japanese
    // follows without a space; never "Options" or "Optional".
    .replace(/\bOption(?![A-Za-z])/g, "Alt");
}
