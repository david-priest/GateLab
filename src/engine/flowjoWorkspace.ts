/**
 * Read gates directly from a FlowJo workspace (`.wsp`).
 *
 * FlowJo stores its gates as embedded ISAC Gating-ML: every gate element in a workspace is
 * `gating:PolygonGate` with `gating:vertex` / `data-type:value` children, in the same
 * namespaces GateLab already parses. Measured on a real 24-sample workspace, the vertices are
 * byte-identical to the ones FlowJo writes into its own Gating-ML export, and they are in raw
 * linear coordinates — the space gates are evaluated in — so nothing has to be un-transformed.
 *
 * What the workspace has that the export does not is population NAMES, the hierarchy, and
 * FlowJo's own event counts. FlowJo's Gating-ML export omits `gating:name` entirely, so an
 * imported strategy rebuilds as `ID1394212032` and cannot be read as a gating figure. That gap
 * is the only reason a separate name-recovery step ever existed.
 *
 * So this module does not re-implement gating: it rewrites the workspace's own gate elements
 * into a standard Gating-ML document, adding the `gating:name` and `gating:parent_id` that the
 * hierarchy implies, and hands that to `importGatingML`. Channel resolution, validation,
 * population building and the merge/replace flow are unchanged.
 *
 * Gate ids are used only within one parse. FlowJo reassigns them whenever a workspace is
 * saved — a workspace re-saved minutes after an export no longer shared a single id with it —
 * so nothing durable may be keyed on them.
 */

import type { SpilloverMatrix } from "./fcs";

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const TRANSFORMS_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

/**
 * The prefix FlowJo uses for a compensated parameter when a workspace does not name its own.
 * Only used to recognise that a dimension *looks* compensated while no matrix could be read,
 * which has to be reported rather than guessed at.
 */
const CONVENTIONAL_COMP_PREFIX = "Comp-";

/** Gate elements this importer can carry across. Anything else is reported, never dropped. */
const SUPPORTED_GATE_LOCAL_NAMES = new Set(["PolygonGate", "RectangleGate"]);

/** One independent gating tree within a sample. GateLab holds exactly one at a time. */
export interface FlowJoTreeSummary {
  /** Position among the sample's top-level populations; how a tree is selected. */
  index: number;
  /** The root population's name, which is what a user recognises the strategy by. */
  name: string;
  /** Events FlowJo recorded for the root, or null when absent. */
  rootCount: number | null;
  /** Gates in this tree that this importer can read. */
  gateCount: number;
  /** Gates it cannot; they and their descendants are skipped. */
  unsupportedCount: number;
  /** Population names in this tree, depth-first, so a picker can show the shape. */
  populations: string[];
}

export interface FlowJoSampleSummary {
  /**
   * Position in the workspace. Selection is by index, never by name: FlowJo allows the same
   * file to be added twice, and resolving a duplicate name by taking the first match would
   * import another sample's gates without saying so.
   */
  index: number;
  /** `SampleNode@name`, normally the FCS file name. */
  name: string;
  /** FlowJo group this sample is analysed under, for telling near-identical names apart. */
  owningGroup: string;
  /** Another sample in this workspace carries the same name. */
  duplicateName: boolean;
  /** Independent top-level trees. More than one means parallel strategies in one sample. */
  rootCount: number;
  /**
   * File names this sample may be stored under, best first.
   *
   * The `DataSet` URI's basename is the name the file actually had when FlowJo saw it, and is
   * the only one of the three that is reliably the on-disk name: a FACSDiva export names its
   * SampleNode after the acquisition's `$FIL` (`19319.fcs`) while the file is called something
   * else entirely. Older workspaces may carry no `$FIL` at all.
   */
  candidateFileNames: string[];
  /** The independent gating trees, for choosing one. */
  trees: FlowJoTreeSummary[];
  /** `SampleNode@count` — the events FlowJo had for the sample, or null when absent. */
  eventCount: number | null;
  /** Populations carrying a gate this importer understands. */
  gateCount: number;
  /** Populations whose gate type is not supported; they and their descendants are skipped. */
  unsupportedCount: number;
}

