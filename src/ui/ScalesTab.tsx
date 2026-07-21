// ScalesTab.tsx — global per-channel display axis ranges. Compensation now has its own tab so
// transforms and assay-layer changes are not mixed into one control surface.

import type { Sample } from "../engine/sample";

interface Props {
  sample: Sample;
  globalScales: Record<string, [number, number]>;
  onSetGlobalScale: (key: string, range: [number, number] | null) => void;
}

export function ScalesTab({ sample, globalScales, onSetGlobalScale }: Props) {
  return (
    <div className="gl-tab-panel gl-tab-fill">
      <h2 className="gl-tab-title">Scales</h2>

      {/* ── Global Channel Scales ────────────────────────────────── */}
      <section className="gl-scales-section gl-scales-section-grow">
        <div className="gl-section-header">Global Channel Scales</div>
        <p className="gl-hint" style={{ marginBottom: 8 }}>
          Min/Max are in <strong>display (transformed) units</strong> — the logicle scale for
          fluorescence channels, arcsinh for scatter / CyTOF — <em>not</em> raw values, so they won't
          match the axis's decade labels (100, 1K, 10K…, which are the raw values). A fixed range per
          channel is used whenever that channel is plotted (blank = auto), keeping axes uniform across
          panels. Pan/zoom on the Gating tab writes here too.
        </p>
        <div className="gl-stats-scroll gl-grow-scroll" style={{ maxWidth: 460 }}>
          <table className="gl-scales-table">
            <thead>
              <tr>
                <th className="gl-stats-name">Channel</th>
                <th className="gl-stats-num">Min</th>
                <th className="gl-stats-num">Max</th>
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
                        <button className="gl-mini-btn" title="Clear (revert to auto)" onClick={() => onSetGlobalScale(c.key, null)}>
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
