import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { CoreState } from "../store";
import type { Gate, Population } from "../engine/models";
import { provenanceSource } from "../proposals/strategyProposal";
import { proposalSourceLabel } from "./StrategyProposalReview";
import { useI18n } from "./i18n";

/** Reads the current UI state only; opening details never dispatches a gating action. */
export function StrategyProposalDetails({ id, gate, state, labelForKey, countScope, onClose }: {
  id: string;
  gate: Gate;
  state: CoreState;
  labelForKey: (key: string) => string;
  countScope?: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const missing = t("Not recorded");
  const provenance = gate.provenance;
  const source = provenanceSource(provenance);
  const hierarchy = state.hierarchies.find(h => h.id === state.active_hierarchy_id);
  const uses = Object.values(state.populations).filter(p => p.gate_refs.some(ref => ref.gate_id === gate.gate_id));
  const populationPath = (id: string) => {
    const names: string[] = [];
    const visited = new Set<string>();
    let current: string | null = id;
    while (current && !visited.has(current)) {
      visited.add(current);
      const population: Population | undefined = state.populations[current];
      if (!population) { names.unshift(t("Unavailable parent")); break; }
      names.unshift(population.name);
      current = population.parent_id;
    }
    return names.join(" → ");
  };
  const coordinates = gate.gate_type === "quadrant" ? { center: gate.center, curl: gate.curl, arms: gate.arms }
    : gate.gate_type === "ellipse" ? { mean: gate.mean, covariance: gate.covariance, distance_square: gate.distance_square }
    : { vertices: gate.vertices, ...(gate.gate_type === "rectangle" ? { bounds: gate.bounds ?? "closed" } : {}) };
  return createPortal(
    <section id={id} ref={panel} tabIndex={-1} role="dialog" aria-modal="false" aria-label={t("Strategy proposal details")}
      className="gl-strategy-proposal-details"
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
      }}>
      <div className="gl-strategy-proposal-heading">
        <h3>{t("Strategy proposal details")}</h3>
        <button type="button" className="gl-mini-btn" onClick={onClose}>{t("Close")}</button>
      </div>
      <strong>{gate.name}</strong>
      <dl>
        <dt>{t("Proposal source")}</dt><dd>{source ? t(proposalSourceLabel(source)) : missing}</dd>
        <dt>{t("Proposed by")}</dt><dd>{provenance?.by || missing}</dd>
        <dt>{t("Created")}</dt><dd>{provenance?.at || missing}</dd>
        <dt>{t("Recorded rationale")}</dt><dd className="gl-strategy-proposal-rationale">{provenance?.rationale || missing}</dd>
      </dl>
      <p>{t("The rationale was supplied when this gate was created. It may not describe later edits. It is not a measured accuracy or confidence score.")}</p>
      <h4>{t("Current gate")}</h4>
      <dl>
        <dt>{t("X channel")}</dt><dd>{labelForKey(gate.x_channel)}{labelForKey(gate.x_channel) !== gate.x_channel && ` (${gate.x_channel})`}</dd>
        <dt>{t("Y channel")}</dt><dd>{labelForKey(gate.y_channel)}{labelForKey(gate.y_channel) !== gate.y_channel && ` (${gate.y_channel})`}</dd>
        <dt>{t("Coordinate space")}</dt><dd>{gate.space ?? missing}</dd>
        <dt>{t("Shape")}</dt><dd>{gate.gate_type}</dd>
        <dt>{t("Tree")}</dt><dd>{hierarchy?.name ?? missing}</dd>
        <dt>{t("Count scope")}</dt><dd>{countScope || t("Viewed file")}</dd>
        <dt>{t("Active population")}</dt><dd>{state.active_population_id ? populationPath(state.active_population_id) : missing}</dd>
      </dl>
      <h4>{t("Used by populations")}</h4>
      {uses.length ? <ul>{uses.map(population => <li key={population.population_id}>
        {populationPath(population.population_id)}
        {population.gate_refs.filter(ref => ref.gate_id === gate.gate_id).map((ref, index) => <span key={index}>
          {" · "}{ref.include ? t("included") : t("excluded")}{ref.quadrant != null && ` · Q${ref.quadrant}`}
        </span>)}
      </li>)}</ul> : <p>{t("This gate is not used by a population.")}</p>}
      <p>{t("Population counts include their ancestor gates. A gate's count on the current plot can differ from its population count.")}</p>
      <details>
        <summary>{t("Coordinates and recorded transforms")}</summary>
        <pre>{JSON.stringify({ ...coordinates, transforms: gate.transforms ?? null }, null, 2)}</pre>
        <p>{t("Model version, source inputs, edit history and reference-label accuracy are not recorded in this proposal metadata.")}</p>
      </details>
    </section>, document.body
  );
}