/**
 * A compensation matrix carried by the workspace rather than by the FCS.
 *
 * BD FACSDiva exports frequently have no `$SPILLOVER` at all: the matrix lives only in the
 * workspace, and FlowJo shows the compensated parameters under a prefix (`Comp-BV786-A`). Gates
 * drawn on those parameters cannot be evaluated without it.
 */
export interface FlowJoSpillover {
  /** FlowJo's name for the matrix, e.g. "DivaCompMtx_19319.fcs". */
  name: string;
  /** Prefix marking a compensated parameter; normally "Comp-", but the workspace decides. */
  prefix: string;
  suffix: string;
  /** Same shape and orientation as an FCS $SPILLOVER: row = source parameter, diagonal 1. */
  matrix: SpilloverMatrix;
}

export interface FlowJoConversion {
  /** A standard Gating-ML 2.0 document, ready for importGatingML. */
  gatingMl: string;
  sampleName: string;
  /** FlowJo's own event count per population name, for a concordance readout. */
  flowJoCounts: Record<string, number>;
  /** Anything skipped or altered, in the order encountered. Never silently discarded. */
  warnings: string[];
  /**
   * The matrix this sample's gates were drawn under, when the workspace carries one. Null when
   * the sample is uncompensated *or* when no matrix could be read; the two are distinguished by
   * whether `warnings` mentions unresolved compensated dimensions.
   */
  spillover: FlowJoSpillover | null;
}

/**
 * Direct children with this local name.
 *
 * Walks siblings rather than materialising `node.children`: that is a live HTMLCollection which
 * indexes in linear time, so `Array.from` over it is quadratic. It never mattered while the only
 * callers were Subpopulations and Population lists of a handful of elements, but a `<Keywords>`
 * block holds thousands, and reading one keyword per sample took a 24-sample workspace from 2s
 * to 25s.
 */
function childrenByLocalName(node: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === localName) out.push(c);
  }
  return out;
}

function parseWorkspace(xmlText: string): Document {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("This file is not valid XML, so it cannot be read as a FlowJo workspace.");
  }
  return doc;
}

/** True when the document looks like a FlowJo workspace rather than a Gating-ML file. */
export function isFlowJoWorkspace(xmlText: string): boolean {
  try {
    const doc = parseWorkspace(xmlText);
    return doc.getElementsByTagName("SampleNode").length > 0;
  } catch {
    return false;
  }
}

/** The gate element of one Population, if it carries one this importer understands. */
function gateElementOf(population: Element): { el: Element | null; unsupported: string | null } {
  const gate = childrenByLocalName(population, "Gate")[0];
  if (!gate) return { el: null, unsupported: null };
  const candidates = Array.from(gate.children).filter((c) => c.localName.endsWith("Gate"));
  if (!candidates.length) return { el: null, unsupported: null };
  const supported = candidates.find((c) => SUPPORTED_GATE_LOCAL_NAMES.has(c.localName));
  return supported
    ? { el: supported, unsupported: null }
    : { el: null, unsupported: candidates[0].localName };
}

function eachPopulation(
  container: Element,
  visit: (population: Element, depth: number) => boolean,
  depth = 0,
): void {
  for (const subs of childrenByLocalName(container, "Subpopulations")) {
    for (const pop of childrenByLocalName(subs, "Population")) {
      // visit() returns false when the subtree must not be descended into, which happens when
      // a gate could not be represented: its children's membership depends on it, so carrying
      // them over re-parented would silently change what they mean.
      if (visit(pop, depth)) eachPopulation(pop, visit, depth + 1);
    }
  }
}

function sampleNodes(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName("SampleNode"));
}

