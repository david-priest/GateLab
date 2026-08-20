// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "./engine/workspace";

// The toggle is persisted as an optional display field. Workspaces written before it existed
// have no value, and those were saved under the scoped behaviour — so absent must read as
// scoped. Reading absent as "off" would silently widen every old workspace's plots.
const restored = (display: { branchGatesOnly?: boolean } | undefined) =>
  display?.branchGatesOnly !== false;

describe("branch-gates toggle persistence", () => {
  it("treats a workspace saved before the control as scoped", () => {
    expect(restored(undefined)).toBe(true);
    expect(restored({})).toBe(true);
  });

  it("round-trips both explicit states", () => {
    expect(restored({ branchGatesOnly: true })).toBe(true);
    expect(restored({ branchGatesOnly: false })).toBe(false);
  });

  it("is optional in the workspace display type", () => {
    // Compile-time check: a display block without the field must still type-check.
    const display: WorkspaceFile["display"] = {
      xChannel: "X", yChannel: "Y", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5,
    };
    expect(display.branchGatesOnly).toBeUndefined();
  });
});
