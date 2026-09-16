// @vitest-environment jsdom
// A details-based popover closes on a click outside it and on Escape, and stays open on a click inside.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePopoverDismissal } from "./usePopoverDismissal";

function Probe() {
  usePopoverDismissal();
  return (
    <div>
      <button id="outside">elsewhere</button>
      <details className="gl-popover" id="pop">
        <summary>Display</summary>
        <div className="body"><button id="inside">inside</button></div>
      </details>
      <details id="fold" open><summary>A fold</summary><p>stays</p></details>
    </div>
  );
}

let root: Root; let host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<Probe />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const pop = () => host.querySelector<HTMLDetailsElement>("#pop")!;
const down = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });

describe("usePopoverDismissal", () => {
  it("closes an open popover on a mousedown outside it, and leaves it open on one inside", () => {
    pop().open = true;
    down(host.querySelector("#inside")!);
    expect(pop().open).toBe(true);
    down(host.querySelector("#outside")!);
    expect(pop().open).toBe(false);
  });

  it("closes on Escape and leaves plain folds alone", () => {
    pop().open = true;
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(pop().open).toBe(false);
    down(host.querySelector("#outside")!);
    expect(host.querySelector<HTMLDetailsElement>("#fold")!.open).toBe(true);
  });
});
