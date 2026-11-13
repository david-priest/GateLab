// @vitest-environment jsdom

// LayoutSourcePanel.test.tsx — the inspector's Data list (a long file list cut to three names,
// the full list in its title), the note shown when the pointer rests on a block for half a second
// (on the document, not in the sheet), and the legend block's mark (its date, a regenerate that
// asks first, the English note in the Japanese interface). Synthetic files D1 to D5.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import type { BlockSource } from "./layoutSources";
import { LayoutLegendMark, LayoutSourceHover, LayoutSourcePanel, SOURCE_HOVER_DELAY } from "./LayoutSourcePanel";

const SOURCE: BlockSource = {
  kind: "statistic",
  shows: "Median CD4 of CD4_positive cells per file",
  files: ["D1.fcs", "D2.fcs", "D3.fcs", "D4.fcs", "D5.fcs"],
  populations: ["CD4_positive"],
  channels: ["CD4"],
  value: "Median CD4",
  statistic: "median",
  unit: "files",
  groupTitle: "Treatment",
  groups: [{ label: "control", population: "CD4_positive", n: 2 }, { label: "treated", population: "CD4_positive", n: 3 }],
  centre: "Boxes show the median and quartiles of the files.",
  testAsked: true,
  tests: [{ panel: "CD4_positive", name: "Wilcoxon rank-sum", p: 0.1 }],
  follows: false,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("The inspector's Data list", () => {
  it("cuts the file list to three names and keeps the full list in its title", () => {
    act(() => root.render(<LayoutSourcePanel source={SOURCE} />));
    const terms = [...host.querySelectorAll(".gl-layout-source > dl > dt")].map((dt) => dt.textContent);
    expect(terms).toContain("Files (5)");
    const files = [...host.querySelectorAll(".gl-layout-source > dl > dd")].find((dd) => dd.textContent?.startsWith("D1.fcs"))!;
    expect(files.textContent).toBe("D1.fcs, D2.fcs, D3.fcs + 2 more");
    expect(files.getAttribute("title")).toBe("D1.fcs, D2.fcs, D3.fcs, D4.fcs, D5.fcs");
    expect(host.textContent).toContain("control, n = 2 files; treated, n = 3 files");
    expect(host.textContent).toContain("Wilcoxon rank-sum test, p = 0.10.");
    // The placeholders the block offers, each with what it reads.
    const tokens = [...host.querySelectorAll(".gl-layout-source-placeholders dt code")].map((code) => code.textContent);
    expect(tokens).toEqual(["{files}", "{sizes}", "{unit}", "{channel}", "{statistic}", "{test}", "{p}"]);
  });

  it("shows nothing for a block that draws no data", () => {
    act(() => root.render(<LayoutSourcePanel source={null} />));
    expect(host.innerHTML).toBe("");
  });
});

describe("The note over a block", () => {
  it("shows after the pointer rests half a second, outside the sheet, and holds back the block's title", () => {
    vi.useFakeTimers();
    const sheet = document.createElement("section");
    sheet.innerHTML = `<article class="gl-layout-item" data-item-id="a" title="Block A"><div class="inner"></div></article>`;
    document.body.appendChild(sheet);
    const describe = vi.fn((id: string) => (id === "a" ? SOURCE : null));
    act(() => root.render(<LayoutSourceHover container={sheet} describe={describe} />));
    const inner = sheet.querySelector(".inner")!;
    act(() => { inner.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 40, clientY: 40 })); });
    act(() => { vi.advanceTimersByTime(SOURCE_HOVER_DELAY - 50); });
    expect(document.querySelector(".gl-layout-source-tip")).toBeNull();
    act(() => { vi.advanceTimersByTime(60); });
    const tip = document.querySelector(".gl-layout-source-tip")!;
    expect(tip.textContent).toContain("Median CD4 of CD4_positive cells per file");
    expect(sheet.contains(tip)).toBe(false);
    expect(sheet.querySelector("article")!.hasAttribute("title")).toBe(false);
    // A press hides it and gives the block its title back.
    act(() => { inner.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(document.querySelector(".gl-layout-source-tip")).toBeNull();
    expect(sheet.querySelector("article")!.getAttribute("title")).toBe("Block A");
    sheet.remove();
  });
});

describe("A legend block's mark", () => {
  it("regenerates only after the confirmation, and says the legend is English in the Japanese interface", () => {
    const onRegenerate = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    act(() => root.render(<LayoutLegendMark date="2026-11-10" onRegenerate={onRegenerate} />));
    expect(host.textContent).toContain("Legend written 2026-11-10");
    expect(host.querySelector(".gl-hint")).toBeNull();
    act(() => host.querySelector("button")!.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onRegenerate).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    act(() => host.querySelector("button")!.click());
    expect(onRegenerate).toHaveBeenCalledTimes(1);

    window.localStorage.setItem("gatelab.uiLanguage", "ja");
    act(() => root.render(<I18nProvider><LayoutLegendMark date="2026-11-10" onRegenerate={onRegenerate} /></I18nProvider>));
    expect(host.querySelector(".gl-hint")?.textContent).toBe("凡例は学術誌が受け付ける英語で書かれます。");
  });
});
