// useCellImage.ts — one event's picture from the image service, as React state. A cached
// picture is served on the first render; otherwise the request goes out and is cancelled when
// the event, the settings or the component changes.

import { useEffect, useState } from "react";
import type { RenderLane, RenderSpecMessage } from "./cvwProtocol";
import { RenderCancelled, type ImageService, type RenderResult } from "./imageService";

export type CellImageStatus = "idle" | "loading" | "ready" | "none" | "error";

export interface CellImageState {
  readonly status: CellImageStatus;
  readonly result: RenderResult | null;
  readonly error: string | null;
}

const IDLE: CellImageState = { status: "idle", result: null, error: null };

export function useCellImage(
  service: ImageService | null,
  fileKey: string | null,
  eventIndex: number | null,
  spec: RenderSpecMessage | null,
  lane: RenderLane,
): CellImageState {
  const [state, setState] = useState<CellImageState>(IDLE);
  useEffect(() => {
    if (!service || fileKey === null || eventIndex === null || !spec) {
      setState(IDLE);
      return;
    }
    const cached = service.cached(fileKey, eventIndex, spec);
    if (cached) {
      setState({ status: cached.kind === "image" ? "ready" : "none", result: cached, error: null });
      return;
    }
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading", result: null, error: null }));
    const handle = service.render(fileKey, eventIndex, spec, lane);
    let live = true;
    handle.promise.then(
      (result) => { if (live) setState({ status: result.kind === "image" ? "ready" : "none", result, error: null }); },
      (error: unknown) => {
        if (!live || error instanceof RenderCancelled) return;
        setState({ status: "error", result: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
      handle.cancel();
    };
  }, [service, fileKey, eventIndex, spec, lane]);
  return state;
}
