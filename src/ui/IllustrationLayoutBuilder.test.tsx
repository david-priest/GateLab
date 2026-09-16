// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IllustrationDimensionLayout } from "../engine/illustrationLayout";
import { I18nProvider } from "./i18n";
import { IllustrationLayoutBuilder } from "./IllustrationLayoutBuilder";

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

describe("IllustrationLayoutBuilder", () => {
  it("offers drag layout with a keyboard-accessible placement control", () => {
    const changes: IllustrationDimensionLayout[] = [];
    function Harness() {
      const [layout, setLayout] = useState<IllustrationDimensionLayout>({
        rows: ["files", "populations"], columns: ["channels"], overlay: [],
      });
      return (
        <I18nProvider>
          <IllustrationLayoutBuilder
            value={layout}
            onChange={(next) => {
              changes.push(next);
              setLayout(next);
            }}
          />
        </I18nProvider>
      );
    }

    act(() => root.render(<Harness />));
    expect(host.querySelectorAll(".gl-illustration-dimension-pill")).toHaveLength(3);
    const files = host.querySelector<HTMLSelectElement>('[aria-label="Place FCS files"]')!;
    act(() => {
      files.value = "columns";
      files.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({
      rows: ["populations"], columns: ["channels", "files"], overlay: [],
    });

    const channels = host.querySelector<HTMLSelectElement>('[aria-label="Place Channels"]')!;
    expect(channels.querySelector<HTMLOptionElement>('option[value="overlay"]')?.disabled).toBe(true);
  });
});
