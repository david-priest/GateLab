// @vitest-environment jsdom
// The gate list's quieter rows: one ⋯ menu per row in place of the action buttons, a header naming
// the population the counts are taken in, and the space badge only where it is unusual.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateList } from "./GateList";
import { coreReducer, initialCoreState, type CoreState } from "../store";

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

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
  for (const name of ["Cells", "CD4_positive"]) {
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name, xChannel: "A", yChannel: "B", vertices: [[0, 0], [1, 1]],
      createPop: { name, parentId: state.root_population_id! } });
  }
  return state;
}
const card = (name: string) => [...host.querySelectorAll<HTMLElement>(".gate-card")].find((row) => row.querySelector(".gate-card-name")?.textContent?.startsWith(name))!;

describe("gate list rows", () => {
  it("carries one ⋯ menu per row, and no row of action buttons", () => {
    const state = fixture();
    const rename = vi.fn();
    const dispatch = vi.fn();
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={dispatch}
      rowMenuOf={(gid) => [{ label: "Rename…", className: "gate-row-rename", onClick: () => rename(gid) }]} />));
    expect(host.querySelector(".gate-card-actions")).toBeNull();
    const row = card("Cells");
    const trigger = row.querySelector<HTMLButtonElement>(".gate-row-menu .gl-menu-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("Cells: actions");
    // Opening the menu does not select the row.
    act(() => trigger.click());
    expect(dispatch).not.toHaveBeenCalled();
    act(() => row.querySelector<HTMLButtonElement>(".gate-row-rename")!.click());
    expect(rename).toHaveBeenCalledWith(state.gate_order[0]);
    expect(row.querySelector(".gate-row-menu.has-proposal")).toBeNull();
  });

  it("names the population the counts are taken in over the list", () => {
    act(() => root.render(<GateList state={fixture()} derived={{ gateCounts: {} } as never} dispatch={vi.fn()} countHeader="CD4_positive" />));
    expect(host.querySelector(".gate-list-head-count")?.textContent).toBe("Events in CD4_positive");
    expect([...host.querySelectorAll(".gate-list-head > span")].map((cell) => cell.className.split(" ")[0])).toEqual(["gate-list-head-swatch", "gate-card-name", "gate-card-channels", "gate-card-info", "gate-card-menu"]);
    act(() => root.render(<GateList state={fixture()} derived={{ gateCounts: {} } as never} dispatch={vi.fn()} />));
    expect(host.querySelector(".gate-list-head")).toBeNull();
  });

  it("shows a space badge on the row only where it is unusual; the name's tooltip always has it", () => {
    const state = fixture();
    const badgeFor = () => ({ text: "RR", hint: "raw on both axes" });
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()}
      badgeFor={badgeFor} badgeShown={(gate) => gate.name === "CD4_positive"} />));
    expect(card("Cells").querySelector(".gate-space-badge")).toBeNull();
    // The name's tooltip carries the channels too, which a narrow pane drops from the row.
    expect(card("Cells").querySelector(".gate-card-name")!.getAttribute("title")).toBe("Cells\nA / B\nRR · raw on both axes");
    expect(card("CD4_positive").querySelector(".gate-space-badge")?.textContent).toBe("RR");
    expect(card("CD4_positive").querySelector(".gate-card-name")!.getAttribute("title")).toBe("CD4_positive\nA / B");
  });

  it("puts the tailoring switch in its own column, after the counts, on every row, its label inside it", () => {
    const state = fixture();
    const [cells, cd4] = state.gate_order;
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()}
      tailorSwitchOf={(gid) => (gid === cells ? { on: true, label: "follows Q1:Comp-PE-Cy7-A-,Comp-APC-Cy7-A+", title: "t" } : gid === cd4 ? { on: false, label: null, title: "t" } : null)}
      rowMenuOf={() => [{ label: "Rename…", onClick: vi.fn() }]} />));
    for (const name of ["Cells", "CD4_positive"]) {
      const row = card(name);
      const children = [...row.children].map((child) => child.className);
      // The column sits between the counts and the ⋯, so nothing before it moves it.
      expect(children.indexOf("gate-tailor-col")).toBe(children.indexOf("gate-card-info") + 1);
      expect(children.indexOf("gate-card-menu")).toBe(children.indexOf("gate-tailor-col") + 1);
    }
    expect(card("Cells").querySelector(".gate-tailor-col .gate-tailor-switch-label")?.textContent).toBe("follows Q1:Comp-PE-Cy7-A-,Comp-APC-Cy7-A+");
    expect(card("Cells").querySelector(".gate-tailor-col .gate-tailor-switch")?.getAttribute("title")).toBe("t");
    // Without switches at all, no column is held.
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()} />));
    expect(host.querySelector(".gate-tailor-col")).toBeNull();
  });

  it("colours the switch by whose version is used, dashes a pending group tailoring, and asks for the file on a click", () => {
    const state = fixture();
    const [cells, cd4] = state.gate_order;
    const onTailorSwitch = vi.fn();
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()} onTailorSwitch={onTailorSwitch}
      tailorSwitchOf={(gid) => (gid === cells
        ? { on: true, next: true, colour: "#e6820e", label: "Treated", title: "group" }
        : gid === cd4 ? { on: false, pending: true, colour: "#e6820e", label: "Treated", title: "pending" } : null)} />));
    const sw = (name: string) => card(name).querySelector<HTMLElement>(".gate-tailor-switch")!;
    expect(sw("Cells").classList.contains("is-on")).toBe(true);
    expect(sw("Cells").style.getPropertyValue("--gl-switch-on")).toBe("#e6820e");
    expect(sw("CD4_positive").classList.contains("is-pending")).toBe(true);
    expect(sw("CD4_positive").querySelector("input")!.checked).toBe(false);
    // On for the group's version, yet a click asks to tailor the file: `next`, not the checkbox's flip.
    act(() => sw("Cells").querySelector("input")!.click());
    expect(onTailorSwitch).toHaveBeenLastCalledWith(cells, true);
    // The switch is alone in its column: the other choices are in the row's ⋯ menu.
    expect([...card("Cells").querySelector(".gate-tailor-col")!.children].map((child) => child.className)).toEqual(["gate-tailor-switch is-on is-group"]);
    expect(card("Cells").querySelector(".gate-tailor-choices-menu")).toBeNull();
  });

  it("gives a gate that follows the tree no chip, and at most one chip on any row", () => {
    const state = fixture();
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()}
      scopeChipOf={(gid) => (gid === state.gate_order[1] ? { label: "+1 version", title: "D2.fcs", menu: false } : null)} />));
    expect(card("Cells").querySelectorAll(".gate-scope-chip, .gate-space-badge")).toHaveLength(0);
    expect([...card("CD4_positive").querySelectorAll(".gate-scope-chip")].map((chip) => chip.textContent)).toEqual(["+1 version"]);
  });
});
