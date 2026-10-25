import type { StrategyProposalSource, StrategyReview } from "../proposals/strategyProposal";
import { useI18n } from "./i18n";

/** The word a gate's badge and the review use for where a proposal came from. */
export function proposalSourceLabel(source: StrategyProposalSource | null): string {
  return source === "autogate" ? "autogate" : source === "host" ? "host" : source === "file" ? "file" : "agent";
}

/**
 * A strategy proposal from any source, as it would leave the gating: what it makes, what it changes
 * of what is there, and the counts of its new and target populations on a copy of the state.
 * Reading it changes nothing; Apply adds it as one undo step, Reject drops it.
 */
export function StrategyProposalReview({ review, note, busy, refused, onAccept, onReject }: {
  review: StrategyReview;
  /** Why the review is shown again, or why Apply did not go through. */
  note: string | null;
  busy: boolean;
  /** The proposal can no longer be applied (the note says why); only Close is offered. */
  refused?: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const { proposal, changes, base } = review;
  const steps = Array.isArray(proposal.steps) ? proposal.steps.length : 0;
  const labelsOf = new Map<string, string[]>();
  for (const [label, id] of Object.entries(review.targets)) labelsOf.set(id, [...(labelsOf.get(id) ?? []), label]);
  const shown = review.populations.filter((p) => p.isNew || p.isTarget);
  const named = (ids: string[], names: (id: string) => string | undefined) => ids.map((id) => names(id) ?? id).join(", ");
  const gateName = (id: string) => {
    const scopes = changes.scopedGateChanges.filter((g) => g.canonicalGateId === id);
    const name = base.gates[id]?.name;
    const shared = JSON.stringify(base.gates[id]) !== JSON.stringify(review.next.gates[id]);
    const labels = [...(shared ? [t("tree")] : []), ...scopes.map((g) => `${t(g.scope)}: ${g.ownerName}`)];
    return scopes.length ? `${name ?? id} (${labels.join(", ")})` : name;
  };
  const populationName = (id: string) => base.populations[id]?.name;
  const edited = changes.changedGateIds.length + changes.changedPopulationIds.length;
  const removed = changes.removedGateIds.length + changes.removedPopulationIds.length;
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal gl-strategy-review" role="dialog" aria-modal="true" aria-label={t("Strategy proposal")}>
        <div className="gl-modal-title">{t("Strategy proposal")}</div>
        <dl className="gl-strategy-review-meta">
          <dt>{t("Proposal source")}</dt><dd>{t(proposalSourceLabel(proposal.source))}</dd>
          <dt>{t("Proposed by")}</dt><dd>{proposal.by}</dd>
          <dt>{t("Rationale")}</dt><dd className="gl-strategy-review-rationale">{proposal.rationale}</dd>
        </dl>
        <div className="gl-modal-note">
          {t("{steps} steps · {gates} new gates · {populations} new populations · counted on {samples} samples", {
            steps, gates: changes.createdGateIds.length, populations: changes.createdPopulationIds.length, samples: review.sampleIds.length,
          })}
        </div>
        {edited > 0 && (
          <div className="gl-modal-warning" role="alert">
            {t("It changes gates or populations already there: {names}.", {
              names: [named(changes.changedGateIds, gateName), named(changes.changedPopulationIds, populationName)].filter(Boolean).join(", "),
            })}
          </div>
        )}
        {removed > 0 && (
          <div className="gl-modal-warning" role="alert">
            {t("It removes gates or populations already there: {names}.", {
              names: [named(changes.removedGateIds, gateName), named(changes.removedPopulationIds, populationName)].filter(Boolean).join(", "),
            })}
          </div>
        )}
        <div className="gl-strategy-review-table">
          <table>
            <thead>
              <tr><th>{t("Population")}</th><th>{t("Events")}</th><th>{t("% of parent")}</th><th>{t("Target")}</th></tr>
            </thead>
            <tbody>
              {shown.map((population) => (
                <tr key={population.id} className={population.isTarget ? "is-target" : undefined}>
                  <td style={{ paddingLeft: 4 + 12 * population.depth }}>{population.name}</td>
                  <td>{population.pooled.n.toLocaleString()}</td>
                  <td>{population.pooled.percentOfParent === null ? "—" : `${population.pooled.percentOfParent.toFixed(1)}%`}</td>
                  <td>{labelsOf.get(population.id)?.join(", ") ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="gl-modal-note">
          {t("Counts are pooled over the samples counted, on a copy of the gating. Nothing changes until the proposal is applied; Apply adds it as one step, which Undo removes.")}
        </p>
        {note && <div className="gl-modal-warning" role="status">{note}</div>}
        <div className="gl-modal-actions">
          <button type="button" className="gl-btn-ghost" disabled={busy} onClick={onReject}>{t(refused ? "Close" : "Reject")}</button>
          {!refused && <button type="button" className="gl-btn" disabled={busy} onClick={onAccept}>{t("Apply proposal")}</button>}
        </div>
      </div>
    </div>
  );
}
