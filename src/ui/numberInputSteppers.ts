const STEPPER_HIT_WIDTH = 23;
const STEP_UP_CLASS = "gl-number-step-up-hover";
const STEP_DOWN_CLASS = "gl-number-step-down-hover";

export type NumberStepRegion = "up" | "down";

export function numberStepRegionAt(
  input: HTMLInputElement,
  clientX: number,
  clientY: number,
): NumberStepRegion | null {
  const rect = input.getBoundingClientRect();
  const hitWidth = Math.min(STEPPER_HIT_WIDTH, rect.width / 2);
  if (
    clientX < rect.right - hitWidth || clientX > rect.right ||
    clientY < rect.top || clientY > rect.bottom
  ) return null;
  return clientY < rect.top + rect.height / 2 ? "up" : "down";
}

function setHoverRegion(input: HTMLInputElement, region: NumberStepRegion | null): void {
  input.classList.toggle(STEP_UP_CLASS, region === "up");
  input.classList.toggle(STEP_DOWN_CLASS, region === "down");
}

function applyNumberStep(input: HTMLInputElement, region: NumberStepRegion): void {
  if (input.disabled || input.readOnly) return;
  const previousValue = input.value;
  try {
    if (region === "up") input.stepUp();
    else input.stepDown();
  } catch {
    return;
  }
  if (input.value === previousValue) return;
  input.focus({ preventScroll: true });
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function installNumberInputSteppers(root: Document = document): () => void {
  let hoveredInput: HTMLInputElement | null = null;

  const clearHoveredInput = () => {
    if (!hoveredInput) return;
    setHoverRegion(hoveredInput, null);
    hoveredInput = null;
  };

  const onPointerMove = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "number" || target.disabled) {
      clearHoveredInput();
      return;
    }
    if (hoveredInput && hoveredInput !== target) clearHoveredInput();
    hoveredInput = target;
    setHoverRegion(target, numberStepRegionAt(target, event.clientX, event.clientY));
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) clearHoveredInput();
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "number") return;
    const region = numberStepRegionAt(target, event.clientX, event.clientY);
    if (!region || target.disabled || target.readOnly) return;
    event.preventDefault();
    applyNumberStep(target, region);
  };

  root.addEventListener("pointermove", onPointerMove, true);
  root.addEventListener("pointerout", onPointerOut, true);
  root.addEventListener("pointerdown", onPointerDown, true);

  return () => {
    clearHoveredInput();
    root.removeEventListener("pointermove", onPointerMove, true);
    root.removeEventListener("pointerout", onPointerOut, true);
    root.removeEventListener("pointerdown", onPointerDown, true);
  };
}
