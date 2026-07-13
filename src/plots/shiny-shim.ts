// shiny-shim.ts — the crux of the reuse strategy.
//
// GateLabR's D3 modules (cytof_plot.js, mini_plot.js, division_plot.js,
// pop_tree_scroll.js) touch the outside world through ONLY two Shiny APIs:
//   - Shiny.addCustomMessageHandler(name, fn)  (server → plot)
//   - Shiny.setInputValue(name, value, opts)   (plot → server)
// We stub `window.Shiny` with those two methods so the ~5k lines of D3 run
// verbatim in a non-Shiny host: `send(name, payload)` invokes a registered
// handler (e.g. "updatePlot"), and `on(name, cb)` receives the plot's inputs
// (e.g. "new_gate", "gate_edit", "pop_tree_click").

type MessageHandler = (payload: any) => void;
type InputListener = (value: any) => void;

export interface PlotBus {
  /** Invoke a handler the D3 registered via addCustomMessageHandler (server → plot). */
  send(name: string, payload: unknown): void;
  /** Subscribe to a plot input emitted via setInputValue (plot → server). */
  on(name: string, cb: InputListener): () => void;
  /** True once a handler with this name has been registered by the loaded D3. */
  has(name: string): boolean;
}

let installed: PlotBus | null = null;

export function installShim(): PlotBus {
  if (installed) return installed;

  const handlers: Record<string, MessageHandler> = {};
  const listeners: Record<string, InputListener[]> = {};

  const Shiny = {
    addCustomMessageHandler(name: string, fn: MessageHandler) {
      handlers[name] = fn;
    },
    setInputValue(name: string, value: any, _opts?: unknown) {
      const ls = listeners[name];
      if (ls) for (const cb of ls) cb(value);
    },
    // Some modules feature-detect `window.Shiny` before wiring up; nothing else
    // in the reused code is used, but expose a marker so those guards pass.
    setInputValueDefined: true as const,
  };

  (window as any).Shiny = Shiny;

  installed = {
    send(name, payload) {
      const fn = handlers[name];
      if (fn) fn(payload);
      else console.warn(`[GateLab] no plot handler registered for "${name}"`);
    },
    on(name, cb) {
      (listeners[name] ||= []).push(cb);
      return () => {
        listeners[name] = (listeners[name] || []).filter((f) => f !== cb);
      };
    },
    has(name) {
      return name in handlers;
    },
  };
  return installed;
}
