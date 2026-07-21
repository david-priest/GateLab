import { useMemo, useSyncExternalStore } from "react";

interface RevisionSource {
  readonly dataRevision: number;
  subscribeDataRevision(listener: () => void): () => void;
}

export interface SampleRevisionEntry {
  readonly id: string;
  readonly sample: RevisionSource;
}

/** Primitive snapshot: stable by value, but sensitive to sample identity, order, and revision. */
export function sampleDataRevisionKey(samples: readonly SampleRevisionEntry[]): string {
  return JSON.stringify(samples.map(({ id, sample }) => [id, sample.dataRevision]));
}

/**
 * Subscribe React to every loaded Sample as one external store. This also closes the
 * render-to-effect gap when a worker installs a layer on an inactive sample.
 */
export function useSampleDataRevisionKey(samples: readonly SampleRevisionEntry[]): string {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const unsubscribe = samples.map(({ sample }) => sample.subscribeDataRevision(listener));
      return () => unsubscribe.forEach((stop) => stop());
    },
    [samples],
  );
  const getSnapshot = useMemo(() => () => sampleDataRevisionKey(samples), [samples]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
