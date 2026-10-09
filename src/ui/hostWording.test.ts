// In GateLabR the app's lists hold an object's samples, and its text says "samples" where it
// was written for files. These pin the sentences GateLabR showed with "file", "FCS" or "$Pn"
// in them on 2026-10-09, each with what it shows now, and the kinds of sentence left as written.
import { afterEach, describe, expect, it } from "vitest";
import { hostWords, samplesSentence, setHostWording } from "./hostWording";
import { translateUi } from "./i18n";

afterEach(() => setHostWording("files"));

const REWORDED: readonly (readonly [string, string])[] = [
  ["Files / samples", "Samples"],
  ["Lock scales between files", "Lock scales between samples"],
  ["{count} files pooled", "{count} samples pooled"],
  ["{count} files · all following", "{count} samples · all following"],
  ["the tree · all files", "the tree · all samples"],
  ["pooled · {count} FCS", "pooled · {count} samples"],
  ["Pooled counts: {count} FCS · selected display: {contributing} contribute", "Pooled counts: {count} samples · selected display: {contributing} contribute"],
  ["{contributing} of {checked} files contribute", "{contributing} of {checked} samples contribute"],
  ["{count} plotted files", "{count} plotted samples"],
  ["Editing the tree · every file follows, tailored gates excepted", "Editing the tree · every sample follows, tailored gates excepted"],
  ["One tree, tailored per file.", "One tree, tailored per sample."],
  ["Revert all files…", "Revert all samples…"],
  ["Revert {count} selected files…", "Revert {count} selected samples…"],
  ["Moving a gate tailors it for this file alone; the tree and the other files keep theirs.", "Moving a gate tailors it for this sample alone; the tree and the other samples keep theirs."],
  ["The tree's gates apply to every pooled file; these are not per-file tailored counts.", "The tree's gates apply to every pooled sample; these are not per-sample tailored counts."],
  ["Per-file Channel Scales", "Per-sample Channel Scales"],
  ["Population counts and statistics per file", "Population counts and statistics per sample"],
  ["File", "Sample"],
  ["File (filename)", "Sample"],
  ["Filename (read-only)", "Sample name (read-only)"],
  ["Once per file", "Once per sample"],
  ["File for new plots", "Sample for new plots"],
  ["Population · file", "Population · sample"],
  ["Files across columns", "Samples across columns"],
  ["Files down rows", "Samples down rows"],
  ["Overlay files", "Overlay samples"],
  ["Use checked files", "Use checked samples"],
  ["Show each file’s gates", "Show each sample’s gates"],
  ["Find file / sample…", "Find sample…"],
  ["Order files / samples", "Order samples"],
  ["Mixed-file panels omit gate outlines. Percentages in single-file panels are relative to the displayed population.", "Mixed-sample panels omit gate outlines. Percentages in single-sample panels are relative to the displayed population."],
  ["Events pooled · event-count weighting · gates and percentages pooled where the files' gates agree", "Events pooled · event-count weighting · gates and percentages pooled where the samples' gates agree"],
  ["Each entry is an FCS file, not necessarily one biological sample. The figure's selection is independent of the Gating tab's.", "Each entry is a sample of the object. The figure's selection is independent of the Gating tab's."],
  ["Loaded FCS samples", "Loaded samples"],
  ["Channel ($PnN)", "Channel"],
  ["Marker ($PnS)", "Marker"],
  // What the FCS export reads is the samples; what it writes is files.
  ["Checked files ({count})", "Checked samples ({count})"],
  ["{populations} pooled population files from {files} checked files", "{populations} pooled population files from {files} checked samples"],
];

const AS_WRITTEN: readonly string[] = [
  // Real files, whatever the host.
  "Export FCS…",
  "Export {count} files",
  "Import gates recorded in the loaded files…",
  "Write the loaded files and their gating trees as a FlowJo workspace (.wsp), in the layout FlowJo 10.10 writes, which FlowJo opens and BD FACSChorus imports sort gates from.",
  "The export is the page at its physical size; a grid of pages is written as one PDF page each, or one SVG or PNG file each in a zip. The data layer is drawn at the resolution above and anything beyond the pages is cut off.",
  "holds {characters}, which a filename cannot",
  // Sentences that tell a file from a sample: the import dialogs.
  "Which loaded file is each sample?",
  "Several files could be \"{sample}\": say which above, and its tree goes on that file.",
  // Nothing about files.
  "Return to single sample",
  "Pool selected samples ({count})",
];

describe("the words for a host whose samples are not files", () => {
  it("leaves every sentence as written in the browser app", () => {
    for (const [source] of REWORDED) expect(translateUi("en", source)).toBe(source);
    expect(hostWords("files")).toBe("files");
  });

  it("says samples where GateLabR said files", () => {
    setHostWording("samples");
    const shown = REWORDED.map(([source]) => [source, translateUi("en", source)]);
    expect(shown).toEqual(REWORDED.map(([source, expected]) => [source, expected]));
    expect(hostWords("files")).toBe("samples");
  });

  it("leaves a sentence about real files, or one that tells files from samples, as written", () => {
    setHostWording("samples");
    expect(AS_WRITTEN.filter((source) => translateUi("en", source) !== source)).toEqual([]);
    expect(AS_WRITTEN.map((source) => samplesSentence(source))).toEqual(AS_WRITTEN.map(() => null));
  });

  it("rewrites the sentence and never what is put into it", () => {
    setHostWording("samples");
    // A sample named "file 2" keeps its name; the {file} placeholder of a title keeps its spelling.
    expect(translateUi("en", "{count} files pooled", { count: 12 })).toBe("12 samples pooled");
    expect(translateUi("en", "Viewing: {name}", { name: "file 2" })).toBe("Viewing: file 2");
    expect(translateUi("en", "Not pooled, different panel: {files}", { files: "file A, file B" })).toBe("Not pooled, different panel: file A, file B");
    expect(samplesSentence("One page per file, titled {file}")?.en).toBe("One page per sample, titled {file}");
  });

  it("makes the same change in Japanese", () => {
    setHostWording("samples");
    expect(translateUi("ja", "Files / samples")).toBe("サンプル");
    expect(translateUi("ja", "Pooled view · {count} files", { count: 3 })).toBe("プール表示 · 3サンプル");
    const japanese = REWORDED.map(([source]) => translateUi("ja", source)).filter((text) => /ファイル/.test(text));
    expect(japanese).toEqual([
      // Files the export writes.
      translateUi("ja", "{populations} pooled population files from {files} checked files"),
    ].filter((text) => /ファイル/.test(text)));
    setHostWording("files");
    expect(translateUi("ja", "Pooled view · {count} files", { count: 3 })).toBe("プール表示 · 3ファイル");
  });
});
