import type { Gate, GateRef, PopulationMap } from "./models";
import { populationTreeOrder } from "./populations";

export interface PopulationTableState {
  populations: PopulationMap;
  gates: Record<string, Gate>;
  rootPopulationId: string | null;
}

export interface PopulationBulkEditUpdate {
  popId: string;
  name: string;
  gateRefs: GateRef[];
}

export interface PopulationBulkEditPreview {
  updates: PopulationBulkEditUpdate[];
  rowCount: number;
  renameCount: number;
  gateDefinitionCount: number;
  unchangedCount: number;
  omittedCount: number;
  legacyRenameOnly: boolean;
}

const HEADERS = [
  "population_id",
  "current_population",
  "new_population",
  "gate_names",
] as const;

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function escapeGateToken(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
}

function gateNameCounts(gates: Record<string, Gate>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const gate of Object.values(gates)) {
    counts.set(gate.name, (counts.get(gate.name) ?? 0) + 1);
  }
  return counts;
}

function serializeGateRef(
  ref: GateRef,
  gates: Record<string, Gate>,
  duplicateNames: ReadonlyMap<string, number>,
): string {
  const gate = gates[ref.gate_id];
  if (!gate) throw new Error(`Population references missing gate id "${ref.gate_id}".`);
  if (!ref.include) {
    throw new Error(
      `Population table export supports positive AND definitions only; gate "${gate.name}" is negated.`,
    );
  }
  const disambiguated = (duplicateNames.get(gate.name) ?? 0) > 1
    ? `${gate.name} {${gate.gate_id}}`
    : gate.name;
  if (gate.gate_type === "quadrant") {
    if (!Number.isInteger(ref.quadrant) || ref.quadrant! < 1 || ref.quadrant! > 4) {
      throw new Error(`Quadrant gate "${gate.name}" has an invalid quadrant reference.`);
    }
    return escapeGateToken(`${disambiguated} [Q${ref.quadrant}]`);
  }
  if (ref.quadrant !== undefined) {
    throw new Error(`Non-quadrant gate "${gate.name}" has a quadrant reference.`);
  }
  return escapeGateToken(disambiguated);
}

/** Excel-friendly, ID-keyed template for atomic population name/definition edits. */
export function serializePopulationEditTemplate(state: PopulationTableState): string {
  const duplicateNames = gateNameCounts(state.gates);
  const order = populationTreeOrder(state.populations, state.rootPopulationId);
  const rows = order.map(({ popId }) => {
    const population = state.populations[popId];
    const gateNames = population.gate_refs
      .map((ref) => serializeGateRef(ref, state.gates, duplicateNames))
      .join(", ");
    return [
      popId,
      population.name,
      population.name,
      gateNames,
    ].map(escapeCsvCell).join(",");
  });
  return `\uFEFF${[HEADERS.join(","), ...rows].join("\r\n")}\r\n`;
}

function detectDelimiter(text: string): "," | "\t" {
  let commas = 0;
  let tabs = 0;
  let quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && (character === "\r" || character === "\n")) {
      break;
    } else if (!quoted && character === ",") {
      commas++;
    } else if (!quoted && character === "\t") {
      tabs++;
    }
  }
  if (commas === 0 && tabs === 0) {
    throw new Error("Population import needs a comma- or tab-delimited header row.");
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

  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      finishCell();
    } else if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && text[index + 1] === "\n") index++;
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Population import contains an unterminated quoted field.");
  if (cell.length > 0 || record.length > 0) finishRecord();
  return records;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function splitGateNames(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ",") {
      if (token.trim()) tokens.push(token.trim());
      token = "";
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (token.trim()) tokens.push(token.trim());
  return tokens;
}

function refsEqual(left: readonly GateRef[], right: readonly GateRef[]): boolean {
  return left.length === right.length && left.every((ref, index) =>
    ref.gate_id === right[index].gate_id &&
    ref.include === right[index].include &&
    ref.quadrant === right[index].quadrant);
}

