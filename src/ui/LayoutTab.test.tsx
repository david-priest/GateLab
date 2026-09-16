// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutWorkspace, type LayoutWorkspace } from "../engine/layout";
import { initialCoreState } from "../store";
import { I18nProvider } from "./i18n";
import { LayoutTab } from "./LayoutTab";

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

describe("LayoutTab sheet and freeform foundations", () => {
  it("adds text blocks, creates sheets, and renames a sheet inline", () => {
    const changes: LayoutWorkspace[] = [];
    function Harness() {
      const [workspace, setWorkspace] = useState(createDefaultLayoutWorkspace);
      return (
        <I18nProvider>
          <LayoutTab
            workspace={workspace}
            onChange={(next) => {
              changes.push(next);
              setWorkspace(next);
            }}
            samples={[]}
            activeSampleId={null}
            activePopulationId={null}
            state={initialCoreState()}
            globalScales={{}}
            defaultX=""
            defaultY=""
            illustrationConfig={null}
            dataRevision={0}
            densityColorPower={1.6}
            onOpenInGating={vi.fn()}
          />
        </I18nProvider>
      );
    }

    act(() => root.render(<Harness />));
    expect(host.textContent).toContain("Blank layout");

    const addText = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "+ Text")!;
    act(() => addText.click());
    expect(host.querySelectorAll(".gl-layout-item")).toHaveLength(1);
    expect(changes.at(-1)?.sheets[0].items[0].recipe).toMatchObject({
      kind: "text",
      text: "Text",
    });

    const dragHandle = host.querySelector<HTMLElement>(".gl-layout-item-head")!;
    act(() => {
      dragHandle.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }));
      window.dispatchEvent(new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 160,
        clientY: 135,
      }));
      window.dispatchEvent(new MouseEvent("pointerup", {
        bubbles: true,
        clientX: 160,
        clientY: 135,
      }));
    });
    expect(changes.at(-1)?.sheets[0].items[0]).toMatchObject({ x: 84, y: 59 });

    const addSheet = host.querySelector<HTMLButtonElement>(".gl-layout-sheet-add")!;
    act(() => addSheet.click());
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(changes.at(-1)?.sheets).toHaveLength(2);

    const activeTab = host.querySelector<HTMLButtonElement>(".gl-layout-sheet-tab.active")!;
    act(() => activeTab.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const rename = host.querySelector<HTMLInputElement>(".gl-layout-sheet-rename")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(rename, "Figure 2");
      rename.dispatchEvent(new Event("input", { bubbles: true }));
      rename.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(changes.at(-1)?.sheets[1].name).toBe("Figure 2");
  });
});
