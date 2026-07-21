import { useEffect, useMemo, useState } from "react";

export interface SampleListItem {
  id: string;
  name: string;
  eventCount: number;
  channelCount: number;
  sourcePath?: string;
}

export interface FolderImportItem {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  duplicateName: boolean;
}

export interface SampleImportProgress {
  current: number;
  total: number;
  name: string;
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function matchesQuery(item: SampleListItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return item.name.toLocaleLowerCase().includes(needle) ||
    (item.sourcePath?.toLocaleLowerCase().includes(needle) ?? false);
}

export function SampleNavigator({
  items,
  activeId,
  excludedIds,
  busy,
  importProgress,
  onOpenFiles,
  onOpenFolder,
  onManage,
  onManageSample,
  onActivate,
  onToggleIncluded,
  onIncludeAll,
  onIncludeNone,
  onInvertIncluded,
}: {
  items: readonly SampleListItem[];
  activeId: string | null;
  excludedIds: ReadonlySet<string>;
  busy: boolean;
  importProgress: SampleImportProgress | null;
  onOpenFiles: () => void;
  onOpenFolder: () => void;
  onManage: () => void;
  onManageSample: (id: string) => void;
  onActivate: (id: string) => void;
  onToggleIncluded: (id: string, included: boolean) => void;
  onIncludeAll: () => void;
  onIncludeNone: () => void;
  onInvertIncluded: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => items.filter((item) => matchesQuery(item, query)), [items, query]);
  const includedCount = items.reduce((count, item) => count + Number(!excludedIds.has(item.id)), 0);

  return (
    <section className="gl-sample-navigator" aria-label="FCS samples">
      <div className="gl-sample-heading">
        <div className="gl-side-title">Samples</div>
        <span>{includedCount} / {items.length} included</span>
      </div>
      <div className="gl-sample-add-actions">
        <button type="button" className="gl-btn gl-sample-add-primary" disabled={busy} onClick={onOpenFiles}>
          + Files…
        </button>
        <button type="button" className="gl-mini-btn" disabled={busy} onClick={onOpenFolder}>
          + Folder…
        </button>
        <button type="button" className="gl-mini-btn" disabled={busy || items.length === 0} onClick={onManage}>
          Manage…
        </button>
      </div>

      {items.length > 0 && (
        <div className="gl-sample-inclusion-actions" aria-label="Analysis inclusion">
          <span>Analyses</span>
          <button type="button" onClick={onIncludeAll}>All</button>
          <button type="button" onClick={onIncludeNone}>None</button>
          <button type="button" onClick={onInvertIncluded}>Invert</button>
        </div>
      )}

      {items.length >= 5 && (
        <input
          className="gl-sample-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search samples…"
          aria-label="Search samples"
        />
      )}

      {importProgress && (
        <div className="gl-sample-import-progress" role="status" aria-live="polite">
          <div>
            <span>Loading {importProgress.current} / {importProgress.total}</span>
            <span title={importProgress.name}>{importProgress.name}</span>
          </div>
          <progress max={importProgress.total} value={Math.max(0, importProgress.current - 1)} />
        </div>
      )}

      <div className="gl-sample-list" role="listbox" aria-label="Loaded FCS samples">
        {items.length === 0 ? (
          <em className="gl-hint">No files loaded.</em>
        ) : visible.length === 0 ? (
          <em className="gl-hint">No samples match “{query}”.</em>
        ) : visible.map((item) => {
          const included = !excludedIds.has(item.id);
          const active = item.id === activeId;
          const exactSummary = `${item.eventCount.toLocaleString()} events · ${item.channelCount} channels`;
          return (
            <div
              key={item.id}
              className={`gl-sample-row${active ? " active" : ""}`}
              role="option"
              aria-selected={active}
              tabIndex={0}
              title={`${item.sourcePath ?? item.name}\n${exactSummary}`}
              onClick={() => onActivate(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onActivate(item.id);
                }
              }}
            >
              <input
                type="checkbox"
                className="gl-sample-include"
                title="Include this sample in multi-sample analyses"
                aria-label={`Include ${item.name} in analyses`}
                checked={included}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onToggleIncluded(item.id, event.target.checked)}
              />
              <span className="gl-sample-active-dot" aria-hidden="true" />
              <span className="gl-sample-name">{item.name}</span>
              <span className="gl-sample-meta" title={exactSummary}>
                {compactNumber.format(item.eventCount)} · {item.channelCount}ch
              </span>
              <button
                type="button"
                className="gl-sample-row-menu"
                aria-label={`Manage ${item.name}`}
                title="Manage this sample"
                onClick={(event) => {
                  event.stopPropagation();
                  onManageSample(item.id);
                }}
              >
                ⋯
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ModalFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal gl-sample-manager-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="gl-modal-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function SampleManagerModal({
  items,
  activeId,
  excludedIds,
  initialSelectedIds = [],
  onClose,
  onActivate,
  onToggleIncluded,
  onIncludeAll,
  onIncludeNone,
  onInvertIncluded,
  onRemove,
}: {
  items: readonly SampleListItem[];
  activeId: string | null;
  excludedIds: ReadonlySet<string>;
  initialSelectedIds?: readonly string[];
  onClose: () => void;
  onActivate: (id: string) => void;
  onToggleIncluded: (id: string, included: boolean) => void;
  onIncludeAll: () => void;
  onIncludeNone: () => void;
  onInvertIncluded: () => void;
  onRemove: (ids: readonly string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(initialSelectedIds));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const visible = useMemo(() => items.filter((item) => matchesQuery(item, query)), [items, query]);

  useEffect(() => {
    setSelectedIds((previous) => new Set([...previous].filter((id) => items.some((item) => item.id === id))));
  }, [items]);

  const selectVisible = (selected: boolean) => {
    setConfirmRemove(false);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const item of visible) selected ? next.add(item.id) : next.delete(item.id);
      return next;
    });
  };

  return (
    <ModalFrame title="Manage samples">
      <div className="gl-sample-manager-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search filename or source…"
          aria-label="Search managed samples"
        />
        <span>{items.length} files</span>
      </div>
      <div className="gl-sample-manager-actions">
        <span>Manage selection</span>
        <button type="button" onClick={() => selectVisible(true)}>All visible</button>
        <button type="button" onClick={() => selectVisible(false)}>None visible</button>
        <span className="gl-sample-manager-separator" />
        <span>Analyses</span>
        <button type="button" onClick={onIncludeAll}>All</button>
        <button type="button" onClick={onIncludeNone}>None</button>
        <button type="button" onClick={onInvertIncluded}>Invert</button>
      </div>
      <div className="gl-sample-manager-table-wrap">
        <table className="gl-sample-manager-table">
          <thead>
            <tr>
              <th aria-label="Select for management" />
              <th>Active</th>
              <th>Analyses</th>
              <th>File</th>
              <th>Events</th>
              <th>Channels</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id} className={item.id === activeId ? "active" : ""}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.name} for management`}
                    checked={selectedIds.has(item.id)}
                    onChange={(event) => {
                      setConfirmRemove(false);
                      setSelectedIds((previous) => {
                        const next = new Set(previous);
                        event.target.checked ? next.add(item.id) : next.delete(item.id);
                        return next;
                      });
                    }}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name="active-managed-sample"
                    aria-label={`Make ${item.name} active`}
                    checked={item.id === activeId}
                    onChange={() => onActivate(item.id)}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Include ${item.name} in analyses`}
                    checked={!excludedIds.has(item.id)}
                    onChange={(event) => onToggleIncluded(item.id, event.target.checked)}
                  />
                </td>
                <td className="gl-sample-manager-file" title={item.name}>{item.name}</td>
                <td>{item.eventCount.toLocaleString()}</td>
                <td>{item.channelCount}</td>
                <td className="gl-sample-manager-source" title={item.sourcePath ?? "Individually selected file"}>
                  {item.sourcePath ?? "Individual file"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmRemove ? (
        <div className="gl-sample-manager-confirm" role="alert">
          <span>Remove {selectedIds.size} selected sample{selectedIds.size === 1 ? "" : "s"} from this workspace?</span>
          <button type="button" className="gl-btn-ghost" onClick={() => setConfirmRemove(false)}>Cancel</button>
          <button
            type="button"
            className="gl-btn gl-btn-danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              await onRemove([...selectedIds]);
              setRemoving(false);
              setSelectedIds(new Set());
              setConfirmRemove(false);
            }}
          >
            {removing ? "Removing…" : "Remove"}
          </button>
        </div>
      ) : (
        <div className="gl-modal-actions">
          <button
            type="button"
            className="gl-btn-ghost gl-sample-manager-remove"
            disabled={selectedIds.size === 0}
            onClick={() => setConfirmRemove(true)}
          >
            Remove selected…
          </button>
          <button type="button" className="gl-btn" onClick={onClose}>Done</button>
        </div>
      )}
    </ModalFrame>
  );
}

