// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContextualGlobalScales, type GlobalScales } from "./useContextualGlobalScales";

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

describe("useContextualGlobalScales", () => {
  it("keeps ranges per coordinate context and does not leak through an empty sample state", () => {
    let setRanges!: (ranges: GlobalScales) => void;
    let context: string | null = "original";
    let workspace = 0;
    function Harness() {
      const state = useContextualGlobalScales(context, workspace);
      setRanges = state.setGlobalScales;
      return <output>{JSON.stringify(state.globalScales)}</output>;
    }

    act(() => root.render(<Harness />));
    act(() => setRanges({ CD3: [0, 1] }));
    expect(host.textContent).toBe('{"CD3":[0,1]}');

    context = null;
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe('{"CD3":[0,1]}');

    context = "compensated";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe("{}");
    act(() => setRanges({ CD3: [-1, 2] }));

    context = "original";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe('{"CD3":[0,1]}');
    context = "compensated";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe('{"CD3":[-1,2]}');

    // Starting a fresh FCS workspace deliberately clears both active and off-context ranges,
    // even when its first sample happens to use the same common Original context string.
    context = null;
    act(() => root.render(<Harness />));
    act(() => {
      workspace++;
      context = "original";
      setRanges({});
      root.render(<Harness />);
    });
    expect(host.textContent).toBe("{}");
    context = "compensated";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe("{}");
  });

  it("accepts file-restored ranges for an explicitly armed target context", () => {
    let setRanges!: (ranges: GlobalScales) => void;
    let preserve!: (contextKey: string) => void;
    let context: string | null = "original";
    function Harness() {
      const state = useContextualGlobalScales(context);
      setRanges = state.setGlobalScales;
      preserve = state.preserveScalesForContext;
      return <output>{JSON.stringify(state.globalScales)}</output>;
    }

    act(() => root.render(<Harness />));
    act(() => setRanges({ CD3: [0, 1] }));
    act(() => {
      preserve("imported");
      setRanges({ CD19: [-2, 3] });
      context = "imported";
      root.render(<Harness />);
    });
    expect(host.textContent).toBe('{"CD19":[-2,3]}');

    context = "original";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe('{"CD3":[0,1]}');
  });

  it("discards off-context ranges when a new workspace namespace is restored", () => {
    let setRanges!: (ranges: GlobalScales) => void;
    let preserve!: (contextKey: string) => void;
    let context: string | null = "original";
    let workspace = 0;
    function Harness() {
      const state = useContextualGlobalScales(context, workspace);
      setRanges = state.setGlobalScales;
      preserve = state.preserveScalesForContext;
      return <output>{JSON.stringify(state.globalScales)}</output>;
    }

    act(() => root.render(<Harness />));
    act(() => setRanges({ CD3: [0, 1] }));
    context = "compensated";
    act(() => root.render(<Harness />));
    act(() => setRanges({ CD3: [-1, 2] }));

    act(() => {
      workspace = 1;
      context = "original";
      preserve("original");
      setRanges({ CD19: [2, 5] });
      root.render(<Harness />);
    });
    expect(host.textContent).toBe('{"CD19":[2,5]}');

    context = "compensated";
    act(() => root.render(<Harness />));
    expect(host.textContent).toBe("{}");
  });
});
