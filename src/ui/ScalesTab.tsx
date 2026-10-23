// ScalesTab.tsx — per-channel display axis ranges for the active file or locked comparison frame.
// The ranges are a file's own unless the scale lock is on; the display transform is the channel's,
// the same in every file. Compensation has its own tab so transforms and assay-layer changes stay
// separate.

import type { Sample } from "../engine/sample";
import { useI18n } from "./i18n";
import { TabIntro, TabIntroToggle, useTabIntro } from "./TabIntro";

interface Props {
  sample: Sample;
  globalScales: Record<string, [number, number]>;
  onSetGlobalScale: (key: string, range: [number, number] | null) => void;
  lockedBetweenFiles: boolean;
}

export function ScalesTab({ sample, globalScales, onSetGlobalScale, lockedBetweenFiles }: Props) {
  const { t } = useI18n();
  const intro = useTabIntro("scales");
  return (
    <div className="gl-tab-panel gl-tab-fill">
      <h2 className="gl-tab-title">{t("Scales")}</h2>

      <section className="gl-scales-section gl-scales-section-grow">
        <div className="gl-section-header">
          {t(lockedBetweenFiles ? "Axis ranges · shared by all files" : "Axis ranges · this file")}
          <TabIntroToggle intro={intro} />
        </div>
        <TabIntro intro={intro} className="gl-scales-intro">
          {t(lockedBetweenFiles
            ? "The scale lock is on, so these ranges are shared by every file and switching files keeps the same frame. The display transform (linear, logicle, arcsinh) belongs to the channel and is the same in every file whether or not the lock is on. Min and Max are in display (transformed) units; blank means automatic. Panning and zooming on the Gating tab write here too."
            : "Each file keeps its own axis ranges: switching files loads that file's fitted or edited range. The display transform (linear, logicle, arcsinh) belongs to the channel and is the same in every file. Min and Max are in display (transformed) units; blank means automatic. Panning and zooming on the Gating tab write here too.")}
        </TabIntro>
        <div className="gl-stats-scroll gl-grow-scroll" style={{ maxWidth: 560 }}>
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
