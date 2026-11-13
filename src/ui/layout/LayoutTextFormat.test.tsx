// @vitest-environment jsdom
// Text formatting on the Layout tab: bold, italic, superscript and subscript within a block in
// the on-page editor (Cmd-B, Cmd-I and the bar by the editor), and italic, colour, alignment and
// the marker-sign helper for the selected blocks in the inspector. Moveable and Selecto are stood
// in for by props recorders, as in LayoutTab.test.tsx. Synthetic sample D1; nothing here is a
// real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutItem, type LayoutWorkspace } from "../../engine/layout";
import { DEFAULT_HIERARCHY_ID } from "../../engine/hierarchies";
import { newRootPopulation } from "../../engine/models";
import { Sample } from "../../engine/sample";
import type { FcsFile } from "../../engine/fcs";
import type { FigureSample } from "../../engine/figure";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";
import { fitLayoutText } from "../layoutTextFit";
import { selectOffsets } from "./richTextDom";

const draws = vi.hoisted(() => ({ selecto: null as Record<string, any> | null }));
vi.mock("../../plots/loadPlots", () => ({ loadMiniPlots: () => ({ renderMiniPlot: () => {}, renderStrategyGrid: () => {} }) }));
vi.mock("../../plots/layoutExport", () => ({ composeSheetPages: () => [], writeComposedPages: async () => {} }));
vi.mock("react-moveable", () => ({
  default: forwardRef((_props: Record<string, any>, ref) => {
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
    return null;
  }),
}));
vi.mock("react-selecto", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    draws.selecto = props;
    useImperativeHandle(ref, () => ({ setSelectedTargets: () => {}, clickTarget: () => {} }));
    return null;
  }),
}));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const state = initialCoreState();
  const rootPop = newRootPopulation();
  Object.assign(state, { populations: { [rootPop.population_id]: rootPop }, root_population_id: rootPop.population_id, active_population_id: rootPop.population_id });
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {}, spillover: null,
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([10, 20, 30]), Float32Array.from([30, 20, 10])],
  };
  const samples: FigureSample[] = [{ id: "D1", name: "D1.fcs", hierarchyId: DEFAULT_HIERARCHY_ID, sample: new Sample(fcs), metadata: {} }];
  return { state: state as CoreState, rootId: rootPop.population_id, samples };
}

const text = (id: string, words: string, extra: Record<string, unknown> = {}): LayoutItem =>
  ({ id, x: 20, y: 20 + 40 * Number(id.slice(1)), width: 200, height: 30, z: Number(id.slice(1)), recipe: { kind: "text", text: words, fontSize: 12, ...extra } }) as LayoutItem;

function mount(items: LayoutItem[]) {
  const fx = fixture();
  const changes: LayoutWorkspace[] = [];
  const initial = createDefaultLayoutWorkspace();
  initial.sheets[0].items = items;
  function Harness() {
    const [workspace, setWorkspace] = useState(() => normalizeLayoutWorkspace(JSON.parse(JSON.stringify(initial))));
    return (
      <I18nProvider>
        <LayoutTab
          workspace={workspace}
          onChange={(next) => { changes.push(next); setWorkspace(next); }}
          samples={fx.samples}
          activeSampleId="D1"
          activePopulationId={fx.rootId}
          state={fx.state}
          globalScales={{}}
          defaultX="FSC-A"
          defaultY="SSC-A"
          illustrationConfig={null}
          dataRevision={0}
          densityColorPower={1}
          onOpenInGating={vi.fn()}
        />
      </I18nProvider>
    );
  }
  act(() => root.render(<Harness />));
  return changes;
}

