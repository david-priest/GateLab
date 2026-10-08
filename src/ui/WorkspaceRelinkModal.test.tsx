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

  // The files of a workspace can sit in several folders: each choice keeps what it found, the
  // dialog ticks those entries and says what is still to find, and the next choice can be another
  // folder or the files themselves.
  it("ticks the entries found so far, counts the rest, and offers another folder or the files", () => {
    const onChoose = vi.fn();
    act(() => root.render(
      <WorkspaceRelinkModal
        requirements={[
          { dataPath: "/data/D1.fcs", fileName: "D1.fcs" },
          { dataPath: "/data/D2.fcs", fileName: "D2.fcs" },
          { dataPath: "/data/D3.fcs", fileName: "D3.fcs" },
        ]}
        found={new Map([["/data/D1.fcs", "run-1/D1.fcs"], ["/data/D2.fcs", "run-1/D2.fcs"]])}
        folderSelectionAvailable
        fileSelectionAvailable
        scanning={false}
        note="2 of 3 found in run-1; 1 still to find: D3.fcs."
        error={null}
        onChoose={onChoose}
        onCancel={vi.fn()}
      />,
    ));
    const text = host.textContent ?? "";
    expect(text).toContain("2 of 3 FCS files found · 1 to find");
    expect(text).toContain("1 still to find: D3.fcs");
    const rows = [...host.querySelectorAll<HTMLElement>(".gl-workspace-relink-files > div")];
    expect(rows.map((row) => row.classList.contains("is-found"))).toEqual([true, true, false]);
    expect(rows[0].textContent).toContain("run-1/D1.fcs");
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")].map((b) => b.textContent);
    expect(buttons).toContain("Choose another folder…");
    expect(buttons).toContain("Choose files…");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Choose files…")!.click());
    expect(onChoose).toHaveBeenLastCalledWith("files");
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Choose another folder…")!.click());
    expect(onChoose).toHaveBeenLastCalledWith("folder");
  });
});
