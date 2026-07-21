import type { CompensationMatrixInput } from "./compensationProfile";

export type MatrixTableDelimiter = "csv" | "tsv";

export type MatrixTableParseCode =
  | "invalid-input"
  | "invalid-delimiter"
  | "empty-file"
  | "missing-delimiter"
  | "ambiguous-delimiter"
  | "malformed-quoted-field"
  | "missing-source-column"
  | "missing-receiver-columns"
  | "missing-data-rows"
  | "row-width"
  | "missing-source-channel"
  | "invalid-coefficient";

export class CompensationMatrixTableError extends Error {
  readonly code: MatrixTableParseCode;
  readonly row?: number;
  readonly column?: number;

  constructor(
    code: MatrixTableParseCode,
    message: string,
    location: { readonly row?: number; readonly column?: number } = {},
  ) {
    super(message);
    this.name = "CompensationMatrixTableError";
    this.code = code;
    this.row = location.row;
    this.column = location.column;
  }
}

export interface ParsedCompensationMatrixTable {
  readonly input: CompensationMatrixInput;
  readonly format: {
    readonly delimiter: MatrixTableDelimiter;
    /** Original spelling, retained for import preview and provenance. */
    readonly sourceColumnHeader: string;
  };
}

export interface CompensationMatrixTableOptions {
  readonly delimiter?: "auto" | MatrixTableDelimiter;
}

interface ParsedRecord {
  readonly cells: string[];
  readonly row: number;
}

const DECIMAL_TOKEN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function normalizeIdentity(value: string): string {
  return value.trim().normalize("NFC");
}

function isSourceColumnHeader(value: string): boolean {
  const normalized = normalizeIdentity(value).toLowerCase();
  return (
    normalized === "" ||
    normalized === "x" ||
    normalized === "row.names" ||
    normalized === "channel" ||
    normalized === "source"
  );
}

function delimiterCharacter(delimiter: MatrixTableDelimiter): "," | "\t" {
  return delimiter === "csv" ? "," : "\t";
}

function detectDelimiter(text: string): MatrixTableDelimiter {
  let commas = 0;
  let tabs = 0;
  let inQuotes = false;
  let sawNonWhitespace = false;
  let line = 1;

  const chooseDelimiter = (): MatrixTableDelimiter => {
    if (commas > 0 && tabs > 0) {
      throw new CompensationMatrixTableError(
        "ambiguous-delimiter",
        "The matrix header mixes comma and tab delimiters. Choose CSV or TSV explicitly.",
        { row: line },
      );
    }
    if (commas === 0 && tabs === 0) {
      throw new CompensationMatrixTableError(
        "missing-delimiter",
        "The matrix header must contain comma-separated or tab-separated columns.",
        { row: line },
      );
    }
    return tabs > 0 ? "tsv" : "csv";
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      sawNonWhitespace = true;
      if (inQuotes && text[index + 1] === '"') {
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) continue;
    if (character === ",") {
      commas++;
      sawNonWhitespace = true;
    } else if (character === "\t") {
      tabs++;
      sawNonWhitespace = true;
    } else if (character === "\r" || character === "\n") {
      if (sawNonWhitespace) return chooseDelimiter();
      if (character === "\r" && text[index + 1] === "\n") index++;
      line++;
      commas = 0;
      tabs = 0;
    } else if (!/\s/.test(character)) {
      sawNonWhitespace = true;
    }
  }

  return chooseDelimiter();
}

function readDelimitedRecords(text: string, delimiter: "," | "\t"): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let line = 1;
  let recordStartLine = 1;

  const pushField = () => {
    cells.push(field);
    field = "";
    quoteClosed = false;
  };
  const pushRecord = () => {
    pushField();
    records.push({ cells, row: recordStartLine });
    cells = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && text[index + 1] === "\n") index++;
        field += "\n";
        line++;
      } else {
        field += character;
      }
      continue;
    }

    if (quoteClosed) {
      if (character === delimiter) {
        pushField();
      } else if (character === "\r" || character === "\n") {
        pushRecord();
        if (character === "\r" && text[index + 1] === "\n") index++;
        line++;
        recordStartLine = line;
      } else if (character !== " ") {
        throw new CompensationMatrixTableError(
          "malformed-quoted-field",
          "Unexpected text follows a closing quote in the compensation matrix.",
          { row: line, column: cells.length + 1 },
        );
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw new CompensationMatrixTableError(
          "malformed-quoted-field",
          "A quoted matrix field must begin with a quote.",
          { row: line, column: cells.length + 1 },
        );
      }
      inQuotes = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === "\r" || character === "\n") {
      pushRecord();
      if (character === "\r" && text[index + 1] === "\n") index++;
      line++;
      recordStartLine = line;
    } else {
      field += character;
    }
  }

  if (inQuotes) {
    throw new CompensationMatrixTableError(
      "malformed-quoted-field",
      "The compensation matrix contains an unclosed quoted field.",
      { row: recordStartLine, column: cells.length + 1 },
    );
  }
  if (field.length > 0 || cells.length > 0 || quoteClosed) pushRecord();

  return records.filter(
    ({ cells: recordCells }) =>
      !(recordCells.length === 1 && recordCells[0].trim().length === 0),
  );
}

function parseCoefficient(token: string, row: number, column: number): number {
  const trimmed = token.trim();
  if (!DECIMAL_TOKEN.test(trimmed)) {
    throw new CompensationMatrixTableError(
      "invalid-coefficient",
      `Matrix coefficient at row ${row}, column ${column} is not a finite decimal number.`,
      { row, column },
    );
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new CompensationMatrixTableError(
      "invalid-coefficient",
      `Matrix coefficient at row ${row}, column ${column} is outside the finite numeric range.`,
      { row, column },
    );
  }
  return value;
}

