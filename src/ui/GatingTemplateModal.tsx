// GatingTemplateModal.tsx — before a gating template is applied, every channel its gates read set
// beside the channel of the viewed file it will read, with how it was found; a channel found
// other than by its name is marked, one not found blocks the import until it is chosen by hand
// (David, 2026-11-10; plan D6). Nothing changes until Continue.

import { useI18n } from "./i18n";
import { ModalEscape } from "./useModalEscape";
import type { TemplateChannelMatch, TemplateChannelRow } from "../gatingTemplate";

export interface GatingTemplateModalProps {
  fileName: string;
  treeName: string;
  nGates: number;
  nPopulations: number;
  /** Where the template was written: the file it was exported viewing, and when. */
  sourceFileName: string | null;
  savedAt: string;
  rows: readonly TemplateChannelRow[];
  /** The viewed file's channels, to choose from. */
  channels: readonly { key: string; label: string }[];
  /** Other loaded files lacking a channel the mapped gates read. */
  filesMissing: readonly { file: string; channels: readonly string[] }[];
  scalesAvailable: boolean;
  withScales: boolean;
  compensationNote: string | null;
  notes: readonly string[];
  onPick: (templateKey: string, targetKey: string | null) => void;
  onScales: (withScales: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}

const FOUND_BY: Record<TemplateChannelMatch, string> = {
  key: "same name",
  pnn: "same detector ($PnN)",
  marker: "same marker ($PnS)",
  name: "name, ignoring case and punctuation",
  manual: "chosen",
};

const PROBLEM: Record<NonNullable<TemplateChannelRow["problem"]>, string> = {
  missing: "not found; choose one",
  ambiguous: "more than one matches; choose one",
  shared: "another template channel has it; choose one",
};

export function GatingTemplateModal(props: GatingTemplateModalProps) {
  const { t } = useI18n();
  const { rows } = props;
  const ok = rows.every((r) => r.target !== null);
  const otherwise = rows.filter((r) => r.target !== null && r.by !== "key").length;
  return (
    <div className="gl-modal-backdrop">
      <ModalEscape onClose={props.onCancel} />
      <div className="gl-modal" style={{ maxWidth: 680 }} role="dialog" aria-label={t("Apply gating template")}>
        <div className="gl-modal-title">{t("Apply gating template")}</div>
        <div className="gl-modal-note">
          {t("\"{tree}\" from {file}: {gates} gate(s), {populations} population(s).", { tree: props.treeName, file: props.fileName, gates: props.nGates, populations: props.nPopulations })}
          {props.sourceFileName ? <>{" "}{t("Exported viewing {file}.", { file: props.sourceFileName })}</> : null}
        </div>
        <div className="gl-modal-note">
          {t("Each channel the template's gates read, and the channel of this file it will read. Nothing changes until you continue.")}
          {otherwise > 0 && <>{" "}{t("{count} found other than by name, marked below.", { count: otherwise })}</>}
        </div>
        <table className="gl-template-channels" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>{t("Template channel")}</th>
              <th style={{ textAlign: "left" }}>{t("Channel in this file")}</th>
              <th style={{ textAlign: "left" }}>{t("Found by")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const marked = row.target === null || row.by !== "key";
              const detail = [row.channel.pnn !== row.channel.key ? row.channel.pnn : null, row.channel.marker && row.channel.marker !== row.channel.key ? row.channel.marker : null].filter(Boolean).join(" · ");
              return (
                <tr key={row.channel.key} data-marked={marked ? "true" : undefined}
                  style={marked ? { background: `color-mix(in srgb, var(${row.target === null ? "--gl-color-danger" : "--gl-color-accent"}) 12%, transparent)` } : undefined}>
                  <td style={{ padding: "3px 6px" }}>
                    {row.channel.key}
                    {detail && <span style={{ opacity: 0.7 }}>{" "}({detail})</span>}
                  </td>
                  <td style={{ padding: "3px 6px" }}>
                    <select
                      aria-label={t("Channel for {channel}", { channel: row.channel.key })}
                      value={row.target ?? ""}
                      onChange={(e) => props.onPick(row.channel.key, e.target.value || null)}
                    >
                      <option value="">{t("(none)")}</option>
                      {props.channels.map((c) => <option key={c.key} value={c.key}>{c.label === c.key ? c.key : `${c.label} (${c.key})`}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "3px 6px" }}>{row.problem ? t(PROBLEM[row.problem]) : row.by ? t(FOUND_BY[row.by]) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {props.filesMissing.map((f) => (
          <div key={f.file} className="gl-modal-note">
            {t("{file} lacks {channels}, which the template's gates read.", { file: f.file, channels: f.channels.join(", ") })}
          </div>
        ))}
        <label className="gl-modal-field" style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
          <input type="checkbox" checked={props.withScales && props.scalesAvailable} disabled={!props.scalesAvailable}
            onChange={(e) => props.onScales(e.target.checked)} />
          <span>
            {props.scalesAvailable
              ? t("Show this file on the template's axes (scales and ranges). Display only: the gates hold the same events either way.")
              : t("The template carries no axes; this file keeps its own.")}
          </span>
        </label>
        {props.compensationNote && <div className="gl-modal-note">{props.compensationNote}</div>}
        {props.notes.map((n, i) => <div key={i} className="gl-modal-note">{n}</div>)}
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={props.onCancel}>{t("Cancel")}</button>
          <button className="gl-btn" disabled={!ok} onClick={props.onContinue}>{t("Continue")}</button>
        </div>
      </div>
    </div>
  );
}