const element = (id: string) => host.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
const recipes = (changes: LayoutWorkspace[]) => changes.at(-1)!.sheets[0].items.map((item) => item.recipe);
const select = (...ids: string[]) => act(() => {
  draws.selecto!.onSelectEnd({ selected: ids.map(element), isDragStart: false, isClick: ids.length <= 1, inputEvent: {} });
});
const openEditor = (id: string) => act(() => {
  element(id).querySelector<HTMLElement>(".gl-layout-text-surface")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
});
const keydown = (target: Element, init: KeyboardEventInit) => act(() => {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
});
const barButton = (id: string, label: string) => element(id).querySelector<HTMLButtonElement>(`.gl-layout-text-bar button[aria-label="${label}"]`)!;
const richEditor = (id: string) => element(id).querySelector<HTMLElement>('[contenteditable][aria-label="Layout text"]')!;

describe("Layout text formatting in the editor", () => {
  it("sets bold and italic on a selection with Cmd-B and Cmd-I, and the bar shows the selection's state", () => {
    const changes = mount([text("t1", "CD4 T cells")]);
    select("t1");
    openEditor("t1");
    const area = element("t1").querySelector<HTMLTextAreaElement>("textarea")!;
    expect(barButton("t1", "Bold").getAttribute("aria-pressed")).toBe("false");
    // A plain block is a text field until a mark is applied; Cmd-B turns it into the formatting editor.
    area.setSelectionRange(0, 3);
    keydown(area, { key: "b", metaKey: true });
    const editor = richEditor("t1");
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    expect(editor.innerHTML).toBe("<b>CD4</b> T cells");
    expect(barButton("t1", "Bold").getAttribute("aria-pressed")).toBe("true");
    act(() => selectOffsets(editor, 6, 11));
    keydown(editor, { key: "i", ctrlKey: true });
    expect(editor.innerHTML).toBe("<b>CD4</b> T <i>cells</i>");
    expect(barButton("t1", "Italic").getAttribute("aria-pressed")).toBe("true");
    expect(barButton("t1", "Bold").getAttribute("aria-pressed")).toBe("false");
    act(() => editor.blur());
    expect(recipes(changes)[0]).toMatchObject({ text: "<b>CD4</b> T <i>cells</i>", rich: true });
    const surface = element("t1").querySelector(".gl-layout-text-surface.is-static")!;
    expect(surface.innerHTML).toBe("<b>CD4</b> T <i>cells</i>");
    // Cmd-B again on the bold word takes it off.
    openEditor("t1");
    act(() => selectOffsets(richEditor("t1"), 0, 3));
    keydown(richEditor("t1"), { key: "b", metaKey: true });
    act(() => richEditor("t1").blur());
    expect(recipes(changes)[0]).toMatchObject({ text: "CD4 T <i>cells</i>", rich: true });
  });

  it("applies a mark with nothing selected to what is typed next, from the bar", () => {
    const changes = mount([text("t1", "CD4")]);
    select("t1");
    openEditor("t1");
    const area = element("t1").querySelector<HTMLTextAreaElement>("textarea")!;
    area.setSelectionRange(3, 3);
    act(() => {
      barButton("t1", "Superscript").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      barButton("t1", "Superscript").click();
    });
    const editor = richEditor("t1");
    expect(barButton("t1", "Superscript").getAttribute("aria-pressed")).toBe("true");
    keydown(editor, { key: "+" });
    expect(editor.innerHTML).toBe("CD4<sup>+</sup>");
    // Off again for what comes next; text from an input method, not a key, takes it too.
    act(() => barButton("t1", "Superscript").click());
    expect(barButton("t1", "Superscript").getAttribute("aria-pressed")).toBe("false");
    act(() => { editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: " T" })); });
    expect(editor.innerHTML).toBe("CD4<sup>+</sup> T");
    act(() => editor.blur());
    expect(recipes(changes)[0]).toMatchObject({ text: "CD4<sup>+</sup> T", rich: true });
    expect(element("t1").querySelector(".gl-layout-text-surface sup")?.textContent).toBe("+");
  });

  it("saves a block edited without marks as plain text, and leaves an unformatted block plain", () => {
    const changes = mount([text("t1", "a <b>tag</b> typed as text")]);
    // An older block's tags are its words: drawn literally, no element made of them.
    expect(element("t1").querySelector(".gl-layout-text-surface")!.textContent).toBe("a <b>tag</b> typed as text");
    expect(element("t1").querySelector(".gl-layout-text-surface b")).toBeNull();
    select("t1");
    openEditor("t1");
    const area = element("t1").querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "a <b>tag</b> & more");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => area.blur());
    expect(recipes(changes)[0]).toEqual({ kind: "text", text: "a <b>tag</b> & more", fontSize: 12 });
  });
});

