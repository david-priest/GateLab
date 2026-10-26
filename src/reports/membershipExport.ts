// membershipExport.ts — every population's event membership for one file, as a plain table that
// another tool can read: one column per population, one row per event, 1 inside and 0 outside.
//
// Nothing here gates anything. The masks are the ones the engine already made for the file
// (applyGatingStrategy's GatingResult, or the store's GatingDerived, both a MaskMap keyed by
// population id over the file's events in FCS order). This module names each population by its
// place in the tree, writes the table, and reads it back.
//
// A population is named by its path: the names of the populations from the top of the tree down to
// it, joined by "/", e.g. "Lymphocytes/Single cells/Live/CD4_positive". The root (every event of the
// file) is not part of any path and has no column, since it holds every event. A name that holds
// "/" or "\" has each escaped with a backslash ("CD4/CD8" is written "CD4\/CD8", "a\b" is
// "a\\b"), so a path splits back into its names without ambiguity.
//
// The CSV carries no comment lines: its first line is the header, whose first column is
// "event_index" and whose other columns are population paths; each further line is one event.
// What a reader may want to know about the file goes in the manifest returned beside it.

import pkg from "../../package.json";
import type { MaskMap } from "../engine/populations";
import { populationTreeOrder } from "../engine/populations";
import type { PopulationMap } from "../engine/models";

export const PATH_SEPARATOR = "/";
export const EVENT_INDEX_COLUMN = "event_index";
export const MEMBERSHIP_CSV_FORMAT = "gatelab-membership-csv";
export const MEMBERSHIP_CSV_VERSION = 1;

/** One population's name as it appears in a path: "\" and "/" escaped with a backslash. */
export function escapePathSegment(name: string): string {
  return name.replace(/[\\/]/g, (ch) => `\\${ch}`);
}

/** The names a path is made of, with their escapes undone. A trailing lone backslash is an error. */
export function splitPopulationPath(path: string): string[] {
  const names: string[] = [];
  let current = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === "\\") {
      if (i + 1 >= path.length) throw new Error(`Population path '${path}' ends in an unfinished escape.`);
      current += path[++i];
    } else if (ch === PATH_SEPARATOR) {
      names.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  names.push(current);
  return names;
}

/** The path of a population from its names, top of the tree first. */
export function joinPopulationPath(names: readonly string[]): string {
  return names.map(escapePathSegment).join(PATH_SEPARATOR);
}

/** The path of the population a path sits under, or null for a population directly under the root. */
export function parentPopulationPath(path: string): string | null {
  const names = splitPopulationPath(path);
  return names.length > 1 ? joinPopulationPath(names.slice(0, -1)) : null;
}

/** One population of the tree, keyed by its path. */
export interface PopulationKey {
  populationId: string;
  name: string;
  path: string;
  /** The path of its parent; null when the parent is the root. */
  parentPath: string | null;
  /** 1 for a population directly under the root. */
  depth: number;
  /** Its own name, when a sibling of the same name came first and this one's path says "name (2)". */
  renamedFrom?: string;
}

/**
 * Every population below the root, in the tree's display order (populationTreeOrder), with its
 * path. The path is the key a comparison matches on, so it must name one population: a second
 * sibling of the same name is written "name (2)", a third "name (3)", as the FlowJo export names
 * them (flowjoExport.ts), and its key says so (renamedFrom).
 */
export function populationKeys(populations: PopulationMap, rootPopulationId: string): PopulationKey[] {
  const keys: PopulationKey[] = [];
  const seen = new Set<string>();
  // populationTreeOrder walks depth first, so the names above a population are the last one
  // visited at each smaller depth.
  const above: string[] = [];
  for (const { popId, depth } of populationTreeOrder(populations, rootPopulationId)) {
    if (depth === 0) continue;
    const name = populations[popId].name;
    above.length = depth - 1;
    let written = name;
    for (let k = 2; seen.has(joinPopulationPath([...above, written])); k++) written = `${name} (${k})`;
    const path = joinPopulationPath([...above, written]);
    seen.add(path);
    keys.push({
      populationId: popId,
      name,
      path,
      parentPath: depth > 1 ? joinPopulationPath(above) : null,
      depth,
      ...(written !== name ? { renamedFrom: name } : {}),
    });
    above.push(written);
  }
  return keys;
}

