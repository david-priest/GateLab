// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatingMlImportModal } from "./CrudModals";
import { I18nProvider } from "./i18n";

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

function renderModal(mergeBlockedReason: string | null, onImport = vi.fn(), structureMatches = true) {
  act(() => root.render(
    <GatingMlImportModal
      nGates={3}
      nPopulations={2}
      sourceLabel="a GateLab / GateLabR export"
      currentRootName="All Events"
      hasExistingStrategy
      structureMatches={structureMatches}
      mergeBlockedReason={mergeBlockedReason}
      compensationNote={null}
      compensationNeedsConfirmation={false}
      matrixChoice={null}
      onMatrixChoice={vi.fn()}
      onCancel={vi.fn()}
      onImport={onImport}
    />,
  ));
  return onImport;
}

describe("GatingMlImportModal", () => {
  it("defaults to the non-destructive merge option for a tree of the workspace's structure and can explicitly select replacement", () => {
    const onImport = renderModal(null);
    const merge = host.querySelector<HTMLInputElement>('input[value="merge"]')!;
    const replace = host.querySelector<HTMLInputElement>('input[value="replace"]')!;
    expect(merge.checked).toBe(true);
    expect(replace.checked).toBe(false);
    expect(host.textContent).toContain("Merge with current strategy (recommended)");
    expect(host.textContent).not.toContain("Replace current strategy (recommended)");

    act(() => replace.click());
    const importButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Import")!;
    act(() => importButton.click());
    expect(onImport).toHaveBeenCalledWith("replace", "all");
  });

  // David, 2026-09-29: "Replace should be the default here." A tree whose structure differs from
  // the workspace's can only replace the tree for every file (the per-file targets are closed), and
  // the dialog still defaulted to Merge, marked recommended, which hangs it beneath the root.
  it("defaults to replacement, marked recommended, for a tree whose structure differs, whatever it was read from", () => {
    for (const sourceKind of ["gatingml", "flowjo", "diva", "chorus"] as const) {
      const onImport = vi.fn();
      act(() => root.render(
        <GatingMlImportModal
          key={sourceKind}
          nGates={3} nPopulations={2} sourceLabel="a Gating-ML file" sourceKind={sourceKind} currentRootName="All Events"
          hasExistingStrategy structureMatches={false} mergeBlockedReason={null}
          compensationNote={null} compensationNeedsConfirmation={false} matrixChoice={null}
          onMatrixChoice={vi.fn()} onCancel={vi.fn()} onImport={onImport}
          files={{ total: 2, selected: 2, viewedName: "D2.fcs", tailored: 0 }}
        />,
      ));
      const merge = host.querySelector<HTMLInputElement>('input[value="merge"]')!;
      const replace = host.querySelector<HTMLInputElement>('input[value="replace"]')!;
      expect(replace.checked).toBe(true);
      expect(merge.checked).toBe(false);
      expect(merge.disabled).toBe(false);
      expect(host.textContent).toContain("Replace current strategy (recommended)");
      expect(host.textContent).toContain("Merge with current strategy");
      expect(host.textContent).not.toContain("Merge with current strategy (recommended)");
      expect(host.querySelector<HTMLInputElement>('input[name="gatingml-import-target"][value="viewed"]')!.disabled).toBe(true);
      const importButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Import")!;
      act(() => importButton.click());
      expect(onImport).toHaveBeenCalledWith("replace", "all");
      // Merge is still there to choose.
      act(() => merge.click());
      act(() => importButton.click());
      expect(onImport).toHaveBeenLastCalledWith("merge", "all");
    }
  });

  it("disables merge and defaults to replacement when measurement spaces conflict", () => {
    renderModal("Merge is unavailable because compensation would change.");
    const merge = host.querySelector<HTMLInputElement>('input[value="merge"]')!;
    const replace = host.querySelector<HTMLInputElement>('input[value="replace"]')!;
    expect(merge.disabled).toBe(true);
    expect(merge.checked).toBe(false);
    expect(replace.checked).toBe(true);
    expect(host.textContent).toContain("Replace current strategy (recommended)");
    expect(host.textContent).toContain("compensation would change");
  });

  it("names a Gating-ML file, not a workspace, as the source of the matrix it carries", () => {
    const render = (source: "workspace" | "gatingml") => act(() => root.render(
      <I18nProvider>
        <GatingMlImportModal
          nGates={3}
          nPopulations={2}
          sourceLabel="a GateLab / GateLabR export"
          currentRootName="All Events"
          hasExistingStrategy={false}
          mergeBlockedReason={null}
          compensationNote={null}
          compensationNeedsConfirmation={false}
          matrixChoice={{ workspaceLabel: "Matrix_B1", maxDelta: 0.1, value: "workspace", source }}
          onMatrixChoice={vi.fn()}
          onCancel={vi.fn()}
          onImport={vi.fn()}
        />
      </I18nProvider>,
    ));
    render("gatingml");
    expect(host.textContent).toContain("This FCS and the Gating-ML file each carry a spillover matrix");
    expect(host.textContent).toContain("The Gating-ML file's — Matrix_B1.");
    expect(host.textContent).not.toContain("workspace's");
    render("workspace");
    expect(host.textContent).toContain("This FCS and the workspace each carry a spillover matrix");
    expect(host.textContent).toContain("The workspace's — Matrix_B1.");
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    act(() => root.unmount());
    root = createRoot(host);
    render("gatingml");
    expect(host.textContent).toContain("このFCSとGating-MLファイルはそれぞれスピルオーバー行列を持ち");
    expect(host.textContent).toContain("Gating-MLファイルの行列 — Matrix_B1。");
    window.localStorage.removeItem("gatelab.uiLanguage");
  });

  it("holds Import for a compensation the file does not carry until a matrix is supplied or the FCS file's is chosen", () => {
    // Gates whose Cytobank compensation_id names a matrix the file does not carry were evaluated
    // with the FCS file's own matrix, unasked.
    const onImport = vi.fn();
    const onSupply = vi.fn();
    const onUseFcs = vi.fn();
    const render = (missing: { supplied: string | null; useFcs: boolean; error: string | null }) => act(() => root.render(
      <I18nProvider>
        <GatingMlImportModal
          nGates={3}
          nPopulations={2}
          sourceLabel="a Cytobank export"
          currentRootName="All Events"
          hasExistingStrategy={false}
          mergeBlockedReason={null}
          compensationNote="The gate drawn under Cytobank compensation 5, which this file names but does not carry."
          compensationNeedsConfirmation
          matrixChoice={null}
          onMatrixChoice={vi.fn()}
          onCancel={vi.fn()}
          onImport={onImport}
          missingMatrix={missing}
          onSupplyMatrix={onSupply}
          onUseFcsMatrix={onUseFcs}
        />
      </I18nProvider>,
    ));
    const importButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Import")!;
    render({ supplied: null, useFcs: false, error: null });
    expect(importButton().disabled).toBe(true);
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => box.click());
    expect(onUseFcs).toHaveBeenCalledWith(true);
    const file = new File(["x"], "matrix.csv", { type: "text/csv" });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onSupply).toHaveBeenCalledWith(file);

    render({ supplied: null, useFcs: true, error: null });
    expect(importButton().disabled).toBe(false);
    render({ supplied: "matrix.csv", useFcs: false, error: null });
    expect(importButton().disabled).toBe(false);
    expect(host.textContent).toContain("The gates will be evaluated with the matrix from matrix.csv.");
    act(() => importButton().click());
    expect(onImport).toHaveBeenCalledWith("replace", "all");
  });

  // The matrix question names every file whose own matrix differs from its sample's: it used to
  // be put for the primary alone, and another file's was settled without a word.
  it("names the files whose matrices differ, when a per-file import has several", () => {
    act(() => root.render(
      <GatingMlImportModal
        nGates={3} nPopulations={2} sourceLabel="a FlowJo workspace" currentRootName="All Events"
        hasExistingStrategy={false} mergeBlockedReason={null} compensationNote={null} compensationNeedsConfirmation={false}
        matrixChoice={{ workspaceLabel: "Acquisition", maxDelta: 0.0123, value: "workspace", files: ["D2.fcs", "D3.fcs"] }}
        onMatrixChoice={vi.fn()} onCancel={vi.fn()} onImport={vi.fn()}
        perFileNames={["D1.fcs", "D2.fcs", "D3.fcs"]} followNames={["X.fcs"]}
      />,
    ));
    expect(host.textContent).toContain("These files and their samples in the workspace each carry a spillover matrix, and they differ by up to 0.0123: D2.fcs, D3.fcs.");
    expect(host.textContent).toContain("These follow the tree without a tree of their own: X.fcs.");
  });

  // A FACSDiva or FACSChorus experiment is not a workspace, and its files are tubes or recordings,
  // not samples: the result said so, and this dialog still said "its own sample's tree: one tree
  // for the workspace".
  it("says a FACSDiva or FACSChorus per-file import as in the experiment", () => {
    const render = (sourceKind: "diva" | "chorus" | "flowjo", hasExistingStrategy = false) => act(() => root.render(
      <GatingMlImportModal
        key={`${sourceKind}-${hasExistingStrategy}`}
        nGates={3} nPopulations={2} sourceLabel="an experiment" currentRootName="All Events" sourceKind={sourceKind}
        hasExistingStrategy={hasExistingStrategy} mergeBlockedReason={null} compensationNote={null} compensationNeedsConfirmation={false}
        matrixChoice={null} onMatrixChoice={vi.fn()} onCancel={vi.fn()} onImport={vi.fn()}
        perFileNames={["D1.fcs", "D2.fcs"]} structureMatches={hasExistingStrategy}
      />,
    ));
    render("diva");
    expect(host.textContent).toContain("Each of these 2 files gets its own tube's tree, as in the experiment: one tree, tailored per file where they differ: D1.fcs, D2.fcs.");
    expect(host.textContent).not.toContain("workspace");
    render("chorus");
    expect(host.textContent).toContain("Each of these 2 files gets the tree it was recorded under, as in the experiment: one tree, tailored per file where they differ: D1.fcs, D2.fcs.");
    expect(host.textContent).not.toContain("workspace");
    // Merged (the default for a tree of the workspace's structure), only the viewed file's is.
    render("diva", true);
    expect(host.textContent).toContain("Replace the current strategy to give each of the 2 files its own tube's tree.");
    render("flowjo");
    expect(host.textContent).toContain("Each of these 2 files gets its own sample's tree: one tree for the workspace, tailored per file where they differ: D1.fcs, D2.fcs.");
  });
});

