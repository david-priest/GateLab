// ScalesTab.tsx — the Scales tab, mirroring GateLabR: (1) Compensation — apply/inspect the
// embedded $SPILLOVER matrix before gating; (2) Global Channel Scales — a fixed per-channel
// display axis range used when that channel is plotted (uniform axes across figures).

import type { Sample } from "../engine/sample";

interface Props {
  sample: Sample;
  compensationOn: boolean;
  onToggleCompensation: (on: boolean) => void;
  globalScales: Record<string, [number, number]>;
  onSetGlobalScale: (key: string, range: [number, number] | null) => void;
}

export function ScalesTab({ sample, compensationOn, onToggleCompensation, globalScales, onSetGlobalScale }: Props) {
  const spill = sample.spillover;

  return (
    <div className="gl-tab-panel gl-tab-fill">
      <h2 className="gl-tab-title">Scales</h2>

      {/* ── Compensation ─────────────────────────────────────────── */}
      <section className="gl-scales-section">
        <div className="gl-section-header">Compensation</div>
        {spill ? (
          <>
            <label className="gl-check" style={{ marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={compensationOn}
                onChange={(e) => onToggleCompensation(e.target.checked)}
              />
              Apply spillover compensation (before gating) — {spill.channels.length} fluorochrome channels
            </label>
            <div className="gl-stats-scroll" style={{ maxHeight: 300 }}>
              <table className="gl-comp-table">
                <thead>
                  <tr>
                    <th></th>
                    {spill.channels.map((c) => (
                      <th key={c} title={c}>{sample.labelForKey(c)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {spill.matrix.map((row, i) => (
                    <tr key={i}>
                      <th title={spill.channels[i]}>{sample.labelForKey(spill.channels[i])}</th>
                      {row.map((v, j) => (
                        <td
                          key={j}
                          className={i === j ? "diag" : v !== 0 ? "spill" : ""}
                          style={i !== j && v > 0 ? { background: `rgba(47,128,237,${Math.min(0.5, v * 3)})` } : undefined}
                        >
                          {i === j ? "1" : v === 0 ? "·" : (v * 100).toFixed(1)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="gl-hint" style={{ marginTop: 6 }}>
              Values are % spillover (off-diagonal). Applied as X·solve(S) to the raw fluorescence
              values; scatter and QC channels pass through untouched.
            </p>
          </>
        ) : (
          <p className="gl-hint">
            No embedded <code>$SPILLOVER</code> matrix in this file{" "}
            {sample.instrument === "cytof" ? "(CyTOF — compensation not applicable)." : "(or it is identity / already compensated)."}
          </p>
        )}
      </section>

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
