// LayoutGeometryControls.tsx — the Layout tab's geometry controls: an item's X, Y, width and
// height in mm or px with a switch between them and a lock on its proportions; Match width,
// height and size and Arrange in grid for a selection; and Space with a typed gap beside the
// Distribute buttons. The geometry itself is in layoutGeometry.ts.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { layoutItemMinimum, type LayoutItem } from "../../engine/layout";
import { useI18n } from "../i18n";
import { NumberField } from "../NumberField";
import {
  defaultGridColumns,
  framePatch,
  pxToUnit,
  unitToPx,
  type FrameField,
  type GridOrder,
  type LengthUnit,
  type MatchHow,
  type SpaceDirection,
} from "./layoutGeometry";

/** What the tab remembers of these controls while it is open: the unit, the proportions lock and the last gap. */
export function useLayoutGeometryPrefs() {
  const [unit, setUnit] = useState<LengthUnit>("mm");
  const [keepRatio, setKeepRatio] = useState(false);
  const [gapMm, setGapMm] = useState(4);
  return { unit, setUnit, keepRatio, setKeepRatio, gapMm, setGapMm };
}
export type LayoutGeometryPrefs = ReturnType<typeof useLayoutGeometryPrefs>;

const FIELD_LABELS: Record<FrameField, string> = { x: "X", y: "Y", width: "Width", height: "Height" };

/** The selected item's X, Y, width and height in the chosen unit; a typed value is one commit. */
export function LayoutDimensionFields({
  item,
  prefs,
  onCommit,
}: Readonly<{
  item: Pick<LayoutItem, FrameField | "recipe">;
  prefs: LayoutGeometryPrefs;
  onCommit: (patch: Partial<Record<FrameField, number>>) => void;
}>) {
  const { t } = useI18n();
  const { unit, setUnit, keepRatio, setKeepRatio } = prefs;
  const minimum = layoutItemMinimum(item.recipe.kind);
  const field = (name: FrameField) => (
    <label key={name}>
      {t(FIELD_LABELS[name])} ({unit})
      <NumberField
        aria-label={`Item ${name}`}
        min={name === "width" || name === "height" ? pxToUnit(minimum[name], unit) : 0}
        step={unit === "mm" ? 0.1 : 1}
        value={pxToUnit(item[name], unit)}
        onCommit={(value) => onCommit(framePatch(item, name, unitToPx(value, unit), keepRatio))}
      />
    </label>
  );
  return (
    <>
      <div className="gl-layout-dimensions">
        {field("x")}
        {field("y")}
        {field("width")}
        {field("height")}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <label className="gl-check" title={t("Typing a width sets the height to keep the item's proportions, and the reverse; dragging a handle keeps them too, and Shift frees them")}>
          <input type="checkbox" checked={keepRatio} onChange={(event) => setKeepRatio(event.target.checked)} />
          {t("Keep proportions")}
        </label>
        <span role="group" aria-label={t("Unit")} style={{ display: "inline-flex", gap: 2 }}>
          {(["mm", "px"] as const).map((choice) => (
            <button key={choice} type="button" className="gl-mini-btn" aria-pressed={unit === choice} onClick={() => setUnit(choice)} title={t("Show X, Y, width and height in {unit}", { unit: choice })}>
              {choice}
            </button>
          ))}
        </span>
      </div>
    </>
  );
}

