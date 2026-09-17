// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "./NumberField";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const input = () => host.querySelector<HTMLInputElement>("input")!;
/** Typing sets the value with an input event that carries an inputType, as a keyboard does. */
const type = (text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
});
const spin = (text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (k: string) => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: k })); });

describe("NumberField", () => {
  it("keeps a typed value until Enter, then clamps and commits it once", () => {
    const commits: number[] = [];
    function Harness() {
      const [value, setValue] = useState(260);
      return <NumberField value={value} min={140} max={2000} integer onCommit={(v) => { commits.push(v); setValue(v); }} />;
    }
    act(() => root.render(<Harness />));
    act(() => input().focus());
    type("3");
    expect(commits).toEqual([]); // not 140: a value being typed is left alone
    expect(input().value).toBe("3");
    type("300");
    key("Enter");
    expect(commits).toEqual([300]);
    type("20");
    key("Enter");
    expect(commits).toEqual([300, 140]); // clamped to the minimum on commit
    expect(input().value).toBe("140");
    type("abc");
    key("Enter");
    expect(commits).toEqual([300, 140]); // not a number: the committed value is restored
    expect(input().value).toBe("140");
  });

  it("commits on leaving the field, restores on Escape, and follows the spinner at once", () => {
    const commits: number[] = [];
    function Harness() {
      return <NumberField value={57} min={0} onCommit={(v) => commits.push(v)} />;
    }
    act(() => root.render(<Harness />));
    act(() => input().focus());
    type("99");
    act(() => input().blur());
    expect(commits).toEqual([99]);
    act(() => input().focus());
    type("12");
    key("Escape");
    expect(commits).toEqual([99]);
    expect(input().value).toBe("57"); // the prop's value, since the harness did not update it
    spin("58");
    expect(commits).toEqual([99, 58]);
  });
});
