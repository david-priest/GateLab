// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BiexParams } from "../engine/biex";
import { BiexAxisControl, formatBiexFull, formatBiexMax, formatBiexSummary, formatBiexWidth } from "./BiexAxisControl";

// The parameters a FlowJo workspace declared on the axis that overflowed the Transforms row.
const RECORDED: BiexParams = { maxValue: 3162277.66, pos: 4.7, neg: 0.7, widthBasis: -199.5262314969, channelRange: 256, tableChannels: 4096 };

let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A drag is applied once per frame: frames are queued here and run by setRange.
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const setRange = (label: string, value: string) => act(() => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (const frame of frames.splice(0)) frame(0);
});

describe("the biex parameters in the Transforms row", () => {
  it("are formatted short, with every digit in the tooltip", () => {
    expect(formatBiexSummary(RECORDED)).toBe("4.7 \u00b7 0.7 \u00b7 \u2212199.5 \u00b7 3.16M");
    expect(formatBiexWidth(-10)).toBe("\u221210");
    expect(formatBiexMax(262144)).toBe("262K");
    expect(formatBiexMax(800)).toBe("800");
    expect(formatBiexFull(RECORDED)).toBe("pos 4.7, neg 0.7, width -199.5262314969, max 3,162,277.66");
  });

  it("put the width basis on the row and the rest behind the menu", () => {
    act(() => root.render(<BiexAxisControl axis="X" params={RECORDED} recorded={RECORDED} onChange={() => true} onReset={() => {}} />));
    const details = host.querySelector("details")!;
    // On the row, outside the menu: the width slider and its value.
    const width = host.querySelector<HTMLInputElement>('input[aria-label="X biex widthBasis"]')!;
    expect(details.contains(width)).toBe(false);
    expect(host.querySelector(".gl-biex-width")!.textContent).toBe("\u2212199.5");
    // In the menu: the other three sliders, every value, FlowJo's fixed fields and Reset.
    for (const field of ["pos", "neg", "maxValue"]) {
      expect(details.contains(host.querySelector(`input[aria-label="X biex ${field}"]`))).toBe(true);
    }
    for (const field of ["widthBasis", "pos", "neg", "maxValue"]) {
      expect(details.contains(host.querySelector(`input[aria-label="X biex ${field} value"]`))).toBe(true);
    }
    expect(details.querySelector(".gl-biex-summary")!.textContent).toBe(formatBiexSummary(RECORDED));
    expect(details.querySelector(".gl-biex-fixed")!.textContent).toBe("Length 256 \u00b7 table 4096");
    expect(details.contains(host.querySelector('button[aria-label="Reset X biex to recorded"]'))).toBe(true);
    expect(host.querySelector("summary")!.title).toContain("width -199.5262314969");
    expect(host.querySelector("summary")!.title).toContain("max 3,162,277.66");
  });

  it("adjust one parameter at a time, carrying the rest, and reset to the recorded axis", () => {
    let shown = RECORDED;
    const onChange = vi.fn((params: BiexParams) => { shown = params; return true; });
    const onReset = vi.fn(() => { shown = RECORDED; });
    const render = () => act(() => root.render(
      <BiexAxisControl axis="X" params={shown} recorded={RECORDED} onChange={onChange} onReset={onReset} />,
    ));
    render();
    const reset = () => host.querySelector<HTMLButtonElement>('button[aria-label="Reset X biex to recorded"]')!;
    expect(reset().disabled).toBe(true);

    // Width and max run over log10 of their magnitude.
    setRange("X biex widthBasis", "2");
    expect(onChange).toHaveBeenLastCalledWith({ ...RECORDED, widthBasis: -100 });
    render();
    expect(host.querySelector(".gl-biex-width")!.textContent).toBe("\u2212100");
    setRange("X biex pos", "5.2");
    expect(onChange).toHaveBeenLastCalledWith({ ...RECORDED, widthBasis: -100, pos: 5.2 });
    render();
    setRange("X biex maxValue", "5.5");
    expect(onChange).toHaveBeenLastCalledWith({ ...RECORDED, widthBasis: -100, pos: 5.2, maxValue: 316000 });
    render();
    expect(host.querySelector(".gl-biex-summary")!.textContent).toBe("5.2 \u00b7 0.7 \u00b7 \u2212100 \u00b7 316K");
    expect(host.querySelector("summary")!.className).toContain("gl-biex-adjusted");
    expect(host.querySelector("summary")!.title).toContain("Recorded: pos 4.7");

    expect(reset().disabled).toBe(false);
    act(() => reset().click());
    expect(onReset).toHaveBeenCalledTimes(1);
    render();
    expect(host.querySelector(".gl-biex-summary")!.textContent).toBe(formatBiexSummary(RECORDED));
    expect(reset().disabled).toBe(true);
  });

  it("say when a slider is held and released", () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    act(() => root.render(<BiexAxisControl axis="X" params={RECORDED} recorded={RECORDED} onChange={() => true} onReset={() => {}} onDragStart={onDragStart} onDragEnd={onDragEnd} />));
    const width = host.querySelector<HTMLInputElement>('input[aria-label="X biex widthBasis"]')!;
    act(() => width.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(onDragStart).toHaveBeenCalledTimes(1);
    act(() => width.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("take a typed value", () => {
    const onChange = vi.fn(() => true);
    act(() => root.render(<BiexAxisControl axis="Y" params={RECORDED} recorded={RECORDED} onChange={onChange} onReset={() => {}} />));
    const field = host.querySelector<HTMLInputElement>('input[aria-label="Y biex neg value"]')!;
    act(() => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "1.25");
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "1.25" }));
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...RECORDED, neg: 1.25 });
  });

  it("name the default axis, not a recording, where nothing was recorded or the recording is the default", () => {
    const DEFAULTS: BiexParams = { maxValue: 262144, pos: Math.log10(262144) - 1, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: 4096 };
    const adjusted = { ...DEFAULTS, widthBasis: -40 };
    const onReset = vi.fn();
    for (const recorded of [null, DEFAULTS]) {
      act(() => root.render(<BiexAxisControl axis="X" params={adjusted} recorded={recorded} defaults={DEFAULTS} onChange={() => true} onReset={onReset} />));
      expect(host.querySelector('button[aria-label="Reset X biex to recorded"]')).toBeNull();
      const reset = host.querySelector<HTMLButtonElement>('button[aria-label="Reset X biex to default"]')!;
      expect(reset.textContent).toBe("Reset to default");
      expect(reset.disabled).toBe(false);
      expect(reset.title).toContain("width basis estimated from its negative values");
      expect(host.querySelector("summary")!.title).toContain(`Default: ${formatBiexFull(DEFAULTS)}.`);
      expect(host.textContent + host.innerHTML).not.toMatch(/flowjo/i);
      expect(host.querySelector("summary")!.title).not.toContain("Recorded:");
    }
    // A recording other than the default keeps its own name.
    act(() => root.render(<BiexAxisControl axis="X" params={adjusted} recorded={RECORDED} defaults={DEFAULTS} onChange={() => true} onReset={onReset} />));
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Reset X biex to recorded"]')!.textContent).toBe("Reset to recorded");
  });

  it("show each entry at the summary's precision, and keep the exact value until a new one is typed", () => {
    const EXACT: BiexParams = { maxValue: 262144.0000291775, pos: Math.log10(262144) - 1, neg: 0, widthBasis: -102.53, channelRange: 256, tableChannels: 4096 };
    const onChange = vi.fn(() => true);
    act(() => root.render(<BiexAxisControl axis="X" params={EXACT} recorded={null} defaults={EXACT} onChange={onChange} onReset={() => {}} />));
    const field = (f: string) => host.querySelector<HTMLInputElement>(`input[aria-label="X biex ${f} value"]`)!;
    expect(field("pos").value).toBe("4.42");
    expect(field("neg").value).toBe("0");
    expect(field("widthBasis").value).toBe("-102.5");
    expect(field("maxValue").value).toBe("262144");
    // Focus and leave every field without typing: nothing is committed, the axis stays exact and
    // the menu is not marked adjusted.
    for (const f of ["pos", "neg", "widthBasis", "maxValue"]) {
      act(() => {
        field(f).focus();
        field(f).blur();
        for (const frame of frames.splice(0)) frame(0);
      });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector("summary")!.className).not.toContain("gl-biex-adjusted");
    // A typed value commits as typed.
    act(() => {
      field("pos").focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field("pos"), "4.5");
      field("pos").dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "4.5" }));
      field("pos").blur();
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ ...EXACT, pos: 4.5 });
  });
});