/** Population memberships over one file's events, keyed by population path, in column order. */
export interface MembershipTable {
  totalEvents: number;
  /** Population paths in column order. */
  paths: string[];
  /** One mask per path, of length totalEvents: 1 where the event is a member. */
  masks: Map<string, Uint8Array>;
}

/** What the engine made for one file: its population tree and a mask per population id. */
export interface FileGating {
  populations: PopulationMap;
  rootPopulationId: string;
  /** applyGatingStrategy's masks (GatingResult.masks) or the store's GatingDerived.masks. */
  masks: MaskMap;
}

/**
 * The table of one file's gating: a column per population below the root, in tree order. Every
 * population must have a mask as long as the root's, the file's event count; a missing or short
 * one is an error rather than a column of zeros, which would read as "no event is a member".
 */
export function membershipTable(gating: FileGating): MembershipTable {
  const rootMask = gating.masks[gating.rootPopulationId];
  if (!rootMask) throw new Error(`The gating has no mask for the root population '${gating.rootPopulationId}'.`);
  const totalEvents = rootMask.length;
  const keys = populationKeys(gating.populations, gating.rootPopulationId);
  const masks = new Map<string, Uint8Array>();
  for (const key of keys) {
    const mask = gating.masks[key.populationId];
    if (!mask) throw new Error(`Population '${key.path}' has no mask: it was not evaluated.`);
    if (mask.length !== totalEvents) {
      throw new Error(`Population '${key.path}' has a mask of ${mask.length} events; the file has ${totalEvents}.`);
    }
    masks.set(key.path, mask);
  }
  return { totalEvents, paths: keys.map((key) => key.path), masks };
}

const csvCell = (text: string): string => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/**
 * The table as CSV. The first column, "event_index", is the event's 0-based position in the file
 * (FCS event order); each other column is a population path, 1 for a member and 0 otherwise. Lines
 * end in "\n" and the text ends in one. A header cell holding a comma, quote or line break is
 * quoted as RFC 4180 has it.
 */
export function membershipCsv(table: MembershipTable): string {
  const masks = table.paths.map((path) => {
    const mask = table.masks.get(path);
    if (!mask || mask.length !== table.totalEvents) throw new Error(`Population '${path}' has no mask of ${table.totalEvents} events.`);
    return mask;
  });
  const lines: string[] = new Array(table.totalEvents + 1);
  lines[0] = [EVENT_INDEX_COLUMN, ...table.paths].map(csvCell).join(",");
  const row: string[] = new Array(masks.length + 1);
  for (let i = 0; i < table.totalEvents; i++) {
    row[0] = String(i);
    for (let c = 0; c < masks.length; c++) row[c + 1] = masks[c][i] ? "1" : "0";
    lines[i + 1] = row.join(",");
  }
  return `${lines.join("\n")}\n`;
}

/** Facts about the file and the tree that the CSV does not carry. */
export interface MembershipManifest {
  format: typeof MEMBERSHIP_CSV_FORMAT;
  formatVersion: typeof MEMBERSHIP_CSV_VERSION;
  /** The file the events are from, as GateLab holds it. */
  fileName: string;
  /** The file's $FIL keyword, or null when it has none or none was given. */
  fil: string | null;
  totalEvents: number;
  /** The CSV's event_index starts here. */
  eventIndexBase: 0;
  rootPopulationId: string;
  rootName: string;
  /** Every column's population, in column order: its id in the workspace, its path and its count. */
  populations: { populationId: string; path: string; events: number }[];
  /** The GateLab version that wrote it; the caller may replace it (GateLabR states its own). */
  gatelabVersion: string | null;
}

/** The file the gating is of: its name, and its FCS keywords when the caller has them. */
export interface MembershipFileInfo {
  fileName: string;
  keywords?: Readonly<Record<string, string>>;
}

