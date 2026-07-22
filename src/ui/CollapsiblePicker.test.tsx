// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsiblePicker } from "./CollapsiblePicker";
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

describe("CollapsiblePicker", () => {
  it("reclaims checklist space while retaining its label, selection summary, and actions", () => {
    act(() => root.render(
      <I18nProvider>
        <CollapsiblePicker
          label="Populations"
          summary="3 of 10 selected"
          actions={<button type="button">All</button>}
        >
          <div data-testid="picker-list">Population checklist</div>
        </CollapsiblePicker>
      </I18nProvider>,
    ));

    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Hide Populations"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="picker-list"]')).not.toBeNull();

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show Populations");
    expect(host.querySelector('[data-testid="picker-list"]')).toBeNull();
    expect(host.textContent).toContain("Populations");
    expect(host.textContent).toContain("3 of 10 selected");
    expect(host.textContent).toContain("All");

    act(() => toggle.click());
    expect(host.querySelector('[data-testid="picker-list"]')).not.toBeNull();
  });
});
