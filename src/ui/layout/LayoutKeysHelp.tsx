// LayoutKeysHelp.tsx — the Items tab's list of the Layout tab's keys and pointer gestures, folded
// by default (its state remembered). Each key is one the tab's handlers take
// (LayoutTab's onCanvasKeyDown and window listener, layoutClipboard.ts, layoutNavigation.ts);
// LayoutKeysHelp.test.tsx holds the two to each other.

import { useState } from "react";
import { FoldSummary } from "../FoldSummary";
import { useI18n } from "../i18n";
import "./layoutNavigation.css";

export interface LayoutKeyEntry {
  /** As shown, in the Mac's names; the translation renames them on other systems. */
  keys: string;
  action: string;
  /**
   * The key presses it stands for, as `Mod+Shift+Key` with Mod for Cmd or Ctrl, for the test that
   * checks the list against the handlers. A pointer gesture has none.
   */
  presses?: readonly string[];
}

export interface LayoutKeyGroup { title: string; entries: readonly LayoutKeyEntry[] }

export const LAYOUT_KEYS: readonly LayoutKeyGroup[] = [
  {
    title: "Select",
    entries: [
      { keys: "Click", action: "Select an item" },
      { keys: "Drag empty page", action: "Select several" },
      { keys: "Shift-click", action: "Add to or remove from the selection" },
      { keys: "Cmd-A", action: "Select all", presses: ["Mod+A"] },
      { keys: "Escape", action: "Select nothing; cancel a drag or a shape being drawn", presses: ["Escape"] },
      { keys: "Enter", action: "Edit the selected text block", presses: ["Enter"] },
    ],
  },
  {
    title: "Move and resize",
    entries: [
      { keys: "Drag", action: "Move; Shift holds the direction" },
      { keys: "Drag a corner or an edge", action: "Resize; Shift keeps the proportions, Option resizes from the centre" },
      { keys: "Cmd while dragging", action: "Snapping off" },
      { keys: "Arrow keys", action: "Nudge 1 px; Shift: 10 px", presses: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"] },
    ],
  },
  {
    title: "Copy and paste",
    entries: [
      { keys: "Cmd-C", action: "Copy", presses: ["Mod+C"] },
      { keys: "Cmd-X", action: "Cut", presses: ["Mod+X"] },
      { keys: "Cmd-V", action: "Paste", presses: ["Mod+V"] },
      { keys: "Shift-Cmd-V", action: "Paste in place", presses: ["Mod+Shift+V"] },
      { keys: "Cmd-D", action: "Duplicate", presses: ["Mod+D"] },
      { keys: "Option-drag", action: "Copy where it is dropped" },
      { keys: "Delete or Backspace", action: "Remove", presses: ["Delete", "Backspace"] },
    ],
  },
  {
    title: "Order and group",
    entries: [
      { keys: "Cmd-] and Cmd-[", action: "Bring forward and send backward", presses: ["Mod+]", "Mod+["] },
      { keys: "Shift-Cmd-] and Shift-Cmd-[", action: "Bring to front and send to back", presses: ["Mod+Shift+]", "Mod+Shift+["] },
      { keys: "Cmd-G", action: "Group", presses: ["Mod+G"] },
      { keys: "Shift-Cmd-G", action: "Ungroup", presses: ["Mod+Shift+G"] },
      { keys: "Shift-Cmd-L", action: "Lock or unlock", presses: ["Mod+Shift+L"] },
      { keys: "Cmd-Z", action: "Undo", presses: ["Mod+Z"] },
      { keys: "Shift-Cmd-Z", action: "Redo", presses: ["Mod+Shift+Z"] },
    ],
  },
  {
    title: "View",
    entries: [
      { keys: "Space-drag", action: "Move the view", presses: ["Space"] },
      { keys: "Middle-button drag", action: "Move the view" },
      { keys: "Option-scroll or pinch", action: "Zoom about the pointer" },
      { keys: "Cmd-0", action: "Fit the page", presses: ["Mod+0"] },
      { keys: "Cmd-1", action: "100 %", presses: ["Mod+1"] },
      { keys: "Cmd-2", action: "Zoom to the selection, or to everything", presses: ["Mod+2"] },
      { keys: "Cmd-= and Cmd--", action: "Zoom in and out", presses: ["Mod+=", "Mod+-"] },
    ],
  },
];

const OPEN_KEY = "gatelab.layout.keysOpen";

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

export function LayoutKeysHelp() {
  const { t } = useI18n();
  const [open, setOpen] = useState(readOpen);
  return (
    <details
      className="gl-layout-keys"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      }}
    >
      <FoldSummary>{t("Keys")}</FoldSummary>
      {LAYOUT_KEYS.map((group) => (
        <section key={group.title}>
          <h4>{t(group.title)}</h4>
          <dl>
            {group.entries.map((entry) => (
              <div key={entry.keys} className="gl-layout-key">
                <dt><kbd>{t(entry.keys)}</kbd></dt>
                <dd>{t(entry.action)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </details>
  );
}
