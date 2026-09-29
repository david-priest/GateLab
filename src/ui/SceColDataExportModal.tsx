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

/** Joins a population's name to the ancestor names that tell it apart: "CD4 T cells / Activated". */
const PATH_SEPARATOR = " / ";

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * Each population's default colData column name: its own name, verbatim. R accepts any string as a
 * column name (colData(sce)[["CD4-CD8+ T cells"]]), so no character is rewritten and no sign is
 * read into or out of a name. Populations that share a name are told apart by prefixing their
 * nearest ancestors' names up to the first that differs, joined with " / " ("CD4 T cells /
 * Activated", "CD8 T cells / Activated"). Populations whose ancestors carry the same names all the
 * way up, and any default that would repeat another population's, are numbered: "Activated (2)".
 *
 * `path` is the population's own name, then its parent's, up to but not including the root.
 */
function defaultColumnNames(
  populations: readonly { popId: string; path: readonly string[] }[],
): Record<string, string> {
  const byName = new Map<string, { popId: string; path: readonly string[] }[]>();
  for (const population of populations) {
    const group = byName.get(population.path[0]);
    if (group) group.push(population);
    else byName.set(population.path[0], [population]);
  }
  const labels = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length === 1) continue;
    const longest = Math.max(...group.map(({ path }) => path.length));
    for (const { popId, path } of group) {
      const others = group.filter((other) => !sameNames(other.path, path));
      let depth = 0;
      while (
        depth < longest &&
        others.some((other) => sameNames(other.path.slice(0, depth + 1), path.slice(0, depth + 1)))
      ) depth += 1;
      labels.set(popId, path.slice(0, depth + 1).reverse().join(PATH_SEPARATOR));
    }
  }
  // A name no other population shares is its default, so it is taken first and a prefixed or
  // numbered default can never displace it.
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const { popId, path } of populations) {
    if (labels.has(popId)) continue;
    names.set(popId, path[0]);
    taken.add(path[0]);
  }
  for (const { popId } of populations) {
    const label = labels.get(popId);
    if (label === undefined) continue;
    let name = label;
    for (let n = 2; taken.has(name); n += 1) name = `${label} (${n})`;
    names.set(popId, name);
    taken.add(name);
  }
  return Object.fromEntries(names);
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
  const populations = useMemo(() => {
    // The tree order is depth first, so a population's ancestors are the populations last listed
    // at each shallower depth.
    const namesAtDepth: string[] = [];
    return populationTreeOrder(state.populations, rootId).flatMap(({ popId, depth }) => {
      const name = state.populations[popId]?.name ?? popId;
      namesAtDepth.length = depth;
      namesAtDepth.push(name);
      if (popId === rootId) return [];
      return [{ popId, depth, name, path: namesAtDepth.slice(1).reverse() }];
    });
  }, [rootId, state.populations]);
  const [selected, setSelected] = useState(
    () => new Set(initialPopulationIds.filter((id) => id !== rootId)),
  );
  const [columnNames, setColumnNames] = useState<Record<string, string>>(
    () => defaultColumnNames(populations),
  );
  const [inLabel, setInLabel] = useState("TRUE");
  const [outLabel, setOutLabel] = useState("FALSE");
  const [overwrite, setOverwrite] = useState(false);
  const specs = populations
    .filter(({ popId }) => selected.has(popId))
    .map(({ popId, name }) => ({
      populationId: popId,
      populationName: name,
      columnName: columnNames[popId] ?? "",
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
    specs.every(({ columnName }) => columnName.trim().length > 0) &&
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
            const collides = existingColumns.includes(columnName);
            const duplicate = duplicateNames.has(columnName);
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
