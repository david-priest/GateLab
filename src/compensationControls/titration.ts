import { eventIndices, medianSorted, quantileSorted, sortedValues } from "./controlFile";

/** Preserve an unfamiliar version until a compatible review can read it. */
export function titrationRecordFromWorkspace(workspace: unknown): unknown {
  if (!record(workspace) || !record(workspace.display)) return undefined;
  return workspace.display.titrationReview;
}

export interface TitrationTube {
  fileId: string;
  dose: string;
  replicate: string;
  populationId: string | null;
  negativeLower: number | null;
  negativeUpper: number | null;
  positiveLower: number | null;
  positiveUpper: number | null;
  reviewed?: TitrationReviewSnapshot;
}

export interface TitrationSeries {
  id: string;
  clone: string;
  conjugate: string;
  lot: string;
  detector: string;
  unit: string;
  tubes: TitrationTube[];
  chosenDose: string | null;
  note: string;
}

export interface TitrationStatistics {
  negativeCount: number;
  positiveCount: number;
  negativeMedian: number | null;
  positiveMedian: number | null;
  negativeSpread: number | null;
  stainIndex: number | null;
  saturationFraction: number | null;
}

export interface TitrationReviewSnapshot {
  detector: string;
  populationId: string | null;
  assay: "original";
  fileName: string;
  eventCount: number;
  statistics: ReturnType<typeof measureTube>;
}

const DECIMAL = /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** A concentration or dilution as a numeric dose, preserving the user's spelling in the series. */
export function parseDose(text: string): number | null {
  const parts = text.trim().replace(/−/g, "-").split(/\s*[/:]\s*/);
  if (parts.length > 2 || !parts.every((part) => DECIMAL.test(part))) return null;
  const [amount, total = 1] = parts.map(Number);
  if (!Number.isFinite(amount) || !Number.isFinite(total) || total <= 0) return null;
  const value = amount / total;
  return Number.isFinite(value) ? value : null;
}

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/** Both populations must be defined. The lower end belongs to the interval and the upper end does not. */
export function validTitrationGates(tube: TitrationTube): boolean {
  const { negativeLower, negativeUpper, positiveLower, positiveUpper } = tube;
  return [negativeLower, negativeUpper, positiveLower, positiveUpper].every(finiteOrNull)
    && negativeUpper !== null && positiveLower !== null
    && (negativeLower === null || negativeLower < negativeUpper)
    && (positiveUpper === null || positiveLower < positiveUpper)
    && negativeUpper <= positiveLower;
}

