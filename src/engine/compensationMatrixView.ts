import type { CanonicalCompensationMatrix } from "./compensationProfile";

export interface CytofIsotopeIdentity {
  readonly element: string;
  readonly mass: number;
}

export type CytofInteractionType =
  | "self"
  | "same-element"
  | "M-1"
  | "M+1"
  | "oxide (+16)"
  | "other";

export interface DisplayCompensationMatrix {
  readonly sourceChannels: readonly string[];
  readonly receiverChannels: readonly string[];
  readonly matrix: readonly (readonly number[])[];
}

/**
 * Parse the two isotope conventions used by FCS and panel files:
 * `Cd106Di` / `Cd106` and `106Cd_CD32` / `106Cd`.
 *
 * Restricting the match to the beginning of the identity deliberately avoids
 * treating arbitrary digits in flow-fluorophore labels as isotope masses.
 */
export function parseCytofIsotope(channel: string): CytofIsotopeIdentity | null {
  const normalized = channel.trim().normalize("NFC");
  const elementFirst = normalized.match(/^([A-Z][a-z]?)(\d{2,3})(?:Di)?(?:$|[_\s(\-])/);
  if (elementFirst) {
    return { element: elementFirst[1], mass: Number(elementFirst[2]) };
  }
  const massFirst = normalized.match(/^(\d{2,3})([A-Z][a-z]?)(?:Di)?(?:$|[_\s(\-])/);
  if (massFirst) {
    return { element: massFirst[2], mass: Number(massFirst[1]) };
  }
  return null;
}

/** Stable CATALYST/plot_spill-style isotope-mass order. */
export function orderCytofChannels(channels: readonly string[]): readonly number[] {
  return channels
    .map((channel, index) => ({ channel, index, isotope: parseCytofIsotope(channel) }))
    .sort((left, right) => {
      if (left.isotope && right.isotope) {
        return left.isotope.mass - right.isotope.mass ||
          left.isotope.element.localeCompare(right.isotope.element) ||
          left.index - right.index;
      }
      if (left.isotope) return -1;
      if (right.isotope) return 1;
      return left.index - right.index;
    })
    .map(({ index }) => index);
}

/**
 * Reorder only the presentation of a canonical CyTOF matrix. The stored matrix,
 * its hash, and the NNLS solve order remain untouched.
 */
export function cytofMatrixForDisplay(
  input: CanonicalCompensationMatrix,
): DisplayCompensationMatrix {
  const sourceOrder = orderCytofChannels(input.sourceChannels);
  const receiverOrder = orderCytofChannels(input.receiverChannels);
  return {
    sourceChannels: sourceOrder.map((index) => input.sourceChannels[index]),
    receiverChannels: receiverOrder.map((index) => input.receiverChannels[index]),
    matrix: sourceOrder.map((sourceIndex) =>
      receiverOrder.map((receiverIndex) => input.matrix[sourceIndex][receiverIndex]),
    ),
  };
}

export function cytofInteractionType(
  sourceChannel: string,
  receiverChannel: string,
): CytofInteractionType {
  if (sourceChannel === receiverChannel) return "self";
  const source = parseCytofIsotope(sourceChannel);
  const receiver = parseCytofIsotope(receiverChannel);
  if (!source || !receiver) return "other";
  const delta = receiver.mass - source.mass;
  if (source.element === receiver.element) {
    if (delta === -1) return "M-1";
    if (delta === 1) return "M+1";
    return "same-element";
  }
  if (delta === -1) return "M-1";
  if (delta === 1) return "M+1";
  if (delta === 16) return "oxide (+16)";
  return "other";
}
