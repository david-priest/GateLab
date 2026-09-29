// fileIdentity.ts — is this FCS file the acquisition a workspace recorded?
//
// Every importer that pairs a workspace's samples, tubes or files with FCS files names them by
// file name first, and a file name is not an identity. BD FACSDiva names its files
// Specimen_001_Tube_001.fcs in every experiment, FlowJo lets one file be added twice, and a
// same-named file from another experiment imported another acquisition's gates without a word.
//
// What identifies an acquisition is what the cytometer wrote while recording it: the event count,
// the date and the begin and end times, and (on BD instruments) a GUID. FlowJo copies the file's
// whole TEXT segment into each sample's <Keywords>, a FACSDiva experiment records each tube's
// begin and end, and a GateLab workspace records them per file. So a name nominates candidates,
// and these keywords decide between them.
//
// The comparison tolerates what differs harmlessly between two copies of one TEXT segment:
// whitespace, keyword-name case, padding and leading zeros in $TOT, FlowJo's date formats
// ("12_17_2018" for "12/17/2018"), fractional seconds, and a blank value (FlowJo fills $DATE,
// GUID and $FIL where the FCS holds spaces). Measured on the FlowRepository corpus (2026-09-24),
// that leaves no contradiction on any pairing where GateLab's counts agree with FlowJo's, except
// one deposit that is a genuine subset of its acquisition.

/** The keywords compared. $FIL is not among them: it is a name, and Diva repeats it. */
export type IdentityKey = "$TOT" | "$DATE" | "$BTIM" | "$ETIM" | "GUID";
export const IDENTITY_KEYS: readonly IdentityKey[] = ["$TOT", "$DATE", "$BTIM", "$ETIM", "GUID"];

/** What a record says about an acquisition: only the keys it carries, each non-blank. */
export type RecordedIdentity = Partial<Record<IdentityKey, string>>;

/** Keys that tell two acquisitions apart. $TOT and $DATE alone do not: fixed-count runs share a $TOT. */
const DISTINCTIVE: readonly IdentityKey[] = ["$BTIM", "$ETIM", "GUID"];

/**
 * The identity keywords of a keyword map, keyword names compared without case and values trimmed.
 * A blank value is left out: it is not recorded, and must not read as a difference.
 */
