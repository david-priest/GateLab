// The gate-edge display modes, shared by the gating plot and the Strategy / Illustration grids.
//
// A gate is a straight polygon in the space it was drawn in, so it bows once an axis is shown on
// a different scale — visibly so with one linear and one arcsinh axis. Gating-ML 2.0 defines a
// polygon as straight segments between consecutive vertices in the space the dimension declares,
// which is why the vertices are authoritative and the bow is a rendering of the same gate rather
// than a different one. Rectangles and quadrants are axis-aligned and provably never bow.
export type GateEdgeMode = "straight" | "straight-bow" | "bowed";

export const GATE_EDGE_MODES: { id: GateEdgeMode; label: string; hint: string }[] = [
  { id: "straight", label: "Straight",
    hint: "Straight lines between vertices — familiar, and what FlowJo draws. On a non-linear axis this is not where a GateLab gate falls, because GateLab keeps the gate in raw space. (FlowJo has no such gap: it evaluates the straight edge it draws, so its gate moves when you change the axis scale.)" },
  { id: "straight-bow", label: "Straight + true edge",
    hint: "Straight edges to work with, plus a thin grey line showing the real boundary." },
  { id: "bowed", label: "True edge",
    hint: "The boundary the gate actually has on these axes." },
];
