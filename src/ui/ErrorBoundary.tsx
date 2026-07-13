// ErrorBoundary.tsx — a render-error firewall. React has no hook equivalent for
// componentDidCatch, so this is intentionally a class component. A render exception in a
// wrapped subtree (e.g. an analysis tab over a degenerate population — a NaN-only channel,
// an empty/single-event population feeding stats/contours, a zero-area quadrant) is caught
// and shown as a recoverable panel instead of unmounting the whole app to a blank page —
// closer to Shiny's per-output error isolation, where one panel erroring leaves the rest live.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Short context label for the message + console log (e.g. the tab id). */
  label?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[GateLab] ${this.props.label ?? "view"} render error:`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}
      >
        <span className="gl-error">
          ⚠ {this.props.label ? `${this.props.label}: ` : ""}something went wrong rendering this view.
        </span>
        <pre
          style={{ margin: 0, maxWidth: "100%", overflow: "auto", fontSize: 12, opacity: 0.8, whiteSpace: "pre-wrap" }}
        >
          {error.message}
        </pre>
        <button className="gl-btn-ghost" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
