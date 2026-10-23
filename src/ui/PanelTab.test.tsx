// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sample } from "../engine/sample";
import { I18nProvider } from "./i18n";
import { PanelTab } from "./PanelTab";

let root: Root;
let host: HTMLDivElement;

const sample = {
  channels: [
    { key: "FSC-A", pnn: "FSC-A", marker: null, label: undefined },
    { key: "CD3", pnn: "Blue 1-A", marker: "CD3", label: undefined },
    { key: "CD19", pnn: "Red 2-A", marker: "CD19", label: "B cells" },
  ],
  channelLabel: (index: number) => ["FSC-A", "CD3", "B cells"][index],
  isRenamable: (index: number) => index !== 0,
} as unknown as Sample;

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

describe("PanelTab bulk editing", () => {
  it("previews an uploaded template and applies all validated changes in one callback", async () => {
    const onRenameMany = vi.fn();
    act(() => root.render(
      <I18nProvider>
        <PanelTab
          sample={sample}
          onRename={vi.fn()}
          onRenameMany={onRenameMany}
          onResetAll={vi.fn()}
          labelMode="marker"
          onLabelModeChange={vi.fn()}
        />
      </I18nProvider>,
    ));

    expect(host.textContent).toContain("Download template");
    expect(host.textContent).toContain("Upload CSV/TSV…");
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const table = "channel_key,display_name\nFSC-A,Forward scatter\nCD3,T cells\nCD19,\n";
    const file = new File([table], "edited-panel.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { configurable: true, value: vi.fn().mockResolvedValue(table) });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(host.textContent).toContain("Ready to apply 2 display-name changes.");
    expect(host.textContent).toContain("1 locked changes ignored");
    const apply = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Apply panel changes")!;
    act(() => apply.click());
    expect(onRenameMany).toHaveBeenCalledWith([
      { key: "CD3", label: "T cells" },
      { key: "CD19", label: "" },
    ]);
  });

  it("rejects malformed uploads without exposing an Apply action", async () => {
    act(() => root.render(
      <I18nProvider>
        <PanelTab
          sample={sample}
          onRename={vi.fn()}
          onRenameMany={vi.fn()}
          onResetAll={vi.fn()}
          labelMode="marker"
          onLabelModeChange={vi.fn()}
        />
      </I18nProvider>,
    ));
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const table = "channel_key,marker\nCD3,T cells\n";
    const file = new File([table], "bad.csv");
    Object.defineProperty(file, "text", { configurable: true, value: vi.fn().mockResolvedValue(table) });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("display_name");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Apply panel changes")).toBe(false);
  });
});

describe("PanelTab locked channels and its explanation", () => {
  const render = () => act(() => root.render(
    <I18nProvider>
      <PanelTab
        sample={sample}
        onRename={vi.fn()}
        onRenameMany={vi.fn()}
        onResetAll={vi.fn()}
        labelMode="marker"
        onLabelModeChange={vi.fn()}
      />
    </I18nProvider>,
  ));
  afterEach(() => localStorage.clear());

  it("marks a locked channel with a lock icon and the word, its reason as the tooltip, not a LOCKED chip", () => {
    render();
    const rows = [...host.querySelectorAll("tbody tr")];
    const lock = rows[0].querySelector<HTMLElement>(".gl-panel-lock")!;
    expect(lock.querySelector("svg")).not.toBeNull();
    expect(lock.getAttribute("title")).toBe("Locked (scatter, QC or imaging feature)");
    expect(lock.getAttribute("aria-label")).toBe("Locked (scatter, QC or imaging feature)");
    // The muted word beside the icon (David, 2026-10-23: "Put back the 'locked' word"), not a chip.
    expect(lock.textContent).toBe("Locked");
    expect(rows[1].querySelector(".gl-panel-lock")).toBeNull();
    expect(host.querySelector(".gl-pill-lock")).toBeNull();
  });

  it("hides the explanation with × and brings it back with ? by the title", () => {
    render();
    const text = "Rename the display name (marker) for each channel.";
    expect(host.textContent).toContain(text);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Hide this explanation"]')!.click());
    expect(host.textContent).not.toContain(text);
    const show = host.querySelector<HTMLButtonElement>('h2 button[aria-label="Show the explanation"]')!;
    act(() => show.click());
    expect(host.textContent).toContain(text);
  });
});
