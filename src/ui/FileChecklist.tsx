// FileChecklist.tsx — the file picker of the Illustration, Plotting and Strategy tabs, where
// several files are chosen: a checkbox per file in the file list's order, All, None and, where the
// tab offers it, the files checked in the file list; a filter box; each file's values in the
// metadata columns the tab is using; and the file list's metadata chips under "Select by metadata".
// A tab that chooses one file (Strategy unpooled, a Layout plot) keeps its own single choice.

import { useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "./i18n";
import { FoldSummary } from "./FoldSummary";
import { facetColumns, groupCheckedCount, toggleGroupChecked } from "../engine/sampleFacets";
import "./figure.css";

export interface FileChecklistFile {
  id: string;
  name: string;
  fileName?: string;
  metadata?: Record<string, string>;
}

export function FileChecklist({
  files,
  selected,
  onChange,
  checkedIds,
  columns = [],
  levels,
  selectByMetadata = true,
  listLabel,
  listClassName,
  searchLabel,
}: Readonly<{
  /** The files, in the file list's order. */
  files: readonly FileChecklistFile[];
  selected: readonly string[];
  /** A ticked file is added at the end of the selection and an unticked one removed from it. */
  onChange: (ids: string[]) => void;
  /** The files checked in the file list; given, "Use checked files" takes them. */
  checkedIds?: readonly string[];
  /** The metadata columns the tab is using, whose values each row shows. */
  columns?: readonly string[];
  /** A metadata column's order of its values, for the chips. */
  levels?: Readonly<Record<string, readonly string[] | undefined>>;
  /** Offer the metadata chips when the files carry metadata. */
  selectByMetadata?: boolean;
  listLabel?: string;
  /** Extra class names for the list, which a tab's own styles and tests address. */
  listClassName?: string;
  searchLabel?: string;
}>) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const chosen = useMemo(() => new Set(selected), [selected]);
  const facets = useMemo(() => {
    if (!selectByMetadata) return [];
    const metadata = Object.fromEntries(files.filter((f) => f.metadata).map((f) => [f.id, f.metadata!]));
    const names = [...new Set(Object.values(metadata).flatMap((m) => Object.keys(m)))];
    return facetColumns(metadata, names.map((name) => ({ name, ...(levels?.[name] ? { levels: [...levels[name]!] } : {}) })));
  }, [files, levels, selectByMetadata]);
  const excluded = useMemo(() => new Set(files.filter((f) => !chosen.has(f.id)).map((f) => f.id)), [files, chosen]);
  const query = search.trim().toLowerCase();
  const shown = query ? files.filter((f) => `${f.name} ${f.fileName ?? ""}`.toLowerCase().includes(query)) : files;
  const valuesOf = (file: FileChecklistFile) =>
    columns.map((column) => [column, file.metadata?.[column] ?? ""] as const).filter(([, value]) => value.trim());

  return (
    <div className="gl-file-checklist">
      <div className="gl-figure-actions gl-figure-list-actions">
        {checkedIds && (
          <button type="button" className="gl-mini-btn" onClick={() => onChange([...checkedIds])}>
            {t("Use checked files")}
          </button>
        )}
        <button type="button" className="gl-mini-btn" onClick={() => onChange(files.map((f) => f.id))}>{t("All")}</button>
        <button type="button" className="gl-mini-btn" onClick={() => onChange([])}>{t("None")}</button>
      </div>
      <input
        type="search"
        className="gl-file-checklist-search"
        aria-label={searchLabel ?? t("Find file / sample…")}
        placeholder={t("Find file / sample…")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={`gl-figure-list${listClassName ? ` ${listClassName}` : ""}`} role="group" aria-label={listLabel ?? t("Files / samples")}>
        {shown.map((file) => {
          const values = valuesOf(file);
          return (
            <label key={file.id} className="gl-figure-row" title={file.fileName && file.fileName !== file.name ? `${file.name} · ${file.fileName}` : file.name}>
              <input
                type="checkbox"
                checked={chosen.has(file.id)}
                onChange={() => onChange(chosen.has(file.id) ? selected.filter((id) => id !== file.id) : [...selected, file.id])}
              />
              <span className="gl-figure-row-name">{file.name}{file.fileName && file.fileName !== file.name && <small>{file.fileName}</small>}</span>
              {values.length > 0 && (
                <small className="gl-figure-row-meta" title={values.map(([column, value]) => `${column}: ${value}`).join("\n")}>
                  {values.map(([, value]) => value).join(" · ")}
                </small>
              )}
            </label>
          );
        })}
      </div>
      {facets.length > 0 && (
        <details className="gl-figure-facets-fold" open>
          <FoldSummary>{t("Select by metadata")}</FoldSummary>
          <div className="gl-sample-facets gl-figure-facets" aria-label={t("Select files by metadata")}>
            {facets.map((column) => (
              <div key={column.name} className="gl-sample-facet-row">
                <span className="gl-sample-facet-lock" aria-hidden="true" />
                <span className="gl-sample-facet-name" title={column.name}>{column.name}</span>
                <div className="gl-sample-facet-values">
                  {column.values.map((entry) => {
                    const on = groupCheckedCount(entry.sampleIds, excluded);
                    const total = entry.sampleIds.length;
                    const chipState = on === total ? "all" : on === 0 ? "none" : "some";
                    const fill = total > 0 ? Math.round((on / total) * 100) : 0;
                    return (
                      <button
                        key={entry.value}
                        type="button"
                        className={`gl-sample-facet-chip is-${chipState}`}
                        style={chipState === "some" ? { "--gl-facet-fill": `${fill}%` } as CSSProperties : undefined}
                        aria-pressed={on === total}
                        title={`${entry.value}: ${on} of ${total} selected — ${on === total ? `click to deselect all ${total}` : `click to select all ${total}`}`}
                        onClick={() => {
                          const next = toggleGroupChecked(entry.sampleIds, excluded);
                          onChange(files.filter((f) => !next.has(f.id)).map((f) => f.id));
                        }}
                      >
                        <span className="gl-sample-facet-label">{entry.value}</span>
                        <span className="gl-sample-facet-count">{on}/{total}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
