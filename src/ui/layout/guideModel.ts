// guideModel.ts — the Layout tab's rulers and guides, as pure functions: the ruler's tick and
// label spacing at a zoom, the ticks in view, the snap lines a sheet's guides add, and the edits
// to a sheet's guides. A guide is kept on the sheet in px from the first page's top-left corner
// (engine/layout.ts LayoutGuide); the rulers measure in mm from the same corner. Guides are never
// printed or exported: they are not items, and the export reads items only.

import { SCREEN_PX_PER_MM, type LayoutGuide, type LayoutSheet } from "../../engine/layout";

/** The rulers' thickness in screen px; the canvas pane's padding is the same, so they cover no page at first. */
export const RULER_SIZE = 18;

/** The steps a ruler's ticks and labels take, in mm. */
const STEPS_MM = [1, 5, 10, 50, 100, 500];
/** The least screen distance between two ticks, and between two labels. */
const MIN_TICK_PX = 6;
const MIN_LABEL_PX = 34;

/** The tick and label spacing in mm at a zoom: the smallest steps that leave ticks and labels apart. */
export function rulerSteps(zoom: number): { tickMm: number; labelMm: number } {
  const pxPerMm = SCREEN_PX_PER_MM * Math.max(zoom, 1e-6);
  const pick = (least: number) => STEPS_MM.find((step) => step * pxPerMm >= least) ?? STEPS_MM[STEPS_MM.length - 1];
  const tickMm = pick(MIN_TICK_PX);
  const labelMm = Math.max(tickMm, pick(MIN_LABEL_PX));
  return { tickMm, labelMm };
}

export interface RulerTick {
  /** Where the tick is along the ruler, in screen px from the ruler's start. */
  at: number;
  mm: number;
  /** A labelled tick. */
  major: boolean;
}

/**
 * The ticks along a ruler `length` screen px long whose start is `origin` screen px after the
 * first page's corner would be (so `origin` is where 0 mm falls, from the ruler's start).
 */
export function rulerTicks(origin: number, length: number, zoom: number): RulerTick[] {
  const { tickMm, labelMm } = rulerSteps(zoom);
  const pxPerMm = SCREEN_PX_PER_MM * zoom;
  const first = Math.ceil(-origin / pxPerMm / tickMm) * tickMm;
  const last = (length - origin) / pxPerMm;
  const ticks: RulerTick[] = [];
  for (let mm = first; mm <= last && ticks.length < 2000; mm += tickMm) {
    const whole = Math.round(mm) || 0;
    ticks.push({ at: origin + whole * pxPerMm, mm: whole, major: whole % labelMm === 0 });
  }
  return ticks;
}

/** A guide's position as kept: px to 0.01 px, as item positions are; a typed mm value reads back as typed. */
export function roundGuide(px: number): number {
  return Math.round(px * 100) / 100;
}

/** The snap lines a sheet's guides add: vertical guides at their x, horizontal ones at their y. */
export function guideSnapLines(sheet: Pick<LayoutSheet, "guides"> | null | undefined): { vertical: number[]; horizontal: number[] } {
  const vertical: number[] = [], horizontal: number[] = [];
  for (const guide of sheet?.guides ?? []) (guide.axis === "x" ? vertical : horizontal).push(guide.at);
  return { vertical, horizontal };
}

/** A copy of a sheet's guides for a copy of the sheet; nothing when it has none. */
export function copiedGuides(sheet: Pick<LayoutSheet, "guides">): { guides?: LayoutGuide[] } {
  return sheet.guides?.length ? { guides: sheet.guides.map((guide) => ({ ...guide })) } : {};
}

export function addGuide(sheet: LayoutSheet, guide: LayoutGuide): void {
  sheet.guides = [...(sheet.guides ?? []), { axis: guide.axis, at: roundGuide(guide.at) }];
}

export function moveGuide(sheet: LayoutSheet, index: number, at: number): void {
  if (!sheet.guides?.[index]) return;
  sheet.guides = sheet.guides.map((guide, i) => (i === index ? { ...guide, at: roundGuide(at) } : guide));
}

export function removeGuide(sheet: LayoutSheet, index: number): void {
  if (!sheet.guides?.[index]) return;
  const rest = sheet.guides.filter((_, i) => i !== index);
  if (rest.length) sheet.guides = rest;
  else delete sheet.guides;
}

export function clearGuides(sheet: LayoutSheet): void {
  delete sheet.guides;
}

/**
 * Whether a point on screen is over the ruler a guide of this axis comes from: the top ruler for
 * a horizontal guide (axis "y"), the left one for a vertical guide (axis "x").
 */
export function overOwnRuler(axis: LayoutGuide["axis"], view: DOMRect | { left: number; top: number }, clientX: number, clientY: number): boolean {
  return axis === "y" ? clientY < view.top + RULER_SIZE : clientX < view.left + RULER_SIZE;
}
