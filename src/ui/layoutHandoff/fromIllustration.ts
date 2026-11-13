/**
 * The Illustration tab's hand-off to Layout (moved from App.tsx): the whole figure as one block.
 * Its "Add panels" goes through addPlotsToSheet (shared.ts), as the other tabs' plots do.
 */
import type { Sample } from "../../engine/sample";
import { cloneLayoutWorkspace, nextLayoutItemPosition, type LayoutWorkspace } from "../../engine/layout";
import { sampleDisplayId } from "../../engine/metadata";
import type { IllustrationConfig } from "../../engine/workspace";
import type { CoreState } from "../../store";
import { figureBlockFrame } from "../LayoutFigure";
import { placeBlockOnPage } from "../layoutPlacement";
import type { HandoffFiles } from "./shared";

/** The Illustration tab's figure as one Layout block on the active sheet, sized and placed on a page; `page` is the figure's page it draws, 0-based. */
export function addFigureBlock(
  current: LayoutWorkspace,
  config: IllustrationConfig,
  context: HandoffFiles<{ id: string; name: string; sample: Sample }> & { state: CoreState },
  page = 0,
): LayoutWorkspace {
  const { samples, metadata, hierarchyOfFile, state } = context;
  const next = cloneLayoutWorkspace(current);
  const sheet = next.sheets.find((s0) => s0.id === next.activeSheetId) ?? next.sheets[0];
  if (!sheet) return current;
  const files = samples.map(entry => ({ ...entry, fileName: entry.name, name: sampleDisplayId(entry.name, metadata[entry.id]), hierarchyId: hierarchyOfFile(entry.id), metadata: metadata[entry.id] }));
  const size = figureBlockFrame(config, files, state, sheet, undefined, page);
  const frame = nextLayoutItemPosition(sheet, size.width, size.height);
  const item = { id: crypto.randomUUID(), ...frame, recipe: { kind: "figure" as const, illustration: config, page } };
  sheet.items.push(item);
  placeBlockOnPage(sheet, [item]);
  sheet.width = Math.max(sheet.width, item.x + item.width + 48);
  sheet.height = Math.max(sheet.height, item.y + item.height + 48);
  return next;
}
