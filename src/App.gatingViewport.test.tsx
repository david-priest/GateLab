// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import type { NewGate } from "./plots/GatingPlot";

interface CapturedPlotProps {
  payload: {
    x_range: [number, number];
    y_range: [number, number];
    gates: Array<{ gate_id: string; gate_type: string }>;
    gates_only?: boolean;
    gate_edge_mode?: string;
    x_b64: string;
    y_b64: string;
  };
  onNewGate: (gate: NewGate) => void;
  onGateEdit: (edit: { gate_id: string; vertices: [number, number][] }) => void;
  onQuadrantMove: (edit: { gate_id: string; center: [number, number] }) => void;
  onGateSelect: (gateId: string) => void;
  onGateLabelMove: (edit: { gate_id: string; label_offset: [number, number] }) => void;
}

const plotHarness = vi.hoisted(() => ({
  props: null as CapturedPlotProps | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 4,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [
    Float32Array.from([100, 200, 300, 400]),
    Float32Array.from([150, 250, 350, 450]),
  ],
  spillover: null,
};

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  plotHarness.props = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  plotHarness.props = null;
  uuid = 0;
});

function testFile(): File {
  const file = new File([Uint8Array.from([70, 67, 83])], "viewport.fcs", {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => Uint8Array.from([70, 67, 83]).buffer,
  });
  return file;
}

function button(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function ranges(): { x: [number, number]; y: [number, number] } {
  if (!plotHarness.props) throw new Error("Gating plot was not rendered");
  return {
    x: [...plotHarness.props.payload.x_range] as [number, number],
    y: [...plotHarness.props.payload.y_range] as [number, number],
  };
}

async function createGate(gate: NewGate, confirmLabel: string): Promise<string> {
  act(() => plotHarness.props!.onNewGate(gate));
  act(() => button(confirmLabel).click());
  const created = plotHarness.props!.payload.gates.find(
    (candidate) => candidate.gate_type === gate.gate_type,
  );
  if (!created) throw new Error(`Missing created ${gate.gate_type} gate`);
  return created.gate_id;
}

describe("App gating viewport invariant", () => {
  it("never rescales after polygon, rectangle, quadrant, or label edits and their repaint", async () => {
    act(() => root.render(<App />));
    const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(fcsInput, "files", { configurable: true, value: [testFile()] });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const initial = ranges();
    const polygonId = await createGate({
      gate_type: "polygon",
      vertices: [[10, 10], [11, 10], [11, 11]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }, "Create");
    expect(ranges()).toEqual(initial);
    act(() => plotHarness.props!.onGateEdit({
      gate_id: polygonId,
      vertices: [[20, 20], [21, 20], [21, 21]],
    }));
    act(() => plotHarness.props!.onGateSelect(polygonId));
    expect(ranges()).toEqual(initial);
    act(() => plotHarness.props!.onGateLabelMove({
      gate_id: polygonId,
      label_offset: [100, 100],
    }));
    expect(ranges()).toEqual(initial);

    const rectangleId = await createGate({
      gate_type: "rectangle",
      vertices: [[30, 30], [31, 31]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }, "Create");
    act(() => plotHarness.props!.onGateEdit({
      gate_id: rectangleId,
      vertices: [[40, 40], [41, 41]],
    }));
    act(() => plotHarness.props!.onGateSelect(rectangleId));
    expect(ranges()).toEqual(initial);

    const quadrantId = await createGate({
      gate_type: "quadrant",
      vertices: [[50, 50]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }, "Create 4 populations");
    act(() => plotHarness.props!.onQuadrantMove({
      gate_id: quadrantId,
      center: [60, 60],
    }));
    act(() => plotHarness.props!.onGateSelect(quadrantId));
    expect(ranges()).toEqual(initial);
  });

  it("updates gates without repainting the cells", async () => {
    // cytof has a fast path that redraws gate overlays and leaves the canvas alone. GateLab never
    // set it, so every gate edit, label move and selection sent a full payload, re-decoded the
    // event arrays and repainted every cell — which is the flicker seen while dragging a gate.
    act(() => root.render(<App />));
    const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(fcsInput, "files", { configurable: true, value: [testFile()] });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const events = plotHarness.props!.payload.x_b64;

    const gateId = await createGate({
      gate_type: "rectangle",
      vertices: [[10, 10], [20, 20]],
      x_channel: "FSC-A",
      y_channel: "SSC-A",
    }, "Create");

    // Creating, moving a label, editing vertices and selecting all leave the events untouched.
    for (const change of [
      () => plotHarness.props!.onGateLabelMove({ gate_id: gateId, label_offset: [5, 5] }),
      () => plotHarness.props!.onGateEdit({ gate_id: gateId, vertices: [[12, 12], [22, 22]] }),
      () => plotHarness.props!.onGateSelect(gateId),
    ]) {
      act(change);
      expect(plotHarness.props!.payload.x_b64).toBe(events);
      expect(plotHarness.props!.payload.gates_only).toBe(true);
    }

    // The other direction needs no test: the flag is decided by comparing the encoded event
    // bytes, so a payload whose events differ cannot be marked gates-only. That is a property of
    // the comparison rather than of the inputs, which is why it is done on the bytes and not on a
    // guess at which state changes matter.
  });

  it("sends the gate edge mode when it changes", async () => {
    // A field added to the payload but not to the memo's dependencies is a control that appears
    // to work and does nothing until something else forces a re-render. Assert the payload, not
    // the state, so the bug cannot hide between them.
    act(() => root.render(<App />));
    const fcsInput = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(fcsInput, "files", { configurable: true, value: [testFile()] });
    await act(async () => {
      fcsInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const select = [...host.querySelectorAll<HTMLSelectElement>("select")]
      .find((el) => [...el.options].some((o) => o.value === "straight-bow"));
    expect(select, "the gate edge control should be rendered").toBeTruthy();
    expect(plotHarness.props!.payload.gate_edge_mode).toBe("straight-bow");

    // React tracks the value on the node, so a plain assignment is swallowed; go through the
    // prototype setter the way a real change does.
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    for (const next of ["bowed", "straight", "straight-bow"]) {
      act(() => {
        setValue.call(select!, next);
        select!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(plotHarness.props!.payload.gate_edge_mode).toBe(next);
    }
  });
});
