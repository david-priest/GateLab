export function significantNumber(value: number, significantDigits: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0) || value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || absolute < 1e-8) return value.toExponential(Math.max(1, significantDigits - 1));
  const decimalPlaces = Math.min(
    10,
    Math.max(0, significantDigits - Math.floor(Math.log10(absolute)) - 1),
  );
  return value.toFixed(decimalPlaces).replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

export function percentText(value: number, zeroAsDot = false, significantDigits = 3): string {
  if (zeroAsDot && value === 0) return "·";
  const percent = value * 100;
  return `${significantNumber(percent, significantDigits)}%`;
}

export interface CompensationMatrixCellAppearance {
  readonly backgroundColor?: string;
  readonly color?: string;
}

function srgbComponent(value: number): number {
  const normalized = Math.max(0, Math.min(255, value)) / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/**
 * Heat tint and readable foreground for an off-diagonal compensation coefficient.
 * The translucent red/blue tint is composited onto GateLab's white matrix background before
 * choosing a high-contrast foreground. Very dark saturated fills deliberately prefer white even
 * when black wins the formal ratio by a small margin; dense red cells are easier to scan that way.
 */
export function compensationMatrixCellAppearance(
  value: number,
  maximumAbsoluteOffDiagonal: number,
  diagonal = false,
): CompensationMatrixCellAppearance {
  if (diagonal) return {};
  if (!Number.isFinite(value)) return { backgroundColor: "#ae3e3e", color: "#ffffff" };
  const relativeMagnitude = maximumAbsoluteOffDiagonal > 0
    ? Math.min(1, Math.abs(value) / maximumAbsoluteOffDiagonal)
    : 0;
  if (relativeMagnitude === 0) return {};
  const alpha = 0.08 + 0.82 * Math.sqrt(relativeMagnitude);
  const base = value < 0 ? [47, 128, 237] : [211, 47, 47];
  const composited = base.map((component) => 255 + (component - 255) * alpha);
  const luminance = 0.2126 * srgbComponent(composited[0])
    + 0.7152 * srgbComponent(composited[1])
    + 0.0722 * srgbComponent(composited[2]);
  return {
    backgroundColor: `rgba(${base.join(",")},${alpha})`,
    color: luminance < 0.25 ? "#ffffff" : "#26384e",
  };
}
