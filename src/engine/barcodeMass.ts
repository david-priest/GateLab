// barcodeMass.ts — naming a CyTOF channel by its isotope.
//
// A barcode scheme names its channels by mass ("89", "89Y", "194Pt"), while a file names them
// "89Y_CD45", "Pt194Di" or "194Pt". Both directions of that mapping live here, so the scheme
// parser, the template and the gate names all agree on what "194Pt" means.

export interface MassToken {
  mass: number;
  /** Element symbol as written, capitalised ("Pt"); null when the token carries none. */
  element: string | null;
}

const ELEMENT = "[A-Z][a-z]?";

/**
 * The isotope a channel name carries, or null. Accepts "194Pt_CD45", "194Pt", "Pt194Di",
 * "Pt194", "89Y CD45" and "CD45_89Y"; a bare number inside a marker name ("CD45") is not a mass.
 */
export function massToken(name: string): MassToken | null {
  const s = name.trim();
  let m = new RegExp(`(?:^|[^A-Za-z0-9])(\\d{2,3})(${ELEMENT})(?![a-z])`).exec(s);
  if (m) return { mass: Number(m[1]), element: m[2] };
  m = new RegExp(`(?:^|[^A-Za-z])(${ELEMENT})(\\d{2,3})(?:Di)?(?![0-9])`).exec(s);
  if (m) return { mass: Number(m[2]), element: m[1] };
  m = /^(\d{2,3})$/.exec(s);
  if (m) return { mass: Number(m[1]), element: null };
  return null;
}

/** "194Pt" for a channel named "194Pt_CD45" or "Pt194Di"; "194" when no element is known. */
export function massLabel(name: string): string | null {
  const t = massToken(name);
  if (!t) return null;
  return `${t.mass}${t.element ?? ""}`;
}

/** Whether a scheme token ("89", "89Y") names this channel. */
export function tokenMatchesChannel(token: MassToken, channelName: string): boolean {
  const c = massToken(channelName);
  if (!c || c.mass !== token.mass) return false;
  return token.element === null || c.element === null || token.element === c.element;
}

/** A DNA intercalator channel, the usual display partner for an unpaired barcode isotope. */
export function isDnaChannel(name: string): boolean {
  if (/dna|intercalat|iridium/i.test(name)) return true;
  const t = massToken(name);
  return !!t && ((t.mass === 191 || t.mass === 193) && (t.element === null || t.element === "Ir") ||
                 (t.mass === 103 && (t.element === null || t.element === "Rh")));
}
