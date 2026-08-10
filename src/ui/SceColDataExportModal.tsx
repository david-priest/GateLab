import { useMemo, useState } from "react";
import { populationTreeOrder } from "../engine/populations";
import type { CoreState } from "../store";

export interface ScePopulationColumnSpec {
  populationId: string;
  populationName: string;
  columnName: string;
  inLabel: string;
  outLabel: string;
}

function defaultColumnName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "population";
}

export function SceColDataExportModal({
  state,
  existingColumns,
  initialPopulationIds,
  busy,
  onCancel,
  onExport,
}: {
  state: CoreState;
  existingColumns: readonly string[];
  initialPopulationIds: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onExport: (
    columns: readonly ScePopulationColumnSpec[],
    overwrite: boolean,
  ) => void;
}) {
  const rootId = state.root_population_id;
  const populations = useMemo(
    () => populationTreeOrder(state.populations, rootId)
      .filter(({ popId }) => popId !== rootId)
      .map(({ popId, depth }) => ({
        popId,
        depth,
        name: state.populations[popId]?.name ?? popId,
      })),
    [rootId, state.populations],
  );
  const [selected, setSelected] = useState(
    () => new Set(initialPopulationIds.filter((id) => id !== rootId)),
  );
  const [columnNames, setColumnNames] = useState<Record<string, string>>(
    () => Object.fromEntries(
      populations.map(({ popId, name }) => [popId, defaultColumnName(name)]),
    ),
  );
  const [inLabel, setInLabel] = useState("TRUE");
  const [outLabel, setOutLabel] = useState("FALSE");
  const [overwrite, setOverwrite] = useState(false);
  const specs = populations
    .filter(({ popId }) => selected.has(popId))
    .map(({ popId, name }) => ({
      populationId: popId,
      populationName: name,
      columnName: (columnNames[popId] ?? "").trim(),
      inLabel: inLabel.trim(),
      outLabel: outLabel.trim(),
    }));
  const duplicateNames = new Set(
    specs
      .map(({ columnName }) => columnName)
      .filter((name, index, names) => names.indexOf(name) !== index),
  );
  const collisions = specs.filter(
    ({ columnName }) => existingColumns.includes(columnName),
  );
  const valid =
    specs.length > 0 &&
    specs.every(({ columnName }) => columnName.length > 0) &&
    duplicateNames.size === 0 &&
    inLabel.trim().length > 0 &&
    outLabel.trim().length > 0 &&
    inLabel.trim() !== outLabel.trim() &&
    (overwrite || collisions.length === 0);

  const toggle = (populationId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(populationId)) next.delete(populationId);
      else next.add(populationId);
      return next;
    });
  };

  return (
    <div className="gl-modal-backdrop">
      <div
        className="gl-modal gl-sce-coldata-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sce-coldata-title"
      >
        <div className="gl-modal-title" id="sce-coldata-title">
          Export population memberships to SCE
        </div>
        <div className="gl-modal-note">
          GateLab will save the current workspace first, then write exact full-data
          membership calls back to the original SingleCellExperiment event order.
        </div>
        <div className="gl-sce-coldata-toolbar">
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setSelected(new Set(populations.map(({ popId }) => popId)))}
          >
            All
          </button>
          <button
            type="button"
            className="gl-mini-btn"
            onClick={() => setSelected(new Set())}
          >
            None
          </button>
          <label>
            Inside
            <input value={inLabel} onChange={(event) => setInLabel(event.target.value)} />
          </label>
          <label>
            Outside
            <input value={outLabel} onChange={(event) => setOutLabel(event.target.value)} />
          </label>
        </div>
        <div className="gl-sce-coldata-list">
          {populations.map(({ popId, depth, name }) => {
            const columnName = columnNames[popId] ?? "";
            const collides = existingColumns.includes(columnName.trim());
            const duplicate = duplicateNames.has(columnName.trim());
            return (
              <div className="gl-sce-coldata-row" key={popId}>
                <label
                  className="gl-sce-coldata-pop"
                  style={{ paddingLeft: 8 + Math.max(0, depth - 1) * 12 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(popId)}
                    onChange={() => toggle(popId)}
                  />
                  <span title={name}>{name}</span>
                </label>
                <input
                  aria-label={`colData column for ${name}`}
                  disabled={!selected.has(popId)}
                  className={selected.has(popId) && (collides || duplicate) ? "has-warning" : ""}
                  value={columnName}
                  onChange={(event) => setColumnNames((current) => ({
                    ...current,
                    [popId]: event.target.value,
                  }))}
                />
              </div>
            );
          })}
        </div>
        {collisions.length > 0 && (
          <label className="gl-modal-check">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(event) => setOverwrite(event.target.checked)}
            />
            Overwrite existing colData column{collisions.length === 1 ? "" : "s"}:{" "}
            {collisions.map(({ columnName }) => columnName).join(", ")}
          </label>
        )}
        {duplicateNames.size > 0 && (
          <div className="gl-modal-warning" role="alert">
            Each exported population needs a unique colData column name.
          </div>
        )}
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="gl-btn"
            disabled={busy || !valid}
            onClick={() => onExport(specs, overwrite)}
          >
            {busy ? "Writing to SCE…" : `Export ${specs.length || ""} population${specs.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
