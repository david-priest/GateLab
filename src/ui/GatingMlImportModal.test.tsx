// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatingMlImportModal } from "./CrudModals";

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

function renderModal(mergeBlockedReason: string | null, onImport = vi.fn()) {
  act(() => root.render(
    <GatingMlImportModal
      nGates={3}
      nPopulations={2}
      sourceLabel="a GateLab / GateLabR export"
      currentRootName="All Events"
      hasExistingStrategy
      mergeBlockedReason={mergeBlockedReason}
      compensationNote={null}
      compensationNeedsConfirmation={false}
      onCancel={vi.fn()}
      onImport={onImport}
    />,
  ));
  return onImport;
}

describe("GatingMlImportModal", () => {
  it("defaults to the non-destructive merge option and can explicitly select replacement", () => {
    const onImport = renderModal(null);
    const merge = host.querySelector<HTMLInputElement>('input[value="merge"]')!;
    const replace = host.querySelector<HTMLInputElement>('input[value="replace"]')!;
    expect(merge.checked).toBe(true);
    expect(replace.checked).toBe(false);

    act(() => replace.click());
    const importButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Import")!;
    act(() => importButton.click());
    expect(onImport).toHaveBeenCalledWith("replace");
  });

  it("disables merge and defaults to replacement when measurement spaces conflict", () => {
    renderModal("Merge is unavailable because compensation would change.");
    const merge = host.querySelector<HTMLInputElement>('input[value="merge"]')!;
    const replace = host.querySelector<HTMLInputElement>('input[value="replace"]')!;
    expect(merge.disabled).toBe(true);
    expect(merge.checked).toBe(false);
    expect(replace.checked).toBe(true);
    expect(host.textContent).toContain("compensation would change");
  });
});
