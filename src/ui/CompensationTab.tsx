import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  reportMatrixCompatibility,
  type MatrixCompatibilityReport,
} from "../engine/compensationCompatibility";
import {
  parseCompensationMatrixTable,
  type ParsedCompensationMatrixTable,
} from "../engine/compensationMatrixImport";
import {
  validateAndCanonicalizeCompensationMatrix,
  type CanonicalCompensationMatrix,
  type MatrixValidationIssue,
} from "../engine/compensationProfile";
import {
  createCompensationBaselineProfile,
  type CompensationProfileRecord,
} from "../engine/compensationProfileRecord";
import {
  CYTOF_NNLS_SOLVER_VERSION,
  DEFAULT_CYTOF_NNLS_SETTINGS,
} from "../engine/cytofCompensationEngine";
import type { CompensationApplyProgress } from "../engine/compensationManager";
import type { Sample } from "../engine/sample";
import { usePersistedTabState } from "./tabState";

interface Props {
  sample: Sample;
  compensationOn: boolean;
  onToggleCompensation: (enabled: boolean) => boolean | void;
  onApplyProfile?: (
    profile: CompensationProfileRecord,
    onProgress?: (progress: CompensationApplyProgress) => void,
  ) => Promise<void>;
  onCancelApply?: () => void;
  hasExistingGates?: boolean;
  applyStatus?: CompensationApplyUiStatus | null;
  visible?: boolean;
  stateKey: string;
}

export interface CompensationApplyUiStatus {
  readonly phase: "preparing" | "applying" | "cancelling";
  readonly profileName: string;
  readonly fraction: number;
  readonly processedEvents: number;
  readonly totalEvents: number;
}

interface CytofMatrixDraft {
  readonly fileName: string;
  readonly parsed: ParsedCompensationMatrixTable;
  readonly matrix: CanonicalCompensationMatrix;
  readonly validationWarnings: readonly MatrixValidationIssue[];
}

type DrawerId = "evidence" | "review";

const DRAWERS: ReadonlyArray<Readonly<{ id: DrawerId; label: string }>> = [
  { id: "evidence", label: "Evidence" },
  { id: "review", label: "Review queue" },
];

const PAIR_SEPARATOR = "\u001f";

function significantNumber(value: number, significantDigits: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0) || value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || absolute < 1e-8) return value.toExponential(Math.max(1, significantDigits - 1));
  const decimalPlaces = Math.min(
    10,
    Math.max(0, significantDigits - Math.floor(Math.log10(absolute)) - 1),
  );
  return value.toFixed(decimalPlaces).replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

function percentText(value: number, zeroAsDot = false, significantDigits = 6): string {
  if (zeroAsDot && value === 0) return "·";
  const percent = value * 100;
  return `${significantNumber(percent, significantDigits)}%`;
}

function channelDisplay(sample: Sample, key: string): Readonly<{
  key: string;
  pnn: string;
  label: string;
  combined: string;
}> {
  const index = sample.index(key);
  const pnn = index === undefined ? key : sample.channels[index].pnn;
  const label = sample.labelForKey(key);
  return {
    key,
    pnn,
    label,
    combined: label === pnn ? pnn : `${label} (${pnn})`,
  };
}

function channelDisplayForPnn(sample: Sample, pnn: string): ReturnType<typeof channelDisplay> {
  const channel = sample.channels.find((candidate) => candidate.pnn === pnn);
  return channelDisplay(sample, channel?.key ?? pnn);
}

function methodLabel(kind: "flow-spillover" | "cytof-spillover", method: "matrix-inverse" | "nnls"): string {
  if (kind === "cytof-spillover" && method === "nnls") return "CyTOF NNLS";
  return "Flow linear inverse";
}

function reasonLabel(reason: string): string {
  return reason.replaceAll("-", " ");
}

function axisLabel(channel: ReturnType<typeof channelDisplay>) {
  return (
    <>
      <span className="gl-comp-axis-label">{channel.label}</span>
      {channel.pnn !== channel.label && <small className="gl-comp-axis-pnn">{channel.pnn}</small>}
    </>
  );
}

