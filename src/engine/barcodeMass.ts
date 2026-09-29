// barcodeMass.ts — naming a CyTOF channel by its isotope.
//
// A barcode scheme names its channels by mass ("89", "89Y", "194Pt"), while a file names them
// "89Y_CD45", "Pt194Di" or "194Pt". Both directions of that mapping live here, so the scheme
// parser, the template and the gate names all agree on what "194Pt" means.

import { metalSpellings } from "./channelMatch";

export interface MassToken {
  mass: number;
  /** Element symbol as written, capitalised ("Pt"); null when the token carries none. */
  element: string | null;
}

/**
 * The isotope a channel name or scheme token carries, or null. A name carries one where it spells a
 * metal (channelMatch.metalSpellings: an element's symbol in its own case with a mass within that
 * element's natural isotopes, either way round), the first where it spells several: "194Pt_CD45",
 * "194Pt", "Pt194Di", "Pt194", "89Y CD45" and "CD45_89Y". A scheme may also name a channel by its
 * mass alone ("89"), which carries no element. A number inside a marker name is not a mass: "CD45"
 * is not cadmium 45, and "Ki67" and "Ly108" name no element. The letters and number of any name had
 * been taken, so "Ly108" carried mass 108 and a scheme's "108" found it beside the Pd108 channel.
 */
export function massToken(name: string): MassToken | null {
  const s = name.trim();
  const metal = metalSpellings(s)[0];
  if (metal) return { mass: metal.mass, element: metal.element };
  const m = /^(\d{2,3})$/.exec(s);
  if (m) return { mass: Number(m[1]), element: null };
  return null;
}

/** "194Pt" for a channel named "194Pt_CD45" or "Pt194Di"; "194" when no element is known. */
export function massLabel(name: string): string | null {
  const t = massToken(name);
  if (!t) return null;
  return `${t.mass}${t.element ?? ""}`;
}

/**
 * The isotope GateLab took a name to carry until 2026-09 (60a69a9, and the public release 0.8.3):
 * two or three digits with one or two letters after them or, failing that, before them, whether or
 * not they spell a metal, so "Ki67" carried 67 "Ki", "B220" 220 "B" and "V450-A" 450 "V". Those
 * versions wrote a channel in a hierarchy CSV or barcode scheme by it ("67Ki", "220B", "450V"),
 * named barcode gates by its mass ("450-530+") and keyed a saved template's planes by it
 * ("530Bx450V"). It is kept to read what they wrote and to give the names they gave; a channel is
 * found by its isotope through massToken only.
 */
export function legacyMassToken(name: string): MassToken | null {
  const s = name.trim();
  let m = /(?:^|[^A-Za-z0-9])(\d{2,3})([A-Z][a-z]?)(?![a-z])/.exec(s);
  if (m) return { mass: Number(m[1]), element: m[2] };
  m = /(?:^|[^A-Za-z])([A-Z][a-z]?)(\d{2,3})(?:Di)?(?![0-9])/.exec(s);
  if (m) return { mass: Number(m[2]), element: m[1] };
  m = /^(\d{2,3})$/.exec(s);
  if (m) return { mass: Number(m[1]), element: null };
  return null;
}

/** The label legacyMassToken gives a name, as GateLab wrote it until 2026-09: "67Ki" for "Ki67", "450V" for "V450-A". */
export function legacyMassLabel(name: string): string | null {
  const t = legacyMassToken(name);
  return t ? `${t.mass}${t.element ?? ""}` : null;
}

/**
 * The label a template keys a barcode plane's channel by: the metal the channel's name spells, or,
 * where it spells none, the label GateLab gave it until 2026-09 (legacyMassLabel), so that a
 * template saved then still finds its planes; the name itself where neither gives one.
 */
export function planeLabel(name: string): string {
  return massLabel(name) ?? legacyMassLabel(name) ?? name;
}

/**
 * Whether a scheme token ("89", "89Y") names this channel: the channel's name spells a metal of the
 * token's mass, and of its element when the token gives one. A channel is found by the metal its
 * name spells only, never by a bare number in it.
 */
export function tokenMatchesChannel(token: MassToken, channelName: string): boolean {
  const c = metalSpellings(channelName.trim())[0];
  if (!c || c.mass !== token.mass) return false;
  return token.element === null || token.element === c.element;
}

/** A DNA intercalator channel, the usual display partner for an unpaired barcode isotope. */
export function isDnaChannel(name: string): boolean {
  if (/dna|intercalat|iridium/i.test(name)) return true;
  const t = massToken(name);
  return !!t && ((t.mass === 191 || t.mass === 193) && (t.element === null || t.element === "Ir") ||
                 (t.mass === 103 && (t.element === null || t.element === "Rh")));
}
