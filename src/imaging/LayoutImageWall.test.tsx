// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutImageWallRecipe } from "../engine/imageWallBlock";
import { LayoutImageWall } from "./LayoutImageWall";
import type { ImageService, RenderResult, SourceInfo } from "./imageService";

const recipe: LayoutImageWallRecipe = {
  kind: "imagewall", sampleId: "D1", fileName: "D1.fcs", populationId: "p1", populationName: "CD4_positive",
  events: [3, 1, 2], imaged: 3, populationCount: 10, sortKey: "", sortLabel: "", sortDesc: false,
  display: [{ slot: 2, name: "LightLoss (Imaging)", enabled: true, colour: "#bdbdbd", threshold: 0, saturation: 0.8, gamma: 1, smoothing: 1 }],
  exposure: 1, tile: 40, columns: 2,
};

function fakeService(attached: boolean) {
  const renders: number[] = [];
  const info: SourceInfo = {
    eventCount: 6, imageCount: 6, hasImage: Uint8Array.from([1, 1, 1, 1, 1, 1]),
    scale: { 2: 1 }, channelNames: { 2: "LightLoss (Imaging)" }, pixelAspectRatio: 0.3, recordingId: "r",
  };
  const service = {
    hasSource: () => attached,
    knownInfo: () => (attached ? info : null),
    info: async () => info,
    cached: () => null,
    render(_fileKey: string, eventIndex: number) {
      renders.push(eventIndex);
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

describe("LayoutImageWall", () => {
  it("asks for every event of the block on the batch lane and draws on one canvas", async () => {
    const { service, renders } = fakeService(true);
    act(() => root.render(<LayoutImageWall recipe={recipe} service={service} width={300} height={200} />));
    await settle();
    expect(host.querySelector("canvas")).toBeTruthy();
    expect(renders.sort()).toEqual([1, 2, 3]);
    expect(host.querySelector(".gl-layout-imagewall")?.getAttribute("data-events")).toBe("3");
    expect(host.querySelector(".gl-layout-imagewall")?.getAttribute("data-ready")).toBe("3");
  });

  it("draws the caption and no tiles when the file's images are not attached", async () => {
    const { service, renders } = fakeService(false);
    act(() => root.render(<LayoutImageWall recipe={recipe} service={service} width={300} height={200} />));
    await settle();
    expect(renders).toEqual([]);
    expect(host.querySelector("canvas")).toBeTruthy();
    act(() => root.render(<LayoutImageWall recipe={recipe} service={null} width={300} height={200} />));
    await settle();
    expect(host.querySelector("canvas")).toBeTruthy();
  });
});
