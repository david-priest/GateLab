// Read-only feedback from the tab's cumulative memberships. No geometry is evaluated here.
import { createHash } from "node:crypto";

export const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
export const sampleManifest = (d) => ({
  samples: d.samples.map(({ id, name, events }) => ({ id, name, events })),
  channels: d.channels.map(({ key, transform }) => ({ key, transform })),
  assay: d.context?.assay ?? null,
});
export const manifestHash = (d) => sha256(sampleManifest(d));
/**
 * What a membership read depends on: the gating (the revision moves with every change to the core
 * state), the data and channel manifest, the samples' metadata and the assay. The view's axes and
 * ranges are left out, so panning between two reads does not refuse the call.
 */
export const snapshotKey = (d) => JSON.stringify({
  revision: d.revision, manifest: manifestHash(d),
  metadata: d.samples.map(({ id, metadata }) => [id, metadata ?? null]),
  assay: d.context?.assay ?? null,
});

export function populationChain(d, id) {
  const chain = [], seen = new Set();
  while (id !== null) {
    requireThat(!seen.has(id), "Population tree contains a cycle.");
    seen.add(id);
    const p = d.populations.find((p) => p.id === id);
    requireThat(p, `Unknown population ${id}.`);
    chain.unshift(p);
    id = p.parentId;
  }
  requireThat(chain[0]?.id === d.rootPopulationId, "Population is outside the active hierarchy.");
  return chain;
}

export function contextOf(d) {
  const chain = d.view.populationId ? populationChain(d, d.view.populationId) : [];
  return {
    revision: d.revision, host: d.host, sampleManifestSha256: manifestHash(d),
    samples: d.samples, channels: d.channels,
    activePopulationChain: chain,
    view: d.view,
    assay: d.context?.assay ?? null,
    plotSelection: d.context?.plot ?? null,
    gateVisibility: d.context?.gateVisibility ?? null,
    checkedSampleIds: d.samples.filter((s) => s.checked).map((s) => s.id),
    populationCountScope: "all-loaded-samples",
    gateCountScope: "geometry-within-active-population",
    warnings: [
      ...(!d.context ? ["This core does not expose plot pooling or assay binding; neither can be inferred from checked samples."] : []),
      "Population counts include the full ancestor chain. Gate-card counts test geometry inside the active displayed population and may differ.",
      "Selected or explicitly checked gates can be shown outside the active branch; branch-only visibility does not hide them.",
    ],
  };
}

function bits(mask, events, label) {
  requireThat(mask && mask.eventCount === events, `${label}: event count differs from the loaded sample.`);
  // R and MIME encoders commonly wrap long base64 strings at fixed columns.
  const value = typeof mask.membershipBitsBase64 === "string" ? mask.membershipBitsBase64.replace(/[\r\n\t ]/g, "") : mask.membershipBitsBase64;
  requireThat(typeof value === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), `${label}: invalid base64 mask.`);
  const packed = Buffer.from(value, "base64");
  requireThat(packed.length === Math.ceil(events / 8), `${label}: packed mask length differs.`);
  requireThat(!events || events % 8 === 0 || (packed.at(-1) >> (events % 8)) === 0, `${label}: nonzero padding bits.`);
  return packed;
}
const has = (mask, i) => (mask[i >> 3] >> (i % 8)) & 1;
const ratio = (a, b) => b ? a / b : null;
function metrics({ n, tp, fp, fn, tn }) {
  return { n, tp, fp, fn, tn, selected: tp + fp, targets: tp + fn,
    prevalence: ratio(tp + fn, n), precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn), falsePositiveRate: ratio(fp, fp + tn),
    abundanceBiasPercentagePoints: n ? 100 * (fp - fn) / n : null,
  };
}
const add = (rows) => rows.reduce((a, r) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + r[key]])), { n: 0, tp: 0, fp: 0, fn: 0, tn: 0 });

