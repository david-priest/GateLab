// A quoted metadata cell that holds a line break is one cell of one row: the break is kept in the
// value, and the cells after it stay in the same row.
import { describe, expect, it } from "vitest";
import { parseMetadataTable } from "./metadata";

describe("parseMetadataTable with a line break inside a quoted cell", () => {
  it("keeps the cell whole with CRLF row ends", () => {
    const parsed = parseMetadataTable('file,note,condition\r\nS1.fcs,"day 7\r\nboost",D1\r\nS2.fcs,day 14,D2\r\n');
    expect(parsed.rowCount).toBe(2);
    expect(Object.keys(parsed.byFileName).sort()).toEqual(["S1.fcs", "S2.fcs"]);
    expect(parsed.byFileName["S1.fcs"]).toEqual({ note: "day 7\r\nboost", condition: "D1" });
    expect(parsed.byFileName["S2.fcs"]).toEqual({ note: "day 14", condition: "D2" });
  });

  it("keeps the cell whole with LF row ends and an escaped quote in the cell", () => {
    const parsed = parseMetadataTable('file,note\nS1.fcs,"say ""hi""\nagain"\nS2.fcs,plain\n');
    expect(parsed.rowCount).toBe(2);
    expect(parsed.byFileName["S1.fcs"]).toEqual({ note: 'say "hi"\nagain' });
    expect(parsed.byFileName["S2.fcs"]).toEqual({ note: "plain" });
  });

  it("does not join rows after a quote that stands inside an unquoted cell", () => {
    const parsed = parseMetadataTable('file,note\nS1.fcs,5" dish\nS2.fcs,plain\n');
    expect(parsed.rowCount).toBe(2);
    expect(Object.keys(parsed.byFileName).sort()).toEqual(["S1.fcs", "S2.fcs"]);
    expect(parsed.byFileName["S2.fcs"]).toEqual({ note: "plain" });
  });
});
