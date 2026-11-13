// FoldSummary.tsx — the heading of a <details> fold, drawn with the app's chevron in place of the
// browser's disclosure triangle, so a fold reads like a pane header or a file group's header.

import type { ReactNode } from "react";
import { ChevronIcon } from "./icons";

/** A `<summary>` for a fold. The details stays uncontrolled: the chevron turns with its `open`
 *  attribute in CSS (`.gl-fold-summary`), so clicking, Enter and Space open and close it as before.
 *  Popover summaries (`.gl-popover`, `.gl-header-notes`) keep their own button look and do not use this. */
export function FoldSummary({ children }: { children: ReactNode }) {
  return (
    <summary className="gl-fold-summary">
      <span className="gl-fold-mark" aria-hidden="true"><ChevronIcon size={12} /></span>
      {children}
    </summary>
  );
}