export function evaluateMemberships(d, memberships, reference, args) {
  requireThat(memberships.revision === d.revision, "The gating changed while reading feedback; describe again.");
  requireThat(reference?.format === "gatelab-reference-masks" && reference.version === 1, "Expected gatelab-reference-masks version 1.");
  requireThat(typeof reference.label === "string" && reference.label.trim(), "The reference needs a label.");
  requireThat(reference.eventOrder === "as-loaded", "Reference eventOrder must explicitly be as-loaded.");
  requireThat(reference.sampleManifestSha256 === manifestHash(d), "Reference sample manifest differs from the loaded data, channels or assay.");
  for (const key of ["populationIds", "sampleIds"]) {
    requireThat(Array.isArray(args[key]) && args[key].length > 0 && args[key].every((id) => typeof id === "string" && id), `${key} must be a nonempty list of ids.`);
    requireThat(new Set(args[key]).size === args[key].length, `${key} contains duplicates.`);
  }
  requireThat(args.projectedPrevalence === undefined || (typeof args.projectedPrevalence === "number" && args.projectedPrevalence >= 0 && args.projectedPrevalence <= 1), "projectedPrevalence must be between 0 and 1.");
  requireThat(Array.isArray(reference.sampleMasks), "Reference sampleMasks must be an array.");
  requireThat(new Set(reference.sampleMasks.map((m) => m.sampleId)).size === reference.sampleMasks.length, "Duplicate reference sample masks.");
  const samples = args.sampleIds.map((id) => {
    const s = d.samples.find((s) => s.id === id);
    requireThat(s, `Unknown sample ${id}.`);
    if (args.groupBy !== undefined) requireThat(typeof args.groupBy === "string" && Object.hasOwn(s.metadata ?? {}, args.groupBy) && typeof s.metadata[args.groupBy] === "string" && s.metadata[args.groupBy].trim(), `Missing grouping metadata ${args.groupBy} on ${id}.`);
    const r = reference.sampleMasks.find((m) => m.sampleId === id);
    return { ...s, target: bits(r, s.events, `Reference ${id}`) };
  });
  const rows = [], stageRows = [], excluded = [];
  for (const id of args.populationIds) {
    const chain = populationChain(d, id);
    for (const sample of samples) {
      const masks = chain.map((p) => {
        const candidates = memberships.populations.filter((m) => m.id === p.id);
        requireThat(candidates.length === 1, `Missing or ambiguous membership for ${p.id}.`);
        const ms = candidates[0].sampleMasks.filter((m) => m.sampleId === sample.id);
        requireThat(ms.length === 1, `Missing or ambiguous sample mask for ${p.id}/${sample.id}.`);
        return ms[0];
      });
      const unavailable = masks.find((m) => m.notEvaluated);
      if (unavailable) { excluded.push({ populationId: id, sampleId: sample.id, reason: unavailable.notEvaluated }); continue; }
      const packed = masks.map((m) => bits(m, sample.events, `Population ${id}/${sample.id}`));
      let counts = { n: sample.events, tp: 0, fp: 0, fn: 0, tn: 0 };
      const stages = chain.map((p) => ({ populationId: p.id, parentId: p.parentId, selected: 0, targetRetained: 0, targetLostAtStage: 0 }));
      let targets = 0;
      for (let e = 0; e < sample.events; e++) {
        const target = has(sample.target, e), selected = has(packed.at(-1), e);
        counts[target ? selected ? "tp" : "fn" : selected ? "fp" : "tn"]++;
        targets += target;
        let parent = 1;
        packed.forEach((mask, j) => {
          const inside = has(mask, e);
          requireThat(!inside || parent, `Membership ${chain[j].id} is not nested in its parent.`);
          stages[j].selected += inside;
          stages[j].targetRetained += target && inside ? 1 : 0;
          stages[j].targetLostAtStage += target && parent && !inside ? 1 : 0;
          parent = inside;
        });
      }
      rows.push({ populationId: id, series: sample.id, ...(args.groupBy ? { group: sample.metadata[args.groupBy] } : {}), ...metrics(counts) });
      stageRows.push(...stages.map((s) => ({ evaluatedPopulationId: id, series: sample.id, ...s, targets, targetLostCumulative: targets - s.targetRetained })));
    }
  }
  const pooled = args.populationIds.map((id) => ({ populationId: id, series: "pooled", ...metrics(add(rows.filter((r) => r.populationId === id))) }));
  const grouped = args.groupBy ? args.populationIds.flatMap((id) => [...new Set(rows.filter((r) => r.populationId === id).map((r) => r.group))].map((group) => ({ populationId: id, group, ...metrics(add(rows.filter((r) => r.populationId === id && r.group === group))) }))) : [];
  const stages = args.populationIds.flatMap((id) => populationChain(d, id).map((p) => {
    const rs = stageRows.filter((s) => s.evaluatedPopulationId === id && s.populationId === p.id);
    return { evaluatedPopulationId: id, populationId: p.id, parentId: p.parentId, series: "pooled", ...Object.fromEntries(["selected", "targets", "targetRetained", "targetLostAtStage", "targetLostCumulative"].map((k) => [k, rs.reduce((a, r) => a + r[k], 0)])) };
  }));
  return {
    revision: d.revision, label: reference.label, sampleManifestSha256: manifestHash(d),
    sampleIds: args.sampleIds, denominator: "all events in the explicitly selected samples", exact: true,
    pooled, perSample: rows, grouped, stages, perSampleStages: stageRows, excluded,
    ...(args.projectedPrevalence === undefined ? {} : { projected: pooled.map((r) => ({ populationId: r.populationId, prevalence: args.projectedPrevalence, precision: r.recall === null || r.falsePositiveRate === null ? null : ratio(r.recall * args.projectedPrevalence, r.recall * args.projectedPrevalence + r.falsePositiveRate * (1 - args.projectedPrevalence)) })) }),
    warnings: [
      "Reference labels are supplied annotations, not independently established biological truth.",
      "Manifest and mask lengths are checked. Event identity and order within each sample remain the reference producer's responsibility.",
      ...(excluded.length ? ["Unevaluated sample/population pairs are excluded from numerator and denominator; they are not zero selections."] : []),
      ...(args.projectedPrevalence === undefined ? [] : ["Projected precision assumes unchanged sensitivity and false-positive rate at the stated prevalence."]),
    ],
  };
}