/** Summarise every sample in the workspace, so the caller can choose one. */
/** The independent gating trees of a sample: its top-level Population elements. */
function rootPopulations(sampleNode: Element): Element[] {
  return childrenByLocalName(sampleNode, "Subpopulations")
    .flatMap((subs) => childrenByLocalName(subs, "Population"));
}

/** Visit one tree, root included. `eachPopulation` starts below a container, not at it. */
function walkTree(root: Element, visit: (pop: Element, depth: number) => boolean): void {
  if (visit(root, 0)) eachPopulation(root, visit, 1);
}

function summariseTree(root: Element, index: number): FlowJoTreeSummary {
  let gateCount = 0;
  let unsupportedCount = 0;
  const populations: string[] = [];
  walkTree(root, (pop) => {
    const { el, unsupported } = gateElementOf(pop);
    if (el) {
      gateCount++;
      populations.push(pop.getAttribute("name") ?? "");
      return true;
    }
    if (unsupported) unsupportedCount++;
    return false;
  });
  const raw = Number(root.getAttribute("count"));
  return {
    index,
    name: root.getAttribute("name") ?? `tree ${index + 1}`,
    rootCount: Number.isFinite(raw) ? raw : null,
    gateCount,
    unsupportedCount,
    populations,
  };
}

/**
 * The names this sample's FCS may be stored under, best first.
 *
 * Order matters. The `DataSet` URI is the path FlowJo actually read, so its basename is the
 * file's real name; `SampleNode@name` and `$FIL` can both be the acquisition's internal name
 * instead. All three are offered because no single one is present in every workspace: a
 * FACSDiscover export here carries no `$FIL` at all, and a FACSDiva export's node name is
 * `19319.fcs` while the file on disk is `Specimen_001_B cell presort.fcs`.
 */
function candidateFileNames(sampleNode: Element): string[] {
  const owner = sampleNode.parentElement;
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const v = (value ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  const uri = owner ? childrenByLocalName(owner, "DataSet")[0]?.getAttribute("uri") : null;
  if (uri) {
    const base = uri.split(/[\\/]/).pop() ?? "";
    let decoded = base;
    try {
      decoded = decodeURIComponent(base);
    } catch {
      // A malformed escape is not a reason to lose the name; use it as written.
    }
    push(decoded);
  }
  push(sampleNode.getAttribute("name"));
  // Direct children only. Scanning every descendant of a <Sample> means walking its whole gate
  // tree and graph settings for one keyword, which took the 24-sample workspace from 3s to 45s.
  for (const keywords of owner ? childrenByLocalName(owner, "Keywords") : []) {
    for (const kw of childrenByLocalName(keywords, "Keyword")) {
      if (kw.getAttribute("name") === "$FIL") push(kw.getAttribute("value"));
    }
  }
  return out;
}

export function listFlowJoWorkspaceSamples(xmlText: string): FlowJoSampleSummary[] {
  const nodes = sampleNodes(parseWorkspace(xmlText));
  const nameCounts = new Map<string, number>();
  for (const n of nodes) {
    const nm = n.getAttribute("name") ?? "";
    nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);
  }
  return nodes.map((node, index) => {
    let gateCount = 0;
    let unsupportedCount = 0;
    eachPopulation(node, (pop) => {
      const { el, unsupported } = gateElementOf(pop);
      if (el) {
        gateCount++;
        return true;
      }
      if (unsupported) unsupportedCount++;
      return false;
    });
    const rawCount = Number(node.getAttribute("count"));
    const name = node.getAttribute("name") ?? "";
    const trees = rootPopulations(node).map(summariseTree);
    return {
      index,
      name,
      owningGroup: node.getAttribute("owningGroup") ?? "",
      duplicateName: (nameCounts.get(name) ?? 0) > 1,
      rootCount: trees.length,
      candidateFileNames: candidateFileNames(node),
      trees,
      eventCount: Number.isFinite(rawCount) ? rawCount : null,
      gateCount,
      unsupportedCount,
    };
  });
}

