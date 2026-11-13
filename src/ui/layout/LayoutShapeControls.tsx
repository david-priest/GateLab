// LayoutShapeControls.tsx — the Layout tab's controls for lines and shapes: the "+ Shape" menu
// (and the same entries for the page's own menu), which arm the pointer to draw one, and the
// inspector's fields for the selected shapes, each field shown when a selected shape has it and
// set on every selected shape that has it.

import {
  LAYOUT_BRACKET_SIDES,
  LAYOUT_SHAPE_ARROWS,
  LAYOUT_SHAPE_CORNERS,
  LAYOUT_SHAPE_DASHES,
  SHAPE_BRACKET_ENDS_RANGE,
  SHAPE_CORNER_RADIUS_RANGE,
  SHAPE_STROKE_WIDTH_RANGE,
  type LayoutShapeRecipe,
} from "../../engine/shapeBlock";
import type { LayoutItem } from "../../engine/layout";
import { MenuButton, type MenuEntry } from "../MenuButton";
import { NumberField } from "../NumberField";
import { useI18n } from "../i18n";
import { shapeHasField, SHAPE_TOOLS, type ShapeTool } from "./shapeGeometry";

type Translate = (source: string, values?: Readonly<Record<string, string | number>>) => string;

export const SHAPE_TOOL_LABELS: Record<ShapeTool, string> = {
  line: "Line",
  arrow: "Arrow",
  bracket: "Bracket",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
};

/** What the item list and the export call a shape. */
export function shapeTitle(recipe: LayoutShapeRecipe): string {
  if (recipe.shape === "line") return recipe.arrows && recipe.arrows !== "none" ? "Arrow" : "Line";
  return SHAPE_TOOL_LABELS[recipe.shape];
}

/** The selected items that are shapes. */
export function shapeItems(items: readonly LayoutItem[]): (LayoutItem & { recipe: LayoutShapeRecipe })[] {
  return items.filter((item): item is LayoutItem & { recipe: LayoutShapeRecipe } => item.recipe.kind === "shape");
}

/** The shape entries of a menu: one per tool, each arming it; the armed one ticked. */
function shapeEntries(t: Translate, armed: ShapeTool | null, onArm: (tool: ShapeTool) => void): MenuEntry[] {
  return SHAPE_TOOLS.map((tool) => ({
    label: t(SHAPE_TOOL_LABELS[tool]),
    className: `gl-layout-shape-tool-${tool}`,
    checked: armed === tool,
    onClick: () => onArm(tool),
  }));
}

/** The blank page's menu entries for shapes, after a separator and under their heading. */
export function shapeMenuEntries(t: Translate, armed: ShapeTool | null, onArm: (tool: ShapeTool) => void): MenuEntry[] {
  return ["separator", { section: t("+ Shape") }, ...shapeEntries(t, armed, onArm)];
}

/** The toolbar's "+ Shape" menu. */
export function LayoutShapeMenu({ armed, onArm }: Readonly<{ armed: ShapeTool | null; onArm: (tool: ShapeTool) => void }>) {
  const { t } = useI18n();
  return (
    <MenuButton
      label={t("+ Shape")}
      className="gl-layout-shape-menu"
      title={t("Draw a line, arrow, bracket, rectangle or ellipse: choose one, then drag on the page")}
      items={shapeEntries(t, armed, onArm)}
    />
  );
}

const DASH_LABELS: Record<LayoutShapeRecipe["dash"], string> = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" };
const ARROW_LABELS: Record<NonNullable<LayoutShapeRecipe["arrows"]>, string> = { none: "None", end: "At the end", start: "At the start", both: "At both ends" };
const CORNER_LABELS: Record<NonNullable<LayoutShapeRecipe["from"]>, string> = {
  "top-left": "Top left to bottom right",
  "bottom-right": "Bottom right to top left",
  "bottom-left": "Bottom left to top right",
  "top-right": "Top right to bottom left",
};
const SIDE_LABELS: Record<NonNullable<LayoutShapeRecipe["side"]>, string> = { down: "Down", up: "Up", left: "Left", right: "Right" };

export type ShapePatch = Partial<Omit<LayoutShapeRecipe, "fill" | "kind" | "shape">> & { fill?: string | null };

