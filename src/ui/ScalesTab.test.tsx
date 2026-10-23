// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sample } from "../engine/sample";
import { ScalesTab } from "./ScalesTab";

let root: Root;
let host: HTMLDivElement;

const sample = {
  channels: [{ key: "FSC-A" }, { key: "CD3" }],
  channelLabel: (index: number) => ["FSC-A", "CD3"][index],
  displayRange: () => [0, 4.5] as [number, number],
} as unknown as Sample;

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
  localStorage.clear();
});

const render = (locked: boolean) => act(() => root.render(
  <ScalesTab sample={sample} globalScales={{ CD3: [0.5, 4] }} onSetGlobalScale={vi.fn()} lockedBetweenFiles={locked} />,
));
const title = () => host.querySelector(".gl-section-header")!.textContent;

describe("ScalesTab", () => {
  it("says the ranges are the file's own and the transform the channel's, workspace-wide", () => {
    render(false);
    expect(title()).toBe("Axis ranges · this file");
    expect(host.textContent).toContain("Each file keeps its own axis ranges");
    expect(host.textContent).toContain("The display transform (linear, logicle, arcsinh) belongs to the channel and is the same in every file.");
    expect(host.textContent).not.toContain("Per-file Channel Scales");
  });

  it("says the ranges are shared while the scale lock is on, and the transform still the channel's", () => {
    render(true);
    expect(title()).toBe("Axis ranges · shared by all files");
    expect(host.textContent).toContain("these ranges are shared by every file");
    expect(host.textContent).toContain("belongs to the channel and is the same in every file whether or not the lock is on");
  });

  it("hides the explanation with × and brings it back with ? by the title", () => {
    render(false);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Hide this explanation"]')!.click());
    expect(host.textContent).not.toContain("Each file keeps its own axis ranges");
    // The "?" is an icon now, so the title reads as before; the button is there.
    expect(title()).toBe("Axis ranges · this file");
    expect(host.querySelector('.gl-section-header button[aria-label="Show the explanation"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.gl-section-header button[aria-label="Show the explanation"]')!.click());
    expect(host.textContent).toContain("Each file keeps its own axis ranges");
  });

  it("gives Min and Max inputs room for a full value", () => {
    render(false);
    const inputs = [...host.querySelectorAll<HTMLInputElement>(".gl-scale-input")];
    expect(inputs.map((input) => input.value)).toEqual(["", "", "0.5", "4"]);
    const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    const width = Number(/\.gl-scale-input \{\s*width: (\d+)px/.exec(css)?.[1]);
    expect(width).toBeGreaterThanOrEqual(100);
  });
});
