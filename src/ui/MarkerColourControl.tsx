// MarkerColourControl.tsx — contrast for "Colour by → Channel".
//
// Deliberately the same control as the pseudocolour DensityColourControl beside it: the same
// slider, the same readout, the same sentence structure in its tooltip. The two do the same job
// on different quantities — where the ramp's contrast sits — and a user who has learned one has
// learned the other.

import {
  MARKER_COLOR_POWER_STEP,
  MAX_MARKER_COLOR_POWER,
  MIN_MARKER_COLOR_POWER,
  normalizeMarkerColorPower,
} from "../engine/markerColour";
import { useI18n } from "./i18n";

interface Props {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}

export function MarkerColourControl({ value, onChange, disabled = false, className = "" }: Props) {
  const { t } = useI18n();
  const resolved = normalizeMarkerColorPower(value);
  return (
    <label
      className={`gl-density-colour-control${className ? ` ${className}` : ""}`}
      title="Higher values hold the bright end of the ramp back for the brightest events; lower values bring it in earlier. This changes colour mapping only — the scale on the colour bar moves with it."
    >
      <span>{t("Colour scaling")}</span>
      <input
        type="range"
        min={MIN_MARKER_COLOR_POWER}
        max={MAX_MARKER_COLOR_POWER}
        step={MARKER_COLOR_POWER_STEP}
        value={resolved}
        disabled={disabled}
        aria-label="Marker colour contrast"
        onChange={(event) => onChange(normalizeMarkerColorPower(event.currentTarget.value))}
      />
      <output>{resolved.toFixed(1)}</output>
    </label>
  );
}
