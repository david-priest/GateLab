// @vitest-environment jsdom
//
// The Export FlowJo workspace dialog lists each file with the tree it is gated under. A tailored
// file's tree is its own copy, named "<file> · <tree>", and was listed after the file's name as
// "D1.fcs · D1.fcs · Imported strategy" (FR-FCM-Z2V4, the release candidate's browser verifier).
// Synthetic names.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowJoExportModal, type FlowJoExportFolderOption } from "./CrudModals";
import { hasUiTranslation, I18nProvider } from "./i18n";
import type { FlowJoFolderPreview } from "../engine/flowjoExportFolder";

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

describe("FlowJoExportModal", () => {
  it("names a tailored file's own copy of the tree once, not with the file's name again", () => {
    act(() => root.render(
      <FlowJoExportModal
        files={[
          { id: "a", name: "D1.fcs", hierarchy: "D1.fcs · Imported strategy", checked: true },
          { id: "b", name: "D2.fcs", hierarchy: "Imported strategy", checked: true },
        ]}
        plan={() => ({ warnings: [], sampleCount: 2, gateCount: 4 })}
        onCancel={vi.fn()}
        onExport={vi.fn()}
      />,
    ));
    const rows = [...host.querySelectorAll(".gl-modal-list li")].map((li) => li.textContent);
    expect(rows).toEqual(["D1.fcs · Imported strategy, this file's own copy", "D2.fcs · Imported strategy"]);
    expect(hasUiTranslation("ja", "{tree}, this file's own copy")).toBe(true);
  });
});

