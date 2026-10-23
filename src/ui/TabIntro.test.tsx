// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabIntro, TabIntroToggle, useTabIntro } from "./TabIntro";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Tab() {
  const intro = useTabIntro("example");
  return (
    <div>
      <h2>Example<TabIntroToggle intro={intro} /></h2>
      <TabIntro intro={intro}>How this tab works.</TabIntro>
    </div>
  );
}

const hideButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Hide this explanation"]');
const showButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Show the explanation"]');

describe("a tab's explanation", () => {
  it("shows on the first visit, hides with ×, stays hidden on the next visit and comes back with ?", () => {
    act(() => root.render(<Tab />));
    expect(host.textContent).toContain("How this tab works.");
    expect(showButton()).toBeNull();

    act(() => hideButton()!.click());
    expect(host.textContent).not.toContain("How this tab works.");
    expect(localStorage.getItem("gatelab.intro.example.hidden")).toBe("1");

    // The next visit: the tab is mounted afresh and remembers.
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Tab />));
    expect(host.textContent).not.toContain("How this tab works.");

    act(() => showButton()!.click());
    expect(host.textContent).toContain("How this tab works.");
    expect(localStorage.getItem("gatelab.intro.example.hidden")).toBeNull();
  });

  it("still shows and hides where the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    act(() => root.render(<Tab />));
    expect(host.textContent).toContain("How this tab works.");
    act(() => hideButton()!.click());
    expect(host.textContent).not.toContain("How this tab works.");
    act(() => showButton()!.click());
    expect(host.textContent).toContain("How this tab works.");
  });
});
