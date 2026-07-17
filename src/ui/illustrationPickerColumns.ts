export const ILLUSTRATION_PICKER_MAX_COLUMNS = 4;
export const ILLUSTRATION_PICKER_VISIBLE_ROWS = 15;

export interface IllustrationPickerLayout<T> {
  columns: T[][];
  lastColumnScrollable: boolean;
}

export interface IllustrationPickerLayoutOptions {
  visibleRows?: number;
  distribution?: "balanced" | "fill-first";
}

/**
 * Arrange a checklist across the available columns while preserving its reading order.
 * Balanced lists use the available width immediately; fill-first lists complete each
 * left-hand column before continuing right. Overflow stays in the final scrollable column.
 */
export function layoutIllustrationPicker<T>(
  items: readonly T[],
  availableColumns: number,
  options: IllustrationPickerLayoutOptions = {},
): IllustrationPickerLayout<T> {
  const visibleRows = options.visibleRows ?? ILLUSTRATION_PICKER_VISIBLE_ROWS;
  const safeRows = Math.max(1, Math.floor(visibleRows));
  const safeAvailable = Math.max(1, Math.floor(availableColumns));
  const columnCount = Math.min(safeAvailable, Math.max(1, items.length));
  const lastColumnScrollable = items.length > columnCount * safeRows;
  const columns: T[][] = [];

  if (lastColumnScrollable || options.distribution === "fill-first") {
    let offset = 0;
    for (let column = 0; column < columnCount - 1; column += 1) {
      columns.push(items.slice(offset, offset + safeRows));
      offset += safeRows;
    }
    columns.push(items.slice(offset));
    return { columns, lastColumnScrollable };
  }

  let offset = 0;
  for (let column = 0; column < columnCount; column += 1) {
    const columnsLeft = columnCount - column;
    const size = Math.ceil((items.length - offset) / columnsLeft);
    columns.push(items.slice(offset, offset + size));
    offset += size;
  }

  return { columns, lastColumnScrollable };
}