/** How a workspace sample was matched to the loaded file. */
export type FlowJoSampleMatchKey = "name" | "fil";

export interface FlowJoSampleMatch {
  matches: FlowJoSampleSummary[];
  /** Which key produced a unique match, or null when the result is not unique. */
  matchedOn: FlowJoSampleMatchKey | null;
}

/** Compare two FCS-ish names the way FlowJo and the file system disagree about them. */
function sameFile(a: string, b: string): boolean {
  const stem = (n: string) => n.replace(/\.fcs$/i, "").trim().toLowerCase();
  return stem(a).length > 0 && stem(a) === stem(b);
}

/**
 * Find the workspace sample corresponding to the loaded file.
 *
 * `SampleNode@name` is usually the FCS file name, but it is not always: a BD FACSDiva export
 * names its samples by the acquisition's `$FIL` keyword (`19319.fcs`) while the file on disk is
 * called something else entirely (`Specimen_001_B cell presort.fcs`). Matching on the file name
 * alone finds nothing there and sends the user to the picker for a workspace holding exactly one
 * sample, so `$FIL` is tried as well.
 *
 * The file name is tried first: it is what the user sees, and where the two disagree the file
 * name is the more deliberate of the two. Neither key is allowed to return an ambiguous answer —
 * FlowJo permits the same file twice, and picking the first would import another sample's gates.
 */
export function matchFlowJoSamples(
  samples: FlowJoSampleSummary[],
  loaded: { fileName: string; fil?: string | null },
): FlowJoSampleMatch {
  // Any name the workspace records for a sample is a legitimate way to recognise it: the path
  // FlowJo read, the node name, or the acquisition's $FIL. Which one is present varies by vendor.
  const matchesFile = (s: FlowJoSampleSummary, candidate: string) =>
    s.candidateFileNames.some((c) => sameFile(c, candidate));

  const byName = samples.filter((s) => matchesFile(s, loaded.fileName));
  if (byName.length === 1) return { matches: byName, matchedOn: "name" };

  const fil = loaded.fil?.trim();
  if (fil) {
    const byFil = samples.filter((s) => matchesFile(s, fil));
    if (byFil.length === 1) return { matches: byFil, matchedOn: "fil" };
    if (byName.length === 0 && byFil.length > 1) return { matches: byFil, matchedOn: null };
  }
  return { matches: byName, matchedOn: null };
}

export interface FlowJoFileResolution {
  /** Index into the sample list this resolution is for. */
  sampleIndex: number;
  /** The provided file that matches, or null when none does. */
  fileName: string | null;
  /** Which of the sample's recorded names matched, for explaining the choice. */
  matchedName: string | null;
}

/**
 * Match a workspace's samples to a set of files the user has supplied.
 *
 * Every sample is reported, matched or not: a workspace whose files are partly missing is a
 * normal situation, and the ones that did resolve are still worth importing. A file is never
 * given to two samples, so a workspace that lists the same file twice resolves the first and
 * leaves the second unmatched rather than importing one sample's gates under another's name.
 */
export function resolveFlowJoWorkspaceFiles(
  samples: FlowJoSampleSummary[],
  fileNames: readonly string[],
): FlowJoFileResolution[] {
  const taken = new Set<string>();
  return samples.map((sample) => {
    for (const candidate of sample.candidateFileNames) {
      const hit = fileNames.find((f) => !taken.has(f) && sameFile(f, candidate));
      if (hit !== undefined) {
        taken.add(hit);
        return { sampleIndex: sample.index, fileName: hit, matchedName: candidate };
      }
    }
    return { sampleIndex: sample.index, fileName: null, matchedName: null };
  });
}