const filOf = (keywords: Readonly<Record<string, string>> | undefined): string | null => {
  const found = Object.entries(keywords ?? {}).find(([key]) => key.trim().toUpperCase() === "$FIL")?.[1]?.trim();
  return found ? found : null;
};

const countOf = (mask: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
};

/** One file's memberships as CSV text, with its manifest. */
export function exportMemberships(
  gating: FileGating,
  file: MembershipFileInfo,
  options: { gatelabVersion?: string | null } = {},
): { csv: string; manifest: MembershipManifest; table: MembershipTable } {
  const table = membershipTable(gating);
  const keys = populationKeys(gating.populations, gating.rootPopulationId);
  const manifest: MembershipManifest = {
    format: MEMBERSHIP_CSV_FORMAT,
    formatVersion: MEMBERSHIP_CSV_VERSION,
    fileName: file.fileName,
    fil: filOf(file.keywords),
    totalEvents: table.totalEvents,
    eventIndexBase: 0,
    rootPopulationId: gating.rootPopulationId,
    rootName: gating.populations[gating.rootPopulationId]?.name ?? gating.rootPopulationId,
    populations: keys.map((key) => ({
      populationId: key.populationId,
      path: key.path,
      events: countOf(table.masks.get(key.path)!),
    })),
    gatelabVersion: options.gatelabVersion !== undefined ? options.gatelabVersion : pkg.version,
  };
  return { csv: membershipCsv(table), manifest, table };
}

/**
 * The header record: RFC 4180 fields up to the first line break outside quotes. Returns the fields
 * and where the data lines start.
 */
function readHeader(text: string): { fields: string[]; end: number } {
  const fields: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let fieldStart = true;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; continue; }
    if (ch === ",") { fields.push(field); field = ""; fieldStart = true; continue; }
    if (ch === "\n" || ch === "\r") break;
    field += ch;
    fieldStart = false;
  }
  if (quoted) throw new Error("The membership CSV's header has an unclosed quote.");
  fields.push(field);
  if (text[i] === "\r" && text[i + 1] === "\n") i++;
  return { fields, end: i + 1 };
}

/**
 * Read a membership CSV back into a table. Lines may end in "\n" or "\r\n", and a UTF-8 byte-order
 * mark is skipped. The header must start with "event_index" and name each population once; every
 * data line must have as many fields as the header, an event_index equal to its 0-based position,
 * and only 0 or 1 in the population columns. Anything else is refused with the line it is on.
 */
export function parseMembershipCsv(text: string): MembershipTable {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") throw new Error("The membership CSV is empty.");
  const { fields: header, end } = readHeader(body);
  if (header[0] !== EVENT_INDEX_COLUMN) {
    throw new Error(`The membership CSV's first column is '${header[0]}'; it must be '${EVENT_INDEX_COLUMN}'.`);
  }
  const paths = header.slice(1);
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`The membership CSV names population '${path}' twice.`);
    splitPopulationPath(path);
    seen.add(path);
  }
  const lines = body.slice(end).split(/\r?\n/);
  // The text ends in a line break, which leaves one empty string after it.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const totalEvents = lines.length;
  const masks = paths.map(() => new Uint8Array(totalEvents));
  const width = header.length;
  for (let r = 0; r < totalEvents; r++) {
    const line = lines[r];
    const lineNumber = r + 2;
    const cells = line.split(",");
    if (cells.length !== width) {
      throw new Error(`Line ${lineNumber} of the membership CSV has ${cells.length} fields; the header has ${width}.`);
    }
    if (cells[0] !== String(r)) {
      throw new Error(`Line ${lineNumber} of the membership CSV has event_index '${cells[0]}'; expected ${r}.`);
    }
    for (let c = 1; c < width; c++) {
      const cell = cells[c];
      if (cell === "1") masks[c - 1][r] = 1;
      else if (cell !== "0") {
        throw new Error(`Line ${lineNumber} of the membership CSV has '${cell}' for '${paths[c - 1]}'; only 0 or 1 is allowed.`);
      }
    }
  }
  return { totalEvents, paths, masks: new Map(paths.map((path, c) => [path, masks[c]])) };
}