describe("Layout text formatting in the inspector", () => {
  it("sets italic, colour and alignment on every selected text block", () => {
    const changes = mount([text("t1", "D1"), text("t2", "D2", { bold: true })]);
    select("t1", "t2");
    const italic = [...host.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((label) => label.textContent?.trim() === "Italic")!.querySelector("input")!;
    act(() => italic.click());
    const colour = host.querySelector<HTMLInputElement>('input[type="color"][aria-label="Text colour"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(colour, "#aa3300");
      colour.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const align = host.querySelector<HTMLSelectElement>('select[aria-label="Text alignment"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(align, "center");
      align.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(recipes(changes)).toEqual([
      { kind: "text", text: "D1", fontSize: 12, italic: true, color: "#aa3300", align: "center" },
      { kind: "text", text: "D2", fontSize: 12, bold: true, italic: true, color: "#aa3300", align: "center" },
    ]);
    for (const id of ["t1", "t2"]) {
      const style = element(id).querySelector<HTMLElement>(".gl-layout-text-surface")!.style;
      expect([style.fontStyle, style.color, style.textAlign]).toEqual(["italic", "rgb(170, 51, 0)", "center"]);
    }
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(align, "left");
      align.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Default")!.click());
    expect(recipes(changes).map((recipe) => ("align" in recipe || "color" in recipe))).toEqual([false, false]);
  });

  it("superscripts marker signs, and shows a rich block's text without tags, read-only", () => {
    const changes = mount([text("t1", "CD4+ CD45RA- PD1hi")]);
    select("t1");
    const field = () => [...host.querySelectorAll<HTMLLabelElement>("label.gl-field-inline")].find((label) => label.firstChild?.textContent === "Text")!.querySelector("input")!;
    expect(field().readOnly).toBe(false);
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Superscript marker signs")!.click());
    expect(recipes(changes)[0]).toMatchObject({ text: "CD4<sup>+</sup> CD45RA<sup>-</sup> PD1<sup>hi</sup>", rich: true });
    expect([...element("t1").querySelectorAll(".gl-layout-text-surface sup")].map((sup) => sup.textContent)).toEqual(["+", "-", "hi"]);
    expect(field().value).toBe("CD4+ CD45RA- PD1hi");
    expect(field().readOnly).toBe(true);
    expect(host.textContent).toContain("double-click it on the page to edit it");
  });
});

describe("fitLayoutText with formatting", () => {
  it("measures a rich block with its formatting elements and italic", () => {
    const measured: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      measured.push(`${this.innerHTML}|${this.style.fontStyle}`);
      return { width: 60, height: 20, x: 0, y: 0, top: 0, left: 0, right: 60, bottom: 20, toJSON: () => ({}) } as DOMRect;
    });
    expect(fitLayoutText("CD4<sup>+</sup> &lt; 5", 12, 320, false, { rich: true, italic: true })).toEqual({ width: 63, height: 22 });
    expect(measured[0]).toBe("CD4<sup>+</sup> &lt; 5|italic");
    measured.length = 0;
    fitLayoutText("CD4<sup>+</sup>", 12, 320);
    expect(measured[0]).toBe("CD4&lt;sup&gt;+&lt;/sup&gt;|");
  });
});
