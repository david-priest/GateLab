// ChannelTransformSelect.tsx — the display transform of one channel: linear or arcsinh for scatter and
// imaging features, logicle, arcsinh or biexponential for fluorescence. The Gating tab's Transforms
// row shows it for the two plotted axes and the Scales tab for every channel; both set it on the
// channel, so it is the same in every file. A channel with one scale (CyTOF, Time) shows that
// scale and nothing to choose. Gates live in raw space, so no choice moves an event in or out.

import type { Sample } from "../engine/sample";
import { useI18n } from "./i18n";

export type ChannelTransformKind = "fluor" | "scatter" | "imaging" | null;

/** Which choice a channel offers: null where it has one scale. */
export function channelTransformKind(sample: Sample, idx: number): ChannelTransformKind {
  return sample.isFluorChannel(idx) ? "fluor" : sample.isScatterAxis(idx) ? "scatter" : sample.isImagingFeatureAxis(idx) ? "imaging" : null;
}

/** The name of the one scale a channel without a choice is drawn on. */
function fixedScaleName(sample: Sample, idx: number): string {
  const key = sample.channels[idx]?.key;
  let kind = "identity";
  try {
    if (key) kind = sample.transformSpec(key).kind;
  } catch {
    // A channel the transform cannot describe is drawn linearly.
  }
  return kind === "asinh" ? "Arcsinh" : kind === "logicle" ? "Logicle" : kind === "biex" ? "Biexponential" : "Linear";
}

export function ChannelTransformSelect({ sample, idx, label, onChanged }: {
  sample: Sample;
  idx: number;
  /** Names the control for assistive technology: the axis ("X") or the channel. */
  label: string;
  /** Called after the transform changed, for the caller to refit the ranges the old one framed. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const kind = channelTransformKind(sample, idx);
  if (kind === "scatter") {
    return (
      <select
        className="gl-scatter-scale"
        aria-label={`${label} scatter scale`}
        title={t("Arcsinh (cofactor 150) renders near-zero and negative scatter that a linear axis cannot. Linear is the usual display for scatter.")}
        value={sample.scatterScale(idx) === "linear" ? "linear" : "arcsinh"}
        onChange={(e) => {
          sample.setScatterScale(idx, e.target.value === "linear" ? "linear" : "arcsinh");
          onChanged();
        }}
      >
        <option value="linear">{t("Linear")}</option>
        <option value="arcsinh">{t("Arcsinh")}</option>
      </select>
    );
  }
  if (kind === "imaging") {
    return (
      <select
        className="gl-scatter-scale"
        aria-label={`${label} imaging scale`}
        title={t("A shape or position feature the instrument derived from the cell's image. Linear is how FACSChorus shows it; arcsinh (cofactor 150) spreads the values near zero. Gates live in raw space, so neither moves an event in or out of a gate.")}
        value={sample.featureScale(idx)}
        onChange={(e) => {
          sample.setFeatureScale(idx, e.target.value === "arcsinh" ? "arcsinh" : "linear");
          onChanged();
        }}
      >
        <option value="linear">{t("Linear")}</option>
        <option value="arcsinh">{t("Arcsinh")}</option>
      </select>
    );
  }
  if (kind === "fluor") {
    return (
      <select
        className="gl-scatter-scale"
        aria-label={`${label} signal scale`}
        title={t("Logicle is estimated per channel and shaped by W. Arcsinh is shaped by its cofactor, which sets where the linear region around zero gives way to log. Gates live in raw space, so neither moves an event in or out of a gate.")}
        value={sample.fluorScale(idx)}
        onChange={(e) => {
          sample.setFluorScale(idx, e.target.value === "arcsinh" ? "arcsinh" : e.target.value === "biex" ? "biex" : "logicle");
          onChanged();
        }}
      >
        <option value="logicle">{t("Logicle")}</option>
        <option value="arcsinh">{t("Arcsinh")}</option>
        {sample.biexOffered(idx) && (
          <option value="biex">{t("Biexponential")}</option>
        )}
      </select>
    );
  }
  const name = fixedScaleName(sample, idx);
  return (
    <select className="gl-scatter-scale" aria-label={`${label} scale`} disabled value="fixed" title={t("This axis has one scale.")}>
      <option value="fixed">{t(name)}</option>
    </select>
  );
}
