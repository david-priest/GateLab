// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";
import { installNumberInputSteppers, numberStepRegionAt } from "./numberInputSteppers";

function setInputRect(input: HTMLInputElement): void {
  input.getBoundingClientRect = () => ({
    x: 10,
    y: 20,
    left: 10,
    right: 80,
    top: 20,
    bottom: 46,
    width: 70,
    height: 26,
    toJSON: () => ({}),
  });
}

describe("number input steppers", () => {
  let host: HTMLDivElement;
  let root: Root;
  let uninstall: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    uninstall = installNumberInputSteppers(document);
  });

  afterEach(() => {
    uninstall();
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("maps the full right gutter into separate upper and lower targets", () => {
    const input = document.createElement("input");
    input.type = "number";
    setInputRect(input);
    expect(numberStepRegionAt(input, 70, 24)).toBe("up");
    expect(numberStepRegionAt(input, 70, 42)).toBe("down");
    expect(numberStepRegionAt(input, 40, 24)).toBeNull();
  });

  it("steps a controlled React input without changing normal text-entry behavior", () => {
    function Harness() {
      const [value, setValue] = useState(1);
      return (
        <input
          aria-label="Test value"
          type="number"
          min={0}
          max={2}
          step={0.5}
          value={value}
          onChange={(event) => setValue(Number(event.currentTarget.value))}
        />
      );
    }

    act(() => root.render(<Harness />));
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    setInputRect(input);

    act(() => input.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 24,
    })));
    expect(input.value).toBe("1.5");

    act(() => input.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 42,
    })));
    expect(input.value).toBe("1");

    act(() => input.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 24,
    })));
    expect(input.value).toBe("1");
  });

  it("highlights only the hovered step target and ignores disabled inputs", () => {
    act(() => root.render(<input type="number" defaultValue={3} />));
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    setInputRect(input);

    input.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 70, clientY: 24 }));
    expect(input.classList.contains("gl-number-step-up-hover")).toBe(true);
    expect(input.classList.contains("gl-number-step-down-hover")).toBe(false);

    input.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 70, clientY: 42 }));
    expect(input.classList.contains("gl-number-step-up-hover")).toBe(false);
    expect(input.classList.contains("gl-number-step-down-hover")).toBe(true);

    input.disabled = true;
    input.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 70, clientY: 24 }));
    expect(input.classList.contains("gl-number-step-up-hover")).toBe(false);
    expect(input.classList.contains("gl-number-step-down-hover")).toBe(false);
  });
});
