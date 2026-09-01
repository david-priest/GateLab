import { describe, expect, it } from "vitest";
import { workspaceConflictFrom } from "./workspaceContract";

// The parser is the gate between "an error string" and "a conflict this browser may resync from",
// so it has to be strict: resyncing to a revision read out of a malformed payload would move the
// browser to a number the SCE never reported.
describe("workspaceConflictFrom", () => {
  const data = { expectedRevision: 14, currentRevision: 15, writerId: "writer-a" };

  it("reads a well-formed conflict, writer id included", () => {
    expect(workspaceConflictFrom("workspace-revision-conflict", data)).toEqual(data);
  });

  it("ignores errors that are not revision conflicts", () => {
    expect(workspaceConflictFrom(undefined, data)).toBeNull();
    expect(workspaceConflictFrom("some-other-failure", data)).toBeNull();
  });

  it("omits the writer id when the stored write predates writer ids", () => {
    const conflict = workspaceConflictFrom("workspace-revision-conflict", {
      expectedRevision: 14,
      currentRevision: 15,
    });
    // Present, but unattributable -- so the caller cannot mistake it for its own write.
    expect(conflict).toEqual({ expectedRevision: 14, currentRevision: 15 });
    expect(conflict?.writerId).toBeUndefined();
  });

  it("refuses a payload whose revisions are missing or unusable", () => {
    for (const bad of [
      undefined,
      null,
      "15",
      { currentRevision: 15 },
      { expectedRevision: 14 },
      { expectedRevision: 14, currentRevision: "15" },
      { expectedRevision: 14, currentRevision: 15.5 },
      { expectedRevision: 14, currentRevision: -1 },
      { expectedRevision: 14, currentRevision: Number.NaN },
    ]) {
      expect(workspaceConflictFrom("workspace-revision-conflict", bad)).toBeNull();
    }
  });
})
