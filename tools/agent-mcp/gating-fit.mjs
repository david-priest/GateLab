// The external agent proposes revisions; this bounded session supplies native-core feedback.
// Validation is read once at finish, after which the session cannot accept further candidates.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { evaluateMemberships, manifestHash, populationChain, sha256 } from "./feedback.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const nonempty = (v, label) => { if (typeof v !== "string" || !v.trim()) throw new Error(`${label} is required.`); return v; };
const ids = (v, label, all, required = true) => {
  if (!Array.isArray(v) || (required && !v.length) || v.some((id) => typeof id !== "string" || !all.has(id)) || new Set(v).size !== v.length) throw new Error(`${label} must explicitly name unique loaded samples.`);
  return [...v];
};

/**
 * What a candidate's scores depend on: the live tree (its populations and their gates' geometry), the
 * data and channel manifest, the samples' metadata and the assay. The revision moves with every new
 * core state, selecting a population or gate included, so it is not compared, nor are the viewed and
 * checked flags, the plot pool or the gate visibility: a search used to end when the user clicked a
 * population in the tab.
 */
const scoringKey = (d) => JSON.stringify({
  root: d.rootPopulationId,
  populations: d.populations.map(({ id, name, parentId, gates }) => ({ id, name, parentId, gates })),
  gates: d.gates,
  manifest: manifestHash(d),
  metadata: d.samples.map(({ id, metadata }) => [id, metadata ?? null]),
  assay: d.context?.assay ?? null,
});

