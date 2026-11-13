// A "Recording Name" row straight after a population table, with no blank line between, starts a
// new recording: each recording keeps its own id and populations.
import { describe, expect, it } from "vitest";
import { parseChorusStatistics } from "./chorusStatistics";

const CSV = [
  "Experiment Name,synthetic panel",
  "Export Date,02/01/2026 10:30:00",
  "",
  "Recording Name,D1",
  "Recording Id,00000000-0000-0000-0000-000000000002",
  "",
  "Population,Events,Percent Parent,Percent Total",
  "All Events,1000,NaN,100",
  "Cells,800,80,80",
  "Recording Name,D2",
  "Recording Id,00000000-0000-0000-0000-000000000003",
  "Population,Events,Percent Parent,Percent Total",
  "All Events,500,NaN,100",
  "Cells,400,80,80",
  "",
].join("\r\n");

describe("parseChorusStatistics with no blank line before a Recording Name row", () => {
  it("starts a new recording", () => {
    const stats = parseChorusStatistics(CSV);
    expect(stats.recordings.map((r) => [r.name, r.id, r.populations.map((p) => p.events)])).toEqual([
      ["D1", "00000000-0000-0000-0000-000000000002", [1000, 800]],
      ["D2", "00000000-0000-0000-0000-000000000003", [500, 400]],
    ]);
  });

  it("does not read a numeric recording name as a population", () => {
    const stats = parseChorusStatistics(CSV.replace("Recording Name,D2", "Recording Name,2"));
    expect(stats.recordings.map((r) => r.name)).toEqual(["D1", "2"]);
    expect(stats.recordings[0].populations.map((p) => p.name)).toEqual(["All Events", "Cells"]);
  });
});
