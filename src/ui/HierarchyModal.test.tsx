// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HierarchyModal } from "./HierarchyModal";
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

const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;

describe("HierarchyModal", () => {
  it("creates with the proposed name, and refuses a name another hierarchy has", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <HierarchyModal mode="duplicate" currentName="Main" initialName="Main copy" takenNames={["Main", "Other"]} onCancel={vi.fn()} onConfirm={onConfirm} />
        </I18nProvider>,
      );
    });
    const input = host.querySelector("input")!;
    expect(input.value).toBe("Main copy");
    expect(button("Create").disabled).toBe(false);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Other");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Another hierarchy already has that name.");
    expect(button("Create").disabled).toBe(true);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  Scheme B ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Create").click());
    expect(onConfirm).toHaveBeenCalledWith("Scheme B");
  });

  it("confirms a deletion by name and says the gates stay", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <I18nProvider>
          <HierarchyModal mode="delete" currentName="Scheme B" initialName="" takenNames={[]} onCancel={vi.fn()} onConfirm={onConfirm} />
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain('Delete the hierarchy "Scheme B" and its populations? The gates stay');
    expect(host.querySelector("input")).toBeNull();
    act(() => button("Delete").click());
    expect(onConfirm).toHaveBeenCalledWith("");
  });
});