/**
 * Read one `transforms:spilloverMatrix` element.
 *
 * Orientation is chosen to match `parseSpillover()` in `fcs.ts` exactly, so the result can be
 * used anywhere an embedded `$SPILLOVER` can: `matrix[i][j]` is the coefficient of the row
 * parameter `channels[i]` in the column parameter `channels[j]`, with a unit diagonal. Rows are
 * indexed by their declared parameter rather than by document order, so a workspace that writes
 * them in a different order still yields the same matrix.
 */
function readSpilloverMatrix(el: Element): FlowJoSpillover | null {
  // `spectral="1"` marks a spectral unmixing matrix, whose convention this app has never been
  // checked against. Reading one as if it were a conventional spillover would unmix wrongly and
  // silently. Declining it costs nothing today — the one spectral workspace here (FACSDiscover
  // S8) gates on unprefixed, uncompensated parameters — and any workspace that did rely on one
  // reports its dimensions as unresolved instead of importing them into the wrong space.
  if ((el.getAttribute("spectral") ?? "0") !== "0") return null;

  const params = Array.from(el.getElementsByTagNameNS(DATATYPE_NS, "parameter"))
    .map((p) => p.getAttributeNS(DATATYPE_NS, "name") ?? "")
    .filter((n) => n.length > 0);
  if (params.length < 2) return null;
  const index = new Map(params.map((n, i) => [n, i]));

  const matrix: number[][] = params.map(() => params.map(() => 0));
  let rowsSeen = 0;
  for (const row of Array.from(el.getElementsByTagNameNS(TRANSFORMS_NS, "spillover"))) {
    const rowName = row.getAttributeNS(DATATYPE_NS, "parameter") ?? "";
    const i = index.get(rowName);
    if (i === undefined) return null;
    rowsSeen++;
    for (const coef of Array.from(row.getElementsByTagNameNS(TRANSFORMS_NS, "coefficient"))) {
      const j = index.get(coef.getAttributeNS(DATATYPE_NS, "parameter") ?? "");
      const v = Number(coef.getAttributeNS(TRANSFORMS_NS, "value"));
      if (j === undefined || !Number.isFinite(v)) return null;
      matrix[i][j] = v;
    }
  }
  if (rowsSeen !== params.length) return null;

  // A matrix whose diagonal is not unit is not the convention the rest of the app compensates
  // with, and silently using it would change every gated population. Refuse it instead.
  //
  // The tolerance is loose because a real instrument-derived diagonal is not exactly 1: the Diva
  // matrix in the Priest et al. 2024 sort workspace runs 0.9999999974 to 1.0000020054. This test
  // exists to catch a different convention entirely — a percentage-scaled or already-inverted
  // matrix — which is wrong by orders of magnitude, not by parts per million.
  if (!matrix.every((row, i) => Math.abs(row[i] - 1) < 1e-3)) return null;
  // Identity means no real compensation, matching parseSpillover()'s behaviour.
  if (matrix.every((row, i) => row.every((v, j) => (i === j ? true : Math.abs(v) < 1e-9)))) {
    return null;
  }

  return {
    name: el.getAttribute("name") ?? "",
    prefix: el.getAttribute("prefix") ?? "",
    suffix: el.getAttribute("suffix") ?? "",
    matrix: { channels: params, matrix },
  };
}

/**
 * The matrix belonging to one sample.
 *
 * FlowJo writes the sample's own matrix inside its `Sample` element and also copies it into the
 * workspace-level `Matrices` block, alongside others that belong to different samples (an
 * "Acquisition-defined" entry is usually present too). Reading the sample's own copy is therefore
 * the only unambiguous choice; the workspace-level block is consulted only when the sample has no
 * matrix of its own and exactly one candidate exists there.
 */
function sampleSpillover(sampleNode: Element): FlowJoSpillover | null {
  const owner = sampleNode.parentElement;
  if (owner) {
    for (const el of childrenByLocalName(owner, "spilloverMatrix")) {
      const parsed = readSpilloverMatrix(el);
      if (parsed) return parsed;
    }
  }
  const doc = sampleNode.ownerDocument;
  if (!doc) return null;
  const all = Array.from(doc.getElementsByTagNameNS(TRANSFORMS_NS, "spilloverMatrix"))
    .map(readSpilloverMatrix)
    .filter((m): m is FlowJoSpillover => m !== null);
  const distinct = new Map(all.map((m) => [m.name, m]));
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}

