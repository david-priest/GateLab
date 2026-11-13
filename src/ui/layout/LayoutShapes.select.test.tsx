// @vitest-environment jsdom
// A level line has no height: it is taken by its invisible outline, which a press near the line
// reaches, rather than by its frame. The page's own marquee and click selection (Selecto) are used
// as they are, so the press goes the way a browser sends it; Moveable is stood in for. Synthetic
// sample D1; nothing here is a real experiment.

import { act, forwardRef, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, normalizeLayoutWorkspace, type LayoutWorkspace } from "../../engine/layout";
import { defaultShapeRecipe } from "../../engine/shapeBlock";
import { initialCoreState, type CoreState } from "../../store";
import { I18nProvider } from "../i18n";
import { LayoutTab } from "../LayoutTab";

const recorded = vi.hoisted(() => ({ target: null as unknown }));
vi.mock("../../plots/loadPlots", () => ({ loadMiniPlots: () => ({ renderMiniPlot: () => {}, renderStrategyGrid: () => {} }) }));
vi.mock("react-moveable", () => ({
  default: forwardRef((props: Record<string, any>, ref) => {
    recorded.target = props.target;
    useImperativeHandle(ref, () => ({ isMoveableElement: () => false, waitToChangeTarget: async () => {}, dragStart: () => {}, stopDrag: () => {}, updateRect: () => {} }));
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
  vi.unstubAllGlobals();
});

describe("A level line on the Layout page", () => {
  it("is selected by a press on its outline, which is wider than the line and takes only its stroke", async () => {
    const workspace = createDefaultLayoutWorkspace();
    workspace.sheets[0].items = [{ id: "line-1", x: 100, y: 200, width: 160, height: 0, z: 0, recipe: defaultShapeRecipe("line") }];
    const initial = normalizeLayoutWorkspace(JSON.parse(JSON.stringify(workspace)));
    function Harness() {
      const [current, setCurrent] = useState<LayoutWorkspace>(initial);
      return (
        <I18nProvider>
          <LayoutTab workspace={current} onChange={setCurrent} samples={[]} activeSampleId={null} activePopulationId={null} state={initialCoreState() as CoreState} globalScales={{}} defaultX="" defaultY="" illustrationConfig={null} dataRevision={0} densityColorPower={1.6} onOpenInGating={vi.fn()} />
        </I18nProvider>
      );
    }
    act(() => root.render(<Harness />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const item = host.querySelector<HTMLElement>('[data-item-id="line-1"]')!;
    expect(item.style.height).toBe("0px");
    const hit = item.querySelector<SVGElement>(".gl-layout-shape-hit")!;
    expect(hit.tagName).toBe("line");
    expect(hit.getAttribute("pointer-events")).toBe("stroke");
    // Ten screen pixels across at any zoom, or the stroke and a margin.
    expect(hit.style.strokeWidth).toContain("10 * var(--gl-hair");
    expect(recorded.target).toEqual([]);
    // A press and release on the outline, as the browser sends it to the element under the pointer.
    const at = { clientX: 180, clientY: 203, bubbles: true, cancelable: true, button: 0 };
    act(() => { hit.dispatchEvent(new MouseEvent("mousedown", at)); });
    act(() => { window.dispatchEvent(new MouseEvent("mouseup", at)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(recorded.target).toBe(item);
    expect(item.classList.contains("is-selected")).toBe(true);
  });
});
