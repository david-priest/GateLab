// @vitest-environment jsdom
// The Statistics tab's CSV is read by R and Python, so it is written to RFC 4180: records end in
// CRLF, and a field holding a comma, a double quote or a line break is enclosed in double quotes
// with each quote doubled; one with white space at either end is quoted too, for R's header
// reader. Names below are synthetic.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "../engine/fcs";
import type { Population } from "../engine/models";
import { Sample } from "../engine/sample";
import { initialCoreState, recompute } from "../store";
import { clearPersistedTabState } from "./tabState";
import { StatsTab } from "./StatsTab";

/** A strict RFC 4180 reader: anything the grammar does not allow is an error, not a guess. */
function parseRfc4180(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const atRecordEnd = () => text.startsWith("\r\n", i);
  for (;;) {
    let field = "";
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) throw new Error("unterminated quoted field");
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        field += text[i++];
      }
      if (i < text.length && text[i] !== "," && !atRecordEnd()) {
        throw new Error(`text after a closing quote at offset ${i}: ${JSON.stringify(text.slice(i, i + 12))}`);
      }
    } else {
      while (i < text.length && text[i] !== "," && !atRecordEnd()) {
        if (text[i] === '"' || text[i] === "\r" || text[i] === "\n") {
          throw new Error(`${JSON.stringify(text[i])} inside an unquoted field at offset ${i}`);
        }
        field += text[i++];
      }
    }
    record.push(field);
    if (text[i] === ",") { i += 1; continue; }
    records.push(record);
    record = [];
    if (atRecordEnd()) i += 2;
    if (i >= text.length) return records;
  }
}

const SAMPLE_NAMES = ['D1, "left".fcs', " D2.fcs "];
const POPULATION_NAMES = ['CD4 "naive", memory', "B cells\r\nCD19+", "plain"];

function flowSample(): Sample {
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [Float32Array.from([100, 200, 300, 400]), Float32Array.from([10, 20, 30, 40])],
    spillover: null,
  };
  return new Sample(fcs);
}

function population(id: string, name: string, parent: string | null, children: string[]): Population {
  return {
    population_id: id, name, gate_refs: [], gate_logic: "and", parent_id: parent, children,
    event_count: 4, percent_of_parent: 100,
  };
}

let root: Root;
let host: HTMLDivElement;
let clipboard: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clipboard = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => { clipboard.push(text); } } });
  clearPersistedTabState();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearPersistedTabState();
  vi.unstubAllGlobals();
});

async function copiedCsv(): Promise<string> {
  const copy = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Copy CSV")!;
  await act(async () => { copy.click(); });
  return clipboard.at(-1)!;
}

describe("Statistics CSV", () => {
  const samples = SAMPLE_NAMES.map((name, index) => ({ id: `s${index}`, name, sample: flowSample() }));
  const state = {
    ...initialCoreState(),
    populations: {
      root: population("root", "All Events", null, ["p1", "p2", "p3"]),
      p1: population("p1", POPULATION_NAMES[0], "root", []),
      p2: population("p2", POPULATION_NAMES[1], "root", []),
      p3: population("p3", POPULATION_NAMES[2], "root", []),
    },
    root_population_id: "root",
    active_population_id: "root",
  };
  const render = () => act(() => root.render(
    <StatsTab
      samples={samples}
      activeSampleId="s0"
      state={state}
      derived={recompute(samples[0].sample, state)}
      defaultChannels={[samples[0].sample.channels[1].key]}
      dataRevisionKey="0"
    />,
  ));

  it("writes one file's table as RFC 4180, names intact", async () => {
    render();
    const csv = await copiedCsv();
    const records = parseRfc4180(csv);
    expect(csv.endsWith("\r\n")).toBe(true);
    const width = records[0].length;
    expect(records.every((r) => r.length === width)).toBe(true);
    expect(records[0].slice(0, 4)).toEqual(["Population", "Count", "% Parent", "% Total"]);
    expect(records.slice(1).map((r) => r[0])).toEqual(["All Events", ...POPULATION_NAMES]);
    expect(records[1][1]).toBe("4");
  });

  it("writes the all-samples comparison as RFC 4180, sample names intact", async () => {
    render();
    const selector = host.querySelector<HTMLSelectElement>(".gl-stats-opt-group select")!;
    act(() => {
      selector.value = "__all__";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const csv = await copiedCsv();
    const records = parseRfc4180(csv);
    expect(records[0]).toEqual(["Population", ...SAMPLE_NAMES]);
    // Quoted, or R's read.csv strips the spaces from the header it reads the sample names from.
    expect(csv.split("\r\n")[0]).toContain('," D2.fcs "');
    expect(records.slice(1).map((r) => r[0])).toEqual(["All Events", ...POPULATION_NAMES]);
    expect(records.every((r) => r.length === SAMPLE_NAMES.length + 1)).toBe(true);
  });
});
