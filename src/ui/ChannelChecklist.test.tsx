// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelChecklist } from "./ChannelChecklist";
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

const OPTIONS = [
  { key: "FSC-A", label: "FSC-A" },
  { key: "CD4", label: "CD4_positive" },
  { key: "CD8", label: "CD8" },
  { key: "CD45RA", label: "CD45RA" },
];

let ticked: string[] = [];
function Harness() {
  const [checked, setChecked] = useState<string[]>([]);
  ticked = checked;
  return (
    <I18nProvider>
      <ChannelChecklist
        label="More channels"
        options={OPTIONS}
        checked={checked}
        onToggle={(keys, on) => setChecked((was) => (on ? [...was, ...keys.filter((k) => !was.includes(k))] : was.filter((k) => !keys.includes(k))))}
      />
    </I18nProvider>
  );
}

const rows = () => [...host.querySelectorAll(".gl-channel-checklist-rows label")].map((l) => l.textContent);
const search = (text: string) =>
  act(() => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("ChannelChecklist", () => {
  it("filters the rows by label or key, case-insensitively, and keeps hidden ticks", () => {
    act(() => root.render(<Harness />));
    expect(rows()).toEqual(["FSC-A", "CD4_positive", "CD8", "CD45RA"]);
    act(() => host.querySelectorAll<HTMLInputElement>(".gl-channel-checklist-rows input")[0].click());
    expect(ticked).toEqual(["FSC-A"]);
    search("cd4");
    expect(rows()).toEqual(["CD4_positive", "CD45RA"]);
    expect(ticked).toEqual(["FSC-A"]);
    search("zzz");
    expect(rows()).toEqual([]);
    expect(host.textContent).toContain("No channel matches");
  });

  it("ticks and unticks only the rows the search shows", () => {
    act(() => root.render(<Harness />));
    search("CD");
    act(() => button("Tick shown").click());
    expect(ticked).toEqual(["CD4", "CD8", "CD45RA"]);
    search("");
    expect(button("Tick all").disabled).toBe(false);
    search("cd8");
    act(() => button("Untick shown").click());
    expect(ticked).toEqual(["CD4", "CD45RA"]);
    search("");
    act(() => button("Untick all").click());
    expect(ticked).toEqual([]);
  });
});
