// GatingPlot.tsx — React wrapper around the reused GateLabR main plot (cytof_plot.js).
// Renders the `#cytof-plot-container` the D3 targets, loads the engine on mount, and
// owns the render lifecycle: it repaints whenever the `payload` prop changes AND when
// the container resizes (via ResizeObserver), always with force_full + a fresh seq so
// re-renders are never swallowed by the engine's staleness guard. Plot → app inputs
// (new_gate/gate_edit/…) are delivered through the shim to typed callbacks.

import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import { loadPlots, type CytofD3Api } from "./loadPlots";
import { isNativeTextEditingTarget } from "../ui/historyShortcuts";

/** Commands App can send the renderer once it has loaded. */
export interface GatingPlotActions {
  /** The selected polygon or rectangle (or the one named) grows until each side meets a facing gate edge or the plot's edge; false when nothing changed. */
  extendSelectedGateToEdges(gateId?: string): boolean;
  /**
   * The facing edges of neighbouring gates move onto one shared line, so they touch; the gates
   * named, or every one drawn. With `focus`, only the gaps between that gate and its neighbours.
   */
  closeGateGaps(gateIds?: readonly string[], focus?: string): boolean;
}
import type { GatingFontSizes } from "../engine/workspace";

/**
 * The Gating plot's type sizes for a new workspace. Axis is 13, the size the 2D axis titles were
 * drawn at while the engine was dropping these settings (#523): 16 was the default on paper only,
 * and drawn at last it was too large (David, 2026-10-23). A workspace saved with 16 keeps it.
 * Gate labels are 14 (David, 2026-10-23); a workspace saved with 12 keeps 12.
 */
export const DEFAULT_GATING_FONT_SIZES: GatingFontSizes = {
  tick: 12,
  axis: 13,
  title: 12,
  gate: 14,
};

export interface NewGate {
  gate_type: "rectangle" | "polygon" | "ellipse" | "quadrant";
  /** For an ellipse: [centre, centre+radii] in display coords; otherwise the drawn vertices. */
  vertices: [number, number][];
  x_channel: string;
  y_channel: string;
  label_offset?: [number, number];
}

interface Props {
  payload?: object | null;
  mode?: string;
  /** Filled once the renderer is loaded, so App can drive commands that live in the renderer. */
  actions?: MutableRefObject<GatingPlotActions | null>;
  visible?: boolean;
  /** Out of the layout while another view takes the plot area (the histogram); pass `visible` false too. */
  hidden?: boolean;
  /**
   * Identity of the sample/display coordinate system represented by `payload`.
   * When supplied, plot events are ignored between a prop update and the paint
   * that makes that identity visible on the canvas.
   */
  interactionToken?: string;
  fontSizes?: GatingFontSizes;
  onNewGate?: (g: NewGate) => void;
  onGateEdit?: (g: { gate_id: string; vertices: [number, number][] }) => void;
  /** Ellipse handle drag: display-space centre and principal axes at the gate's distanceSquare. */
  onEllipseEdit?: (v: { gate_id: string; mean: [number, number]; major: number; minor: number; angle: number }) => void;
  onQuadrantMove?: (e: { gate_id: string; center: [number, number] }) => void;
  /** An arm handle of a curly quadrant was dragged to `at` (display coords). */
  onQuadrantCurl?: (e: { gate_id: string; arm: "h" | "v"; at: [number, number] }) => void;
  /** An arm handle of a spider quadrant was dropped at `at` (display coords). */
  onQuadrantArm?: (e: { gate_id: string; arm: "down" | "right" | "up" | "left"; at: [number, number] }) => void;
  onGateSelect?: (gateId: string) => void;
  onAxisLabelClick?: (e: { axis: "x" | "y"; selected: string }) => void;
  /** `quadrant` names one of a quadrant gate's four labels (0 to 3); absent for a gate label. */
  onGateLabelMove?: (e: { gate_id: string; label_offset: [number, number]; quadrant?: number }) => void;
  /** A right-click on a polygon's vertex handle (`vertex`) or on its edge (`edge`, with the point on it in display units). */
  onVertexMenu?: (e: GateVertexMenuEvent) => void;
  /** A click on a gate label's tailored tag; `client` is where the menu opens, in client pixels. */
  onTailoredTag?: (e: { gate_id: string; client: [number, number] }) => void;
  /**
   * The renderer changed the view itself -- its own pan and stretch mutate the plot's ranges
   * locally and report them here. Without this React never learns, so the next payload it
   * sends carries the range from before and the view snaps back to it.
   */
  onRangeChange?: (e: { x_range: [number, number]; y_range: [number, number] }) => void;
  /** No gate selected: a plain click on the empty plot area, or Escape, while one is. */
  onGateDeselect?: () => void;
}

