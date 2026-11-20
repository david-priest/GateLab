// floorEstimate.ts — the spillover coefficient a stained sample's own events support.
//
// Spillover puts a floor under the receiving channel: an event with x counts in the source holds
// at least s·x counts in the receiver, whatever else the cell carries there. A marker on the same
// cells can only add counts above that floor. So across groups of events of rising source signal,
// the slope of a low quantile of the receiver is
//
//   - never below what spillover alone would give, once the counting noise of the spill itself is
//     allowed for: that gives an upper bound on s that holds whatever the cells express; and
//   - equal to s (within that noise) when at most half of the source-bright events also carry the
//     receiver's own marker.
//
// The estimate is made on stored counts (the Original layer), never on compensated values, and
// solves nothing: it is a few sorts per pair.
//
// The intercept of the fit takes up whatever the receiver holds that does not depend on the
// source (its own marker on every cell, background), so a receiver expressed everywhere does not
// by itself raise the slope.

/** The quantile of the receiver taken as its floor within a group of events. */
export const FLOOR_QUANTILE = 0.25;
/** A second, lower quantile: the distance between the two measures how tight the floor is. */
const LOWER_QUANTILE = 0.1;
/** Standard normal distance between the two quantiles above, in standard deviations. */
const QUANTILE_GAP_SD = 0.607;
/** Fewer screened events than this and a source gives no groups. */
export const MIN_SCREEN_EVENTS = 500;
/** A group holds at least this many events; a smaller one is merged into its neighbour. */
export const MIN_GROUP_EVENTS = 60;
/** A group larger than this is thinned evenly: the floor of 3,000 events is known well enough. */
const MAX_GROUP_EVENTS = 3_000;
/**
 * Upper edges of the groups as quantiles of the source. The lower half is one group (the
 * reference), and each group above holds half the events of the one before, so the bright tail,
 * where spillover is measurable, is resolved without a count threshold on the source. The top
 * 0.05% is left out: aggregates and saturated events.
 */
const GROUP_EDGES = [0.5, 0.75, 0.875, 0.9375, 0.96875, 0.984375, 0.9921875, 0.9995] as const;
/** Fewer groups than this and no slope is fitted. */
const MIN_GROUPS = 4;

export interface SourceGroups {
  /** The source signal of every screened event, as given. */
  readonly values: ArrayLike<number>;
  /** Positions into the screened event arrays, one array per group, the lowest source signal first. */
  readonly groups: readonly Uint32Array[];
  /** The median source signal of each group, raw counts. */
  readonly centres: Float64Array;
  /** Source signal between the lowest and the highest group: the lever the slope is read over. */
  readonly span: number;
}

export type SourceGroupsResult =
  | Readonly<{ usable: true; source: SourceGroups }>
  /** `few-events`: too few screened events. `no-range`: the source does not vary across them. */
  | Readonly<{ usable: false; reason: "few-events" | "no-range" }>;

function sortedCopy(values: ArrayLike<number>, positions: Uint32Array): Float64Array {
  const copy = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index++) copy[index] = values[positions[index]];
  return copy.sort();
}

function quantileOfSorted(sorted: Float64Array, probability: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** Groups of events by rising source signal. The same groups serve every receiver of the source. */
export function groupEventsBySource(source: ArrayLike<number>): SourceGroupsResult {
  const count = source.length;
  if (count < MIN_SCREEN_EVENTS) return { usable: false, reason: "few-events" };
  const order = new Uint32Array(count);
  for (let index = 0; index < count; index++) order[index] = index;
  order.sort((left, right) => source[left] - source[right]);

  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const edge of GROUP_EDGES) {
    const end = Math.min(count, Math.round(edge * count));
    if (end > start) ranges.push([start, end]);
    start = end;
  }
  // A thin group at the bright end is merged downwards until it holds enough events.
  while (ranges.length > 1 && ranges[ranges.length - 1][1] - ranges[ranges.length - 1][0] < MIN_GROUP_EVENTS) {
    const last = ranges.pop()!;
    ranges[ranges.length - 1][1] = last[1];
  }
  if (ranges.length < MIN_GROUPS) return { usable: false, reason: "few-events" };

  const groups: Uint32Array[] = [];
  const centres = new Float64Array(ranges.length);
  ranges.forEach(([from, to], group) => {
    const size = to - from;
    const kept = Math.min(size, MAX_GROUP_EVENTS);
    const positions = new Uint32Array(kept);
    for (let index = 0; index < kept; index++) {
      positions[index] = order[from + (kept === size ? index : Math.floor(index * size / kept))];
    }
    groups.push(positions);
    centres[group] = quantileOfSorted(sortedCopy(source, positions), 0.5);
  });
  const span = centres[centres.length - 1] - centres[0];
  if (!(span > 0)) return { usable: false, reason: "no-range" };
  return { usable: true, source: { values: source, groups, centres, span } };
}

