// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRelinkModal } from "./WorkspaceRelinkModal";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("locating a workspace's FCS files", () => {
  // A relink is decided by the acquisition the workspace saved (fix/multitree-import): a file of
  // the right name that records another acquisition is refused, and offered only by an explicit
  // "Relink to these files anyway". The dialog said it matched every entry by filename.
  for (const folderSelectionAvailable of [true, false]) {
    it(`says a file is relinked by its name and the acquisition saved with it (${folderSelectionAvailable ? "folder" : "files"})`, () => {
      act(() => root.render(
        <WorkspaceRelinkModal
          requirements={[{ dataPath: "/data/D1.fcs", fileName: "D1.fcs", identity: { $BTIM: "10:00:00" } }]}
          folderSelectionAvailable={folderSelectionAvailable}
          scanning={false}
          error={null}
          onChoose={vi.fn()}
          onCancel={vi.fn()}
        />,
      ));
      const text = host.textContent ?? "";
      expect(text).not.toContain("by filename");
      expect(text).toContain("acquisition");
      expect(text).not.toContain("every filename has one unique match");
    });
  }
});
