// levelOrder.ts — the order files and the values of a metadata column are drawn in. Illustration,
// the Plotting charts and the file list's chips all take it from here: files as the file list
// holds them, and a column's values in the column's own order of levels (the Metadata column's
// `levels`, set by the user) where it has one, else in the order its files give them.

/** The files with the ids given, in the file list's order. */
export function fileListOrder<T extends { id: string }>(fileList: readonly T[], ids: Iterable<string>): T[] {
  const wanted = new Set(ids);
  return fileList.filter((file) => wanted.has(file.id));
}

/**
 * The distinct values given, in a column's order of its levels: the levels that are among the
 * values first, in their order, then the other values in the order they are given (each at its
 * first file, when they are given in the file list's order). A level no value carries is dropped.
 * Without levels, the values in the order they are given.
 */
export function columnValueOrder(values: Iterable<string>, levels?: readonly string[]): string[] {
  const distinct = [...new Set(values)];
  if (!levels?.length) return distinct;
  const present = new Set(distinct);
  const listed = [...new Set(levels.filter((level) => present.has(level)))];
  const taken = new Set(listed);
  return [...listed, ...distinct.filter((value) => !taken.has(value))];
}
