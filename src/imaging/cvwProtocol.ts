// cvwProtocol.ts — the messages between the app and the image worker. Modelled on
// workers/compensationProtocol.ts: every message carries the protocol tag and a type, a request
// names what it is for, and the worker answers with transferable buffers where it can.

import type { TiffNaming } from "./tiffFolder";
import type { ByteSource } from "./readRange";
import type { ChannelDisplay } from "./imageWallSettings";

export const CVW_WORKER_PROTOCOL = "gatelab.cvw-worker.v1" as const;

/** Hover wants the latest position only; the wall wants every tile it asked for, in order. */
export type RenderLane = "interactive" | "batch";

export interface RenderSpecMessage {
  readonly display: readonly ChannelDisplay[];
  readonly scale: Readonly<Record<number, number>>;
  readonly exposure: number;
  /** Frame step: 16 native, 32 for thumbnails. */
  readonly hop: number;
  /** The composite of the enabled channels. */
  readonly composite: boolean;
  /** Single-channel renders to return as well, by slot. */
  readonly channels: readonly number[];
  /** Draw the outline of the counted objects (objectCount.ts) over every picture; the mask's slot and
   *  threshold travel with it when the FCS records Chorus's, else the SSC plane at the default fraction. */
  readonly outline?: { readonly slot?: number; readonly fraction?: number } | null;
  /** Of `channels`, the slots to return in grey rather than tinted with their colour. */
  readonly grey?: readonly number[];
}

interface Tagged {
  readonly protocol: typeof CVW_WORKER_PROTOCOL;
}

/** Where a sample's images come from: a `.cvw` to read ranges of, or extracted TIFFs by event. */
export type ImageSourceSpec =
  | ByteSource
  | { readonly kind: "tiff-folder"; readonly handle: FileSystemDirectoryHandle; readonly naming: TiffNaming }
  | { readonly kind: "tiff-files"; readonly files: Readonly<Record<number, Blob>> };

export interface OpenSourceRequest extends Tagged {
  readonly type: "open-source";
  readonly fileKey: string;
  readonly source: ImageSourceSpec;
  /** The FCS's event count, which the file's must equal. */
  readonly eventCount: number;
  /** How many events to decode for the full-scale measurement; 0 skips it. */
  readonly scaleSample?: number;
}

export interface RenderRequest extends Tagged {
  readonly type: "render";
  readonly requestId: string;
  readonly fileKey: string;
  readonly eventIndex: number;
  readonly lane: RenderLane;
  /** Interactive requests carry a sequence; a request older than the latest is dropped unread. */
  readonly hoverSeq?: number;
  readonly spec: RenderSpecMessage;
}

export interface CancelRequest extends Tagged {
  readonly type: "cancel";
  readonly requestIds: readonly string[];
}

export interface DropSourceRequest extends Tagged {
  readonly type: "drop-source";
  readonly fileKey: string;
}

export interface SetBudgetRequest extends Tagged {
  readonly type: "set-budget";
  readonly planeBytes: number;
}

/** Count the objects in every imaged event's light-loss picture (objectCount.ts). */
export interface ClassifyRequest extends Tagged {
  readonly type: "classify";
  readonly requestId: string;
  readonly fileKey: string;
  /** The mask: the image channel slot and the threshold as a fraction of full scale (Chorus's own when the FCS records them). */
  readonly options?: {
    readonly slot?: number;
    readonly fraction?: number;
    readonly minArea?: number;
    readonly smoothing?: number;
    /** The file's full scale per slot when the main thread already knows it (a lane opened without measuring has none). */
    readonly scale?: Readonly<Record<number, number>>;
  };
}

export type CvwWorkerRequest = OpenSourceRequest | RenderRequest | CancelRequest | DropSourceRequest | SetBudgetRequest | ClassifyRequest;