export function identityKeywords(keywords: Readonly<Record<string, string>> | null | undefined): RecordedIdentity {
  const out: RecordedIdentity = {};
  if (!keywords) return out;
  for (const [name, value] of Object.entries(keywords)) {
    const key = name.trim().toUpperCase() as IdentityKey;
    if (!IDENTITY_KEYS.includes(key) || out[key] !== undefined) continue;
    const v = String(value ?? "").trim();
    if (v) out[key] = v;
  }
  return out;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function fullYear(text: string): number {
  const y = Number(text);
  return y < 50 ? y + 2000 : y < 100 ? y + 1900 : y;
}

/**
 * Every calendar date a $DATE value can mean, as "y-m-d". A day-month-year and a month-day-year
 * reading are both kept when the text does not say which it is; two dates agree when any reading
 * of one is a reading of the other. Unreadable text stands for itself.
 */
export function dateReadings(value: string): Set<string> {
  // A weekday before or after the date ("Thu, 25 Oct 2018", "25 Oct 2018 (Thu)") says nothing
  // the date does not, and nor does an ordinal day's suffix ("October 25th, 2018").
  const text = value.trim().toUpperCase()
    .replace(/^(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\.?,?\s+/, "")
    .replace(/[\s,]+\(?(MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\.?\)?$/, "")
    .replace(/\b(\d{1,2})(ST|ND|RD|TH)\b/, "$1");
  // An ISO date-time ("2023-07-20T11:54:39", as FACSDiva writes a tube's) keeps its date part.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (iso) return new Set([`${Number(iso[1])}-${Number(iso[2])}-${Number(iso[3])}`]);
  // A comma separates like a space ("Oct 25, 2018"); it read as a contradiction of 25-OCT-2018.
  const parts = text.split(/[-/_., ]+/).filter(Boolean);
  if (parts.length !== 3) return new Set([`raw:${text}`]);
  const [a, b, c] = parts;
  const month = (s: string) => MONTHS.indexOf(s.slice(0, 3)) + 1;
  // Year first with a month name ("2018-Oct-25"): read as day-month-year it was 2025-10-2018.
  if (month(b) > 0 && /^\d{4}$/.test(a) && /^\d+$/.test(c)) return new Set([`${Number(a)}-${month(b)}-${Number(c)}`]);
  if (month(b) > 0 && /^\d+$/.test(a) && /^\d+$/.test(c)) return new Set([`${fullYear(c)}-${month(b)}-${Number(a)}`]);
  if (month(a) > 0 && /^\d+$/.test(b) && /^\d+$/.test(c)) return new Set([`${fullYear(c)}-${month(a)}-${Number(b)}`]);
  if (![a, b, c].every((p) => /^\d+$/.test(p))) return new Set([`raw:${text}`]);
  const [x, y, z] = [Number(a), Number(b), Number(c)];
  if (x > 31) return new Set([`${x}-${y}-${z}`]);
  return new Set([`${fullYear(c)}-${x}-${y}`, `${fullYear(c)}-${y}-${x}`]);
}

/**
 * A time of day in whole seconds. Fractions (hh:mm:ss.cc) and FCS 3.0's sixtieths (hh:mm:ss:tt)
 * are dropped, and a 12-hour clock is read. Unreadable text stands for itself.
 */
export function secondsOfDay(value: string): number | string {
  const text = value.trim();
  // An ISO date-time carries the time after its T.
  const iso = /^\d{4}-\d{1,2}-\d{1,2}[T ](.*)$/.exec(text);
  const clock = iso ? iso[1].replace(/(Z|[+-]\d\d:?\d\d)$/, "") : text;
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:[.:]\d+)?\s*(AM|PM)?$/i.exec(clock);
  if (!m) return `raw:${text.toUpperCase()}`;
  let h = Number(m[1]);
  if (m[4]) h = (h % 12) + (m[4].toUpperCase() === "PM" ? 12 : 0);
  return h * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Whether two values of one identity keyword describe the same acquisition. */
export function sameIdentityValue(key: IdentityKey, a: string, b: string): boolean {
  switch (key) {
    case "$TOT": {
      const x = a.trim(), y = b.trim();
      return /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) === Number(y) : x === y;
    }
    case "$DATE": {
      const ra = dateReadings(a);
      for (const r of dateReadings(b)) if (ra.has(r)) return true;
      return false;
    }
    case "$BTIM":
    case "$ETIM":
      return secondsOfDay(a) === secondsOfDay(b);
    case "GUID": {
      const g = (s: string) => s.trim().replace(/^\{|\}$/g, "").toLowerCase();
      return g(a) === g(b);
    }
  }
}

/**
 * - confirmed: a begin or end time or the GUID agrees, and nothing differs;
 * - weak: only $TOT or $DATE agree -- fixed-count acquisitions share a $TOT, so this confirms
 *   nothing on its own, though it contradicts nothing either;
 * - unconfirmed: nothing both sides record;
 * - contradicted: a key both sides record differs.
 */
export type IdentityVerdict = "confirmed" | "weak" | "unconfirmed" | "contradicted";

export interface IdentityDifference {
  key: IdentityKey;
  recorded: string;
  file: string;
}

export interface IdentityComparison {
  verdict: IdentityVerdict;
  agree: IdentityKey[];
  differ: IdentityDifference[];
}

/** Compare what a record says about an acquisition with what a file says about itself. */
export function compareIdentity(recorded: RecordedIdentity, file: RecordedIdentity): IdentityComparison {
  const agree: IdentityKey[] = [];
  const differ: IdentityDifference[] = [];
  for (const key of IDENTITY_KEYS) {
    const r = recorded[key], f = file[key];
    if (!r?.trim() || !f?.trim()) continue;
    if (sameIdentityValue(key, r, f)) agree.push(key);
    else differ.push({ key, recorded: r.trim(), file: f.trim() });
  }
  const verdict: IdentityVerdict = differ.length
    ? "contradicted"
    : agree.some((k) => DISTINCTIVE.includes(k))
      ? "confirmed"
      : agree.length ? "weak" : "unconfirmed";
  return { verdict, agree, differ };
}

const VERDICT_RANK: Record<IdentityVerdict, number> = { confirmed: 3, weak: 2, unconfirmed: 1, contradicted: 0 };

/** How strongly a verdict pairs a file with a record, for choosing between two records. */
export function verdictRank(verdict: IdentityVerdict): number {
  return VERDICT_RANK[verdict];
}

function shown(key: IdentityKey, value: string): string {
  return key === "$TOT" && /^\d+$/.test(value.trim()) ? Number(value.trim()).toLocaleString("en-US") : value;
}

/**
 * Say, by name, why a record is not this file: "sample 3 "H1.fcs" records $TOT 36,988 and $BTIM
 * 11:02:10; this file has 43,641 and 11:56:55".
 */
export function describeContradiction(recordLabel: string, differ: readonly IdentityDifference[], fileLabel = "this file"): string {
  const recorded = differ.map((d) => `${d.key} ${shown(d.key, d.recorded)}`);
  const file = differ.map((d) => shown(d.key, d.file));
  const join = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
  return `${recordLabel} records ${join(recorded)}; ${fileLabel} has ${join(file)}`;
}

/** A UI translator, as useI18n().t; the default fills the English template's {placeholders}. */
type Translator = (source: string, values?: Readonly<Record<string, string | number>>) => string;
const inEnglish: Translator = (source, values = {}) =>
  source.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);

/**
 * What the keywords said about a pairing, for saying so: "confirmed by $BTIM, GUID". A weak
 * agreement confirms nothing ($TOT and $DATE are shared by fixed-count runs of one day), and is
 * not called a confirmation: "agrees on $TOT, $DATE only, which does not confirm it". In the
 * interface's language when it passes its translator; the FlowJo open dialog's rows said it in
 * English in Japanese.
 */
export function describeAgreement(comparison: IdentityComparison, say: Translator = inEnglish): string {
  const keywords = comparison.agree.join(", ");
  if (comparison.verdict === "confirmed") return say("confirmed by {keywords}", { keywords });
  if (comparison.verdict === "weak") return say("agrees on {keywords} only, which does not confirm it", { keywords });
  return say(comparison.verdict === "unconfirmed" ? "no identity keyword to compare" : "contradicted");
}

/**
 * Two FCS-ish names the way workspaces and file systems disagree about them: stem, no case, and one
 * Unicode form. macOS hands a file picker decomposed names (NFD) where a workspace written elsewhere
 * holds composed ones (NFC), so "Probe_ü.fcs" did not match itself; relinking already normalised.
 */
export function sameFileName(a: string, b: string): boolean {
  // Trim BEFORE stripping the extension: /\.fcs$/ does not match when the name carries trailing
  // whitespace, so the other order silently failed to match a padded workspace name.
  const stem = (n: string) => n.normalize("NFC").trim().replace(/\.fcs$/i, "").trim().toLowerCase();
  return stem(a).length > 0 && stem(a) === stem(b);
}

export interface PairCandidate<S> {
  sample: S;
  comparison: IdentityComparison;
}

/** Which of a workspace's records is this file. Document order never decides. */
export type FilePairing<S> =
  /** One record is this file: the only one named like it that nothing contradicts, or the only
   *  one of several its keywords confirm. `rejected` lists the same-named records they contradict;
   *  `passedOver`, the same-named records that record nothing confirming the file, set aside for
   *  the record its $FIL names and its keywords confirm. */
  | { kind: "own"; sample: S; comparison: IdentityComparison; matchedOn: "name" | "fil"; rejected: PairCandidate<S>[]; passedOver?: PairCandidate<S>[] }
  /** Several records could be this file and the keywords cannot tell which: the user is asked. */
  | { kind: "ambiguous"; candidates: PairCandidate<S>[]; matchedOn: "name" | "fil"; rejected: PairCandidate<S>[] }
  /** Records are named like the file, and every one of them records another acquisition. */
  | { kind: "contradicted"; candidates: PairCandidate<S>[]; matchedOn: "name" | "fil" }
  /** Nothing in the workspace is named like the file. */
  | { kind: "none" };

/**
 * Pair one file with the record that is it.
 *
 * Candidates are every record named like the file (any of `namesOf`). Those whose recorded
 * keywords contradict the file are dropped. One left is the file's own; several are decided by
 * the one the keywords confirm, and otherwise the user is asked -- one acquisition added to a
 * workspace twice is confirmed by both, and nothing can choose between them but the person who
 * added it.
 *
 * When no record named like the file is left -- none is named like it, or every one records
 * another acquisition -- the records named like the file's own $FIL are tried the same way. A file
 * renamed on disk, or two files of one experiment swapped, keeps the $FIL the cytometer wrote, and
 * its sample was reported as "no sample is this file" because a sample of its new name existed.
 *
 * The $FIL is tried as well when the records of the file's name are left but none of them is
 * confirmed: a record of its name that records nothing to compare, or only a $TOT and $DATE, gave
 * way to nothing, and took the file from the record its $FIL names and every keyword confirms.
 * Such a record now gives way to that one; where neither is confirmed, the user is asked.
 */
export function pairFile<S>(
  file: { name: string; keywords?: Readonly<Record<string, string>> | null },
  samples: readonly S[],
  namesOf: (sample: S) => readonly string[],
  recordedOf: (sample: S) => RecordedIdentity,
): FilePairing<S> {
  const named = (name: string) => samples.filter((s) => namesOf(s).some((n) => sameFileName(n, name)));
  const own = identityKeywords(file.keywords);
  const compare = (list: readonly S[]): PairCandidate<S>[] =>
    list.map((sample) => ({ sample, comparison: compareIdentity(recordedOf(sample), own) }));
  const decide = (compared: PairCandidate<S>[], matchedOn: "name" | "fil", earlier: PairCandidate<S>[]): FilePairing<S> | null => {
    const rejected = [...earlier, ...compared.filter((c) => c.comparison.verdict === "contradicted")];
    const left = compared.filter((c) => c.comparison.verdict !== "contradicted");
    if (!left.length) return null;
    if (left.length === 1) return { kind: "own", sample: left[0].sample, comparison: left[0].comparison, matchedOn, rejected };
    const confirmed = left.filter((c) => c.comparison.verdict === "confirmed");
    if (confirmed.length === 1) return { kind: "own", sample: confirmed[0].sample, comparison: confirmed[0].comparison, matchedOn, rejected };
    return { kind: "ambiguous", candidates: left, matchedOn, rejected };
  };
  const byName = compare(named(file.name));
  const confirmedOf = (list: PairCandidate<S>[]) => list.filter((c) => c.comparison.verdict === "confirmed");
  const nameLeft = byName.filter((c) => c.comparison.verdict !== "contradicted");
  // A record of its name that the keywords confirm settles it, as it always did.
  if (confirmedOf(nameLeft).length) return decide(byName, "name", [])!;
  const fil = Object.entries(file.keywords ?? {}).find(([k]) => k.trim().toUpperCase() === "$FIL")?.[1]?.trim();
  const byFil = fil ? compare(named(fil).filter((s) => !byName.some((c) => c.sample === s))) : [];
  const filLeft = byFil.filter((c) => c.comparison.verdict !== "contradicted");
  if (nameLeft.length && filLeft.length) {
    // Records of its name that confirm nothing, and records of its $FIL: the one the keywords
    // confirm, else the user says which.
    const filConfirmed = confirmedOf(filLeft);
    const rejected = [...byName, ...byFil].filter((c) => c.comparison.verdict === "contradicted");
    if (filConfirmed.length === 1) {
      return { kind: "own", sample: filConfirmed[0].sample, comparison: filConfirmed[0].comparison, matchedOn: "fil", rejected, passedOver: nameLeft };
    }
    return { kind: "ambiguous", candidates: [...nameLeft, ...filLeft], matchedOn: "name", rejected };
  }
  const first = decide(byName, "name", []);
  if (first) return first;
  const second = decide(byFil, "fil", byName);
  if (second) return second;
  const all = [...byName, ...byFil];
  if (!all.length) return { kind: "none" };
  return { kind: "contradicted", candidates: all, matchedOn: byName.length ? "name" : "fil" };
}