describe("FlowJoExportModal's self-contained folder", () => {
  const files = [
    { id: "a", name: "D1.fcs", hierarchy: "Tree", checked: true },
    { id: "b", name: "D1.fcs", hierarchy: "Tree", checked: true },
    { id: "c", name: "D2.fcs", hierarchy: "Tree", checked: true },
  ];
  const preview: FlowJoFolderPreview = {
    folderName: "D1_and_2_more",
    workspaceName: "D1_and_2_more.wsp",
    fileCount: 2,
    fcsBytes: 1_834_000_000,
    zipBytes: 1_834_000_400,
    moved: [{ name: "D1.fcs", path: "2/D1.fcs" }],
    renamed: [],
    missing: ["D2.fcs"],
  };
  const render = (folder: FlowJoExportFolderOption, onExport = vi.fn()) => {
    act(() => root.render(
      <FlowJoExportModal files={files} plan={() => ({ warnings: [], sampleCount: 3, gateCount: 3 })} folder={folder} onCancel={vi.fn()} onExport={onExport} />,
    ));
    return onExport;
  };
  const box = () => host.querySelector<HTMLInputElement>('input[name="flowjo-export-folder"]')!;
  const exportButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Export")!;
  const text = () => host.textContent?.replace(/\s+/g, " ") ?? "";

  it("is off by default, and the workspace alone is exported until it is checked", () => {
    const onExport = render({ writes: "directory", preview: () => preview });
    expect(box().checked).toBe(false);
    expect(text()).not.toContain("are written into a new folder");
    act(() => exportButton().click());
    expect(onExport).toHaveBeenCalledWith("checked", false);
  });

  it("says, before writing, how much goes where, which files go in a subfolder and which it does not hold", () => {
    const onExport = render({ writes: "directory", preview: () => preview });
    act(() => box().click());
    expect(text()).toContain("D1_and_2_more.wsp and 2 FCS files, 1.8 GB, are written into a new folder, D1_and_2_more, inside the folder you choose.");
    expect(text()).toContain("In a subfolder under their own names, because another file of the export has the name; the workspace names each where it is:D1.fcs → 2/D1.fcs");
    const alert = [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
    expect(alert).toContain("GateLab does not hold the bytes of these files");
    expect(alert).toContain("D2.fcs");
    act(() => exportButton().click());
    expect(onExport).toHaveBeenCalledWith("checked", true);
  });

  it("offers one stored .zip where the browser cannot write a folder, and refuses one past 4 GB", () => {
    let zipBytes = preview.zipBytes;
    render({ writes: "zip", preview: () => ({ ...preview, zipBytes }) });
    act(() => box().click());
    expect(text()).toContain("This browser cannot write a folder, so the folder is downloaded as D1_and_2_more.zip, stored uncompressed: D1_and_2_more.wsp and 2 FCS files, at most 1.8 GB in all.");
    expect(exportButton().disabled).toBe(false);
    zipBytes = 5_000_000_000;
    render({ writes: "zip", preview: () => ({ ...preview, zipBytes }) });
    expect(text()).toContain("That is more than one .zip can hold (4.3 GB).");
    expect(exportButton().disabled).toBe(true);
  });

  it("lists, before writing, each file Chrome will not write under its own name, where it goes and why", () => {
    const renamed: FlowJoFolderPreview["renamed"] = [
      { name: "D1 1:2.fcs", path: "D1 1_2.fcs", problems: [{ kind: "characters", characters: [":"] }] },
      { name: "aux.fcs.", path: "_aux.fcs", problems: [{ kind: "ends" }, { kind: "reserved" }] },
      { name: "D3\u200b.lnk", path: "D3_.lnk.fcs", problems: [{ kind: "characters", characters: ["\u200b"] }, { kind: "extension", extension: "lnk" }] },
      { name: "AB~1.fcs", path: "AB_1.fcs", problems: [{ kind: "tilde" }] },
      { name: "..", path: "_", problems: [{ kind: "empty" }] },
    ];
    const onExport = render({ writes: "directory", preview: () => ({ ...preview, moved: [], renamed }) });
    act(() => box().click());
    expect(text()).toContain("Chrome will not write these names as they are, so each file is written under the name shown");
    const items = [...host.querySelectorAll(".gl-modal-field .gl-modal-list li")].map((li) => li.textContent);
    expect(items).toEqual([
      "D1 1:2.fcs → D1 1_2.fcs: holds :, which a file name cannot",
      'aux.fcs. → _aux.fcs: begins or ends with a space, "." or "~"; is a name Windows reserves',
      "D3\u200b.lnk → D3_.lnk.fcs: holds U+200B, which a file name cannot; ends in .lnk, which Chrome will not write",
      'AB~1.fcs → AB_1.fcs: is a short name with a "~", which Chrome will not write on Windows',
      '.. → _: is empty, "." or ".."',
    ]);
    // Written, not refused: every file and its pairing are kept.
    expect(exportButton().disabled).toBe(false);
    act(() => exportButton().click());
    expect(onExport).toHaveBeenCalledWith("checked", true);
  });

  it("is in Japanese in the Japanese UI", () => {
    const keys = [
      "Save the FCS files with it, in a self-contained folder",
      "Each file is written as GateLab loaded it, byte for byte, beside the workspace and under its own name, and the workspace names it there, so FlowJo, FlowKit, CytoML and GateLab find the files wherever the folder is moved.",
      "{workspace} and 1 FCS file, {size}, are written into a new folder, {folder}, inside the folder you choose.",
      "{workspace} and {count} FCS files, {size}, are written into a new folder, {folder}, inside the folder you choose.",
      "This browser cannot write a folder, so the folder is downloaded as {folder}.zip, stored uncompressed: {workspace} and 1 FCS file, at most {size} in all.",
      "This browser cannot write a folder, so the folder is downloaded as {folder}.zip, stored uncompressed: {workspace} and {count} FCS files, at most {size} in all.",
      "That is more than one .zip can hold ({limit}). Export fewer files, or use a browser that writes folders, such as Chrome or Edge.",
      "In a subfolder under their own names, because another file of the export has the name; the workspace names each where it is:",
      "Chrome will not write these names as they are, so each file is written under the name shown. The workspace names it by that name, and its bytes are unchanged, keywords and $FIL included, so FlowJo, FlowKit, CytoML and GateLab still pair it with its sample:",
      "holds {characters}, which a file name cannot",
      'begins or ends with a space, "." or "~"',
      "ends in .{extension}, which Chrome will not write",
      "is a name Windows reserves",
      'is a short name with a "~", which Chrome will not write on Windows',
      'is empty, "." or ".."',
      "GateLab does not hold the bytes of these files, so the folder will not have them; the workspace still names each, and FlowJo will look for it beside the workspace:",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    try {
      act(() => root.render(
        <I18nProvider>
          <FlowJoExportModal files={files} plan={() => ({ warnings: [], sampleCount: 3, gateCount: 3 })} folder={{ writes: "directory", preview: () => preview }} onCancel={vi.fn()} onExport={vi.fn()} />
        </I18nProvider>,
      ));
      act(() => box().click());
      expect(text()).toContain("選択したフォルダーの中に新しいフォルダー「D1_and_2_more」を作り、D1_and_2_more.wspと2個のFCSファイル（1.8 GB）を書き出します。");
    } finally {
      window.localStorage.removeItem("gatelab.uiLanguage");
    }
  });
});
