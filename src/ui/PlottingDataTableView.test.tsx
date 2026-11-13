// @vitest-environment jsdom
// The table behind a Plotting chart, shown under it: built only while its fold is open, the CSV's
// rows cell for cell, copied as tab-separated text. Synthetic files D1 and D2, groups control and
// treated; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasUiTranslation, I18nProvider } from "./i18n";
import { plottingDataTableCsv, type PlottingDataTable } from "./plottingData";
import { numericColumns, plottingDataTableTsv, PLOTTING_TABLE_MAX_ROWS, PlottingDataTableView } from "./PlottingDataTableView";
import { clearPersistedTabState } from "./tabState";
import { setHostWording } from "./hostWording";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clearPersistedTabState();
  setHostWording("files");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setHostWording("files");
});

const TABLE: PlottingDataTable = {
  header: ["File", "condition", "Population", "Count", "Percent (stacked bar)"],
  rows: [
    ["D1.fcs", "control", "CD4_positive", 2, "40"],
    ["D2.fcs", "treated", "CD4_positive", 3, ""],
  ],
};

function render(build: () => PlottingDataTable, onDownloadCsv = () => {}) {
  act(() =>
    root.render(
      <I18nProvider>
        <PlottingDataTableView build={build} onDownloadCsv={onDownloadCsv} />
      </I18nProvider>,
    ),
  );
}

function openFold() {
  const details = host.querySelector("details")!;
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("PlottingDataTableView", () => {
  it.each([
    ["files", undefined, "File", "Files"],
    ["samples", "SingleCellExperiment", "Sample", "Samples"],
    ["samples", "GatingSet", "Sample", "Samples"],
  ] as const)("uses %s wording for %s table headers while preserving data and downloads", (wording, object, singular, plural) => {
    setHostWording(wording, object);
    const table: PlottingDataTable = {
      header: ["File", "Files", "File", "Files", "Count"],
      fileColumns: [0, 1],
      rows: [["File D1", 2, "control", "treated", 4]],
      comparisons: { header: ["File", "Files", "p"], rows: [["File D1", 2, "0.5"]] },
    };
    const original = JSON.stringify(table);
    const csv = plottingDataTableCsv(table), tsv = plottingDataTableTsv(table);
    render(() => table);
    openFold();
    const headings = [...host.querySelectorAll("thead")].map((head) => [...head.querySelectorAll("th")].map((cell) => cell.textContent));
    expect(headings).toEqual([[singular, plural, "File", "Files", "Count"], ["File", "Files", "p"]]);
    expect([...host.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent)))
      .toEqual([["File D1", "2", "control", "treated", "4"], ["File D1", "2", "0.5"]]);
    expect(JSON.stringify(table)).toBe(original);
    expect(plottingDataTableCsv(table)).toBe(csv);
    expect(plottingDataTableTsv(table)).toBe(tsv);
  });

  it("builds nothing while the fold is closed, which it is by default", () => {
    const build = vi.fn(() => TABLE);
    render(build);
    expect(host.querySelector("details")!.open).toBe(false);
    expect(host.textContent).toContain("Data behind this chart");
    expect(host.querySelector("table")).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it("shows the CSV's fields, cell for cell, once opened, and stays open for the session", () => {
    const build = vi.fn(() => TABLE);
    render(build);
    openFold();
    expect(build).toHaveBeenCalledTimes(1);
    const shown = [...host.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th, td")].map((cell) => cell.textContent));
    const csv = plottingDataTableCsv(TABLE).trim().split("\r\n").map((line) => line.split(","));
    expect(shown).toEqual(csv);
    // Count and Percent hold numbers only and are right-aligned; the text columns are not.
    expect(numericColumns(TABLE)).toEqual([false, false, false, true, true]);
    expect(host.querySelector("td.is-number")!.textContent).toBe("2");
    // The tab unmounts and mounts again: the fold opens as it was left.
    act(() => root.unmount());
    root = createRoot(host);
    render(build);
    expect(host.querySelector("details")!.open).toBe(true);
    expect(host.querySelector("table")).not.toBeNull();
  });

  it("copies the table as tab-separated text, and downloads the CSV from the button beside it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onDownloadCsv = vi.fn();
    render(() => TABLE, onDownloadCsv);
    openFold();
    await act(async () => button("Copy").click());
    expect(writeText).toHaveBeenCalledWith(
      "File\tcondition\tPopulation\tCount\tPercent (stacked bar)\nD1.fcs\tcontrol\tCD4_positive\t2\t40\nD2.fcs\ttreated\tCD4_positive\t3\t\n",
    );
    expect(host.textContent).toContain("Copied");
    act(() => button("Data (CSV)").click());
    expect(onDownloadCsv).toHaveBeenCalledTimes(1);
  });

  it("keeps a tab or line break inside a field from splitting the copied row", () => {
    expect(plottingDataTableTsv({ header: ["Population"], rows: [["CD4\tpositive\nB1"]] })).toBe("Population\nCD4 positive B1\n");
  });

  it("draws the first 2,000 rows of a longer table and says the CSV has all of them", () => {
    const rows = Array.from({ length: PLOTTING_TABLE_MAX_ROWS + 5 }, (_, i) => [`D${i + 1}.fcs`, i]);
    render(() => ({ header: ["File", "Count"], rows }));
    openFold();
    expect(host.querySelectorAll("tbody tr")).toHaveLength(PLOTTING_TABLE_MAX_ROWS);
    expect(host.textContent).toContain("The first 2000 of 2005 rows are shown; the CSV has all of them.");
  });

  it("has Japanese for each of its strings", () => {
    for (const key of [
      "Data behind this chart",
      "Copy",
      "Copied",
      "Data (CSV)",
      "The table as tab-separated text, for pasting into a spreadsheet",
      "The first {shown} of {count} rows are shown; the CSV has all of them.",
    ]) expect(hasUiTranslation("ja", key), key).toBe(true);
  });
});
