// Two files of one name in two folders, one spelled NFC and one NFD, are the same name to the
// user, and are offered as ambiguous as a pair spelled identically is.
import { describe, expect, it } from "vitest";
import { planWorkspaceFcsRelink } from "./workspaceRelink";

const nfc = "S1_\u00e9.fcs";
const nfd = "S1_e\u0301.fcs";

describe("relink of a name held by two folders", () => {
  it("identical spelling: ambiguous", () => {
    const plan = planWorkspaceFcsRelink([{ dataPath: "data/0.fcs", fileName: nfc }], [
      { name: nfc, relativePath: `D1/${nfc}` }, { name: nfc, relativePath: `D2/${nfc}` },
    ]);
    expect(plan.ambiguous.length).toBe(1);
  });
  it("NFC vs NFD spelling: also ambiguous", () => {
    const plan = planWorkspaceFcsRelink([{ dataPath: "data/0.fcs", fileName: nfc }], [
      { name: nfd, relativePath: `D1/${nfd}` }, { name: nfc, relativePath: `D2/${nfc}` },
    ]);
    expect(plan.ambiguous.length).toBe(1);
  });
});
