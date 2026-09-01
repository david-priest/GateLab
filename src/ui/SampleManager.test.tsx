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
  it("keeps active-sample selection separate from display and analysis inclusion", () => {
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
    expect(rows[0].classList.contains("included")).toBe(true);
    expect(rows[1].getAttribute("aria-selected")).toBe("false");
    act(() => rows[1].click());
    expect(onActivate).toHaveBeenCalledWith("b");

    const includeB = host.querySelector<HTMLInputElement>(
      'input[aria-label="Show donor-b.fcs in plots and analyses"]',
    )!;
    expect(includeB.checked).toBe(false);
    expect(includeB.closest(".gl-sample-row")?.classList.contains("included")).toBe(false);
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

// Dragging FCS files onto the samples panel is just another way to reach the same import as
// "+ Files…", so the panel has to arm for file drags only, stay inert while an import is running
// or when samples come from a host, and report folders rather than silently dropping them.
describe("SampleNavigator drag and drop", () => {
  function renderNavigator(props: {
    onDropFiles?: (files: readonly File[], directoryCount: number) => void;
    busy?: boolean;
    showImportActions?: boolean;
  }) {
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="a"
        excludedIds={new Set()}
        busy={props.busy ?? false}
        importProgress={null}
        showImportActions={props.showImportActions ?? true}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
        onDropFiles={props.onDropFiles}
      />,
    ));
    return host.querySelector(".gl-sample-navigator") as HTMLElement;
  }

  function dispatch(
    target: HTMLElement,
    type: string,
    transfer: { types: string[]; files?: File[]; items?: unknown[] },
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        types: transfer.types,
        files: transfer.files ?? [],
        items: transfer.items ?? [],
        dropEffect: "none",
      },
    });
    act(() => { target.dispatchEvent(event); });
    return event;
  }

  const fcs = () => new File(["FCS3.1"], "donor-c.fcs");
  const directoryItem = { webkitGetAsEntry: () => ({ isDirectory: true }) };

  it("hands dropped files to the importer", () => {
    const onDropFiles = vi.fn();
    const panel = renderNavigator({ onDropFiles });
    const file = fcs();

    dispatch(panel, "drop", { types: ["Files"], files: [file] });

    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles.mock.calls[0][0]).toEqual([file]);
    expect(onDropFiles.mock.calls[0][1]).toBe(0);
  });

  it("shows the drop target only while a file drag is over the panel", () => {
    const panel = renderNavigator({ onDropFiles: vi.fn() });

    dispatch(panel, "dragenter", { types: ["Files"] });
    expect(host.querySelector(".gl-sample-drop-overlay")).not.toBeNull();
    expect(panel.className).toContain("is-drop-target");

    dispatch(panel, "dragleave", { types: ["Files"] });
    expect(host.querySelector(".gl-sample-drop-overlay")).toBeNull();
  });

  it("stays armed while the drag crosses child elements", () => {
    const panel = renderNavigator({ onDropFiles: vi.fn() });
    const child = panel.querySelector("button") as HTMLElement;

    dispatch(panel, "dragenter", { types: ["Files"] });
    // Entering a child fires enter before the matching leave on the parent; a plain boolean
    // would flicker the target off here.
    dispatch(child, "dragenter", { types: ["Files"] });
    dispatch(panel, "dragleave", { types: ["Files"] });

    expect(host.querySelector(".gl-sample-drop-overlay")).not.toBeNull();
  });

  it("ignores a drag that carries no files", () => {
    const onDropFiles = vi.fn();
    const panel = renderNavigator({ onDropFiles });

    dispatch(panel, "dragenter", { types: ["text/plain"] });
    expect(host.querySelector(".gl-sample-drop-overlay")).toBeNull();

    dispatch(panel, "drop", { types: ["text/plain"] });
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("counts dropped folders so the caller can point at the folder importer", () => {
    const onDropFiles = vi.fn();
    const panel = renderNavigator({ onDropFiles });

    dispatch(panel, "drop", {
      types: ["Files"],
      files: [new File([""], "PBMC")],
      items: [directoryItem],
    });

    expect(onDropFiles.mock.calls[0][1]).toBe(1);
  });

  it("refuses a drop while an import is already running", () => {
    const onDropFiles = vi.fn();
    const panel = renderNavigator({ onDropFiles, busy: true });

    dispatch(panel, "dragenter", { types: ["Files"] });
    dispatch(panel, "drop", { types: ["Files"], files: [fcs()] });

    expect(host.querySelector(".gl-sample-drop-overlay")).toBeNull();
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("refuses a drop when samples do not come from files", () => {
    const onDropFiles = vi.fn();
    const panel = renderNavigator({ onDropFiles, showImportActions: false });

    dispatch(panel, "drop", { types: ["Files"], files: [fcs()] });

    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("leaves the drop inert when no handler is supplied", () => {
    const panel = renderNavigator({});

    const event = dispatch(panel, "drop", { types: ["Files"], files: [fcs()] });

    expect(host.querySelector(".gl-sample-drop-overlay")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