/** The uncompensated parameter behind a possibly prefixed dimension name, or null. */
function uncompensatedName(raw: string, spill: FlowJoSpillover): string | null {
  const { prefix, suffix } = spill;
  if (prefix && !raw.startsWith(prefix)) return null;
  if (suffix && !raw.endsWith(suffix)) return null;
  const base = raw.slice(prefix.length, suffix ? raw.length - suffix.length : undefined);
  // The stripped name must actually be in the matrix. Without this a scatter parameter would be
  // mistaken for a compensated one whenever the prefix is empty.
  return spill.matrix.channels.includes(base) ? base : null;
}

/**
 * Name each dimension in the uncompensated space and say which compensation it needs.
 *
 * The workspace states neither: gate dimensions are written as `Comp-BV786-A` with no
 * `gating:compensation-ref` at all. Left alone, `Comp-BV786-A` resolves to the uncompensated
 * `BV786-A` by channel-name normalisation, so the gates import cleanly and land in the wrong
 * space — the failure is invisible. Making the reference explicit here is what lets the ordinary
 * Gating-ML compensation check reject the import instead.
 */
function nameDimensionsAndRefs(
  gate: Element,
  spill: FlowJoSpillover | null,
  unresolved: Set<string>,
): void {
  for (const dimEl of Array.from(gate.getElementsByTagNameNS(DATATYPE_NS, "fcs-dimension"))) {
    const raw = dimEl.getAttributeNS(DATATYPE_NS, "name") ?? "";
    const owner = dimEl.parentElement;
    if (!owner) continue;
    const base = spill ? uncompensatedName(raw, spill) : null;
    if (base !== null) {
      dimEl.setAttributeNS(DATATYPE_NS, "data-type:name", base);
      owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "FCS");
      continue;
    }

    const prefix = spill?.prefix || CONVENTIONAL_COMP_PREFIX;
    if (prefix && raw.startsWith(prefix)) {
      // Compensated, but nothing here can supply the matrix — either none was found, or this
      // parameter is not in the one that was. The requirement is still declared, and the name
      // still stripped so it resolves to a real parameter, precisely so the ordinary Gating-ML
      // compensation check refuses the import. Marking it uncompensated instead would let the
      // gate land on raw data and look like a clean import.
      dimEl.setAttributeNS(DATATYPE_NS, "data-type:name", raw.slice(prefix.length));
      owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "FCS");
      unresolved.add(raw);
      continue;
    }
    owner.setAttributeNS(GATING_NS, "gating:compensation-ref", "uncompensated");
  }
}

/**
 * Rewrite one sample's gates as a Gating-ML 2.0 document.
 *
 * Names come from `Population@name` and ancestry from the nesting, so neither FlowJo's gate ids
 * nor any `custom_info` convention is relied on for structure.
 */
