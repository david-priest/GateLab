export interface WorkspaceFcsRequirement {
  readonly dataPath: string;
  readonly fileName: string;
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
}

const normalizedName = (name: string): string => name.normalize("NFC").toLocaleLowerCase();

/**
 * Match a workspace's declared samples to one folder snapshot.
 *
 * Exact-case basename matches win. A unique case-insensitive basename is accepted as a
 * convenience, but duplicate basenames are never guessed because opening the wrong FCS
 * would silently corrupt the scientific meaning of the workspace.
 */
export function planWorkspaceFcsRelink<T extends WorkspaceFcsCandidate>(
  requirements: readonly WorkspaceFcsRequirement[],
  candidates: readonly T[],
): WorkspaceFcsRelinkPlan<T> {
  const matches = new Map<string, T>();
  const missing: WorkspaceFcsRequirement[] = [];
  const ambiguous: AmbiguousWorkspaceFcsMatch<T>[] = [];
  const used = new Set<T>();
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

  for (const requirement of requirements) {
    const exact = candidates.filter((candidate) =>
      !used.has(candidate) && candidate.name === requirement.fileName
    );
    const possible = exact.length > 0
      ? exact
      : candidates.filter((candidate) =>
          !used.has(candidate) &&
          normalizedName(candidate.name) === normalizedName(requirement.fileName)
        );

    if (duplicateRequirements.has(requirement.fileName) || possible.length > 1) {
      ambiguous.push({
        requirement,
        candidates: [...possible].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath, undefined, { numeric: true })
        ),
      });
      continue;
    }
    if (possible.length === 0) {
      missing.push(requirement);
      continue;
    }
    matches.set(requirement.dataPath, possible[0]);
    used.add(possible[0]);
  }

  return { matches, missing, ambiguous };
}
