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
