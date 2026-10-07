// ChorusTimelineModal.tsx — a FACSChorus experiment's sorts and the loaded recordings on one
// clock, each with the tree it carries, and a way to import any of them. The layout comes from
// engine/chorusTimeline.ts; this file only draws it.

import { useEffect, useRef, useState } from "react";
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
  /**
   * The loaded file a snapshot or the current gates would go onto, and whether it is a recording
   * of this experiment (null: it carries no FACSChorus record). When it is not, the buttons say
   * whose gates go onto which file, and nothing is applied until one is pressed.
   */
  target?: {
    name: string;
    same: boolean | null;
    /**
     * For a recording of this experiment, the trees it was recorded under (indices into
     * listChorusTrees) and the sort then running. Any other tree is not its own, and its button
     * says so.
     */
    own?: { treeIndices: number[]; labels: string[]; duringSort: string | null } | null;
  } | null;
  /** Import the experiment's tree at this index (a sort's snapshot, or the current gates). */
  onImportTree: (treeIndex: number) => void;
  /** Import the tree each of these files carries, one hierarchy per distinct tree. */
  onImportRecordings: (fileIds: string[]) => void;
  /** Opens the FCS file picker; the recordings appear here as the files load. */
  onAddFiles?: () => void;
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

export function ChorusTimelineModal({ experimentName, timeline, hasSample, target = null, onImportTree, onImportRecordings, onAddFiles, onCancel }: Props) {
  const { t } = useI18n();
  const foreign = !!experimentName && !!target && target.same !== true;
  const recordedUnder = !!experimentName && target?.same === true ? target.own ?? null : null;
  /** A tree of the experiment that is not the one the viewed recording was made under. */
  const notOwn = (treeIndex: number) => !!recordedUnder && !recordedUnder.treeIndices.includes(treeIndex);
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
          {foreign && (
            <>
              {" "}
              <strong>
                {target!.same === false
                  ? t("{file} was recorded in another FACSChorus experiment, so these gates are not its own.", { file: target!.name })
                  : t("{file} carries no FACSChorus record, so nothing shows these gates are its own.", { file: target!.name })}
              </strong>{" "}
              {t("They are applied to it only if you choose a tree below.")}
            </>
          )}
          {recordedUnder && (
            <>
              {" "}
              <strong>
                {recordedUnder.labels.length
                  ? t("{file} was recorded under the same tree as {trees}.", { file: target!.name, trees: recordedUnder.labels.join(", ") })
                  : t("{file} was recorded under a tree that is neither the current gates nor a sort's snapshot; \"Import this file's tree\" imports its own.", { file: target!.name })}
                {recordedUnder.duringSort ? ` ${t("It was recorded during {sort}.", { sort: recordedUnder.duringSort })}` : ""}
              </strong>
            </>
          )}
          <br />
          {sorts.length > 0 && `${sorts.length} ${t("sorts")} · `}
          {`${recordings.length} ${t("recordings")} ${t("loaded")}`}
          {timeline.recordingCount !== null && ` (${timeline.recordingCount} ${t("recordings in Chorus")})`}
          {recordings.length > 0 && ` · ${timeline.treeGroups} ${t("distinct trees")}`}
          {span && ` · ${new Date(span.start).toLocaleDateString()}`}
        </div>

        {experimentName && recordings.length === 0 && (
          <div className="gl-modal-note gl-chorus-empty">
            {timeline.recordingCount
              ? t("None of this experiment's {count} recordings is loaded, so only the current gates can be imported. Load the recordings' FCS files first (the Tubes folder of the export) and they appear here with the gates each was recorded under.", { count: timeline.recordingCount })
              : t("No recording of this experiment is loaded, so only the current gates can be imported. Load the recordings' FCS files first (the Tubes folder of the export) and they appear here with the gates each was recorded under.")}
            {onAddFiles && (
              <>
                {" "}
                <button type="button" className="gl-btn-ghost gl-chorus-add-files" onClick={onAddFiles}>{t("Files…")}</button>
              </>
            )}
          </div>
        )}

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
                <button className="gl-btn-ghost" onClick={() => onImportTree(item.treeIndex)}>
                  {foreign
                    ? t("Apply this snapshot to {file}…", { file: target!.name })
                    : notOwn(item.treeIndex)
                      ? t("Apply this snapshot to {file}, recorded under another tree…", { file: target!.name })
                      : t("Import snapshot…")}
                </button>
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
              <button className="gl-btn-ghost" onClick={() => onImportTree(timeline.current!.treeIndex)}>
                {foreign
                  ? t("Apply the current gates to {file}…", { file: target!.name })
                  : notOwn(timeline.current.treeIndex)
                    ? t("Apply the current gates to {file}, recorded under another tree…", { file: target!.name })
                    : t("Import current gates…")}
              </button>
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
  const { t } = useI18n();
  // Drawn at the strip's own pixel width, so labels are not stretched with the shapes.
  const ref = useRef<SVGSVGElement>(null);
  const [W, setW] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w) setW(Math.max(300, Math.round(w))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 132, L = 8, R = W - 8;
  const AXIS = 108, SORT_Y = 34, SORT_H = 16, REC_TOP = 60, REC_BOTTOM = AXIS;
  const padMs = Math.max(60_000, (end - start) * 0.06);
  const t0 = start - padMs, t1 = end + padMs;
  const x = (ms: number) => L + ((ms - t0) / (t1 - t0)) * (R - L);
  // Ticks at a round step giving four to eight of them: quarter hours on a short afternoon, hours, then parts of a day.
  const spanMin = (t1 - t0) / 60_000;
  const stepMs = (spanMin <= 90 ? 15 : spanMin <= 180 ? 30 : spanMin <= 480 ? 60 : spanMin <= 1440 ? 180 : 360) * 60_000;
  const ticks: number[] = [];
  for (let ms = Math.ceil(t0 / stepMs) * stepMs; ms <= t1; ms += stepMs) ticks.push(ms);
  const savedT = chorusTime(timeline.current?.savedAt ?? null);
  const short = (name: string) => (name.length > 26 ? `${name.slice(0, 24)}…` : name);
  // Recording labels alternate above and below their mark where two marks sit close.
  const recordings = timeline.items.filter((it) => it.kind === "recording").map((it) => ({ it, at: chorusTime(it.startedAt) })).filter((r) => r.at !== null).sort((a, b) => a.at! - b.at!);
  const labelRow = new Map<string, number>();
  let lastX = -Infinity, row = 0;
  for (const r of recordings) {
    const px = x(r.at!);
    row = px - lastX < 150 ? (row + 1) % 2 : 0;
    labelRow.set(r.it.kind === "recording" ? r.it.fileId : "", row);
    lastX = px;
  }
  return (
    <svg ref={ref} className="gl-chorus-timeline-strip" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t("Sorts, recordings and the current gates on one clock")}>
      <line className="axis" x1={L} y1={AXIS} x2={R} y2={AXIS} />
      {ticks.map((ms) => (
        <g key={ms}>
          <line className="tick" x1={x(ms)} y1={AXIS} x2={x(ms)} y2={AXIS + 5} />
          <text className="tick-label" x={x(ms)} y={AXIS + 16} textAnchor="middle">{clock(new Date(ms).toISOString(), multiDay)}</text>
        </g>
      ))}
      {timeline.items.map((item, i) => {
        const a = chorusTime(item.startedAt);
        if (a === null) return null;
        if (item.kind === "sort") {
          const b = chorusTime(item.stoppedAt) ?? a;
          const x0 = x(a), x1 = Math.max(x(b), x0 + 2);
          const span = `${clock(item.startedAt, false)}${item.stoppedAt ? `–${clock(item.stoppedAt, false)}` : ""}`;
          return (
            <g key={`s-${i}`}>
              <rect className={`sort-bar${item.sameAsCurrent ? " is-current" : ""}`} x={x0} y={SORT_Y} width={x1 - x0} height={SORT_H} rx={2}>
                <title>{`${t("sort")} ${item.name}: ${span}${item.sameAsCurrent ? ` · ${t("same as the current gates")}` : ""}`}</title>
              </rect>
              <text className="bar-label" x={x0 > R - 260 ? x1 : x0} y={SORT_Y - 5} textAnchor={x0 > R - 260 ? "end" : "start"}>{`${t("sort")} · ${short(item.name)} · ${span}`}</text>
              {x1 - x0 > 120 && <text className="bar-inner" x={x0 + 4} y={SORT_Y + 12}>{`${t("sorted")} ${item.sorted.map((d) => d.population).join(", ")}`.slice(0, Math.floor((x1 - x0) / 6))}</text>}
            </g>
          );
        }
        const rowAt = labelRow.get(item.fileId) ?? 0;
        const colour = hierarchyColour(item.treeGroup);
        const labelY = rowAt === 0 ? REC_TOP - 6 : REC_BOTTOM - 18;
        // A label reads away from the nearer edge, so none runs off the strip.
        const left = x(a) > R - 200;
        return (
          <g key={`r-${item.fileId}`}>
            <line className="rec-mark" x1={x(a)} y1={REC_TOP} x2={x(a)} y2={REC_BOTTOM} stroke={colour}>
              <title>{`${t("recording")} ${item.fileName}: ${clock(item.startedAt, true)}`}</title>
            </line>
            <text className="rec-label" x={x(a) + (left ? -4 : 4)} y={labelY} fill={colour} textAnchor={left ? "end" : "start"}>{`${clock(item.startedAt, false)} ${short(item.fileName)}`}</text>
          </g>
        );
      })}
      {savedT !== null && (
        <g>
          <line className="saved-mark" x1={x(savedT)} y1={8} x2={x(savedT)} y2={AXIS} />
          <text className="saved-label" x={x(savedT) + (x(savedT) > R - 200 ? -4 : 4)} y={14} textAnchor={x(savedT) > R - 200 ? "end" : "start"}>{`${t("current gates saved")} ${clock(timeline.current?.savedAt ?? null, false)}`}</text>
        </g>
      )}
    </svg>
  );
}
