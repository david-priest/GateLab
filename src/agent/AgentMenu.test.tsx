// @vitest-environment jsdom
// The Agent menu in each state, the connect dialog's check of the address, and the badge an
// agent's gate wears in the gate list.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentMenu, AGENT_URL_STORAGE_KEY } from "./AgentMenu";
import { GateList } from "../ui/GateList";
import { coreReducer, initialCoreState, type CoreState } from "../store";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);
const trigger = () => host.querySelector(".gl-menu-trigger")!.textContent!.replace(/\s*▾$/, "");
const input = (value: string) => {
  const field = host.querySelector<HTMLInputElement>(".gl-agent-dialog input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("AgentMenu", () => {
  it("offers a connection, checks the address and remembers it", () => {
    const onConnect = vi.fn();
    act(() => root.render(<AgentMenu status={{ state: "idle" }} onConnect={onConnect} onDisconnect={vi.fn()} />));
    expect(trigger()).toBe("Agent");
    act(() => button("Connect to an agent…")!.click());
    expect(host.querySelector(".gl-agent-dialog")).not.toBeNull();
    act(() => input("http://127.0.0.1:1/"));
    act(() => button("Connect")!.click());
    expect(host.querySelector("[role=alert]")!.textContent).toContain("not a ws:// address");
    expect(onConnect).not.toHaveBeenCalled();
    act(() => input("ws://127.0.0.1:48123/?token=abc"));
    act(() => button("Connect")!.click());
    expect(onConnect).toHaveBeenCalledWith("ws://127.0.0.1:48123/?token=abc");
    expect(localStorage.getItem(AGENT_URL_STORAGE_KEY)).toBe("ws://127.0.0.1:48123/?token=abc");
    expect(host.querySelector(".gl-agent-dialog")).toBeNull();
    // Opened again, the dialog starts from the remembered address.
    act(() => button("Connect to an agent…")!.click());
    expect(host.querySelector<HTMLInputElement>(".gl-agent-dialog input")!.value).toBe("ws://127.0.0.1:48123/?token=abc");
  });

  it("shows who is connected and what it has done, and offers Disconnect, then Reconnect once closed", () => {
    const onDisconnect = vi.fn(), onConnect = vi.fn();
    act(() => root.render(<AgentMenu status={{ state: "connected", url: "ws://127.0.0.1:1/", writer: "claude", requests: 12 }} onConnect={onConnect} onDisconnect={onDisconnect} />));
    expect(trigger()).toBe("Agent · connected");
    expect(button("claude: 12 requests")!.disabled).toBe(true);
    act(() => button("Disconnect")!.click());
    expect(onDisconnect).toHaveBeenCalled();
    act(() => root.render(<AgentMenu status={{ state: "closed", url: "ws://127.0.0.1:1/", reason: "closed (1006)" }} onConnect={onConnect} onDisconnect={onDisconnect} />));
    expect(trigger()).toBe("Agent · not connected");
    expect(button("Last connection: closed (1006)")!.disabled).toBe(true);
    act(() => button("Reconnect")!.click());
    expect(onConnect).toHaveBeenCalledWith("ws://127.0.0.1:1/");
  });
});

describe("an agent's gate in the gate list", () => {
  it("wears a badge whose tooltip is the rationale", () => {
    let state: CoreState = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 4 });
    state = coreReducer(state, {
      type: "addGate", gateType: "rectangle", name: "CD4 high", xChannel: "A", yChannel: "B", vertices: [[0, 0], [1, 1]],
      createPop: { name: "CD4 high", parentId: state.root_population_id! },
      provenance: { by: "claude", rationale: "The valley between the modes.", at: "2026-10-06T00:00:00.000Z" },
    });
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "By hand", xChannel: "A", yChannel: "B", vertices: [[0, 0], [2, 2]] });
    act(() => root.render(<GateList state={state} derived={{ gateCounts: {} } as never} dispatch={vi.fn()} />));
    const badges = [...host.querySelectorAll(".gate-agent-badge")];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("agent");
    expect(badges[0].getAttribute("title")).toBe("Proposed by claude: The valley between the modes.");
    expect(badges[0].closest(".gate-card")!.textContent).toContain("CD4 high");
  });
});
