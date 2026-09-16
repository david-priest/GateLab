import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Sample } from "../engine/sample";
import type { CoreState, GatingDerived } from "../store";
import {
  figureHierarchies,
  resolveFigurePopulation,
  type FigureSample,
} from "../engine/figure";
import { useFigureSources } from "./useFigureSources";
import type { StoredHierarchy } from "../engine/hierarchies";
import {
  cloneLayoutWorkspace,
  createLayoutSheet,
  nextLayoutItemPosition,
  layoutItemMinimum,
  type LayoutDisplayMode,
  type LayoutItem,
  type LayoutPlotRecipe,
  type LayoutRecipe,
  type LayoutSheet,
  type LayoutStrategyRecipe,
  type LayoutWorkspace,
} from "../engine/layout";
import type { IllustrationConfig } from "../engine/workspace";
import { buildIllustrationPayload } from "../engine/illustration";
import {
  computeGatingStrategy,
  buildStrategyPayload,
} from "../engine/strategy";
import { populationTreeOrder } from "../engine/populations";
import { loadMiniPlots } from "../plots/loadPlots";
import { useI18n } from "./i18n";

export interface LayoutSampleView {
  id: string;
  name: string;
  sample: Sample;
  derived: GatingDerived;
  tree: StoredHierarchy;
}

interface Props {
  workspace: LayoutWorkspace;
  onChange: (workspace: LayoutWorkspace) => void;
  samples: readonly FigureSample[];
  activeSampleId: string | null;
  activePopulationId: string | null;
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  defaultX: string;
  defaultY: string;
  illustrationConfig: IllustrationConfig | null;
  dataRevision: string | number;
  densityColorPower: number;
  onOpenInGating: (recipe: LayoutPlotRecipe | LayoutStrategyRecipe) => void;
}

const DEFAULT_POINT_ALPHA = 0.4;
const DEFAULT_POINT_SIZE = 1.1;
const DEFAULT_FONT_SIZES = {
  tick: 9,
  axis_label: 11,
  gate_label: 9,
  title: 11,
};

function itemTitle(
  item: LayoutItem,
  samples: readonly LayoutSampleView[],
  _state: CoreState,
): string {
  const recipe = item.recipe;
  if (recipe.kind === "text") return recipe.text.split("\n")[0] || "Text";
  if (recipe.title?.trim()) return recipe.title.trim();
  const sample = samples.find(({ id }) => id === recipe.sampleId);
  const population = sample?.tree.populations[recipe.populationId];
  if (recipe.kind === "strategy") {
    return `${population?.name ?? "Population"} strategy`;
  }
  return `${population?.name ?? "Population"} · ${sample?.name ?? "FCS"}`;
}

