// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEADS, beadControl, CELLS, PANEL, syntheticControl, TRUE_SPILLOVER, type SyntheticFile } from "../compensationControls/syntheticControls.fixture";
import type { BaselineCompensationProfileRecord } from "../engine/compensationProfileRecord";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { CompensationControlsDialog, type ControlsDialogFile } from "./CompensationControlsDialog";

/** A synthetic control as a loaded file: scatter, then the panel's area parameters. */
function loaded(file: SyntheticFile, spillover: FcsFile["spillover"] = null): ControlsDialogFile {
  const names = ["FSC-A", "SSC-A", ...PANEL];
  const fcs = {
    version: "FCS3.1", nEvents: file.eventCount, instrument: "flow", keywords: {},
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [file.scatter!.forward as Float32Array, file.scatter!.side as Float32Array, ...file.columns],
    spillover,
  } as unknown as FcsFile;
  return { id: file.id, name: file.fileName, sample: new Sample(fcs) };
}

function experiment(): ControlsDialogFile[] {
  return [
    ...PANEL.map((_, fluor) => loaded(beadControl(fluor, { id: `c${fluor}`, fileName: `Tube_00${fluor + 1}.fcs` }))),
    loaded(syntheticControl({ id: "u", fileName: "Tube_007.fcs", particle: BEADS, seed: 50 })),
    loaded(
      syntheticControl({
        id: "sample", fileName: "D1 treated.fcs", particle: CELLS, seed: 70,
        stains: [
          { fluor: 3, fraction: 1, brightness: 12_000, spread: 0.4 },
          { fluor: 0, fraction: 0.33, brightness: 9_000, spread: 0.5 },
          { fluor: 1, fraction: 0.2, brightness: 8_000, spread: 0.5 },
        ],
      }),
      { channels: [...PANEL], matrix: TRUE_SPILLOVER.map((row) => [...row]) },
    ),
  ];
}

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

function open(files: ControlsDialogFile[], onAdd = vi.fn((profile: BaselineCompensationProfileRecord) => `added ${profile.name}`), onClose = vi.fn()) {
  act(() => {
    root.render(<CompensationControlsDialog workspaceFiles={files} takenNames={new Set(["Calculated matrix"])} onAdd={onAdd} onClose={onClose} />);
  });
  return { onAdd, onClose };
}

const row = (id: string) => host.querySelector<HTMLTableRowElement>(`tr[data-file-id="${id}"]`)!;
const selectIn = (id: string, label: string) =>
  Array.from(row(id).querySelectorAll("select")).find((select) => select.getAttribute("aria-label")?.startsWith(label))!;
const change = (select: HTMLSelectElement, value: string) => act(() => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === text)!;
const matrixCell = (i: number, j: number) =>
  host.querySelectorAll(".gl-comp-controls-matrix tbody tr")[i].querySelectorAll("td")[j].getAttribute("title")!;

