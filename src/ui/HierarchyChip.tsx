// HierarchyChip.tsx — the one device that marks a hierarchy wherever files are assigned to it:
// a round badge in the hierarchy's colour, a thin white ring inset from its edge, and the menu
// number in white at its centre. The ring is what makes it read as a badge rather than as one
// more coloured dot among the checked and active marks. The number keeps two hierarchies apart
// when their colours are close. In the narrow sample list the badge stands alone, name on hover;
// beside the menu it is followed by the name.

export interface HierarchyChipInfo {
  /** 1-based position in the hierarchy menu. */
  index: number;
  name: string;
  colour: string;
}

export function HierarchyChip({ info, compact = false, title }: { info: HierarchyChipInfo; compact?: boolean; title?: string }) {
  return (
    <span className={`gl-hierarchy-chip${compact ? " compact" : ""}`} title={title ?? info.name}>
      <span className="gl-hierarchy-chip-index" style={{ background: info.colour, boxShadow: `inset 0 0 0 1.5px ${info.colour}, inset 0 0 0 2.5px #fff` }}>
        {info.index}
      </span>
      {!compact && <span className="gl-hierarchy-chip-name" style={{ color: info.colour }}>{info.name}</span>}
    </span>
  );
}