function resolveGateToken(
  token: string,
  gates: Record<string, Gate>,
  gatesByName: ReadonlyMap<string, readonly Gate[]>,
): GateRef {
  let label = token;
  let quadrant: number | undefined;
  const quadrantMatch = label.match(/\s+\[Q([1-4])\]$/i);
  if (quadrantMatch) {
    quadrant = Number(quadrantMatch[1]);
    label = label.slice(0, quadrantMatch.index).trim();
  }

  let gate: Gate | undefined;
  const idMatch = label.match(/\s+\{([^{}]+)\}$/);
  if (idMatch) {
    const gateId = idMatch[1].trim();
    gate = gates[gateId];
    if (!gate) throw new Error(`Unknown gate id "${gateId}" in "${token}".`);
    const writtenName = label.slice(0, idMatch.index).trim();
    if (writtenName && writtenName !== gate.name) {
      throw new Error(
        `Gate id "${gateId}" is named "${gate.name}", not "${writtenName}". Download a fresh template.`,
      );
    }
  } else {
    const matches = gatesByName.get(label) ?? [];
    if (matches.length === 0) throw new Error(`Unknown gate name "${label}".`);
    if (matches.length > 1) {
      throw new Error(
        `Gate name "${label}" is ambiguous (${matches.length} gates). Use the {gate_id} form from the template.`,
      );
    }
    gate = matches[0];
  }

  if (gate.gate_type === "quadrant") {
    if (quadrant === undefined) {
      throw new Error(`Quadrant gate "${gate.name}" needs a suffix such as [Q1].`);
    }
  } else if (quadrant !== undefined) {
    throw new Error(`Gate "${gate.name}" is not a quadrant gate and cannot use [Q${quadrant}].`);
  }
  return {
    gate_id: gate.gate_id,
    include: true,
    ...(quadrant === undefined ? {} : { quadrant }),
  };
}

function parseLegacyRename(
  records: readonly string[][],
  headers: readonly string[],
  state: PopulationTableState,
): PopulationBulkEditPreview {
  const oldIndex = headers.indexOf("old_population");
  const newIndex = headers.indexOf("new_population");
  const populationsByName = new Map<string, string[]>();
  for (const population of Object.values(state.populations)) {
    const ids = populationsByName.get(population.name) ?? [];
    ids.push(population.population_id);
    populationsByName.set(population.name, ids);
  }

  const updates: PopulationBulkEditUpdate[] = [];
  const seen = new Set<string>();
  let unchangedCount = 0;
  for (let rowIndex = 1; rowIndex < records.length; rowIndex++) {
    const oldName = records[rowIndex][oldIndex]?.trim() ?? "";
    const newName = records[rowIndex][newIndex]?.trim() ?? "";
    if (!oldName) continue;
    const matches = populationsByName.get(oldName) ?? [];
    if (matches.length === 0) throw new Error(`Row ${rowIndex + 1}: unknown population "${oldName}".`);
    if (matches.length > 1) {
      throw new Error(
        `Row ${rowIndex + 1}: population name "${oldName}" is ambiguous; download the new ID-keyed template.`,
      );
    }
    const popId = matches[0];
    if (seen.has(popId)) throw new Error(`Row ${rowIndex + 1}: population "${oldName}" is listed twice.`);
    seen.add(popId);
    const population = state.populations[popId];
    const name = newName || population.name;
    if (name === population.name) unchangedCount++;
    updates.push({ popId, name, gateRefs: population.gate_refs.map((ref) => ({ ...ref })) });
  }
  if (updates.length === 0) throw new Error("Population import contains no data rows.");
  return {
    updates,
    rowCount: updates.length,
    renameCount: updates.length - unchangedCount,
    gateDefinitionCount: 0,
    unchangedCount,
    omittedCount: Object.keys(state.populations).length - updates.length,
    legacyRenameOnly: true,
  };
}

