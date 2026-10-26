// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NamedTailoredGate } from "../reports/tailoringReport";
import { TailoredGatesModal } from "./TailoredGatesModal";

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

const base = { gateName: "Cells", xChannel: "x", yChannel: "y", fileIds: [] as string[] };
const rows: NamedTailoredGate[] = [
  { ...base, treeId: "cD1", gateId: "g1", owner: { kind: "file", fileId: "f1" }, ownerName: "D1.fcs", fileNames: ["D1.fcs"],
    follows: { kind: "tree" }, shift: { kind: "moved", dx: 0.5, dy: -1200, reshaped: true, space: "display" }, reason: "Shifted" },
  { ...base, treeId: "cgA", gateId: "g2", owner: { kind: "group", groupId: "gA", name: "Group A" }, ownerName: "Group A", fileNames: ["D2.fcs", "D3.fcs"],
    follows: { kind: "tree" }, shift: { kind: "reshaped", why: "bound opened or closed" }, reason: "" },
];

describe("TailoredGatesModal", () => {
  it("lays out each version with its shift and edits its reason", () => {
    const onReasonChange = vi.fn();
    act(() => root.render(
      <TailoredGatesModal rows={rows} labelOf={(c) => c.toUpperCase()} onReasonChange={onReasonChange} onExportCsv={() => {}} onClose={() => {}} />,
    ));
    const cells = [...host.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].slice(0, 4).map((td) => td.textContent));
    expect(cells).toEqual([
      ["D1.fcs", "Cells", "the tree", "X +0.5, Y -1,200 · reshaped (display units)"],
      ["Group A (2 files)", "Cells", "the tree", "reshaped: bound opened or closed"],
    ]);
    const reason = host.querySelectorAll<HTMLInputElement>("input.gl-tailored-reason")[1];
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Low counts");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onReasonChange).toHaveBeenCalledWith("cgA", "g2", "Low counts");
  });
});
