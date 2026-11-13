// @vitest-environment jsdom
// Placed images on the Layout tab: "+ Image…" (toolbar and the page's menu) and a file dropped on
// the page place an SVG, PNG or JPEG at its natural size, scaled down to the page's margins when
// larger, as one undo step; a hostile SVG is drawn only through an <img>; a file over 8 MB is
// refused; the inspector shows the file, its sizes and "Replace…", which keeps the frame; the
// objects list calls it "Image" with its file name, and it takes a panel letter. Moveable and
// Selecto are stood in for, as in LayoutTab.test.tsx. Synthetic sample D1; nothing here is a real
// experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, mmToPx, normalizeLayoutWorkspace, pageSizePx, type LayoutItem, type LayoutWorkspace } from "../../engine/layout";
import type { LayoutPlacedImageRecipe } from "../../engine/placedImageBlock";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { defaultObjectName, objectKindWord, objectNaming } from "./layoutObjects";
import { addPanelLetters, panelLetterState } from "./panelLetters";
import { PLACED_IMAGE_BYTES_LIMIT } from "./placedImage";
import { HOSTILE_SVG, pngHeader } from "./placedImage.fixtures";

const recorded = vi.hoisted(() => ({ moveable: null as Record<string, any> | null, selecto: null as Record<string, any> | null }));
vi.mock("../../plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderMiniPlot: () => {}, renderStrategyGrid: () => {} }),
}));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.moveable = props;
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.selecto = props;
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

let root: Root;
let host: HTMLDivElement;
/** The file the next file picker returns; null, as when the picker is cancelled. */
let picked: File | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  picked = null;
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    if (this.type !== "file") return;
    expect(this.accept).toBe(".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg");
    Object.defineProperty(this, "files", { value: picked ? [picked] : [], configurable: true });
    this.dispatchEvent(new Event(picked ? "change" : "cancel"));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(initial?: LayoutWorkspace) {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  Object.assign(state, { populations: { [rootPop.population_id]: rootPop }, root_population_id: rootPop.population_id, active_population_id: rootPop.population_id });
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
    channels: [{ index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 }, { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 }],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs) }];
  const changes: LayoutWorkspace[] = [];
  function Harness() {
    const [workspace, setWorkspace] = useState(() => initial ?? createDefaultLayoutWorkspace());
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={samples}
          activeSampleId="D1"
          activePopulationId={rootPop.population_id}
          state={state as CoreState}
          globalScales={{}}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={null}
          dataRevision={0}
          densityColorPower={1.6}
          onOpenInGating={vi.fn()}
        />
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}

const items = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items;
const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
const select = (id: string) => act(() => {
  recorded.selecto!.onSelectEnd({ selected: [element(id)], isDragStart: false, isClick: true, inputEvent: {} });
});
/** Let a file's read finish and the page take it. */
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const svgFile = (text: string, name: string) => new File([text], name, { type: "image/svg+xml" });
const pngFile = (width: number, height: number, name: string) => new File([pngHeader(width, height) as BlobPart], name, { type: "image/png" });

