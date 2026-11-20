// GatingCompanionPlot.tsx — one of the Gating tab's plots that is not the selected one.
//
// Drawn by the same engine as the selected plot (an instance of its own), from the view's own
// population and channels, so it looks the same and follows the events as gates change. It is
// looked at, not worked on: the whole plot is one button that selects it, after which it is the
// selected plot and takes the tree, the pickers and the draw tools.

import { useMemo } from "react";
import { decodeFloat32Base64 } from "../engine/encode";
import type { AxisTicks } from "../engine/ticks";
import type { GatingFontSizes } from "../engine/workspace";
import type { CompanionPlot, CompanionPlotView } from "../plots/companionPlotPayload";
import { GatingPlot } from "../plots/GatingPlot";
import { HistogramPlot } from "../plots/HistogramPlot";
import { useI18n } from "./i18n";

interface Props {
  /** The engine instance this plot draws with; never 0, which is the selected plot's. */
  instance: number;
  /** The plot's number among the tab's plots, from 1. */
  number: number;
  view: CompanionPlotView;
  /** Null while it has not been built, or when the viewed file lacks the view's channels. */
  plot: CompanionPlot | null;
  /** The Gating tab is showing: a hidden tab's plots are not drawn. */
  visible: boolean;
  fontSizes: GatingFontSizes;
  channelLabel: (key: string) => string;
  onSelect: () => void;
  onRemove: () => void;
}

export function GatingCompanionPlot({ instance, number, view, plot, visible, fontSizes, channelLabel, onSelect, onRemove }: Props) {
  const { t } = useI18n();
  const payload = plot?.payload ?? null;
  const histogramValues = useMemo(() => {
    const x = (payload as { x_b64?: string } | null)?.x_b64;
    return view.histogram && x ? decodeFloat32Base64(x) : null;
  }, [payload, view.histogram]);
  const name = plot?.title ?? "";
  return (
    <div className="gl-plot-peer" data-plot-number={number}>
      <GatingPlot
        instance={instance}
        passive
        exactSize
        payload={payload}
        visible={visible && !view.histogram}
        hidden={view.histogram}
        fontSizes={fontSizes}
      />
      {view.histogram && payload && (
        <HistogramPlot
          values={histogramValues}
          xRange={(payload as { x_range: [number, number] }).x_range}
          ticks={(payload as { x_logicle_ticks?: AxisTicks | null }).x_logicle_ticks ?? null}
          channel={view.xKey}
          channelOptions={[{ value: view.xKey, label: channelLabel(view.xKey) }]}
          onChannelChange={() => undefined}
          gates={plot!.gates}
          selectedGateId={null}
          mode="navigate"
          fontSizes={fontSizes}
        />
      )}
      {!plot && <div className="gl-plot-peer-empty">{t("This file does not have this plot's channels.")}</div>}
      {name && <div className="gl-plot-peer-name" title={name}>{name}</div>}
      <button
        type="button"
        className="gl-plot-peer-select"
        aria-label={name
          ? t("Select plot {number}: {name}", { number, name })
          : t("Select plot {number}", { number })}
        title={t("Click to work on this plot")}
        onClick={onSelect}
      />
      <button
        type="button"
        className="gl-plot-remove"
        aria-label={t("Remove plot {number}", { number })}
        title={t("Remove this plot")}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