export interface FloorEstimate {
  /** Slope of the receiver's floor against the source: receiver counts per source count. */
  readonly slope: number;
  /** Standard error of the slope from the sampling of each group's floor, widened where the floors do not lie on a line. */
  readonly standardError: number;
  /**
   * The largest coefficient the events allow: the slope with the counting noise of the spill
   * itself and 1.96 standard errors added, so a bound at about the 97.5% level. It does not
   * depend on what the cells express.
   */
  readonly upperBound: number;
  /** The receiver's floor in the reference (lowest) group, raw counts. */
  readonly referenceFloor: number;
  /** Robust spread of the receiver about its floor in the reference group, raw counts. */
  readonly referenceSpread: number;
  /**
   * Width of the floor in the brightest group against the width counting noise alone would give
   * at this slope (1 = as tight as counting noise; several = a spread of expression, not spill).
   */
  readonly tightness: number;
  /** Misfit of the group floors to a straight line, per degree of freedom (about 1 for a line). */
  readonly misfit: number;
  /** Source signal the slope was read over, raw counts. */
  readonly span: number;
  readonly groupCount: number;
  /** The fitted points, for drawing: source centre and receiver floor per group. */
  readonly points: readonly Readonly<{ source: number; floor: number }>[];
}

function logGamma(value: number): number {
  // Lanczos approximation, good to about 1e-14 for value > 0.
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let series = 1.000000000190015;
  let term = value;
  for (const coefficient of coefficients) series += coefficient / ++term;
  const shifted = value + 5.5;
  return (value + 0.5) * Math.log(shifted) - shifted + Math.log(2.5066282746310005 * series / value);
}

/** P(count <= value) for a Poisson count read as continuous: a count n is spread over (n - 1, n]. */
function continuousPoissonCdf(value: number, rate: number): number {
  if (value < 0) return 0;
  if (!(rate > 0)) return 1;
  const whole = Math.floor(value);
  const fraction = value - whole;
  const from = Math.max(0, Math.floor(rate - 12 * Math.sqrt(rate) - 12));
  if (whole + 1 < from) return 0;
  let total = 0;
  let logTerm = from * Math.log(rate) - rate - logGamma(from + 1);
  for (let count = from; count <= whole + 1; count++) {
    const probability = Math.exp(logTerm);
    total += count <= whole ? probability : probability * fraction;
    logTerm += Math.log(rate) - Math.log(count + 1);
  }
  return Math.min(1, total);
}

/**
 * The Poisson rate whose `probability` quantile is `value`: the mean count of a spill whose
 * floor sits at `value`. Counts are read as continuous, as a mass cytometer writes them.
 */
