// panelTable.ts — Excel-friendly bulk export/import for Panel display labels.
// Channel identity remains immutable: an import only stages cosmetic display-name updates.

export interface PanelTableChannel {
  readonly key: string;
  readonly pnn: string;
  readonly marker: string | null;
  readonly label: string;
  readonly renamable: boolean;
}

export interface PanelImportChange {
  readonly key: string;
  /** Empty resets the display name to the stable channel key. */
  readonly label: string;
  readonly previousLabel: string;
}

export interface PanelImportPreview {
  readonly changes: readonly PanelImportChange[];
  readonly rowCount: number;
  readonly matchedCount: number;
  readonly unchangedCount: number;
  readonly lockedIgnoredCount: number;
  readonly unknownIdentifiers: readonly string[];
  readonly omittedCount: number;
}

const PANEL_HEADERS = [
  "channel_pnn",
  "marker_pns",
  "display_name",
  "channel_key",
  "editable",
] as const;

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize the current panel as a UTF-8-BOM CSV that opens cleanly in Excel. */
export function serializePanelTemplate(channels: readonly PanelTableChannel[]): string {
  const records = [
    PANEL_HEADERS.join(","),
    ...channels.map((channel) => [
      channel.pnn,
      channel.marker ?? "",
      channel.label,
      channel.key,
      channel.renamable ? "yes" : "no",
    ].map(escapeCsvCell).join(",")),
  ];
  return `\uFEFF${records.join("\r\n")}\r\n`;
}

function detectDelimiter(text: string): "," | "\t" {
  let commas = 0;
  let tabs = 0;
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && (character === "\r" || character === "\n")) break;
    if (!quoted && character === ",") commas++;
    if (!quoted && character === "\t") tabs++;
  }
  if (commas === 0 && tabs === 0) {
    throw new Error("Panel import needs a comma- or tab-delimited header row.");
  }
  return tabs > commas ? "\t" : ",";
}

function readDelimitedRecords(text: string, delimiter: "," | "\t"): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const finishCell = () => {
    record.push(cell.trim());
    cell = "";
  };
  const finishRecord = () => {
    finishCell();
    if (record.some((value) => value.length > 0)) records.push(record);
    record = [];
  };

  for (let i = start; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      finishCell();
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && text[i + 1] === "\n") i++;
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Panel import contains an unterminated quoted field.");
  if (cell.length > 0 || record.length > 0) finishRecord();
  return records;
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\$pnn/g, "pnn")
    .replace(/\$pns/g, "pns")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function headerIndex(headers: readonly string[], aliases: readonly string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

/**
 * Parse an edited template without mutating the Sample. Rows resolve by GateLab key first and
 * unique $PnN second; omitted rows are deliberately left unchanged.
 */
export function parsePanelImport(
  text: string,
  channels: readonly PanelTableChannel[],
): PanelImportPreview {
  if (text.trim().length === 0) throw new Error("Panel import file is empty.");
  const records = readDelimitedRecords(text, detectDelimiter(text));
  if (records.length < 2) throw new Error("Panel import file has no channel rows.");

  const headers = records[0].map(normalizeHeader);
  const keyColumn = headerIndex(headers, ["channel_key", "gatelab_channel_key", "key"]);
  const pnnColumn = headerIndex(headers, ["channel_pnn", "pnn", "channel_id"]);
  const labelColumn = headerIndex(headers, ["display_name", "display", "label"]);
  if (labelColumn < 0) throw new Error("Panel import needs a display_name column.");
  if (keyColumn < 0 && pnnColumn < 0) {
    throw new Error("Panel import needs a channel_key or channel_pnn column.");
  }

  const byKey = new Map(channels.map((channel) => [channel.key, channel]));
  const pnnCounts = new Map<string, number>();
  for (const channel of channels) pnnCounts.set(channel.pnn, (pnnCounts.get(channel.pnn) ?? 0) + 1);
  const byPnn = new Map(
    channels
      .filter((channel) => pnnCounts.get(channel.pnn) === 1)
      .map((channel) => [channel.pnn, channel]),
  );

  const changes: PanelImportChange[] = [];
  const unknownIdentifiers: string[] = [];
  const seen = new Set<string>();
  let matchedCount = 0;
  let unchangedCount = 0;
  let lockedIgnoredCount = 0;
  let rowCount = 0;

  for (const cells of records.slice(1)) {
    const key = keyColumn >= 0 ? (cells[keyColumn] ?? "").trim() : "";
    const pnn = pnnColumn >= 0 ? (cells[pnnColumn] ?? "").trim() : "";
    if (!key && !pnn && !(cells[labelColumn] ?? "").trim()) continue;
    rowCount++;

    const channel = (key ? byKey.get(key) : undefined) ?? (pnn ? byPnn.get(pnn) : undefined);
    if (!channel) {
      unknownIdentifiers.push(key || pnn || `row ${rowCount + 1}`);
      continue;
    }
    if (seen.has(channel.key)) {
      throw new Error(`Panel import contains duplicate rows for channel "${channel.key}".`);
    }
    seen.add(channel.key);
    matchedCount++;

    const requestedLabel = (cells[labelColumn] ?? "").trim();
    const requestedDisplay = requestedLabel || channel.key;
    const currentDisplay = channel.label.trim() || channel.key;
    if (requestedDisplay === currentDisplay) {
      unchangedCount++;
    } else if (!channel.renamable) {
      lockedIgnoredCount++;
    } else {
      changes.push({ key: channel.key, label: requestedLabel, previousLabel: currentDisplay });
    }
  }

  if (rowCount === 0) throw new Error("Panel import file has no channel rows.");
  return {
    changes,
    rowCount,
    matchedCount,
    unchangedCount,
    lockedIgnoredCount,
    unknownIdentifiers,
    omittedCount: channels.length - seen.size,
  };
}
