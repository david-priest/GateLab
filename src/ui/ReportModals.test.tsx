// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiflowcytAuthorInput } from "../reports/miflowcytReport";
import { MiflowcytReportModal } from "./MiflowcytReportModal";
import { MembershipExportModal } from "./MembershipModals";

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

function button(text: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
}

/** Type into a controlled field the way a user does: the value, then an input event. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const span = [...host.querySelectorAll(".gl-miflowcyt-field > span")].find((s) => s.textContent === label)!;
  return span.parentElement!.querySelector("input, textarea")!;
}

describe("MiflowcytReportModal", () => {
  function render(author: MiflowcytAuthorInput, onAuthorChange = vi.fn(), onDownload = vi.fn()) {
    act(() => root.render(
      <MiflowcytReportModal author={author} onAuthorChange={onAuthorChange} viewedName="D1.fcs" checkedCount={2} allCount={3} onDownload={onDownload} onClose={() => {}} />,
    ));
    return { onAuthorChange, onDownload };
  }

  it("hands each typed item to the workspace, keywords as a list, keeping the comma being typed", () => {
    let author: MiflowcytAuthorInput = { purpose: "Old purpose" };
    const onAuthorChange = vi.fn((next: MiflowcytAuthorInput) => { author = next; });
    render(author, onAuthorChange);
    expect((field("Purpose") as HTMLTextAreaElement).value).toBe("Old purpose");
    type(field("Organism"), "Homo sapiens");
    expect(author).toEqual({ purpose: "Old purpose", organism: "Homo sapiens" });
    type(field("Keywords"), "B cells, ");
    expect(author.keywords).toEqual(["B cells"]);
    // Re-rendered with the stored list, the field still shows what was typed.
    render(author, onAuthorChange);
    expect((field("Keywords") as HTMLInputElement).value).toBe("B cells, ");
  });

  it("downloads for the chosen files and threshold, and refuses a threshold that is not a whole number", () => {
    const { onDownload } = render({});
    const all = [...host.querySelectorAll<HTMLInputElement>('input[name="miflowcyt-scope"]')][2];
    act(() => all.click());
    const min = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    type(min, "100");
    act(() => button("Download HTML").click());
    expect(onDownload).toHaveBeenCalledWith("html", "all", 100);
    type(min, "2.5");
    expect(button("Download Markdown").disabled).toBe(true);
  });
});

describe("MembershipExportModal", () => {
  it("reports what was written and the renamed columns", async () => {
    const onExport = vi.fn(async () => ({ written: ["D1.fcs"], notes: ['D1.fcs: a second population named "CD4_positive" under one parent is the column "Lymphocytes/CD4_positive (2)".'] }));
    act(() => root.render(<MembershipExportModal viewedName="D1.fcs" checkedCount={0} allCount={1} onExport={onExport} onClose={() => {}} />));
    await act(async () => button("Export").click());
    expect(onExport).toHaveBeenCalledWith("viewed");
    expect(host.textContent).toContain("Written: D1.fcs.");
    expect(host.textContent).toContain("CD4_positive (2)");
  });
});
