import { afterEach, describe, expect, it } from "vitest";
import { keyPlatform, platformKeys, setKeyPlatform } from "./platformKeys";

afterEach(() => setKeyPlatform(null));

describe("platformKeys", () => {
  it("leaves the text as written on a Mac", () => {
    const text = "Press Undo (⌘Z). Option-drag copies; Cmd-D duplicates.";
    expect(platformKeys(text, "mac")).toBe(text);
  });

  it("names the keys of a Windows or Linux keyboard elsewhere", () => {
    expect(platformKeys("Press Undo (⌘Z, or the arrow above the plot)", "other")).toBe("Press Undo (Ctrl+Z, or the arrow above the plot)");
    expect(platformKeys("Option-drag copies a population instead of moving it.", "other")).toBe("Alt-drag copies a population instead of moving it.");
    expect(platformKeys("Cmd-D duplicates, Cmd-A selects all", "other")).toBe("Ctrl-D duplicates, Ctrl-A selects all");
    expect(platformKeys("Cmd-G groups and Shift-Cmd-G ungroups", "other")).toBe("Ctrl-G groups and Ctrl-Shift-G ungroups");
    expect(platformKeys("Option-scroll, Shift-scroll or a pinch zooms", "other")).toBe("Alt-scroll, Shift-scroll or a pinch zooms");
    // Text that names both keeps the one that applies.
    expect(platformKeys("Cmd/Ctrl-click to add or remove a row", "other")).toBe("Ctrl-click to add or remove a row");
    expect(platformKeys("Cmd or Ctrl adds, Shift takes a range", "other")).toBe("Ctrl adds, Shift takes a range");
    expect(platformKeys("Cmd-click (Ctrl on Windows) adds one", "other")).toBe("Ctrl-click adds one");
    expect(platformKeys("Option/Alt-drag", "other")).toBe("Alt-drag");
    // Japanese text carries the same key names.
    expect(platformKeys("Cmd-Dで複製、Option を押しながらドラッグ", "other")).toBe("Ctrl-Dで複製、Alt を押しながらドラッグ");
    expect(platformKeys("Shiftで比率を維持、Optionで中心から、Cmdクリックで追加", "other")).toBe("Shiftで比率を維持、Altで中心から、Ctrlクリックで追加");
  });

  it("does not touch words that only look like a key", () => {
    for (const text of ["Options for the export", "An optional column", "Optional: a second file", "The command ran", "No keys here"]) {
      expect(platformKeys(text, "other")).toBe(text);
    }
  });

  it("reads the platform from the browser, and can be pinned", () => {
    setKeyPlatform("other");
    expect(keyPlatform()).toBe("other");
    expect(platformKeys("⌘Z")).toBe("Ctrl+Z");
    setKeyPlatform("mac");
    expect(platformKeys("⌘Z")).toBe("⌘Z");
  });
});
