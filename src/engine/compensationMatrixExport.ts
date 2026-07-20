import type { CompensationMatrixInput } from "./compensationProfile";

export type CompensationMatrixExportVariant = "installed" | "working";

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizedAxis(
  channels: readonly string[],
  label: "source" | "receiver",
): readonly string[] {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error(`The ${label} channel axis is empty.`);
  }
  const normalized = channels.map((channel, index) => {
    if (typeof channel !== "string" || channel.trim().length === 0) {
      throw new Error(`The ${label} channel at position ${index + 1} is blank or invalid.`);
    }
    return channel.trim().normalize("NFC");
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`The ${label} channel axis contains duplicate identities.`);
  }
  return normalized;
}

/**
 * Export a source-row / receiver-column spill matrix as an ordinary numeric CSV.
 * `String(number)` is intentional: it is JavaScript's shortest round-trip-safe
 * representation, so the export never inherits the UI's rounded percentages.
 */
export function serializeCompensationMatrixCsv(
  input: CompensationMatrixInput,
): string {
  const sourceChannels = normalizedAxis(input.sourceChannels, "source");
  const receiverChannels = normalizedAxis(input.receiverChannels, "receiver");
  if (!Array.isArray(input.matrix) || input.matrix.length !== sourceChannels.length) {
    throw new Error("The spill matrix row count does not match its source channel axis.");
  }

  const lines = [
    ["channel", ...receiverChannels].map(csvField).join(","),
  ];
  input.matrix.forEach((row, sourceIndex) => {
    if (!Array.isArray(row) || row.length !== receiverChannels.length) {
      throw new Error(
        `Spill matrix row ${sourceIndex + 1} does not match the receiver channel axis.`,
      );
    }
    const coefficients = row.map((value, receiverIndex) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `Spill coefficient ${sourceChannels[sourceIndex]} → ${receiverChannels[receiverIndex]} is not finite.`,
        );
      }
      return Object.is(value, -0) ? "0" : String(value);
    });
    lines.push([csvField(sourceChannels[sourceIndex]), ...coefficients].join(","));
  });
  return `${lines.join("\n")}\n`;
}

export function compensationMatrixCsvFileName(
  label: string,
  variant: CompensationMatrixExportVariant = "installed",
): string {
  const stem = label
    .replace(/\.(?:csv|tsv|txt)$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 90) || "gatelab";
  const workingSuffix = variant === "working" ? "_working" : "";
  return `${stem}${workingSuffix}_spill_matrix.csv`;
}

export function compensationMatrixRImportSnippet(fileName: string): string {
  const safeFileName = fileName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    "spill <- as.matrix(read.csv(",
    `  "${safeFileName}",`,
    "  row.names = 1,",
    "  check.names = FALSE,",
    '  fileEncoding = "UTF-8"',
    "))",
    'storage.mode(spill) <- "double"',
  ].join("\n");
}