/**
 * Parse and fully validate every row before returning any state update. An error
 * aborts the entire import; callers never apply a partial population strategy.
 */
export function parsePopulationEditTable(
  text: string,
  state: PopulationTableState,
): PopulationBulkEditPreview {
  const delimiter = detectDelimiter(text);
  const records = readDelimitedRecords(text, delimiter);
  if (records.length === 0) throw new Error("Population import is empty.");
  const headers = records[0].map(normalizeHeader);

  if (
    headers.includes("old_population") &&
    headers.includes("new_population") &&
    !headers.includes("population_id")
  ) {
    return parseLegacyRename(records, headers, state);
  }

  const indexOf = (header: typeof HEADERS[number]): number => {
    const index = headers.indexOf(header);
    if (index < 0) throw new Error(`Population import is missing required column "${header}".`);
    return index;
  };
  const populationIdIndex = indexOf("population_id");
  const currentNameIndex = indexOf("current_population");
  const newNameIndex = indexOf("new_population");
  const gateNamesIndex = indexOf("gate_names");

  const gatesByName = new Map<string, Gate[]>();
  for (const gate of Object.values(state.gates)) {
    const matches = gatesByName.get(gate.name) ?? [];
    matches.push(gate);
    gatesByName.set(gate.name, matches);
  }

  const updates: PopulationBulkEditUpdate[] = [];
  const seenPopulations = new Set<string>();
  let renameCount = 0;
  let gateDefinitionCount = 0;
  let unchangedCount = 0;

  for (let rowIndex = 1; rowIndex < records.length; rowIndex++) {
    const record = records[rowIndex];
    const popId = record[populationIdIndex]?.trim() ?? "";
    if (!popId) continue;
    const population = state.populations[popId];
    if (!population) throw new Error(`Row ${rowIndex + 1}: unknown population id "${popId}".`);
    if (seenPopulations.has(popId)) {
      throw new Error(`Row ${rowIndex + 1}: population id "${popId}" is listed twice.`);
    }
    seenPopulations.add(popId);

    const currentName = record[currentNameIndex]?.trim() ?? "";
    if (currentName && currentName !== population.name) {
      throw new Error(
        `Row ${rowIndex + 1}: population "${popId}" is now named "${population.name}", not "${currentName}". Download a fresh template.`,
      );
    }
    const name = record[newNameIndex]?.trim() || population.name;
    const tokens = splitGateNames(record[gateNamesIndex] ?? "");
    if (popId === state.rootPopulationId && tokens.length > 0) {
      throw new Error(`Row ${rowIndex + 1}: the root population cannot contain gate definitions.`);
    }
    let gateRefs: GateRef[];
    try {
      gateRefs = tokens.map((token) => resolveGateToken(token, state.gates, gatesByName));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Row ${rowIndex + 1}: ${message}`);
    }
    const seenRefs = new Set<string>();
    for (const ref of gateRefs) {
      const key = `${ref.gate_id}:${ref.quadrant ?? ""}`;
      if (seenRefs.has(key)) {
        const gateName = state.gates[ref.gate_id]?.name ?? ref.gate_id;
        throw new Error(`Row ${rowIndex + 1}: gate "${gateName}" is listed more than once.`);
      }
      seenRefs.add(key);
    }

    const renamed = name !== population.name;
    const redefined = !refsEqual(gateRefs, population.gate_refs);
    if (renamed) renameCount++;
    if (redefined) gateDefinitionCount++;
    if (!renamed && !redefined) unchangedCount++;
    updates.push({ popId, name, gateRefs });
  }

  if (updates.length === 0) throw new Error("Population import contains no data rows.");
  return {
    updates,
    rowCount: updates.length,
    renameCount,
    gateDefinitionCount,
    unchangedCount,
    omittedCount: Object.keys(state.populations).length - updates.length,
    legacyRenameOnly: false,
  };
}
