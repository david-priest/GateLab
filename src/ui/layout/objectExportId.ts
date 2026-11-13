// objectExportId.ts — the id a Layout item's group takes in an SVG export when the item has a name
// of its own (the objects list), so an editor's layers panel shows the name.

import { slugId } from "../../plots/exportSvg";

/**
 * The id an item's group takes in an SVG export when the item has a name of its own: the name as
 * an XML id (ASCII letters, digits, hyphens and underscores, starting with a letter or an
 * underscore), made unique against `taken` with -2, -3 …, and added to it. Null when the name
 * gives no such characters, and the export's own scheme names the group.
 */
export function objectExportId(name: string | undefined, taken: Set<string>): string | null {
  const slug = slugId(name ?? "");
  if (!slug) return null;
  const base = /^[A-Za-z_]/.test(slug) ? slug : `_${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}
