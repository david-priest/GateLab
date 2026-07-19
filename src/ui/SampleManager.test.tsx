// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderImportModal, SampleManagerModal, SampleNavigator, type SampleListItem } from "./SampleManager";

const items: SampleListItem[] = [
  { id: "a", name: "donor-a.fcs", eventCount: 3420, channelCount: 8 },
  { id: "b", name: "donor-b.fcs", eventCount: 70245, channelCount: 31, sourcePath: "PBMC/donor-b.fcs" },
];

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

describe("SampleNavigator", () => {
  it("keeps active-sample selection separate from analysis inclusion", () => {
    const onActivate = vi.fn();
    const onToggleIncluded = vi.fn();
    const onInvertIncluded = vi.fn();
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="a"
        excludedIds={new Set(["b"])}
        busy={false}
        importProgress={null}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={onActivate}
        onToggleIncluded={onToggleIncluded}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={onInvertIncluded}
      />,
    ));

    const rows = host.querySelectorAll<HTMLElement>('[role="option"]');
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    act(() => rows[1].click());
    expect(onActivate).toHaveBeenCalledWith("b");

    const includeB = host.querySelector<HTMLInputElement>('input[aria-label="Include donor-b.fcs in analyses"]')!;
    expect(includeB.checked).toBe(false);
    act(() => includeB.click());
    expect(onToggleIncluded).toHaveBeenCalledWith("b", true);
    expect(onActivate).toHaveBeenCalledTimes(1);

    const invert = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Invert")!;
    act(() => invert.click());
    expect(onInvertIncluded).toHaveBeenCalledTimes(1);
  });
});

describe("SampleManagerModal", () => {
  it("uses a distinct management selection before confirming bulk removal", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const onToggleIncluded = vi.fn();
    act(() => root.render(
      <SampleManagerModal
        items={items}
        activeId="a"
        excludedIds={new Set()}
        onClose={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={onToggleIncluded}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
        onRemove={onRemove}
      />,
    ));

    const selectA = host.querySelector<HTMLInputElement>('input[aria-label="Select donor-a.fcs for management"]')!;
    act(() => selectA.click());
    expect(onToggleIncluded).not.toHaveBeenCalled();

    const removeSelected = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Remove selected…")!;
    act(() => removeSelected.click());
    expect(host.textContent).toContain("Remove 1 selected sample");

    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Remove")!;
    await act(async () => confirm.click());
    expect(onRemove).toHaveBeenCalledWith(["a"]);
  });
});

describe("FolderImportModal", () => {
  it("starts with top-level files and explicitly opts into subfolders", () => {
    const onImport = vi.fn();
    act(() => root.render(
      <FolderImportModal
        folderName="PBMC"
        items={[
          { id: "top", name: "top.fcs", relativePath: "top.fcs", size: 100, duplicateName: false },
          { id: "nested", name: "nested.fcs", relativePath: "batch/nested.fcs", size: 200, duplicateName: false },
          { id: "duplicate", name: "loaded.fcs", relativePath: "loaded.fcs", size: 300, duplicateName: true },
        ]}
        onCancel={vi.fn()}
        onImport={onImport}
      />,
    ));

    const fileCheckboxes = [...host.querySelectorAll<HTMLInputElement>('.gl-folder-import-list input[type="checkbox"]')];
    expect(fileCheckboxes.map((input) => [input.checked, input.disabled])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);

    const subfolders = host.querySelector<HTMLInputElement>('.gl-folder-import-actions input[type="checkbox"]')!;
    act(() => subfolders.click());
    expect(fileCheckboxes[1].disabled).toBe(false);
    expect(fileCheckboxes[1].checked).toBe(true);

    const importButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Import 2 files")!;
    act(() => importButton.click());
    expect(onImport).toHaveBeenCalledWith(expect.arrayContaining(["top", "nested"]));
    expect(onImport.mock.calls[0][0]).not.toContain("duplicate");
  });
});
