// useCompensationScreen.ts — runs the compensation screen for the Compensation tab's Check view.
//
// The screen (src/compensationScreen) reads one matrix source per step. This hook takes a few
// steps at a time and gives way to the page between them, and it runs only while `enabled`: the
// tab is kept mounted when another tab is shown, and a hidden view computes nothing.
import { useEffect, useRef, useState } from "react";
import type { Sample } from "../engine/sample";
import { screenDataFromSample } from "../compensationScreen/screenInput";
import {
  createScreenJob,
  type ScreenData,
  type ScreenMatrix,
  type ScreenResult,
} from "../compensationScreen/screenPairs";

/** Time spent on the screen before the page is given a turn, in milliseconds. */
const SLICE_MS = 12;

export interface CompensationScreenState {
  readonly status: "idle" | "running" | "done";
  readonly completed: number;
  readonly total: number;
  /** The latest complete reading. It stays while a new one runs, marked by `status`. */
  readonly result: ScreenResult | null;
  /** The events `result` was read from, for drawing a pair. */
  readonly data: ScreenData | null;
}

const IDLE: CompensationScreenState = { status: "idle", completed: 0, total: 0, result: null, data: null };

export function useCompensationScreen(input: Readonly<{
  enabled: boolean;
  sample: Sample;
  /** The events to read: a fixed sample of the review population. */
  eventIndices: Uint32Array;
  /** The matrix to read against, staged values included; null where there is none. */
  matrix: ScreenMatrix | null;
  /** Raise to read again with the same inputs. */
  revision: number;
}>): CompensationScreenState {
  const { enabled, sample, eventIndices, matrix, revision } = input;
  const [state, setState] = useState<CompensationScreenState>(IDLE);
  // What the held result was read from: the same inputs are not read twice.
  const readFrom = useRef<unknown[] | null>(null);

  useEffect(() => {
    if (!matrix) {
      readFrom.current = null;
      setState(IDLE);
      return;
    }
    if (!enabled) return;
    const inputs = [sample, eventIndices, matrix, revision];
    if (readFrom.current && inputs.every((value, index) => value === readFrom.current![index])) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const data = screenDataFromSample(sample, eventIndices);
    const job = createScreenJob(data, matrix);
    let completed = 0;
    setState((current) => ({ ...current, status: "running", completed: 0, total: job.stepCount }));
    const slice = () => {
      if (cancelled) return;
      const started = performance.now();
      let more = true;
      while (more && performance.now() - started < SLICE_MS) {
        more = job.step();
        completed++;
      }
      if (more) {
        setState((current) => ({ ...current, status: "running", completed, total: job.stepCount }));
        timer = setTimeout(slice, 0);
        return;
      }
      readFrom.current = inputs;
      setState({ status: "done", completed: job.stepCount, total: job.stepCount, result: job.result(), data });
    };
    timer = setTimeout(slice, 0);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, eventIndices, matrix, revision, sample]);

  return state;
}
