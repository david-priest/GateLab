// @vitest-environment jsdom
// The question an agent's save puts to the user: what it names, and that only Save says yes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentSaveConfirm } from "./AgentSaveConfirm";
import { I18nProvider } from "../ui/i18n";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text);

describe("AgentSaveConfirm", () => {
  it("names the copy, the path and the agent, and writes only on Save", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(<AgentSaveConfirm request={{ kind: "portable", target: "/data/D1.gatelab", overwrite: false }} writer="claude" busy={false} onSave={onSave} onCancel={onCancel} />));
    const dialog = host.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("Save a copy for claude?");
    expect(dialog.textContent).toContain("claude asks to save a portable copy of this workspace, holding the workspace and every FCS file, to:");
    expect(dialog.textContent).toContain("/data/D1.gatelab");
    expect(dialog.textContent).not.toContain("replaces it");
    expect(onSave).not.toHaveBeenCalled();
    act(() => button("Save")!.click());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("says when a file will be replaced; Cancel, Escape and a click outside decline", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(<AgentSaveConfirm request={{ kind: "linked", target: "/data/D1.gatelab", overwrite: true }} writer="claude" busy={false} onSave={onSave} onCancel={onCancel} />));
    expect(host.textContent).toContain("linked copy of this workspace, which finds its FCS files by name");
    expect(host.querySelector("[role=alert]")!.textContent).toBe("A file is there already; saving replaces it.");
    act(() => button("Cancel")!.click());
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    act(() => { host.querySelector(".gl-modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("holds both buttons while the copy is written", () => {
    const onCancel = vi.fn();
    act(() => root.render(<AgentSaveConfirm request={{ kind: "linked", target: "/data/D1.gatelab", overwrite: false }} writer="claude" busy onSave={vi.fn()} onCancel={onCancel} />));
    expect(button("Saving…")!.disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("is translated into Japanese", () => {
    localStorage.setItem("gatelab.uiLanguage", "ja");
    act(() => root.render(<I18nProvider><AgentSaveConfirm request={{ kind: "portable", target: "/data/D1.gatelab", overwrite: true }} writer="claude" busy={false} onSave={vi.fn()} onCancel={vi.fn()} /></I18nProvider>));
    expect(host.querySelector("[role=dialog]")!.getAttribute("aria-label")).toBe("claudeのためにコピーを保存しますか？");
    expect(host.textContent).toContain("ポータブルコピー");
    expect(host.textContent).toContain("置き換えられます");
    expect(button("保存")).toBeTruthy();
  });
});
