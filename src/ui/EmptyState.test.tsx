// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

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

describe("the opening page, before any file is loaded", () => {
  it("shows the logo, says a file or a workspace begins, and starts the tutorial from a link", () => {
    const onStart = vi.fn(), onResume = vi.fn();
    act(() => root.render(<EmptyState logo tutorial={{ paused: false, onStart, onResume }} />));
    expect(host.querySelector<HTMLImageElement>("img.gl-splash-logo")!.alt).toBe("GateLab");
    expect(host.querySelector(".gl-splash-title")!.textContent).toBe("Open an FCS file or a workspace to begin.");
    expect(host.querySelector(".gl-splash-tutorial")!.textContent).toBe("New to GateLab? Start the tutorial");
    expect(host.querySelector(".gl-splash-hint")!.textContent).toBe("Use a wide browser window.");
    const link = host.querySelector<HTMLButtonElement>("button.gl-splash-link")!;
    act(() => link.click());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("offers to resume a tutorial that was ended part way", () => {
    const onStart = vi.fn(), onResume = vi.fn();
    act(() => root.render(<EmptyState logo tutorial={{ paused: true, onStart, onResume }} />));
    const link = host.querySelector<HTMLButtonElement>("button.gl-splash-link")!;
    expect(link.textContent).toBe("Resume the tutorial");
    act(() => link.click());
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("leaves the logo and the tutorial out under a host that has neither", () => {
    act(() => root.render(<EmptyState logo={false} tutorial={null} />));
    expect(host.querySelector(".gl-splash-title")!.textContent).toBe("Open an FCS file or a workspace to begin.");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).not.toContain("New to GateLab?");
  });
});