export function poissonRateAtQuantile(value: number, probability: number): number {
  const target = Math.max(0, value);
  let low = 0;
  let high = target + 12 * Math.sqrt(target + 1) + 20;
  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (low + high) / 2;
    if (continuousPoissonCdf(target, middle) > probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const order = values.map((_, index) => index).sort((left, right) => values[left] - values[right]);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let running = 0;
  for (const index of order) {
    running += weights[index];
    if (running >= total / 2) return values[index];
  }
  return Number.NaN;
}

/** Rounds of re-reading the floors with the events moved to their group's centre along the slope. */
const RECENTRE_ROUNDS = 3;

interface GroupFloors {
  readonly floors: Float64Array;
  readonly sigmas: Float64Array;
  readonly referenceSpread: number;
  readonly topWidth: number;
}

/**
 * The floor of the receiver in each group. Within a group the source still varies, and with it
 * the spill, so a low quantile of the receiver would sit on the group's dimmer events and read
 * low; each event is first moved to the group's centre along `slope`.
 */
function groupFloors(source: SourceGroups, receiver: ArrayLike<number>, slope: number): GroupFloors {
  const groupCount = source.groups.length;
  const floors = new Float64Array(groupCount);
  const sigmas = new Float64Array(groupCount);
  let referenceSpread = 0;
  let topWidth = 0;
  for (let group = 0; group < groupCount; group++) {
    const positions = source.groups[group];
    const size = positions.length;
    const centre = source.centres[group];
    const sorted = new Float64Array(size);
    for (let index = 0; index < size; index++) {
      const event = positions[index];
      sorted[index] = receiver[event] - slope * (source.values[event] - centre);
    }
    sorted.sort();
    floors[group] = quantileOfSorted(sorted, FLOOR_QUANTILE);
    // Distribution-free interval for a quantile: the order statistics either side of its rank.
    const rank = FLOOR_QUANTILE * (size - 1);
    const halfWidth = 1.96 * Math.sqrt(size * FLOOR_QUANTILE * (1 - FLOOR_QUANTILE));
    const below = sorted[Math.max(0, Math.floor(rank - halfWidth))];
    const above = sorted[Math.min(size - 1, Math.ceil(rank + halfWidth))];
    // Counts are whole numbers underneath: a floor on a pile of equal values is still only
    // known to within a count over the root of the events.
    sigmas[group] = Math.max((above - below) / 3.92, 1 / Math.sqrt(size));
    const width = floors[group] - quantileOfSorted(sorted, LOWER_QUANTILE);
    if (group === 0) referenceSpread = width / QUANTILE_GAP_SD;
    if (group === groupCount - 1) topWidth = width;
  }
  return { floors, sigmas, referenceSpread, topWidth };
}

/**
 * The median of the slopes between every two groups, each weighted by how well it is known
 * (source distance over the error of the two floors). Robust to a group whose floor is lifted
 * by a subpopulation.
 */
function slopeThroughFloors(source: SourceGroups, { floors, sigmas }: GroupFloors): number {
  const slopes: number[] = [];
  const weights: number[] = [];
  for (let low = 0; low < floors.length; low++) {
    for (let high = low + 1; high < floors.length; high++) {
      const distance = source.centres[high] - source.centres[low];
      if (!(distance > 0)) continue;
      slopes.push((floors[high] - floors[low]) / distance);
      weights.push(distance / Math.hypot(sigmas[low], sigmas[high]));
    }
  }
  return weightedMedian(slopes, weights);
}

/**
 * The floor of `receiver` against the source the groups were made from. `receiver` holds one
 * value per screened event, in the order the source was given in; it may be negative where other
 * sources' spillover has been taken off.
 */
export function estimateFloor(source: SourceGroups, receiver: ArrayLike<number>): FloorEstimate {
  const groupCount = source.groups.length;
  let read = groupFloors(source, receiver, 0);
  let slope = slopeThroughFloors(source, read);
  for (let round = 0; round < RECENTRE_ROUNDS; round++) {
    read = groupFloors(source, receiver, slope);
    const next = slopeThroughFloors(source, read);
    const settled = Math.abs(next - slope) <= 1e-6 + 1e-3 * Math.abs(slope);
    slope = next;
    if (settled) break;
  }
  const { floors, sigmas, referenceSpread, topWidth } = read;

  // Error of a weighted straight-line fit through the same floors, widened by its own misfit.
  let sumWeight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let group = 0; group < groupCount; group++) {
    const weight = 1 / sigmas[group] ** 2;
    sumWeight += weight;
    sumX += weight * source.centres[group];
    sumY += weight * floors[group];
  }
  const meanX = sumX / sumWeight;
  const meanY = sumY / sumWeight;
  let sxx = 0;
  let sxy = 0;
  for (let group = 0; group < groupCount; group++) {
    const weight = 1 / sigmas[group] ** 2;
    sxx += weight * (source.centres[group] - meanX) ** 2;
    sxy += weight * (source.centres[group] - meanX) * (floors[group] - meanY);
  }
  const fitted = sxx > 0 ? sxy / sxx : 0;
  let chiSquare = 0;
  for (let group = 0; group < groupCount; group++) {
    const residual = floors[group] - (meanY + fitted * (source.centres[group] - meanX));
    chiSquare += (residual / sigmas[group]) ** 2;
  }
  const misfit = chiSquare / Math.max(1, groupCount - 2);
  const standardError = sxx > 0 ? Math.sqrt(Math.max(1, misfit) / sxx) : Number.POSITIVE_INFINITY;

  // A spill of mean m counts has its floor below m. The mean whose floor is the observed rise is
  // the most the spill can be; a background that adds its own spread only lowers the floor further.
  const rise = Math.max(0, slope * source.span);
  const meanAtFloor = poissonRateAtQuantile(rise, FLOOR_QUANTILE);
  const upperBound = meanAtFloor / source.span + 1.96 * standardError;

  const noiseWidth = QUANTILE_GAP_SD * Math.sqrt(referenceSpread ** 2 + Math.max(1, meanAtFloor));
  return {
    slope,
    standardError,
    upperBound,
    referenceFloor: floors[0],
    referenceSpread,
    tightness: topWidth / noiseWidth,
    misfit,
    span: source.span,
    groupCount,
    points: Array.from(floors, (floor, group) => ({ source: source.centres[group], floor })),
  };
}