/**
 * The fields of the selected shapes: the stroke for all, and the fields of each kind among them.
 * A field shows the first selected shape's value that has it; a change goes to every selected
 * shape that has the field.
 */
export function LayoutShapeInspector({ shapes, onChange }: Readonly<{ shapes: readonly LayoutShapeRecipe[]; onChange: (patch: ShapePatch) => void }>) {
  const { t } = useI18n();
  if (!shapes.length) return null;
  const first = <K extends keyof LayoutShapeRecipe>(field: K): LayoutShapeRecipe | undefined => shapes.find((shape) => shapeHasField(shape.shape, field));
  const has = (field: keyof LayoutShapeRecipe) => !!first(field);
  const lead = shapes[0];
  const fillShape = first("fill");
  const select = <T extends string>(label: string, value: T, options: readonly T[], names: Record<T, string>, onPick: (value: T) => void) => (
    <label className="gl-field-inline">
      {t(label)}
      <select aria-label={t(label)} value={value} onChange={(event) => onPick(event.target.value as T)}>
        {options.map((option) => <option key={option} value={option}>{t(names[option])}</option>)}
      </select>
    </label>
  );
  return (
    <div className="gl-layout-shape-fields" aria-label={t("Shape")}>
      <strong>{shapes.length === 1 ? t(shapeTitle(lead)) : t("{n} shapes", { n: shapes.length })}</strong>
      <label className="gl-layout-shape-colour">
        <input type="color" aria-label={t("Line colour")} value={lead.stroke} onChange={(event) => onChange({ stroke: event.target.value })} />
        {t("Line colour")}
      </label>
      <label className="gl-field-inline">
        {t("Line width (px)")}
        <NumberField
          aria-label={t("Line width (px)")}
          min={SHAPE_STROKE_WIDTH_RANGE[0]}
          max={SHAPE_STROKE_WIDTH_RANGE[1]}
          step={0.25}
          value={lead.strokeWidth}
          onCommit={(value) => onChange({ strokeWidth: value })}
        />
      </label>
      {select("Dash", lead.dash, LAYOUT_SHAPE_DASHES, DASH_LABELS, (dash) => onChange({ dash }))}
      {has("arrows") && select("Arrowheads", first("arrows")!.arrows ?? "none", LAYOUT_SHAPE_ARROWS, ARROW_LABELS, (arrows) => onChange({ arrows }))}
      {has("from") && select("Direction", first("from")!.from ?? "top-left", LAYOUT_SHAPE_CORNERS, CORNER_LABELS, (from) => onChange({ from }))}
      {has("side") && select("Ends point", first("side")!.side ?? "down", LAYOUT_BRACKET_SIDES, SIDE_LABELS, (side) => onChange({ side }))}
      {has("ends") && (
        <label className="gl-field-inline">
          {t("End length (px)")}
          <NumberField
            aria-label={t("End length (px)")}
            min={SHAPE_BRACKET_ENDS_RANGE[0]}
            max={SHAPE_BRACKET_ENDS_RANGE[1]}
            step={1}
            value={first("ends")!.ends ?? 0}
            onCommit={(value) => onChange({ ends: value })}
          />
        </label>
      )}
      {fillShape && (
        <label className="gl-layout-shape-colour">
          <input type="checkbox" aria-label={t("Fill")} checked={!!fillShape.fill} onChange={(event) => onChange({ fill: event.target.checked ? (fillShape.fill ?? "#d9d9d9") : null })} />
          {t("Fill")}
          <input type="color" aria-label={t("Fill colour")} value={fillShape.fill ?? "#d9d9d9"} onChange={(event) => onChange({ fill: event.target.value })} />
        </label>
      )}
      {has("cornerRadius") && (
        <label className="gl-field-inline">
          {t("Corner radius (px)")}
          <NumberField
            aria-label={t("Corner radius (px)")}
            min={SHAPE_CORNER_RADIUS_RANGE[0]}
            max={SHAPE_CORNER_RADIUS_RANGE[1]}
            step={1}
            value={first("cornerRadius")!.cornerRadius ?? 0}
            onCommit={(value) => onChange({ cornerRadius: value })}
          />
        </label>
      )}
    </div>
  );
}