function measurement(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function stainIndex(positive: number | null, negative: number | null, spread: number | null): number | null {
  return positive !== null && negative !== null && spread !== null && spread > 0
    ? measurement((positive - negative) / (2 * spread))
    : null;
}

/** Stored linear detector values from one file. A mask for a named population must resolve to this file. */
export function measureTube(
  values: ArrayLike<number>,
  mask: Uint8Array | null,
  tube: TitrationTube,
  range: number,
): TitrationStatistics | null {
  if (!validTitrationGates(tube) || (tube.populationId !== null && mask === null)
    || (mask !== null && mask.length !== values.length)) return null;
  const gated = (lower: number | null, upper: number | null) => sortedValues(values, eventIndices({
    fileId: tube.fileId, mask, lower: lower ?? undefined, upper: upper ?? undefined,
  }, values));
  const negative = gated(tube.negativeLower, tube.negativeUpper);
  const positive = gated(tube.positiveLower, tube.positiveUpper);
  const negativeMedian = measurement(medianSorted(negative));
  const positiveMedian = measurement(medianSorted(positive));
  const negativeSpread = measurement((quantileSorted(negative, 0.8413) - quantileSorted(negative, 0.1587)) / 2);
  let saturationFraction: number | null = null;
  if (Number.isFinite(range) && range > 0 && positive.length > 0) {
    // Same near-ceiling threshold as the spillover estimator (TOP_OF_RANGE).
    let atTop = 0;
    for (let i = positive.length - 1; i >= 0 && positive[i] >= 0.99 * range; i--) atTop++;
    saturationFraction = atTop / positive.length;
  }
  return {
    negativeCount: negative.length, positiveCount: positive.length,
    negativeMedian, positiveMedian, negativeSpread,
    stainIndex: stainIndex(positiveMedian, negativeMedian, negativeSpread), saturationFraction,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function eventCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readStatistics(value: unknown, total: number): TitrationStatistics | null {
  if (!record(value)) return null;
  const { negativeCount, positiveCount, negativeMedian, positiveMedian, negativeSpread, saturationFraction } = value;
  if (!eventCount(negativeCount) || !eventCount(positiveCount) || negativeCount + positiveCount > total
    || !finiteOrNull(negativeMedian) || !finiteOrNull(positiveMedian) || !finiteOrNull(negativeSpread)
    || !finiteOrNull(value.stainIndex) || !finiteOrNull(saturationFraction)) return null;
  if ((negativeCount === 0 && (negativeMedian !== null || negativeSpread !== null))
    || (positiveCount === 0 && (positiveMedian !== null || saturationFraction !== null))
    || (negativeSpread !== null && negativeSpread < 0)
    || (saturationFraction !== null && (saturationFraction < 0 || saturationFraction > 1))) return null;
  if (value.stainIndex !== stainIndex(positiveMedian, negativeMedian, negativeSpread)) return null;
  return { negativeCount, positiveCount, negativeMedian, positiveMedian, negativeSpread, stainIndex: value.stainIndex, saturationFraction };
}

function readSnapshot(value: unknown, detector: string, tube: TitrationTube): TitrationReviewSnapshot | undefined {
  if (!record(value) || value.detector !== detector || !identifier(detector) || value.populationId !== tube.populationId
    || value.assay !== "original" || !identifier(value.fileName) || !eventCount(value.eventCount)) return undefined;
  const statistics = readStatistics(value.statistics, value.eventCount);
  if (value.statistics !== null && (!statistics || !validTitrationGates(tube))) return undefined;
  return {
    detector, populationId: tube.populationId, assay: "original", fileName: value.fileName,
    eventCount: value.eventCount, statistics,
  };
}

function readTube(value: unknown, detector: string): TitrationTube | null {
  if (!record(value) || !identifier(value.fileId)) return null;
  const { fileId, dose, replicate, populationId, negativeLower, negativeUpper, positiveLower, positiveUpper } = value;
  if (typeof dose !== "string" || typeof replicate !== "string" || (populationId !== null && !identifier(populationId))
    || !finiteOrNull(negativeLower) || !finiteOrNull(negativeUpper)
    || !finiteOrNull(positiveLower) || !finiteOrNull(positiveUpper)) return null;
  const tube = { fileId, dose, replicate, populationId, negativeLower, negativeUpper, positiveLower, positiveUpper };
  const reviewed = readSnapshot(value.reviewed, detector, tube);
  return reviewed ? { ...tube, reviewed } : tube;
}

/** Restores editable series, including drafts. The first well-formed record for each ID wins. */
export function readTitrationSeries(value: unknown): TitrationSeries[] {
  if (!Array.isArray(value)) return [];
  const series: TitrationSeries[] = [];
  const seriesIds = new Set<string>();
  for (const item of value) {
    if (!record(item) || !identifier(item.id) || seriesIds.has(item.id) || !Array.isArray(item.tubes)) continue;
    const { id, clone, conjugate, lot, detector, unit, note } = item;
    if (typeof clone !== "string" || typeof conjugate !== "string" || typeof lot !== "string"
      || typeof detector !== "string" || typeof unit !== "string" || typeof note !== "string") continue;
    const tubes: TitrationTube[] = [];
    const fileIds = new Set<string>();
    for (const input of item.tubes) {
      const tube = readTube(input, detector);
      if (!tube || fileIds.has(tube.fileId)) continue;
      tubes.push(tube);
      fileIds.add(tube.fileId);
    }
    const chosenDose = typeof item.chosenDose === "string" && parseDose(item.chosenDose) !== null
      && tubes.some((tube) => tube.dose === item.chosenDose) ? item.chosenDose : null;
    series.push({ id, clone, conjugate, lot, detector, unit, tubes, chosenDose, note });
    seriesIds.add(id);
  }
  return series;
}