function LayoutPlotSurface({
  item,
  samples,
  state: activeState,
  globalScales,
  dataRevision,
  densityColorPower,
}: Readonly<{
  item: LayoutItem;
  samples: readonly LayoutSampleView[];
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  dataRevision: string | number;
  densityColorPower: number;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const recipe = item.recipe;
  const source =
    recipe.kind === "text"
      ? null
      : (samples.find(({ id }) => id === recipe.sampleId) ?? null);
  const state = source ? { ...activeState, ...source.tree } : activeState;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || recipe.kind === "text") return;
    const timer = window.setTimeout(() => {
      host.innerHTML = "";
      if (!source) {
        host.textContent =
          "The referenced file is unavailable or still loading.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      const population = state.populations[recipe.populationId];
      if (!population) {
        host.textContent = "The referenced population is unavailable.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      host.className = "gl-layout-plot-host";
      const availableWidth = Math.max(120, item.width - 8);
      const availableHeight = Math.max(120, item.height - 8);

      if (recipe.kind === "strategy") {
        const plotSize = Math.max(140, Math.min(220, availableHeight - 8));
        const steps = computeGatingStrategy(
          source.sample,
          state.gates,
          state.populations,
          state.root_population_id ?? "",
          recipe.populationId,
          { fullPath: recipe.fullPath, maxEvents: 10000 },
        );
        const columns = Math.max(1, Math.floor(availableWidth / plotSize));
        const payload = buildStrategyPayload(
          source.sample,
          steps,
          null,
          globalScales,
          {
            gateView: ["forward"],
            displayMode: recipe.displayMode,
            maxEvents: 10000,
            nColumns: columns,
            plotSize,
            fitToColumns: false,
            contourThreshold: 5,
            pointAlpha: DEFAULT_POINT_ALPHA,
            densityColorPower,
            pointSize: DEFAULT_POINT_SIZE,
            kdeBandwidth: 0,
            pubStyle: false,
            gateLineWidth: 1.5,
            fontSizes: DEFAULT_FONT_SIZES,
            contextTitle: recipe.title?.trim() || population.name,
          },
        );
        host.id = `layout-strategy-${item.id}`;
        loadMiniPlots().renderStrategyGrid(host.id, payload);
        return;
      }

      const plotSize = Math.max(120, Math.min(availableWidth, availableHeight));
      const yChannel = recipe.kind === "histogram" ? null : recipe.yChannel;
      const payload = buildIllustrationPayload(
        source.sample,
        state.gates,
        state.gate_order,
        state.populations,
        source.derived.masks,
        source.derived.stats.event_count,
        [recipe.populationId],
        [recipe.xChannel],
        yChannel,
        globalScales,
        {
          displayMode: recipe.displayMode,
          maxEvents: 20000,
          nColumns: 1,
          plotSize,
          fitToColumns: false,
          contourThreshold: 5,
          pointAlpha: DEFAULT_POINT_ALPHA,
          densityColorPower,
          pointSize: DEFAULT_POINT_SIZE,
          kdeBandwidth: 0,
          colorByPop: false,
          overlayPops: false,
          populationColors: {},
          histLineWidth: 1.8,
          histFill: true,
          histFillAlpha: 0.22,
          histOverlayMode: "front_opaque",
          histLayout: "grid",
          ridgeOverlap: 0.7,
          ridgeColGap: 8,
          ridgeGradient: false,
          pubStyle: false,
          gateLineWidth: 1.5,
          fontSizes: DEFAULT_FONT_SIZES,
          scaleFontsWithPlot: true,
        },
      ) as {
        plots?: Record<string, Record<string, unknown>>;
        gate_overlays?: Record<string, unknown>;
      };
      const key = `${recipe.populationId}|${recipe.xChannel}`;
      const plot = payload.plots?.[key];
      if (!plot) {
        host.textContent =
          "No events are available for this FCS/population combination.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      loadMiniPlots().renderMiniPlot(host, {
        ...plot,
        display_mode: recipe.displayMode,
        plot_size: plotSize,
        contour_threshold: 5,
        point_alpha: DEFAULT_POINT_ALPHA,
        density_color_power: densityColorPower,
        point_size: DEFAULT_POINT_SIZE,
        kde_bandwidth: 0,
        hist_line_width: 1.8,
        hist_fill: true,
        hist_fill_alpha: 0.22,
        hist_overlay_mode: "front_opaque",
        title: recipe.title?.trim() || `${population.name} · ${source.name}`,
        contour_levels: 10,
        font_sizes: DEFAULT_FONT_SIZES,
        gate_style: { pub_style: false, line_width: 1.5 },
        pop_color: "#334155",
        gates: payload.gate_overlays?.[key] ?? [],
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [
    dataRevision,
    densityColorPower,
    globalScales,
    item.height,
    item.id,
    item.width,
    recipe,
    source,
    state.gate_order,
    state.gate_version,
    state.gates,
    state.populations,
    state.root_population_id,
  ]);

  if (recipe.kind === "text") {
    return (
      <div
        className="gl-layout-text-surface"
        style={{ fontSize: recipe.fontSize }}
      >
        {recipe.text}
      </div>
    );
  }
  return <div ref={hostRef} className="gl-layout-plot-host" />;
}

function LayoutItemFrame({
  item,
  selected,
  samples,
  state,
  globalScales,
  dataRevision,
  densityColorPower,
  onSelect,
  onFrameChange,
  onDelete,
  onOpenInGating,
  onTextChange,
}: Readonly<{
  item: LayoutItem;
  selected: boolean;
  samples: readonly LayoutSampleView[];
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  dataRevision: string | number;
  densityColorPower: number;
  onSelect: () => void;
  onFrameChange: (
    frame: Pick<LayoutItem, "x" | "y" | "width" | "height">,
  ) => void;
  onDelete: () => void;
  onOpenInGating: () => void;
  onTextChange: (text: string) => void;
}>) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLElement>(null);

  const startPointer = (
    mode: "move" | "resize",
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const node = frameRef.current;
    if (!node) return;
    const start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    };
    let frame = {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    };
    const move = (pointer: PointerEvent) => {
      const dx = pointer.clientX - start.pointerX;
      const dy = pointer.clientY - start.pointerY;
      if (mode === "move") {
        frame = {
          ...frame,
          x: Math.max(0, Math.round(start.x + dx)),
          y: Math.max(0, Math.round(start.y + dy)),
        };
        node.style.left = `${frame.x}px`;
        node.style.top = `${frame.y}px`;
      } else {
        frame = {
          ...frame,
          width: Math.max(
            layoutItemMinimum(item.recipe.kind).width,
            Math.round(start.width + dx),
          ),
          height: Math.max(
            layoutItemMinimum(item.recipe.kind).height,
            Math.round(start.height + dy),
          ),
        };
        node.style.width = `${frame.width}px`;
        node.style.height = `${frame.height}px`;
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      onFrameChange(frame);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <article
      ref={frameRef}
      className={`gl-layout-item${selected ? " is-selected" : ""}${item.showFrame ? " has-frame" : ""}${item.recipe.kind === "text" ? " is-text" : ""}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.z,
      }}
      onPointerDown={onSelect}
    >
      <header
        className="gl-layout-item-head"
        onPointerDown={(event) => startPointer("move", event)}
      >
        <span title={itemTitle(item, samples, state)}>
          {itemTitle(item, samples, state)}
        </span>
        <div>
          {item.recipe.kind !== "text" && (
            <button
              type="button"
              className="gl-layout-item-action"
              title={t("Open in Gating")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenInGating}
            >
              ↗
            </button>
          )}
          <button
            type="button"
            className="gl-layout-item-action"
            title={t("Remove from layout")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onDelete}
          >
            ×
          </button>
        </div>
      </header>
      {item.recipe.kind === "text" ? (
        <LayoutTextEditor
          text={item.recipe.text}
          fontSize={item.recipe.fontSize}
          onCommit={onTextChange}
        />
      ) : (
        <LayoutPlotSurface
          item={item}
          samples={samples}
          state={state}
          globalScales={globalScales}
          dataRevision={dataRevision}
          densityColorPower={densityColorPower}
        />
      )}
      <button
        type="button"
        className="gl-layout-resize"
        aria-label={t("Resize layout item")}
        onPointerDown={(event) => startPointer("resize", event)}
      />
    </article>
  );
}

function LayoutTextEditor({
  text,
  fontSize,
  onCommit,
}: {
  text: string;
  fontSize: number;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <textarea
      className="gl-layout-text-surface"
      aria-label="Layout text"
      value={draft}
      style={{ fontSize }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== text) onCommit(draft);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          setDraft(text);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function LayoutTab({
  workspace,
  onChange,
  samples: files,
  activeSampleId,
  activePopulationId,
  state,
  globalScales,
  defaultX,
  defaultY,
  illustrationConfig,
  dataRevision,
  densityColorPower,
  onOpenInGating,
}: Readonly<Props>) {
  const { t } = useI18n();
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [renamingSheetId, setRenamingSheetId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [insertFileId, setInsertFileId] = useState(
    activeSampleId ?? files[0]?.id ?? "",
  );
  const [section, setSection] = useState("item");
  const [preview, setPreview] = useState(false);
  const sourceResult = useFigureSources(
    files,
    files.map((file) => file.id),
    state,
    dataRevision,
  );
  const samples: LayoutSampleView[] = sourceResult.current
    ? sourceResult.sources.map((source) => ({
        ...source,
        derived: source.gating,
      }))
    : [];
  const undoRef = useRef<LayoutWorkspace[]>([]);
  const redoRef = useRef<LayoutWorkspace[]>([]);
  const activeSheet =
    workspace.sheets.find(({ id }) => id === workspace.activeSheetId) ??
    workspace.sheets[0];
  const selectedItem =
    activeSheet?.items.find(({ id }) => id === selectedItemId) ?? null;

  useEffect(() => {
    if (
      selectedItemId &&
      !activeSheet?.items.some(({ id }) => id === selectedItemId)
    ) {
      setSelectedItemId(null);
    }
  }, [activeSheet, selectedItemId]);

  const commit = (next: LayoutWorkspace, remember = true) => {
    if (remember) {
      undoRef.current = [
        cloneLayoutWorkspace(workspace),
        ...undoRef.current,
      ].slice(0, 30);
      redoRef.current = [];
    }
    onChange(next);
  };

  const mutate = (change: (draft: LayoutWorkspace) => void) => {
    const next = cloneLayoutWorkspace(workspace);
    change(next);
    commit(next);
  };

  const mutateActiveSheet = (change: (sheet: LayoutSheet) => void) => {
    mutate((draft) => {
      const sheet = draft.sheets.find(({ id }) => id === draft.activeSheetId);
      if (sheet) change(sheet);
    });
  };

  const addItem = (
    recipe: LayoutRecipe,
    frame?: { width: number; height: number },
  ) => {
    let createdId = "";
    mutateActiveSheet((sheet) => {
      createdId = crypto.randomUUID();
      sheet.items.push({
        id: createdId,
        ...nextLayoutItemPosition(sheet, frame?.width, frame?.height),
        recipe,
      });
      const created = sheet.items[sheet.items.length - 1];
      sheet.width = Math.max(sheet.width, created.x + created.width + 48);
      sheet.height = Math.max(sheet.height, created.y + created.height + 48);
    });
    setSelectedItemId(createdId);
  };

  const defaultSource =
    samples.find(({ id }) => id === insertFileId) ?? samples[0] ?? null;
  const mappedActive =
    defaultSource && activePopulationId
      ? resolveFigurePopulation(
          {
            hierarchyId: state.active_hierarchy_id,
            populationId: activePopulationId,
            label: "",
          },
          defaultSource.tree,
          figureHierarchies(state),
        )
      : null;
  const defaultPopulation =
    mappedActive?.id ?? defaultSource?.tree.root_population_id ?? "";

  const addPlot = (kind: "biplot" | "histogram") => {
    if (!defaultSource || !defaultPopulation) {
      setMessage(t("Check an FCS file and select a population first."));
      return;
    }
    addItem({
      kind,
      sampleId: defaultSource.id,
      populationId: defaultPopulation,
      xChannel:
        defaultSource.sample.index(defaultX) !== undefined
          ? defaultX
          : (defaultSource.sample.channels[0]?.key ?? ""),
      yChannel:
        kind === "histogram"
          ? null
          : defaultSource.sample.index(defaultY) !== undefined
            ? defaultY
            : (defaultSource.sample.channels[1]?.key ??
              defaultSource.sample.channels[0]?.key ??
              null),
      displayMode: "pseudocolor",
    });
  };

  const addStrategy = () => {
    if (!defaultSource || !defaultPopulation) {
      setMessage(t("Check an FCS file and select a population first."));
      return;
    }
    addItem(
      {
        kind: "strategy",
        sampleId: defaultSource.id,
        populationId: defaultPopulation,
        fullPath: true,
        displayMode: "pseudocolor",
      },
      { width: 600, height: 320 },
    );
  };

  const addIllustrationSelection = () => {
    if (!illustrationConfig) {
      setMessage(t("Render or configure an Illustration selection first."));
      return;
    }
    if (
      !illustrationConfig.figure &&
      illustrationConfig.plotType === "heatmap"
    ) {
      setMessage(
        t("Heatmap layout blocks are planned for the next Layout phase."),
      );
      return;
    }
    const sourceById = new Map(samples.map((sample) => [sample.id, sample]));
    const combinations: {
      sampleId: string;
      populationId: string;
      xChannel: string;
      yChannel?: string;
      type?: "biplot" | "histogram";
    }[] = [];
    const figure = illustrationConfig.figure;
    for (const source of samples) {
      if (figure) {
        if (!figure.sampleIds.includes(source.id)) continue;
        for (const plot of figure.plots) {
          if (plot.type === "heatmap") continue;
          for (const ref of plot.population
            ? [plot.population]
            : (figure.samplePopulations?.[source.id] ?? figure.populations)) {
            const mapped = resolveFigurePopulation(
              ref,
              source.tree,
              figureHierarchies(state),
            );
            if (mapped.id && mapped.status !== "changed")
              combinations.push({
                sampleId: source.id,
                populationId: mapped.id,
                xChannel: plot.x,
                yChannel: plot.y,
                type: plot.type,
              });
          }
        }
        continue;
      }
      const popIds =
        illustrationConfig.selectionMode === "matrix"
          ? (illustrationConfig.selectedPopulationsBySample?.[source.id] ?? [])
          : illustrationConfig.popIds;
      for (const populationId of popIds) {
        for (const xChannel of illustrationConfig.xChannels) {
          combinations.push({ sampleId: source.id, populationId, xChannel });
        }
      }
    }
    const accepted = combinations.slice(0, 60);
    if (accepted.length === 0) {
      setMessage(
        t("The current Illustration selection has no plot combinations."),
      );
      return;
    }
    mutateActiveSheet((sheet) => {
      for (const combination of accepted) {
        const source = sourceById.get(combination.sampleId);
        if (!source) continue;
        const kind =
          combination.type ??
          (illustrationConfig.plotType === "histogram"
            ? "histogram"
            : "biplot");
        sheet.items.push({
          id: crypto.randomUUID(),
          ...nextLayoutItemPosition(sheet),
          recipe: {
            kind,
            sampleId: combination.sampleId,
            populationId: combination.populationId,
            xChannel: combination.xChannel,
            yChannel:
              kind === "histogram"
                ? null
                : (combination.yChannel ?? illustrationConfig.yChannel),
            displayMode: (illustrationConfig.displayMode === "dots"
              ? "scatter"
              : illustrationConfig.displayMode) as LayoutDisplayMode,
          },
        });
      }
      const maxX = Math.max(
        0,
        ...sheet.items.map((item) => item.x + item.width),
      );
      const maxY = Math.max(
        0,
        ...sheet.items.map((item) => item.y + item.height),
      );
      sheet.width = Math.max(sheet.width, maxX + 48);
      sheet.height = Math.max(sheet.height, maxY + 48);
    });
    setMessage(
      combinations.length > accepted.length
        ? t(
            "Added the first {count} Illustration plots; refine the selection before adding more.",
            {
              count: accepted.length,
            },
          )
        : t("Added {count} Illustration plots.", { count: accepted.length }),
    );
  };

  const updateSelectedRecipe = (
    change: (recipe: LayoutRecipe) => LayoutRecipe,
  ) => {
    if (!selectedItem) return;
    mutateActiveSheet((sheet) => {
      const item = sheet.items.find(({ id }) => id === selectedItem.id);
      if (item) item.recipe = change(item.recipe);
    });
  };

  const selectedRecipe = selectedItem?.recipe;
  const selectedSource =
    selectedRecipe && selectedRecipe.kind !== "text"
      ? (samples.find(({ id }) => id === selectedRecipe.sampleId) ?? null)
      : null;
  const selectedPopulations = selectedSource
    ? populationTreeOrder(
        selectedSource.tree.populations,
        selectedSource.tree.root_population_id ?? "",
      )
    : [];

  const undo = () => {
    const previous = undoRef.current.shift();
    if (!previous) return;
    redoRef.current = [
      cloneLayoutWorkspace(workspace),
      ...redoRef.current,
    ].slice(0, 30);
    commit(previous, false);
  };
  const redo = () => {
    const next = redoRef.current.shift();
    if (!next) return;
    undoRef.current = [
      cloneLayoutWorkspace(workspace),
      ...undoRef.current,
    ].slice(0, 30);
    commit(next, false);
  };

  if (!activeSheet) return null;

  return (
    <div
      className={`gl-tab-panel gl-tab-fill gl-layout-tab${preview ? " is-preview" : ""}`}
    >
      <div
        className="gl-layout-sheet-tabs"
        role="tablist"
        aria-label={t("Layout sheets")}
      >
        {workspace.sheets.map((sheet) => (
          <div key={sheet.id} className="gl-layout-sheet-tab-wrap">
            {renamingSheetId === sheet.id ? (
              <input
                className="gl-layout-sheet-rename"
                defaultValue={sheet.name}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name) {
                    mutate((draft) => {
                      const target = draft.sheets.find(
                        ({ id }) => id === sheet.id,
                      );
                      if (target) target.name = name;
                    });
                  }
                  setRenamingSheetId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenamingSheetId(null);
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={workspace.activeSheetId === sheet.id}
                className={`gl-layout-sheet-tab${workspace.activeSheetId === sheet.id ? " active" : ""}`}
                title={t("Double-click to rename")}
                onClick={() =>
                  mutate((draft) => {
                    draft.activeSheetId = sheet.id;
                  })
                }
                onDoubleClick={() => setRenamingSheetId(sheet.id)}
              >
                {sheet.name}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="gl-layout-sheet-add"
          title={t("New blank layout")}
          onClick={() => {
            const next = createLayoutSheet(
              `Layout ${workspace.sheets.length + 1}`,
            );
            mutate((draft) => {
              draft.sheets.push(next);
              draft.activeSheetId = next.id;
            });
            setSelectedItemId(null);
          }}
        >
          +
        </button>
      </div>

      <div className="gl-layout-toolbar">
        <div className="gl-layout-toolbar-group">
          <button
            className="gl-mini-btn"
            type="button"
            onClick={() => addPlot("biplot")}
          >
            {t("+ Biplot")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            onClick={() => addPlot("histogram")}
          >
            {t("+ Histogram")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addStrategy}>
            {t("+ Gating strategy")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            onClick={() =>
              addItem(
                { kind: "text", text: "Text", fontSize: 18 },
                {
                  width: 160,
                  height: 32,
                },
              )
            }
          >
            {t("+ Text")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            onClick={addIllustrationSelection}
          >
            {t("Add Illustration selection")}
          </button>
        </div>
        <div className="gl-layout-toolbar-group">
          <button
            className="gl-mini-btn"
            type="button"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? "Edit layout" : "Preview"}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            disabled={!undoRef.current.length}
            onClick={undo}
          >
            {t("Undo")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            disabled={!redoRef.current.length}
            onClick={redo}
          >
            {t("Redo")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            onClick={() => {
              const copy = {
                ...activeSheet,
                id: crypto.randomUUID(),
                name: `${activeSheet.name} copy`,
                items: activeSheet.items.map((item) => ({
                  ...item,
                  id: crypto.randomUUID(),
                  recipe: { ...item.recipe },
                })),
              };
              mutate((draft) => {
                draft.sheets.push(copy);
                draft.activeSheetId = copy.id;
              });
              setSelectedItemId(null);
            }}
          >
            {t("Duplicate sheet")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            disabled={workspace.sheets.length <= 1}
            onClick={() => {
              mutate((draft) => {
                const index = draft.sheets.findIndex(
                  ({ id }) => id === draft.activeSheetId,
                );
                draft.sheets.splice(index, 1);
                draft.activeSheetId = draft.sheets[Math.max(0, index - 1)].id;
              });
              setSelectedItemId(null);
            }}
          >
            {t("Delete sheet")}
          </button>
        </div>
        <span className="gl-layout-performance-note">
          {t(
            "Only the open sheet renders. Layout plots are view-only; edit gates in Gating.",
          )}
        </span>
      </div>

      {message && (
        <div className="gl-layout-message">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}

      <div className="gl-layout-workspace">
        <aside className="gl-layout-controls" aria-label="Layout controls">
          <nav className="gl-presentation-tabs" aria-label="Layout inspector">
            {["item", "page"].map((tab) => (
              <button
                key={tab}
                aria-pressed={section === tab}
                onClick={() => setSection(tab)}
              >
                {tab === "item" ? "Items" : "Page"}
              </button>
            ))}
          </nav>
          {section === "item" && (
            <>
              <label className="gl-field-inline">
                File for new plots
                <select
                  value={insertFileId}
                  onChange={(event) => setInsertFileId(event.target.value)}
                >
                  {files.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="gl-hint">
                Placed plots keep their own file and hierarchy, independently of
                the Gating selection.
              </p>
              {sourceResult.error && <p role="alert">{sourceResult.error}</p>}
              {!selectedItem && (
                <p className="gl-hint">
                  Select an item to edit its content and appearance. Text can be
                  edited directly on the page.
                </p>
              )}
              {selectedItem && (
                <div
                  className="gl-layout-inspector"
                  aria-label={t("Selected layout item")}
                >
                  <strong>{t("Selected")}</strong>
                  <label className="gl-check">
                    <input
                      type="checkbox"
                      checked={selectedItem.showFrame === true}
                      onChange={(event) =>
                        mutateActiveSheet((sheet) => {
                          const item = sheet.items.find(
                            (item) => item.id === selectedItem.id,
                          );
                          if (item) item.showFrame = event.target.checked;
                        })
                      }
                    />
                    Surrounding frame
                  </label>
                  <div className="gl-layout-dimensions">
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <label key={field}>
                        {field}
                        <input
                          type="number"
                          aria-label={`Item ${field}`}
                          min={
                            field === "width" || field === "height"
                              ? layoutItemMinimum(selectedItem.recipe.kind)[
                                  field
                                ]
                              : 0
                          }
                          value={selectedItem[field]}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            if (!Number.isFinite(value)) return;
                            mutateActiveSheet((sheet) => {
                              const item = sheet.items.find(
                                (item) => item.id === selectedItem.id,
                              );
                              if (item)
                                item[field] = Math.max(
                                  field === "width" || field === "height"
                                    ? layoutItemMinimum(item.recipe.kind)[field]
                                    : 0,
                                  value,
                                );
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  {selectedItem.recipe.kind === "text" ? (
                    <>
                      <label className="gl-field-inline">
                        {t("Text")}
                        <input
                          value={selectedItem.recipe.text}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? { ...recipe, text: event.target.value }
                                : recipe,
                            )
                          }
                        />
                      </label>
                      <label className="gl-field-inline">
                        {t("Font")}
                        <input
                          type="number"
                          min={8}
                          max={72}
                          value={selectedItem.recipe.fontSize}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? {
                                    ...recipe,
                                    fontSize: Math.max(
                                      8,
                                      Number(event.target.value) || 8,
                                    ),
                                  }
                                : recipe,
                            )
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="gl-field-inline">
                        {t("FCS")}
                        <select
                          value={selectedItem.recipe.sampleId}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) => {
                              if (recipe.kind === "text") return recipe;
                              const target = samples.find(
                                (file) => file.id === event.target.value,
                              );
                              if (!target) return recipe;
                              const mapped =
                                selectedSource &&
                                resolveFigurePopulation(
                                  {
                                    hierarchyId: selectedSource.tree.id,
                                    populationId: recipe.populationId,
                                    label: "",
                                  },
                                  target.tree,
                                  figureHierarchies(state),
                                );
                              return {
                                ...recipe,
                                sampleId: target.id,
                                populationId:
                                  mapped?.id ??
                                  target.tree.root_population_id ??
                                  "",
                              };
                            })
                          }
                        >
                          {samples.map((sample) => (
                            <option key={sample.id} value={sample.id}>
                              {sample.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Population")}
                        <select
                          value={selectedItem.recipe.populationId}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : {
                                    ...recipe,
                                    populationId: event.target.value,
                                  },
                            )
                          }
                        >
                          {selectedPopulations.map(({ popId, depth }) => (
                            <option key={popId} value={popId}>
                              {"\u00a0".repeat(depth * 2)}
                              {selectedSource?.tree.populations[popId]?.name ??
                                popId}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedItem.recipe.kind !== "strategy" && (
                        <>
                          <label className="gl-field-inline">
                            X
                            <select
                              value={selectedItem.recipe.xChannel}
                              onChange={(event) =>
                                updateSelectedRecipe((recipe) =>
                                  recipe.kind === "biplot" ||
                                  recipe.kind === "histogram"
                                    ? {
                                        ...recipe,
                                        xChannel: event.target.value,
                                      }
                                    : recipe,
                                )
                              }
                            >
                              {selectedSource?.sample.channels.map(
                                (channel) => (
                                  <option key={channel.key} value={channel.key}>
                                    {selectedSource.sample.channelLabel(
                                      selectedSource.sample.index(
                                        channel.key,
                                      ) ?? 0,
                                    )}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          {selectedItem.recipe.kind === "biplot" && (
                            <label className="gl-field-inline">
                              Y
                              <select
                                value={selectedItem.recipe.yChannel ?? ""}
                                onChange={(event) =>
                                  updateSelectedRecipe((recipe) =>
                                    recipe.kind === "biplot"
                                      ? {
                                          ...recipe,
                                          yChannel: event.target.value,
                                        }
                                      : recipe,
                                  )
                                }
                              >
                                {selectedSource?.sample.channels.map(
                                  (channel) => (
                                    <option
                                      key={channel.key}
                                      value={channel.key}
                                    >
                                      {selectedSource.sample.channelLabel(
                                        selectedSource.sample.index(
                                          channel.key,
                                        ) ?? 0,
                                      )}
                                    </option>
                                  ),
                                )}
                              </select>
                            </label>
                          )}
                        </>
                      )}
                      {selectedItem.recipe.kind === "strategy" && (
                        <label className="gl-check">
                          <input
                            type="checkbox"
                            checked={selectedItem.recipe.fullPath}
                            onChange={(event) =>
                              updateSelectedRecipe((recipe) =>
                                recipe.kind === "strategy"
                                  ? {
                                      ...recipe,
                                      fullPath: event.target.checked,
                                    }
                                  : recipe,
                              )
                            }
                          />
                          {t("Full path from root")}
                        </label>
                      )}
                      <label className="gl-field-inline">
                        {t("Display")}
                        <select
                          value={selectedItem.recipe.displayMode}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : {
                                    ...recipe,
                                    displayMode: event.target
                                      .value as LayoutDisplayMode,
                                  },
                            )
                          }
                        >
                          <option value="pseudocolor">
                            {t("Pseudocolor")}
                          </option>
                          <option value="scatter">{t("Scatter")}</option>
                          <option value="contour">{t("Contour")}</option>
                        </select>
                      </label>
                      <label className="gl-field-inline gl-layout-title-field">
                        {t("Title")}
                        <input
                          placeholder={itemTitle(selectedItem, samples, state)}
                          value={selectedItem.recipe.title ?? ""}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : { ...recipe, title: event.target.value },
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="gl-mini-btn"
                        onClick={() =>
                          onOpenInGating(
                            selectedItem.recipe as
                              | LayoutPlotRecipe
                              | LayoutStrategyRecipe,
                          )
                        }
                      >
                        {t("Open in Gating")}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {section === "page" && (
            <>
              <h3>Page size</h3>
              {(["width", "height"] as const).map((field) => (
                <label className="gl-field-inline" key={field}>
                  {field}
                  <input
                    type="number"
                    min={field === "width" ? 720 : 560}
                    value={activeSheet[field]}
                    onChange={(event) =>
                      mutateActiveSheet((sheet) => {
                        sheet[field] = Math.max(
                          field === "width" ? 720 : 560,
                          Number(event.target.value) || 0,
                        );
                      })
                    }
                  />
                </label>
              ))}
              <p className="gl-hint">
                Preview hides selection handles and the alignment grid. Frames
                are optional for every item.
              </p>
            </>
          )}
        </aside>

        <div className="gl-layout-canvas-scroll">
          <section
            className="gl-layout-canvas"
            aria-label={activeSheet.name}
            style={{ width: activeSheet.width, height: activeSheet.height }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelectedItemId(null);
            }}
          >
            {activeSheet.items.length === 0 && (
              <div className="gl-layout-empty">
                <strong>{t("Blank layout")}</strong>
                <span>
                  {t(
                    "Add a plot, gating strategy, text, or the current Illustration selection.",
                  )}
                </span>
              </div>
            )}
            {activeSheet.items.map((item) => (
              <LayoutItemFrame
                key={item.id}
                item={item}
                selected={item.id === selectedItemId}
                samples={samples}
                state={state}
                globalScales={globalScales}
                dataRevision={dataRevision}
                densityColorPower={densityColorPower}
                onSelect={() => setSelectedItemId(item.id)}
                onTextChange={(text) =>
                  mutateActiveSheet((sheet) => {
                    const target = sheet.items.find(
                      (candidate) => candidate.id === item.id,
                    );
                    if (target?.recipe.kind === "text")
                      target.recipe.text = text;
                  })
                }
                onFrameChange={(frame) =>
                  mutateActiveSheet((sheet) => {
                    const target = sheet.items.find(({ id }) => id === item.id);
                    if (!target) return;
                    Object.assign(target, frame);
                    sheet.width = Math.max(
                      sheet.width,
                      frame.x + frame.width + 48,
                    );
                    sheet.height = Math.max(
                      sheet.height,
                      frame.y + frame.height + 48,
                    );
                  })
                }
                onDelete={() => {
                  mutateActiveSheet((sheet) => {
                    sheet.items = sheet.items.filter(
                      ({ id }) => id !== item.id,
                    );
                  });
                  setSelectedItemId((current) =>
                    current === item.id ? null : current,
                  );
                }}
                onOpenInGating={() => {
                  if (item.recipe.kind !== "text") onOpenInGating(item.recipe);
                }}
              />
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
