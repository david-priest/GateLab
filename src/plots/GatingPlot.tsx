// GatingPlot.tsx — React wrapper around the reused GateLabR main plot (cytof_plot.js).
// Renders the `#cytof-plot-container` the D3 targets, loads the engine on mount, and
// owns the render lifecycle: it repaints whenever the `payload` prop changes AND when
// the container resizes (via ResizeObserver), always with force_full + a fresh seq so
// re-renders are never swallowed by the engine's staleness guard. Plot → app inputs
// (new_gate/gate_edit/…) are delivered through the shim to typed callbacks.

import { useEffect, useRef } from "react";
import { loadPlots, type CytofD3Api } from "./loadPlots";

export interface NewGate {
  gate_type: "rectangle" | "polygon" | "quadrant";
  vertices: [number, number][];
  x_channel: string;
  y_channel: string;
  label_offset?: [number, number];
}

interface Props {
  payload?: object | null;
  mode?: string;
  visible?: boolean;
  onNewGate?: (g: NewGate) => void;
  onGateEdit?: (g: { gate_id: string; vertices: [number, number][] }) => void;
  onQuadrantMove?: (e: { gate_id: string; center: [number, number] }) => void;
  onGateSelect?: (gateId: string) => void;
  onAxisLabelClick?: (e: { axis: "x" | "y"; selected: string }) => void;
  onGateLabelMove?: (e: { gate_id: string; label_offset: [number, number] }) => void;
}

let _seq = 1000;

export function GatingPlot({
  payload,
  mode = "navigate",
  visible = true,
  onNewGate,
  onGateEdit,
  onQuadrantMove,
  onGateSelect,
  onAxisLabelClick,
  onGateLabelMove,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<CytofD3Api | null>(null);
  const payloadRef = useRef<Props["payload"]>(payload);
  const modeRef = useRef(mode);
  const visibleRef = useRef(visible);
  const mountedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  payloadRef.current = payload;
  modeRef.current = mode;
  visibleRef.current = visible;

  const cancelScheduledPaint = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    frameRef.current = null;
    retryRef.current = null;
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

    api.render({ ...p, force_full: true, _plot_seq: ++_seq }, modeRef.current);

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

    const offs = [
      onNewGate && bus.on("new_gate", onNewGate as (v: unknown) => void),
      bus.on("gate_edit", (v: unknown) => {
        const e = v as { gate_id: string; vertices: [number, number][]; seq?: number };
        onGateEdit?.(e);
        // Release cytof's pending-edit latch now that the store holds the new geometry
        // (GateLab persists synchronously). Otherwise the dragged vertices stay cached in
        // cytof's _pendingEdits and silently override the store after undo / on the next
        // non-drag render — mirror app.R:4805's clearPendingEdit ack.
        apiRef.current?.clearPendingEdit(e.gate_id, e.seq as number);
      }),
      onQuadrantMove && bus.on("gate_quadrant_move", onQuadrantMove as (v: unknown) => void),
      onGateSelect && bus.on("gate_select", onGateSelect as (v: unknown) => void),
      onAxisLabelClick && bus.on("axis_label_click", onAxisLabelClick as (v: unknown) => void),
      onGateLabelMove && bus.on("gate_label_move", onGateLabelMove as (v: unknown) => void),
    ].filter(Boolean) as (() => void)[];

    // Observe the workspace (parent), not the container: cytof sizes the canvas from
    // the parent's width, and the container is now fit-content (it wouldn't resize when
    // the surrounding layout does, so the canvas would never grow past its first size).
    const ro = new ResizeObserver(() => schedulePaint());
    // Observe the parent because cytof sizes the canvas from its width. Observing the plot
    // container itself would feed the engine's own size changes back into another render.
    const parent = containerRef.current?.parentElement;
    if (parent) ro.observe(parent);

    schedulePaint();

    return () => {
      mountedRef.current = false;
      cancelScheduledPaint();
      offs.forEach((off) => off());
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint when the data changes (full render).
  useEffect(() => {
    if (payload) schedulePaint();
    else cancelScheduledPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // The gating tab stays mounted while hidden. Wake the renderer explicitly when it is
  // selected again; do not rely on an incidental click or resize to reveal the plot.
  useEffect(() => {
    if (visible) schedulePaint();
    else cancelScheduledPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Interaction-mode changes (navigate ↔ draw-rect/poly/quadrant) are light: just
  // flip the engine's mode, no re-decode of the point cloud.
  useEffect(() => {
    apiRef.current?.setMode(mode);
  }, [mode]);

  return <div id="cytof-plot-container" ref={containerRef} className="gl-plot" />;
}