export interface SourceReadyResponse extends Tagged {
  readonly type: "source-ready";
  readonly fileKey: string;
  readonly eventCount: number;
  readonly imageCount: number;
  /** One byte per event, 1 when it has an image. */
  readonly hasImage: Uint8Array;
  /** Full-scale value per slot, measured on a sample of events. */
  readonly scale: Readonly<Record<number, number>>;
  readonly channelNames: Readonly<Record<number, string>>;
  readonly pixelAspectRatio: number;
  readonly recordingId: string;
}

export interface SourceErrorResponse extends Tagged {
  readonly type: "source-error";
  readonly fileKey: string;
  readonly message: string;
}

/** One rendered picture: RGBA bytes, or a bitmap when the worker could make one. */
export interface RenderedPicture {
  readonly width: number;
  readonly height: number;
  readonly pixels?: Uint8ClampedArray;
  readonly bitmap?: ImageBitmap;
}

export interface ImageResponse extends Tagged {
  readonly type: "image";
  readonly requestId: string;
  readonly fileKey: string;
  readonly eventIndex: number;
  readonly rows: number;
  readonly cols: number;
  /** Column pitch over row pitch at the request's hop. */
  readonly aspect: number;
  readonly composite: RenderedPicture | null;
  /** Slot → its single-channel picture, for the slots the request asked for. */
  readonly channels: Readonly<Record<number, RenderedPicture>>;
}

export interface NoImageResponse extends Tagged {
  readonly type: "no-image";
  readonly requestId: string;
  readonly fileKey: string;
  readonly eventIndex: number;
}

export interface CancelledResponse extends Tagged {
  readonly type: "cancelled";
  readonly requestId: string;
}

export interface RenderErrorResponse extends Tagged {
  readonly type: "error";
  readonly requestId: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ClassifyProgressResponse extends Tagged {
  readonly type: "classify-progress";
  readonly requestId: string;
  readonly fileKey: string;
  readonly done: number;
  readonly total: number;
}

export interface ClassifiedResponse extends Tagged {
  readonly type: "classified";
  readonly requestId: string;
  readonly fileKey: string;
  /** Objects per event; OBJECT_CLASS_UNKNOWN (255) for an event without an image. */
  readonly objectCount: Uint8Array;
  /** Pixels in all counted objects per event. */
  readonly objectArea: Uint32Array;
  /** What the counted objects' mask measures, per event, keyed as objectCount.ts's MASK_FEATURE_KEYS. */
  readonly features: Readonly<Record<string, Float32Array>>;
}

export type CvwWorkerResponse =
  | SourceReadyResponse
  | SourceErrorResponse
  | ImageResponse
  | NoImageResponse
  | CancelledResponse
  | RenderErrorResponse
  | ClassifyProgressResponse
  | ClassifiedResponse;

export type CvwWorkerEmit = (response: CvwWorkerResponse, transfer?: readonly Transferable[]) => void;

/** The buffers a response can hand over instead of copying. */
export function responseTransferables(response: CvwWorkerResponse): Transferable[] {
  if (response.type === "source-ready") return [response.hasImage.buffer as ArrayBuffer];
  if (response.type === "classified") {
    return [response.objectCount.buffer as ArrayBuffer, response.objectArea.buffer as ArrayBuffer, ...Object.values(response.features).map((f) => f.buffer as ArrayBuffer)];
  }
  if (response.type === "image") {
    const out: Transferable[] = [];
    const take = (picture: RenderedPicture | null) => {
      if (!picture) return;
      if (picture.bitmap) out.push(picture.bitmap);
      else if (picture.pixels) out.push(picture.pixels.buffer as ArrayBuffer);
    };
    take(response.composite);
    for (const picture of Object.values(response.channels)) take(picture);
    return out;
  }
  return [];
}

export function isCvwWorkerRequest(value: unknown): value is CvwWorkerRequest {
  return typeof value === "object" && value !== null && (value as { protocol?: unknown }).protocol === CVW_WORKER_PROTOCOL;
}
