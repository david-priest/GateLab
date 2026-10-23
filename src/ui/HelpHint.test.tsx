// @vitest-environment jsdom
// The "?" beside a control: a click opens its hint as a short list, and Escape, a click outside or a
// second click closes it; given an action instead, the same button does that.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpHint } from "./HelpHint";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const button = () => host.querySelector<HTMLButtonElement>(".gl-help-hint")!;
const popover = () => document.querySelector(".gl-help-hint-popover");

describe("HelpHint", () => {
  it("opens its hint on a click, as a list where it is ·-separated, and closes on a second click, Escape or a click outside", () => {
    act(() => root.render(<HelpHint topic="Plot" text="drag to pan · shift-drag to stretch" />));
    expect(button().getAttribute("aria-label")).toBe("Help: Plot");
    expect(button().title).toBe("drag to pan · shift-drag to stretch");
    expect(popover()).toBeNull();
    act(() => button().click());
    expect([...popover()!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["drag to pan", "shift-drag to stretch"]);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    act(() => button().click());
    expect(popover()).toBeNull();
    act(() => button().click());
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(popover()).toBeNull();
    act(() => button().click());
    act(() => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    expect(popover()).toBeNull();
  });

  it("shows a hint without a · as one paragraph", () => {
    act(() => root.render(<HelpHint topic="Tree" text="One line." />));
    act(() => button().click());
    expect(popover()!.querySelector("p")!.textContent).toBe("One line.");
  });

  it("does its one action when given one, with the same look", () => {
    const show = vi.fn();
    act(() => root.render(<HelpHint label="Show the explanation" tooltip="Show the introduction" onClick={show} />));
    expect(button().title).toBe("Show the introduction");
    expect(button().getAttribute("aria-label")).toBe("Show the explanation");
    act(() => button().click());
    expect(show).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
  });
});
