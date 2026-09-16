// ChorusTimelineModal.tsx — a FACSChorus experiment's sorts and the loaded recordings on one
// clock, each with the tree it carries, and a way to import any of them. The layout comes from
// engine/chorusTimeline.ts; this file only draws it.

import type { ChorusTimeline, ChorusTimelineItem } from "../engine/chorusTimeline";
import { chorusTime } from "../engine/chorusTimeline";
import { hierarchyColour } from "../engine/hierarchies";
import { useI18n } from "./i18n";

interface Props {
  /** Null when the dialog stands on the loaded files alone. */
  experimentName: string | null;
  timeline: ChorusTimeline;
  /** Whether an FCS is loaded; without one a sort's snapshot needs its FCS chosen next. */
  hasSample: boolean;
  /** Import the experiment's tree at this index (a sort's snapshot, or the current gates). */
  onImportTree: (treeIndex: number) => void;
  /** Import the tree each of these files carries, one hierarchy per distinct tree. */
  onImportRecordings: (fileIds: string[]) => void;
  onCancel: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
function clock(iso: string | null, withDate: boolean): string {
  const t = chorusTime(iso);
  if (t === null) return "–";
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}` : hm;
}
const num = (n: number | null) => (n === null ? "–" : n.toLocaleString("en-US"));

export function ChorusTimelineModal({ experimentName, timeline, hasSample, onImportTree, onImportRecordings, onCancel }: Props) {
  const { t } = useI18n();
  const recordings = timeline.items.filter((i): i is Extract<ChorusTimelineItem, { kind: "recording" }> => i.kind === "recording");
  const sorts = timeline.items.filter((i): i is Extract<ChorusTimelineItem, { kind: "sort" }> => i.kind === "sort");
  const span = timeline.span ? { start: chorusTime(timeline.span.start)!, end: chorusTime(timeline.span.end)! } : null;
  const multiDay = span !== null && new Date(span.start).toDateString() !== new Date(span.end).toDateString();

  return (
    <div className="gl-modal-backdrop" onClick={onCancel}>
      <div className="gl-modal gl-chorus-timeline" role="dialog" aria-label="Choose which gates to import" onClick={(e) => e.stopPropagation()}>
        <div className="gl-modal-title">
          {experimentName ? `${t("FACSChorus experiment")} · ${experimentName}` : t("Gates recorded in the loaded files")}
        </div>
        <div className="gl-modal-note">
          {t("Every FCS the S8 exports carries the gates it was recorded under; a .cef carries the gates as they are now and a snapshot at the start of every sort, but no recordings. Sorts and recordings are laid out on one clock, in local time.")}
          {experimentName && !hasSample && ` ${t("Choose a gate tree, then choose the FCS file containing its event data.")}`}
          <br />
          {sorts.length > 0 && `${sorts.length} ${t("sorts")} · `}
          {`${recordings.length} ${t("recordings")} ${t("loaded")}`}
          {timeline.recordingCount !== null && ` (${timeline.recordingCount} ${t("recordings in Chorus")})`}
          {recordings.length > 0 && ` · ${timeline.treeGroups} ${t("distinct trees")}`}
          {span && ` · ${new Date(span.start).toLocaleDateString()}`}
        </div>

        {span && <TimelineStrip timeline={timeline} start={span.start} end={span.end} multiDay={multiDay} />}

        <div className="gl-chorus-timeline-list">
          {timeline.items.map((item, i) =>
            item.kind === "sort" ? (
              <div key={`s-${i}`} className="gl-chorus-timeline-row is-sort">
                <span className="gl-chorus-timeline-when">
                  {clock(item.startedAt, multiDay)}{item.stoppedAt ? `–${clock(item.stoppedAt, false)}` : ""}
                </span>
                <span className="gl-chorus-timeline-kind">{t("sort")}</span>
                <span className="gl-chorus-timeline-what">
                  <span className="gl-wsp-name">{item.name}</span>
                  <span className="gl-wsp-meta">
                    {`${item.gateCount} ${t("gates")}`}
                    {item.totalEvents !== null ? ` · ${num(item.totalEvents)} ${t("events")}` : ""}
                    {item.sorted.length ? ` · ${t("sorted")}: ${item.sorted.map((d) => `${d.population} ${num(d.sortCount)}`).join(", ")}` : ""}
                    {item.sameAsCurrent ? ` · ${t("same as the current gates")}` : ""}
                    {item.recordedWith.length ? ` · ${t("same tree as")} ${item.recordedWith.join(", ")}` : ""}
                  </span>
                </span>
                <button className="gl-btn-ghost" onClick={() => onImportTree(item.treeIndex)}>{t("Import snapshot…")}</button>
              </div>
            ) : (
              <div key={`r-${item.fileId}`} className={`gl-chorus-timeline-row${item.sameExperiment === false ? " is-foreign" : ""}`}>
                <span className="gl-chorus-timeline-when">{clock(item.startedAt, multiDay)}</span>
                <span className="gl-chorus-timeline-kind">{t("recording")}</span>
                <span className="gl-chorus-timeline-what">
                  <span className="gl-wsp-name">
                    <span className="gl-chorus-timeline-group" style={{ background: hierarchyColour(item.treeGroup) }} aria-hidden="true" />
                    {item.fileName}
                    {item.name && item.name !== item.fileName.replace(/\.fcs$/i, "") ? ` (${item.name})` : ""}
                  </span>
                  <span className="gl-wsp-meta">
                    {item.eventCount !== null ? `${num(item.eventCount)} ${t("events")} · ` : ""}
                    {`${item.gateCount} ${t("gates")}`}
                    {item.duringSort ? ` · ${t("during")} ${item.duringSort}` : ""}
                    {item.matchesTrees.length ? ` · ${t("same tree as")} ${item.matchesTrees.join(", ")}` : ""}
                    {item.sameExperiment === false ? ` · ${t("from another experiment")}` : ""}
                  </span>
                </span>
                <button className="gl-btn-ghost" onClick={() => onImportRecordings([item.fileId])}>{t("Import this file's tree")}</button>
              </div>
            ),
          )}
          {timeline.current && (
            <div className="gl-chorus-timeline-row is-sort">
              <span className="gl-chorus-timeline-when">{timeline.current.savedAt ? `${t("saved")} ${clock(timeline.current.savedAt, multiDay)}` : ""}</span>
              <span className="gl-chorus-timeline-kind">{t("current gates")}</span>
              <span className="gl-chorus-timeline-what">
                <span className="gl-wsp-name">{t("Current gates")}</span>
                <span className="gl-wsp-meta">{`${timeline.current.gateCount} ${t("gates")}`}</span>
              </span>
              <button className="gl-btn-ghost" onClick={() => onImportTree(timeline.current!.treeIndex)}>{t("Import current gates…")}</button>
            </div>
          )}
          {timeline.items.length === 0 && !timeline.current && (
            <div className="gl-modal-note" style={{ padding: 10 }}>{t("No loaded file carries a FACSChorus recording.")}</div>
          )}
        </div>

        <div className="gl-chorus-timeline-actions">
          {recordings.length > 0 && (
            <button className="gl-btn-ghost" onClick={() => onImportRecordings(recordings.map((r) => r.fileId))}>
              {t("Import each file's own tree")} ({recordings.length} {t("files")}, {timeline.treeGroups} {t("trees")})
            </button>
          )}
          {recordings.length > 0 && <div className="gl-hint">{t("One tree for the workspace, the viewed file's recording, tailored per file where the recordings differ; a file recorded under a different tree is reported.")}</div>}
          <div className="gl-hint">{t("A snapshot or the current gates can go to all files, the selected files or the viewed file; you choose after Import.")}</div>
        </div>
        <div className="gl-modal-actions">
          <button onClick={onCancel}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

/** Sorts as bars, recordings as marks coloured by the tree they carry, the save as a dashed line. */
function TimelineStrip({ timeline, start, end, multiDay }: { timeline: ChorusTimeline; start: number; end: number; multiDay: boolean }) {
  const W = 1000, H = 96, L = 8, R = 992;
  const padMs = Math.max(60_000, (end - start) * 0.03);
  const t0 = start - padMs, t1 = end + padMs;
  const x = (ms: number) => L + ((ms - t0) / (t1 - t0)) * (R - L);
  // Tick every whole hour when the span allows about four to eight ticks, else every quarter day.
  const spanH = (t1 - t0) / 3_600_000;
  const stepMs = spanH <= 8 ? 3_600_000 : spanH <= 24 ? 3 * 3_600_000 : 6 * 3_600_000;
  const ticks: number[] = [];
  for (let ms = Math.ceil(t0 / stepMs) * stepMs; ms <= t1; ms += stepMs) ticks.push(ms);
  const savedT = chorusTime(timeline.current?.savedAt ?? null);
  return (
    <svg className="gl-chorus-timeline-strip" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <line className="axis" x1={L} y1={72} x2={R} y2={72} />
      {ticks.map((ms) => (
        <g key={ms}>
          <line className="tick" x1={x(ms)} y1={72} x2={x(ms)} y2={77} />
          <text className="tick-label" x={x(ms)} y={88} textAnchor="middle">{clock(new Date(ms).toISOString(), multiDay)}</text>
        </g>
      ))}
      {timeline.items.map((item, i) => {
        const a = chorusTime(item.startedAt);
        if (a === null) return null;
        if (item.kind === "sort") {
          const b = chorusTime(item.stoppedAt) ?? a;
          const x0 = x(a), x1 = Math.max(x(b), x0 + 2);
          return (
            <g key={`s-${i}`}>
              <rect className={`sort-bar${item.sameAsCurrent ? " is-current" : ""}`} x={x0} y={14} width={x1 - x0} height={18} rx={2}>
                <title>{`${item.name}: ${clock(item.startedAt, true)}${item.stoppedAt ? `–${clock(item.stoppedAt, false)}` : ""}`}</title>
              </rect>
              {x1 - x0 > 60 && <text className="bar-label" x={x0 + 3} y={11}>{item.name}</text>}
            </g>
          );
        }
        return (
          <line key={`r-${item.fileId}`} className="rec-mark" x1={x(a)} y1={40} x2={x(a)} y2={62} stroke={hierarchyColour(item.treeGroup)}>
            <title>{`${item.fileName}: ${clock(item.startedAt, true)}`}</title>
          </line>
        );
      })}
      {savedT !== null && <line className="saved-mark" x1={x(savedT)} y1={8} x2={x(savedT)} y2={72} />}
    </svg>
  );
}
