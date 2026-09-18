import type { FigureSpec } from "./figure";
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const reference = (v: unknown) =>
  record(v) &&
  typeof v.hierarchyId === "string" &&
  typeof v.populationId === "string" &&
  typeof v.label === "string";
const positive = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Structural validation only. Missing files/populations remain repairable figure warnings. */
export function isFigureSpec(v: unknown): v is FigureSpec {
  if (
    !record(v) ||
    v.version !== 1 ||
    typeof v.name !== "string" ||
    !strings(v.sampleIds) ||
    new Set(v.sampleIds).size !== v.sampleIds.length ||
    !Array.isArray(v.populations) ||
    !v.populations.every(reference) ||
    !Array.isArray(v.plots) ||
    !v.plots.every(
      (p) =>
        record(p) &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.x === "string" &&
        typeof p.y === "string" &&
        ["biplot", "histogram", "heatmap"].includes(String(p.type)) &&
        (p.population === undefined || reference(p.population)),
    ) ||
    !strings(v.rows) ||
    !strings(v.columns) ||
    !strings(v.pages) ||
    !["separate", "overlay", "pool"].includes(String(v.composition)) ||
    !["shared", "individual", "gating"].includes(String(v.scalePolicy)) ||
    typeof v.showGates !== "boolean" ||
    !positive(v.panelSize) ||
    Number(v.panelSize) > 1000 ||
    !record(v.transforms)
  )
    return false;
  const dimensions = [...v.rows, ...v.columns, ...v.pages];
  if (
    v.overlayPopulations !== undefined &&
    typeof v.overlayPopulations !== "boolean"
  )
    return false;
  if (v.scalePolicyChosen !== undefined && typeof v.scalePolicyChosen !== "boolean") return false;
  if (v.labelOffsets !== undefined) {
    if (!record(v.labelOffsets)) return false;
    for (const offset of Object.values(v.labelOffsets as Record<string, unknown>))
      if (!Array.isArray(offset) || offset.length !== 2 || !offset.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  }
  if (
    new Set(dimensions).size !== dimensions.length ||
    !["samples", "populations", "plots"].every((d) => dimensions.includes(d)) ||
    dimensions.some(
      (d) =>
        !["samples", "populations", "plots"].includes(d) &&
        !d.startsWith("metadata:") &&
        !d.startsWith("popmeta:"),
    )
  )
    return false;
  if (
    new Set(v.plots.map((p) => (p as { id: string }).id)).size !==
    v.plots.length
  )
    return false;
  if (
    v.samplePopulations !== undefined &&
    (!record(v.samplePopulations) ||
      !Object.values(v.samplePopulations).every(
        (refs) => Array.isArray(refs) && refs.every(reference),
      ))
  )
    return false;
  if (
    v.populationOverrides !== undefined &&
    (!record(v.populationOverrides) ||
      !Object.values(v.populationOverrides).every(
        (refs) =>
          record(refs) &&
          Object.values(refs).every((id) => typeof id === "string"),
      ))
  )
    return false;
  return Object.values(v.transforms).every((spec) => {
    if (!record(spec)) return false;
    if (spec.kind === "identity") return true;
    if (spec.kind === "asinh") return positive(spec.cofactor);
    if (spec.kind === "logicle")
      return (
        positive(spec.T) &&
        positive(spec.M) &&
        typeof spec.W === "number" &&
        Number.isFinite(spec.W) &&
        spec.W >= 0 &&
        typeof spec.A === "number" &&
        Number.isFinite(spec.A) &&
        spec.A >= 0
      );
    if (spec.kind === "biex")
      return (
        ["maxValue", "pos", "channelRange"].every((k) => positive(spec[k])) &&
        ["neg", "widthBasis"].every(
          (k) => typeof spec[k] === "number" && Number.isFinite(spec[k]),
        )
      );
    if (spec.kind === "wsplog")
      return (
        positive(spec.decades) &&
        typeof spec.offset === "number" &&
        Number.isFinite(spec.offset)
      );
    return spec.kind === "flog" && positive(spec.T) && positive(spec.M);
  });
}