function drop(file: File, clientX: number, clientY: number) {
  const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
  const over = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(over, "dataTransfer", { value: { types: ["Files"], files: [], dropEffect: "none" } });
  act(() => { canvas.dispatchEvent(over); });
  expect(over.defaultPrevented).toBe(true);
  const event = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
  act(() => { canvas.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
}

const SCHEMATIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>';

describe("Placing an image on the Layout page", () => {
  it("places a dropped SVG at its natural size at the drop point, as one undo step", async () => {
    const changes = mount();
    drop(svgFile(SCHEMATIC, "schematic_D1.svg"), 300, 250);
    await settle();
    expect(changes).toHaveLength(1);
    const [image] = items(changes);
    expect(image).toMatchObject({ x: 300, y: 250, width: 40, height: 20, recipe: { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SCHEMATIC } });
    expect(recorded.moveable!.target).toBe(element(image.id));
    // One undo step takes it away.
    act(() => { host.querySelector<HTMLElement>(".gl-layout-canvas-scroll")!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true })); });
    expect(items(changes)).toHaveLength(0);
  });

  it("places a PNG from + Image… at its natural size, or scaled down to the margins with its proportions when larger", async () => {
    const changes = mount();
    picked = pngFile(200, 100, "control.png");
    act(() => button("+ Image…").click());
    await settle();
    expect(items(changes)[0]).toMatchObject({ width: 200, height: 100, recipe: { mediaType: "image/png", naturalWidth: 200, naturalHeight: 100 } });
    expect((items(changes)[0].recipe as LayoutPlacedImageRecipe).content.startsWith("data:image/png;base64,")).toBe(true);

    picked = pngFile(4000, 1000, "treated.png");
    act(() => button("+ Image…").click());
    await settle();
    const page = changes.at(-1)!.sheets[0].page;
    const room = pageSizePx(page).width - 2 * mmToPx(page.marginMm);
    const wide = items(changes)[1];
    expect(wide.width).toBeLessThanOrEqual(room);
    expect(wide.width).toBeGreaterThan(room - 1);
    expect(wide.width / wide.height).toBeCloseTo(4, 1);
    // A cancelled picker places nothing.
    picked = null;
    act(() => button("+ Image…").click());
    await settle();
    expect(items(changes)).toHaveLength(2);
  });

  it("offers + Image… in the blank page's menu, placing the image where the menu was opened", async () => {
    const changes = mount();
    const canvas = host.querySelector<HTMLElement>(".gl-layout-canvas")!;
    act(() => { canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
    picked = pngFile(30, 30, "control.png");
    act(() => [...host.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((b) => b.textContent === "+ Image…")!.click());
    await settle();
    expect(items(changes)[0]).toMatchObject({ x: 120, y: 90, width: 30, height: 30 });
  });

  it("draws a hostile SVG only through an <img> of a data URL that holds none of its scripts or outside references", async () => {
    const changes = mount();
    drop(svgFile(HOSTILE_SVG, "hostile.svg"), 100, 100);
    await settle();
    const item = element(items(changes)[0].id);
    expect(item.querySelectorAll("img")).toHaveLength(1);
    expect(item.querySelector("svg, script, foreignObject, iframe, rect, text")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    const src = item.querySelector("img")!.getAttribute("src")!;
    expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(src)).not.toMatch(/<script|foreignObject|onload|onclick|javascript:|example\.org/i);
    // What is saved is the file as it was; only what is drawn and exported is made safe.
    expect((items(changes)[0].recipe as LayoutPlacedImageRecipe).content).toBe(HOSTILE_SVG);
  });

  it("refuses a file over 8 MB, saying the limit, and a file that is not an image", async () => {
    const changes = mount();
    drop(new File([new Uint8Array(PLACED_IMAGE_BYTES_LIMIT + 1)], "B1.png", { type: "image/png" }), 100, 100);
    await settle();
    expect(changes).toHaveLength(0);
    expect(host.textContent).toContain("B1.png is 8.0 MB; a placed image can be at most 8.0 MB.");
    drop(new File(["%PDF-1.7"], "figure.pdf", { type: "application/pdf" }), 100, 100);
    await settle();
    expect(changes).toHaveLength(0);
    expect(host.textContent).toContain("figure.pdf is not an SVG, PNG or JPEG file.");
  });
});

describe("A placed image as an item", () => {
  const placed = (id: string, recipe: LayoutPlacedImageRecipe, frame = { x: 100, y: 120, width: 80, height: 40 }): LayoutItem => ({ id, ...frame, z: 0, recipe });
  const schematic: LayoutPlacedImageRecipe = { kind: "image", fileName: "schematic_D1.svg", mediaType: "image/svg+xml", naturalWidth: 40, naturalHeight: 20, content: SCHEMATIC };
  const sheetWith = (list: LayoutItem[]) => {
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items = list;
    return normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
  };

  it("shows its file, natural size and stored size in the inspector, and Replace… keeps its frame, as one undo step", async () => {
    const changes = mount(sheetWith([placed("img-1", schematic)]));
    select("img-1");
    const fields = host.querySelector<HTMLElement>(".gl-layout-image-fields")!;
    expect(fields.querySelector(".gl-layout-image-file")!.textContent).toBe("schematic_D1.svg (SVG)");
    expect(fields.querySelector(".gl-layout-image-natural")!.textContent).toBe("40 × 20 px");
    expect(fields.querySelector(".gl-layout-image-stored")!.textContent).toBe(`${SCHEMATIC.length} B`);
    picked = pngFile(640, 480, "treated.png");
    act(() => button("Replace…").click());
    await settle();
    expect(changes).toHaveLength(1);
    expect(items(changes)[0]).toMatchObject({ id: "img-1", x: 100, y: 120, width: 80, height: 40, recipe: { fileName: "treated.png", mediaType: "image/png", naturalWidth: 640, naturalHeight: 480 } });
    expect(host.querySelector(".gl-layout-image-natural")!.textContent).toBe("640 × 480 px");
  });

  it("duplicates, follows the Keep proportions setting with Shift reversing it, and has no title field", () => {
    const changes = mount(sheetWith([placed("img-1", schematic)]));
    select("img-1");
    expect(recorded.moveable!.keepRatio).toBe(false);
    expect(host.querySelector(".gl-layout-title-field")).toBeNull();
    act(() => button("Duplicate").click());
    expect(items(changes)).toHaveLength(2);
    expect(items(changes)[1].recipe).toEqual(schematic);
  });

  it("is named Image with its file name in the objects list, and takes a panel letter", () => {
    mount(sheetWith([placed("img-1", schematic)]));
    const row = host.querySelector<HTMLElement>('.gl-layout-objects [data-object-id="img-1"]')!;
    expect(row.querySelector(".gl-layout-object-kind")!.textContent).toBe("Image");
    expect(row.querySelector(".gl-layout-object-name")!.textContent).toBe("schematic_D1.svg");
    const item = placed("img-1", schematic);
    expect(objectKindWord(item)).toBe("Image");
    expect(defaultObjectName(item, objectNaming([]))).toBe("schematic_D1.svg");
    const sheet = sheetWith([item]).sheets[0];
    expect(panelLetterState(sheet, ["img-1"]).canAdd).toBe(true);
    addPanelLetters(sheet, ["img-1"]);
    expect(sheet.items.some((other) => other.recipe.kind === "text" && other.recipe.letterFor === "img-1")).toBe(true);
  });
});
