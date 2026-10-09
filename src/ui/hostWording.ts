// hostWording.ts — the app's words for a host whose samples are not files.
//
// The text is written for FCS files ("Lock scales between files", "12 files pooled"). In
// GateLabR the same lists hold the samples of a SingleCellExperiment, and there it should say
// samples. As platformKeys.ts does for the names of keys, this rewrites the words where they
// are shown, so a sentence written later for files is covered without being listed here.
//
// What it leaves alone: a sentence about a real file whatever the host (a format, an export, a
// picker), and a sentence that already tells files from samples (the FlowJo and FACSChorus
// import dialogs), where swapping the word would make the two the same.

export type HostWording = "files" | "samples";

let wording: HostWording = "files";

/** Set once, where the app is mounted with its host. */
export function setHostWording(next: HostWording): void {
  wording = next;
}

export function hostWording(): HostWording {
  return wording;
}

/** A sentence about real files, in any host: formats, exports, pickers, FCS keywords. */
const ABOUT_REAL_FILES = new RegExp([
  "\\.wsp", "\\.cef", "\\.gatelab", "\\.fcs\\b", "\\.xml", "\\.csv", "\\bCSV\\b", "\\bTSV\\b", "Gating-?ML", "FlowJo",
  "FACSChorus", "FACSDiva", "FACSDiscover", "Cytobank", "\\bzip\\b", "\\bPDF\\b", "\\bSVG\\b", "\\bPNG\\b",
  "FCS export", "Export FCS", "into one FCS", "picker", "folder", "upload", "download", "\\$P", "keyword",
  "Reopen", "Open an FCS", "filename cannot", "template",
].join("|"), "i");
const NAMES_FILES = /\bfiles?\b|\bfilenames?\b|\bFCS\b/i;
const NAMES_SAMPLES = /\bsamples?\b/i;
/** A placeholder, which is a name and not a word of the sentence: {file}, {files}, {meta:column}. */
const PLACEHOLDER = /(\{[A-Za-z0-9_:]+\})/;

/**
 * Sentences the rules below would leave or get wrong, with what the samples host shows. `ja` is
 * given where the Japanese cannot be had by the same swap of one word.
 */
