import { useState, type ReactNode } from "react";
import { useI18n } from "./i18n";

interface Props {
  label: string;
  summary?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Compact selector panel whose checklist can be hidden without hiding its label or actions. */
export function CollapsiblePicker({
  label,
  summary,
  actions,
  children,
  className = "",
}: Readonly<Props>) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);

  return (
    <section className={`gl-collapsible-picker${className ? ` ${className}` : ""}`}>
      <div className="gl-picker-head">
        <button
          type="button"
          className="gl-picker-collapse-toggle"
          aria-expanded={expanded}
          aria-label={t(expanded ? "Hide {label}" : "Show {label}", { label })}
          title={t(expanded ? "Hide {label}" : "Show {label}", { label })}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="gl-picker-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <span className="gl-stats-opt-label">{label}</span>
          {summary === undefined ? null : <span className="gl-picker-summary">{summary}</span>}
        </button>
        {actions === undefined ? null : <div className="gl-picker-actions">{actions}</div>}
      </div>
      {expanded ? <div className="gl-picker-body">{children}</div> : null}
    </section>
  );
}