export function flowJoWorkspaceToGatingML(
  xmlText: string,
  sampleIndex: number,
  /**
   * Which of the sample's independent trees to import. GateLab holds exactly one strategy, so a
   * sample with several must be narrowed to one rather than silently merged. Null imports them
   * all, which is reported as the merge it is.
   */
  treeIndex: number | null = null,
): FlowJoConversion {
  const doc = parseWorkspace(xmlText);
  const nodes = sampleNodes(doc);
  const node = nodes[sampleIndex];
  if (!node) {
    throw new Error(
      `This workspace has no sample at position ${sampleIndex + 1}; it holds ${nodes.length}.`,
    );
  }
  const sampleName = node.getAttribute("name") ?? `sample ${sampleIndex + 1}`;

  const out = new DOMParser().parseFromString(
    `<gating:Gating-ML xmlns:gating="${GATING_NS}" xmlns:data-type="${DATATYPE_NS}"/>`,
    "application/xml",
  );
  const root = out.documentElement;

  const warnings: string[] = [];
  const flowJoCounts: Record<string, number> = {};
  const idOf = new Map<Element, string>();
  const spill = sampleSpillover(node);
  const unresolvedCompensated = new Set<string>();
  let serial = 0;

  const roots = rootPopulations(node);
  if (treeIndex !== null && !roots[treeIndex]) {
    throw new Error(
      `"${sampleName}" has no gating tree at position ${treeIndex + 1}; it holds ${roots.length}.`,
    );
  }
  const selectedRoots = treeIndex === null ? roots : [roots[treeIndex]];

  const visitPopulation = (pop: Element, depth: number): boolean => {
    const name = pop.getAttribute("name") ?? `population_${serial + 1}`;
    const { el, unsupported } = gateElementOf(pop);

    if (!el) {
      warnings.push(
        unsupported
          ? `"${name}" uses ${unsupported}, which this importer does not read yet; it and anything below it were skipped.`
          : `"${name}" has no gate; it and anything below it were skipped.`,
      );
      return false;
    }

    const count = Number(pop.getAttribute("count"));
    if (Number.isFinite(count)) flowJoCounts[name] = count;

    const copy = out.importNode(el, true) as Element;
    nameDimensionsAndRefs(copy, spill, unresolvedCompensated);
    // FlowJo ids are unique within one file, which is all that is needed here; a generated id
    // keeps the document valid when one is missing.
    const gateId = el.getAttributeNS(GATING_NS, "id") ?? `wsp_gate_${++serial}`;
    copy.setAttributeNS(GATING_NS, "gating:id", gateId);
    copy.setAttributeNS(GATING_NS, "gating:name", name);
    idOf.set(pop, gateId);

    const parent = pop.parentElement?.parentElement ?? null; // Population -> Subpopulations -> Population
    const parentId = parent && parent.localName === "Population" ? idOf.get(parent) : undefined;
    if (parentId) copy.setAttributeNS(GATING_NS, "gating:parent_id", parentId);
    else if (depth > 0) {
      warnings.push(`"${name}" sits under a skipped gate, so it was attached to the top level.`);
    }

    root.appendChild(copy);
    return true;
  };

  for (const selected of selectedRoots) walkTree(selected, visitPopulation);

  if (!root.children.length) {
    throw new Error(
      `"${sampleName}" has no gates this importer can read.` +
        (warnings.length ? ` ${warnings[0]}` : ""),
    );
  }

  // Parallel top-level trees mean the sample was gated under more than one strategy. They are
  // imported together, which is a merge the user did not ask for, so it is stated.
  const rootTrees = Array.from(root.children).filter(
    (el) => !el.getAttributeNS(GATING_NS, "parent_id"),
  ).length;
  if (rootTrees > 1) {
    warnings.push(
      `"${sampleName}" holds ${rootTrees} independent gating trees and all were imported ` +
        "together, which merges strategies that FlowJo kept apart. Choose one to import it alone.",
    );
  }

  // These dimensions declare a compensation nothing here can supply. They are reported, and the
  // document they are in will be refused downstream for exactly that reason.
  if (unresolvedCompensated.size) {
    warnings.push(
      `${unresolvedCompensated.size} gate dimension(s) are compensated ` +
        `(${[...unresolvedCompensated].slice(0, 3).join(", ")}` +
        `${unresolvedCompensated.size > 3 ? ", …" : ""}) but this workspace carries no usable ` +
        "compensation matrix for the sample, so those gates cannot be placed correctly.",
    );
  }

  return {
    gatingMl: new XMLSerializer().serializeToString(out),
    sampleName,
    flowJoCounts,
    warnings,
    spillover: spill,
  };
}
