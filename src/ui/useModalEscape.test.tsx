// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModalEscape } from "./useModalEscape";

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

function escape(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe("Escape closes dialogs", () => {
  it("closes the topmost dialog only, then the one beneath it", () => {
    const lower = vi.fn();
    const upper = vi.fn();
    act(() => root.render(<><ModalEscape onClose={lower} /><ModalEscape onClose={upper} /></>));
    expect(escape().defaultPrevented).toBe(true);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    act(() => root.render(<><ModalEscape onClose={lower} /></>));
    escape();
    expect(lower).toHaveBeenCalledTimes(1);
    expect(upper).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog open when a control inside it has used the key, or when it cannot be left", () => {
    const onClose = vi.fn();
    act(() => root.render(<><ModalEscape onClose={onClose} /><input onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }} /></>));
    escape(host.querySelector("input")!);
    expect(onClose).not.toHaveBeenCalled();

    act(() => root.render(<ModalEscape onClose={null} />));
    expect(escape().defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls the close it was last given", () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => root.render(<ModalEscape onClose={first} />));
    act(() => root.render(<ModalEscape onClose={second} />));
    escape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
