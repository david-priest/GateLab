// flowjoOpen.ts — the small decisions the "Open FlowJo workspace" dialog makes about files.
//
// Pure, so they can be tested without the dialog: which of the files a user points at are worth
// holding, and which sample stands as the primary when every file gets its own hierarchy.

import type { FlowJoFileResolution, FlowJoSampleSummary } from "./flowjoWorkspace";

/**
 * The incoming files worth holding for the open: not already in the workspace (the dialog counts
 * a loaded file as found, and loading it again pooled a duplicate into the first hierarchy), and
 * not already held. Names are compared as file systems do, without case.
 */
export function filesToHold<T extends { name: string }>(
  held: readonly { name: string }[],
  loadedNames: readonly string[],
  incoming: readonly T[],
): T[] {
  const taken = new Set([...held, ...loadedNames.map((name) => ({ name }))].map((f) => f.name.toLowerCase()));
  const out: T[] = [];
  for (const file of incoming) {
    const key = file.name.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(file);
  }
  return out;
}

/**
 * The sample whose strategy is imported first under "one hierarchy per file": the selected one
 * if its FCS was found, else the first gated sample whose FCS was. The rows are disabled in that
 * mode, so without this a selection left on a missing file had no way to Import.
 */
export function perFilePrimary(
  samples: readonly FlowJoSampleSummary[],
  resolutions: readonly FlowJoFileResolution[],
  strategySample: number | null,
): FlowJoSampleSummary | undefined {
  const found = (index: number) => resolutions.some((r) => r.sampleIndex === index && r.fileName !== null);
  const selected = samples.find((x) => x.index === strategySample);
  if (selected && found(selected.index)) return selected;
  return samples.find((x) => found(x.index));
}
