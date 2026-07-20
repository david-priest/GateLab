// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sha256Digest } from "../engine/compensationProfile";
import type { CompensationApplyProgress } from "../engine/compensationManager";
import type { CompensationProfileRecord } from "../engine/compensationProfileRecord";
import type { FcsFile } from "../engine/fcs";
import { Sample, type CompensatedLayerInput } from "../engine/sample";
import type { PersistedCompensatedLayerBinding } from "../engine/workspaceCompensation";
import {
  CompensationTab,
  type CompensationApplyUiStatus,
  type CompensationReviewPopulation,
  type CompensationSweepSolver,
} from "./CompensationTab";
import { clearPersistedTabState } from "./tabState";

const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}` as Sha256Digest;

function flowSample(options: Readonly<{
  coefficient?: number;
  channelCount?: number;
  matrix?: number[][];
  spillover?: boolean;
}> = {}): Sample {
  const channelCount = options.channelCount ?? 2;
  const fluorNames = Array.from({ length: channelCount }, (_, index) => `FL${index + 1}-A`);
  const markers = Array.from({ length: channelCount }, (_, index) => `Marker ${index + 1}`);
  const matrix = options.matrix ?? Array.from({ length: channelCount }, (_, source) =>
    Array.from({ length: channelCount }, (_, receiver) => {
      if (source === receiver) return 1;
      if (source === 0 && receiver === 1) return options.coefficient ?? 0.05;
      return (source + receiver + 1) / 100;
    }));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      ...fluorNames.map((name, index) => ({
        index: index + 1,
        name,
        marker: markers[index],
        bits: 32,
        range: 262144,
      })),
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400]),
      ...fluorNames.map((_, index) => Float32Array.from([index, index + 10, index + 20, index + 30])),
    ],
    spillover: options.spillover === false ? null : { channels: fluorNames, matrix },
  };
  return new Sample(fcs);
}

function cytofSample(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 3,
    instrument: "cytof",
    keywords: {},
    channels: [
      { index: 0, name: "Time", marker: null, bits: 32, range: 1000 },
      { index: 1, name: "Y89Di", marker: "CD45", bits: 32, range: 1000 },
      { index: 2, name: "In113Di", marker: "Barcode", bits: 32, range: 1000 },
    ],
    columns: [
      Float32Array.from([1, 2, 3]),
      Float32Array.from([10, 20, 30]),
      Float32Array.from([100, 200, 300]),
    ],
    spillover: null,
  };
  return new Sample(fcs);
}

function profileLayer(sample: Sample, kind: "flow-spillover" | "cytof-spillover"): CompensatedLayerInput {
  const method = kind === "flow-spillover" ? "matrix-inverse" : "nnls";
  const included = sample.channels.filter((channel) => channel.pnn !== "FSC-A" && channel.pnn !== "Time");
  const metadata: PersistedCompensatedLayerBinding = {
    profileId: `${kind}-profile`,
    profileHash: digest("a"),
    matrixHash: digest("b"),
    kind,
    method,
    includedPnns: included.map((channel) => channel.pnn),
    channelBindings: included.map((channel, matrixIndex) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.columnIndex,
      matrixSourceIndex: matrixIndex,
      matrixReceiverIndex: matrixIndex,
      included: true,
    })),
    transformBinding: kind === "flow-spillover"
      ? { kind: "flow-linear" }
      : { kind: "cytof-asinh", cofactor: 5 },
  };
  return {
    metadata,
    columns: included.map((channel, index) => ({
      pnn: channel.pnn,
      fcsColumnIndex: channel.columnIndex,
      values: Float32Array.from({ length: sample.fcs.nEvents }, (_, event) => (index + 1) * (event + 1)),
    })),
  };
}

let root: Root;
let host: HTMLDivElement;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  scrollIntoViewMock = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoViewMock,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

function renderTab(
  sample: Sample,
  options: Readonly<{
    compensationOn?: boolean;
    onApplyProfile?: (
      profile: CompensationProfileRecord,
      onProgress?: (progress: CompensationApplyProgress) => void,
    ) => Promise<void>;
    onCancelApply?: () => void;
    hasExistingGates?: boolean;
    applyStatus?: CompensationApplyUiStatus | null;
    installedProfile?: CompensationProfileRecord | null;
    applyWorkerCount?: number;
    applyWorkerLimit?: number;
    onApplyWorkerCountChange?: (count: number) => void;
    installedBaselineProfile?: CompensationProfileRecord | null;
    reviewPopulations?: readonly CompensationReviewPopulation[];
    reviewPopulationMasks?: Readonly<Record<string, Uint8Array>>;
    onSolveCompensationSweep?: CompensationSweepSolver;
    visible?: boolean;
    stateKey?: string;
  }> = {},
) {
  const stateKey = options.stateKey ?? "workspace-a:sample-a";
  act(() => root.render(
    <CompensationTab
      key={stateKey}
      sample={sample}
      compensationOn={options.compensationOn ?? false}
      onApplyProfile={options.onApplyProfile}
      onCancelApply={options.onCancelApply}
      hasExistingGates={options.hasExistingGates}
      applyStatus={options.applyStatus}
      installedProfile={options.installedProfile}
      applyWorkerCount={options.applyWorkerCount}
      applyWorkerLimit={options.applyWorkerLimit}
      onApplyWorkerCountChange={options.onApplyWorkerCountChange}
      installedBaselineProfile={options.installedBaselineProfile}
      reviewPopulations={options.reviewPopulations}
      reviewPopulationMasks={options.reviewPopulationMasks}
      onSolveCompensationSweep={options.onSolveCompensationSweep}
      visible={options.visible}
      stateKey={stateKey}
    />,
  ));
}

describe("CompensationTab common path", () => {
  it("surfaces the bounded Apply worker count and disables it while compensation runs", () => {
    const onChange = vi.fn();
    renderTab(flowSample(), {
      applyWorkerCount: 4,
      applyWorkerLimit: 8,
      onApplyWorkerCountChange: onChange,
    });
    const selector = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Compensation Apply worker count"]',
    )!;
    expect(selector.value).toBe("4");
    expect(selector.options).toHaveLength(8);
    act(() => {
      selector.value = "6";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(6);

    renderTab(flowSample(), {
      applyWorkerCount: 4,
      applyWorkerLimit: 8,
      onApplyWorkerCountChange: onChange,
      applyStatus: {
        phase: "applying",
        profileName: "test",
        fraction: 0.5,
        processedEvents: 2,
        totalEvents: 4,
      },
    });
    expect(host.querySelector<HTMLSelectElement>(
      'select[aria-label="Compensation Apply worker count"]',
    )?.disabled).toBe(true);
  });

  it("keeps one population selector in the tab header for every compensation view", () => {
    const sample = flowSample();
    renderTab(sample, {
      stateKey: "workspace-a:population-scope",
      reviewPopulations: [
        { id: "live", name: "Live cells", depth: 0, eventCount: 2 },
        { id: "t-cells", name: "T cells", depth: 1, eventCount: 1 },
      ],
      reviewPopulationMasks: {
        live: Uint8Array.from([1, 1, 0, 0]),
        "t-cells": Uint8Array.from([0, 1, 0, 0]),
      },
    });

    const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Compensation review population"]')!;
    expect(selector).not.toBeNull();
    expect(selector.closest(".gl-comp-overview")).not.toBeNull();
    expect(host.querySelectorAll('select[aria-label="Compensation review population"]')).toHaveLength(1);

    act(() => {
      selector.value = "live";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector(".gl-comp-review-population")?.textContent).toContain("2 events");
    expect(host.querySelector(".gl-comp-review-population")?.textContent).toContain("applies to biplots, attention ranking, and sweeps");

    const attention = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.includes("Flagged"))!;
    act(() => attention.click());
    expect(host.querySelectorAll('select[aria-label="Compensation review population"]')).toHaveLength(1);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Compensation review population"]')?.value).toBe("live");
  });

  it("opens matrix-first with useful advanced regions closed and unmounted", () => {
    renderTab(flowSample());

    expect(host.querySelector(".gl-comp-matrix")).not.toBeNull();
    expect(host.textContent).toContain("Embedded compensation matrix");
    expect(host.textContent).toContain("Assay selection in the top bar applies to every tab");

    const drawerButtons = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")];
    expect(drawerButtons.map((button) => button.textContent?.trim())).toEqual(["Evidence▸", "Review queue▸"]);
    expect(drawerButtons.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Propagation");
    expect(host.textContent).not.toContain("Biplot gallery");
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .map((button) => button.textContent?.trim())).toEqual([
        "Matrix",
        "Global inspector",
        "Flagged",
      ]);
  });

  it("renders scientifically consistent percentages and keeps immutable channel identities accessible", () => {
    const sample = flowSample();
    sample.setChannelLabel(sample.index("Marker 1")!, "Lymphocyte marker");
    sample.setChannelLabel(sample.index("Marker 2")!, "Lymphocyte marker");
    renderTab(sample);

    const matrix = host.querySelector(".gl-comp-matrix")!;
    expect(matrix.textContent).toContain("100.0");
    expect(matrix.textContent).toContain("5.0");
    expect(host.querySelector(".gl-comp-row-labels")?.textContent).toContain("FL1-A");
    expect(host.querySelector(".gl-comp-column-labels")?.textContent).toContain("FL2-A");
    const labels = [...matrix.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")]
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining("Lymphocyte marker (FL1-A)"),
      expect.stringContaining("Lymphocyte marker (FL2-A)"),
    ]));
  });

  it("offers an exact fractional spill-matrix export with base-R import code", () => {
    renderTab(flowSample({ coefficient: 0.029123456789012344 }));
    const exportButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Export CSV…")!;
    expect(exportButton).toBeDefined();

    act(() => exportButton.click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="comp-export-title"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("exact fractions");
    expect(dialog.textContent).toContain("Source channels are rows");
    expect(dialog.textContent).toContain("embedded_FCS_spill_matrix.csv");
    expect(dialog.textContent).toContain("row.names = 1");
    expect(dialog.textContent).toContain("check.names = FALSE");
    expect(dialog.textContent).toContain('storage.mode(spill) <- "double"');

    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    act(() => cancel.click());
    expect(host.querySelector('[role="dialog"][aria-labelledby="comp-export-title"]')).toBeNull();
  });

  it("preserves tiny, negative, and non-unit-diagonal values instead of rounding or inventing them", () => {
    renderTab(flowSample({ matrix: [[1, 0.000001], [-0.02, 0.95]] }));
    const matrix = host.querySelector(".gl-comp-matrix")!;
    expect(matrix.textContent).toContain("0.0");
    expect(matrix.textContent).toContain("-2.0");
    expect(matrix.textContent).toContain("95.0");

    const tiny = [...matrix.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")]
      .find((button) => button.getAttribute("aria-label")?.includes("0.0001%"))!;
    act(() => tiny.click());
    expect(host.querySelector(".gl-comp-coefficient-readout")?.getAttribute("title")).toContain("0.000001");
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("0.0%");
    const review = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
      .find((button) => button.textContent?.includes("Review queue"))!;
    expect(review.textContent).toContain("(2)");
  });

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`fails closed for a non-finite embedded coefficient (${String(invalid)})`, () => {
      renderTab(flowSample({ matrix: [[1, invalid], [0.02, 1]] }));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("cannot be applied");
      expect(host.textContent).not.toContain("Apply embedded matrix");
      const review = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
        .find((button) => button.textContent?.includes("Review queue"))!;
      expect(review.textContent).toContain("(1)");
    });
  }

  it("selects one source-to-receiver cell and highlights both scientific axes", () => {
    renderTab(flowSample());
    const cell = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")]
      .find((button) => !button.disabled && button.getAttribute("aria-label")?.includes("5%"));
    expect(cell).toBeDefined();
    act(() => cell!.click());

    expect(cell!.getAttribute("aria-pressed")).toBe("true");
    expect(cell!.classList.contains("selected")).toBe(true);
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("5.0%");
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("FL1-A");
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("FL2-A");
    expect(host.querySelectorAll(".gl-comp-cell.is-selected-source")).toHaveLength(2);
    expect(host.querySelectorAll(".gl-comp-cell.is-selected-receiver")).toHaveLength(2);
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
  });

  it("offers a keyboard-accessible inspector resizer and persists its width", () => {
    const sample = flowSample();
    renderTab(sample, { stateKey: "workspace-a:resizer" });
    const commonPath = host.querySelector<HTMLElement>(".gl-comp-common-path")!;
    const separator = host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize compensation inspector"]')!;
    commonPath.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1400,
      bottom: 700,
      width: 1400,
      height: 700,
      toJSON: () => ({}),
    });

    expect(commonPath.style.gridTemplateColumns).toContain("624px");
    expect(separator.getAttribute("aria-valuenow")).toBe("624");
    act(() => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(commonPath.style.gridTemplateColumns).toContain("664px");
    expect(separator.getAttribute("aria-valuenow")).toBe("664");

    renderTab(sample, { stateKey: "workspace-a:resizer" });
    expect(host.querySelector<HTMLElement>(".gl-comp-common-path")?.style.gridTemplateColumns).toContain("664px");
  });

  it("previews a cell and its crosshairs on hover without pinning it", () => {
    renderTab(flowSample());
    const cell = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")]
      .find((button) => !button.disabled && button.getAttribute("aria-label")?.includes("5%"))!;

    act(() => cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(cell.getAttribute("aria-pressed")).toBe("false");
    expect(cell.classList.contains("selected")).toBe(true);
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("5.0%");
    expect(host.querySelectorAll(".gl-comp-cell.is-selected-source")).toHaveLength(2);
    expect(host.querySelectorAll(".gl-comp-cell.is-selected-receiver")).toHaveLength(2);
    expect(host.textContent).toContain("Hover preview · click to pin this pair.");

    act(() => cell.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
    expect(host.querySelector(".gl-comp-pair-detail")).toBeNull();
    expect(cell.classList.contains("selected")).toBe(false);
  });

  it("uses a single roving tab stop and arrow/Home/End navigation in a six-channel matrix", () => {
    renderTab(flowSample({ channelCount: 6 }));
    const cells = () => [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-cell:not(:disabled)")];
    expect(cells().filter((button) => button.tabIndex === 0)).toHaveLength(1);

    const first = host.querySelector<HTMLButtonElement>('button[data-source-index="0"][data-receiver-index="1"]')!;
    act(() => first.focus());
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(
      host.querySelector('button[data-source-index="0"][data-receiver-index="2"]'),
    );

    act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ));
    expect(document.activeElement).toBe(
      host.querySelector('button[data-source-index="1"][data-receiver-index="2"]'),
    );
    act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ));
    expect(document.activeElement).toBe(
      host.querySelector('button[data-source-index="3"][data-receiver-index="2"]'),
    );

    act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ));
    expect(document.activeElement).toBe(
      host.querySelector('button[data-source-index="3"][data-receiver-index="0"]'),
    );
    act(() => (document.activeElement as HTMLButtonElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    ));
    expect(document.activeElement).toBe(
      host.querySelector('button[data-source-index="3"][data-receiver-index="5"]'),
    );
    expect(cells().filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });

  it("renders a 60-channel matrix with one keyboard entry point", () => {
    renderTab(flowSample({ channelCount: 60 }));
    const matrix = host.querySelector<HTMLElement>(".gl-comp-matrix")!;
    const cells = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")];
    const enabled = cells.filter((button) => !button.disabled);
    expect(matrix.classList.contains("shows-values")).toBe(true);
    expect(matrix.getAttribute("role")).toBe("grid");
    expect(matrix.getAttribute("aria-rowcount")).toBe("60");
    expect(matrix.getAttribute("aria-colcount")).toBe("60");
    expect(cells).toHaveLength(3600);
    expect(enabled).toHaveLength(3540);
    expect(enabled.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(enabled.some((button) => button.textContent !== "")).toBe(true);
    expect(enabled.every((button) => button.title.includes("→"))).toBe(true);
    expect(host.querySelectorAll(".gl-comp-row-labels > div")).toHaveLength(60);
    expect(host.querySelectorAll(".gl-comp-column-labels > div")).toHaveLength(60);
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
  });

  for (const drawerName of ["Evidence", "Review queue"] as const) {
    it(`mounts only the ${drawerName} drawer after the user opens it`, () => {
      renderTab(flowSample());
      const button = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
        .find((candidate) => candidate.textContent?.includes(drawerName))!;

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);
      expect(host.querySelector('[role="region"]')?.getAttribute("aria-labelledby")).toBe(button.id);

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
    });
  }

  it("offers explicit warning details without auto-opening the review queue", () => {
    renderTab(flowSample({ coefficient: 1.2 }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("above 100%");
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);

    const details = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Review details")!;
    act(() => details.click());
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);
    expect(host.querySelector('[role="region"]')?.textContent).toContain("coefficient above 100%");
  });

  it("scopes selected cells and drawers to the workspace/sample identity", () => {
    const sampleA = flowSample();
    const sampleB = flowSample({ coefficient: 0.08 });
    renderTab(sampleA, { stateKey: "workspace-a:sample-a" });
    const cell = host.querySelector<HTMLButtonElement>('button[data-source-index="0"][data-receiver-index="1"]')!;
    act(() => cell.click());
    const evidence = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
      .find((button) => button.textContent?.includes("Evidence"))!;
    act(() => evidence.click());
    expect(host.querySelector(".gl-comp-pair-detail")).not.toBeNull();
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);

    renderTab(sampleB, { stateKey: "workspace-a:sample-b" });
    expect(host.querySelector(".gl-comp-pair-detail")).toBeNull();
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);

    renderTab(sampleA, { stateKey: "workspace-a:sample-a" });
    expect(host.querySelector(".gl-comp-pair-detail")).not.toBeNull();
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(1);

    renderTab(sampleA, { stateKey: "workspace-b:sample-a" });
    expect(host.querySelector(".gl-comp-pair-detail")).toBeNull();
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
  });
});

describe("CompensationTab CyTOF import path", () => {
  const matrixText = [
    "channel,Y89Di,In113Di",
    "Y89Di,1,0.1",
    "In113Di,0.05,1",
  ].join("\n");

  async function chooseMatrix(): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Choose CyTOF spillover matrix"]')!;
    const file = new File([matrixText], "wing-lab.csv", { type: "text/csv" });
    if (typeof file.text !== "function") {
      Object.defineProperty(file, "text", { value: async () => matrixText });
    }
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("imports a named matrix and defaults to exact matched $PnN channels", async () => {
    renderTab(cytofSample(), { stateKey: "workspace-a:cytof-import" });
    await chooseMatrix();

    expect(host.textContent).toContain("wing-lab.csv");
    expect(host.textContent).toContain("2 sources × 2 receivers");
    expect(host.textContent).toContain("Exact matches2");
    expect(host.querySelectorAll<HTMLInputElement>('.gl-comp-channel-grid input:checked')).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains the imported matrix and selections while the persistent tab is hidden", async () => {
    const sample = cytofSample();
    const stateKey = "workspace-a:cytof-persistent";
    renderTab(sample, { stateKey, visible: true });
    await chooseMatrix();
    const firstChannel = host.querySelector<HTMLInputElement>('.gl-comp-channel-grid input:checked')!;
    act(() => firstChannel.click());
    expect(host.querySelectorAll<HTMLInputElement>('.gl-comp-channel-grid input:checked')).toHaveLength(1);

    renderTab(sample, { stateKey, visible: false });
    expect(host.querySelector<HTMLElement>(".gl-compensation-tab")?.style.display).toBe("none");

    renderTab(sample, { stateKey, visible: true });
    expect(host.textContent).toContain("wing-lab.csv");
    expect(host.querySelectorAll<HTMLInputElement>('.gl-comp-channel-grid input:checked')).toHaveLength(1);
  });

  it("reflects app-level progress and prevents matrix changes during a running Apply", async () => {
    const sample = cytofSample();
    const stateKey = "workspace-a:cytof-progress";
    renderTab(sample, { stateKey });
    await chooseMatrix();

    renderTab(sample, {
      stateKey,
      applyStatus: {
        phase: "applying",
        profileName: "wing-lab",
        fraction: 0.5,
        processedEvents: 1,
        totalEvents: 2,
      },
    });

    expect(host.textContent).toContain("Applying… 50% (1 / 2 events)");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Choose another matrix…")?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")).toBeDefined();
  });

  it("requires gate-coordinate acknowledgement and emits an immutable NNLS profile", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      subtle: {
        digest: async (_algorithm: string, input: ArrayBuffer) => {
          const bytes = new Uint8Array(input);
          const output = new Uint8Array(32);
          for (let index = 0; index < bytes.length; index++) {
            output[index % output.length] = (output[index % output.length] * 31 + bytes[index] + index) & 0xff;
          }
          return output.buffer;
        },
      },
    });
    const applied = vi.fn(async (
      _profile: CompensationProfileRecord,
      _onProgress?: (progress: CompensationApplyProgress) => void,
    ) => {});
    const sample = cytofSample();
    renderTab(sample, {
      stateKey: "workspace-a:cytof-apply",
      hasExistingGates: true,
      onApplyProfile: applied,
    });
    await chooseMatrix();

    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply NNLS compensation")!;
    expect(apply.disabled).toBe(true);
    const acknowledgement = host.querySelector<HTMLInputElement>(".gl-comp-gate-acknowledgement input")!;
    act(() => acknowledgement.click());
    expect(apply.disabled).toBe(false);

    await act(async () => {
      apply.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(applied).toHaveBeenCalledTimes(1);
    const profile = applied.mock.calls[0][0];
    expect(profile.scientific.kind).toBe("cytof-spillover");
    expect(profile.scientific.method).toBe("nnls");
    expect(profile.scientific.includedChannels).toEqual(["In113Di", "Y89Di"]);
    expect(profile.origin).toMatchObject({
      type: "uploaded",
      fileName: "wing-lab.csv",
      format: "csv",
    });
    expect(host.textContent).toContain("Original measurements remain available");

    const profileMatrix = profile.scientific.matrix;
    const included = profile.scientific.includedChannels;
    sample.installCompensatedLayer({
      metadata: {
        profileId: profile.profileId,
        profileHash: profile.profileHash,
        matrixHash: profile.matrixHash,
        kind: profile.scientific.kind,
        method: profile.scientific.method,
        includedPnns: included,
        channelBindings: included.map((pnn) => {
          const channel = sample.channels.find((candidate) => candidate.pnn === pnn)!;
          return {
            pnn,
            fcsColumnIndex: channel.columnIndex,
            matrixSourceIndex: profileMatrix.sourceChannels.indexOf(pnn),
            matrixReceiverIndex: profileMatrix.receiverChannels.indexOf(pnn),
            included: true,
          };
        }),
        transformBinding: { kind: "cytof-asinh", cofactor: 5 },
      },
      columns: included.map((pnn, index) => {
        const channel = sample.channels.find((candidate) => candidate.pnn === pnn)!;
        return {
          pnn,
          fcsColumnIndex: channel.columnIndex,
          values: Float32Array.from({ length: sample.fcs.nEvents }, (_, event) =>
            Math.max(0, sample.originalColumnData(sample.index(channel.key)!)[event] - (index + 1) * 3),
          ),
        };
      }),
    }, { activeLayer: "compensated" });
    const solveSweep = vi.fn<CompensationSweepSolver>(async () => []);
    renderTab(sample, {
      stateKey: "workspace-a:cytof-applied",
      compensationOn: true,
      installedProfile: profile,
      installedBaselineProfile: profile,
      onApplyProfile: applied,
      onSolveCompensationSweep: solveSweep,
    });

    expect(host.textContent).toContain("CyTOF compensation installed");
    expect(host.textContent).toContain("wing-lab");
    expect(host.querySelector(".gl-comp-profile-pill")).not.toBeNull();
    expect(host.querySelector(".gl-comp-installed-summary")).toBeNull();
    expect(host.textContent).toContain("Uploaded spill matrix");
    expect(host.textContent).not.toContain("Original → Compensated impact");
    expect(host.querySelector(".gl-comp-profile-channels")).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Replace matrix…")).toBeDefined();

    const evidence = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
      .find((button) => button.textContent?.includes("Evidence"))!;
    act(() => evidence.click());
    expect(host.textContent).toContain("Original → Compensated impact");
    expect(host.querySelectorAll(".gl-comp-matrix .gl-comp-cell")).toHaveLength(4);

    const workspaceTabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const matrixTab = workspaceTabs.find((button) => button.textContent?.trim() === "Matrix")!;
    const globalTab = workspaceTabs.find((button) => button.textContent?.trim() === "Global inspector")!;
    expect(workspaceTabs.map((button) => button.textContent?.trim())).toEqual([
      "Matrix",
      "Global inspector",
      "Flagged",
    ]);
    act(() => globalTab.click());
    expect(host.querySelector(".gl-comp-global-inspector")).not.toBeNull();
    const comparisonExportButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Export…")!;
    expect(comparisonExportButton).toBeDefined();
    act(() => comparisonExportButton.click());
    const comparisonExportDialog = host.querySelector<HTMLElement>(
      '[role="dialog"][aria-labelledby="comp-comparison-export-title"]',
    )!;
    expect(comparisonExportDialog).not.toBeNull();
    expect(comparisonExportDialog.textContent).toContain("Original and Compensated");
    expect(comparisonExportDialog.textContent).toContain("2 filtered pairs · both assays");
    expect(comparisonExportDialog.textContent).toContain("1 A4 landscape page · six pairs per page");
    expect(comparisonExportDialog.querySelectorAll('input[name="compensation-comparison-export-format"]')).toHaveLength(3);
    const cancelComparisonExport = [...comparisonExportDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Cancel")!;
    act(() => cancelComparisonExport.click());
    expect(host.querySelector('[role="dialog"][aria-labelledby="comp-comparison-export-title"]')).toBeNull();
    expect(host.querySelector(".gl-comp-lock-pill")?.textContent).toBe("View locked");
    expect(host.querySelector(".gl-comp-lock-pill")?.getAttribute("title")).toContain("same events, axes, transform, density bins, colour scale, and tile geometry");
    const layerToggle = host.querySelector<HTMLButtonElement>(".gl-comp-layer-toggle")!;
    const layerScope = host.querySelector<HTMLElement>(".gl-comp-global-inspector")!;
    expect(layerToggle.textContent).toContain("Compensated");
    expect(layerToggle.getAttribute("aria-pressed")).toBe("true");
    expect(layerScope.dataset.inspectorLayer).toBe("compensated");
    expect(host.querySelectorAll(".gl-comp-layer-toggle")).toHaveLength(1);
    expect(host.querySelector(".gl-comp-inspector")).toBeNull();
    const tilesBefore = [...host.querySelectorAll<HTMLElement>(".gl-comp-global-tile")];
    expect(tilesBefore).toHaveLength(2);
    expect(tilesBefore[0].style.width).toBe("160px");
    const cachedSurfacesBefore = [...host.querySelectorAll<HTMLElement>(".gl-comp-cached-biplot")];
    expect(cachedSurfacesBefore).toHaveLength(2);
    expect(cachedSurfacesBefore.map((surface) => surface.dataset.cacheMode)).toEqual(["dual-canvas", "dual-canvas"]);
    expect(cachedSurfacesBefore.every((surface) => surface.dataset.layer === undefined)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Global compensation plot size"]')?.min).toBe("120");
    const densitySmoothing = host.querySelector<HTMLInputElement>('input[aria-label="Compensation biplot density smoothing"]')!;
    expect(densitySmoothing.value).toBe("6");
    expect(densitySmoothing.max).toBe("10");
    expect(densitySmoothing.closest("label")?.getAttribute("title")).toContain("both assay layers always use the same setting");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(densitySmoothing, "10");
      densitySmoothing.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".gl-comp-density-smoothing output")?.textContent).toBe("10");
    expect(host.querySelectorAll(".gl-comp-global-tile-head")).toHaveLength(2);
    expect(host.querySelector(".gl-comp-global-tile-head")?.textContent).toContain("CD45 → Barcode");
    expect(host.querySelector(".gl-comp-global-tile-head")?.textContent).toContain("10.0%");
    expect(host.querySelector(".gl-comp-global-tile-foot")).toBeNull();
    expect(host.textContent).not.toContain("fixed events · locked frame");
    const lockedFrames = tilesBefore.map((tile) => ({
      node: tile,
      pair: tile.dataset.pairKey,
      events: tile.dataset.eventSignature,
      x: tile.dataset.xRange,
      y: tile.dataset.yRange,
      width: tile.style.width,
    }));
    act(() => layerToggle.click());
    const tilesAfter = [...host.querySelectorAll<HTMLElement>(".gl-comp-global-tile")];
    expect(layerToggle.textContent).toContain("Uncompensated");
    expect(layerToggle.getAttribute("aria-pressed")).toBe("false");
    expect(layerScope.dataset.inspectorLayer).toBe("original");
    expect(tilesAfter.every((tile) => tile.dataset.layer === undefined)).toBe(true);
    const cachedSurfacesAfter = [...host.querySelectorAll<HTMLElement>(".gl-comp-cached-biplot")];
    expect(cachedSurfacesAfter).toEqual(cachedSurfacesBefore);
    expect(cachedSurfacesAfter.every((surface) => surface.dataset.layer === undefined)).toBe(true);
    expect(tilesAfter.map((tile) => ({
      node: tile,
      pair: tile.dataset.pairKey,
      events: tile.dataset.eventSignature,
      x: tile.dataset.xRange,
      y: tile.dataset.yRange,
      width: tile.style.width,
    }))).toEqual(lockedFrames);
    expect(sample.activeLayer).toBe("compensated");
    act(() => layerToggle.click());
    expect(layerToggle.textContent).toContain("Compensated");
    expect(layerToggle.getAttribute("aria-pressed")).toBe("true");
    expect(layerScope.dataset.inspectorLayer).toBe("compensated");

    const openDetails = tilesAfter[0].querySelector<HTMLButtonElement>(".gl-comp-global-plot-button")!;
    act(() => openDetails.click());
    expect(host.querySelector(".gl-comp-inspector")).not.toBeNull();
    expect(host.querySelector(".gl-comp-global-path")?.classList.contains("has-details")).toBe(true);
    expect(host.querySelector(".gl-comp-mini-matrix")).not.toBeNull();
    expect(host.querySelector(".gl-comp-inspector.is-global .gl-comp-biplot-note")).toBeNull();
    const compactDetail = host.querySelector<HTMLElement>(".gl-comp-pair-detail.is-global")!;
    const compactChildren = [...compactDetail.children];
    const followupIndex = compactChildren.findIndex((node) => node.classList.contains("gl-comp-followup-toggle"));
    const editorIndex = compactChildren.findIndex((node) => node.classList.contains("gl-comp-coefficient-editor"));
    const biplotsIndex = compactChildren.findIndex((node) => node.classList.contains("gl-comp-biplot-comparison"));
    const miniMatrixIndex = compactChildren.findIndex((node) => node.classList.contains("gl-comp-mini-matrix"));
    expect(followupIndex).toBeGreaterThanOrEqual(0);
    expect(editorIndex).toBeGreaterThanOrEqual(0);
    expect(biplotsIndex).toBeGreaterThan(followupIndex);
    expect(biplotsIndex).toBeGreaterThan(editorIndex);
    expect(miniMatrixIndex).toBe(biplotsIndex + 1);
    const miniMatrixSvg = host.querySelector<SVGSVGElement>(".gl-comp-mini-matrix svg")!;
    vi.spyOn(miniMatrixSvg, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 160,
      bottom: 66,
      width: 160,
      height: 66,
      toJSON: () => ({}),
    });
    act(() => miniMatrixSvg.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 77,
      clientY: 53,
    })));
    expect(tilesBefore[1].classList.contains("is-selected")).toBe(true);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", inline: "center" });
    expect(scrollIntoViewMock.mock.instances[scrollIntoViewMock.mock.instances.length - 1]).toBe(tilesBefore[1]);
    const closeDetails = host.querySelector<HTMLButtonElement>('button[aria-label="Close global compensation pair details"]')!;
    act(() => closeDetails.click());
    expect(host.querySelector(".gl-comp-inspector")).toBeNull();
    expect(host.querySelector(".gl-comp-global-tile")).toBe(tilesBefore[0]);

    const layout = host.querySelector<HTMLSelectElement>('select[aria-label="Global compensation plot layout"]')!;
    act(() => {
      layout.value = "source";
      layout.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector(".gl-comp-global-groups")?.getAttribute("data-layout")).toBe("source");
    expect(host.querySelector(".gl-comp-global-group")?.textContent).toContain("Source");
    act(() => {
      layout.value = "receiver";
      layout.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector(".gl-comp-global-groups")?.getAttribute("data-layout")).toBe("receiver");
    expect(host.querySelector(".gl-comp-global-group")?.textContent).toContain("Receiver");
    act(() => {
      layout.value = "compact";
      layout.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const galleryFollowup = host.querySelector<HTMLInputElement>('.gl-comp-global-tile input[type="checkbox"]')!;
    act(() => galleryFollowup.click());
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.includes("Flagged"))?.textContent).toContain("(1)");
    act(() => galleryFollowup.click());
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.includes("Flagged"))?.textContent).not.toContain("(1)");
    act(() => matrixTab.click());

    const pair = host.querySelector<HTMLButtonElement>('button[data-source-index="0"][data-receiver-index="1"]')!;
    act(() => pair.click());
    const followup = host.querySelector<HTMLInputElement>(".gl-comp-followup-toggle input")!;
    expect(followup.checked).toBe(false);
    act(() => followup.click());
    expect(followup.checked).toBe(true);

    const attention = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent?.includes("Flagged"))!;
    expect(attention.textContent).toContain("(1)");
    act(() => attention.click());
    expect(host.querySelectorAll(".gl-comp-inspector")).toHaveLength(1);
    expect(host.querySelector(".gl-comp-inspector")?.textContent).toContain("Y89Di");
    expect(host.querySelector(".gl-comp-attention-section")?.textContent).toContain("Flagged by you (1)");
    const flaggedColumns = host.querySelector(".gl-comp-flagged-columns")!;
    expect(flaggedColumns).not.toBeNull();
    expect(flaggedColumns.querySelectorAll(":scope > .gl-comp-attention-section")).toHaveLength(2);
    expect(flaggedColumns.children[0]?.textContent).toContain("Flagged by you");
    expect(flaggedColumns.children[1]?.textContent).toContain("Conservative suggestions");
    expect(host.querySelectorAll('select[aria-label="Compensation sweep workers"] option')).toHaveLength(4);
    const evidenceMode = host.querySelector<HTMLSelectElement>('select[aria-label="Compensation evidence mode"]')!;
    expect(evidenceMode.value).toBe("biological");
    expect(host.textContent).toContain("Broad positive association is excluded");
    act(() => {
      evidenceMode.value = "control";
      evidenceMode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Control-data suggestions");
    act(() => {
      evidenceMode.value = "biological";
      evidenceMode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('select[aria-label="Follow-up source channel"]')).not.toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent === "Recompute suggestions")).toBe(true);
    expect(host.textContent).toContain("Sweep workers are separate from full-Apply workers");
    expect(host.textContent).toContain("Four exact candidates will be interpolated");
    const nextFlagged = host.querySelector<HTMLButtonElement>('button[aria-label="Next flagged compensation pair"]')!;
    const previousFlagged = host.querySelector<HTMLButtonElement>('button[aria-label="Previous flagged compensation pair"]')!;
    expect(nextFlagged.disabled).toBe(false);
    expect(previousFlagged.disabled).toBe(false);
    expect(host.querySelector(".gl-comp-flag-navigation")?.textContent).toContain("1 / 1 flagged");

    const recompute = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Recompute suggestions")!;
    act(() => recompute.click());
    expect(host.textContent).toContain("1 flagged pair was retained");
    expect(host.querySelector<HTMLInputElement>(".gl-comp-followup-toggle input")?.checked).toBe(true);

    const previewBounds = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Preview endpoints")!;
    await act(async () => {
      previewBounds.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(solveSweep).toHaveBeenCalledTimes(1);
    expect(solveSweep.mock.calls[0][2]).toHaveLength(2);
    expect(solveSweep.mock.calls[0][4]).toBe(1);

    const workers = host.querySelector<HTMLSelectElement>('select[aria-label="Compensation sweep workers"]')!;
    act(() => {
      workers.value = "4";
      workers.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const runSweep = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Run four-value sweeps"))!;
    await act(async () => {
      runSweep.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(solveSweep).toHaveBeenCalledTimes(2);
    expect(solveSweep.mock.calls[1][2]).toHaveLength(4);
    expect(solveSweep.mock.calls[1][4]).toBe(4);

    const coefficientInput = host.querySelector<HTMLInputElement>(".gl-comp-coefficient-editor input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(coefficientInput, "12");
      coefficientInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const stage = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Stage value")!;
    act(() => stage.click());
    expect(host.querySelector(".gl-comp-coefficient-history")?.textContent).toContain("Installed");
    expect(host.querySelector(".gl-comp-coefficient-history")?.textContent).toContain("Staged12.0%");

    const applyRevision = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply revised matrix")!;
    await act(async () => {
      applyRevision.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(applied).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Retained 1 flagged pair for post-correction review");
    expect(host.querySelector<HTMLInputElement>(".gl-comp-followup-toggle input")?.checked).toBe(true);
    expect(attention.getAttribute("aria-selected")).toBe("true");
  });
});

describe("CompensationTab assay-layer fidelity", () => {
  it("keeps assay selection out of the tab and points to the one global selector", () => {
    renderTab(flowSample());
    expect(host.textContent).toContain("Assay selection in the top bar applies to every tab");
    expect(host.querySelector('select[aria-label="Active assay layer for all tabs"]')).toBeNull();
  });

  it("does not mislabel an imported flow profile as the embedded FCS matrix", () => {
    const sample = flowSample();
    sample.installCompensatedLayer(profileLayer(sample, "flow-spillover"));
    renderTab(sample);

    expect(host.textContent).toContain("Installed compensation profile");
    expect(host.textContent).toContain("Flow linear inverse");
    expect(host.textContent).toContain("Assay selection in the top bar applies to every tab");
    expect(host.textContent).not.toContain("Embedded compensation matrix");
    expect(host.textContent).toContain("flow-spillover-profile");
    expect(sample.activeLayer).toBe("original");
  });

  it("identifies an active CyTOF NNLS profile and offers reversible assay switching", () => {
    const sample = cytofSample();
    sample.installCompensatedLayer(profileLayer(sample, "cytof-spillover"), { activeLayer: "compensated" });
    renderTab(sample, { compensationOn: true });

    expect(host.textContent).toContain("Installed compensation profile");
    expect(host.textContent).toContain("CyTOF NNLS");
    expect(host.textContent).toContain("CyTOF compensation installed");
    expect(host.textContent).toContain("Assay selection in the top bar applies to every tab");
    expect(host.textContent).not.toContain("Apply embedded matrix");
    expect(host.textContent).not.toContain("Not configured");
  });

  it("fails closed when a CyTOF profile becomes stale and exposes exact reasons only on request", () => {
    const sample = cytofSample();
    sample.installCompensatedLayer(profileLayer(sample, "cytof-spillover"), { activeLayer: "compensated" });
    sample.setCytofCofactor(10);
    renderTab(sample, { stateKey: "workspace-a:cytof-stale" });

    expect(sample.activeLayer).toBe("original");
    expect(host.textContent).toContain("Unavailable");
    expect(host.textContent).not.toContain("Select the assay for every tab in the top bar");
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
    const review = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")]
      .find((button) => button.textContent?.includes("Review queue"))!;
    expect(review.textContent).toContain("(1)");
    act(() => review.click());
    expect(host.querySelector('[role="region"]')?.textContent).toContain("transform binding mismatch");
  });

  it("states plainly when flow or CyTOF data has no compensation source", () => {
    renderTab(flowSample({ spillover: false }), { stateKey: "workspace-a:flow-empty" });
    expect(host.textContent).toContain("no compatible embedded compensation matrix or imported profile");
    expect(host.querySelector(".gl-comp-matrix")).toBeNull();

    renderTab(cytofSample(), { stateKey: "workspace-a:cytof-empty" });
    expect(host.textContent).toContain("No CyTOF compensation profile is installed");
    expect(host.textContent).not.toContain("Apply embedded matrix");
  });
});
