// CrudModals.tsx — rename prompt + "Create Population" dialog (add_pop_btn).
// Create Population mirrors app.R: name, parent select, per-gate Include (AND) checkboxes.

import { useMemo, useRef, useState } from "react";
import type { CoreState, Action } from "../store";
import { wouldCreateCycle, type GateRef } from "../engine/models";
import { populationTreeOrder } from "../engine/populations";
import { pickFilesOrInput } from "../engine/fsAccess";

/** Picker types for the CSV/TSV tables the dialogs import. */
const TABLE_ACCEPT = { "text/csv": [".csv", ".tsv", ".txt"] };
import {
  FCS_EXPORT_VERSION,
  passesPopulationFcsExportThreshold,
  type FcsExportAssay,
} from "../engine/fcsExport";
import { CYTOBANK_OMITS_CONTRADICTIONS, analyzeCytobankContradictions, analyzeCytobankOrOmissions, analyzeGatingMLQuadrantOmissions, type GatingMLFormat } from "../engine/gatingmlExport";
import type { GatingImportMode, GatingImportTarget } from "../engine/gatingMerge";
import {
  parsePopulationEditTable,
  serializePopulationEditTemplate,
  type PopulationBulkEditPreview,
  type PopulationBulkEditUpdate,
} from "../engine/populationTable";
import { useI18n } from "./i18n";
import { gateRefLabel, EXCLUDE_HINT } from "./gateRefLabel";
import { FlowJoGridOption } from "./FlowJoGridOption";
import { fitsInZip, formatByteSize, ZIP_MAX_BYTES, type FlowJoFolderPreview, type FlowJoNameProblem } from "../engine/flowjoExportFolder";

function ModalShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="gl-modal-backdrop">
      <div className="gl-modal">
        <div className="gl-modal-title">{t(title)}</div>
        {children}
      </div>
    </div>
  );
}

/** What a gating import was read from. Every kind arrives as Gating-ML, but the user chose a file. */
export type GatingImportSourceKind = "gatingml" | "flowjo" | "chorus" | "diva";
const IMPORT_TITLES: Record<GatingImportSourceKind, string> = {
  gatingml: "Import Gating-ML",
  flowjo: "Import FlowJo workspace",
  chorus: "Import FACSChorus gates",
  diva: "Import FACSDiva gates",
};

