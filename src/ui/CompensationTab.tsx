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
  adaptCytofSpilloverMatrix,
  CYTOF_NNLS_SOLVER_VERSION,
  DEFAULT_CYTOF_NNLS_SETTINGS,
} from "../engine/cytofCompensationEngine";
import type { CompensationApplyProgress } from "../engine/compensationManager";
import type { Sample } from "../engine/sample";
import { usePersistedTabState } from "./tabState";

interface Props {
  sample: Sample;
  compensationOn: boolean;
  onApplyProfile?: (
    profile: CompensationProfileRecord,
    onProgress?: (progress: CompensationApplyProgress) => void,
  ) => Promise<void>;
  onCancelApply?: () => void;
  hasExistingGates?: boolean;
  applyStatus?: CompensationApplyUiStatus | null;
  installedProfile?: CompensationProfileRecord | null;
  visible?: boolean;
  stateKey: string;
}

export interface CompensationApplyUiStatus {
  readonly phase: "preparing" | "applying" | "cancelling";
  /** Restore rehydrates a saved derived assay; omitted/"apply" is an interactive Apply. */
  readonly operation?: "apply" | "restore";
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

interface CompensationMatrixView {
  readonly axisKeys: readonly string[];
  readonly channels: readonly ReturnType<typeof channelDisplay>[];
  readonly matrix: readonly (readonly number[])[];
  readonly title: string;
  readonly subtitle: string;
  readonly coefficientNote: string;
}

interface CompensationImpactSummary {
  readonly previewEvents: number;
  readonly comparedValues: number;
  readonly changedValues: number;
  readonly medianAbsoluteDelta: number;
  readonly maxAbsoluteDelta: number;
  readonly zeroedNegativeValues: number;
  readonly mostChangedChannel: string;
  readonly mostChangedChannelMedianDelta: number;
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function summarizeInstalledCompensation(
  sample: Sample,
  includedPnns: readonly string[],
): CompensationImpactSummary | null {
  const status = sample.compensatedLayerStatus();
  if (status.state !== "ready" || includedPnns.length === 0 || sample.fcs.nEvents === 0) return null;
  const indices = includedPnns.flatMap((pnn) => {
    const index = sample.channels.findIndex((channel) => channel.pnn === pnn);
    return index < 0 ? [] : [index];
  });
  if (indices.length === 0) return null;

  const previewEvents = Math.min(2048, sample.fcs.nEvents);
  const allDeltas: number[] = [];
  let changedValues = 0;
  let maxAbsoluteDelta = 0;
  let zeroedNegativeValues = 0;
  let mostChangedChannel = "";
  let mostChangedChannelMedianDelta = -1;

  for (const index of indices) {
    const original = sample.originalColumnData(index);
    const compensated = sample.compensatedColumnData(index);
    const channelDeltas: number[] = [];
    for (let previewIndex = 0; previewIndex < previewEvents; previewIndex++) {
      const event = previewEvents === 1
        ? 0
        : Math.floor(previewIndex * (sample.fcs.nEvents - 1) / (previewEvents - 1));
      const before = original[event];
      const after = compensated[event];
      const delta = Math.abs(after - before);
      channelDeltas.push(delta);
      allDeltas.push(delta);
      if (delta > Math.max(1e-6, Math.abs(before) * 1e-6)) changedValues++;
      if (before < 0 && after === 0) zeroedNegativeValues++;
      maxAbsoluteDelta = Math.max(maxAbsoluteDelta, delta);
    }
    const channelMedian = median(channelDeltas);
    if (channelMedian > mostChangedChannelMedianDelta) {
      mostChangedChannelMedianDelta = channelMedian;
      mostChangedChannel = channelDisplay(sample, sample.channels[index].key).combined;
    }
  }

  return {
    previewEvents,
    comparedValues: allDeltas.length,
    changedValues,
    medianAbsoluteDelta: median(allDeltas),
    maxAbsoluteDelta,
    zeroedNegativeValues,
    mostChangedChannel,
    mostChangedChannelMedianDelta: Math.max(0, mostChangedChannelMedianDelta),
  };
}

function profileOriginText(profile: CompensationProfileRecord): string {
  if (profile.origin.type === "uploaded") return profile.origin.fileName;
  if (profile.origin.type === "embedded-fcs") return `${profile.origin.fileName} · embedded FCS`;
  return `${profile.origin.presetId} · bundled preset ${profile.origin.presetVersion}`;
}

export function CompensationTab({
  sample,
  compensationOn,
  onApplyProfile,
  onCancelApply,
  hasExistingGates = false,
  applyStatus = null,
  installedProfile = null,
  visible = true,
  stateKey,
}: Props) {
  const installedStatus = sample.compensatedLayerStatus();
  const installedMetadata = installedStatus.state === "missing" ? null : installedStatus.metadata;
  const profileMetadata = installedMetadata?.runtimeIdentity === "profile" ? installedMetadata : null;
  const profileRecord = installedProfile?.profileId === profileMetadata?.profileId
    ? installedProfile
    : null;
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

  const matrixView = useMemo<CompensationMatrixView | null>(() => {
    if (spill) {
      return {
        axisKeys: spill.channels,
        channels: spill.channels.map((key) => channelDisplay(sample, key)),
        matrix: spill.matrix,
        title: "Embedded compensation matrix",
        subtitle: "Source rows ↓ · Receiver columns → · values are spillover percentages",
        coefficientNote: "Applying the embedded matrix leaves its coefficients unchanged.",
      };
    }
    if (!profileRecord || !profileMetadata) return null;
    const axisPnns = profileMetadata.includedPnns;
    const matrix = profileRecord.scientific.kind === "cytof-spillover"
      ? adaptCytofSpilloverMatrix(profileRecord.scientific.matrix, axisPnns)
      : axisPnns.map((sourcePnn) => {
          const sourceIndex = profileRecord.scientific.matrix.sourceChannels.indexOf(sourcePnn);
          return profileRecord.scientific.matrix.matrix[sourceIndex];
        });
    if (
      matrix.length !== axisPnns.length ||
      matrix.some((row) => !row || row.length !== axisPnns.length)
    ) return null;
    return {
      axisKeys: axisPnns,
      channels: axisPnns.map((pnn) => channelDisplayForPnn(sample, pnn)),
      matrix,
      title: profileRecord.scientific.kind === "cytof-spillover"
        ? "Applied NNLS solve matrix"
        : "Applied compensation matrix",
      subtitle: profileRecord.scientific.kind === "cytof-spillover"
        ? "Identity-backed source rows ↓ · Receiver columns → · exact matrix used by NNLS"
        : "Source rows ↓ · Receiver columns → · exact installed coefficients",
      coefficientNote: "This is the exact installed solve matrix. Original measurements remain stored separately.",
    };
  }, [profileMetadata, profileRecord, sample, spill]);
  const channels = matrixView?.channels ?? [];
  const selectedPair = useMemo(() => {
    if (!matrixView || !selectedPairKey) return null;
    const [sourceKey, receiverKey] = selectedPairKey.split(PAIR_SEPARATOR);
    const sourceIndex = matrixView.axisKeys.indexOf(sourceKey);
    const receiverIndex = matrixView.axisKeys.indexOf(receiverKey);
    if (sourceIndex < 0 || receiverIndex < 0 || sourceIndex === receiverIndex) return null;
    return {
      sourceIndex,
      receiverIndex,
      source: channels[sourceIndex],
      receiver: channels[receiverIndex],
      value: matrixView.matrix[sourceIndex][receiverIndex],
    };
  }, [channels, matrixView, selectedPairKey]);
  const unusualCoefficients = useMemo(() => {
    if (!matrixView) return [];
    const found: string[] = [];
    for (let source = 0; source < matrixView.matrix.length; source++) {
      for (let receiver = 0; receiver < matrixView.matrix[source].length; receiver++) {
        const value = matrixView.matrix[source][receiver];
        if (source === receiver || !Number.isFinite(value) || value <= 1) continue;
        found.push(`${channels[source].combined} → ${channels[receiver].combined}`);
      }
    }
    return found;
  }, [channels, matrixView]);
  const matrixReviewItems = useMemo(() => {
    if (!matrixView) return [];
    const found: string[] = [];
    for (let source = 0; source < matrixView.matrix.length; source++) {
      for (let receiver = 0; receiver < matrixView.matrix[source].length; receiver++) {
        const value = matrixView.matrix[source][receiver];
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
  }, [channels, matrixView]);
  const matrixHasNonFinite = useMemo(
    () => matrixView?.matrix.some((row) => row.some((value) => !Number.isFinite(value))) ?? false,
    [matrixView],
  );
  const profileChannels = useMemo(
    () => profileMetadata?.includedPnns.map((pnn) => channelDisplayForPnn(sample, pnn)) ?? [],
    [profileMetadata, sample],
  );
  const impactSummary = useMemo(
    () => profileMetadata && installedStatus.state === "ready"
      ? summarizeInstalledCompensation(sample, profileMetadata.includedPnns)
      : null,
    [installedStatus.state, profileMetadata, sample],
  );
  const reviewItems = useMemo(() => {
    const items = [...matrixReviewItems];
    if (installedStatus.state === "stale") {
      items.push(...installedStatus.reasons.map((reason) => `Profile unavailable: ${reasonLabel(reason)}`));
    }
    return items;
  }, [installedStatus, matrixReviewItems]);

  const source = profileMetadata
    ? profileRecord?.name ?? "Installed compensation profile"
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
    setSelectedPairKey(`${matrixView!.axisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView!.axisKeys[receiverIndex]}`);
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
    const count = matrixView?.axisKeys.length ?? 0;
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
        {canToggle && <span className="gl-comp-global-layer-note">Select the assay for every tab in the top bar.</span>}
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

      {profileMetadata && (
        <section className="gl-comp-profile-panel gl-comp-installed-summary" aria-labelledby="comp-profile-heading">
          <div className="gl-comp-panel-head">
            <div>
              <h3 id="comp-profile-heading">
                {profileMetadata.kind === "cytof-spillover" ? "CyTOF" : "Flow"} compensation installed
              </h3>
              <span>Original and Compensated are complete, reversible assay layers</span>
            </div>
          </div>
          <dl className="gl-comp-profile-summary">
            <div><dt>Profile</dt><dd title={profileRecord?.name ?? profileMetadata.profileId}>{profileRecord?.name ?? profileMetadata.profileId}</dd></div>
            <div><dt>Status</dt><dd>{installedStatus.state === "ready" ? "Ready" : "Unavailable"}</dd></div>
            <div><dt>Method</dt><dd>{method}</dd></div>
            <div><dt>Source</dt><dd title={profileRecord ? profileOriginText(profileRecord) : undefined}>{profileRecord ? profileOriginText(profileRecord) : "Stored workspace profile"}</dd></div>
            <div><dt>Imported matrix</dt><dd>{profileRecord ? `${profileRecord.scientific.matrix.sourceChannels.length} × ${profileRecord.scientific.matrix.receiverChannels.length}` : "—"}</dd></div>
            <div><dt>Solve channels</dt><dd>{profileMetadata.includedPnns.length} exact <code>$PnN</code> bindings</dd></div>
          </dl>
          {profileRecord && (
            <div className="gl-comp-method-card" aria-label="Installed compensation method">
              <div>
                <span>Pipeline</span>
                <strong>{profileRecord.scientific.kind === "cytof-spillover" ? "Original counts → NNLS → Compensated counts → arcsinh display" : "Original values → linear matrix inverse → Compensated values → display transform"}</strong>
              </div>
              <div>
                <span>Solver</span>
                <strong>{profileRecord.scientific.solverVersion}</strong>
                <small>{profileRecord.scientific.solverSettings.map(({ key, value }) => `${key}=${String(value)}`).join(" · ")}</small>
              </div>
            </div>
          )}
          {impactSummary && (
            <div className="gl-comp-impact" aria-label="Original versus Compensated preview">
              <div className="gl-comp-impact-head">
                <div>
                  <h4>Original → Compensated impact</h4>
                  <span>Deterministic preview of {impactSummary.previewEvents.toLocaleString()} evenly spaced events across {profileMetadata.includedPnns.length} solve channels</span>
                </div>
              </div>
              <dl>
                <div><dt>Values changed</dt><dd>{impactSummary.changedValues.toLocaleString()} / {impactSummary.comparedValues.toLocaleString()} ({percentText(impactSummary.changedValues / impactSummary.comparedValues, false, 4)})</dd></div>
                <div><dt>Median |Δ|</dt><dd>{significantNumber(impactSummary.medianAbsoluteDelta, 5)}</dd></div>
                <div><dt>Maximum |Δ|</dt><dd>{significantNumber(impactSummary.maxAbsoluteDelta, 5)}</dd></div>
                <div><dt>Largest median shift</dt><dd title={impactSummary.mostChangedChannel}>{impactSummary.mostChangedChannel} · {significantNumber(impactSummary.mostChangedChannelMedianDelta, 5)}</dd></div>
                {profileMetadata.kind === "cytof-spillover" && (
                  <div><dt>Negative → zero</dt><dd>{impactSummary.zeroedNegativeValues.toLocaleString()} preview values</dd></div>
                )}
              </dl>
            </div>
          )}
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
      )}

      {matrixView ? (
        <div className="gl-comp-common-path">
          <section className="gl-comp-matrix-panel" aria-labelledby="comp-matrix-heading">
            <div className="gl-comp-panel-head">
              <div>
                <h3 id="comp-matrix-heading">{matrixView.title}</h3>
                <span>{matrixView.subtitle}</span>
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
                  {matrixView.matrix.map((row, sourceIndex) => (
                    <tr key={matrixView.axisKeys[sourceIndex]}>
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
                                if (!diagonal) setSelectedPairKey(`${matrixView.axisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView.axisKeys[receiverIndex]}`);
                              }}
                              onClick={() => setSelectedPairKey(`${matrixView.axisKeys[sourceIndex]}${PAIR_SEPARATOR}${matrixView.axisKeys[receiverIndex]}`)}
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
                  {matrixView.coefficientNote} Select another off-diagonal cell to inspect its stored value.
                </p>
              </div>
            ) : (
              <div className="gl-comp-inspector-empty">No coefficient selected.</div>
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

      {(matrixView || profileMetadata) && (
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
                profileRecord ? (
                  <dl className="gl-comp-evidence-grid">
                    <div><dt>Profile ID</dt><dd>{profileRecord.profileId}</dd></div>
                    <div><dt>Created</dt><dd>{new Date(profileRecord.createdAt).toLocaleString()}</dd></div>
                    <div><dt>Matrix source</dt><dd>{profileOriginText(profileRecord)}</dd></div>
                    <div><dt>Orientation</dt><dd>Source rows → receiver columns</dd></div>
                    <div><dt>Imported dimensions</dt><dd>{profileRecord.scientific.matrix.sourceChannels.length} sources × {profileRecord.scientific.matrix.receiverChannels.length} receivers</dd></div>
                    <div><dt>Applied solve</dt><dd>{profileMetadata.includedPnns.length} exact <code>$PnN</code> channels · {installedStatus.state}</dd></div>
                    <div><dt>Matrix hash</dt><dd title={profileRecord.matrixHash}>{profileRecord.matrixHash.slice(0, 19)}…</dd></div>
                    <div><dt>Profile hash</dt><dd title={profileRecord.profileHash}>{profileRecord.profileHash.slice(0, 19)}…</dd></div>
                    <div><dt>Provenance</dt><dd>{profileRecord.provenance?.sourceDescription ?? "No additional source note supplied"}</dd></div>
                    <div><dt>Estimation</dt><dd>{profileRecord.provenance?.estimationMethod ?? "Imported coefficients preserved exactly"}</dd></div>
                  </dl>
                ) : (
                  <p>{profileMetadata.profileId} · {method} · {profileMetadata.includedPnns.length} exact <code>$PnN</code> channel bindings · {installedStatus.state}. The numerical profile record is not available in this live workspace state.</p>
                )
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
