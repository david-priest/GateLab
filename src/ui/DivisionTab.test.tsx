// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DivisionTab } from "./DivisionTab";
import type { Derived } from "../store";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { clearPersistedTabState } from "./tabState";

const plots = vi.hoisted(() => ({
  render: vi.fn(),
  bus: { on: vi.fn(() => () => {}) },
}));
vi.mock("../plots/loadPlots", () => ({ loadDivisionPlots: () => ({ api: { render: plots.render }, bus: plots.bus }) }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  plots.render.mockClear();
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await vi.runAllTimersAsync(); });
}

/** One dye channel of 1,200 events, two populations of brightness. */
function sampleOf() {
  const n = 1200;
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: n,
    instrument: "flow",
    keywords: {},
    spillover: null,
    channels: [{ index: 0, name: "CFSE-A", marker: "CFSE", bits: 32, range: 262144 }],
    columns: [Float32Array.from({ length: n }, (_, i) => (i % 2 ? 200 + (i % 50) : 2000 + (i % 50)))],
  };
  return new Sample(fcs);
}
const payload = () => plots.render.mock.calls.at(-1)![0] as { x: number[] };
const input = (text: string) =>
  [...host.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent?.includes(text))!.querySelector("input")!;
const setInput = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("Division tab events", () => {
  it("draws a subsample of the dye values, every one of them with All events on, and the subsample again when it is off", async () => {
    const props = {
      sample: sampleOf(),
      sampleName: "D1.fcs",
      derived: { activeMask: null } as Derived,
      savedProfile: null,
      profileStale: false,
      onApply: vi.fn(),
      dataRevision: 0,
    };
    act(() => root.render(<DivisionTab {...props} />));
    await flush();
    expect(payload().x).toHaveLength(1200);
    setInput(input("Subsample"), "1000");
    await flush();
    expect(payload().x).toHaveLength(1000);

    const all = input("All events");
    expect(all.checked).toBe(false);
    act(() => all.click());
    await flush();
    expect(all.checked).toBe(true);
    expect(input("Subsample").disabled).toBe(true);
    expect(payload().x).toHaveLength(1200);

    act(() => all.click());
    await flush();
    expect(input("Subsample").disabled).toBe(false);
    expect(input("Subsample").value).toBe("1000");
    expect(payload().x).toHaveLength(1000);
  });
});
