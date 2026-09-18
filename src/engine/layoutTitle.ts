// layoutTitle.ts — what a Layout plot is called. A sheet carries one template for all its plots,
// with placeholders for the population, the file, the sample id, the channels, the plot's own
// name and any metadata field; a plot may set its own instead. Without a template the title is
// whatever differs across the page: the population when the page is one file's populations, the
// file when it is one population's files, both otherwise.

export interface PlotTitleContext {
  population: string;
  /** The file's name, and its display id (the sample id when the metadata names one). */
  file: string;
  sample: string;
  x: string;
  y: string;
  /** The plot's own name where it came from, e.g. an Illustration plot's; the channels otherwise. */
  plot?: string;
  count?: number;
  metadata?: Readonly<Record<string, string>>;
  populationMetadata?: Readonly<Record<string, string>>;
}

export interface TitlePreset {
  id: string;
  label: string;
  template: string;
}

/** The template that means "what differs across the page". */
export const AUTOMATIC_TITLE = "";
/** The template for no title at all. */
export const NO_TITLE = "{none}";

export const TITLE_PRESETS: readonly TitlePreset[] = [
  { id: "auto", label: "What differs across the page", template: AUTOMATIC_TITLE },
  { id: "population", label: "Population", template: "{population}" },
  { id: "file", label: "File", template: "{file}" },
  { id: "sample", label: "Sample id", template: "{sample}" },
  { id: "population-file", label: "Population · file", template: "{population} · {file}" },
  { id: "population-plot", label: "Population · plot", template: "{population} · {plot}" },
  { id: "none", label: "No title", template: NO_TITLE },
];

export const TITLE_PLACEHOLDERS = "{population}, {file}, {sample}, {x}, {y}, {plot}, {count}, {meta:column}, {popmeta:field}";

/** A field the title builder offers: its placeholder, what the chip says, and what it belongs to. */
export interface TitleField {
  token: string;
  label: string;
  group: "population" | "file" | "plot";
}

/** The fields a workspace offers a title: the population and its metadata, the file and its metadata, the plot. */
export function titleFields(metadataColumns: readonly string[], populationMetadataFields: readonly string[]): TitleField[] {
  return [
    { token: "{population}", label: "Population", group: "population" },
    ...populationMetadataFields.map((field) => ({ token: `{popmeta:${field}}`, label: field, group: "population" as const })),
    { token: "{file}", label: "File", group: "file" },
    { token: "{sample}", label: "Sample id", group: "file" },
    ...metadataColumns.map((column) => ({ token: `{meta:${column}}`, label: column, group: "file" as const })),
    { token: "{plot}", label: "Plot", group: "plot" },
    { token: "{x}", label: "X", group: "plot" },
    { token: "{y}", label: "Y", group: "plot" },
    { token: "{count}", label: "Count", group: "plot" },
  ];
}

/** What can stand between the fields of a built title. */
export const TITLE_SEPARATORS: readonly { id: string; label: string; value: string }[] = [
  { id: "dot", label: "·", value: " · " },
  { id: "space", label: "space", value: " " },
  { id: "comma", label: ",", value: ", " },
  { id: "slash", label: "/", value: " / " },
  { id: "dash", label: "–", value: " – " },
];

export function templateFromFields(tokens: readonly string[], separator: string): string {
  return tokens.join(separator);
}

/**
 * The fields of a template the builder made: placeholders with one separator between them and
 * nothing else. Null for any other template, which the text field still edits.
 */
export function fieldsFromTemplate(template: string): { tokens: string[]; separator: string } | null {
  const tokens = template.match(/\{[^}]+\}/g) ?? [];
  if (!tokens.length) return null;
  const between = template.split(/\{[^}]+\}/);
  if (between[0] !== "" || between[between.length - 1] !== "") return null;
  const separators = between.slice(1, -1);
  const separator = separators[0] ?? " · ";
  if (separators.some((candidate) => candidate !== separator)) return null;
  return { tokens, separator };
}

/** What a plot's placeholders read, from the plot's recipe and what the app knows of its file and population. */
export function plotTitleContext(
  recipe: { xChannel?: string; yChannel?: string | null; label?: string },
  file: { name: string; fileName?: string; metadata?: Readonly<Record<string, string>> } | null,
  population: { id: string; name: string } | null,
  count?: number,
  populationMetadata?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): PlotTitleContext {
  return {
    population: population?.name ?? "",
    file: file?.fileName ?? file?.name ?? "",
    sample: file?.name ?? file?.fileName ?? "",
    x: recipe.xChannel ?? "",
    y: recipe.yChannel ?? "",
    ...(recipe.label ? { plot: recipe.label } : {}),
    ...(typeof count === "number" ? { count } : {}),
    ...(file?.metadata ? { metadata: file.metadata } : {}),
    ...(population && populationMetadata?.[population.id] ? { populationMetadata: populationMetadata[population.id] } : {}),
  };
}

/** A title from a template: placeholders filled, empty parts and their separators dropped. */
export function plotTitle(template: string, context: PlotTitleContext): string {
  if (template.trim() === NO_TITLE) return "";
  const filled = template.replace(/\{(population|file|sample|x|y|plot|count|meta:[^}]+|popmeta:[^}]+)\}/g, (whole, key: string) => {
    switch (key) {
      case "population": return context.population;
      case "file": return context.file;
      case "sample": return context.sample;
      case "x": return context.x;
      case "y": return context.y;
      case "plot": return context.plot ?? (context.y ? `${context.x} vs ${context.y}` : context.x);
      case "count": return typeof context.count === "number" ? context.count.toLocaleString() : "";
    }
    if (key.startsWith("meta:")) return context.metadata?.[key.slice(5)] ?? "";
    if (key.startsWith("popmeta:")) return context.populationMetadata?.[key.slice(8)] ?? "";
    return whole;
  });
  // A part that came out empty takes its separator with it: "Naive · " reads as "Naive".
  return filled
    .replace(/(\s*·\s*)+/g, " · ")
    .replace(/^\s*·\s*/, "")
    .replace(/\s*·\s*$/, "")
    .trim();
}

/**
 * The template for a page where none is set: what differs. One file's populations are told
 * apart by population, one population's files by file, anything else by both; a plot named
 * where it came from adds its name.
 */
export function automaticTitleTemplate(
  plots: readonly { sampleId: string; populationId: string; label?: string }[],
): string {
  const files = new Set(plots.map((plot) => plot.sampleId));
  const populations = new Set(plots.map((plot) => plot.populationId));
  const named = plots.some((plot) => plot.label);
  const base = files.size <= 1 && populations.size > 1
    ? "{population}"
    : populations.size <= 1 && files.size > 1
      ? "{file}"
      : "{population} · {file}";
  return named ? `${base} · {plot}` : base;
}
