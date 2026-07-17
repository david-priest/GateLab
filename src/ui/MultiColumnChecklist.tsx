import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ILLUSTRATION_PICKER_MAX_COLUMNS,
  layoutIllustrationPicker,
  type IllustrationPickerLayoutOptions,
} from "./illustrationPickerColumns";

const DEFAULT_MIN_COLUMN_WIDTH = 148;
const COLUMN_DIVIDER_WIDTH = 1;
const ROW_HEIGHT = 19;
const FRAME_HEIGHT = 10;

interface Props<T> {
  items: readonly T[];
  ariaLabel: string;
  selected: (item: T) => boolean;
  onToggle: (item: T) => void;
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  getDepth?: (item: T) => number;
  renderTrailing?: (item: T) => ReactNode;
  distribution?: IllustrationPickerLayoutOptions["distribution"];
  visibleRows?: number;
  maxColumns?: number;
  minColumnWidth?: number;
  height?: number;
  className?: string;
}

/** Shared responsive checklist used by Illustration, Statistics, and Strategy. */
export function MultiColumnChecklist<T>({
  items,
  ariaLabel,
  selected,
  onToggle,
  getKey,
  getLabel,
  getDepth,
  renderTrailing,
  distribution = "balanced",
  visibleRows = 15,
  maxColumns = ILLUSTRATION_PICKER_MAX_COLUMNS,
  minColumnWidth = DEFAULT_MIN_COLUMN_WIDTH,
  height = visibleRows * ROW_HEIGHT + FRAME_HEIGHT,
  className = "",
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [availableColumns, setAvailableColumns] = useState(maxColumns);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const width = element.getBoundingClientRect().width || element.clientWidth;
      if (width <= 0) return;
      const next = Math.max(
        1,
        Math.min(
          maxColumns,
          Math.floor((width + COLUMN_DIVIDER_WIDTH) / (minColumnWidth + COLUMN_DIVIDER_WIDTH)),
        ),
      );
      setAvailableColumns((current) => (current === next ? current : next));
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [maxColumns, minColumnWidth]);

  const layout = layoutIllustrationPicker(items, availableColumns, { visibleRows, distribution });

  return (
    <div
      ref={ref}
      className={`gl-multi-picker-columns${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={ariaLabel}
      style={{
        height,
        gridTemplateColumns: `repeat(${layout.columns.length}, minmax(0, 1fr))`,
      }}
    >
      {layout.columns.map((column, columnIndex) => (
        <div
          key={columnIndex}
          className={`gl-multi-picker-column${layout.lastColumnScrollable && columnIndex === layout.columns.length - 1 ? " is-scrollable" : ""}`}
        >
          {column.map((item) => {
            const key = getKey(item);
            const label = getLabel(item);
            return (
              <label
                key={key}
                className="gl-multi-picker-item"
                style={{ paddingLeft: (getDepth?.(item) ?? 0) * 10 }}
                title={label}
              >
                <input type="checkbox" checked={selected(item)} onChange={() => onToggle(item)} />
                <span className="gl-multi-picker-label">{label}</span>
                {renderTrailing?.(item)}
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