export function CompensationTab({
  sample,
  compensationOn,
  onToggleCompensation,
  onApplyProfile,
  onCancelApply,
  hasExistingGates = false,
  applyStatus = null,
  visible = true,
  stateKey,
}: Props) {
  const installedStatus = sample.compensatedLayerStatus();
  const installedMetadata = installedStatus.state === "missing" ? null : installedStatus.metadata;
  const profileMetadata = installedMetadata?.runtimeIdentity === "profile" ? installedMetadata : null;
  // A profile-derived result and the embedded FCS matrix are different scientific sources. Never
  // present the embedded matrix as the active profile's coefficients.
  const spill = !profileMetadata && sample.instrument === "flow" ? sample.spillover : null;
  const [selectedPairKey, setSelectedPairKey] = usePersistedTabState<string | null>(
    `compensation.${stateKey}.selectedPair`,
    null,
  );
  const [openDrawers, setOpenDrawers] = usePersistedTabState<Record<DrawerId, boolean>>(
    `compensation.${stateKey}.openDrawers`,
    { evidence: false, review: false },
  );
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionIsError, setActionIsError] = useState(false);
  const [cytofDraft, setCytofDraft] = useState<CytofMatrixDraft | null>(null);
  const [includedCytofChannels, setIncludedCytofChannels] = useState<Set<string>>(
    () => new Set(),
  );
  const [cytofImportError, setCytofImportError] = useState<string | null>(null);
  const [gateRecomputeAcknowledged, setGateRecomputeAcknowledged] = useState(false);
  const [applyProgress, setApplyProgress] = useState<CompensationApplyProgress | null>(null);
  const [applyingProfile, setApplyingProfile] = useState(false);
  const applySubmissionRef = useRef(false);
  const cytofFileRef = useRef<HTMLInputElement>(null);
  const matrixRef = useRef<HTMLTableElement>(null);
  const applyBusy = applyingProfile || applyStatus !== null;
  const visibleApplyProgress: CompensationApplyUiStatus | null = applyStatus ??
    (applyProgress
      ? {
          phase: "applying",
          profileName: cytofDraft?.fileName ?? "CyTOF compensation",
          fraction: applyProgress.fraction,
          processedEvents: applyProgress.processedEvents,
          totalEvents: applyProgress.totalEvents,
        }
      : null);

  const samplePnnChannels = useMemo(
    () => sample.channels.map(({ pnn, columnIndex }) => ({ pnn, columnIndex })),
    [sample],
  );
  const cytofCompatibility = useMemo<MatrixCompatibilityReport | null>(() => {
    if (!cytofDraft) return null;
    return reportMatrixCompatibility({
      kind: "cytof-spillover",
      matrix: cytofDraft.matrix,
      sampleChannels: samplePnnChannels,
      includedChannels: Array.from(includedCytofChannels),
    });
  }, [cytofDraft, includedCytofChannels, samplePnnChannels]);

  const channels = useMemo(
    () => spill?.channels.map((key) => channelDisplay(sample, key)) ?? [],
    [sample, spill],
  );
  const selectedPair = useMemo(() => {
    if (!spill || !selectedPairKey) return null;
    const [sourceKey, receiverKey] = selectedPairKey.split(PAIR_SEPARATOR);
    const sourceIndex = spill.channels.indexOf(sourceKey);
    const receiverIndex = spill.channels.indexOf(receiverKey);
    if (sourceIndex < 0 || receiverIndex < 0 || sourceIndex === receiverIndex) return null;
    return {
      sourceIndex,
      receiverIndex,
      source: channels[sourceIndex],
      receiver: channels[receiverIndex],
      value: spill.matrix[sourceIndex][receiverIndex],
    };
  }, [channels, selectedPairKey, spill]);
  const unusualCoefficients = useMemo(() => {
    if (!spill) return [];
    const found: string[] = [];
    for (let source = 0; source < spill.matrix.length; source++) {
      for (let receiver = 0; receiver < spill.matrix[source].length; receiver++) {
        const value = spill.matrix[source][receiver];
        if (source === receiver || !Number.isFinite(value) || value <= 1) continue;
        found.push(`${channels[source].combined} → ${channels[receiver].combined}`);
      }
    }
    return found;
  }, [channels, spill]);
  const matrixReviewItems = useMemo(() => {
    if (!spill) return [];
    const found: string[] = [];
    for (let source = 0; source < spill.matrix.length; source++) {
      for (let receiver = 0; receiver < spill.matrix[source].length; receiver++) {
        const value = spill.matrix[source][receiver];
        const pair = `${channels[source].combined} → ${channels[receiver].combined}`;
        if (!Number.isFinite(value)) {
          found.push(`${pair}: non-finite coefficient (${String(value)})`);
        } else if (source === receiver && Math.abs(value - 1) > 1e-8) {
          found.push(`${channels[source].combined}: diagonal is ${percentText(value)}, not 100%`);
        } else if (source !== receiver && value < 0) {
          found.push(`${pair}: negative coefficient (${percentText(value)})`);
        } else if (source !== receiver && value > 1) {
          found.push(`${pair}: coefficient above 100%`);
        }
      }
    }
    return found;
  }, [channels, spill]);
  const matrixHasNonFinite = useMemo(
    () => spill?.matrix.some((row) => row.some((value) => !Number.isFinite(value))) ?? false,
    [spill],
  );
  const profileChannels = useMemo(
    () => profileMetadata?.includedPnns.map((pnn) => channelDisplayForPnn(sample, pnn)) ?? [],
    [profileMetadata, sample],
  );
  const reviewItems = useMemo(() => {
    const items = [...matrixReviewItems];
    if (installedStatus.state === "stale") {
      items.push(...installedStatus.reasons.map((reason) => `Profile unavailable: ${reasonLabel(reason)}`));
    }
    return items;
  }, [installedStatus, matrixReviewItems]);

  const source = profileMetadata
    ? "Installed compensation profile"
    : spill
      ? "Embedded FCS matrix"
      : "No compatible matrix";
  const method = profileMetadata
    ? methodLabel(profileMetadata.kind, profileMetadata.method)
    : spill
      ? "Flow linear inverse"
      : "Not configured";
  const channelCount = profileMetadata?.includedPnns.length ?? spill?.channels.length ?? 0;
  const canToggle = (spill !== null && !matrixHasNonFinite) ||
    (profileMetadata !== null && installedStatus.state === "ready");

  const toggleDrawer = (id: DrawerId) => {
    setOpenDrawers((current) => ({ ...current, [id]: !current[id] }));
  };

  const handleLayerToggle = () => {
    setActionMessage(null);
    setActionIsError(false);
    try {
      const result = onToggleCompensation(!compensationOn);
      if (result === false) {
        setActionIsError(true);
        setActionMessage("Compensation could not be applied. The current assay layer was left unchanged.");
      }
    } catch {
      setActionIsError(true);
      setActionMessage("Compensation could not be applied. The current assay layer was left unchanged.");
    }
  };

  const handleCytofMatrixFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setCytofImportError(null);
    setActionMessage(null);
    setActionIsError(false);
    setApplyProgress(null);
    setGateRecomputeAcknowledged(false);
    try {
      const parsed = parseCompensationMatrixTable(await file.text());
      const validated = validateAndCanonicalizeCompensationMatrix(
        parsed.input,
        "cytof-spillover",
      );
      if (!validated.ok) {
        throw new Error(validated.errors.map(({ message }) => message).join(" "));
      }
      const sampleCounts = new Map<string, number>();
      for (const { pnn } of samplePnnChannels) {
        const exactPnn = pnn.trim().normalize("NFC");
        sampleCounts.set(exactPnn, (sampleCounts.get(exactPnn) ?? 0) + 1);
      }
      const matched = validated.value.receiverChannels.filter(
        (pnn) => sampleCounts.get(pnn) === 1,
      );
      setCytofDraft({
        fileName: file.name,
        parsed,
        matrix: validated.value,
        validationWarnings: validated.warnings,
      });
      setIncludedCytofChannels(new Set(matched));
    } catch (cause) {
      setCytofDraft(null);
      setIncludedCytofChannels(new Set());
      setCytofImportError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const setCytofChannelIncluded = (pnn: string, included: boolean) => {
    setIncludedCytofChannels((current) => {
      const next = new Set(current);
      if (included) next.add(pnn);
      else next.delete(pnn);
      return next;
    });
  };

  const applyCytofProfile = async () => {
    if (
      applySubmissionRef.current ||
      applyBusy ||
      !cytofDraft ||
      !cytofCompatibility?.canApply ||
      !onApplyProfile
    ) return;
    if (hasExistingGates && !gateRecomputeAcknowledged) {
      setCytofImportError(
        "Confirm that existing gate memberships will be recomputed in compensated coordinates before applying.",
      );
      return;
    }
    setCytofImportError(null);
    setActionMessage(null);
    setApplyProgress(null);
    applySubmissionRef.current = true;
    setApplyingProfile(true);
    try {
      const suffix = globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const displayName = cytofDraft.fileName.replace(/\.(?:csv|tsv|txt)$/i, "") ||
        "CyTOF compensation";
      const profile = await createCompensationBaselineProfile(
        {
          kind: "cytof-spillover",
          method: "nnls",
          solverVersion: CYTOF_NNLS_SOLVER_VERSION,
          solverSettings: DEFAULT_CYTOF_NNLS_SETTINGS,
          matrix: cytofDraft.matrix,
          includedChannels: Array.from(includedCytofChannels),
        },
        {
          profileId: `cytof-${suffix}`,
          name: displayName,
          createdAt: new Date(),
          origin: {
            type: "uploaded",
            fileName: cytofDraft.fileName,
            format: cytofDraft.parsed.format.delimiter,
            sourceColumnHeader: cytofDraft.parsed.format.sourceColumnHeader,
          },
          provenance: {
            sourceDescription: "User-uploaded CyTOF spillover matrix",
            estimationMethod: "Imported; coefficients preserved exactly",
          },
        },
      );
      await onApplyProfile(profile, setApplyProgress);
      setActionMessage(
        `Applied ${displayName} to ${includedCytofChannels.size} channel${includedCytofChannels.size === 1 ? "" : "s"}. Original measurements remain available.`,
      );
      setCytofDraft(null);
      setIncludedCytofChannels(new Set());
      setGateRecomputeAcknowledged(false);
      setApplyProgress(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/cancel/i.test(message)) setActionMessage("CyTOF compensation was cancelled; the previous assay was left unchanged.");
      else setCytofImportError(message);
    } finally {
      applySubmissionRef.current = false;
      setApplyingProfile(false);
    }
  };

  const selectAndFocus = (sourceIndex: number, receiverIndex: number) => {
    const sourceChannel = channels[sourceIndex];
    const receiverChannel = channels[receiverIndex];
    if (!sourceChannel || !receiverChannel || sourceIndex === receiverIndex) return;
    setSelectedPairKey(`${sourceChannel.key}${PAIR_SEPARATOR}${receiverChannel.key}`);
    matrixRef.current
      ?.querySelector<HTMLButtonElement>(
        `button[data-source-index="${sourceIndex}"][data-receiver-index="${receiverIndex}"]`,
      )
      ?.focus();
  };

  const handleMatrixKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sourceIndex: number,
    receiverIndex: number,
  ) => {
    const count = channels.length;
    let nextSource = sourceIndex;
    let nextReceiver = receiverIndex;
    const step = (start: number, delta: -1 | 1, unavailable: number) => {
      let candidate = start + delta;
      while (candidate >= 0 && candidate < count) {
        if (candidate !== unavailable) return candidate;
        candidate += delta;
      }
      return start;
    };

    switch (event.key) {
      case "ArrowLeft":
        nextReceiver = step(receiverIndex, -1, sourceIndex);
        break;
      case "ArrowRight":
        nextReceiver = step(receiverIndex, 1, sourceIndex);
        break;
      case "ArrowUp":
        nextSource = step(sourceIndex, -1, receiverIndex);
        break;
      case "ArrowDown":
        nextSource = step(sourceIndex, 1, receiverIndex);
        break;
      case "Home":
        nextReceiver = sourceIndex === 0 ? 1 : 0;
        break;
      case "End":
        nextReceiver = sourceIndex === count - 1 ? count - 2 : count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectAndFocus(nextSource, nextReceiver);
  };

  return (
    <div
      className="gl-tab-panel gl-tab-fill gl-compensation-tab"
      style={visible ? undefined : { display: "none" }}
      aria-hidden={visible ? undefined : true}
    >
      <div className="gl-comp-overview">
        <div className="gl-comp-overview-title">
          <h2 className="gl-tab-title">Compensation</h2>
          <span className="gl-comp-method">{method}</span>
        </div>
        <dl className="gl-comp-summary" aria-label="Compensation summary">
          <div><dt>Source</dt><dd>{source}</dd></div>
          <div><dt>Layer</dt><dd>{compensationOn ? "Compensated" : "Original measurements"}</dd></div>
          <div><dt>Channels</dt><dd>{channelCount}</dd></div>
        </dl>
        {canToggle && (
          <button
            type="button"
            className={compensationOn ? "gl-btn-ghost" : "gl-btn"}
            onClick={handleLayerToggle}
          >
            {compensationOn
              ? "Use original measurements"
              : profileMetadata
                ? "Use compensated NNLS"
                : "Apply embedded matrix"}
          </button>
        )}
      </div>

      {actionMessage && (
        <div className={actionIsError ? "gl-comp-error" : "gl-comp-status"} role={actionIsError ? "alert" : "status"}>
          {actionMessage}
        </div>
      )}

      {sample.instrument === "cytof" && (
        <section className="gl-comp-cytof-import" aria-labelledby="comp-cytof-import-heading">
          <div className="gl-comp-panel-head gl-comp-import-head">
            <div>
              <h3 id="comp-cytof-import-heading">CyTOF spillover matrix</h3>
              <span>Linear counts → non-negative least squares → arcsinh display</span>
            </div>
            <div className="gl-comp-import-actions">
              <input
                ref={cytofFileRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                className="gl-sr-only"
                aria-label="Choose CyTOF spillover matrix"
                onChange={(event) => void handleCytofMatrixFile(event)}
              />
              <button
                type="button"
                className={cytofDraft ? "gl-btn-ghost" : "gl-btn"}
                disabled={applyBusy}
                onClick={() => cytofFileRef.current?.click()}
              >
                {cytofDraft ? "Choose another matrix…" : "Import matrix…"}
              </button>
            </div>
          </div>

          {cytofImportError && <div className="gl-comp-error" role="alert">{cytofImportError}</div>}

          {cytofDraft && cytofCompatibility && (
            <div className="gl-comp-import-body">
              <div className="gl-comp-import-summary">
                <div>
                  <strong>{cytofDraft.fileName}</strong>
                  <span>
                    {cytofDraft.matrix.sourceChannels.length} sources × {cytofDraft.matrix.receiverChannels.length} receivers
                  </span>
                </div>
                <dl>
                  <div><dt>Exact matches</dt><dd>{cytofCompatibility.matchedChannels.length}</dd></div>
                  <div><dt>Included</dt><dd>{cytofCompatibility.includedChannels.length}</dd></div>
                  <div><dt>Not in FCS</dt><dd>{cytofCompatibility.matrixOnlyChannels.length}</dd></div>
                </dl>
              </div>

              <div className="gl-comp-channel-head">
                <div>
                  <h4>Channels included in NNLS</h4>
                  <span>Exact, case-sensitive <code>$PnN</code> matching; unchecked channels pass through unchanged.</span>
                </div>
                <div>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy}
                    onClick={() => setIncludedCytofChannels(new Set(cytofCompatibility.matchedChannels))}
                  >
                    All matched
                  </button>
                  <button
                    type="button"
                    className="gl-mini-btn"
                    disabled={applyBusy}
                    onClick={() => setIncludedCytofChannels(new Set())}
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="gl-comp-channel-grid">
                {cytofDraft.matrix.receiverChannels.map((pnn) => {
                  const matched = cytofCompatibility.matchedChannels.includes(pnn);
                  return (
                    <label key={pnn} className={matched ? "" : "is-unavailable"} title={matched ? pnn : `${pnn} is not uniquely present in this FCS file`}>
                      <input
                        type="checkbox"
                        checked={includedCytofChannels.has(pnn)}
                        disabled={!matched || applyBusy}
                        onChange={(event) => setCytofChannelIncluded(pnn, event.currentTarget.checked)}
                      />
                      <span>{channelDisplayForPnn(sample, pnn).combined}</span>
                      {!matched && <small>not matched</small>}
                    </label>
                  );
                })}
              </div>

              {(cytofDraft.validationWarnings.length > 0 || cytofCompatibility.warnings.length > 0) && (
                <div className="gl-comp-warning" role="status">
                  <span>
                    {cytofDraft.validationWarnings.length + cytofCompatibility.warnings.length} review item{
                      cytofDraft.validationWarnings.length + cytofCompatibility.warnings.length === 1 ? "" : "s"
                    }: {[
                      ...cytofDraft.validationWarnings.map(({ message }) => message),
                      ...cytofCompatibility.warnings.map(({ message }) => message),
                    ].join(" ")}
                  </span>
                </div>
              )}

              {cytofCompatibility.blockers.length > 0 && (
                <div className="gl-comp-error" role="alert">
                  {cytofCompatibility.blockers.map(({ message }) => message).join(" ")}
                </div>
              )}

              {hasExistingGates && (
                <label className="gl-comp-gate-acknowledgement">
                  <input
                    type="checkbox"
                    checked={gateRecomputeAcknowledged}
                    disabled={applyBusy}
                    onChange={(event) => setGateRecomputeAcknowledged(event.currentTarget.checked)}
                  />
                  <span>
                    I understand that existing gates are retained, but their memberships will be recomputed using the compensated coordinates.
                  </span>
                </label>
              )}

              <div className="gl-comp-apply-row">
                <div>
                  {applyBusy
                    ? visibleApplyProgress
                      ? `${visibleApplyProgress.phase === "cancelling" ? "Cancelling" : visibleApplyProgress.phase === "preparing" ? "Preparing" : "Applying"}… ${Math.round(visibleApplyProgress.fraction * 100)}% (${visibleApplyProgress.processedEvents.toLocaleString()} / ${visibleApplyProgress.totalEvents.toLocaleString()} events)`
                      : "Preparing compensation…"
                    : "The Original assay is retained and can be restored at any time."}
                </div>
                {applyBusy ? (
                  <button
                    type="button"
                    className="gl-btn-ghost"
                    disabled={visibleApplyProgress?.phase === "cancelling"}
                    onClick={onCancelApply}
                  >
                    {visibleApplyProgress?.phase === "cancelling" ? "Cancelling…" : "Cancel"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="gl-btn"
                    disabled={
                      !onApplyProfile ||
                      !cytofCompatibility.canApply ||
                      (hasExistingGates && !gateRecomputeAcknowledged)
                    }
                    onClick={() => void applyCytofProfile()}
                  >
                    Apply NNLS compensation
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {matrixHasNonFinite && (
        <div className="gl-comp-error" role="alert">
          The embedded compensation matrix contains non-finite values and cannot be applied.
        </div>
      )}

      {unusualCoefficients.length > 0 && (
        <div className="gl-comp-warning" role="status">
          <span>
            {unusualCoefficients.length} off-diagonal coefficient{unusualCoefficients.length === 1 ? " is" : "s are"} above 100%.
            Review the matrix source before applying it.
          </span>
          <button type="button" className="gl-mini-btn" onClick={() => setOpenDrawers((current) => ({ ...current, review: true }))}>
            Review details
          </button>
        </div>
      )}

      {spill ? (
        <div className="gl-comp-common-path">
          <section className="gl-comp-matrix-panel" aria-labelledby="comp-matrix-heading">
            <div className="gl-comp-panel-head">
              <div>
                <h3 id="comp-matrix-heading">Embedded compensation matrix</h3>
                <span>Source rows ↓ · Receiver columns → · values are spillover percentages</span>
              </div>
            </div>
            <div className="gl-comp-matrix-scroll">
              <table
                ref={matrixRef}
                className="gl-comp-table gl-comp-matrix"
                aria-label="Embedded compensation matrix; source rows and receiver columns"
              >
                <thead>
                  <tr>
                    <th scope="col" className="gl-comp-orientation">
                      <span>Source ↓</span>
                      <span>Receiver →</span>
                    </th>
                    {channels.map((channel, receiverIndex) => (
                      <th
                        scope="col"
                        key={channel.key}
                        title={channel.combined}
                        className={selectedPair?.receiverIndex === receiverIndex ? "is-selected-axis" : undefined}
                      >
                        {axisLabel(channel)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {spill.matrix.map((row, sourceIndex) => (
                    <tr key={channels[sourceIndex].key}>
                      <th
                        scope="row"
                        title={channels[sourceIndex].combined}
                        className={selectedPair?.sourceIndex === sourceIndex ? "is-selected-axis" : undefined}
                      >
                        {axisLabel(channels[sourceIndex])}
                      </th>
                      {row.map((value, receiverIndex) => {
                        const diagonal = sourceIndex === receiverIndex;
                        const selected = selectedPair?.sourceIndex === sourceIndex && selectedPair.receiverIndex === receiverIndex;
                        const sourceChannel = channels[sourceIndex];
                        const receiverChannel = channels[receiverIndex];
                        const alpha = !diagonal && value > 0 ? Math.min(0.5, value * 3) : 0;
                        const defaultTabStop = selectedPair === null && sourceIndex === 0 && receiverIndex === 1;
                        const cross = selectedPair?.sourceIndex === sourceIndex || selectedPair?.receiverIndex === receiverIndex;
                        return (
                          <td
                            key={receiverChannel.key}
                            className={`${diagonal ? "diag" : value !== 0 ? "spill" : ""}${cross ? " is-selected-cross" : ""}`}
                          >
                            <button
                              type="button"
                              className={`gl-comp-cell${selected ? " selected" : ""}`}
                              disabled={diagonal}
                              tabIndex={diagonal ? -1 : selected || defaultTabStop ? 0 : -1}
                              data-source-index={sourceIndex}
                              data-receiver-index={receiverIndex}
                              aria-pressed={diagonal ? undefined : selected}
                                aria-label={
                                  diagonal
                                  ? `${sourceChannel.combined} diagonal: ${percentText(value)}`
                                  : `${sourceChannel.combined} source to ${receiverChannel.combined} receiver: ${percentText(value)}`
                              }
                              style={alpha > 0 ? { backgroundColor: `rgba(47,128,237,${alpha})` } : undefined}
                              onFocus={() => {
                                if (!diagonal) setSelectedPairKey(`${sourceChannel.key}${PAIR_SEPARATOR}${receiverChannel.key}`);
                              }}
                              onClick={() => setSelectedPairKey(`${sourceChannel.key}${PAIR_SEPARATOR}${receiverChannel.key}`)}
                              onKeyDown={(event) => handleMatrixKeyDown(event, sourceIndex, receiverIndex)}
                            >
                              {diagonal ? percentText(value) : percentText(value, true)}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="gl-comp-inspector" aria-labelledby="comp-selected-heading">
            <div className="gl-comp-panel-head">
              <div>
                <h3 id="comp-selected-heading">Selected coefficient</h3>
                <span>Click a cell, or use the arrow keys, to inspect it.</span>
              </div>
            </div>
            {selectedPair ? (
              <div className="gl-comp-pair-detail">
                <div className="gl-comp-pair-route">
                  <div><span>Source</span><strong>{selectedPair.source.label}</strong><small>{selectedPair.source.pnn}</small></div>
                  <span aria-hidden="true">→</span>
                  <div><span>Receiver</span><strong>{selectedPair.receiver.label}</strong><small>{selectedPair.receiver.pnn}</small></div>
                </div>
                <div className="gl-comp-coefficient-readout">
                  <span>Matrix coefficient</span>
                  <strong>{percentText(selectedPair.value, false, 10)}</strong>
                </div>
                <p className="gl-hint">
                  Applying the embedded matrix leaves its coefficients unchanged. Select another off-diagonal cell to inspect its stored value.
                </p>
              </div>
            ) : (
              <div className="gl-comp-inspector-empty">No coefficient selected.</div>
            )}
          </section>
        </div>
      ) : profileMetadata ? (
        <div className="gl-comp-profile-path">
          <section className="gl-comp-profile-panel" aria-labelledby="comp-profile-heading">
            <div className="gl-comp-panel-head">
              <div>
                <h3 id="comp-profile-heading">{profileMetadata.kind === "cytof-spillover" ? "CyTOF" : "Flow"} compensation profile</h3>
                <span>Exact channel identities bound to this sample</span>
              </div>
            </div>
            <dl className="gl-comp-profile-summary">
              <div><dt>Profile</dt><dd>{profileMetadata.profileId}</dd></div>
              <div><dt>Method</dt><dd>{method}</dd></div>
              <div><dt>Status</dt><dd>{installedStatus.state === "ready" ? "Ready" : "Unavailable"}</dd></div>
            </dl>
            <div className="gl-comp-profile-channels" aria-label="Profile channel bindings">
              {profileChannels.map((channel) => (
                <span key={channel.pnn} title={channel.combined}>
                  <strong>{channel.label}</strong>
                  {channel.pnn !== channel.label && <small>{channel.pnn}</small>}
                </span>
              ))}
            </div>
            {installedStatus.state === "stale" && (
              <div className="gl-comp-warning" role="status">
                This profile cannot be applied to the current sample context. Open the review queue for exact reasons.
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="gl-tab-placeholder gl-comp-empty">
          <p>
            {sample.instrument === "cytof"
              ? "No CyTOF compensation profile is installed for this sample."
              : "This sample has no compatible embedded compensation matrix or imported profile."}
          </p>
        </div>
      )}

      {(spill || profileMetadata) && (
        <div className="gl-comp-advanced" role="group" aria-label="Advanced compensation tools">
          <div className="gl-comp-drawer-buttons">
            {DRAWERS.map(({ id, label }) => (
              <button
                type="button"
                key={id}
                id={`comp-drawer-${id}-button`}
                className="gl-comp-drawer-toggle"
                aria-expanded={openDrawers[id]}
                aria-controls={`comp-drawer-${id}`}
                onClick={() => toggleDrawer(id)}
              >
                <span>{label}{id === "review" && reviewItems.length > 0 ? ` (${reviewItems.length})` : ""}</span>
                <span aria-hidden="true">{openDrawers[id] ? "▾" : "▸"}</span>
              </button>
            ))}
          </div>
          {openDrawers.evidence && (
            <section id="comp-drawer-evidence" role="region" aria-labelledby="comp-drawer-evidence-button" className="gl-comp-drawer-region">
              <h3>Matrix evidence</h3>
              {profileMetadata ? (
                <p>{profileMetadata.profileId} · {method} · {profileMetadata.includedPnns.length} exact <code>$PnN</code> channel bindings · {installedStatus.state}.</p>
              ) : (
                <p>Embedded <code>$SPILLOVER</code> · {spill!.channels.length} matched channels · {matrixReviewItems.length || "no"} coefficient warning{matrixReviewItems.length === 1 ? "" : "s"}.</p>
              )}
            </section>
          )}
          {openDrawers.review && (
            <section id="comp-drawer-review" role="region" aria-labelledby="comp-drawer-review-button" className="gl-comp-drawer-region">
              <h3>Review queue</h3>
              {reviewItems.length > 0 ? (
                <ul>{reviewItems.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : (
                <p>No matrix-level items currently require review.</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