/** A right-click on a polygon's vertex handle, or on its edge with the clicked point projected onto it. */
export interface GateVertexMenuEvent {
  gate_id: string;
  gate_type: string;
  /** The vertex's index, for a right-click on a handle. */
  vertex?: number;
  /** The edge's index (from this vertex to the next), for a right-click on an edge. */
  edge?: number;
  /** The clicked point on that edge, in display units in the gate's own axis order. */
  point?: [number, number];
  /** True for a right-click on the gate itself: a polygon's body, or a rectangle or an ellipse anywhere. */
  body?: boolean;
  /** With `body`: the gate's box on screen, [left, top, right, bottom] in client pixels. */
  box?: [number, number, number, number];
  /** Where the menu opens, in client pixels. */
  client: [number, number];
}

interface GateEditEvent {
  gate_id: string;
  vertices: [number, number][];
  seq?: number;
}

interface PendingGateEdit {
  vertices: [number, number][];
  seq?: number;
  /** Canvas identity that emitted these display-space vertices. */
  interactionToken?: string;
}

function sameCoordinate(a: unknown, b: number): boolean {
  if (typeof a !== "number" || !Number.isFinite(a)) return false;
  // display → gating → display is not necessarily bit-exact (notably logicle axes).
  return Math.abs(a - b) <= 1e-6 + 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The plot's cursor for the node under the pointer: the cursor the renderer gave that node or
 * its nearest ancestor inside the plot, except that a link-style hand becomes the arrow. Move
 * over a gate and its label, a resize arrow over an edge, crosshair while drawing, grab over a
 * handle; otherwise the arrow.
 */
export function plotCursorAt(target: Element | null, container: Element): string {
  for (let el: Element | null = target; el && el !== container; el = el.parentElement) {
    const own = (el as HTMLElement | SVGElement).style?.cursor;
    if (own) return own === "pointer" || own === "auto" ? "default" : own;
  }
  return "default";
}

/** Whether two payloads carry the very same field values (by reference). */
function sameFields(a: object, b: object | null | undefined): boolean {
  if (!b) return false;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

function payloadContainsEdit(payload: object, gateId: string, edit: PendingGateEdit): boolean {
  const gates = (payload as { gates?: unknown }).gates;
  if (!Array.isArray(gates)) return false;
  const gate = gates.find((item) =>
    typeof item === "object" && item !== null &&
    (item as { gate_id?: unknown }).gate_id === gateId,
  ) as { vertices?: unknown } | undefined;
  const vertices = gate?.vertices;
  if (!Array.isArray(vertices) || vertices.length !== edit.vertices.length) {
    return false;
  }
  return edit.vertices.every(([x, y], index) => {
    const vertex = vertices[index];
    return Array.isArray(vertex) && vertex.length >= 2 &&
      sameCoordinate(vertex[0], x) && sameCoordinate(vertex[1], y);
  });
}

let _seq = 1000;

export function GatingPlot({
  payload,
  mode = "navigate",
  visible = true,
  hidden = false,
  interactionToken,
  fontSizes = DEFAULT_GATING_FONT_SIZES,
  onNewGate,
  onGateEdit,
  onEllipseEdit,
  onQuadrantMove,
  onQuadrantCurl,
  onQuadrantArm,
  onGateSelect,
  onAxisLabelClick,
  onGateLabelMove,
  onRangeChange,
  actions,
  onVertexMenu,
  onTailoredTag,
  onGateDeselect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<CytofD3Api | null>(null);
  const payloadRef = useRef<Props["payload"]>(payload);
  /** The payload last drawn: a new object carrying the same fields is not drawn again. */
  const paintedPayloadRef = useRef<Props["payload"]>(null);
  const modeRef = useRef(mode);
  const visibleRef = useRef(visible);
  const mountedRef = useRef(false);
  /** The container's style as React gives it, put back after each engine render (below). */
  const styleRef = useRef<Record<string, string>>({});
  const frameRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  const pendingGateEditsRef = useRef(new Map<string, PendingGateEdit>());
  const desiredInteractionTokenRef = useRef(interactionToken);
  const paintedInteractionTokenRef = useRef<string | undefined>(undefined);
  const callbacksRef = useRef({
    onNewGate,
    onGateEdit,
    onEllipseEdit,
    onQuadrantMove,
    onQuadrantCurl,
    onQuadrantArm,
    onGateSelect,
    onAxisLabelClick,
    onGateLabelMove,
    onRangeChange,
    onVertexMenu,
    onTailoredTag,
    onGateDeselect,
  });
  payloadRef.current = payload;
  modeRef.current = mode;
  visibleRef.current = visible;
  desiredInteractionTokenRef.current = interactionToken;
  callbacksRef.current = {
    onNewGate,
    onGateEdit,
    onEllipseEdit,
    onQuadrantMove,
    onQuadrantCurl,
    onQuadrantArm,
    onGateSelect,
    onAxisLabelClick,
    onGateLabelMove,
    onRangeChange,
    onVertexMenu,
    onTailoredTag,
    onGateDeselect,
  };

  const cancelScheduledPaint = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    frameRef.current = null;
    retryRef.current = null;
  };

  const interactionIsCurrent = () => {
    const desired = desiredInteractionTokenRef.current;
    return desired === undefined || paintedInteractionTokenRef.current === desired;
  };

  const schedulePaint = (retry = false) => {
    if (!mountedRef.current || !visibleRef.current || !payloadRef.current) return;

    if (retry) {
      // A hidden or not-yet-laid-out tab can remain at zero width indefinitely. Keep one
      // low-frequency retry alive until layout is ready rather than giving up after an
      // arbitrary deadline. Tab activation and ResizeObserver also wake the scheduler.
      if (retryRef.current !== null || frameRef.current !== null) return;
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        schedulePaint();
      }, 100);
      return;
    }

    if (frameRef.current !== null) return;
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      paint();
    });
  };

  const paint = () => {
    const p = payloadRef.current;
    if (!mountedRef.current || !visibleRef.current || !p) return;
    const api = apiRef.current;
    const el = containerRef.current;
    if (!api || !el) {
      schedulePaint(true);
      return;
    }

    // The D3 engine gives the initially-empty plot container its width. Waiting for
    // `el.clientWidth` here creates a circular dependency: render never runs because the
    // container is zero-width, and it stays zero-width because render never ran. What must
    // be ready is the surrounding plot area from which the engine calculates its size.
    const host = el.parentElement;
    if (!host || host.clientWidth === 0) {
      schedulePaint(true);
      return;
    }

    // cytof_plot.js keeps freshly dragged vertices in a pending latch so a queued render
    // cannot restore stale geometry. React state commits asynchronously, so acknowledge an
    // edit only from a paint holding the corresponding committed payload. Clearing here and
    // immediately rendering that payload also makes its canonical label offset authoritative;
    // the browser cannot paint any stale deferred flush between these synchronous calls.
    // Clearing it in the gate_edit callback races the commit and causes the polygon to snap
    // back to its old coordinates.
    const targetInteractionToken = desiredInteractionTokenRef.current;
    for (const [gateId, edit] of pendingGateEditsRef.current) {
      // A latch contains display-space vertices. It must never be merged into a payload for
      // another sample/assay identity, even when that payload happens to reuse the same gate id.
      const contextChanged = edit.interactionToken !== targetInteractionToken;
      if (!contextChanged && !payloadContainsEdit(p, gateId, edit)) continue;
      api.clearPendingEdit(gateId, edit.seq);
      if (pendingGateEditsRef.current.get(gateId) === edit) {
        pendingGateEditsRef.current.delete(gateId);
      }
    }

    const paintedInteractionToken = desiredInteractionTokenRef.current;
    const renderApplied = api.render({ ...p, force_full: true, _plot_seq: ++_seq }, modeRef.current);
    // The engine sets the container's style afresh (cssText) as it lays the plot out, which drops
    // what React put there and only re-sets when a value changes: the plot's font sizes, so the
    // Fonts settings never reached the axis titles or ticks, and the hidden state. Put them back.
    const box = containerRef.current;
    if (box) for (const [key, value] of Object.entries(styleRef.current)) box.style.setProperty(key.startsWith("--") ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(value));
    if (!renderApplied) {
      // cytof_plot.js queues renders while a gate drag is active. Keep rejecting events from
      // the old canvas and retry until this wrapper itself observes a completed paint.
      schedulePaint(true);
      return;
    }
    paintedInteractionTokenRef.current = paintedInteractionToken;
    paintedPayloadRef.current = p;

    // Rendering is synchronous. If the legacy engine did not initialise a usable canvas,
    // keep the scheduler alive so a later layout pass can recover without a page refresh.
    const canvas = el.querySelector("canvas");
    if (!canvas || canvas.width === 0 || canvas.height === 0) schedulePaint(true);
  };

  // Mount once: load the engine, wire plot → app inputs, observe container size.
  useEffect(() => {
    mountedRef.current = true;
    const { CytofD3, bus } = loadPlots();
    apiRef.current = CytofD3;
    if (actions) actions.current = {
      extendSelectedGateToEdges: (gateId) => apiRef.current?.extendSelectedGateToEdges?.(gateId) ?? false,
      closeGateGaps: (gateIds, focus) => apiRef.current?.closeGateGaps?.(gateIds, focus) ?? false,
    };

    const offs = [
      bus.on("new_gate", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onNewGate?.(v as NewGate);
      }),
      bus.on("gate_vertex_menu", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onVertexMenu?.(v as GateVertexMenuEvent);
      }),
      bus.on("gate_edit", (v: unknown) => {
        const e = v as GateEditEvent;
        if (!interactionIsCurrent()) {
          pendingGateEditsRef.current.delete(e.gate_id);
          apiRef.current?.clearPendingEdit(e.gate_id, e.seq);
          return;
        }
        const handler = callbacksRef.current.onGateEdit;
        if (!handler) {
          apiRef.current?.clearPendingEdit(e.gate_id, e.seq);
          return;
        }
        pendingGateEditsRef.current.set(e.gate_id, {
          vertices: e.vertices.map(([x, y]) => [x, y]),
          seq: e.seq,
          interactionToken: paintedInteractionTokenRef.current,
        });
        handler(e);
      }),
      bus.on("ellipse_edit", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onEllipseEdit?.(
          v as { gate_id: string; mean: [number, number]; major: number; minor: number; angle: number });
      }),
      bus.on("gate_quadrant_move", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onQuadrantMove?.(v as { gate_id: string; center: [number, number] });
      }),
      bus.on("gate_quadrant_curl", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onQuadrantCurl?.(v as { gate_id: string; arm: "h" | "v"; at: [number, number] });
      }),
      bus.on("gate_quadrant_arm", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onQuadrantArm?.(v as { gate_id: string; arm: "down" | "right" | "up" | "left"; at: [number, number] });
      }),
      bus.on("gate_select", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onGateSelect?.(v as string);
      }),
      bus.on("axis_label_click", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onAxisLabelClick?.(v as { axis: "x" | "y"; selected: string });
      }),
      bus.on("gate_label_move", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onGateLabelMove?.(v as { gate_id: string; label_offset: [number, number]; quadrant?: number });
      }),
      bus.on("gate_tailored_tag", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onTailoredTag?.(v as { gate_id: string; client: [number, number] });
      }),
      bus.on("plot_range", (v: unknown) => {
        if (!interactionIsCurrent()) return;
        callbacksRef.current.onRangeChange?.(v as { x_range: [number, number]; y_range: [number, number] });
      }),
    ];

    // Observe the workspace (parent), not the container: cytof sizes the canvas from
    // the parent's width, and the container is now fit-content (it wouldn't resize when
    // the surrounding layout does, so the canvas would never grow past its first size).
    const ro = new ResizeObserver(() => schedulePaint());
    // Observe the parent because cytof sizes the canvas from its width. Observing the plot
    // container itself would feed the engine's own size changes back into another render.
    const parent = containerRef.current?.parentElement;
    if (parent) ro.observe(parent);

    // One cursor for the plot, set on this container from what is under the pointer as it
    // moves. The renderer's nodes all inherit it (styles.css), so a gate layer rebuilt under a
    // still pointer, as a click on a gate does, cannot flip it (David, 2026-10-23).
    const container = containerRef.current;
    const onPointerMove = (event: PointerEvent) => {
      if (!container) return;
      const next = plotCursorAt(event.target as Element | null, container);
      if (container.style.cursor !== next) container.style.cursor = next;
    };
    container?.addEventListener("pointermove", onPointerMove, true);
    // A plain click on the empty plot area deselects the selected gate (David, 2026-10-23). Empty
    // is the renderer's pointer overlay, under every gate, label and handle; plain is a press and
    // release a few px apart at most, so a pan drag keeps the selection; and only while
    // navigating, since a click with a draw tool places a vertex or a quadrant.
    let press: { x: number; y: number } | null = null;
    const onEmpty = (target: EventTarget | null) => target instanceof Element && target.classList.contains("cytof-overlay");
    const onPointerDown = (event: PointerEvent) => {
      press = event.button === 0 && modeRef.current === "navigate" && onEmpty(event.target) ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: PointerEvent) => {
      const from = press;
      press = null;
      if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4 || !onEmpty(event.target)) return;
      if ((payloadRef.current as { selected_gate_id?: string | null } | null)?.selected_gate_id) callbacksRef.current.onGateDeselect?.();
    };
    container?.addEventListener("pointerdown", onPointerDown, true);
    container?.addEventListener("pointerup", onPointerUp, true);

    schedulePaint();

    return () => {
      container?.removeEventListener("pointermove", onPointerMove, true);
      container?.removeEventListener("pointerdown", onPointerDown, true);
      container?.removeEventListener("pointerup", onPointerUp, true);
      mountedRef.current = false;
      cancelScheduledPaint();
      // CytofD3 is a cached singleton. Clear its pending/deferred interaction state before
      // this wrapper forgets the corresponding tokens, otherwise a later workspace remount
      // that reuses a gate id could inherit display-space vertices from this canvas.
      apiRef.current?.clear();
      pendingGateEditsRef.current.clear();
      offs.forEach((off) => off());
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint when the data changes (full render). App can hand over a new payload object whose
  // fields are all the ones already drawn (a memo re-run after a gate click, say); drawing it
  // again rebuilt every gate node a second time, under the pointer, so it is skipped.
  useEffect(() => {
    if (payload && sameFields(payload, paintedPayloadRef.current)) return;
    if (payload) schedulePaint();
    else cancelScheduledPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // A token can change while the payload object remains referentially stable. It still
  // needs a paint before events may be interpreted in the new coordinate system.
  useEffect(() => {
    if (interactionToken !== undefined) schedulePaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactionToken]);

  // Typography is CSS-driven, but a full repaint is still required because the reused D3
  // renderer measures gate labels to size their coloured backgrounds.
  useEffect(() => {
    schedulePaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSizes.tick, fontSizes.axis, fontSizes.title, fontSizes.gate]);

  // The gating tab stays mounted while hidden. Wake the renderer explicitly when it is
  // selected again; do not rely on an incidental click or resize to reveal the plot.
  useEffect(() => {
    if (visible) schedulePaint();
    else cancelScheduledPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Escape abandons a polygon being drawn, or else deselects the selected gate; Backspace or Delete
  // takes back a drawn polygon's last vertex. The listener captures, so a key spent here never
  // reaches the Gating tab's Delete for the selected gate.
  useEffect(() => {
    if (visible === false) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isNativeTextEditingTarget(event.target) || document.querySelector(".gl-modal-backdrop")) return;
      const api = apiRef.current;
      const used = event.key === "Escape"
        ? api?.cancelPolygonDraft?.()
        : event.key === "Backspace" || event.key === "Delete"
          ? api?.undoPolygonVertex?.()
          : false;
      if (used) event.preventDefault();
      // An open menu or popover takes its own Escape first, and a focused list its own (its
      // selection back to one row).
      else if (event.key === "Escape" && (payloadRef.current as { selected_gate_id?: string | null } | null)?.selected_gate_id &&
        !document.querySelector(".gl-menu-popover:not([hidden]), details.gl-popover[open]") &&
        !(event.target instanceof Element && event.target.closest(".gate-list-panel, #population_tree_container"))) {
        event.preventDefault();
        callbacksRef.current.onGateDeselect?.();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible]);

  // Interaction-mode changes (navigate ↔ draw-rect/poly/quadrant) are light: just
  // flip the engine's mode, no re-decode of the point cloud.
  useEffect(() => {
    apiRef.current?.setMode(mode);
  }, [mode]);

  const fontStyle = {
    "--gl-gating-font-tick": `${fontSizes.tick}px`,
    "--gl-gating-font-axis": `${fontSizes.axis}px`,
    "--gl-gating-font-title": `${fontSizes.title}px`,
    "--gl-gating-font-gate": `${fontSizes.gate}px`,
  } as CSSProperties;
  styleRef.current = { ...(fontStyle as Record<string, string>), ...(hidden ? { display: "none" } : {}) };

  return <div id="cytof-plot-container" ref={containerRef} className="gl-plot" style={hidden ? { ...fontStyle, display: "none" } : fontStyle} />;
}
