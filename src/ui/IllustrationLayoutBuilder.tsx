import { useState, type DragEvent } from "react";
import {
  DEFAULT_ILLUSTRATION_LAYOUT,
  ILLUSTRATION_DIMENSIONS,
  moveIllustrationDimension,
  normalizeIllustrationLayout,
  type IllustrationDimension,
  type IllustrationDimensionAxis,
  type IllustrationDimensionLayout,
} from "../engine/illustrationLayout";
import { useI18n } from "./i18n";

interface Props {
  value: IllustrationDimensionLayout;
  onChange: (value: IllustrationDimensionLayout) => void;
}

const AXES: readonly IllustrationDimensionAxis[] = ["rows", "columns", "overlay"];

function dimensionLabel(dimension: IllustrationDimension): string {
  if (dimension === "files") return "FCS files";
  if (dimension === "populations") return "Populations";
  return "Channels";
}

function axisLabel(axis: IllustrationDimensionAxis): string {
  if (axis === "rows") return "Rows";
  if (axis === "columns") return "Columns";
  return "Overlay";
}

export function IllustrationLayoutBuilder({ value, onChange }: Readonly<Props>) {
  const { t } = useI18n();
  const layout = normalizeIllustrationLayout(value);
  const [dragged, setDragged] = useState<IllustrationDimension | null>(null);

  const move = (
    dimension: IllustrationDimension,
    axis: IllustrationDimensionAxis,
    index?: number,
  ) => onChange(moveIllustrationDimension(layout, dimension, axis, index));

  const drop = (event: DragEvent, axis: IllustrationDimensionAxis, index?: number) => {
    event.preventDefault();
    const fromTransfer = event.dataTransfer.getData("text/plain") as IllustrationDimension;
    const dimension = dragged ?? (ILLUSTRATION_DIMENSIONS.includes(fromTransfer) ? fromTransfer : null);
    if (dimension) move(dimension, axis, index);
    setDragged(null);
  };

  return (
    <section className="gl-illustration-layout-builder" aria-label={t("Illustration layout")}>
      <div className="gl-illustration-layout-head">
        <div>
          <span className="gl-control-section-label">{t("Illustration layout")}</span>
          <div className="gl-hint">
            {t("Drag dimensions between rows, columns and overlay. This reorganises the figure without a free-form layout canvas.")}
          </div>
        </div>
        <button
          type="button"
          className="gl-mini-btn"
          onClick={() => onChange(normalizeIllustrationLayout(DEFAULT_ILLUSTRATION_LAYOUT))}
        >
          {t("Reset layout")}
        </button>
      </div>
      <div className="gl-illustration-layout-zones">
        {AXES.map((axis) => (
          <div
            key={axis}
            className={`gl-illustration-layout-zone is-${axis}`}
            data-layout-axis={axis}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, axis)}
          >
            <div className="gl-illustration-layout-zone-label">
              {t(axisLabel(axis))}
              <span>{layout[axis].length || "—"}</span>
            </div>
            <div className="gl-illustration-layout-pills">
              {layout[axis].map((dimension, index) => (
                <div
                  key={dimension}
                  className="gl-illustration-dimension-pill"
                  draggable
                  onDragStart={(event) => {
                    setDragged(dimension);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", dimension);
                  }}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.stopPropagation();
                    drop(event, axis, index);
                  }}
                  title={t("Drag to reorganise the illustration")}
                >
                  <span className="gl-illustration-dimension-grip" aria-hidden="true">::::</span>
                  <span>{t(dimensionLabel(dimension))}</span>
                  <select
                    aria-label={t("Place {dimension}", { dimension: dimensionLabel(dimension) })}
                    value={axis}
                    onChange={(event) => move(
                      dimension,
                      event.target.value as IllustrationDimensionAxis,
                    )}
                  >
                    <option value="rows">{t("Rows")}</option>
                    <option value="columns">{t("Columns")}</option>
                    <option value="overlay" disabled={dimension === "channels"}>{t("Overlay")}</option>
                  </select>
                  <div className="gl-illustration-dimension-order">
                    <button
                      type="button"
                      aria-label={t("Move {dimension} earlier", { dimension: dimensionLabel(dimension) })}
                      disabled={index === 0}
                      onClick={() => move(dimension, axis, index - 1)}
                    >←</button>
                    <button
                      type="button"
                      aria-label={t("Move {dimension} later", { dimension: dimensionLabel(dimension) })}
                      disabled={index === layout[axis].length - 1}
                      onClick={() => move(dimension, axis, index + 1)}
                    >→</button>
                  </div>
                </div>
              ))}
              {layout[axis].length === 0 ? (
                <div className="gl-illustration-layout-empty">{t("Drop a dimension here")}</div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="gl-hint gl-illustration-layout-note">
        {t("Overlaying FCS files pools their events. Overlaying populations gives each population a colour; gates are hidden in that mixed-population view. Channels always remain a row or column dimension.")}
      </div>
    </section>
  );
}
