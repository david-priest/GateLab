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

const GATING_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DATATYPE_NS = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

/** Gate elements this importer can carry across. Anything else is reported, never dropped. */
const SUPPORTED_GATE_LOCAL_NAMES = new Set(["PolygonGate", "RectangleGate"]);

export interface FlowJoSampleSummary {
  /** `SampleNode@name`, normally the FCS file name. */
  name: string;
  /** `SampleNode@count` — the events FlowJo had for the sample, or null when absent. */
  eventCount: number | null;
  /** Populations carrying a gate this importer understands. */
  gateCount: number;
  /** Populations whose gate type is not supported; they and their descendants are skipped. */
  unsupportedCount: number;
}

export interface FlowJoConversion {
  /** A standard Gating-ML 2.0 document, ready for importGatingML. */
  gatingMl: string;
  sampleName: string;
  /** FlowJo's own event count per population name, for a concordance readout. */
  flowJoCounts: Record<string, number>;
  /** Anything skipped or altered, in the order encountered. Never silently discarded. */
  warnings: string[];
}

function childrenByLocalName(node: Element, localName: string): Element[] {
  return Array.from(node.children).filter((c) => c.localName === localName);
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
export function listFlowJoWorkspaceSamples(xmlText: string): FlowJoSampleSummary[] {
  return sampleNodes(parseWorkspace(xmlText)).map((node) => {
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
    return {
      name: node.getAttribute("name") ?? "",
      eventCount: Number.isFinite(rawCount) ? rawCount : null,
      gateCount,
      unsupportedCount,
    };
  });
}

/**
 * Rewrite one sample's gates as a Gating-ML 2.0 document.
 *
 * Names come from `Population@name` and ancestry from the nesting, so neither FlowJo's gate ids
 * nor any `custom_info` convention is relied on for structure.
 */
export function flowJoWorkspaceToGatingML(xmlText: string, sampleName: string): FlowJoConversion {
  const doc = parseWorkspace(xmlText);
  const node = sampleNodes(doc).find((n) => n.getAttribute("name") === sampleName);
  if (!node) {
    const available = sampleNodes(doc).map((n) => n.getAttribute("name") ?? "?");
    throw new Error(
      `No sample named "${sampleName}" in this workspace. It contains: ${available.join(", ") || "no samples"}.`,
    );
  }

  const out = new DOMParser().parseFromString(
    `<gating:Gating-ML xmlns:gating="${GATING_NS}" xmlns:data-type="${DATATYPE_NS}"/>`,
    "application/xml",
  );
  const root = out.documentElement;

  const warnings: string[] = [];
  const flowJoCounts: Record<string, number> = {};
  const idOf = new Map<Element, string>();
  let serial = 0;

  eachPopulation(node, (pop, depth) => {
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
  });

  if (!root.children.length) {
    throw new Error(
      `"${sampleName}" has no gates this importer can read.` +
        (warnings.length ? ` ${warnings[0]}` : ""),
    );
  }

  return {
    gatingMl: new XMLSerializer().serializeToString(out),
    sampleName,
    flowJoCounts,
    warnings,
  };
}
