// LayoutCellPanelEditor.tsx — the Layout side panel for a cell panel: its title, tile size and
// exposure, the swap of rows and columns, the headers, labels and mask outline, then the columns
// (each channel in grey or its colour with its own gain, the merge and what it holds, the order)
// and the cells (their labels and order). Every change is a new recipe; nothing here decodes.

import type { CellPanelColumn, LayoutCellPanelRecipe } from "../engine/cellPanelBlock";
import { useI18n } from "./i18n";

export interface LayoutCellPanelEditorProps {
  readonly recipe: LayoutCellPanelRecipe;
  readonly onChange: (next: LayoutCellPanelRecipe) => void;
}

function move<T>(list: readonly T[], from: number, by: number): T[] {
  const to = from + by;
  if (to < 0 || to >= list.length) return list.slice();
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function LayoutCellPanelEditor({ recipe, onChange }: LayoutCellPanelEditorProps) {
  const { t } = useI18n();
  const set = (patch: Partial<LayoutCellPanelRecipe>) => onChange({ ...recipe, ...patch });
  const nameOf = (slot: number) => recipe.display.find((d) => d.slot === slot)?.name ?? `#${slot}`;
  const colourOf = (slot: number) => recipe.display.find((d) => d.slot === slot)?.colour ?? "#888";
  const setColumn = (index: number, patch: Partial<CellPanelColumn>) =>
    set({ columns: recipe.columns.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
  const used = new Set(recipe.columns.filter((c) => c.kind === "channel").map((c) => c.slot));
  const hasMerge = recipe.columns.some((c) => c.kind === "merge");
  const addable = recipe.display.filter((d) => !used.has(d.slot));

  return (
    <div className="gl-cellpanel-editor">
      <p className="gl-hint">{t("Cells from the Images tab as rows and image channels as columns; every part can be changed here. The pictures are drawn from the file's images.")}</p>
      <label className="gl-field-inline gl-layout-title-field">
        {t("Title")}
        <input value={recipe.title ?? ""} onChange={(event) => set({ title: event.target.value })} />
      </label>
      <label className="gl-field-inline">
        {t("Tile size")}
        <input type="number" min={16} max={240} value={recipe.tile} onChange={(event) => set({ tile: Math.max(16, Math.min(240, Math.round(Number(event.target.value) || 64))) })} />
      </label>
      <label className="gl-field-inline">
        {t("Exposure")}
        <input type="range" min={-2} max={2} step={0.05} value={Math.log2(recipe.exposure)} onChange={(event) => set({ exposure: Math.pow(2, Number(event.target.value)) })} />
      </label>
      <label className="gl-check">
        <input type="checkbox" checked={recipe.transpose === true} onChange={(event) => set({ transpose: event.target.checked })} />
        {t("Cells as columns")}
      </label>
      <label className="gl-check">
        <input type="checkbox" checked={recipe.showHeaders !== false} onChange={(event) => set({ showHeaders: event.target.checked })} />
        {t("Channel names")}
      </label>
      <label className="gl-check">
        <input type="checkbox" checked={recipe.showLabels !== false} onChange={(event) => set({ showLabels: event.target.checked })} />
        {t("Cell labels")}
      </label>
      <label className="gl-check">
        <input type="checkbox" checked={recipe.outline === true} onChange={(event) => set({ outline: event.target.checked })} />
        {t("Mask outline")}
      </label>

      <div className="gl-cellpanel-section">{t("Channels shown")}</div>
      <ol className="gl-cellpanel-list" aria-label={t("Channels shown")}>
        {recipe.columns.map((column, index) => (
          <li key={`${column.kind}-${column.slot ?? "m"}-${index}`} className={"gl-cellpanel-row" + (column.hidden ? " is-off" : "")}>
            <input
              type="checkbox"
              checked={!column.hidden}
              aria-label={t("Show {column}", { column: column.header || nameOf(column.slot ?? -1) })}
              title={t("Show this column")}
              disabled={!column.hidden && recipe.columns.filter((c) => !c.hidden).length <= 1}
              onChange={(event) => setColumn(index, { hidden: !event.target.checked })}
            />
            {column.kind === "channel" && column.slot !== undefined ? (
              <span className="gl-cell-chip" style={{ background: column.grey ? "#bdbdbd" : colourOf(column.slot) }} title={nameOf(column.slot)} />
            ) : (
              <span className="gl-cellpanel-merge-mark" title={t("Merge")}>+</span>
            )}
            <input
              className="gl-cellpanel-text"
              value={column.header}
              aria-label={t("Column name")}
              onChange={(event) => setColumn(index, { header: event.target.value })}
            />
            {column.kind === "channel" && column.slot !== undefined && (
              <>
                <label className="gl-check" title={t("Draw this channel in grey rather than its colour")}>
                  <input type="checkbox" checked={column.grey === true} onChange={(event) => setColumn(index, { grey: event.target.checked })} />
                  {t("Grey")}
                </label>
                <input
                  type="range"
                  min={-2}
                  max={2}
                  step={0.05}
                  aria-label={t("Brightness of {channel}", { channel: nameOf(column.slot) })}
                  title={t("Brightness of {channel}", { channel: nameOf(column.slot) })}
                  value={Math.log2(recipe.gain?.[column.slot] ?? 1)}
                  onChange={(event) => set({ gain: { ...(recipe.gain ?? {}), [column.slot!]: Math.pow(2, Number(event.target.value)) } })}
                />
              </>
            )}
            {column.kind === "merge" && (
              <span className="gl-cellpanel-merge">
                {recipe.display.map((d) => (
                  <label key={d.slot} className="gl-check" title={d.name}>
                    <input
                      type="checkbox"
                      checked={(column.slots ?? []).includes(d.slot)}
                      onChange={(event) => {
                        const slots = new Set(column.slots ?? []);
                        if (event.target.checked) slots.add(d.slot); else slots.delete(d.slot);
                        setColumn(index, { slots: recipe.display.map((x) => x.slot).filter((s) => slots.has(s)) });
                      }}
                    />
                    <span className="gl-cell-chip" style={{ background: d.colour }} />
                  </label>
                ))}
              </span>
            )}
            <button type="button" className="gl-mini-btn" title={t("Move up")} aria-label={t("Move up")} disabled={index === 0} onClick={() => set({ columns: move(recipe.columns, index, -1) })}>↑</button>
            <button type="button" className="gl-mini-btn" title={t("Move down")} aria-label={t("Move down")} disabled={index === recipe.columns.length - 1} onClick={() => set({ columns: move(recipe.columns, index, 1) })}>↓</button>
            {column.kind === "merge" && (
              <button type="button" className="gl-mini-btn" title={t("Remove")} aria-label={t("Remove")} onClick={() => set({ columns: recipe.columns.filter((_, i) => i !== index) })}>×</button>
            )}
          </li>
        ))}
      </ol>
      {(addable.length > 0 || !hasMerge) && (
        <select
          className="gl-cellpanel-add"
          value=""
          aria-label={t("Add a column")}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "merge") {
              set({ columns: [...recipe.columns, { kind: "merge", slots: recipe.display.filter((d) => d.enabled).map((d) => d.slot), header: t("Merge") }] });
            } else if (value) {
              const slot = Number(value);
              set({ columns: [...recipe.columns, { kind: "channel", slot, header: nameOf(slot) }] });
            }
          }}
        >
          <option value="">{t("Add a column…")}</option>
          {addable.map((d) => <option key={d.slot} value={String(d.slot)}>{d.name}</option>)}
          {!hasMerge && <option value="merge">{t("Merge")}</option>}
        </select>
      )}

      <div className="gl-cellpanel-section">{t("Cells shown")}</div>
      <ol className="gl-cellpanel-list" aria-label={t("Cells shown")}>
        {recipe.cells.map((cell, index) => (
          <li key={`${cell.event}-${index}`} className="gl-cellpanel-row">
            <input
              className="gl-cellpanel-text"
              value={cell.label}
              aria-label={t("Label of event {index}", { index: cell.event.toLocaleString() })}
              onChange={(event) => set({ cells: recipe.cells.map((c, i) => (i === index ? { ...c, label: event.target.value } : c)) })}
            />
            <button type="button" className="gl-mini-btn" title={t("Move up")} aria-label={t("Move up")} disabled={index === 0} onClick={() => set({ cells: move(recipe.cells, index, -1) })}>↑</button>
            <button type="button" className="gl-mini-btn" title={t("Move down")} aria-label={t("Move down")} disabled={index === recipe.cells.length - 1} onClick={() => set({ cells: move(recipe.cells, index, 1) })}>↓</button>
            <button type="button" className="gl-mini-btn" title={t("Remove")} aria-label={t("Remove")} disabled={recipe.cells.length <= 1} onClick={() => set({ cells: recipe.cells.filter((_, i) => i !== index) })}>×</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
