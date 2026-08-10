// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "./i18n";
import {
  IllustrationSelectionMatrix,
  type IllustrationMatrixPopulation,
  type IllustrationMatrixSample,
} from "./IllustrationSelectionMatrix";

let root: Root;
let host: HTMLDivElement;

const samples: IllustrationMatrixSample[] = [
  { id: "sample-a", name: "A.fcs", eventCount: { live: 25, rare: 0 } },
  { id: "sample-b", name: "B.fcs", eventCount: { live: 0, rare: 8 } },
];
const populations: IllustrationMatrixPopulation[] = [
  { id: "live", name: "Live", depth: 0 },
  { id: "rare", name: "Rare", depth: 1 },
];

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

describe("IllustrationSelectionMatrix", () => {
  it("selects exact population × FCS cells and supports non-empty bulk selection", () => {
    const changes: Array<Record<string, string[]>> = [];
    function Harness() {
      const [value, setValue] = useState<Record<string, string[]>>({
        "sample-a": ["live"],
        "sample-b": [],
      });
      return (
        <I18nProvider>
          <IllustrationSelectionMatrix
            samples={samples}
            populations={populations}
            value={value}
            onChange={(next) => {
              changes.push(next);
              setValue(next);
            }}
          />
        </I18nProvider>
      );
    }

    act(() => root.render(<Harness />));
    expect(host.textContent).toContain("1 of 4 combinations selected");

    const rareB = host.querySelector<HTMLButtonElement>(
      '[aria-label="B.fcs · Rare · 8 events"]',
    )!;
    act(() => rareB.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Enter",
    })));
    expect(changes.at(-1)).toEqual({
      "sample-a": ["live"],
      "sample-b": ["rare"],
    });
    expect(host.textContent).toContain("2 of 4 combinations selected");

    const none = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "None")!;
    act(() => none.click());
    expect(changes.at(-1)).toEqual({
      "sample-a": [],
      "sample-b": [],
    });

    const nonEmpty = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Non-empty")!;
    act(() => nonEmpty.click());
    expect(changes.at(-1)).toEqual({
      "sample-a": ["live"],
      "sample-b": ["rare"],
    });
  });
});
