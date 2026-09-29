import { compareIdentity, verdictRank, type IdentityDifference, type IdentityKey, type RecordedIdentity } from "./fileIdentity";
import { parseFcsDataSetFileName } from "./fcs";

export interface WorkspaceFcsRequirement {
  readonly dataPath: string;
  readonly fileName: string;
  /** What the file recorded about its acquisition when the workspace was saved, when it was. */
  readonly identity?: RecordedIdentity;
}

export interface WorkspaceFcsCandidate {
  readonly name: string;
  readonly relativePath: string;
}

export interface AmbiguousWorkspaceFcsMatch<T extends WorkspaceFcsCandidate> {
  readonly requirement: WorkspaceFcsRequirement;
  readonly candidates: readonly T[];
}

export interface WorkspaceFcsRelinkPlan<T extends WorkspaceFcsCandidate> {
  readonly matches: ReadonlyMap<string, T>;
  readonly missing: readonly WorkspaceFcsRequirement[];
  readonly ambiguous: readonly AmbiguousWorkspaceFcsMatch<T>[];
  /**
   * Requirements whose only files of that name record another acquisition than the one the
   * workspace was saved with: a same-named file from another experiment. Never relinked.
   */
  readonly mismatched: readonly { requirement: WorkspaceFcsRequirement; candidates: readonly { candidate: T; differ: readonly IdentityDifference[] }[] }[];
  /**
   * Matches that the identity a requirement was saved with does not confirm -- it agrees on
   * `agree` alone, or the file's keywords could not be read -- taken over other files of the name
   * (`setAside`), in any case, that it does not fit. The right file, as a rule, and relinked, but
   * nothing confirms it, and that is said.
   */
  readonly unconfirmed: readonly { requirement: WorkspaceFcsRequirement; candidate: T; agree: readonly IdentityKey[]; setAside: readonly T[] }[];
}

const normalizedName = (name: string): string => name.normalize("NFC").toLocaleLowerCase();

/**
 * A declaration named so it can be told from another of the same file name: the name alone where
 * the workspace declares it once, else with the acquisition it was saved with ("… recorded
 * 25-OCT-2018 10:48:03"), or where it was saved when that is all there is. Two declarations of one
 * name read identically wherever a message listed them, and nothing said which was which.
 */
export function describeRequirement(requirement: WorkspaceFcsRequirement, all: readonly WorkspaceFcsRequirement[]): string {
  const twice = all.filter((r) => normalizedName(r.fileName) === normalizedName(requirement.fileName)).length > 1;
  if (!twice) return requirement.fileName;
  const id = requirement.identity ?? {};
  const when = [id["$DATE"], id["$BTIM"]].filter((v) => v?.trim()).join(" ");
  return when
    ? `${requirement.fileName} recorded ${when}`
    : `${requirement.fileName} saved at ${requirement.dataPath}`;
}

/** Keys that tell two acquisitions of one name apart; $TOT and $DATE alone do not. */
const DISTINCTIVE = ["$BTIM", "$ETIM", "GUID"] as const;

/**
 * The file names a workspace declares more than once whose declarations cannot be told apart by
 * the identity each was saved with. A name declared twice, each with its own acquisition times or
 * GUID, is two files the keywords can tell apart, and is relinked; before identities were saved it
 * was refused outright, and it still is where one declaration carries none, or two carry the same.
 */
export function indistinguishableDuplicateNames(requirements: readonly WorkspaceFcsRequirement[]): string[] {
  const byName = new Map<string, WorkspaceFcsRequirement[]>();
  for (const r of requirements) {
    const key = normalizedName(r.fileName);
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  const out: string[] = [];
  const signatureOf = (r: WorkspaceFcsRequirement) => {
    const id = r.identity ?? {};
    const keys = DISTINCTIVE.filter((k) => id[k]?.trim());
    return keys.length ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, id[k]!.trim().toLowerCase()]))) : null;
  };
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const signatures = group.map(signatureOf);
    const known = signatures.filter((sig) => sig !== null);
    // A declaration without an identity is told from the others by its exact spelling -- the
    // others taking the files their identities confirm first -- where it is the only one of the
    // group without one and no other declaration spells the name as it does. A case-variant saved
    // with its identity was refused beside it, where the identity decided.
    const bareTold = signatures.every((sig, i) => sig !== null ||
      (signatures.filter((other) => other === null).length === 1 &&
        group.filter((other) => other.fileName === group[i].fileName).length === 1));
    if (!bareTold || new Set(known).size < known.length) out.push(group[0].fileName);
  }
  return out;
}

/**
 * Match a workspace's declared samples to one folder snapshot.
 *
 * Where a declaration was saved with its acquisition identity, every file of its name, in any
 * case, is a candidate and the identity decides: an exact-case file of another acquisition used
 * to hide the case-changed file the identity confirms, the folder was refused, and "Relink
 * anyway" put another acquisition's tree on it. Where the identity does not decide, and where
 * none was saved, exact-case basename matches win. A unique case-insensitive basename is
 * accepted as a convenience, but duplicate basenames are never guessed because opening the wrong
 * FCS would silently corrupt the scientific meaning of the workspace. A name the workspace
 * declares twice is matched only where the identity each declaration was saved with confirms one
 * file.
 *
 * A sample that is one data set of a multi-data-set file (fcsDataSetFileName) is matched by the
 * name of the file it came from, and the data sets of one file all match that one file. Its saved
 * identity is the data set's own, which the whole file's keywords (its first data set's) cannot
 * confirm or contradict, so the file is matched by its name.
 */
