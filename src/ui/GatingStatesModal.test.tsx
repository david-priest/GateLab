// @vitest-environment jsdom
//
// The Gating states dialog: the current gating saved under a name, and a saved state restored,
// updated, renamed or deleted. Synthetic gates Cells / CD4_positive.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureGatingState, type SavedGatingState } from "../gatingStates";
import { coreReducer, initialCoreState } from "../store";
import { GatingStatesModal } from "./GatingStatesModal";
import { I18nProvider } from "./i18n";

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

function saved(id: string, name: string, gates: string[]): SavedGatingState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 100 });
  for (const gate of gates) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: gate,
      xChannel: "FSC-A", yChannel: "SSC-A", vertices: [[0, 0], [100, 100]],
      createPop: { name: gate, parentId: state.root_population_id! } });
  }
  return captureGatingState(state, ["D1"], name, new Date(), id);
}
const STATES = [saved("s1", "Tight gates", ["Cells"]), saved("s2", "Loose gates", ["Cells", "CD4_positive"])];

function open(over: Partial<Parameters<typeof GatingStatesModal>[0]> = {}) {
  const handlers = { onSave: vi.fn(), onRestore: vi.fn(), onUpdate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onClose: vi.fn() };
  act(() => {
    root.render(
      <I18nProvider>
        <GatingStatesModal states={STATES} currentIds={new Set()} suggestedName="State 3" {...handlers} {...over} />
      </I18nProvider>,
    );
  });
  return handlers;
}
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;
const rows = () => Array.from(host.querySelectorAll<HTMLLabelElement>(".gl-modal-history-list label"));
const choose = (index: number) => act(() => rows()[index].querySelector<HTMLInputElement>('input[type="radio"]')!.click());
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (target: Element, name: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });

describe("the Gating states dialog", () => {
  it("lists the saved states with what each holds, and says so when there are none", () => {
    open();
    expect(rows().map((row) => row.querySelector("strong")!.textContent)).toEqual(["Tight gates", "Loose gates"]);
    expect(rows().map((row) => row.querySelector("small")!.textContent)).toEqual(["1 gates · 1 populations", "2 gates · 2 populations"]);

    open({ states: [] });
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("No gating states saved yet in this workspace.");
  });

  it("saves the current gating under the name typed, or the suggested one", () => {
    const { onSave } = open();
    const name = host.querySelector<HTMLInputElement>(".gl-gating-state-save input")!;
    expect(name.placeholder).toBe("State 3");
    act(() => button("Save the current gating").click());
    expect(onSave).toHaveBeenLastCalledWith("State 3");

    type(name, "  After the doublets  ");
    act(() => button("Save the current gating").click());
    expect(onSave).toHaveBeenLastCalledWith("After the doublets");
    expect(name.value).toBe("");
  });

  it("restores the chosen state, and nothing until one is chosen", () => {
    const { onRestore } = open();
    expect(button("Restore this state").disabled).toBe(true);
    choose(1);
    expect(button("Restore this state").disabled).toBe(false);
    act(() => button("Restore this state").click());
    expect(onRestore).toHaveBeenCalledExactlyOnceWith("s2");
  });

  it("marks the state the gating matches, which is neither restored nor updated", () => {
    open({ currentIds: new Set(["s1"]) });
    expect(rows()[0].querySelector("strong")!.textContent).toBe("Tight gates · the gating as it is now");
    choose(0);
    expect(button("Restore this state").disabled).toBe(true);
    expect(button("Update").disabled).toBe(true);
    choose(1);
    expect(button("Restore this state").disabled).toBe(false);
    expect(button("Update").disabled).toBe(false);
  });

  it("asks once before a saved state is replaced or deleted", () => {
    const { onUpdate, onDelete } = open();
    choose(0);
    act(() => button("Update").click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Replace the saved state "Tight gates" with the gating as it is now?');
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => button("Cancel").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() => button("Update").click());
    act(() => button("Replace").click());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith("s1");

    act(() => button("Delete").click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Delete the saved state "Tight gates"?');
    expect(onDelete).not.toHaveBeenCalled();
    // Choosing another state withdraws the question.
    choose(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    act(() => button("Delete").click());
    act(() => Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === "Delete").at(-1)!.click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("s2");
  });

  it("renames a state in its row: Enter keeps the name, Escape leaves it and the dialog open", () => {
    const { onRename, onClose } = open();
    choose(0);
    act(() => button("Rename").click());
    let field = rows()[0].querySelector<HTMLInputElement>('.gl-modal-history-what input')!;
    expect(field.value).toBe("Tight gates");
    type(field, "Tighter gates");
    key(field, "Enter");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("s1", "Tighter gates");
    expect(rows()[0].querySelector(".gl-modal-history-what input")).toBeNull();

    // A double-click on the name does the same; Escape in the field is the field's.
    act(() => { rows()[1].querySelector("strong")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    field = rows()[1].querySelector<HTMLInputElement>('.gl-modal-history-what input')!;
    type(field, "Other");
    key(field, "Escape");
    expect(rows()[1].querySelector(".gl-modal-history-what input")).toBeNull();
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // With no field open, Escape closes the dialog.
    key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
