// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCellPanel, type LayoutCellPanelRecipe } from "../engine/cellPanelBlock";
import type { RenderSpecMessage } from "./cvwProtocol";
import { LayoutCellPanel } from "./LayoutCellPanel";
import type { ImageService, RenderResult, SourceInfo } from "./imageService";
import type { ChannelDisplay } from "./imageWallSettings";

const d = (slot: number, name: string, enabled: boolean, colour: string): ChannelDisplay => ({ slot, name, enabled, colour, threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 });
const display = [d(2, "LightLoss (Imaging)", true, "#bdbdbd"), d(5, "CD4", true, "#00ff00"), d(6, "CD8", true, "#ff0000")];
const recipe: LayoutCellPanelRecipe = defaultCellPanel({
  sampleId: "D1", fileName: "D1.fcs", cells: [{ event: 3, label: "Event 3" }, { event: 1, label: "Event 1" }], display, exposure: 1, mask: { slot: 4 },
});

function fakeService(attached: boolean) {
  const renders: { eventIndex: number; spec: RenderSpecMessage; lane: string }[] = [];
  const info: SourceInfo = {
    eventCount: 6, imageCount: 6, hasImage: Uint8Array.from([1, 1, 1, 1, 1, 1]),
    scale: { 2: 1, 5: 1, 6: 1 }, channelNames: { 2: "LightLoss (Imaging)", 5: "CD4", 6: "CD8" }, pixelAspectRatio: 0.3, recordingId: "r",
  };
  const service = {
    hasSource: () => attached,
    knownInfo: () => (attached ? info : null),
    info: async () => info,
    cached: () => null,
    render(_fileKey: string, eventIndex: number, spec: RenderSpecMessage, lane: string) {
      renders.push({ eventIndex, spec, lane });
      return { promise: Promise.resolve({ kind: "no-image" } as RenderResult), cancel: () => undefined };
    },
  } as unknown as ImageService;
  return { service, renders };
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

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

describe("LayoutCellPanel", () => {
  it("asks once per cell for every column's channel, LightLoss in grey, and the merge as the composite", async () => {
    const { service, renders } = fakeService(true);
    act(() => root.render(<LayoutCellPanel recipe={recipe} service={service} width={400} height={300} />));
    await settle();
    expect(renders.map((r) => r.eventIndex).sort()).toEqual([1, 3]);
    const spec = renders[0].spec;
    expect(renders[0].lane).toBe("batch");
    expect(spec.channels).toEqual([2, 5, 6]);
    expect(spec.grey).toEqual([2]);
    expect(spec.composite).toBe(true);
    expect(spec.display.filter((x) => x.enabled).map((x) => x.slot)).toEqual([5, 6]);
    expect(spec.outline).toBeUndefined();
    expect(host.querySelector(".gl-layout-cellpanel")?.getAttribute("data-cells")).toBe("2");
    expect(host.querySelector(".gl-layout-cellpanel")?.getAttribute("data-ready")).toBe("2");
    expect(host.querySelector("canvas")).toBeTruthy();
  });

  it("asks again with the outline and the new gain when the recipe changes, and draws only the caption when the images are not attached", async () => {
    const { service, renders } = fakeService(true);
    act(() => root.render(<LayoutCellPanel recipe={recipe} service={service} width={400} height={300} />));
    await settle();
    const first = renders.length;
    act(() => root.render(<LayoutCellPanel recipe={{ ...recipe, outline: true, gain: { 5: 2 } }} service={service} width={400} height={300} />));
    await settle();
    expect(renders.length).toBe(first + 2);
    const spec = renders[renders.length - 1].spec;
    expect(spec.outline).toEqual({ slot: 4 });
    expect(spec.display.find((x) => x.slot === 5)!.saturation).toBeCloseTo(0.4, 9);
    const detached = fakeService(false);
    act(() => root.render(<LayoutCellPanel recipe={recipe} service={detached.service} width={400} height={300} />));
    await settle();
    expect(detached.renders).toEqual([]);
    expect(host.querySelector("canvas")).toBeTruthy();
  });
});