export function planWorkspaceFcsRelink<T extends WorkspaceFcsCandidate>(
  requirements: readonly WorkspaceFcsRequirement[],
  candidates: readonly T[],
  /**
   * What a candidate file records about its acquisition, when it has been read. A candidate whose
   * keywords contradict the identity a requirement was saved with is not that file, whatever its
   * name; of several of one name, the one they confirm is taken.
   */
  identityOf: (candidate: T) => RecordedIdentity | null = () => null,
): WorkspaceFcsRelinkPlan<T> {
  const matches = new Map<string, T>();
  const missing: WorkspaceFcsRequirement[] = [];
  const ambiguous: AmbiguousWorkspaceFcsMatch<T>[] = [];
  const mismatched: WorkspaceFcsRelinkPlan<T>["mismatched"][number][] = [];
  const unconfirmed: WorkspaceFcsRelinkPlan<T>["unconfirmed"][number][] = [];
  const used = new Set<T>();
  const sameName = (candidate: T, requirement: WorkspaceFcsRequirement) =>
    normalizedName(candidate.name) === normalizedName(requirement.fileName);
  // A file that one declaration's identity alone confirms is that declaration's, whatever order the
  // workspace declares them in: a case-variant declared first without an identity took it by its
  // exact name, and the declaration it was saved as was refused.
  const reserved = new Map<T, WorkspaceFcsRequirement>();
  for (const requirement of requirements) {
    // A data set's identity is its own, which no whole file's keywords can confirm (below).
    if (!requirement.identity || parseFcsDataSetFileName(requirement.fileName)) continue;
    const confirmed = candidates.filter((candidate) => {
      if (!sameName(candidate, requirement)) return false;
      const own = identityOf(candidate);
      return !!own && compareIdentity(requirement.identity!, own).verdict === "confirmed";
    });
    if (confirmed.length === 1 && !reserved.has(confirmed[0])) reserved.set(confirmed[0], requirement);
  }
  const duplicateRequirements = new Set<string>();
  const requirementsByExactName = new Map<string, WorkspaceFcsRequirement[]>();

  for (const requirement of requirements) {
    const group = requirementsByExactName.get(requirement.fileName) ?? [];
    group.push(requirement);
    requirementsByExactName.set(requirement.fileName, group);
  }
  for (const [fileName, group] of requirementsByExactName) {
    if (group.length > 1) duplicateRequirements.add(fileName);
  }

  /** The file each data set's requirement matched, so the file's other data sets reuse it. */
  const byDataSetFile = new Map<string, T>();
  for (const requirement of requirements) {
    const dataSetFile = parseFcsDataSetFileName(requirement.fileName)?.fileName ?? null;
    const fileName = dataSetFile ?? requirement.fileName;
    const shared = dataSetFile !== null ? byDataSetFile.get(fileName) : undefined;
    if (shared) {
      matches.set(requirement.dataPath, shared);
      continue;
    }
    const named = candidates.filter((candidate) =>
      !used.has(candidate) && normalizedName(candidate.name) === normalizedName(fileName) &&
      (!reserved.has(candidate) || reserved.get(candidate) === requirement)
    );
    // Of files the identity cannot tell apart, the one whose name matches exactly.
    const exactFirst = (list: readonly T[]): T[] => {
      const exact = list.filter((candidate) => candidate.name === fileName);
      return exact.length > 0 ? exact : [...list];
    };
    let possible = exactFirst(named);
    // The name nominates, in any case; the acquisition keywords the workspace was saved with decide.
    const identity = dataSetFile === null ? requirement.identity : undefined;
    let confirmedOne = false;
    let compared: { candidate: T; comparison: ReturnType<typeof compareIdentity> | null }[] = [];
    if (identity && named.length > 0) {
      compared = named.map((candidate) => {
        const own = identityOf(candidate);
        return { candidate, comparison: own ? compareIdentity(identity, own) : null };
      });
      const contradicted = compared.filter((c) => c.comparison?.verdict === "contradicted");
      const left = compared.filter((c) => c.comparison?.verdict !== "contradicted");
      if (left.length === 0) {
        mismatched.push({ requirement, candidates: contradicted.map((c) => ({ candidate: c.candidate, differ: c.comparison!.differ })) });
        continue;
      }
      const best = Math.max(...left.map((c) => (c.comparison ? verdictRank(c.comparison.verdict) : 1)));
      const top = left.filter((c) => (c.comparison ? verdictRank(c.comparison.verdict) : 1) === best);
      confirmedOne = best === verdictRank("confirmed") && top.length === 1;
      possible = confirmedOne ? [top[0].candidate] : exactFirst(left.map((c) => c.candidate));
    }

    // Nothing of the name left is missing, whether or not the name is declared twice: the other
    // declaration's file was found, and this one's was not.
    if (possible.length === 0) {
      missing.push(requirement);
      continue;
    }
    if ((duplicateRequirements.has(requirement.fileName) && !confirmedOne) || possible.length > 1) {
      ambiguous.push({
        requirement,
        candidates: [...possible].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true })
        ),
      });
      continue;
    }
    matches.set(requirement.dataPath, possible[0]);
    used.add(possible[0]);
    if (dataSetFile !== null) byDataSetFile.set(fileName, possible[0]);
    // Taken over other files of the name without the identity confirming it: said, not left silent.
    const taken = compared.find((c) => c.candidate === possible[0]);
    if (taken && taken.comparison?.verdict !== "confirmed" && named.length > 1) {
      unconfirmed.push({
        requirement, candidate: possible[0], agree: taken.comparison?.agree ?? [],
        setAside: named.filter((candidate) => candidate !== possible[0]),
      });
    }
  }

  return { matches, missing, ambiguous, mismatched, unconfirmed };
}
