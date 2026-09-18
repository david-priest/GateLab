// @vitest-environment jsdom
// The "Groups from a metadata column" dialog: the column chosen, what it makes shown, confirmed.
// Synthetic columns and values; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupsFromMetadataModal, type MetadataGroupsPreview } from "./CrudModals";
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

describe("GroupsFromMetadataModal", () => {
  it("shows the groups a column makes, with existing groups marked, and confirms the column", () => {
    const previews: Record<string, MetadataGroupsPreview> = {
      condition: { groups: [{ value: "control", count: 3, existing: false }, { value: "treated", count: 2, existing: true }], unassigned: 1 },
      donor: { groups: [], unassigned: 6 },
    };
    const onConfirm = vi.fn();
    act(() => root.render(
      <I18nProvider>
        <GroupsFromMetadataModal columns={["condition", "donor"]} preview={(c) => previews[c]} onConfirm={onConfirm} onCancel={vi.fn()} />
      </I18nProvider>,
    ));
    expect(host.textContent).toContain("control · 3 files");
    expect(host.textContent).toContain("treated · 2 files");
    expect(host.textContent).toContain("into the group of that name");
    expect(host.textContent).toContain("1 files without a value stay as they are.");
    const button = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Make groups")!;
    expect(button().disabled).toBe(false);
    act(() => button().click());
    expect(onConfirm).toHaveBeenCalledWith("condition");
    const select = host.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "donor");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("No file has a value in this column.");
    expect(button().disabled).toBe(true);
  });
});