// In Japanese the dialog said "a FlowJo workspaceから…": the source was passed into the sentence
// untranslated (the release candidate's browser verifier).
describe("GatingMlImportModal in Japanese", () => {
  it("names the source in Japanese inside the Japanese sentence", () => {
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    try {
      act(() => root.render(
        <I18nProvider>
          <GatingMlImportModal
            nGates={3}
            nPopulations={2}
            sourceLabel="a FlowJo workspace"
            sourceKind="flowjo"
            currentRootName="All Events"
            hasExistingStrategy={false}
            mergeBlockedReason={null}
            compensationNote={null}
            compensationNeedsConfirmation={false}
            matrixChoice={null}
            onMatrixChoice={vi.fn()}
            onCancel={vi.fn()}
            onImport={vi.fn()}
          />
        </I18nProvider>,
      ));
      expect(host.textContent).toContain("FlowJoワークスペースからゲート3件、集団2件を読み込みました。");
      expect(host.textContent).not.toContain("a FlowJo workspace");
    } finally {
      window.localStorage.removeItem("gatelab.uiLanguage");
    }
  });

  it("marks the default recommended in Japanese: replacement for a tree of another structure, merging for one of the same", () => {
    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    try {
      const render = (structureMatches: boolean) => act(() => root.render(
        <I18nProvider>
          <GatingMlImportModal
            key={String(structureMatches)}
            nGates={3} nPopulations={2} sourceLabel="a FlowJo workspace" sourceKind="flowjo" currentRootName="All Events"
            hasExistingStrategy structureMatches={structureMatches} mergeBlockedReason={null}
            compensationNote={null} compensationNeedsConfirmation={false} matrixChoice={null}
            onMatrixChoice={vi.fn()} onCancel={vi.fn()} onImport={vi.fn()}
          />
        </I18nProvider>,
      ));
      render(false);
      expect(host.textContent).toContain("現在の戦略を置換（推奨）");
      expect(host.textContent).toContain("現在の戦略と統合");
      expect(host.textContent).not.toContain("現在の戦略と統合（推奨）");
      render(true);
      expect(host.textContent).toContain("現在の戦略と統合（推奨）");
      expect(host.textContent).not.toContain("現在の戦略を置換（推奨）");
    } finally {
      window.localStorage.removeItem("gatelab.uiLanguage");
    }
  });
});
