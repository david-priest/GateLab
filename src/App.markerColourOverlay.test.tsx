// @vitest-environment jsdom
//
// "Colour by → Channel" through the whole app: the dropdown, the per-event indices the renderer
// is handed, the palette that indexes them, and the colour bar that claims to describe both.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";
import { decodeUint8Base64 } from "./engine/encode";
import { MARKER_COLOUR_LEVELS, MARKER_MISSING_LEVEL } from "./engine/markerColour";
import { UNGATED_COLOR } from "./engine/palettes";

interface CapturedPlotProps {
  payload: {
    n_events: number;
    overlay_mode?: boolean;
    color_b64?: string;
    color_palette?: string[];
    color_labels?: string[];
  };
}

const plotHarness = vi.hoisted(() => ({ props: null as CapturedPlotProps | null }));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: CapturedPlotProps) => {
    plotHarness.props = props;
    return <div data-testid="gating-plot" />;
  },
}));

// Seed 1: a CD4 channel whose values climb across the file, so a correct ramp is monotonic.
// Seed 2: the same panel, ten times brighter on CD4 — the pooled-scale case.
// Seed 3: no CD4 at all, which must not be painted as "negative for CD4".
function syntheticFcs(seed: number): FcsFile {
  const count = 200;
  // Seed 2 sits a long way above seed 1 with no overlap, so a pooled ramp must separate them.
  const offset = seed === 2 ? 50_000 : 0;
  const third = seed === 3
    ? { index: 2, name: "V450-A", marker: "CD19", bits: 32, range: 262144 }
    : { index: 2, name: "B530-A", marker: "CD4", bits: 32, range: 262144 };
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
      third,
    ],
    columns: [
      Float32Array.from({ length: count }, (_, i) => 1000 + i),
      Float32Array.from({ length: count }, (_, i) => 1000 + i),
      Float32Array.from({ length: count }, (_, i) => offset + 100 + i * 10),
    ],
    spillover: null,
  };
}

vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (b: ArrayBuffer) => syntheticFcs(new Uint8Array(b)[0]) };
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

function testFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

async function load(...files: File[]): Promise<void> {
  act(() => root.render(<App />));
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
    .find((i) => !i.hasAttribute("webkitdirectory"))!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  await settle();
}

function colourByTrigger(): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]');
  if (!trigger) throw new Error("no Colour by control");
  return trigger;
}

/** Open the picker and return its panel. */
function openColourBy(): HTMLElement {
  if (!host.querySelector(".gl-searchable-select-panel")) act(() => colourByTrigger().click());
  return host.querySelector<HTMLElement>(".gl-searchable-select-panel")!;
}

function colourByValues(): string[] {
  const panel = openColourBy();
  const values = [...panel.querySelectorAll("option")].map((o) => o.value);
  act(() => colourByTrigger().click());
  return values;
}

function paletteSelect(): HTMLSelectElement {
  const label = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes("Palette"));
  if (!label) throw new Error("no Palette control");
  return label.querySelector("select")!;
}

async function chooseColourBy(value: string): Promise<void> {
  openColourBy();
  const list = host.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, value);
    list.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  await settle();
}

function levels(): number[] {
  const payload = plotHarness.props?.payload;
  if (!payload?.color_b64) throw new Error("the plot was handed no per-event colours");
  return [...decodeUint8Base64(payload.color_b64)];
}

