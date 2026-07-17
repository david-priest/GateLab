import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "./workspace";
import {
  createWorkspaceCheckpoint,
  retainedWorkspaceCheckpointIds,
  workspaceCheckpointSignature,
  type WorkspaceCheckpoint,
} from "./workspaceHistory";

function workspace(): WorkspaceFile {
  return {
    format: "gatelab-workspace",
    version: 2,
    workspaceId: "lineage-1",
    savedAt: "2026-07-17T00:00:00.000Z",
    app: "GateLab",
    samples: [{
      fileName: "sample.fcs",
      dataPath: "data/0_sample.fcs",
      logicleW: {},
      compensationOn: false,
    }],
    activeSample: 0,
    gating: {
      gates: {
        g1: {
          gate_id: "g1",
          name: "Cells",
          gate_type: "rectangle",
          x_channel: "FSC-A",
          y_channel: "SSC-A",
          vertices: [[0, 0], [1, 1]],
          color: "#000000",
          label_offset: null,
        },
      },
      gate_order: ["g1"],
      populations: {
        root: {
          population_id: "root",
          name: "All Events",
          gate_refs: [],
          gate_logic: "and",
          parent_id: null,
          children: ["cells"],
          event_count: null,
          percent_of_parent: 100,
        },
        cells: {
          population_id: "cells",
          name: "Cells",
          gate_refs: [{ gate_id: "g1", include: true }],
          gate_logic: "and",
          parent_id: "root",
          children: [],
          event_count: null,
          percent_of_parent: null,
        },
      },
      root_population_id: "root",
      active_population_id: "cells",
      selected_gate_id: "g1",
    },
    scales: { globalScales: {} },
    display: {
      xChannel: "FSC-A",
      yChannel: "SSC-A",
      mode: "pseudocolor",
      maxEvents: 50000,
      contourThreshold: 5,
    },
  };
}

function checkpoint(id: string, createdAt: string): WorkspaceCheckpoint {
  return createWorkspaceCheckpoint("lineage-1", workspace(), "automatic", new Date(createdAt), id);
}

describe("browser-local workspace checkpoints", () => {
  it("snapshots lightweight workspace JSON without retaining mutable input or FCS bytes", () => {
    const ws = workspace();
    const saved = createWorkspaceCheckpoint(
      "lineage-1",
      ws,
      "before-gatingml-replace",
      new Date("2026-07-17T12:00:00.000Z"),
      "checkpoint-1",
    );

    ws.gating.gates.g1.name = "Changed later";
    expect(saved.workspace.gating.gates.g1.name).toBe("Cells");
    expect(saved.workspace.workspaceId).toBe("lineage-1");
    expect(saved.summary).toMatchObject({ samples: 1, gates: 1, populations: 2 });
    expect(saved.summary.bytes).toBeGreaterThan(0);
    expect("bytes" in (saved.workspace.samples[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("ignores savedAt for de-duplication but detects real workspace edits", () => {
    const a = workspace();
    const b = workspace();
    b.savedAt = "2026-07-17T12:00:00.000Z";
    expect(workspaceCheckpointSignature(a)).toBe(workspaceCheckpointSignature(b));

    b.gating.gates.g1.name = "Lymphocytes";
    expect(workspaceCheckpointSignature(a)).not.toBe(workspaceCheckpointSignature(b));
  });

  it("keeps all recent snapshots, then one per hour and one per day", () => {
    const now = Date.parse("2026-07-17T12:30:00.000Z");
    const checkpoints = [
      checkpoint("recent-new", "2026-07-17T12:25:00.000Z"),
      checkpoint("recent-old", "2026-07-17T11:00:00.000Z"),
      checkpoint("hour-09-new", "2026-07-17T09:20:00.000Z"),
      checkpoint("hour-09-old", "2026-07-17T09:10:00.000Z"),
      checkpoint("hour-08", "2026-07-17T08:20:00.000Z"),
      checkpoint("day-14-new", "2026-07-14T12:30:00.000Z"),
      checkpoint("day-14-old", "2026-07-14T11:30:00.000Z"),
      checkpoint("day-13", "2026-07-13T12:30:00.000Z"),
      checkpoint("expired", "2026-07-02T12:30:00.000Z"),
    ];

    expect([...retainedWorkspaceCheckpointIds(checkpoints, now)].sort()).toEqual([
      "day-13",
      "day-14-new",
      "hour-08",
      "hour-09-new",
      "recent-new",
      "recent-old",
    ]);
  });

  it("always keeps the newest dormant snapshot and enforces the hard per-workspace cap", () => {
    const now = Date.parse("2026-07-17T12:30:00.000Z");
    const dormant = [
      checkpoint("old-newest", "2026-06-27T12:30:00.000Z"),
      checkpoint("old-older", "2026-06-26T12:30:00.000Z"),
    ];
    expect([...retainedWorkspaceCheckpointIds(dormant, now)]).toEqual(["old-newest"]);

    const frequent = Array.from({ length: 300 }, (_, i) =>
      checkpoint(`frequent-${i}`, new Date(now - i * 20_000).toISOString()),
    );
    const kept = retainedWorkspaceCheckpointIds(frequent, now);
    expect(kept.size).toBe(256);
    expect(kept.has("frequent-0")).toBe(true);
    expect(kept.has("frequent-299")).toBe(false);
  });
});
