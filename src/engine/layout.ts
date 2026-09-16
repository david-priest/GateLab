export const LAYOUT_WORKSPACE_VERSION = 1 as const;

export type LayoutDisplayMode = "scatter" | "pseudocolor" | "contour";

export interface LayoutItemFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  showFrame?: boolean;
}

export interface LayoutPlotRecipe {
  kind: "biplot" | "histogram";
  sampleId: string;
  populationId: string;
  xChannel: string;
  yChannel: string | null;
  displayMode: LayoutDisplayMode;
  title?: string;
}

export interface LayoutStrategyRecipe {
  kind: "strategy";
  sampleId: string;
  populationId: string;
  fullPath: boolean;
  displayMode: LayoutDisplayMode;
  title?: string;
}

export interface LayoutTextRecipe {
  kind: "text";
  text: string;
  fontSize: number;
}

export type LayoutRecipe = LayoutPlotRecipe | LayoutStrategyRecipe | LayoutTextRecipe;

export interface LayoutItem extends LayoutItemFrame {
  recipe: LayoutRecipe;
}

export interface LayoutSheet {
  id: string;
  name: string;
  width: number;
  height: number;
  items: LayoutItem[];
}

export interface LayoutWorkspace {
  version: typeof LAYOUT_WORKSPACE_VERSION;
  activeSheetId: string;
  sheets: LayoutSheet[];
}

export function layoutItemMinimum(kind: LayoutRecipe["kind"]) {
  return kind === "text" ? { width: 24, height: 20 } : { width: 140, height: 140 };
}
const MIN_SHEET_WIDTH = 720;
const MIN_SHEET_HEIGHT = 560;

function finiteAtLeast(value: unknown, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.round(value))
    : fallback;
}

function nonBlank(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function validDisplayMode(value: unknown): LayoutDisplayMode {
  return value === "scatter" || value === "contour" || value === "pseudocolor"
    ? value
    : "pseudocolor";
}

function normalizeRecipe(value: unknown): LayoutRecipe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "text") {
    return {
      kind: "text",
      text: typeof candidate.text === "string" ? candidate.text : "Text",
      fontSize: finiteAtLeast(candidate.fontSize, 8, 18),
    };
  }
  if (candidate.kind === "strategy") {
    return {
      kind: "strategy",
      sampleId: nonBlank(candidate.sampleId, ""),
      populationId: nonBlank(candidate.populationId, ""),
      fullPath: candidate.fullPath !== false,
      displayMode: validDisplayMode(candidate.displayMode),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  if (candidate.kind === "biplot" || candidate.kind === "histogram") {
    return {
      kind: candidate.kind,
      sampleId: nonBlank(candidate.sampleId, ""),
      populationId: nonBlank(candidate.populationId, ""),
      xChannel: nonBlank(candidate.xChannel, ""),
      yChannel: candidate.kind === "histogram"
        ? null
        : nonBlank(candidate.yChannel, "") || null,
      displayMode: validDisplayMode(candidate.displayMode),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  return null;
}

function normalizeItem(value: unknown, index: number): LayoutItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const recipe = normalizeRecipe(candidate.recipe);
  if (!recipe) return null;
  return {
    id: nonBlank(candidate.id, `layout-item-${index + 1}`),
    x: finiteAtLeast(candidate.x, 0, 24 + (index % 3) * 280),
    y: finiteAtLeast(candidate.y, 0, 24 + Math.floor(index / 3) * 280),
    width: finiteAtLeast(candidate.width, layoutItemMinimum(recipe.kind).width, recipe.kind === "strategy" ? 560 : 260),
    height: finiteAtLeast(candidate.height, layoutItemMinimum(recipe.kind).height, recipe.kind === "text" ? 32 : recipe.kind === "strategy" ? 300 : 280),
    showFrame: candidate.showFrame === true,
    z: finiteAtLeast(candidate.z, 0, index),
    recipe,
  };
}

function normalizeSheet(value: unknown, index: number): LayoutSheet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const rawItems = Array.isArray(candidate.items) ? candidate.items : [];
  const items = rawItems.flatMap((item, itemIndex) => {
    const normalized = normalizeItem(item, itemIndex);
    return normalized ? [normalized] : [];
  });
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) item.id = crypto.randomUUID();
    seen.add(item.id);
  }
  return {
    id: nonBlank(candidate.id, `layout-sheet-${index + 1}`),
    name: nonBlank(candidate.name, `Layout ${index + 1}`),
    width: finiteAtLeast(candidate.width, MIN_SHEET_WIDTH, 1200),
    height: finiteAtLeast(candidate.height, MIN_SHEET_HEIGHT, 800),
    items,
  };
}

export function createLayoutSheet(name = "Layout 1"): LayoutSheet {
  return {
    id: crypto.randomUUID(),
    name,
    width: 1200,
    height: 800,
    items: [],
  };
}

export function createDefaultLayoutWorkspace(): LayoutWorkspace {
  const sheet = createLayoutSheet();
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: sheet.id,
    sheets: [sheet],
  };
}

/**
 * Parse persisted layout state defensively. Layouts are presentation-only: a malformed layout
 * is replaced with a clean sheet rather than preventing scientifically valid gating data from
 * opening.
 */
export function normalizeLayoutWorkspace(value: unknown): LayoutWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultLayoutWorkspace();
  }
  const candidate = value as Record<string, unknown>;
  const rawSheets = Array.isArray(candidate.sheets) ? candidate.sheets : [];
  const sheets = rawSheets.flatMap((sheet, index) => {
    const normalized = normalizeSheet(sheet, index);
    return normalized ? [normalized] : [];
  });
  if (sheets.length === 0) return createDefaultLayoutWorkspace();

  const seen = new Set<string>();
  for (const sheet of sheets) {
    if (seen.has(sheet.id)) sheet.id = crypto.randomUUID();
    seen.add(sheet.id);
  }
  const requestedActive = nonBlank(candidate.activeSheetId, "");
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: sheets.some(({ id }) => id === requestedActive)
      ? requestedActive
      : sheets[0].id,
    sheets,
  };
}

export function nextLayoutItemPosition(
  sheet: LayoutSheet,
  width = 260,
  height = 280,
): Pick<LayoutItemFrame, "x" | "y" | "width" | "height" | "z"> {
  const index = sheet.items.length;
  const columns = Math.max(1, Math.floor((sheet.width - 48) / (width + 18)));
  return {
    x: 24 + (index % columns) * (width + 18),
    y: 24 + Math.floor(index / columns) * (height + 18),
    width,
    height,
    z: Math.max(0, ...sheet.items.map(({ z }) => z)) + 1,
  };
}

export function cloneLayoutWorkspace(workspace: LayoutWorkspace): LayoutWorkspace {
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: workspace.activeSheetId,
    sheets: workspace.sheets.map((sheet) => ({
      ...sheet,
      items: sheet.items.map((item) => ({
        ...item,
        recipe: { ...item.recipe },
      })),
    })),
  };
}
