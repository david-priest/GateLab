// @vitest-environment jsdom
// The "Revert workspace" dialog: checkpoints listed by age and reason, one chosen, reverted.
// Synthetic workspace content; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceCheckpoint } from "../engine/workspaceHistory";
import { WorkspaceHistoryModal } from "./WorkspaceHistoryModal";
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

function checkpoint(id: string, reason: WorkspaceCheckpoint["reason"], minutesAgo: number, gates = 2): WorkspaceCheckpoint {
  return {
    id,
    workspaceId: "w1",
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    reason,
    workspace: {} as WorkspaceCheckpoint["workspace"],
    summary: { samples: 3, gates, populations: gates + 1, bytes: 1000 },
  };
}

describe("WorkspaceHistoryModal", () => {
  it("lists checkpoints by age and reason, marks the one as opened, and reverts to the chosen one", () => {
    const list = [checkpoint("c1", "automatic", 2, 5), checkpoint("c2", "after-workspace-open", 12, 2), checkpoint("c3", "after-workspace-open", 300, 2)];
    const onRevert = vi.fn();
    act(() => root.render(
      <I18nProvider>
        <WorkspaceHistoryModal checkpoints={list} loading={false} onRevert={onRevert} onCancel={vi.fn()} />
      </I18nProvider>,
    ));
    const rows = [...host.querySelectorAll<HTMLElement>(".gl-modal-history-list label")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "2 min agoAutomatic3 files · 5 gates · 6 populations",
      "12 min agoAs opened · the workspace as it was opened3 files · 2 gates · 3 populations",
      "5 h agoAs opened3 files · 2 gates · 3 populations",
    ]);
    const button = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Revert to this checkpoint")!;
    expect(button().disabled).toBe(true);
    act(() => { rows[1].querySelector("input")!.click(); });
    expect(rows[1].classList.contains("is-chosen")).toBe(true);
    expect(button().disabled).toBe(false);
    act(() => button().click());
    expect(onRevert).toHaveBeenCalledWith(list[1]);
  });

  it("says when checkpoints are being read and when there are none", () => {
    act(() => root.render(
      <I18nProvider>
        <WorkspaceHistoryModal checkpoints={[]} loading onRevert={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>,
    ));
    expect(host.textContent).toContain("Reading checkpoints…");
    act(() => root.render(
      <I18nProvider>
        <WorkspaceHistoryModal checkpoints={[]} loading={false} onRevert={vi.fn()} onCancel={vi.fn()} />
      </I18nProvider>,
    ));
    expect(host.textContent).toContain("No checkpoints yet for this workspace.");
  });
});