export function createGatingFit(relay) {
  let session = null;
  const requireSession = () => { if (!session || session.closed) throw new Error("Start a new gating fit; this session is absent or frozen."); return session; };
  const publish = async (s, message, status = "searching") => relay.call("gatingTask", { id: s.id, mode: s.mode, target: s.target, status, candidates: s.candidates.length, budget: s.budget, message });
  const check = async (s) => {
    const d = await relay.call("describe", {});
    if (scoringKey(d) !== scoringKey(s.base)) throw new Error("Data, assay, sample metadata or the live gating changed. Start a new fit from the current state.");
    if (d.gatingTask?.id !== s.id || d.gatingTask?.status !== "searching") throw new Error("The user ended or replaced this search.");
    return d;
  };
  const score = (s, proposal, targets, sampleIds) => s.references.map((ref) => {
    const id = targets[ref.key];
    if (typeof id !== "string") throw new Error(`Missing target population for ${ref.key}.`);
    const resolved = proposal.aliases[id] ?? id;
    const result = evaluateMemberships(proposal.describe, proposal.memberships, ref.value, { populationIds: [resolved], sampleIds, ...(s.groupBy ? { groupBy: s.groupBy } : {}) });
    const row = result.pooled[0];
    if (row.n !== sampleIds.reduce((n, id) => n + s.base.samples.find((sample) => sample.id === id).events, 0)) throw new Error("A selected sample is unavailable for feedback; partial scores cannot select a candidate.");
    return { key: ref.key, referenceSha256: ref.sha256, ...result };
  });
  const quality = (s, scores, complexity) => {
    const rows = scores.map((r) => r.pooled[0]);
    const eligible = rows.length > 0 && rows.every((r) => r.targets > 0 && Number.isFinite(r[s.objective]) && (s.minPrecision === null || r.precision >= s.minPrecision));
    return { eligible, value: eligible ? rows.reduce((n, r) => n + r[s.objective], 0) / rows.length - s.complexityPenalty * complexity.gates : null };
  };
  const preview = async (s, candidate, sampleIds) => {
    // The tab's revision now: the tree is the baseline's (check), whatever was clicked since.
    const d = await check(s);
    const result = await relay.call("proposal", { expectedRevision: d.revision, steps: candidate.steps, populationIds: Object.values(candidate.targets), sampleIds });
    await check(s);
    return result;
  };
  const log = async (s, event, fields) => appendFile(s.historyPath, JSON.stringify({ event, at: new Date().toISOString(), sessionId: s.id, ...fields }) + "\n", { mode: 0o600 });
  const tools = [
    {
      name: "gatelab_fit_start",
      description: "Start an explained gating search in population mode (known/user-described phenotype; no label scores) or cluster mode (explicit aligned references and training feedback). Fix the budget, objective and disjoint training/validation samples now. All candidates are previews; none changes live gates. The external agent proposes the revisions. A new history file is mandatory; final test samples must be excluded from both selections.",
      inputSchema: { type: "object", properties: {
        mode: { enum: ["population", "cluster"] }, target: { type: "string" }, budget: { type: "integer", minimum: 1, maximum: 100 },
        historyPath: { type: "string", description: "New absolute JSONL path, never overwritten." },
        trainingSampleIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true }, validationSampleIds: { type: "array", items: { type: "string" }, uniqueItems: true },
        references: { type: "array", items: { type: "object", properties: { key: { type: "string" }, path: { type: "string" } }, required: ["key", "path"], additionalProperties: false }, maxItems: 128 },
        objective: { enum: ["f1", "precision", "recall"] }, minPrecision: { type: "number", minimum: 0, maximum: 1 }, complexityPenalty: { type: "number", minimum: 0, maximum: 1 }, groupBy: { type: "string" },
      }, required: ["mode", "target", "budget", "historyPath", "trainingSampleIds"], additionalProperties: false },
      async run(args) {
        if (session && !session.closed) {
          const current = await relay.call("describe", {});
          if (current.gatingTask?.id === session.id && current.gatingTask.status === "cancelled") { session.closed = true; await log(session, "cancelled", { by: "user" }); }
          else throw new Error("Finish or cancel the current fit before starting another.");
        }
        if (!["population", "cluster"].includes(args.mode)) throw new Error("Choose population or cluster mode.");
        nonempty(args.target, "Target definition");
        if (!Number.isSafeInteger(args.budget) || args.budget < 1 || args.budget > 100) throw new Error("Budget must be 1–100 candidates.");
        if (typeof args.historyPath !== "string" || !isAbsolute(args.historyPath)) throw new Error("historyPath must be absolute.");
        const base = await relay.call("describe", {}), all = new Set(base.samples.map((s) => s.id));
        const training = ids(args.trainingSampleIds, "trainingSampleIds", all);
        const validation = ids(args.validationSampleIds ?? [], "validationSampleIds", all, false);
        if (training.some((id) => validation.includes(id))) throw new Error("Training and validation samples overlap.");
        if (args.groupBy !== undefined) {
          nonempty(args.groupBy, "Grouping metadata");
          const groups = (selected) => selected.map((id) => nonempty(base.samples.find((s) => s.id === id).metadata?.[args.groupBy], `Grouping metadata on ${id}`));
          const trainGroups = groups(training), validationGroups = groups(validation);
          if (trainGroups.some((group) => validationGroups.includes(group))) throw new Error("Training and validation grouping values overlap; split whole donors/groups.");
        }
        if (!["f1", "precision", "recall"].includes(args.objective ?? "f1") || (args.minPrecision !== undefined && !(Number.isFinite(args.minPrecision) && args.minPrecision >= 0 && args.minPrecision <= 1)) || (args.complexityPenalty !== undefined && !(Number.isFinite(args.complexityPenalty) && args.complexityPenalty >= 0 && args.complexityPenalty <= 1))) throw new Error("Invalid objective or constraints.");
        const references = [];
        if (args.mode === "cluster") {
          if (!validation.length) throw new Error("Cluster mode requires separate validation samples.");
          if (!Array.isArray(args.references) || !args.references.length || args.references.length > 128) throw new Error("Cluster mode requires 1–128 reference masks.");
          for (const ref of args.references) {
            nonempty(ref.key, "Reference key");
            if (references.some((r) => r.key === ref.key) || !isAbsolute(ref.path)) throw new Error("References need unique keys and absolute paths.");
            const text = await readFile(ref.path, "utf8"), value = JSON.parse(text);
            if (value.sampleManifestSha256 !== manifestHash(base)) throw new Error("Reference manifest does not match the loaded data.");
            references.push({ key: ref.key, path: ref.path, value, sha256: sha256(text) });
          }
        } else if (args.references?.length || validation.length) throw new Error("Population mode uses phenotype review, without cluster references or validation scores.");
        const s = { id: randomUUID(), mode: args.mode, target: args.target, budget: args.budget, historyPath: args.historyPath, training, validation, references, base: clone(base), objective: args.objective ?? "f1", minPrecision: args.minPrecision ?? null, complexityPenalty: args.complexityPenalty ?? 0, groupBy: args.groupBy, candidates: [], closed: false };
        await mkdir(dirname(s.historyPath), { recursive: true });
        await writeFile(s.historyPath, JSON.stringify({ event: "start", at: new Date().toISOString(), format: "gatelab-gating-fit", version: 1, sessionId: s.id, config: args, sampleManifestSha256: manifestHash(base), baseline: base, references: references.map(({ value, ...r }) => r), sourceSha256: sha256(await readFile(new URL(import.meta.url), "utf8")) }) + "\n", { flag: "wx", mode: 0o600 });
        session = s;
        try { await publish(s, "Ready for read-only proposals. Live gates are unchanged."); }
        catch (error) { s.closed = true; await log(s, "failed", { message: String(error) }); throw error; }
        return { sessionId: s.id, mode: s.mode, budget: s.budget, excludedSampleIds: base.samples.filter((sample) => !training.includes(sample.id) && !validation.includes(sample.id)).map((sample) => sample.id), historyPath: s.historyPath };
      },
    },
    {
      name: "gatelab_fit_candidate",
      description: "Preview a complete candidate tree, returning training-only feedback and ancestor losses. Supply every command from the unchanged baseline; later ID fields may reference @stepKey.population or @stepKey.gate. Each candidate needs a rationale and target mapping. Revise bounds, pairs or simple polygon vertices in response to errors; every candidate consumes the fixed budget and is retained. No live gate application occurs.",
      inputSchema: { type: "object", properties: { rationale: { type: "string" }, steps: { type: "array", maxItems: 128, description: "At most 128 steps, or fewer where the tab sets a lower limit; the refusal names the limit in force.", items: { type: "object", properties: { key: { type: "string" }, command: { type: "object" } }, required: ["key", "command"], additionalProperties: false } }, targets: { type: "object", additionalProperties: { type: "string" }, description: "Reference key → final population ID/reference in cluster mode; descriptive key → population in population mode." } }, required: ["rationale", "steps", "targets"], additionalProperties: false },
      async run(args) {
        const s = requireSession();
        if (s.candidates.length >= s.budget) throw new Error("Candidate budget exhausted; finish or cancel this fit.");
        nonempty(args.rationale, "Candidate rationale");
        if (!args.targets || Array.isArray(args.targets) || typeof args.targets !== "object" || !Object.keys(args.targets).length || Object.keys(args.targets).length > 128 || Object.values(args.targets).some((id) => typeof id !== "string" || !id)) throw new Error("Explicit target populations are required.");
        if (s.mode === "cluster" && JSON.stringify(Object.keys(args.targets).sort()) !== JSON.stringify(s.references.map((r) => r.key).sort())) throw new Error("Targets must match the declared reference keys.");
        const candidate = clone({ id: s.candidates.length + 1, rationale: args.rationale, steps: args.steps, targets: args.targets });
        await check(s);
        let p;
        try { p = await preview(s, candidate, s.training); }
        catch (error) {
          const failed = { ...candidate, error: String(error) };
          await log(s, "candidate-refused", failed); s.candidates.push(failed);
          await publish(s, `Candidate ${candidate.id} refused; the reason is retained in history. Live gates are unchanged.`);
          throw error;
        }
        const targetIds = p.populationIds;
        const chains = targetIds.map((id) => populationChain(p.describe, id));
        const gateIds = [...new Set(chains.flatMap((c) => c.flatMap((p) => p.gates.map((g) => g.gateId))))];
        const complexity = { gates: gateIds.length, maxDepth: Math.max(...chains.map((c) => c.length - 1)), markers: [...new Set(p.describe.gates.filter((g) => gateIds.includes(g.id)).flatMap((g) => [g.x, g.y]))].length };
        const feedback = s.mode === "cluster" ? score(s, p, candidate.targets, s.training) : null;
        const result = { ...candidate, complexity, training: feedback, quality: feedback ? quality(s, feedback, complexity) : null, populations: p.describe.populations.filter((pop) => targetIds.includes(pop.id)), gates: p.describe.gates.filter((g) => gateIds.includes(g.id)) };
        await log(s, "candidate", result);
        s.candidates.push(result);
        await publish(s, `Candidate ${candidate.id}/${s.budget}: ${feedback ? `training ${s.objective} objective ${result.quality.value?.toFixed(3) ?? "unavailable"}` : "phenotype proposal ready for inspection"}. ${complexity.gates} gates; depth ${complexity.maxDepth}.`);
        return result;
      },
    },
    {
      name: "gatelab_fit_finish",
      description: "Freeze a proposal for human review. Cluster mode scores the retained candidates on validation once and selects by the predeclared macro objective minus gate penalty, subject to minimum precision. No more revisions are accepted afterwards. Population mode requires the agent/user-selected candidate ID and reports no concordance. Returns the original commands with aliases for review/application through the existing workflow; it does not apply them.",
      inputSchema: { type: "object", properties: { candidateId: { type: "integer", minimum: 1 }, rationale: { type: "string" } }, required: ["rationale"], additionalProperties: false },
      async run(args) {
        const s = requireSession(); await check(s); nonempty(args.rationale, "Selection rationale");
        const valid = s.candidates.filter((c) => !c.error);
        if (!valid.length) throw new Error("No valid candidates have been previewed.");
        if (s.mode === "cluster" && args.candidateId !== undefined) throw new Error("Cluster selection follows the declared validation objective.");
        if (s.mode === "population" && !valid.some((c) => c.id === args.candidateId)) throw new Error("Select a valid candidateId for phenotype review.");
        // Close before reading validation, including if a later validation read fails.
        s.closed = true;
        const validation = [];
        try {
          if (s.mode === "cluster") for (const candidate of valid) {
            const p = await preview(s, candidate, s.validation);
            const feedback = score(s, p, candidate.targets, s.validation);
            validation.push({ candidateId: candidate.id, feedback, ...quality(s, feedback, candidate.complexity) });
          }
          const ranked = validation.filter((r) => r.eligible).sort((a,b) => b.value - a.value || s.candidates[a.candidateId - 1].complexity.gates - s.candidates[b.candidateId - 1].complexity.gates || a.candidateId - b.candidateId);
          const chosen = s.mode === "population" ? args.candidateId : ranked[0]?.candidateId;
          if (!chosen) throw new Error("No candidate met the validation constraints; the session is closed. Retain this failure before designing a new experiment.");
          const result = { format: "gatelab-frozen-proposal", version: 1, sessionId: s.id, mode: s.mode, target: s.target, baseRevision: s.base.revision, sampleManifestSha256: manifestHash(s.base), selected: s.candidates[chosen - 1], validation, rationale: args.rationale, applied: false, historyPath: s.historyPath };
          await log(s, "frozen", result);
          await publish(s, `Candidate ${chosen} frozen for review. Live gates are unchanged.`, "review");
          return result;
        } catch (error) { await log(s, "failed", { message: String(error), validation }); await publish(s, "Search stopped; inspect the retained failure before starting again.", "cancelled"); throw error; }
      },
    },
    {
      name: "gatelab_fit_cancel", description: "End the search, retaining its history and leaving live gates unchanged.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() { const s = requireSession(); s.closed = true; await log(s, "cancelled", {}); await publish(s, "Search ended; live gates are unchanged.", "cancelled"); return { cancelled: true, historyPath: s.historyPath }; },
    },
  ];
  /**
   * Why gatelab_evaluate may not score these samples now, or null. While a cluster fit searches,
   * only its training samples may be scored: validation is read once, at finish, and samples in
   * neither list are held out. `described` is the tab's describe, whose gatingTask says whether the
   * user ended the search from the Agent menu.
   */
  const evaluationRefusal = (sampleIds, described) => {
    const s = session;
    if (!s || s.closed || s.mode !== "cluster") return null;
    if (described?.gatingTask?.id !== s.id || described.gatingTask.status !== "searching") return null;
    const outside = (Array.isArray(sampleIds) ? sampleIds : []).filter((id) => !s.training.includes(id));
    return outside.length
      ? `A cluster fit is searching: gatelab_evaluate scores only its training samples (${s.training.join(", ")}) until gatelab_fit_finish or gatelab_fit_cancel. Not scored now: ${outside.join(", ")}.`
      : null;
  };
  return { tools, evaluationRefusal };
}
