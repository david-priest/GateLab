import { describe, expect, it } from "vitest";
import { branchScopedGateOrder } from "./branchGates";

/**
 * Ticking a gate in the Gates list forces it onto the plot even when branch scoping would hide
 * it. The case that motivated this: a trial gate belonging to no population cannot be shown at
 * all under branch scoping, because there is no branch to place it in.
 *
 * The merge is done in App, so this pins the property it depends on -- that branch scoping really
 * does omit such a gate -- and the ordering rule the merge has to preserve.
 */
describe("gates outside the displayed branch", () => {
  const gates = {
    g_root: { gate_id: "g_root", x_channel: "SSC-W", y_channel: "SSC-A" },
    g_child: { gate_id: "g_child", x_channel: "SSC-W", y_channel: "SSC-A" },
    g_orphan: { gate_id: "g_orphan", x_channel: "SSC-W", y_channel: "SSC-A" },
  } as never;
  const populations = {
    root: { population_id: "root", parent_id: null, gate_refs: [] },
    p1: { population_id: "p1", parent_id: "root", gate_refs: [{ gate_id: "g_root" }] },
    p2: { population_id: "p2", parent_id: "p1", gate_refs: [{ gate_id: "g_child" }] },
  } as never;
  const order = ["g_root", "g_child", "g_orphan"];

  it("omits a gate that defines no population", () => {
    // If this ever stops being true the force-show has nothing to fix.
    const scoped = branchScopedGateOrder(populations, gates, order, "root", "root", null);
    expect(scoped).not.toContain("g_orphan");
  });

  it("the merge keeps the canonical order rather than appending", () => {
    // Ticking a gate must not reorder the ones already drawn, so the merge filters the full order
    // instead of concatenating. Mirrors the expression in App.
    const scoped = branchScopedGateOrder(populations, gates, order, "root", "root", null);
    const ticked = ["g_orphan"];
    const shown = new Set(scoped);
    const merged = order.filter((id) => shown.has(id) || ticked.includes(id));
    expect(merged).toEqual(order.filter((id) => shown.has(id) || id === "g_orphan"));
    expect(merged.indexOf("g_orphan")).toBe(merged.length - 1);
    // ...and every previously shown gate keeps its place.
    expect(merged.filter((id) => shown.has(id))).toEqual(scoped.filter((id) => order.includes(id)));
  });
});