const SENTENCES: Readonly<Record<string, Readonly<{ en: string; ja?: string }>>> = {
  "Files / samples": { en: "Samples", ja: "サンプル" },
  "files / samples": { en: "samples", ja: "サンプル" },
  "Order files / samples": { en: "Order samples" },
  "Find file / sample…": { en: "Find sample…" },
  "Find figure files or samples": { en: "Find figure samples" },
  "Loaded FCS samples": { en: "Loaded samples", ja: "読み込み済みサンプル" },
  "File (filename)": { en: "Sample", ja: "サンプル" },
  "Each entry is an FCS file, not necessarily one biological sample. The figure's selection is independent of the Gating tab's.": {
    en: "Each entry is a sample of the object. The figure's selection is independent of the Gating tab's.",
  },
  "Draw every event of the plot's files rather than a sample of them; a plot of a million points repaints slowly. Counts and percentages always use every event.": {
    en: "Draw every event of the plot's samples rather than a subset of them; a plot of a million points repaints slowly. Counts and percentages always use every event.",
  },
  "Build a file / sample comparison": { en: "Build a sample comparison" },
  "File / sample comparison": { en: "Sample comparison" },
  "This page has more than 256 panels. Move Files / samples or Populations to Pages in Arrange, or select fewer items.": {
    en: "This page has more than 256 panels. Move Samples or Populations to Pages in Arrange, or select fewer items.",
  },
  "Channel ($PnN)": { en: "Channel", ja: "チャンネル" },
  "Marker ($PnS)": { en: "Marker", ja: "マーカー" },
  "Rename the display name (marker) for each channel. The FCS channel id ($PnN) is fixed. Scatter, Time/QC and imaging-feature channels are locked. Renames apply to every loaded sample and are cosmetic — gates and statistics are unaffected. Download the template to edit display names in Excel, then upload it here; omitted channels remain unchanged.": {
    en: "Rename the display name (marker) for each channel. The channel's own name in the object is fixed. Renames apply to every sample and are cosmetic — gates and statistics are unaffected. Download the template to edit display names in Excel, then upload it here; omitted channels remain unchanged.",
  },
  "Axis and picker names throughout the app. The detector comes from $PnN, which is kept even when the channel's identity is just the marker. Renaming a channel here always overrides this.": {
    en: "Axis and picker names throughout the app. The detector is the channel's own name in the object, which is kept even when the channel's identity is just the marker. Renaming a channel here always overrides this.",
  },
  "Sample ID (sample_id) is editable and saved with the workspace. It defaults to the filename; filenames are read-only. Import CSV/TSV using filename as the first column and sample_id plus any condition fields after it. Metadata drives Plotting groups, replicate units and facets.": {
    en: "Sample ID (sample_id) is editable and saved with the workspace. It defaults to the sample's name in the object, which is read-only. Import CSV/TSV with that name in the first column, headed filename as in the template, and sample_id plus any condition fields after it. Metadata drives Plotting groups, replicate units and facets.",
  },
  // Gates an FCS file carries from its instrument: about files, and never on offer for an object.
  "Import gates recorded in the loaded files…": { en: "Import gates recorded in the loaded files…" },
  // The FCS export writes files; what it reads them from are the samples.
  "Export {count} files": { en: "Export {count} files" },
  "Events are concatenated into one file. Source-file identity is not retained.": { en: "Events are concatenated into one file. Source-sample identity is not retained." },
  "{populations} pooled population files from {files} checked files": { en: "{populations} pooled population files from {files} checked samples" },
  "Checked files, kept separate — {count} files": { en: "Checked samples, kept separate — {count} files" },
  "A value of 0 skips empty outputs. This filter only affects separate-file export; pooled data are never filtered this way.": {
    en: "A value of 0 skips empty outputs. This filter only affects separate-file export; pooled data are never filtered this way.",
  },
};

function words(text: string): string {
  return text
    .replace(/\b(A|a)n FCS file\b/g, "$1 sample")
    .replace(/\bFCS files\b/g, "samples")
    .replace(/\bFCS file\b/g, "sample")
    .replace(/\bfilenames\b/g, "sample names")
    .replace(/\bfilename\b/g, "sample name")
    .replace(/\bFilename\b/g, "Sample name")
    .replace(/\bFiles\b/g, "Samples")
    .replace(/\bfiles\b/g, "samples")
    .replace(/\bFile\b/g, "Sample")
    .replace(/\bfile\b/g, "sample");
}

/**
 * The sentence as the samples host shows it, or null where it is shown as written. Given the
 * source text with its placeholders, before they are filled, so that a sample named "file 2"
 * keeps its name.
 */
export function samplesSentence(source: string): Readonly<{ en: string; ja?: string }> | null {
  const listed = SENTENCES[source];
  if (listed) return listed.en === source && !listed.ja ? null : listed;
  if (!NAMES_FILES.test(source) || ABOUT_REAL_FILES.test(source) || NAMES_SAMPLES.test(source)) return null;
  const en = source
    .replace(/\} FCS\b/g, "} samples")
    .split(PLACEHOLDER)
    .map((part) => (PLACEHOLDER.test(part) ? part : words(part)))
    .join("");
  return en === source ? null : { en };
}

/** For text built outside the translation function: the sentence in this host's words. */
export function hostWords(source: string): string {
  return wording === "samples" ? samplesSentence(source)?.en ?? source : source;
}

/** The Japanese of a sentence samplesSentence() rewrote: the same swap, of the one word. */
export function samplesJapanese(japanese: string): string {
  return japanese
    .replace(/\} ?FCS(?![A-Za-z])/g, "}サンプル")
    .split(PLACEHOLDER)
    .map((part) => (PLACEHOLDER.test(part) ? part : part.replace(/FCSファイル/g, "サンプル").replace(/ファイル/g, "サンプル")))
    .join("");
}
