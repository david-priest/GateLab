// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translateUi, useI18n, type UiLanguage } from "./i18n";

function Probe() {
  const { language, setLanguage, t } = useI18n();
  return (
    <label>
      {t("Language")}
      <select
        aria-label="language"
        value={language}
        onChange={(event) => setLanguage(event.currentTarget.value as UiLanguage)}
      >
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
      <span>{t("Open Workspace…")}</span>
    </label>
  );
}

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
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("GateLab UI localization", () => {
  it("falls back to the English source for untranslated scientific text", () => {
    expect(translateUi("ja", "CD19-A")).toBe("CD19-A");
    expect(translateUi("ja", "Samples")).toBe("サンプル");
    expect(translateUi("ja", "Per-channel z-score")).toBe("チャンネルごとのzスコア");
    expect(translateUi(
      "ja",
      "{scale} needs at least two populations to have a within-channel range. With one population every cell collapses to a single flat value, giving an uninformative row. Switch to unscaled transformed expression, or add another population.",
      { scale: "チャンネルごと（0–1）" },
    )).toContain("チャンネルごと（0–1）");
  });

  it("switches to Japanese, persists the choice, and updates the document language", () => {
    act(() => root.render(<I18nProvider><Probe /></I18nProvider>));
    const selector = host.querySelector("select")!;
    expect(host.textContent).toContain("Open Workspace…");
    act(() => {
      selector.value = "ja";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("ワークスペースを開く…");
    expect(window.localStorage.getItem("gatelab.uiLanguage")).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");
  });
});
