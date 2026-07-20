import {
  DENSITY_COLOR_POWER_STEP,
  MAX_DENSITY_COLOR_POWER,
  MIN_DENSITY_COLOR_POWER,
  normalizeDensityColorPower,
} from "../engine/pseudocolor";

interface Props {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}

export function DensityColourControl({ value, onChange, disabled = false, className = "" }: Props) {
  const resolved = normalizeDensityColorPower(value);
  return (
    <label
      className={`gl-density-colour-control${className ? ` ${className}` : ""}`}
      title="Higher values reserve yellow and red for denser event cores; lower values bring warm colours in earlier. This changes colour mapping only."
    >
      <span>Density colour</span>
      <input
        type="range"
        min={MIN_DENSITY_COLOR_POWER}
        max={MAX_DENSITY_COLOR_POWER}
        step={DENSITY_COLOR_POWER_STEP}
        value={resolved}
        disabled={disabled}
        aria-label="Pseudocolour density contrast"
        onChange={(event) => onChange(normalizeDensityColorPower(event.currentTarget.value))}
      />
      <output>{resolved.toFixed(1)}</output>
    </label>
  );
}