function freezeInput(
  sourceChannels: string[],
  receiverChannels: string[],
  matrix: number[][],
): CompensationMatrixInput {
  return Object.freeze({
    sourceChannels: Object.freeze(Array.from(sourceChannels)),
    receiverChannels: Object.freeze(Array.from(receiverChannels)),
    matrix: Object.freeze(matrix.map((row) => Object.freeze(Array.from(row)))),
  });
}

/**
 * Parse a named CSV/TSV spillover matrix without guessing channel identity or
 * changing coefficient scale. Scientific modality/range/diagonal validation is
 * deliberately owned by validateAndCanonicalizeCompensationMatrix().
 */
export function parseCompensationMatrixTable(
  rawText: string,
  options: CompensationMatrixTableOptions = {},
): ParsedCompensationMatrixTable {
  if (typeof rawText !== "string") {
    throw new CompensationMatrixTableError(
      "invalid-input",
      "The compensation matrix contents must be text.",
    );
  }
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  if (text.trim().length === 0) {
    throw new CompensationMatrixTableError("empty-file", "The compensation matrix file is empty.");
  }

  const runtimeDelimiter = (options as unknown as Record<string, unknown>)?.delimiter;
  if (
    runtimeDelimiter !== undefined &&
    runtimeDelimiter !== "auto" &&
    runtimeDelimiter !== "csv" &&
    runtimeDelimiter !== "tsv"
  ) {
    throw new CompensationMatrixTableError(
      "invalid-delimiter",
      "The compensation matrix delimiter must be auto, csv, or tsv.",
    );
  }
  const requestedDelimiter = runtimeDelimiter ?? "auto";
  const delimiter = requestedDelimiter === "auto" ? detectDelimiter(text) : requestedDelimiter;
  const records = readDelimitedRecords(text, delimiterCharacter(delimiter));
  if (records.length === 0) {
    throw new CompensationMatrixTableError("empty-file", "The compensation matrix file is empty.");
  }

  const header = records[0];
  if (header.cells.length < 2) {
    throw new CompensationMatrixTableError(
      "missing-receiver-columns",
      "The matrix header needs a source-channel column and at least one receiver channel.",
      { row: header.row },
    );
  }
  const sourceColumnHeader = header.cells[0];
  if (!isSourceColumnHeader(sourceColumnHeader)) {
    throw new CompensationMatrixTableError(
      "missing-source-column",
      "The first column must identify source channels (blank, X, row.names, channel, or source).",
      { row: header.row, column: 1 },
    );
  }
  if (records.length < 2) {
    throw new CompensationMatrixTableError(
      "missing-data-rows",
      "The compensation matrix does not contain any source-channel rows.",
      { row: header.row + 1 },
    );
  }

  const receiverChannels = header.cells.slice(1).map(normalizeIdentity);
  const sourceChannels: string[] = [];
  const matrix: number[][] = [];
  for (const record of records.slice(1)) {
    if (record.cells.length !== header.cells.length) {
      throw new CompensationMatrixTableError(
        "row-width",
        `Matrix row ${record.row} has ${record.cells.length} columns; expected ${header.cells.length}.`,
        { row: record.row },
      );
    }
    const sourceChannel = normalizeIdentity(record.cells[0]);
    if (sourceChannel.length === 0) {
      throw new CompensationMatrixTableError(
        "missing-source-channel",
        `Matrix row ${record.row} has no source-channel identity.`,
        { row: record.row, column: 1 },
      );
    }
    sourceChannels.push(sourceChannel);
    matrix.push(
      record.cells
        .slice(1)
        .map((token, index) => parseCoefficient(token, record.row, index + 2)),
    );
  }

  return Object.freeze({
    input: freezeInput(sourceChannels, receiverChannels, matrix),
    format: Object.freeze({ delimiter, sourceColumnHeader }),
  });
}

/** Deliberate orientation change for import preview; never called automatically. */
export function transposeCompensationMatrixInput(
  input: CompensationMatrixInput,
): CompensationMatrixInput {
  const invalid = () => {
    throw new Error(
      "Cannot transpose a compensation matrix unless its named axes, dimensions, and coefficients are valid.",
    );
  };
  if (input == null || typeof input !== "object") invalid();
  const candidate = input as unknown as Record<string, unknown>;
  if (
    !Array.isArray(candidate.sourceChannels) ||
    !Array.isArray(candidate.receiverChannels) ||
    !Array.isArray(candidate.matrix)
  ) {
    invalid();
  }
  const sourceCandidates = candidate.sourceChannels as unknown[];
  const receiverCandidates = candidate.receiverChannels as unknown[];
  const rowCandidates = candidate.matrix as unknown[];
  if (
    sourceCandidates.some((channel) => typeof channel !== "string") ||
    receiverCandidates.some((channel) => typeof channel !== "string") ||
    rowCandidates.length !== sourceCandidates.length ||
    rowCandidates.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== receiverCandidates.length ||
        row.some((value) => typeof value !== "number" || !Number.isFinite(value)),
    )
  ) {
    invalid();
  }
  const sourceChannels = sourceCandidates as string[];
  const receiverChannels = receiverCandidates as string[];
  const matrix = rowCandidates as number[][];
  const transposed = receiverChannels.map((_, column) =>
    sourceChannels.map((_, row) => matrix[row][column]),
  );
  return freezeInput(
    Array.from(receiverChannels),
    Array.from(sourceChannels),
    transposed,
  );
}
