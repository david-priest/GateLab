export const ILLUSTRATION_PICKER_MAX_COLUMNS = 4;
export const ILLUSTRATION_PICKER_VISIBLE_ROWS = 15;

export interface IllustrationPickerLayout<T> {
  columns: T[][];
  lastColumnScrollable: boolean;
}

/**
 * Spread a checklist across the available columns while preserving its reading order.
 * Once every column can hold a full visible page, keep the first columns fixed and put
 * any remaining items in the final scrollable column.
 */
export function layoutIllustrationPicker<T>(
  items: readonly T[],
  availableColumns: number,
  visibleRows = ILLUSTRATION_PICKER_VISIBLE_ROWS,
): IllustrationPickerLayout<T> {
  const safeRows = Math.max(1, Math.floor(visibleRows));
  const safeAvailable = Math.max(1, Math.floor(availableColumns));
  const columnCount = Math.min(safeAvailable, Math.max(1, items.length));
  const lastColumnScrollable = items.length > columnCount * safeRows;
  const columns: T[][] = [];

  if (lastColumnScrollable) {
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
