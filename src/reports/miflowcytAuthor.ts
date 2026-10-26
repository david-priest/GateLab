// miflowcytAuthor.ts — the MIFlowCyt items only the author can supply, as the report dialog edits
// them and the workspace keeps them.
//
// They are saved at the top level of the workspace JSON under MIFLOWCYT_AUTHOR_FIELD. Nothing in
// gating reads them, and a GateLab without this field ignores it, so no workspace feature is
// declared. Read back defensively: a value of the wrong type is dropped, never coerced.

import type { MiflowcytAuthorInput } from "./miflowcytReport";

export const MIFLOWCYT_AUTHOR_FIELD = "miflowcytAuthor";

/** The dialog's fields, in report order, with the MIFlowCyt section each belongs to. */
export const MIFLOWCYT_AUTHOR_FIELDS: readonly {
  key: Exclude<keyof MiflowcytAuthorInput, "keywords"> | "keywords";
  label: string;
  section: "overview" | "specimen" | "analysis";
  multiline: boolean;
  placeholder: string;
}[] = [
  { key: "purpose", label: "Purpose", section: "overview", multiline: true, placeholder: "What the experiment set out to test" },
  { key: "keywords", label: "Keywords", section: "overview", multiline: false, placeholder: "Comma-separated, e.g. B cells, germinal centre, flow cytometry" },
  { key: "experimentVariables", label: "Experiment variables", section: "overview", multiline: true, placeholder: "e.g. Donor (D1, D2, D3); condition (treated, control)" },
  { key: "conclusions", label: "Conclusions", section: "overview", multiline: true, placeholder: "Summary of findings" },
  { key: "qualityControl", label: "Quality control", section: "overview", multiline: true, placeholder: "Replicates, calibration beads, FMO or isotype controls" },
  { key: "contact", label: "Contact", section: "overview", multiline: false, placeholder: "Name and e-mail for requests" },
  { key: "material", label: "Material", section: "specimen", multiline: false, placeholder: "e.g. peripheral blood mononuclear cells" },
  { key: "source", label: "Specimen source", section: "specimen", multiline: false, placeholder: "e.g. venous blood" },
  { key: "organism", label: "Organism", section: "specimen", multiline: false, placeholder: "e.g. Homo sapiens" },
  { key: "treatment", label: "Treatment", section: "specimen", multiline: true, placeholder: "Agents, concentrations and times" },
  { key: "reagents", label: "Reagents, analytes, detectors and reporters", section: "specimen", multiline: true, placeholder: "Where the $PnS label alone does not say what was measured" },
  { key: "dataAvailability", label: "List-mode data availability", section: "analysis", multiline: false, placeholder: "Repository and accession, or how to request the FCS files" },
];

/** True when no field holds anything. */
export function isEmptyMiflowcytAuthor(author: MiflowcytAuthorInput): boolean {
  return Object.values(author).every((v) => (Array.isArray(v) ? v.length === 0 : !v || !String(v).trim()));
}

/** The author items of a workspace JSON object, or an empty set when it has none. */
export function readMiflowcytAuthor(workspace: unknown): MiflowcytAuthorInput {
  if (!workspace || typeof workspace !== "object") return {};
  const raw = (workspace as Record<string, unknown>)[MIFLOWCYT_AUTHOR_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: MiflowcytAuthorInput = {};
  for (const { key } of MIFLOWCYT_AUTHOR_FIELDS) {
    const v = (raw as Record<string, unknown>)[key];
    if (key === "keywords") {
      if (Array.isArray(v) && v.every((s) => typeof s === "string")) out.keywords = v as string[];
    } else if (typeof v === "string") {
      out[key] = v;
    }
  }
  return out;
}

/** Keywords as the dialog holds them (one comma-separated line) and as the report takes them. */
export function splitKeywords(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}
