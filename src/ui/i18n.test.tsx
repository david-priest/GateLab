// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUiTranslation, I18nProvider, translateUi, useI18n, type UiLanguage } from "./i18n";
import { describeAgreement, type IdentityComparison } from "../engine/fileIdentity";

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

  // The open dialogs named two samples of one name "D1.fcs (position 2)" in Japanese too.
  it("translates the words the FlowJo, FACSDiva and FACSChorus import dialogs tell samples and files apart by", () => {
    const keys = [
      "position",
      "Each of these {count} files gets its own tube's tree, as in the experiment: one tree, tailored per file where they differ: {files}.",
      "Each of these {count} files gets the tree it was recorded under, as in the experiment: one tree, tailored per file where they differ: {files}.",
      "Merged, only {file}'s tree is imported, and the other files' are not; files already tailored keep their tailoring. Replace the current strategy to give each of the {count} files its own tube's tree.",
      "Merged, only {file}'s tree is imported, and the other files' are not; files already tailored keep their tailoring. Replace the current strategy to give each of the {count} files the tree it was recorded under.",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  // The release candidate's browser verifier found the Japanese UI's "Revert workspace…", the
  // FlowJo open dialog's first sentence and its "Choose FCS files…" still in English; the rest of
  // those two dialogs was English too.
  it("translates the Revert workspace dialog and the FlowJo open dialog", () => {
    const keys = [
      "Revert workspace…",
      "Revert workspace",
      "GateLab keeps checkpoints of this workspace in this browser: as it was opened, every two minutes while it changes, and before anything destructive. Choose one to go back to. The current state is kept as a checkpoint first, so a revert can itself be reverted.",
      "Reading checkpoints…",
      "No checkpoints yet for this workspace.",
      "Checkpoints",
      "the workspace as it was opened",
      "{samples} files · {gates} gates · {populations} populations",
      "Revert to this checkpoint",
      "Open FlowJo workspace",
      "A workspace holds gates, not data. Choose the FCS files it refers to; any it cannot find are skipped.",
      "found",
      "not found",
      "already open",
      "One shared hierarchy will be imported, so choose the sample whose strategy it should use.",
      "Also in the workspace, with no gates: loaded unselected for actions. Pooling is an explicit action above the plot.",
      "Choose FCS files…",
      "The FCS for the selected strategy has not been found yet",
      "Checking the workspace's compensation…",
      "Choose a sample from the workspace",
      "unreadable",
      "Choose a gating strategy",
      "This sample holds several independent strategies. GateLab holds one at a time, so importing them together would merge trees FlowJo kept apart.",
      "The workspace's — {name}. This is the compensation in force when the gates were drawn.",
      "The file's — the matrix stored in the FCS, typically the one recorded at acquisition.",
      "These gates were drawn on compensated data and this file carries no spillover matrix, so the workspace's \"{name}\" will be applied to {n} channel(s).",
      "The workspace's spillover matrix \"{name}\" matches the one in this file; compensation will be enabled with it.",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  // The release candidate's browser verifier, in Japanese: each FlowJo open dialog row said
  // "confirmed by $TOT, $DATE, ..." in English, the import dialog said "a FlowJo workspaceから...",
  // and its spillover-matrix sentence was English.
  // The gate-edge hint beside a transformed axis was English in the Japanese interface (the release
  // candidate's browser verifier).
  it("translates the hint that straight edges can look curved", () => {
    expect(hasUiTranslation("ja", "Straight edges can look curved here \u2014 gates are stored in raw values, so the curve is where the gate really falls. Gating is unchanged.")).toBe(true);
  });

  it("translates the open dialog's keyword agreement, the import dialog's source and its matrix notes", () => {
    const keys = [
      "confirmed by {keywords}",
      "agrees on {keywords} only, which does not confirm it",
      "no identity keyword to compare",
      "contradicted",
      "a FlowJo workspace",
      "a FACSChorus experiment",
      "a FACSDiva experiment",
      "a GateLab / GateLabR export",
      "a Cytobank Gating-ML file",
      "a Gating-ML file",
      "the Gating-ML file",
      "the FlowJo workspace",
      "The gate ({gates}) was drawn under Cytobank compensation {id}, which this file names but does not carry. To import them as drawn, load that matrix below. Evaluating them with this FCS file's own matrix instead places them on differently compensated data; choose it only knowing that.",
      "{count} gates ({gates}) were drawn under Cytobank compensation {id}, which this file names but does not carry. To import them as drawn, load that matrix below. Evaluating them with this FCS file's own matrix instead places them on differently compensated data; choose it only knowing that.",
      "This strategy was gated with the spillover matrix \"{label}\", which the file carries. Importing will apply it to {count} channel(s) and enable compensation; this FCS carries a different matrix of its own (coefficients differ by up to {delta}), which changes where every fluorescence gate falls.",
      "This strategy was gated with the spillover matrix \"{label}\", which the file carries. Importing will apply it to {count} channel(s) and enable compensation.",
      "The embedded spillover matrix exactly matches the loaded FCS; compensation is already enabled.",
      "This strategy was gated with FCS compensation enabled. Its exact matrix matches the loaded FCS, so importing will enable compensation.",
      "This strategy was gated without compensation, so importing will disable the current compensation setting.",
      "This strategy was gated without compensation; the current data are already uncompensated.",
      "This FCS and {source} each carry a spillover matrix, and they are not the same: coefficients differ by up to {delta}. The FCS's is typically the matrix recorded at acquisition; the one in {source} is the compensation in force when these gates were drawn. Compensation will be enabled either way, and which matrix is used changes where every fluorescence gate falls.",
      "The spillover matrix \"{label}\" from {source} matches the one in this FCS; importing will enable compensation with it.",
      "These gates were drawn on compensated data, and this FCS carries no spillover matrix. Importing will apply the matrix \"{label}\" from {source} to {count} channel(s) and enable compensation.",
      "{count} of its parameter(s) are not in this file ({names}) and were left out, which changes the result for the channels they spill into.",
      "Importing will disable the current compensation setting.",
      "This file declares FCS compensation but does not contain GateLab's exact matrix record. Import will use the spillover matrix embedded in the loaded FCS. Continue only if compensation was enabled when these gates were drawn.",
      "This file declares uncompensated dimensions, so importing will disable the current compensation setting.",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
    const ja = (source: string, values?: Record<string, string | number>) => translateUi("ja", source, values);
    const confirmed = describeAgreement({ verdict: "confirmed", agree: ["$TOT", "$DATE", "GUID"], differ: [] } as unknown as IdentityComparison, ja);
    expect(confirmed).toBe("$TOT, $DATE, GUIDで確認済み");
    expect(describeAgreement({ verdict: "confirmed", agree: ["$TOT"], differ: [] } as unknown as IdentityComparison)).toBe("confirmed by $TOT");
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
