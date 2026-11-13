// ChartPlotMarks.tsx — a Plotting chart panel's marks, cut at the plot's edges by a clip path when
// typed limits set the value axis, so a box or violin crossing a limit is cut, not moved, and a
// point beyond one is not drawn. Without limits the marks are drawn as they are.

import type { ReactNode } from "react";

export interface ChartPlotMarksProps {
  /** The clip path's id, unique in the document: the chart's container id and the panel's key. */
  clipId: string;
  clip: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  children: ReactNode;
}

export function ChartPlotMarks({ clipId, clip, left, top, width, height, children }: ChartPlotMarksProps) {
  if (!clip) return <>{children}</>;
  return (
    <>
      <clipPath id={clipId}>
        <rect x={left} y={top} width={width} height={height} />
      </clipPath>
      <g className="gl-prop-plot-clip" clipPath={`url(#${clipId})`}>
        {children}
      </g>
    </>
  );
}