/** A button with a small popover under it that closes on Escape, on a click elsewhere, or on Apply. */
function PopoverButton({
  label,
  title,
  disabled,
  dialogLabel,
  children,
}: Readonly<{ label: string; title: string; disabled: boolean; dialogLabel: string; children: (close: () => void) => ReactNode }>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <span ref={root} style={{ position: "relative", display: "inline-flex" }}>
      <button className="gl-mini-btn" type="button" aria-expanded={open} disabled={disabled} onClick={() => setOpen((was) => !was)} title={title}>
        {label}
      </button>
      {open && (
        <div className="gl-menu-popover" role="dialog" aria-label={dialogLabel} style={{ display: "grid", gap: 6, padding: 8, minWidth: 200 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </span>
  );
}

function GapField({ prefs }: Readonly<{ prefs: LayoutGeometryPrefs }>) {
  const { t } = useI18n();
  return (
    <label className="gl-field-inline">
      {t("Gap (mm)")}
      <NumberField aria-label={t("Gap (mm)")} min={0} max={500} step={0.5} value={prefs.gapMm} onCommit={prefs.setGapMm} />
    </label>
  );
}

/** Match width, height and size, and Arrange in grid, for a selection of two or more items. */
export function LayoutSelectionGeometry({
  itemCount,
  unitCount,
  prefs,
  onMatch,
  onGrid,
}: Readonly<{
  /** Selected items that are not panel letters. */
  itemCount: number;
  /** Units the grid would move: groups once, locked items not at all. */
  unitCount: number;
  prefs: LayoutGeometryPrefs;
  onMatch: (how: MatchHow) => void;
  onGrid: (options: { columns: number; gapMm: number; order: GridOrder }) => void;
}>) {
  const { t } = useI18n();
  const reference = t("the item nearest the top left of the selection");
  const matches: { how: MatchHow; label: string; title: string }[] = [
    { how: "width", label: t("Match width"), title: t("Give each selected item the width of {reference}, keeping each top-left corner; locked items are not changed", { reference }) },
    { how: "height", label: t("Match height"), title: t("Give each selected item the height of {reference}, keeping each top-left corner; locked items are not changed", { reference }) },
    { how: "size", label: t("Match size"), title: t("Give each selected item the width and height of {reference}, keeping each top-left corner; locked items are not changed", { reference }) },
  ];
  return (
    <div className="gl-layout-item-actions">
      {matches.map(({ how, label, title }) => (
        <button key={how} type="button" className="gl-mini-btn" disabled={itemCount < 2} onClick={() => onMatch(how)} title={title}>{label}</button>
      ))}
      <PopoverButton
        label={t("Arrange in grid…")}
        dialogLabel={t("Arrange in grid")}
        title={t("Place the selected items in a grid in reading order, from the selection's top-left corner; locked items stay where they are")}
        disabled={unitCount < 2}
      >
        {(close) => <GridForm key={unitCount} count={unitCount} prefs={prefs} onApply={(options) => { onGrid(options); close(); }} />}
      </PopoverButton>
    </div>
  );
}

function GridForm({ count, prefs, onApply }: Readonly<{ count: number; prefs: LayoutGeometryPrefs; onApply: (options: { columns: number; gapMm: number; order: GridOrder }) => void }>) {
  const { t } = useI18n();
  const [columns, setColumns] = useState(defaultGridColumns(count));
  const [order, setOrder] = useState<GridOrder>("across");
  return (
    <>
      <label className="gl-field-inline">
        {t("Columns")}
        <NumberField aria-label={t("Columns")} integer min={1} max={Math.max(1, count)} value={columns} onCommit={setColumns} />
      </label>
      <GapField prefs={prefs} />
      <label className="gl-field-inline">
        {t("Order")}
        <select aria-label={t("Order")} value={order} onChange={(event) => setOrder(event.target.value as GridOrder)}>
          <option value="across">{t("Across, then down")}</option>
          <option value="down">{t("Down, then across")}</option>
        </select>
      </label>
      <div>
        <button type="button" className="gl-mini-btn" onClick={() => onApply({ columns, gapMm: prefs.gapMm, order })}>{t("Apply")}</button>
      </div>
    </>
  );
}

/** "Space…": the selection set at a typed gap across or down, the first item staying. */
export function LayoutSpaceButton({
  unitCount,
  disabled,
  prefs,
  onSpace,
}: Readonly<{ unitCount: number; disabled: boolean; prefs: LayoutGeometryPrefs; onSpace: (gapMm: number, direction: SpaceDirection) => void }>) {
  const { t } = useI18n();
  const [direction, setDirection] = useState<SpaceDirection>("across");
  return (
    <PopoverButton
      label={t("Space…")}
      dialogLabel={t("Space at a gap")}
      title={t("Space two or more items or groups at a typed gap; the first stays and each next one is put after the one before")}
      disabled={disabled || unitCount < 2}
    >
      {(close) => (
        <>
          <GapField prefs={prefs} />
          <label className="gl-field-inline">
            {t("Direction")}
            <select aria-label={t("Direction")} value={direction} onChange={(event) => setDirection(event.target.value as SpaceDirection)}>
              <option value="across">{t("Across")}</option>
              <option value="down">{t("Down")}</option>
            </select>
          </label>
          <div>
            <button type="button" className="gl-mini-btn" onClick={() => { onSpace(prefs.gapMm, direction); close(); }}>{t("Apply")}</button>
          </div>
        </>
      )}
    </PopoverButton>
  );
}
