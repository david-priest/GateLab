// ScalesTab.tsx — per-channel display axis ranges for the active file or locked comparison frame.
// Compensation has its own tab so transforms and assay-layer changes stay separate.

import type { Sample } from "../engine/sample";
import { useI18n } from "./i18n";

interface Props {
  sample: Sample;
  globalScales: Record<string, [number, number]>;
  onSetGlobalScale: (key: string, range: [number, number] | null) => void;
  lockedBetweenFiles: boolean;
}

export function ScalesTab({ sample, globalScales, onSetGlobalScale, lockedBetweenFiles }: Props) {
  const { t } = useI18n();
  return (
    <div className="gl-tab-panel gl-tab-fill">
      <h2 className="gl-tab-title">{t("Scales")}</h2>

      <section className="gl-scales-section gl-scales-section-grow">
        <div className="gl-section-header">
          {t(lockedBetweenFiles ? "Locked Channel Scales" : "Per-file Channel Scales")}
        </div>
        <p className="gl-hint" style={{ marginBottom: 8 }}>
          {t(lockedBetweenFiles
            ? "These ranges are shared while the scale lock is on. Switching files keeps the same frame for direct comparison. Min/Max are display (transformed) units; blank means auto. Pan/zoom on the Gating tab writes here too."
            : "These ranges belong to the selected file. Switching files loads that file's own fitted or edited frame. Min/Max are display (transformed) units; blank means auto. Pan/zoom on the Gating tab writes here too.")}
        </p>
        <div className="gl-stats-scroll gl-grow-scroll" style={{ maxWidth: 460 }}>
          <table className="gl-scales-table">
            <thead>
              <tr>
                <th className="gl-stats-name">{t("Channel")}</th>
                <th className="gl-stats-num">{t("Min")}</th>
                <th className="gl-stats-num">{t("Max")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sample.channels.map((c, i) => {
                const gs = globalScales[c.key];
                const auto = sample.displayRange(i);
                const r3 = (n: number) => Math.round(n * 1000) / 1000;
                const set = (lo: number, hi: number) => {
                  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) onSetGlobalScale(c.key, [lo, hi]);
                };
                return (
                  <tr key={c.key} className={gs ? "active" : ""}>
                    <td className="gl-stats-name">{sample.channelLabel(i)}</td>
                    <td className="gl-stats-num">
                      <input
                        type="number"
                        className="gl-scale-input"
                        step={0.1}
                        placeholder={String(r3(auto[0]))}
                        value={gs ? r3(gs[0]) : ""}
                        onChange={(e) => set(+e.target.value, gs ? gs[1] : auto[1])}
                      />
                    </td>
                    <td className="gl-stats-num">
                      <input
                        type="number"
                        className="gl-scale-input"
                        step={0.1}
                        placeholder={String(r3(auto[1]))}
                        value={gs ? r3(gs[1]) : ""}
                        onChange={(e) => set(gs ? gs[0] : auto[0], +e.target.value)}
                      />
                    </td>
                    <td className="gl-stats-num">
                      {gs && (
                        <button className="gl-mini-btn" title={t("Clear (revert to auto)")} onClick={() => onSetGlobalScale(c.key, null)}>
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
