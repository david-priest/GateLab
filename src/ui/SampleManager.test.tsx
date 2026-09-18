// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareSampleNames, FolderImportModal, SampleManagerModal, SampleNavigator, type SampleListItem } from "./SampleManager";

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
  it("selects visible ranges, toggles rows and supports keyboard focus independently of inspection", () => {
    const onInspect = vi.fn();
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `D${i + 1}`, name: `D${i + 1}.fcs`, eventCount: 100, channelCount: 2 }));
    function Harness() {
      const [excluded, setExcluded] = useState(new Set(many.map(item => item.id)));
      const select = (ids: readonly string[]) => setExcluded(new Set(many.filter(item => !ids.includes(item.id)).map(item => item.id)));
      return <SampleNavigator items={many} activeId="D1" excludedIds={excluded} busy={false} importProgress={null}
        onOpenFiles={vi.fn()} onOpenFolder={vi.fn()} onManage={vi.fn()} onManageSample={vi.fn()}
        onActivate={id => select([id])} onInspect={onInspect} onSelectIds={select}
        onToggleIncluded={(id, included) => setExcluded(previous => { const next = new Set(previous); included ? next.delete(id) : next.add(id); return next; })}
        onIncludeAll={() => select(many.map(item => item.id))} onIncludeNone={() => select([])} onInvertIncluded={vi.fn()} />;
    }
    act(() => root.render(<Harness />));
    const rows = () => [...host.querySelectorAll<HTMLElement>('.gl-sample-row')];
    const selected = () => rows().filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.querySelector('.gl-sample-name')!.textContent);
    const click = (index: number, options = {}) => act(() => rows()[index].dispatchEvent(new MouseEvent('click', { bubbles: true, ...options })));
    click(1); click(4, { shiftKey: true });
    expect(selected()).toEqual(['D2.fcs', 'D3.fcs', 'D4.fcs', 'D5.fcs']);
    click(2, { metaKey: true });
    expect(selected()).toEqual(['D2.fcs', 'D4.fcs', 'D5.fcs']);
    click(0, { ctrlKey: true });
    expect(selected()).toEqual(['D1.fcs', 'D2.fcs', 'D4.fcs', 'D5.fcs']);
    const key = (index: number, key: string, options = {}) => act(() => rows()[index].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...options })));
    key(0, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    // A plain arrow views the file it lands on and leaves the selection alone.
    expect(onInspect).toHaveBeenCalledWith('D2');
    expect(selected()).toHaveLength(4);
    key(1, 'ArrowDown', { metaKey: true });
    expect(document.activeElement).toBe(rows()[2]);
    expect(onInspect).not.toHaveBeenCalledWith('D3');
    key(1, 'Enter'); expect(onInspect).toHaveBeenCalledWith('D2');
    key(1, 'a', { metaKey: true }); expect(selected()).toHaveLength(6);
    click(4); key(4, 'ArrowUp', { shiftKey: true });
    expect(selected()).toEqual(['D4.fcs', 'D5.fcs']);
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1);
    key(3, ' '); expect(selected()).toEqual(['D5.fcs']);
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'D6'); search.dispatchEvent(new Event('input', { bubbles: true })); });
    click(0, { shiftKey: true }); // hidden anchor: start a new range, never select hidden files
    expect(selected()).toEqual(['D6.fcs']);
    key(0, 'a', { ctrlKey: true });
    expect(selected()).toEqual(['D6.fcs']);
    expect(host.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true');
  });
  it("marks a tailored file with how many gates it tailored, the names on hover", () => {
    const tagged: SampleListItem[] = [
      { ...items[0] },
      { ...items[1], tailored: ["Cells", "Singlets"] },
    ];
    act(() => root.render(
      <SampleNavigator
        items={tagged}
        activeId="a"
        excludedIds={new Set()}
        busy={false}
        importProgress={null}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
    const badges = Array.from(host.querySelectorAll<HTMLElement>(".gl-sample-row .gl-sample-tailored"));
    expect(badges.map((b) => b.textContent)).toEqual(["2"]);
    expect(badges[0].title).toBe("2 gates tailored for this file: Cells, Singlets");
    expect(badges[0].closest(".gl-sample-row")!.textContent).toContain("donor-b.fcs");
    expect(host.querySelector(".gl-sample-scope-key")!.textContent).toContain("gates tailored for that file");
  });

  it("tags a file with its group, and the Groups menu acts on the selected files", () => {
    const onGroupAction = vi.fn();
    const tagged: SampleListItem[] = [{ ...items[0], group: "Treated", groupColour: "#e6820e" }, { ...items[1] }];
    act(() => root.render(
      <SampleNavigator
        items={tagged}
        activeId="a"
        excludedIds={new Set(["b"])}
        busy={false}
        importProgress={null}
        groups={[{ id: "g1", name: "Treated" }]}
        onGroupAction={onGroupAction}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
    const tags = [...host.querySelectorAll<HTMLElement>(".gl-sample-row .gl-sample-group")];
    expect(tags.map((tag) => tag.textContent)).toEqual(["Treated"]);
    expect(tags[0].closest(".gl-sample-row")!.textContent).toContain("donor-a.fcs");
    expect(tags[0].style.background).toContain("230, 130, 14"); // the group's own colour
    const item = (cls: string) => host.querySelector<HTMLButtonElement>(`.gl-sample-groups-menu .${cls}`)!;
    expect(item("gl-sample-group-new").textContent).toBe("New group from the 1 selected…");
    act(() => item("gl-sample-group-new").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "new" });
    expect(item("gl-sample-group-assign").textContent).toBe("Add the 1 selected to Treated");
    act(() => item("gl-sample-group-assign").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "assign", groupId: "g1" });
    act(() => item("gl-sample-group-remove").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "remove" });
    act(() => item("gl-sample-group-rename").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "rename", groupId: "g1" });
    act(() => item("gl-sample-group-delete").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "delete", groupId: "g1" });
    // Groups from a metadata column: offered only when the workspace has columns.
    expect(item("gl-sample-group-from-metadata").disabled).toBe(true);
    act(() => root.render(
      <SampleNavigator
        items={tagged}
        activeId="a"
        excludedIds={new Set(["b"])}
        busy={false}
        importProgress={null}
        groups={[{ id: "g1", name: "Treated" }]}
        facetColumnNames={["condition"]}
        onGroupAction={onGroupAction}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
    expect(item("gl-sample-group-from-metadata").disabled).toBe(false);
    act(() => item("gl-sample-group-from-metadata").click());
    expect(onGroupAction).toHaveBeenCalledWith({ kind: "fromMetadata" });
    // Creation first, then the assignments, then each group's own entries, separated.
    const labels = [...host.querySelectorAll<HTMLElement>(".gl-sample-groups-menu [role='menuitem'], .gl-sample-groups-menu [role='separator']")].map((el) => el.getAttribute("role") === "separator" ? "—" : el.textContent);
    expect(labels).toEqual(["New group from the 1 selected…", "Groups from a metadata column…", "—", "Add the 1 selected to Treated", "Remove the 1 selected from their group", "—", "Rename Treated…", "Delete Treated…"]);
  });

  it("shows no badge and no key while nothing is tailored", () => {
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="a"
        excludedIds={new Set()}
        busy={false}
        importProgress={null}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
    expect(host.querySelector(".gl-sample-tailored")).toBeNull();
    expect(host.querySelector(".gl-sample-scope-key")!.textContent).not.toContain("tailored");
  });

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

    expect(host.querySelector('.gl-sample-row input[type="checkbox"]')).toBeNull();
    act(() => rows[1].dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
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

// Files arrive in whichever order the picker produced, so the manage dialog offers to reorder the
// workspace by name. The ordering has to read the way a person reads a filename, not the way a
// byte comparison does.
describe("sorting samples by name", () => {
  it("puts exp10 after exp9 rather than after exp1", () => {
    const names = ["exp10_T2.fcs", "exp2_T2.fcs", "exp1_T2.fcs", "exp9_T2.fcs"];
    expect([...names].sort(compareSampleNames)).toEqual([
      "exp1_T2.fcs", "exp2_T2.fcs", "exp9_T2.fcs", "exp10_T2.fcs",
    ]);
    // Plain lexicographic ordering is the trap this exists to avoid.
    expect([...names].sort()).not.toEqual([...names].sort(compareSampleNames));
  });

  it("does not sort a file away from its neighbours over a stray capital", () => {
    expect(compareSampleNames("Donor_b.fcs", "donor_a.fcs")).toBeGreaterThan(0);
    expect(compareSampleNames("donor_A.fcs", "donor_a.fcs")).toBe(0);
  });

  function renderManager(onSort?: (direction: "asc" | "desc") => void) {
    act(() => root.render(
      <SampleManagerModal
        items={items}
        activeId="a"
        excludedIds={new Set()}
        onClose={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
        onRemove={vi.fn(async () => {})}
        onSort={onSort}
      />,
    ));
  }

  function sortButton(label: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === label);
  }

  it("asks for each direction from the manage dialog", () => {
    const onSort = vi.fn();
    renderManager(onSort);

    act(() => sortButton("Name A–Z")!.click());
    expect(onSort).toHaveBeenLastCalledWith("asc");

    act(() => sortButton("Name Z–A")!.click());
    expect(onSort).toHaveBeenLastCalledWith("desc");
  });

  it("offers no reordering when the sample order is not the user's to change", () => {
    // A hosted SCE owns its sample list, so App passes no handler and the controls stay away
    // rather than appearing and doing nothing.
    renderManager(undefined);
    expect(sortButton("Name A–Z")).toBeUndefined();
    expect(sortButton("Name Z–A")).toBeUndefined();
  });
});

// A chip is a bulk checkbox for its group: the fill says how much of the group is checked, and a
// click flips exactly that. There is no second state to read.
describe("SampleNavigator metadata chips", () => {
  const faceted: SampleListItem[] = [
    { id: "s1", name: "D1_treated.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D1", stim: "treated" } },
    { id: "s2", name: "D1_control.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D1", stim: "control" } },
    { id: "s3", name: "D2_treated.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D2", stim: "treated" } },
  ];
  const donorFacet = {
    name: "donor",
    values: [
      { value: "D1", sampleIds: ["s1", "s2"] },
      { value: "D2", sampleIds: ["s3"] },
    ],
    covered: 3,
    sampleCount: 3,
  };

  function render(props: { excluded?: string[]; onToggleFacet?: (column: string, value: string) => void }) {
    act(() => root.render(
      <SampleNavigator
        items={faceted}
        activeId="s1"
        excludedIds={new Set(props.excluded ?? [])}
        busy={false}
        importProgress={null}
        facets={[donorFacet]}
        facetColumnNames={["donor", "stim"]}
        onToggleFacet={props.onToggleFacet ?? vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
  }

  const chip = (value: string) => [...host.querySelectorAll<HTMLButtonElement>(".gl-sample-facet-chip")]
    .find((button) => button.textContent?.startsWith(value));

  it("fills a chip whose group is entirely checked", () => {
    render({});
    expect(chip("D1")?.textContent).toContain("2/2");
    expect(chip("D1")?.className).toContain("is-all");
    expect(chip("D1")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("tints a chip whose group is only partly checked", () => {
    render({ excluded: ["s2"] });
    expect(chip("D1")?.textContent).toContain("1/2");
    expect(chip("D1")?.className).toContain("is-some");
    expect(chip("D1")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("empties a chip whose group is unchecked", () => {
    render({ excluded: ["s1", "s2"] });
    expect(chip("D1")?.className).toContain("is-none");
  });

  it("carries no second state beyond how much is checked", () => {
    // The halo that used to mark a chip as "picked" was a second thing to read for no gain.
    render({ excluded: ["s2"] });
    expect(chip("D1")?.className).not.toContain("is-picked");
  });

  it("asks the caller to toggle the value it was given", () => {
    const onToggleFacet = vi.fn();
    render({ onToggleFacet });
    act(() => chip("D2")!.click());
    expect(onToggleFacet).toHaveBeenCalledWith("donor", "D2");
  });

  it("leaves the sample list alone: chips select, they do not filter", () => {
    render({ excluded: ["s1", "s2"] });
    expect([...host.querySelectorAll(".gl-sample-name")]).toHaveLength(3);
  });

  it("stays out of the way when the workspace has no metadata", () => {
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="a"
        excludedIds={new Set()}
        busy={false}
        importProgress={null}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
    expect(host.querySelector(".gl-sample-facet-board")).toBeNull();
  });
});

// The partial state is the one nobody chooses -- it falls out of other clicks -- so it has to
// explain itself rather than be a second colour to learn.
describe("SampleNavigator chip fill", () => {
  const items3: SampleListItem[] = [
    { id: "s1", name: "a.fcs", eventCount: 1, channelCount: 1, metadata: { donor: "D1" } },
    { id: "s2", name: "b.fcs", eventCount: 1, channelCount: 1, metadata: { donor: "D1" } },
    { id: "s3", name: "c.fcs", eventCount: 1, channelCount: 1, metadata: { donor: "D1" } },
    { id: "s4", name: "d.fcs", eventCount: 1, channelCount: 1, metadata: { donor: "D1" } },
  ];
  const facet = {
    name: "donor",
    values: [{ value: "D1", sampleIds: ["s1", "s2", "s3", "s4"] }],
    covered: 4,
    sampleCount: 4,
  };

  function chipWith(excluded: string[]) {
    act(() => root.render(
      <SampleNavigator
        items={items3}
        activeId="s1"
        excludedIds={new Set(excluded)}
        busy={false}
        importProgress={null}
        facets={[facet]}
        onToggleFacet={vi.fn()}
        onOpenFiles={vi.fn()} onOpenFolder={vi.fn()} onManage={vi.fn()} onManageSample={vi.fn()}
        onActivate={vi.fn()} onToggleIncluded={vi.fn()} onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()} onInvertIncluded={vi.fn()}
      />,
    ));
    return host.querySelector<HTMLButtonElement>(".gl-sample-facet-chip")!;
  }

  it("fills to the fraction that is checked", () => {
    expect(chipWith(["s3", "s4"]).style.getPropertyValue("--gl-facet-fill")).toBe("50%");
    expect(chipWith(["s4"]).style.getPropertyValue("--gl-facet-fill")).toBe("75%");
  });

  it("carries no fraction when the group is all in or all out", () => {
    // Those two are solid and empty; a gradient would only muddy an unambiguous state.
    expect(chipWith([]).style.getPropertyValue("--gl-facet-fill")).toBe("");
    expect(chipWith(["s1", "s2", "s3", "s4"]).style.getPropertyValue("--gl-facet-fill")).toBe("");
  });
});

describe("SampleNavigator columns that do not line up with samples", () => {
  const items: SampleListItem[] = [
    { id: "s1", name: "a.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D1", gate: "TRUE" } },
    { id: "s2", name: "b.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D1" } },
    { id: "s3", name: "c.fcs", eventCount: 100, channelCount: 4, metadata: { donor: "D2" } },
  ];
  const gateFacet = { name: "gate", values: [{ value: "TRUE", sampleIds: ["s1"] }], covered: 1, sampleCount: 3 };
  const donorFacet = {
    name: "donor",
    values: [{ value: "D1", sampleIds: ["s1", "s2"] }, { value: "D2", sampleIds: ["s3"] }],
    covered: 3,
    sampleCount: 3,
  };

  function render(facets: typeof gateFacet[]) {
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="s1"
        excludedIds={new Set<string>()}
        busy={false}
        importProgress={null}
        facets={facets}
        facetColumnNames={["donor", "gate"]}
        facetPartialColumns={["gate"]}
        onToggleFacet={vi.fn()}
        onSetFacetColumns={vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
  }

  it("marks the row with how many samples the column reaches", () => {
    render([gateFacet]);
    const label = host.querySelector(".gl-sample-facet-name.is-partial");
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain("1/3");
    expect(label?.getAttribute("title") ?? "").toContain("per-event data");
  });

  it("marks the column in the columns control before it is pinned", () => {
    render([donorFacet]);
    const button = Array.from(host.querySelectorAll("button"))
      .find((element) => (element.textContent ?? "").includes("Columns"));
    act(() => { button?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    const labels = Array.from(host.querySelectorAll(".gl-sample-facet-columns label"));
    const gate = labels.find((element) => (element.textContent ?? "").includes("gate"));
    const donor = labels.find((element) => (element.textContent ?? "").includes("donor"));
    expect(gate?.className).toContain("is-partial");
    expect(donor?.className ?? "").not.toContain("is-partial");
  });
});

describe("SampleNavigator row locks", () => {
  const items: SampleListItem[] = [
    { id: "a", name: "a.fcs", eventCount: 10, channelCount: 2, metadata: { cell: "CTL", stim: "control" } },
    { id: "b", name: "b.fcs", eventCount: 10, channelCount: 2, metadata: { cell: "CTL", stim: "treated" } },
    { id: "c", name: "c.fcs", eventCount: 10, channelCount: 2, metadata: { cell: "Naive", stim: "control" } },
  ];
  const cellFacet = {
    name: "cell",
    values: [{ value: "CTL", sampleIds: ["a", "b"] }, { value: "Naive", sampleIds: ["c"] }],
    covered: 3,
    sampleCount: 3,
  };

  function render(props: {
    excluded?: string[];
    locks?: Record<string, readonly string[]>;
    facets?: typeof cellFacet[];
    outside?: number;
    onToggleFacetLock?: (column: string) => void;
  }) {
    act(() => root.render(
      <SampleNavigator
        items={items}
        activeId="a"
        excludedIds={new Set(props.excluded ?? [])}
        busy={false}
        importProgress={null}
        facets={props.facets ?? [cellFacet]}
        facetColumnNames={["cell", "stim"]}
        facetLocks={props.locks ?? {}}
        facetLockOutside={props.outside ?? 0}
        onToggleFacet={vi.fn()}
        onToggleFacetLock={props.onToggleFacetLock ?? vi.fn()}
        onOpenFiles={vi.fn()}
        onOpenFolder={vi.fn()}
        onManage={vi.fn()}
        onManageSample={vi.fn()}
        onActivate={vi.fn()}
        onToggleIncluded={vi.fn()}
        onIncludeAll={vi.fn()}
        onIncludeNone={vi.fn()}
        onInvertIncluded={vi.fn()}
      />,
    ));
  }

  const lock = () => host.querySelector<HTMLButtonElement>(".gl-sample-facet-lock");

  it("cannot lock a row with nothing checked in it", () => {
    render({ excluded: ["a", "b", "c"] });
    expect(lock()?.disabled).toBe(true);
  });

  it("locks the row on the user's click", () => {
    const onToggleFacetLock = vi.fn();
    render({ excluded: ["c"], onToggleFacetLock });
    expect(lock()?.disabled).toBe(false);
    act(() => { lock()?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onToggleFacetLock).toHaveBeenCalledWith("cell");
  });

  it("writes the frozen value on the row, not only in a tooltip", () => {
    render({ excluded: ["c"], locks: { cell: ["CTL"] } });
    expect(lock()?.className).toContain("is-locked");
    expect(host.querySelector(".gl-sample-facet-held")?.textContent).toBe("CTL");
  });

  it("shows a value the lock rules out as empty rather than as fully checked", () => {
    // What App hands down under a lock on CTL: the Naive group has no reachable sample.
    const held = {
      ...cellFacet,
      values: [{ value: "CTL", sampleIds: ["a", "b"] }, { value: "Naive", sampleIds: [] }],
    };
    render({ excluded: ["c"], locks: { cell: ["CTL"] }, facets: [held] });
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".gl-sample-facet-chip"));
    const naive = chips.find((chip) => (chip.textContent ?? "").startsWith("Naive"));
    expect(naive?.className).toContain("is-none");
    expect(naive?.className).not.toContain("is-all");
    expect(naive?.disabled).toBe(true);
    expect(naive?.getAttribute("aria-pressed")).toBe("false");
  });

  it("says how many checked samples no chip can count", () => {
    // All / None / Invert stay global, so they can check a sample the lock rules out. Without this
    // the board's chips would quietly account for fewer files than the tally.
    render({ locks: { cell: ["CTL"] }, outside: 1 });
    const outside = host.querySelector(".gl-sample-facet-outside");
    expect(outside?.textContent).toBe("+1");
    expect(outside?.getAttribute("title") ?? "").toContain("outside the rows being held fixed");
  });

  it("says nothing when every checked sample is inside the held rows", () => {
    render({ locks: { cell: ["CTL"] }, outside: 0 });
    expect(host.querySelector(".gl-sample-facet-outside")).toBeNull();
  });
});