/** Gating import summary and explicit replace/merge strategy choice. */
export function GatingMlImportModal({
  nGates,
  nPopulations,
  sourceLabel,
  sourceKind = "gatingml",
  currentRootName,
  hasExistingStrategy,
  mergeBlockedReason,
  compensationNote,
  compensationNeedsConfirmation,
  matrixChoice,
  onMatrixChoice,
  files = null,
  perFileNames = null,
  primaryByChoice = null,
  followNames = null,
  onCancel,
  onImport,
  structureMatches,
  busy = false,
  missingMatrix = null,
  onSupplyMatrix,
  onUseFcsMatrix,
  flowJoGrid = null,
  onFlowJoGrid,
}: {
  nGates: number;
  nPopulations: number;
  sourceLabel: string;
  sourceKind?: GatingImportSourceKind;
  currentRootName: string;
  hasExistingStrategy: boolean;
  mergeBlockedReason: string | null;
  compensationNote: string | null;
  compensationNeedsConfirmation: boolean;
  /**
   * The loaded files, when there is more than one: the tree needs a target. `tailored` counts
   * the files with a tailored copy of their own, which "all files" drops.
   */
  files?: { total: number; selected: number; viewedName: string; tailored: number } | null;
  /**
   * The files of a per-file import, each to get its own sample's tree: one tree, tailored per
   * file. No target is chosen then, and the question is not asked; it offered "All N files", a
   * tree every file follows, for an import that tailors each file to its own sample.
   */
  perFileNames?: readonly string[] | null;
  /**
   * Under a per-file import, the loaded files with no tree of their own in it: no sample is the
   * file, or its strategy could not be read. They follow the tree, and are named here as well as
   * in the result; the dialog used to name only the files that got their own tree.
   */
  followNames?: readonly string[] | null;
  /** Whose tree the first of perFileNames gets by the user's choice, when not its own sample's. */
  primaryByChoice?: string | null;
  /** An import is running: Import is disabled so a second click cannot apply it twice. */
  busy?: boolean;
  /**
   * Offered when the loaded FCS and the workspace each carry a spillover matrix and they are not
   * the same. Both are legitimate — the file's is what the instrument recorded, the workspace's
   * is what the analysis used — so this is a choice, not a correction. `source` says where the
   * gates' matrix came from: a FlowJo workspace, or a Gating-ML file that carries its own
   * (value "workspace" then means that file's matrix). The dialog names it, rather than calling
   * a Gating-ML file's matrix the workspace's.
   */
  matrixChoice: {
    workspaceLabel: string;
    maxDelta: number;
    value: "workspace" | "file";
    source?: "workspace" | "gatingml";
    /**
     * Under a per-file import, the files whose own matrix differs from their sample's in the
     * workspace. The answer applies to each of them; the question used to be put only when the
     * primary file's differed, and another file's was settled without a word.
     */
    files?: readonly string[];
  } | null;
  onMatrixChoice: (value: "workspace" | "file") => void;
  onCancel: () => void;
  onImport: (mode: GatingImportMode, target: GatingImportTarget) => void;
  /**
   * The imported tree has the workspace tree's structure, so it can tailor files instead of
   * replacing the tree. False, or absent, when there is no tree yet or the structures differ.
   */
  structureMatches?: boolean;
  /**
   * Gates drawn under a compensation the file names and does not carry (a Cytobank
   * compensation_id with no matrix). Import waits until the user supplies that matrix
   * (`supplied`, the file it came from) or chooses the FCS file's own knowingly (`useFcs`): the
   * FCS file's matrix is never taken for it unasked.
   */
  missingMatrix?: { supplied: string | null; useFcs: boolean; error: string | null } | null;
  onSupplyMatrix?: (file: File) => void;
  onUseFcsMatrix?: (useFcs: boolean) => void;
  /**
   * "Evaluate gates as FlowJo does", for a FlowJo workspace imported onto the loaded files, which
   * no earlier dialog asked. Changing it reads the workspace again (`busy` meanwhile). Null where
   * the dialog that opened the workspace asked it.
   */
  flowJoGrid?: { value: boolean; busy: boolean } | null;
  onFlowJoGrid?: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const canTailor = hasExistingStrategy && structureMatches === true;
  // The default, and the option marked recommended. A tree whose structure differs from the
  // workspace's (!canTailor, which also closes the per-file targets below) replaces it: Merge was
  // the default whenever a tree was present, and hung a second strategy beneath the root for every
  // file. Merge stays the default where the structure matches and nothing blocks it. Until the
  // user chooses, the default follows the tree the dialog shows, which a matrix answer can change.
  const recommended: GatingImportMode = canTailor && !mergeBlockedReason ? "merge" : "replace";
  const [chosenMode, setMode] = useState<GatingImportMode | null>(null);
  const mode = chosenMode ?? recommended;
  // Every file unless some file has tailored gates of its own, which applying to all would
  // discard; then the selection, which the user chose.
  const [target, setTarget] = useState<GatingImportTarget>(
    canTailor && files && files.tailored > 0 && files.selected > 0 ? "selected" : "all",
  );
  const perFile = !!perFileNames && perFileNames.length > 1;
  const askTarget = !!files && files.total > 1 && !perFile;

  return (
    <ModalShell title={t(IMPORT_TITLES[sourceKind])}>
      <div className="gl-modal-note">{t("Parsed {gates} gates and {populations} populations from {source}.", { gates: nGates, populations: nPopulations, source: t(sourceLabel) })}</div>
      {flowJoGrid && onFlowJoGrid && (
        <FlowJoGridOption checked={flowJoGrid.value} disabled={flowJoGrid.busy || busy} onChange={onFlowJoGrid} />
      )}
      {compensationNote && (
        <div className={compensationNeedsConfirmation ? "gl-modal-warning" : "gl-modal-note"} role={compensationNeedsConfirmation ? "alert" : undefined}>
          {compensationNote}
        </div>
      )}
      {missingMatrix && (
        <div className="gl-modal-field">
          <label style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text)" }}>
            <span>{t("Load the matrix these gates were drawn under (CSV or TSV)")}</span>
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              aria-label={t("Load the matrix these gates were drawn under (CSV or TSV)")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onSupplyMatrix?.(file);
              }}
            />
          </label>
          {missingMatrix.supplied && (
            <span className="gl-modal-note">{t("The gates will be evaluated with the matrix from {name}.", { name: missingMatrix.supplied })}</span>
          )}
          {missingMatrix.error && <span className="gl-modal-warning" role="alert">{missingMatrix.error}</span>}
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input
              type="checkbox"
              checked={missingMatrix.useFcs}
              disabled={missingMatrix.supplied !== null}
              onChange={(e) => onUseFcsMatrix?.(e.target.checked)}
            />
            <span>{t("Use this FCS file's own matrix instead. It is not the one these gates were drawn under, so the events they hold will differ.")}</span>
          </label>
        </div>
      )}
      {matrixChoice && (
        <div className="gl-modal-field">
          <span>
            {matrixChoice.files?.length
              ? t("These files and their samples in the workspace each carry a spillover matrix, and they differ by up to {delta}: {files}. Which should the gates be evaluated with, for each of them?", { delta: matrixChoice.maxDelta.toFixed(4), files: matrixChoice.files.join(", ") })
              : matrixChoice.source === "gatingml"
                ? t("This FCS and the Gating-ML file each carry a spillover matrix, and they differ by up to {delta}. Which should the gates be evaluated with?", { delta: matrixChoice.maxDelta.toFixed(4) })
                : t("This FCS and the workspace each carry a spillover matrix, and they differ by up to {delta}. Which should the gates be evaluated with?", { delta: matrixChoice.maxDelta.toFixed(4) })}
          </span>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input
              type="radio"
              name="gatingml-import-matrix"
              value="workspace"
              checked={matrixChoice.value === "workspace"}
              onChange={() => onMatrixChoice("workspace")}
            />
            <span>
              {matrixChoice.source === "gatingml"
                ? t("The Gating-ML file's — {name}. This is the compensation the gates were drawn under.", { name: matrixChoice.workspaceLabel })
                : t("The workspace's — {name}. This is the compensation in force when the gates were drawn.", { name: matrixChoice.workspaceLabel })}
            </span>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input
              type="radio"
              name="gatingml-import-matrix"
              value="file"
              checked={matrixChoice.value === "file"}
              onChange={() => onMatrixChoice("file")}
            />
            <span>{t("The file's — the matrix stored in the FCS, typically the one recorded at acquisition.")}</span>
          </label>
        </div>
      )}
      {/* With nothing in the workspace there is nothing to merge with and nothing to replace,
          so the question has no answer that means anything. It stays on "replace", which on an
          empty workspace is simply "import". Asking it anyway made a first import look as
          though it were about to destroy work that does not exist. */}
      {hasExistingStrategy && (
      <div className="gl-modal-field">
        <span>{t("How should the imported strategy be applied?")}</span>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input
            type="radio"
            name="gatingml-import-mode"
            value="merge"
            checked={mode === "merge"}
            disabled={mergeBlockedReason !== null}
            onChange={() => setMode("merge")}
          />
          <span>
            <strong>{recommended === "merge" ? t("Merge with current strategy (recommended)") : t("Merge with current strategy")}</strong><br />
            <span className="gl-modal-note">
              {t("Keep current gates and populations; add imported top-level populations beneath {root}. Scientific labels are preserved.", { root: currentRootName })}
            </span>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input
            type="radio"
            name="gatingml-import-mode"
            value="replace"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
          />
          <span>
            <strong>{recommended === "replace" ? t("Replace current strategy (recommended)") : t("Replace current strategy")}</strong><br />
            <span className="gl-modal-note">{t("Remove the current gates and populations and use the imported hierarchy.")}</span>
          </span>
        </label>
      </div>
      )}
      {hasExistingStrategy && mergeBlockedReason &&
        <div className="gl-modal-warning" role="alert">{mergeBlockedReason}</div>}
      {perFile && (
        <div className="gl-modal-note">
          {mode === "replace" && primaryByChoice
            ? t("These {count} files get one tree for the workspace, tailored per file where they differ: {files}. {file} gets \"{sample}\"'s tree by choice; each of the others gets its own sample's.",
                { count: perFileNames!.length, files: perFileNames!.join(", "), file: perFileNames![0], sample: primaryByChoice })
            : mode === "replace"
            // A FACSDiva or FACSChorus experiment is not a workspace, and its files are tubes or
            // recordings: said as the result says it, "as in the experiment".
            ? t(sourceKind === "diva"
                ? "Each of these {count} files gets its own tube's tree, as in the experiment: one tree, tailored per file where they differ: {files}."
                : sourceKind === "chorus"
                  ? "Each of these {count} files gets the tree it was recorded under, as in the experiment: one tree, tailored per file where they differ: {files}."
                  : "Each of these {count} files gets its own sample's tree: one tree for the workspace, tailored per file where they differ: {files}.",
                { count: perFileNames!.length, files: perFileNames!.join(", ") })
            : t(sourceKind === "diva"
                ? "Merged, only {file}'s tree is imported, and the other files' are not; files already tailored keep their tailoring. Replace the current strategy to give each of the {count} files its own tube's tree."
                : sourceKind === "chorus"
                  ? "Merged, only {file}'s tree is imported, and the other files' are not; files already tailored keep their tailoring. Replace the current strategy to give each of the {count} files the tree it was recorded under."
                  : "Merged, only {file}'s tree is imported, and the other files' are not; files already tailored keep their tailoring. Replace the current strategy to give each of the {count} files its own sample's tree.",
                { file: perFileNames![0], count: perFileNames!.length })}
          {mode === "replace" && followNames && followNames.length > 0 && (
            <>{" "}{t("These follow the tree without a tree of their own: {files}.", { files: followNames.join(", ") })}</>
          )}
        </div>
      )}
      {askTarget && files && (
      <div className="gl-modal-field">
        <span>{t("Which files should be gated with it?")}</span>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input type="radio" name="gatingml-import-target" value="all" checked={target === "all"} onChange={() => setTarget("all")} />
          <span>
            <strong>{t("All {count} files", { count: files.total })}</strong><br />
            <span className="gl-modal-note">
              {files.tailored > 0
                ? mode === "merge" && hasExistingStrategy
                  // A merge keeps the tree, so the files tailored to it keep their tailoring; it
                  // was dropped, and a file an earlier per-file import had given its own sample's
                  // geometry took another sample's.
                  ? (files.tailored === 1
                      ? t("It is merged into the tree every file follows; the one with tailored gates of its own keeps them.")
                      : t("It is merged into the tree every file follows; the {count} with tailored gates of their own keep them.", { count: files.tailored }))
                  : (files.tailored === 1
                      ? t("It becomes the tree every file follows; the one with tailored gates of its own loses them.")
                      : t("It becomes the tree every file follows; the {count} with tailored gates of their own lose them.", { count: files.tailored }))
                : t("It becomes the tree every file follows. Tailor a gate for one file later by editing that file only.")}
            </span>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input type="radio" name="gatingml-import-target" value="selected" checked={target === "selected"} disabled={!canTailor || files.selected === 0} onChange={() => setTarget("selected")} />
          <span>
            <strong>{files.selected === 1 ? t("The 1 selected file") : t("The {count} selected files", { count: files.selected })}</strong><br />
            <span className="gl-modal-note">{files.selected === 1
              ? t("Its coordinates become its tailoring of the tree; the other files keep theirs.")
              : t("Its coordinates become their tailoring of the tree; the other files keep theirs.")}</span>
          </span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
          <input type="radio" name="gatingml-import-target" value="viewed" checked={target === "viewed"} disabled={!canTailor} onChange={() => setTarget("viewed")} />
          <span>
            <strong>{t("Only the viewed file, {name}", { name: files.viewedName })}</strong><br />
            <span className="gl-modal-note">{t("Its coordinates become this file's tailoring of the tree; the tree and the other files keep theirs.")}</span>
          </span>
        </label>
        {!canTailor && (
          <span className="gl-modal-note">
            {hasExistingStrategy
              ? t("Its structure differs from this workspace's tree, so it can only replace the tree for every file. A different tree belongs in a different workspace.")
              : t("There is no tree yet, so it becomes the tree for every file.")}
          </span>
        )}
      </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button
          className="gl-btn"
          disabled={busy || !!flowJoGrid?.busy || (!!missingMatrix && missingMatrix.supplied === null && !missingMatrix.useFcs)}
          onClick={() => onImport(mode, askTarget ? target : "all")}
        >{busy ? t("Importing…") : t("Import")}</button>
      </div>
    </ModalShell>
  );
}

/** One loaded file as the FlowJo export dialog lists it. */
export interface FlowJoExportFile {
  id: string;
  name: string;
  /** The hierarchy this file is gated under, as the file's sample will carry it. */
  hierarchy: string;
  checked: boolean;
}

export type FlowJoExportScope = "checked" | "all";

/** The export's option to write the FCS files beside the workspace, in a folder of their own. */
export interface FlowJoExportFolderOption {
  /** "directory" where the browser can write a folder; "zip" where it downloads the folder as one .zip. */
  writes: "directory" | "zip";
  preview: (scope: FlowJoExportScope) => FlowJoFolderPreview | { error: string };
}

/** A character as the dialog shows it: itself where it can be seen, else its code point. */
const shownCharacter = (c: string): string =>
  /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\p{White_Space}]/u.test(c)
    ? `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    : c;

/** Why Chrome will not write a file's own name, in the dialog's words. */
function nameProblemText(problem: FlowJoNameProblem, t: (source: string, values?: Record<string, string | number>) => string): string {
  switch (problem.kind) {
    case "characters": return t("holds {characters}, which a file name cannot", { characters: problem.characters.map(shownCharacter).join(" ") });
    case "ends": return t("begins or ends with a space, \".\" or \"~\"");
    case "extension": return t("ends in .{extension}, which Chrome will not write", { extension: problem.extension });
    case "reserved": return t("is a name Windows reserves");
    case "tilde": return t("is a short name with a \"~\", which Chrome will not write on Windows");
    case "empty": return t("is empty, \".\" or \"..\"");
  }
}

/**
 * FlowJo workspace export: which files, what the file will carry, and what was approximated.
 * The warnings come from a dry run of the export, so what the dialog says is what the file does.
 */
export function FlowJoExportModal({
  files,
  plan,
  folder,
  onCancel,
  onExport,
}: {
  files: FlowJoExportFile[];
  plan: (scope: FlowJoExportScope) => { warnings: string[]; sampleCount: number; gateCount: number } | { error: string };
  folder?: FlowJoExportFolderOption;
  onCancel: () => void;
  onExport: (scope: FlowJoExportScope, asFolder: boolean) => void;
}) {
  const { t } = useI18n();
  const checked = files.filter((f) => f.checked);
  const [scope, setScope] = useState<FlowJoExportScope>(checked.length ? "checked" : "all");
  const [asFolder, setAsFolder] = useState(false);
  const listed = scope === "checked" ? checked : files;
  const preview = useMemo(() => plan(scope), [plan, scope]);
  const folderPreview = useMemo(() => (asFolder && folder ? folder.preview(scope) : null), [asFolder, folder, scope]);
  const zipTooLarge = !!folderPreview && !("error" in folderPreview) && folder?.writes === "zip" && !fitsInZip(folderPreview);
  const blocked = "error" in preview || (!!folderPreview && "error" in folderPreview) || zipTooLarge;
  return (
    <ModalShell title="Export FlowJo workspace">
      <div className="gl-modal-note">
        {t("Written in the layout of a FlowJo 10.10 workspace: one sample per file, holding the tree that file is gated under, gate vertices in raw values, and each parameter's axis declared as FlowJo declares it (linear, biexponential, log, or arcsinh for mass cytometry). FlowJo opens it, and BD FACSChorus reads it with Import from FlowJo.")}
      </div>
      <div className="gl-modal-field">
        <span>{t("Files")}</span>
        <label className="gl-radio-row">
          <input type="radio" name="flowjo-export-scope" checked={scope === "checked"} disabled={!checked.length} onChange={() => setScope("checked")} />
          <span>{t("Checked files ({count})", { count: checked.length })}</span>
        </label>
        <label className="gl-radio-row">
          <input type="radio" name="flowjo-export-scope" checked={scope === "all"} onChange={() => setScope("all")} />
          <span>{t("All loaded files ({count})", { count: files.length })}</span>
        </label>
      </div>
      <ul className="gl-modal-list">
        {listed.map((f) => {
          // A tailored file's own copy of the tree is named "<file> · <tree>" (tailoredCopy), so
          // after the file's name it read "<file> · <file> · <tree>".
          const own = f.hierarchy.startsWith(`${f.name} · `) ? f.hierarchy.slice(f.name.length + 3) : null;
          return (
            <li key={f.id}>{f.name} <span className="gl-muted">· {own !== null ? t("{tree}, this file's own copy", { tree: own }) : f.hierarchy}</span></li>
          );
        })}
      </ul>
      {folder && (
        <div className="gl-modal-field">
          <label style={{ display: "flex", alignItems: "flex-start", gap: 7, color: "var(--text)" }}>
            <input type="checkbox" name="flowjo-export-folder" checked={asFolder} onChange={(e) => setAsFolder(e.target.checked)} />
            <span>
              <strong>{t("Save the FCS files with it, in a self-contained folder")}</strong><br />
              <span className="gl-modal-note">{t("Each file is written as GateLab loaded it, byte for byte, beside the workspace and under its own name, and the workspace names it there, so FlowJo, FlowKit, CytoML and GateLab find the files wherever the folder is moved.")}</span>
            </span>
          </label>
          {folderPreview && ("error" in folderPreview ? (
            <div className="gl-modal-warning" role="alert">{folderPreview.error}</div>
          ) : (
            <>
              <div className="gl-modal-note">
                {folder.writes === "directory"
                  ? t(folderPreview.fileCount === 1
                    ? "{workspace} and 1 FCS file, {size}, are written into a new folder, {folder}, inside the folder you choose."
                    : "{workspace} and {count} FCS files, {size}, are written into a new folder, {folder}, inside the folder you choose.", {
                      workspace: folderPreview.workspaceName, count: folderPreview.fileCount, size: formatByteSize(folderPreview.fcsBytes), folder: folderPreview.folderName,
                    })
                  : t(folderPreview.fileCount === 1
                    ? "This browser cannot write a folder, so the folder is downloaded as {folder}.zip, stored uncompressed: {workspace} and 1 FCS file, at most {size} in all."
                    : "This browser cannot write a folder, so the folder is downloaded as {folder}.zip, stored uncompressed: {workspace} and {count} FCS files, at most {size} in all.", {
                      workspace: folderPreview.workspaceName, count: folderPreview.fileCount, size: formatByteSize(folderPreview.zipBytes), folder: folderPreview.folderName,
                    })}
              </div>
              {zipTooLarge && (
                <div className="gl-modal-warning" role="alert">
                  {t("That is more than one .zip can hold ({limit}). Export fewer files, or use a browser that writes folders, such as Chrome or Edge.", { limit: formatByteSize(ZIP_MAX_BYTES) })}
                </div>
              )}
              {folderPreview.renamed.length > 0 && (
                <div className="gl-modal-note">
                  {t("Chrome will not write these names as they are, so each file is written under the name shown. The workspace names it by that name, and its bytes are unchanged, keywords and $FIL included, so FlowJo, FlowKit, CytoML and GateLab still pair it with its sample:")}
                  <ul className="gl-modal-list">
                    {folderPreview.renamed.map((r) => (
                      <li key={r.path}>{r.name} → {r.path}: {r.problems.map((p) => nameProblemText(p, t)).join("; ")}</li>
                    ))}
                  </ul>
                </div>
              )}
              {folderPreview.moved.length > 0 && (
                <div className="gl-modal-note">
                  {t("In a subfolder under their own names, because another file of the export has the name; the workspace names each where it is:")}
                  <ul className="gl-modal-list">
                    {folderPreview.moved.map((m) => <li key={m.path}>{m.name} → {m.path}</li>)}
                  </ul>
                </div>
              )}
              {folderPreview.missing.length > 0 && (
                <div className="gl-modal-warning" role="alert">
                  {t("GateLab does not hold the bytes of these files, so the folder will not have them; the workspace still names each, and FlowJo will look for it beside the workspace:")}
                  <ul>
                    {folderPreview.missing.map((name, i) => <li key={i}>{name}</li>)}
                  </ul>
                </div>
              )}
            </>
          ))}
        </div>
      )}
      {"error" in preview ? (
        <div className="gl-modal-warning" role="alert">{preview.error}</div>
      ) : (
        <>
          <div className="gl-modal-note">
            {t("{gates} gate element(s) across {samples} sample(s).", { gates: preview.gateCount, samples: preview.sampleCount })}
          </div>
          {preview.warnings.length > 0 && (
            <div className="gl-modal-warning" role="alert">
              <ul>
                {preview.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn" disabled={blocked || listed.length === 0} onClick={() => onExport(scope, asFolder && !!folder)}>{t("Export")}</button>
      </div>
    </ModalShell>
  );
}

/** Gating-ML export options plus explicit warnings for formats that cannot be lossless. */
export function GatingMlExportModal({
  state,
  onCancel,
  onExport,
}: {
  state: CoreState;
  onCancel: () => void;
  onExport: (format: GatingMLFormat) => void;
}) {
  const { t } = useI18n();
  const [format, setFormat] = useState<GatingMLFormat>("standard");
  const quadrantOmissions = analyzeGatingMLQuadrantOmissions(state.gates, state.populations);
  // Beneath an OR population the Cytobank format leaves everything out, by name; an OR population
  // there is left out with the rest rather than blocking the export.
  const orOmissions = state.root_population_id
    ? analyzeCytobankOrOmissions(state.populations, state.root_population_id)
    : { populationIds: [], names: [] };
  const beneathOr = new Set(orOmissions.populationIds);
  const nestedOrPopulations = Object.values(state.populations).filter(
    (p) =>
      p.gate_logic === "or" &&
      p.gate_refs.length > 1 &&
      p.parent_id !== null &&
      p.parent_id !== state.root_population_id &&
      !beneathOr.has(p.population_id),
  );
  const cytobankBlocked = format === "cytobank" && nestedOrPopulations.length > 0;
  // A population excluding a gate a population above it includes: empty, and left out by name.
  const contradictions = format === "cytobank" && CYTOBANK_OMITS_CONTRADICTIONS && state.root_population_id
    ? analyzeCytobankContradictions(state.gates, state.populations, state.root_population_id)
    : { populationIds: [], names: [], warnings: [] };

  return (
    <ModalShell title="Export GatingML">
      <label className="gl-modal-field">
        <span>{t("Format")}</span>
        <select value={format} onChange={(e) => setFormat(e.target.value as GatingMLFormat)}>
          <option value="standard">{t("Standard — GateLab / GateLabR interchange")}</option>
          <option value="cytobank">{t("Cytobank-compatible")}</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {format === "standard"
          ? t("Preserves the population hierarchy for GateLab and GateLabR; OR populations are written for other Gating-ML readers and left out when GateLab imports the file.")
          : t("Uses Cytobank channel names and Boolean-gate metadata for Cytobank import.")}
      </div>
      {quadrantOmissions.gateIds.length > 0 && (
        <div className="gl-modal-warning" role="alert">
          This workspace contains {quadrantOmissions.gateIds.length} quadrant gate{quadrantOmissions.gateIds.length === 1 ? "" : "s"}.
          Quadrant gates and {quadrantOmissions.populationIds.length} dependent population{quadrantOmissions.populationIds.length === 1 ? "" : "s"},
          including all descendants, will not be included in this GatingML file.
          The saved .gatelab workspace remains complete.
        </div>
      )}
      {format === "cytobank" && orOmissions.names.length > 0 && (
        <div className="gl-modal-warning" role="alert">
          The Cytobank-compatible format cannot hold a population beneath an OR population, because it ANDs every population with its whole ancestry: {orOmissions.names.join(", ")}, and {orOmissions.populationIds.length} population{orOmissions.populationIds.length === 1 ? "" : "s"} in all, will not be included.
          The standard format writes them for other Gating-ML readers; the .gatelab workspace keeps them.
        </div>
      )}
      {contradictions.names.length > 0 && (
        <div className="gl-modal-warning" role="alert">
          The Cytobank-compatible format cannot hold a population that excludes a gate a population above it includes, or includes one it excludes; such a population holds no events: {contradictions.names.join(", ")}, and {contradictions.populationIds.length} population{contradictions.populationIds.length === 1 ? "" : "s"} in all, will not be included.
          The standard format writes them; the .gatelab workspace keeps them.
        </div>
      )}
      {cytobankBlocked && (
        <div className="gl-modal-warning" role="alert">
          Cytobank-compatible export cannot represent an OR population beneath another population: {nestedOrPopulations.map((p) => p.name).join(", ")}.
          The standard format writes them for other Gating-ML readers, but GateLab leaves OR populations out when it imports Gating-ML; the .gatelab workspace keeps them.
        </div>
      )}
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn" disabled={cytobankBlocked} onClick={() => onExport(format)}>{t("Export")}</button>
      </div>
    </ModalShell>
  );
}

/** FCS export dialog: pick populations, an explicit value space, and sample scope. */
export interface FcsExportSampleOption {
  id: string;
  name: string;
  eventCount: number;
  active: boolean;
  checked: boolean;
  populationEventCounts: Readonly<Record<string, number | null>> | null;
}

export function FcsExportModal({
  state,
  samples,
  combinedCompatibility,
  initialPopIds,
  initialAssay,
  initialScope,
  initialMinimumEvents,
  hierarchy,
  onCancel,
  onExport,
}: {
  state: CoreState;
  samples: readonly FcsExportSampleOption[];
  /** The active hierarchy (1-based position and total); exports read the active one. */
  hierarchy?: { name: string; index: number; count: number };
  combinedCompatibility: { compatible: boolean; reason: string | null };
  initialPopIds: string[];
  initialAssay: FcsExportAssay;
  initialScope: "active" | "combined" | "split";
  initialMinimumEvents: number;
  onCancel: () => void;
  onExport: (
    popIds: string[],
    assay: FcsExportAssay,
    scope: "active" | "combined" | "split",
    minimumEvents: number,
  ) => void;
}) {
  const { t } = useI18n();
  const order = populationTreeOrder(state.populations, state.root_population_id ?? null);
  const allIds = order.map((o) => o.popId);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(initialPopIds));
  const [assay, setAssay] = useState(initialAssay);
  const activeSample = samples.find((sample) => sample.active) ?? samples[0] ?? null;
  const checkedSamples = samples.filter((sample) => sample.checked);
  const [scope, setScope] = useState<"active" | "combined" | "split">(() => {
    if (initialScope === "combined" && !combinedCompatibility.compatible) return "split";
    if (initialScope !== "active" && checkedSamples.length === 0) return "active";
    return initialScope;
  });
  const [minimumEvents, setMinimumEvents] = useState(() =>
    Math.max(0, Math.floor(initialMinimumEvents)),
  );
  const [confirmingSplitExport, setConfirmingSplitExport] = useState(false);
  const toggle = (id: string) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const splitCombinations = useMemo(() => {
    const selectedPopulationIds = [...checked];
    return checkedSamples.flatMap((sample) =>
      selectedPopulationIds.map((popId) => {
        const count = sample.populationEventCounts?.[popId];
        const eventCount =
          typeof count === "number" && Number.isFinite(count) ? count : null;
        return {
          key: `${sample.id}:${popId}`,
          sampleName: sample.name,
          populationName: state.populations[popId]?.name ?? popId,
          eventCount,
          writable: passesPopulationFcsExportThreshold(eventCount, minimumEvents),
        };
      }),
    );
  }, [checked, checkedSamples, minimumEvents, state.populations]);
  const splitCombinationSummary = useMemo(() => {
    const writable = splitCombinations.filter((combination) => combination.writable).length;
    return {
      ready: splitCombinations.every((combination) => combination.eventCount !== null),
      writable,
      skipped: splitCombinations.length - writable,
    };
  }, [splitCombinations]);
  if (confirmingSplitExport) {
    return (
      <ModalShell title="Confirm separate FCS export">
        <div className="gl-fcs-export-confirm-summary">
          <strong>
            {t("FCS outputs to write: {written}", {
              written: splitCombinationSummary.writable,
            })}
          </strong>
          <span>
            {t("{skipped} population × file combinations will be skipped (≤ {threshold} events)", {
              skipped: splitCombinationSummary.skipped,
              threshold: minimumEvents,
            })}
          </span>
        </div>
        <div className="gl-fcs-export-combinations">
          <div className="gl-fcs-export-combination header" aria-hidden="true">
            <span>{t("FCS file")}</span>
            <span>{t("Population")}</span>
            <span>{t("Events")}</span>
            <span>{t("Result")}</span>
          </div>
          {splitCombinations.map((combination) => (
            <div
              key={combination.key}
              className={`gl-fcs-export-combination${combination.writable ? " included" : " skipped"}`}
            >
              <span title={combination.sampleName}>{combination.sampleName}</span>
              <span title={combination.populationName}>{combination.populationName}</span>
              <span>{combination.eventCount?.toLocaleString() ?? "…"}</span>
              <strong>{combination.writable ? t("Write") : t("Skip")}</strong>
            </div>
          ))}
        </div>
        <div className="gl-modal-actions">
          <button className="gl-btn-ghost" onClick={() => setConfirmingSplitExport(false)}>
            {t("Back")}
          </button>
          <button
            className="gl-btn"
            disabled={splitCombinationSummary.writable === 0}
            onClick={() => onExport([...checked], assay, scope, minimumEvents)}
          >
            {t("Export {count} FCS", { count: splitCombinationSummary.writable })}
          </button>
        </div>
      </ModalShell>
    );
  }
  return (
    <ModalShell title="Export FCS">
      {hierarchy && hierarchy.count > 1 && (
        <div className="gl-modal-note">
          {t("The populations listed are the viewed tree's. A file that follows a tailored or group copy of the tree is exported under that copy.")}
        </div>
      )}
      <div className="gl-modal-field">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span>{t("Populations")}</span>
          <button className="gl-btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setChecked(new Set(allIds))}>{t("Select all")}</button>
          <button className="gl-btn-ghost" onClick={() => setChecked(new Set())}>{t("None")}</button>
          <span style={{ opacity: 0.7, minWidth: 66, textAlign: "right" }}>{t("{count} selected", { count: checked.size })}</span>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--gl-border, #ccc)", borderRadius: 4, padding: "4px 6px" }}>
          {allIds.length === 0 && <em style={{ opacity: 0.6 }}>{t("No populations.")}</em>}
          {order.map(({ popId, depth }) => (
            <label key={popId} style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: depth * 14, cursor: "pointer" }}>
              <input type="checkbox" checked={checked.has(popId)} onChange={() => toggle(popId)} />
              {state.populations[popId]?.name ?? popId}
            </label>
          ))}
        </div>
      </div>
      <label className="gl-modal-field">
        <span>{t("Values")}</span>
        <select value={assay} onChange={(e) => setAssay(e.target.value as FcsExportAssay)}>
          <option value="original">{t("Original measurements (uncompensated)")}</option>
          <option value="compensated">{t("Compensated linear measurements")}</option>
          <option value="display">{t("Transformed display values")}</option>
        </select>
      </label>
      <div className="gl-modal-note">
        {assay === "original" && "Exports the measurements stored in the source FCS before spillover compensation or display transforms. This matches GateLabR's counts export."}
        {assay === "compensated" && "Applies each sample's current spillover-compensation setting, but does not apply logicle or arcsinh display transforms."}
        {assay === "display" && "Exports the values currently used for display after compensation (when enabled) and logicle/arcsinh transformation."}
        {" "}The output file is FCS {FCS_EXPORT_VERSION}, and states which of these values it holds.
        {assay === "display"
          ? " Display values are written as 32-bit floating point."
          : " Measurements keep the source file's precision: 64-bit floating point where a channel was stored or decoded in double precision, or holds integers 32-bit floating point cannot represent; 32-bit otherwise."}
      </div>
      <div className="gl-modal-field">
        <span>{t("FCS source and packaging")}</span>
        <div className="gl-fcs-scope-options">
          <label className={`gl-fcs-scope-option${scope === "active" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="active"
              checked={scope === "active"}
              disabled={!activeSample}
              onChange={() => setScope("active")}
            />
            <span>
              <strong>
                {t("Active file only — {name}", { name: activeSample?.name ?? t("none") })}
              </strong>
              <small>{t("The blue row is exported; other checked files are ignored.")}</small>
            </span>
          </label>
          <label className={`gl-fcs-scope-option${scope === "split" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="split"
              checked={scope === "split"}
              disabled={checkedSamples.length === 0}
              onChange={() => setScope("split")}
            />
            <span>
              <strong>
                {t("Checked files, kept separate — {count} FCS", {
                  count: checkedSamples.length,
                })}
                {checkedSamples.length > 1 && <em>{t("Recommended")}</em>}
              </strong>
              <small>{t("Preserves each source filename and sample identity; multiple outputs are placed in one ZIP.")}</small>
            </span>
          </label>
          <label className={`gl-fcs-scope-option${scope === "combined" ? " selected" : ""}`}>
            <input
              type="radio"
              name="fcs-export-scope"
              value="combined"
              checked={scope === "combined"}
              disabled={!combinedCompatibility.compatible}
              onChange={() => setScope("combined")}
            />
            <span>
              <strong>{t("Pool checked files into one FCS — advanced")}</strong>
              <small>
                {combinedCompatibility.compatible
                  ? t("Events are concatenated into one file. Source-file identity is not retained.")
                  : combinedCompatibility.reason}
              </small>
            </span>
          </label>
        </div>
      </div>
      {scope === "split" && (
        <div className="gl-fcs-threshold">
          <label>
            <span>{t("Only write population × file combinations with more than")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={minimumEvents}
              aria-label={t("Minimum events for each population and FCS combination")}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMinimumEvents(Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0);
              }}
            />
            <span>{t("events")}</span>
          </label>
          <small>
            {t("A value of 0 skips empty outputs. This filter only affects separate-file export; pooled data are never filtered this way.")}
          </small>
        </div>
      )}
      <div className="gl-fcs-export-summary" role="status">
        <strong>{t("Export summary")}</strong>
        <span>
          {scope === "active"
            ? t("{populations} populations from {name}", {
                populations: checked.size,
                name: activeSample?.name ?? t("none"),
              })
            : scope === "split"
              ? t("{populations} populations × {files} checked files, kept separate", {
                  populations: checked.size,
                  files: checkedSamples.length,
                })
              : t("{populations} pooled population files from {files} checked files", {
                  populations: checked.size,
                  files: checkedSamples.length,
                })}
        </span>
        {scope === "split" && (
          <span>
            {splitCombinationSummary.ready
              ? t("FCS outputs to write: {written} · skipped: {skipped} (≤ {threshold} events)", {
                  written: splitCombinationSummary.writable,
                  skipped: splitCombinationSummary.skipped,
                  threshold: minimumEvents,
                })
              : t("Calculating population × file event counts…")}
          </span>
        )}
        {scope !== "active" && checkedSamples.length > 0 && (
          <span title={checkedSamples.map((sample) => sample.name).join("\n")}>
            {t("Sources: {names}", {
              names: checkedSamples.map((sample) => sample.name).join(", "),
            })}
          </span>
        )}
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button
          className="gl-btn"
          disabled={
            checked.size === 0 ||
            (scope === "active" && !activeSample) ||
            (scope === "split" && (
              checkedSamples.length === 0 ||
              !splitCombinationSummary.ready
            )) ||
            (scope === "combined" && !combinedCompatibility.compatible)
          }
          onClick={() => {
            if (scope === "split") setConfirmingSplitExport(true);
            else onExport([...checked], assay, scope, minimumEvents);
          }}
        >
          {scope === "split"
            ? t("Review export")
            : `${t("Export")}${checked.size > 1 ? ` (${checked.size})` : ""}`}
        </button>
      </div>
    </ModalShell>
  );
}

/** Atomic, previewed bulk edits of population names and positive AND gate definitions. */
export function BulkRenameModal({
  state,
  onCancel,
  onConfirm,
}: {
  state: CoreState;
  onCancel: () => void;
  onConfirm: (updates: PopulationBulkEditUpdate[]) => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<PopulationBulkEditPreview | null>(null);
  const tableState = useMemo(() => ({
    populations: state.populations,
    gates: state.gates,
    rootPopulationId: state.root_population_id,
  }), [state.populations, state.gates, state.root_population_id]);

  const downloadTemplate = () => {
    setErr(null);
    let csv: string;
    try {
      csv = serializePopulationEditTemplate(tableState);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "population_edit_template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f: File) => {
    try {
      setPreview(parsePopulationEditTable(await f.text(), tableState));
      setErr(null);
    } catch (e) {
      setPreview(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <ModalShell title="Bulk-edit populations">
      <p style={{ fontSize: 12, color: "#555", margin: "2px 0 12px", lineHeight: 1.4 }}>
        {t("Download the template, edit new_population and gate_names, then upload it. Gate names are a comma-separated positive AND list; quadrant references use Gate name [Q1]. Population IDs keep rows unambiguous.")}
      </p>
      {err && <p style={{ fontSize: 12, color: "#d64545" }}>{err}</p>}
      {preview && (
        <div className="gl-modal-note" role="status">
          <strong>{t("Validated — no changes have been applied yet.")}</strong>
          <br />
          {t("{rows} rows · {renames} renames · {definitions} gate definitions changed · {unchanged} unchanged", {
            rows: preview.rowCount,
            renames: preview.renameCount,
            definitions: preview.gateDefinitionCount,
            unchanged: preview.unchangedCount,
          })}
          {preview.omittedCount > 0
            ? ` · ${t("{count} omitted populations will be left unchanged", { count: preview.omittedCount })}`
            : ""}
          {preview.legacyRenameOnly ? ` · ${t("legacy rename-only file")}` : ""}
        </div>
      )}
      <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }} />
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={downloadTemplate}>{t("Template ↧")}</button>
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn-ghost" onClick={() => void pickFilesOrInput(fileRef.current, TABLE_ACCEPT, "Population edit table").then((files) => { if (files?.[0]) void onFile(files[0]); })}>{t("Choose CSV/TSV…")}</button>
        <button
          className="gl-btn"
          disabled={!preview || (preview.renameCount === 0 && preview.gateDefinitionCount === 0)}
          onClick={() => preview && onConfirm(preview.updates)}
        >
          {t("Apply changes")}
        </button>
      </div>
    </ModalShell>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <ModalShell title={t(title)}>
      <p style={{ fontSize: 13, color: "#555", margin: "2px 0 14px", lineHeight: 1.4 }}>{message}</p>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn gl-btn-danger" onClick={onConfirm}>{t(confirmLabel)}</button>
      </div>
    </ModalShell>
  );
}

export interface MetadataGroupsPreview {
  groups: { value: string; count: number; existing: boolean }[];
  /** Files with no value in the column: they stay as they are. */
  unassigned: number;
}

/** One group per value of a metadata column: the column is chosen and what it would make is shown. */
export function GroupsFromMetadataModal({
  columns,
  preview,
  onConfirm,
  onCancel,
}: {
  columns: readonly string[];
  preview: (column: string) => MetadataGroupsPreview;
  onConfirm: (column: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [column, setColumn] = useState(columns[0] ?? "");
  const shown = column ? preview(column) : { groups: [], unassigned: 0 };
  return (
    <ModalShell title={t("Groups from a metadata column")}>
      <label className="gl-modal-field">
        {t("Column:")}
        <select autoFocus value={column} onChange={(e) => setColumn(e.target.value)}>
          {columns.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <div className="gl-modal-preview" aria-label={t("Groups this makes")}>
        {shown.groups.length === 0 ? (
          <p className="gl-hint">{t("No file has a value in this column.")}</p>
        ) : (
          <ul className="gl-modal-preview-list">
            {shown.groups.map((g) => (
              <li key={g.value}>
                <strong>{g.value}</strong> · {t("{count} files", { count: g.count })}
                {g.existing && <small> · {t("into the group of that name")}</small>}
              </li>
            ))}
          </ul>
        )}
        {shown.unassigned > 0 && <p className="gl-hint">{t("{count} files without a value stay as they are.", { count: shown.unassigned })}</p>}
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-btn" disabled={!shown.groups.length} onClick={() => onConfirm(column)}>{t("Make groups")}</button>
      </div>
    </ModalShell>
  );
}

export function RenameModal({
  title,
  initial,
  onConfirm,
  onCancel,
}: {
  title: string;
  initial: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const commit = () => {
    if (name.trim()) onConfirm(name.trim());
  };
  return (
    <ModalShell title={t(title)}>
      <label className="gl-modal-field">
        {t("New name:")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      </label>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Rename")}
        </button>
      </div>
    </ModalShell>
  );
}

export function EditPopModal({
  state,
  popId,
  onConfirm,
  onCancel,
}: {
  state: CoreState;
  popId: string;
  onConfirm: (a: Action) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pop = state.populations[popId];
  const orderedGateIds = state.gate_order.length ? state.gate_order : Object.keys(state.gates);
  const gateIds = orderedGateIds.filter((gid) => state.gates[gid]?.gate_type !== "quadrant");
  const lockedQuadrantRefs = (pop?.gate_refs ?? []).filter(
    (ref) => state.gates[ref.gate_id]?.gate_type === "quadrant",
  );

  const [name, setName] = useState(pop?.name ?? "");
  const [parentId, setParentId] = useState(pop?.parent_id ?? state.root_population_id ?? "");
  const [checked, setChecked] = useState<Set<string>>(
    new Set((pop?.gate_refs ?? []).filter((r) => state.gates[r.gate_id]?.gate_type !== "quadrant").map((r) => r.gate_id)),
  );
  // NOT is per gate reference, not per population: gate_logic is one value for the
  // whole population, so a reference is either intersected or complemented.
  const [excluded, setExcluded] = useState<Set<string>>(
    new Set((pop?.gate_refs ?? []).filter((r) => !r.include).map((r) => r.gate_id)),
  );

  // Valid parents: any population that isn't this one or a descendant of it.
  const parentChoices = useMemo(
    () =>
      Object.keys(state.populations)
        .filter((pid) => pid !== popId && !wouldCreateCycle(state.populations, popId, pid))
        .map((pid) => ({ id: pid, name: state.populations[pid].name })),
    [state.populations, popId],
  );

  // Gates inherited from the parent chain (read-only).
  const inherited = useMemo(() => {
    const out: { gateId: string; include: boolean; from: string }[] = [];
    let walk = pop?.parent_id ?? null;
    const seen = new Set<string>();
    while (walk && state.populations[walk] && !seen.has(walk)) {
      seen.add(walk);
      const anc = state.populations[walk];
      for (const ref of anc.gate_refs) out.push({ gateId: ref.gate_id, include: ref.include, from: anc.name });
      walk = anc.parent_id;
    }
    return out;
  }, [pop, state.populations]);

  if (!pop) return null;

  const commit = () => {
    const gateRefs: GateRef[] = [
      ...lockedQuadrantRefs.map((ref) => ({ ...ref })),
      ...[...checked].map((gid) => ({ gate_id: gid, include: !excluded.has(gid) })),
    ];
    onConfirm({ type: "editPopulation", popId, name, parentId, gateRefs });
  };

  return (
    <ModalShell title={t("Edit Population")}>
      <label className="gl-modal-field">
        {t("Name:")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        {t("Parent population:")}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parentChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {inherited.length > 0 && (
        <div className="gl-modal-field" style={{ gap: 4 }}>
          {t("Inherited from parent chain:")}
          <div className="gl-inherited">
            {inherited.map((ir, i) => {
              const g = state.gates[ir.gateId];
              if (!g) return null;
              return (
                <span
                  key={i}
                  className={"gate-ref-badge" + (ir.include ? "" : " exclude")}
                  style={{ background: g.color, opacity: 0.75 }}
                >
                  {gateRefLabel(g.name, ir.include) + " ← " + ir.from}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <div className="gl-modal-field" style={{ gap: 6 }}>
        {t("Gates for this population:")}
        {lockedQuadrantRefs.length > 0 && (
          <div className="gl-inherited">
            {lockedQuadrantRefs.map((ref) => {
              const gate = state.gates[ref.gate_id];
              return (
                <span key={`${ref.gate_id}:${ref.quadrant}`} className="gate-ref-badge" style={{ background: gate.color, opacity: 0.75 }}>
                  {gate.name} · quadrant {ref.quadrant} (locked)
                </span>
              );
            })}
          </div>
        )}
        <div className="gl-gateref-list">
          {gateIds.length === 0 && <em style={{ color: "var(--muted)" }}>{t("No gates yet.")}</em>}
          {gateIds.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <div key={gid} className="gl-gateref-row">
                <label className="gl-gateref-pick">
                  <input
                    type="checkbox"
                    checked={checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setChecked(next);
                      // Dropping a gate drops its exclusion too, so an unrelated
                      // NOT cannot reappear if the gate is ticked again later.
                      if (!e.target.checked && excluded.has(gid)) {
                        const stillExcluded = new Set(excluded);
                        stillExcluded.delete(gid);
                        setExcluded(stillExcluded);
                      }
                    }}
                  />
                  <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                  <span>{g.name}</span>
                </label>
                <label
                  className={"gl-gateref-not" + (checked.has(gid) ? "" : " is-disabled")}
                  title={t(EXCLUDE_HINT)}
                >
                  <input
                    type="checkbox"
                    checked={excluded.has(gid)}
                    disabled={!checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setExcluded(next);
                    }}
                  />
                  {t("NOT")}
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Save")}
        </button>
      </div>
    </ModalShell>
  );
}

export function CreatePopModal({
  state,
  onConfirm,
  onCancel,
}: {
  state: CoreState;
  onConfirm: (a: Action) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const parentChoices = useMemo(
    () => Object.keys(state.populations).map((id) => ({ id, name: state.populations[id].name })),
    [state.populations],
  );
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(
    state.active_population_id && state.populations[state.active_population_id]
      ? state.active_population_id
      : state.root_population_id ?? "",
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const ids = (state.gate_order.length ? state.gate_order : Object.keys(state.gates))
    .filter((gid) => state.gates[gid]?.gate_type !== "quadrant");

  const commit = () => {
    const popName = name.trim() || `Pop_${Object.keys(state.populations).length}`;
    const gateRefs: GateRef[] = [...checked].map((gid) => ({ gate_id: gid, include: !excluded.has(gid) }));
    onConfirm({ type: "addPopulation", name: popName, parentId, gateRefs });
  };

  return (
    <ModalShell title={t("Create Population")}>
      <label className="gl-modal-field">
        {t("Population name:")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="gl-modal-field">
        {t("Parent population:")}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {parentChoices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="gl-modal-field" style={{ gap: 6 }}>
        {t("Gate references (AND logic; tick NOT to exclude):")}
        <div className="gl-gateref-list">
          {ids.length === 0 && <em style={{ color: "var(--muted)" }}>{t("No gates yet.")}</em>}
          {ids.map((gid) => {
            const g = state.gates[gid];
            if (!g) return null;
            return (
              <div key={gid} className="gl-gateref-row">
                <label className="gl-gateref-pick">
                  <input
                    type="checkbox"
                    checked={checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(checked);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setChecked(next);
                      // Dropping a gate drops its exclusion too, so an unrelated
                      // NOT cannot reappear if the gate is ticked again later.
                      if (!e.target.checked && excluded.has(gid)) {
                        const stillExcluded = new Set(excluded);
                        stillExcluded.delete(gid);
                        setExcluded(stillExcluded);
                      }
                    }}
                  />
                  <span className="gate-color-swatch" style={{ background: g.color, width: 10, height: 10 }} />
                  <span>{g.name}</span>
                </label>
                <label
                  className={"gl-gateref-not" + (checked.has(gid) ? "" : " is-disabled")}
                  title={t(EXCLUDE_HINT)}
                >
                  <input
                    type="checkbox"
                    checked={excluded.has(gid)}
                    disabled={!checked.has(gid)}
                    onChange={(e) => {
                      const next = new Set(excluded);
                      if (e.target.checked) next.add(gid);
                      else next.delete(gid);
                      setExcluded(next);
                    }}
                  />
                  {t("NOT")}
                </label>
              </div>
            );
          })}
        </div>
      </div>
      <div className="gl-modal-actions">
        <button className="gl-btn-ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button className="gl-btn" onClick={commit}>
          {t("Create")}
        </button>
      </div>
    </ModalShell>
  );
}
