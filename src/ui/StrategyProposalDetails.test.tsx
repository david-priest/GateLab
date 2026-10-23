// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateList } from "./GateList";
import { coreReducer, initialCoreState, type CoreState } from "../store";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function fixture() {
  let state = coreReducer(initialCoreState(), {type:"loadSample", nEvents:4});
  state = coreReducer(state, {type:"addGate", gateType:"rectangle", name:"Parent range", xChannel:"Marker_A", yChannel:"Marker_B", vertices:[[0,0],[4,4]], createPop:{name:"Parent population", parentId:state.root_population_id!}});
  const parent = Object.values(state.populations).find(p=>p.name === "Parent population")!;
  state = coreReducer(state, {type:"addGate", gateType:"rectangle", name:"Proposed range", xChannel:"Marker_A", yChannel:"Marker_B", vertices:[[1.123456789012345,1],[3,3]], space:"display", createPop:{name:"Proposed population", parentId:parent.population_id}, provenance:{by:"test-agent", rationale:"<script>unsafe()</script>\nTraining distribution has two modes.", at:"2026-01-01T00:00:00Z"}});
  const id = Object.values(state.gates).find(g=>g.name === "Proposed range")!.gate_id;
  return {state,id,parent};
}
const panel = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Strategy proposal details"]');

describe("strategy proposal inspection", () => {
  it("opens without selecting or changing gates, escapes supplied text, and restores keyboard focus", () => {
    const {state} = fixture();
    const before = JSON.stringify(state);
    const dispatch = vi.fn();
    act(()=>root.render(<GateList state={state} derived={{gateCounts:{}} as never} dispatch={dispatch} countScope="pooled · 2 files" />));
    // The proposal is an item of the row's ⋯ menu, whose trigger carries a dot for it.
    const trigger = host.querySelector<HTMLButtonElement>(".gate-row-menu.has-proposal .gl-menu-trigger")!;
    expect(trigger.getAttribute("aria-label")).toBe("Proposed range: actions; it was proposed");
    act(()=>trigger.click());
    act(()=>host.querySelector<HTMLButtonElement>(".gate-proposal-item")!.click());
    expect(panel()).not.toBeNull();
    expect(document.activeElement).toBe(panel());
    expect(panel()!.querySelector("script")).toBeNull();
    expect(panel()!.textContent).toContain("<script>unsafe()</script>");
    expect(panel()!.textContent).toContain("Parent population → Proposed population");
    expect(panel()!.textContent).toContain("pooled · 2 files");
    expect(panel()!.textContent).toContain("1.123456789012345");
    expect(panel()!.textContent).toContain("not a measured accuracy");
    const globalKey = vi.fn();
    document.addEventListener("keydown", globalKey);
    act(()=>panel()!.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true})));
    document.removeEventListener("keydown", globalKey);
    expect(globalKey).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).toBe(before);
  });

  it("shows current geometry after an edit and survives population selection without rewriting the rationale", () => {
    const {state,id,parent} = fixture();
    const draw = (next:CoreState)=>act(()=>root.render(<GateList state={next} derived={{gateCounts:{}} as never} dispatch={vi.fn()} />));
    draw(state);
    act(()=>host.querySelector<HTMLButtonElement>(".gate-proposal-item")!.click());
    const edited = {...state, active_population_id:parent.population_id, gates:{...state.gates, [id]:{...state.gates[id], vertices:[[2.25,1],[3,3]]}}} as CoreState;
    draw(edited);
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain("2.25");
    expect(panel()!.textContent).not.toContain("1.123456789012345");
    expect(panel()!.textContent).toContain("Training distribution has two modes.");
    expect(panel()!.textContent).toContain("may not describe later edits");
    draw({...edited,gates:{},gate_order:[]});
    expect(panel()).toBeNull();
  });

  it("labels missing legacy metadata explicitly and leaves hand-drawn gates without an agent control", () => {
    const {state,id} = fixture();
    const gate = {...state.gates[id], space:undefined, transforms:undefined, provenance:{by:"",rationale:"",at:""}};
    act(()=>root.render(<GateList state={{...state,gates:{...state.gates,[id]:gate}}} derived={{gateCounts:{}} as never} dispatch={vi.fn()} />));
    expect(host.querySelectorAll(".gate-proposal-item")).toHaveLength(1);
    // A gate made before sources were recorded was an agent's: the menu item says so, the details
    // say the source itself was not recorded.
    expect(host.querySelector(".gate-proposal-item")!.textContent).toBe("Proposed by agent…");
    act(()=>host.querySelector<HTMLButtonElement>(".gate-proposal-item")!.click());
    expect(panel()!.querySelectorAll("dd")[0].textContent).toBe("Not recorded");
    expect(panel()!.querySelectorAll("dd")[1].textContent).toBe("Not recorded");
    expect(panel()!.textContent).toContain('"transforms": null');
    act(()=>panel()!.querySelector<HTMLButtonElement>("button")!.click());
    expect(panel()).toBeNull();
  });

  it("names the source a proposal recorded on its gates", () => {
    const {state,id} = fixture();
    const gate = {...state.gates[id], provenance:{by:"GateLabR",rationale:"Sent from R.",at:"2026-01-01T00:00:00Z",source:"file"}};
    act(()=>root.render(<GateList state={{...state,gates:{...state.gates,[id]:gate}}} derived={{gateCounts:{}} as never} dispatch={vi.fn()} />));
    expect(host.querySelector(".gate-proposal-item")!.textContent).toBe("Proposed by file…");
    act(()=>host.querySelector<HTMLButtonElement>(".gate-proposal-item")!.click());
    expect([...panel()!.querySelectorAll("dd")].slice(0, 2).map((dd) => dd.textContent)).toEqual(["file", "GateLabR"]);
  });
});
