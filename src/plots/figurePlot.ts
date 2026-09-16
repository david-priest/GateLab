import { loadMiniPlots } from "./loadPlots";
import type { AxisTicks } from "../engine/ticks";

export function spacedFigureTicks(
  ticks: AxisTicks | undefined,
  range: number[],
  width: number,
  fontSize: number,
): AxisTicks | undefined {
  if (!ticks || !(range[1] > range[0])) return ticks;
  let right = -Infinity;
  const major_labels = ticks.major_labels.map((label, i) => {
    const x = ((ticks.major_pos[i] - range[0]) / (range[1] - range[0])) * width,
      half = label.length * fontSize * 0.32 + 4;
    if (x - half < right) return "";
    right = x + half;
    return label;
  });
  return { ...ticks, major_labels };
}

const NS = "http://www.w3.org/2000/svg";
function text(svg: SVGElement, value: string, x: number, y: number, size = 11) {
  const node = document.createElementNS(NS, "text");
  node.textContent = value;
  node.setAttribute("x", String(x));
  node.setAttribute("y", String(y));
  node.setAttribute("font-size", String(size));
  node.setAttribute("font-family", "Arial, Helvetica, sans-serif");
  node.setAttribute("fill", "#26364a");
  svg.appendChild(node);
  return node;
}

/** Shared on-screen/export entry point; SVG-only summary cells remain vector in exports. */
export function drawFigurePlot(
  node: HTMLElement,
  cfg: Record<string, unknown>,
) {
  if (
    cfg.hist_layout === "ridgeline" &&
    !cfg.y_label &&
    !("figure_summary" in cfg)
  ) {
    const legends = (cfg.legend_entries ?? []) as {
      name: string;
      color: string;
    }[];
    const traces = [
      {
        x: cfg.x,
        name: legends[0]?.name ?? "Population",
        color: cfg.pop_color,
      },
      ...((cfg.overlay_traces ?? []) as object[]),
    ];
    loadMiniPlots().renderRidgelinePanel(node, {
      ...cfg,
      channel: cfg.x_label,
      traces,
      overlap: cfg.ridge_overlap,
      gradient: cfg.ridge_gradient,
      x_logicle_ticks: spacedFigureTicks(
        cfg.x_logicle_ticks as AxisTicks | undefined,
        cfg.x_range as number[],
        Number(cfg.plot_size) - 18,
        Number((cfg.font_sizes as { tick?: number })?.tick) || 10,
      ),
      plot_size: Number(cfg.plot_size) + 22,
      line_width: cfg.hist_line_width,
      show_labels: false,
    });
    return;
  }
  if (!("figure_summary" in cfg)) {
    loadMiniPlots().renderMiniPlot(node, cfg);
    return;
  }
  node.replaceChildren();
  const size = Number(cfg.plot_size) || 80;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("width", String(size));
  rect.setAttribute("height", String(size));
  rect.setAttribute("fill", String(cfg.summary_color ?? "#eeeeee"));
  svg.appendChild(rect);
  const value = cfg.figure_summary;
  const label = text(
    svg,
    typeof value === "number"
      ? Number(value.toPrecision(4)).toLocaleString()
      : "No events",
    size / 2,
    size / 2 + 4,
    12,
  );
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("fill", String(cfg.summary_text_color ?? "#26364a"));
  if (cfg.summary_show_values === false && typeof value === "number")
    label.setAttribute("visibility", "hidden");
  const title = document.createElementNS(NS, "title");
  title.textContent = `${cfg.summary_stat}: ${value ?? "no events"}; ${cfg.n_events} events`;
  svg.appendChild(title);
  node.appendChild(svg);
}
