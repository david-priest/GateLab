// cellTypes.ts — the small shared shapes App.tsx and the imaging panels pass around.

/** One event of one file. */
export interface CellRef {
  readonly sampleId: string;
  readonly eventIndex: number;
}

/** What the hover probe found under the cursor. */
export interface HoverHit {
  /** Position in the plotted arrays. */
  readonly plotIndex: number;
  readonly eventIndex: number;
  /** The file the point came from on a pooled plot; null on a single-file plot. */
  readonly sampleId: string | null;
}
