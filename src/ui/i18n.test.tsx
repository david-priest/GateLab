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

  it("translates the tailored gate's tag, its menu, its confirmation and the pooled view's note", () => {
    const keys = [
      "this file",
      "+1 version",
      "+{count} versions",
      "No pooled file follows the tree's {gates} (grey).",
      "Solid: {file}'s version, which a drag edits; dashed:",
      "Switch on to tailor {gate} for {file}: its next drag changes {file} only.",
      "follows {group}",
      "{gate} is tailored for {file}: a drag changes {file} only. Switch off to take {target}'s coordinates again.",
      "{gate} is tailored for {file}: a drag changes {file} only. Undo is available.",
      "{gate} on {owner} takes {target}'s coordinates again; its own are dropped. Undo brings them back.",
      "Switch off this gate's tailoring?",
      "Switch off",
      "The next drag of {gate} tailors it for {owner}; other gates keep their scope",
      "{gate} has coordinates of its own for {owner} now. Undo is available.",
      "1 file",
      "1 file tailored",
      "{count} files tailored",
      "Keep following {source}",
      "Renames the four populations of every quadrant gate; the names shown in the Create quadrant gate dialog.",
      "Tailor for {name}",
      "Tailored in {names}. This file follows the tree's; click to tailor it here.",
      "The next drag of this gate changes {name} only; the tree and the other files keep theirs.",
      "The next drag of {gate} tailors it for {owner}; the other files keep theirs.",
      "The next drag tailors this gate for {owner}. Click to withdraw it.",
      "This file uses {owner}'s own coordinates for the gate; a drag changes them. Click to revert them or use them for {target}.",
      "Use {name}'s for {target}…",
      "Use {name}'s gates for {target}…",
      "Withdraw the tailoring asked for: the next drag goes where it went before.",
      "{count} files · {grouped} tailored by groups",
      "{count} files · {tailored} tailored, {grouped} by groups",
      "{gate} · the tree's · the next drag tailors it for {file}",
      "{gate} · the tree's · the next drag tailors it for {group}",
      "{name}: {scope}",
      "{target} takes every gate's coordinates from {name}, and every file following it follows again, its own tailoring dropped. Undo is available.",
      "{name} (1 file)",
      "{name} ({count} files)",
      "Show tailoring",
      "Show the dashed outline of the version a tailored gate would revert to, or of the versions pooled files use instead of the tree's, and the mark on a tailored gate's label. Hiding them changes nothing that is drawn solid, counted or edited.",
      "{gate} · {owner}'s own, {target}'s dashed · a drag changes {owner} only",
      "{gate} · {owner}'s own, {target}'s dashed · a drag changes {owner} and the files following it",
      "{gate} · the tree's · a drag changes the tree and every file following it",
      "{gate} · {source}'s · a drag tailors it for {file} only",
      "{gate} · {group}'s · a drag changes {group} and the files following it",
      "{gate} · the tree's · a drag changes the tree; {files} keep their own (dashed)",
      "{gate} · the tree's · a drag changes the tree; {files} keeps its own (dashed)",
      "Pooled · the tree's gates · a drag changes the tree and every file following it",
      "The tree's gates · a drag changes the tree and every file following it",
      "Tagged gates are {owners}'s own ({target}'s dashed) · a drag of one changes {owners} only, of any other the tree",
      "Editing {file} only · a drag tailors a gate for {file} alone",
      "Editing {group} · a drag changes {group} and the files following it",
      "Orange tag: a gate's own coordinates here. Click it to revert them to {target} or use them for {target}.",
      "This file's own coordinates for the gate; what it follows is dashed. Click to revert them or use them for the tree.",
      "{group}'s own coordinates for the gate; what it follows is dashed. Click to revert them or use them for the tree.",
      "Tailored: these coordinates are {owner}'s own and no longer follow the tree. Click to revert them or use them for the tree.",
      "Tailored for {owner}: {name}",
      "Revert to {target}",
      "Use for {target}\u2026",
      "{gate} on {owner} follows {target} again. Undo is available.",
      "{target} takes {owner}'s {gate}; the files that followed it follow the new coordinates. Undo is available.",
      "Use these coordinates for the tree?",
      "Use these coordinates for the group?",
      "Use for the tree",
      "Use for the group",
      "{target} takes {owner}'s coordinates for {gate}, and every file that followed its {gate} follows the new ones. Files that tailor {gate} keep their own. Undo brings it back.",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  it("has Japanese for the side panel's pane and row menus, its plot display controls and the file-list groups", () => {
    const keys = [
      "Align gates",
      "Always draw gates that belong to no population. Such a gate is in no branch, so branch scoping would otherwise hide it whenever it is not selected or ticked.",
      "Bulk edit via CSV…",
      "Clear selection",
      "Click to select; Shift-click to change, exclude (NOT), or remove",
      "Delete {count} selected…",
      "Delete selected gate…",
      "Delete the highlighted gates",
      "Delete…",
      "Draw only the gates belonging to the displayed branch — the gates on the current population and its descendants, or, once a gate is selected, that gate's own sub-branch. Unchecked draws every gate sharing the plot's channels, which is how thresholds set on different branches are compared.",
      "Duplicate {count} selected",
      "Edit active population…",
      "Events in {population}",
      "Hide the files in {name}",
      "Line the gate badges up in one column after the longest population name. Unchecked, each row's badges follow its own name.",
      "No group",
      "Plot shows",
      "Plot shows:",
      "Proposed by {source}…",
      "Rename selected gate…",
      "Rename…",
      "Show the files in {name}",
      "Sort A→Z",
      "Tailored for the file in view.",
      "Tailored in {names}.",
      "Unlock structure to delete gates",
      "Unlock structure to rename gates",
      "branch gates",
      "unowned gates",
      "{name}: actions",
      "{name}: actions; it was proposed",
      "{title} actions",
      "The tree is called {name}.",
      "also here: {names} · switch or delete from the Populations ⋯ menu",
      "The selected files join it and follow the tree's gates. To tailor a gate for every file in the group, choose Tailor for the group from the gate's ⋯ menu, then drag it.",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  it("has Japanese for editing groups in the file list", () => {
    const keys = [
      "Add to {name}",
      "Another colour",
      "Collapse",
      "Colour of {name}",
      "Colour…",
      "Delete group…",
      "Double-click to rename; drag to reorder; drop files here to move them in",
      "Drop files here to take them out of their group",
      "Drop the tailoring of {names}: every gate takes the coordinates it follows again.",
      "Expand",
      "New group from this file…",
      "Remove from group",
      "Rename {name}",
      "Revert {count} files to what they follow",
      "Select its files",
      "The group goes; its files move to No group, each keeping its own tailoring.",
      "{name}: group actions",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  it("has Japanese for group tailoring made visible", () => {
    const keys = [
      "Select the files of {group}",
      "Tailor for this file",
      "The next drag of {gate} tailors it for {group}. Click to tailor it for {file} alone instead.",
      "{file} takes a version of its own: a drag changes {file} only.",
      "{file} · in {group}",
      "{gate} uses {group}'s version: a drag changes every file in {group}. Click to tailor it for {file} alone.",
      "{name}: tailor for…",
    ];
    expect(keys.filter((key) => !hasUiTranslation("ja", key))).toEqual([]);
  });

  it("has Japanese for the Gating tab's strips: Gate settings, the plot type, the gate menus and the notes chip", () => {
    const keys = [
      "Acts on this plot's axes: show {gate}'s channels to use it",
      "Close gaps between the selected gates",
      "Close gaps with neighbours",
      "Colouring",
      "Each side of the gate moves outward until it meets another gate's edge, landing on it, or reaches the plot's edge where nothing is in the way, so nothing at the edges is missed",
      "Extend to edges",
      "Files whose panel differs from {name} are not pooled with it: the same channel name can carry a different marker between panels, so a shared name is not a shared measurement. Uncheck them, or check them alone.",
      "Gate settings",
      "Move the facing edges of the highlighted gates onto shared lines, so they touch with no gap and no overlap",
      "Move the facing edges of this gate and its neighbours onto one shared line, so they touch with no gap and no overlap",
      "No neighbouring gate edges were close enough to join.",
      "Plot type",
      "Point opacity and size, density colour, how many events to draw, colouring, and the plot's font sizes",
      "Show the notes",
      "Where new gates are drawn, how gate edges are drawn, snapping, and which gates the plot shows",
      "coloured",
      "n = gates tailored for that file",
      "{count} checked file(s) not pooled — different panel",
      "{count} events · {contributing} of {checked} files contribute · axes from {name}",
      "{count} export notes",
      "{count} import notes",
      "{gate} already touches its neighbours and the plot's edges.",
      "{gate} · the next drag tailors it for this file",
      "{gate} · the next drag tailors it for {group}",
      "{gate} · the tree's version · a drag changes every file following it",
      "{gate} · this file's version · a drag changes this file",
      "{gate} · {group}'s version · a drag changes {group}'s files",
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
      "This sample holds several independent strategies. GateLab holds one at a time, so importing them together would merge trees the workspace keeps apart.",
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