export function FolderImportModal({
  folderName,
  items,
  onCancel,
  onImport,
}: {
  folderName: string;
  items: readonly FolderImportItem[];
  onCancel: () => void;
  onImport: (ids: readonly string[]) => void;
}) {
  const onlyNested = items.length > 0 && items.every((item) => item.relativePath.includes("/"));
  const [includeSubfolders, setIncludeSubfolders] = useState(onlyNested);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(
    items
      .filter((item) => (onlyNested || !item.relativePath.includes("/")) && !item.duplicateName)
      .map((item) => item.id),
  ));

  const eligible = useMemo(
    () => items.filter((item) => includeSubfolders || !item.relativePath.includes("/")),
    [includeSubfolders, items],
  );
  const selectedBytes = eligible.reduce(
    (sum, item) => sum + (selectedIds.has(item.id) ? item.size : 0),
    0,
  );

  const changeSubfolders = (include: boolean) => {
    setIncludeSubfolders(include);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const item of items) {
        if (!item.relativePath.includes("/")) continue;
        if (include && !item.duplicateName) next.add(item.id);
        else next.delete(item.id);
      }
      return next;
    });
  };

  return (
    <ModalFrame title={`Import FCS folder · ${folderName}`}>
      <div className="gl-folder-import-summary">
        Found {items.length} FCS file{items.length === 1 ? "" : "s"}. Review this snapshot before adding it to the workspace.
      </div>
      <div className="gl-folder-import-actions">
        <label>
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => changeSubfolders(event.target.checked)}
          />
          Include subfolders
        </label>
        <button type="button" onClick={() => setSelectedIds(new Set(eligible.map((item) => item.id)))}>All</button>
        <button type="button" onClick={() => setSelectedIds(new Set())}>None</button>
        <span>{selectedIds.size} selected · {compactNumber.format(selectedBytes)}B</span>
      </div>
      <div className="gl-folder-import-list">
        {items.map((item) => {
          const nestedDisabled = !includeSubfolders && item.relativePath.includes("/");
          return (
            <label key={item.id} className={nestedDisabled ? "disabled" : ""}>
              <input
                type="checkbox"
                disabled={nestedDisabled}
                checked={selectedIds.has(item.id)}
                onChange={(event) => {
                  setSelectedIds((previous) => {
                    const next = new Set(previous);
                    event.target.checked ? next.add(item.id) : next.delete(item.id);
                    return next;
                  });
                }}
              />
              <span title={item.relativePath}>{item.relativePath}</span>
              <span>{compactNumber.format(item.size)}B</span>
              {item.duplicateName && <span className="gl-folder-import-duplicate">name already loaded</span>}
            </label>
          );
        })}
      </div>
      <div className="gl-modal-actions">
        <button type="button" className="gl-btn-ghost" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="gl-btn"
          disabled={selectedIds.size === 0}
          onClick={() => onImport([...selectedIds])}
        >
          Import {selectedIds.size} file{selectedIds.size === 1 ? "" : "s"}
        </button>
      </div>
    </ModalFrame>
  );
}
