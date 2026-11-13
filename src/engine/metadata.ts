// metadata.ts — per-sample metadata. GateLab has no SCE colData; instead each loaded FCS Sample
// carries a free-form set of metadata fields (condition, donor, timepoint, …) supplied by an
// imported CSV/TSV table joined on FCS filename, and editable in the Metadata tab. These per-SAMPLE
// values become the Group / Unit / Facet grouping variables in the Proportions tab (broadcast to
// every event of the sample at plot time), mirroring GateLabR's per-event colData factors.

export interface MetadataColumn {
  name: string;
  /** Explicit categorical level order (for ordered factors / stable colours). Undefined → natural. */
  levels?: string[];
}

const VALUE_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Metadata values in the order a reader expects: day 0, 7, 14 rather than 0, 14, 7, and case set aside. */
export function compareMetadataValues(a: string, b: string): number {
  return VALUE_COLLATOR.compare(a, b);
}

/** A human label, never the immutable UUID used for data, gates and figure references. */
export const SAMPLE_ID_FIELD = "sample_id";
export function sampleDisplayId(fileName: string, fields?: Record<string, string>): string {
  return fields?.[SAMPLE_ID_FIELD]?.trim() || fileName;
}

export interface ParsedMetadata {
  /** Header of the first (join-key) column. */
  fileNameColumn: string;
  /** Field column names (everything after the first column). */
  columns: string[];
  /** filename-as-written → { field: value }. */
  byFileName: Record<string, Record<string, string>>;
  rowCount: number;
}

/** Split one delimited line into fields, honouring double-quoted fields (RFC-4180-ish). */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Split the table text into records at line breaks outside a quoted cell, so a quoted cell that
 * holds a line break (a spreadsheet cell with Alt-Enter) stays inside its row. A cell is quoted
 * only when the quote opens it; a quote further into a cell (5" dish) does not join the rows after.
 */
function splitRecords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let cellStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '""';
        i++;
      } else {
        if (c === '"') inQuotes = false;
        cur += c;
      }
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      out.push(cur);
      cur = "";
      cellStart = true;
    } else {
      if (c === '"' && cellStart) inQuotes = true;
      cellStart = c === "," || c === "\t" || (cellStart && c === " ");
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a CSV or TSV metadata table. First column = FCS file name (the join key); the remaining
 * columns are metadata fields. Delimiter auto-detected (tab if the header has more tabs than commas).
 */
export function parseMetadataTable(text: string): ParsedMetadata {
  const lines = splitRecords(text).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Metadata file is empty.");
  const header0 = lines[0];
  const delim = (header0.match(/\t/g)?.length ?? 0) > (header0.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const header = splitLine(header0, delim);
  if (header.length < 2) throw new Error("Metadata table needs a filename column plus at least one field column.");
  const fileNameColumn = header[0];
  const columns = header.slice(1).map((h, i) => h || `col${i + 1}`);
  const byFileName: Record<string, Record<string, string>> = {};
  let rowCount = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r], delim);
    const key = cells[0];
    if (!key) continue;
    const row: Record<string, string> = {};
    columns.forEach((col, i) => {
      row[col] = cells[i + 1] ?? "";
    });
    byFileName[key] = row;
    rowCount++;
  }
  return { fileNameColumn, columns, byFileName, rowCount };
}

/**
 * Strip a trailing .fcs and lowercase, for tolerant filename matching. Only that extension: with
 * whatever followed the last dot removed, a row named "S1.d7" lost its ".d7", matched the file
 * S1.fcs and missed S1.d7.fcs.
 */
function normName(s: string): string {
  return s.trim().replace(/\.fcs$/i, "").trim().toLowerCase();
}

/**
 * Find the metadata row for a sample by its FCS filename: exact match first, then extension-
 * insensitive + case-insensitive. Returns null if no row matches.
 */
export function lookupMetadataRow(parsed: ParsedMetadata, sampleName: string): Record<string, string> | null {
  if (parsed.byFileName[sampleName]) return parsed.byFileName[sampleName];
  const target = normName(sampleName);
  for (const [fn, row] of Object.entries(parsed.byFileName)) {
    if (normName(fn) === target) return row;
  }
  return null;
}

/** Distinct non-empty values of a field across the metadata map, in first-seen order. */
export function distinctValues(metadata: Record<string, Record<string, string>>, field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of Object.values(metadata)) {
    const v = row[field];
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
