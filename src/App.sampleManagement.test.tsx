// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

const syntheticFcs: FcsFile = {
  version: "FCS3.1",
  nEvents: 3,
  instrument: "flow",
  keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [
    Float32Array.from([100, 200, 300]),
    Float32Array.from([150, 250, 350]),
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
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  uuid = 0;
});

function testFile(name: string): File {
  const file = new File([Uint8Array.from([70, 67, 83])], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => Uint8Array.from([70, 67, 83]).buffer,
  });
  return file;
}

describe("App sample management", () => {
  it("imports a batch atomically and removes selected files through the manager", async () => {
    act(() => root.render(<App />));
    const fileInputs = host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]');
    expect(fileInputs).toHaveLength(2);
    const directFileInput = [...fileInputs].find((input) => !input.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(directFileInput, "files", {
      configurable: true,
      value: [testFile("donor-a.fcs"), testFile("donor-b.fcs")],
    });

    await act(async () => {
      directFileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const sampleRows = host.querySelectorAll<HTMLElement>('[role="option"]');
    expect(sampleRows).toHaveLength(2);
    expect(sampleRows[0].textContent).toContain("donor-a.fcs");
    expect(sampleRows[1].textContent).toContain("donor-b.fcs");
    expect(sampleRows[1].getAttribute("aria-selected")).toBe("true");
    expect(host.textContent).toContain("2 / 2 included");

    const manage = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Manage…")!;
    act(() => manage.click());
    expect(host.textContent).toContain("Manage samples");

    const selectFirst = host.querySelector<HTMLInputElement>('input[aria-label="Select donor-a.fcs for management"]')!;
    act(() => selectFirst.click());
    const removeSelected = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Remove selected…")!;
    act(() => removeSelected.click());
    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Remove")!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(1);
    expect(host.textContent).not.toContain("donor-a.fcs");
    expect(host.textContent).toContain("donor-b.fcs");
    expect(host.textContent).toContain("1 / 1 included");
  });
});