describe("CompensationControlsDialog", () => {
  it("shows what each file was read as, the matrix and the comparison with the embedded one", () => {
    open(experiment());
    expect(selectIn("c0", "What").value).toBe("single-stain");
    expect(selectIn("c0", "Channel").value).toBe("FITC-A");
    expect(row("c0").textContent).toContain("Signal");
    expect(selectIn("u", "What").value).toBe("unstained");
    expect(selectIn("sample", "What").value).toBe("mixed");
    expect(selectIn("c2", "Particles").selectedOptions[0].textContent).toBe("Automatic: beads");
    expect(selectIn("c2", "Negative").selectedOptions[0].textContent).toBe("Automatic: its own");
    expect(host.querySelector(".gl-comp-controls-bar .gl-hint")!.textContent).toBe("8 files · 6 controls used · 6 channels in the matrix");
    expect(host.querySelectorAll(".gl-comp-controls-matrix tbody tr")).toHaveLength(6);
    // The coefficient with about one standard error of it.
    expect(matrixCell(4, 5)).toMatch(/^BV421-A → BV510-A: 2[45]\.\d+% ± 0\.\d+%$/);
    // The first control's histogram is drawn with the two boundaries of each set.
    expect(host.querySelector(".gl-comp-controls-histogram strong")!.textContent).toBe("Tube_001.fcs: events in FITC-A");
    expect(Array.from(host.querySelectorAll(".gl-comp-controls-handle")).map((handle) => handle.getAttribute("aria-label")).sort()).toEqual([
      "Lower boundary of the negative events", "Lower boundary of the positive events",
      "Upper boundary of the negative events", "Upper boundary of the positive events",
    ]);
    const findings = host.querySelector(".gl-comp-controls-report")!.textContent!;
    expect(findings).toContain("Against the matrix embedded in D1 treated.fcs");
    expect(findings).toContain("0 of 30 coefficients differ by more than 0.5% and more than five standard errors.");
  });

  it("adds the matrix with what it was calculated from, under a name not in the list", async () => {
    const { onAdd, onClose } = open(experiment());
    const name = host.querySelector<HTMLInputElement>(".gl-comp-controls-name input")!;
    expect(name.value).toBe("Calculated matrix 2");
    await act(async () => {
      button("Add to matrices").click();
      await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    });
    const profile = onAdd.mock.calls[0][0];
    expect(profile.name).toBe("Calculated matrix 2");
    // A stored matrix keeps its channels in sorted order.
    expect(profile.scientific.matrix.receiverChannels).toEqual([...PANEL].sort());
    expect(profile.origin).toMatchObject({ type: "calculated", estimator: "median-difference", estimatorVersion: "1" });
    const origin = profile.origin as Extract<BaselineCompensationProfileRecord["origin"], { type: "calculated" }>;
    expect(origin.controls).toHaveLength(6);
    expect(origin.controls.find((control) => control.channel === "FITC-A"))
      .toMatchObject({ row: "control", events: { fileName: "Tube_001.fcs" }, negative: { fileName: "Tube_001.fcs" } });
    expect(onClose).toHaveBeenCalledWith("added Calculated matrix 2");
  });

  it("recalculates when a file is set aside or given another channel", () => {
    open(experiment());
    change(selectIn("c4", "What"), "ignored");
    expect(host.querySelector(".gl-comp-controls-bar .gl-hint")!.textContent).toBe("8 files · 5 controls used · 5 channels in the matrix");
    expect(host.querySelector(".gl-comp-controls-report")!.textContent).toContain("No usable control for BV421-A: left out of the matrix.");
    act(() => button("Reset to what was read").click());
    expect(host.querySelectorAll(".gl-comp-controls-matrix tbody tr")).toHaveLength(6);
    // The PE-Cy7 control given to APC: it is used for APC, and the APC control is a duplicate.
    change(selectIn("c2", "Channel"), "APC-A");
    expect(row("c2").textContent).toContain("Chosen");
    expect(row("c2").textContent).toContain("Brightest in PE-Cy7-A.");
    expect(row("c3").textContent).toContain("Not used: Tube_003.fcs is the control for APC-A.");
  });

  it("moves a boundary from the keyboard and puts it back", () => {
    open(experiment());
    const before = matrixCell(0, 1);
    const counts = () => host.querySelector(".gl-comp-controls-counts .is-positive")!.textContent!;
    const positive = counts();
    const handle = host.querySelector<SVGGElement>(".gl-comp-controls-handle.is-positive.is-lower")!;
    expect(handle.getAttribute("role")).toBe("slider");
    // Thirty steps to the right take the boundary into the positive peak.
    for (let step = 0; step < 6; step++) {
      act(() => {
        host.querySelector(".gl-comp-controls-handle.is-positive.is-lower")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
      });
    }
    expect(counts()).not.toBe(positive);
    expect(row("c0").textContent).toContain("Boundaries set by hand.");
    expect(matrixCell(0, 1)).not.toBe(before);
    act(() => button("Reset boundaries").click());
    expect(counts()).toBe(positive);
    expect(matrixCell(0, 1)).toBe(before);
    expect(row("c0").textContent).not.toContain("Boundaries set by hand.");
  });

  it("tightens a set from its outer boundary, and opens it again at the edge of the plot", () => {
    open(experiment());
    const text = (set: string) => host.querySelector(`.gl-comp-controls-counts .is-${set}`)!.textContent!;
    const press = (set: string, side: string, key: string, times: number) => {
      for (let step = 0; step < times; step++) {
        act(() => {
          host.querySelector(`.gl-comp-controls-handle.is-${set}.is-${side}`)!
            .dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: true, bubbles: true }));
        });
      }
    };
    const count = (set: string) => Number(text(set).match(/: ([\d,]+) events/)![1].replace(/,/g, ""));
    const open_ = { positive: text("positive"), negative: text("negative") };
    expect(open_.positive).toMatch(/^Positive: [\d,]+ events at or above /);
    expect(open_.negative).toMatch(/^Negative: [\d,]+ events below /);
    const all = { positive: count("positive"), negative: count("negative") };
    // The upper boundary of the positive events, brought down from the edge, takes fewer of them.
    press("positive", "upper", "ArrowLeft", 3);
    expect(text("positive")).toMatch(/^Positive: [\d,]+ events from [\d,.]+ to [\d,.]+$/);
    expect(count("positive")).toBeLessThan(all.positive);
    expect(text("negative")).toBe(open_.negative);
    expect(row("c0").textContent).toContain("Boundaries set by hand.");
    // The lower boundary of the negative events likewise.
    press("negative", "lower", "ArrowRight", 4);
    expect(text("negative")).toMatch(/^Negative: [\d,]+ events from /);
    expect(count("negative")).toBeLessThan(all.negative);
    // A boundary does not pass its neighbour: the upper one of the positive events stops at the lower one.
    press("positive", "upper", "ArrowLeft", 40);
    expect(count("positive")).toBe(0);
    // Back at the edge of the plot, a set is open on that side again.
    press("positive", "upper", "ArrowRight", 60);
    press("negative", "lower", "ArrowLeft", 60);
    expect(text("positive")).toBe(open_.positive);
    expect(text("negative")).toBe(open_.negative);
    expect(row("c0").textContent).not.toContain("Boundaries set by hand.");
  });

  it("offers to mark a bead control by hand where it has no negative peak", () => {
    const files = experiment();
    files[1] = loaded(syntheticControl({
      id: "c1", fileName: "PE beads.fcs", particle: BEADS, seed: 81,
      stains: [{ fluor: 1, fraction: 1, brightness: 40_000, spread: 0.08 }],
    }));
    // Unstained cells cannot stand in for the beads' negative.
    files[6] = loaded(syntheticControl({ id: "u", fileName: "unstained cells.fcs", particle: CELLS, seed: 51 }));
    open(files);
    expect(row("c1").textContent).toContain("No negative peak was found.");
    expect(host.querySelectorAll(".gl-comp-controls-matrix tbody tr")).toHaveLength(5);
    act(() => row("c1").click());
    expect(host.querySelectorAll(".gl-comp-controls-handle")).toHaveLength(0);
    act(() => button("Mark by hand").click());
    expect(host.querySelectorAll(".gl-comp-controls-handle")).toHaveLength(4);
    expect(host.querySelectorAll(".gl-comp-controls-matrix tbody tr")).toHaveLength(6);
    // Choosing Cells instead takes the unstained tube.
    act(() => button("Reset boundaries").click());
    change(selectIn("c1", "Particles"), "cells");
    expect(selectIn("c1", "Negative").selectedOptions[0].textContent).toBe("Automatic: unstained");
    expect(host.querySelector(".gl-comp-controls-counts .is-negative")!.textContent).toContain("all 5,000 events of unstained cells.fcs");
  });

  it("says so when there is nothing to calculate", () => {
    open([]);
    expect(host.textContent).toContain("No flow files yet.");
    expect(button("Add to matrices").disabled).toBe(true);
  });
});
