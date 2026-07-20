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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
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

  it("opens matrix-first with useful advanced regions closed and unmounted", () => {
    renderTab(flowSample());

    expect(host.querySelector(".gl-comp-matrix")).not.toBeNull();
    expect(host.textContent).toContain("Embedded compensation matrix");
    expect(host.textContent).toContain("Select the assay for every tab in the top bar");

    const drawerButtons = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-drawer-toggle")];
    expect(drawerButtons.map((button) => button.textContent?.trim())).toEqual(["Evidence▸", "Review queue▸"]);
    expect(drawerButtons.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Propagation");
    expect(host.textContent).not.toContain("Biplot gallery");
  });

  it("renders scientifically consistent percentages and visible immutable channel identities", () => {
    const sample = flowSample();
    sample.setChannelLabel(sample.index("Marker 1")!, "Lymphocyte marker");
    sample.setChannelLabel(sample.index("Marker 2")!, "Lymphocyte marker");
    renderTab(sample);

    const matrix = host.querySelector(".gl-comp-matrix")!;
    expect(matrix.textContent).toContain("100%");
    expect(matrix.textContent).toContain("5%");
    expect([...matrix.querySelectorAll(".gl-comp-axis-pnn")].map((node) => node.textContent)).toEqual(
      expect.arrayContaining(["FL1-A", "FL2-A"]),
    );
    expect(matrix.textContent).toContain("Lymphocyte marker");
  });

  it("preserves tiny, negative, and non-unit-diagonal values instead of rounding or inventing them", () => {
    renderTab(flowSample({ matrix: [[1, 0.000001], [-0.02, 0.95]] }));
    const matrix = host.querySelector(".gl-comp-matrix")!;
    expect(matrix.textContent).toContain("0.0001%");
    expect(matrix.textContent).toContain("-2%");
    expect(matrix.textContent).toContain("95%");

    const tiny = [...matrix.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")]
      .find((button) => button.getAttribute("aria-label")?.includes("0.0001%"))!;
    act(() => tiny.click());
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("0.0001%");
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
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("5%");
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("FL1-A");
    expect(host.querySelector(".gl-comp-pair-detail")?.textContent).toContain("FL2-A");
    expect(host.querySelectorAll("th.is-selected-axis")).toHaveLength(2);
    expect(host.querySelectorAll('[role="region"]')).toHaveLength(0);
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
    const cells = [...host.querySelectorAll<HTMLButtonElement>(".gl-comp-cell")];
    const enabled = cells.filter((button) => !button.disabled);
    expect(cells).toHaveLength(3600);
    expect(enabled).toHaveLength(3540);
    expect(enabled.filter((button) => button.tabIndex === 0)).toHaveLength(1);
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
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      subtle: {
        digest: async () => new Uint8Array(32).buffer,
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
    renderTab(sample, {
      stateKey: "workspace-a:cytof-applied",
      compensationOn: true,
      installedProfile: profile,
    });

    expect(host.textContent).toContain("CyTOF compensation installed");
    expect(host.textContent).toContain("wing-lab");
    expect(host.textContent).toContain("Applied NNLS solve matrix");
    expect(host.textContent).toContain("Original → Compensated impact");
    expect(host.querySelectorAll(".gl-comp-matrix .gl-comp-cell")).toHaveLength(4);
  });
});

describe("CompensationTab assay-layer fidelity", () => {
  it("keeps assay selection out of the tab and points to the one global selector", () => {
    renderTab(flowSample());
    expect(host.textContent).toContain("Select the assay for every tab in the top bar");
    expect(host.querySelector('select[aria-label="Active assay layer for all tabs"]')).toBeNull();
  });

  it("does not mislabel an imported flow profile as the embedded FCS matrix", () => {
    const sample = flowSample();
    sample.installCompensatedLayer(profileLayer(sample, "flow-spillover"));
    renderTab(sample);

    expect(host.textContent).toContain("Installed compensation profile");
    expect(host.textContent).toContain("Flow linear inverse");
    expect(host.textContent).toContain("Select the assay for every tab in the top bar");
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
    expect(host.textContent).toContain("Select the assay for every tab in the top bar");
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