describe("Colour by a third marker", () => {
  it("offers every channel of the active file and colours the events by the one chosen", async () => {
    await load(testFile("a.fcs", 1));

    const options = colourByValues();
    expect(options).toContain("channel:CD4");
    expect(options).toContain("channel:FSC-A");

    await chooseColourBy("channel:CD4");
    const payload = plotHarness.props!.payload;
    expect(payload.overlay_mode).toBe(true);
    // The renderer indexes the palette with these levels directly, so its length has to cover
    // every level the app can emit — including the missing slot below the ramp.
    expect(payload.color_palette).toHaveLength(MARKER_COLOUR_LEVELS + 1);
    expect(payload.color_palette![MARKER_MISSING_LEVEL]).toBe(UNGATED_COLOR);
    // 255 swatches would not be a legend. The in-canvas key stays empty and the bar replaces it.
    expect(payload.color_labels ?? []).toHaveLength(0);

    // CD4 climbs monotonically through this file, so its colour levels must too, and must span
    // the ramp rather than sitting in a corner of it.
    const got = levels();
    expect(got).toHaveLength(payload.n_events);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThanOrEqual(got[i - 1]);
    expect(Math.min(...got)).toBe(1);
    expect(Math.max(...got)).toBe(MARKER_COLOUR_LEVELS);
    expect(got).not.toContain(MARKER_MISSING_LEVEL);
  });

  it("can be searched down to one channel, the way the plot's axis picker is", async () => {
    await load(testFile("a.fcs", 1));
    openColourBy();
    const search = host.querySelector<HTMLInputElement>(".gl-searchable-select-panel input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "cd4");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...host.querySelectorAll(".gl-searchable-select-panel option")]
      .map((o) => o.textContent)).toEqual(["CD4"]);

    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();
    expect(colourByTrigger().textContent).toBe("CD4");
    expect(host.querySelector(".gl-marker-colour-bar")).not.toBeNull();
  });

  it("shows the colour bar with the channel and the ends of the scale it coloured against", async () => {
    await load(testFile("a.fcs", 1));
    await chooseColourBy("channel:CD4");

    const bar = host.querySelector(".gl-marker-colour-bar");
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("CD4");
    // The ramp drawn is the palette the events were coloured with, minus the missing slot.
    const ramp = bar!.querySelector<HTMLElement>(".gl-marker-colour-bar-ramp")!;
    const palette = plotHarness.props!.payload.color_palette!;
    // jsdom re-serialises the gradient's colours as rgb(), so compare in that spelling.
    const asRgb = (hex: string) => `rgb(${[1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    expect(ramp.style.backgroundImage).toContain(asRgb(palette[1]));
    expect(ramp.style.backgroundImage).toContain(asRgb(palette[palette.length - 1]));
    // The missing colour is not a step at the bottom of a ramp that does not have one.
    expect(ramp.style.backgroundImage).not.toContain(asRgb(UNGATED_COLOR));
  });

  it("offers ordered ramps for a marker and the categorical palettes otherwise", async () => {
    await load(testFile("a.fcs", 1));
    await chooseColourBy("population");
    const categorical = [...paletteSelect().querySelectorAll("option")].map((o) => o.value);
    expect(categorical).toContain("paired");

    await chooseColourBy("channel:CD4");
    const sequential = [...paletteSelect().querySelectorAll("option")].map((o) => o.value);
    expect(sequential).toContain("viridis");
    // A qualitative palette cycles hues across 255 levels, so the bar would claim an order the
    // colours do not have.
    expect(sequential).not.toContain("paired");
    expect(sequential).not.toContain("default");
  });

  it("repaints when the palette changes, without re-deciding which level an event is on", async () => {
    await load(testFile("a.fcs", 1));
    await chooseColourBy("channel:CD4");
    const before = levels();
    const beforePalette = plotHarness.props!.payload.color_palette!;

    const select = paletteSelect();
    await act(async () => {
      select.value = "inferno";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();

    expect(levels()).toEqual(before);
    expect(plotHarness.props!.payload.color_palette).not.toEqual(beforePalette);
  });

  it("scales one ramp across pooled files, so a colour means one marker level in each", async () => {
    // b.fcs carries CD4 far above a.fcs, with no overlap. Scaled per file the two would fill the
    // ramp identically and look the same; pooled, one file must sit low on the ramp and the other
    // high, with the empty space between them showing as empty.
    await load(testFile("a.fcs", 1), testFile("b.fcs", 2));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected files"))!.click());
    await settle();
    await chooseColourBy("channel:CD4");
    const got = levels();
    expect(got).toHaveLength(plotHarness.props!.payload.n_events);

    // Asserted on the distribution rather than on the cloud's ordering, which is the point
    // cloud builder's business and not this feature's. Under ONE scale the two files land in two
    // bands with the empty space between them showing as a gap in the levels used; scaled per
    // file they would each fill the ramp densely and the largest gap would be a single level.
    const used = [...new Set(got)].sort((a, b) => a - b);
    const largestGap = used.reduce(
      (worst, level, i) => (i === 0 ? worst : Math.max(worst, level - used[i - 1])), 0);
    expect(largestGap).toBeGreaterThan(20);
    expect(Math.min(...got)).toBe(1);
    expect(Math.max(...got)).toBe(MARKER_COLOUR_LEVELS);
  });

  it("never pools a file that lacks the channel, so no file is drawn as uniformly negative", async () => {
    // c.fcs carries CD19 where a.fcs carries CD4. Painting it at the bottom of the ramp would
    // read as "uniformly CD4-negative", which is a claim about the data rather than about the
    // panel. Panel identity is the ordered channels with their markers, so such a file is
    // already refused from the pooled display — and the refusal is the message the user gets.
    // a.fcs is loaded last so it is the primary: the "Colour by" list is the active file's
    // channels, and only it carries CD4.
    await load(testFile("c.fcs", 3), testFile("a.fcs", 1));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected files"))!.click());
    await settle();
    await chooseColourBy("channel:CD4");
    expect(host.textContent).toContain("different panel");
    // Only the file that carries CD4 is drawn, and every event of it is on the ramp.
    expect(levels()).not.toContain(MARKER_MISSING_LEVEL);
  });

  it("re-colours and re-labels the bar together when the contrast slider moves", async () => {
    await load(testFile("a.fcs", 1));
    await chooseColourBy("channel:CD4");
    const before = levels();
    const barBefore = [...host.querySelectorAll<HTMLElement>(".gl-marker-colour-bar-ticks span")]
      .map((s) => ({ label: s.textContent, left: s.style.left }));
    expect(barBefore.length).toBeGreaterThan(0);

    const slider = host.querySelector<HTMLInputElement>('input[aria-label="Marker colour contrast"]')!;
    await act(async () => {
      // React tracks the DOM value it last wrote; assigning through the prototype setter is what
      // makes it see a change at all.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(slider, "2.5");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();

    const after = levels();
    expect(after).not.toEqual(before);
    // The ends are still the ends: the contrast moves where the ramp's colours fall, not the
    // range the bar claims to cover.
    expect(Math.min(...after)).toBe(1);
    expect(Math.max(...after)).toBe(MARKER_COLOUR_LEVELS);

    // And the key moved with the plot. A bar whose labels stayed put would describe the old
    // colouring, which is worse than no bar.
    const barAfter = [...host.querySelectorAll<HTMLElement>(".gl-marker-colour-bar-ticks span")]
      .map((s) => ({ label: s.textContent, left: s.style.left }));
    expect(barAfter.map((t) => t.label)).toEqual(barBefore.map((t) => t.label));
    expect(barAfter.map((t) => t.left)).not.toEqual(barBefore.map((t) => t.left));
  });

  it("labels the bar in the channel's own units, the way its axis would", async () => {
    await load(testFile("a.fcs", 1));
    await chooseColourBy("channel:CD4");
    const labels = [...host.querySelectorAll(".gl-marker-colour-bar-ticks span")]
      .map((s) => s.textContent ?? "");
    expect(labels.length).toBeGreaterThan(0);
    // A logicle channel's axis is labelled in raw decades (100, 1K, 10K), never in the display
    // units the transform works in — the bar reading 0.38 beside an axis reading 10K describes
    // one marker in a language the other does not speak.
    expect(labels.some((l) => /K$|^\d+$|^-?\d+K$/.test(l))).toBe(true);
  });

  it("drops the overlay when the chosen channel leaves the workspace", async () => {
    await load(testFile("c.fcs", 3), testFile("a.fcs", 1));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected files"))!.click());
    await settle();
    await chooseColourBy("channel:CD4");
    expect(host.querySelector(".gl-marker-colour-bar")).not.toBeNull();

    // Removing the file that carries CD4 removes the channel with it. A stale pick would leave
    // "Colour by: CD4" selected over a plot drawn in one flat colour.
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Manage…")!.click());
    act(() => host.querySelector<HTMLInputElement>(
      'input[aria-label="Select a.fcs for management"]')!.click());
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Remove selected…")!.click());
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Remove")!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    await settle();

    expect(host.querySelector(".gl-marker-colour-bar")).toBeNull();
    expect(colourByTrigger().textContent).toBe("None");
  });
});
