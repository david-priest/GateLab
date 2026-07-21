// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sampleDataRevisionKey,
  useSampleDataRevisionKey,
  type SampleRevisionEntry,
} from "./useSampleDataRevisions";

class RevisionStore {
  dataRevision = 0;
  private readonly listeners = new Set<() => void>();
  private beforeNextSubscription: (() => void) | null = null;

  get listenerCount(): number {
    return this.listeners.size;
  }

  beforeSubscribe(callback: () => void): void {
    this.beforeNextSubscription = callback;
  }

  subscribeDataRevision(listener: () => void): () => void {
    const before = this.beforeNextSubscription;
    this.beforeNextSubscription = null;
    before?.();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  revise(): void {
    this.dataRevision++;
    for (const listener of this.listeners) listener();
  }
}

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

describe("useSampleDataRevisionKey", () => {
  it("subscribes added and replacement samples, then unsubscribes removed instances", () => {
    const original = new RevisionStore();
    const added = new RevisionStore();
    const replacement = new RevisionStore();
    const originalOnly: SampleRevisionEntry[] = [{ id: "active", sample: original }];
    const withAdded: SampleRevisionEntry[] = [
      ...originalOnly,
      { id: "inactive", sample: added },
    ];
    const withReplacement: SampleRevisionEntry[] = [
      { id: "active", sample: replacement },
      { id: "inactive", sample: added },
    ];
    let renders = 0;

    function Probe({ entries }: { entries: SampleRevisionEntry[] }) {
      renders++;
      return <output>{useSampleDataRevisionKey(entries)}</output>;
    }

    act(() => root.render(<Probe entries={originalOnly} />));
    expect(host.textContent).toBe(sampleDataRevisionKey(originalOnly));
    expect(original.listenerCount).toBe(1);

    act(() => root.render(<Probe entries={withAdded} />));
    expect(host.textContent).toBe(sampleDataRevisionKey(withAdded));
    expect(original.listenerCount).toBe(1);
    expect(added.listenerCount).toBe(1);

    act(() => added.revise());
    expect(host.textContent).toBe('[["active",0],["inactive",1]]');

    act(() => root.render(<Probe entries={withReplacement} />));
    expect(original.listenerCount).toBe(0);
    expect(replacement.listenerCount).toBe(1);
    const afterReplacement = renders;

    act(() => original.revise());
    expect(renders).toBe(afterReplacement);
    expect(host.textContent).toBe('[["active",0],["inactive",1]]');

    act(() => replacement.revise());
    expect(host.textContent).toBe('[["active",1],["inactive",1]]');

    act(() => root.render(<Probe entries={withReplacement.slice(0, 1)} />));
    expect(added.listenerCount).toBe(0);
    const afterRemoval = renders;
    act(() => added.revise());
    expect(renders).toBe(afterRemoval);
    expect(host.textContent).toBe('[["active",1]]');
  });

  it("detects a revision committed in the render-to-subscribe gap", () => {
    const store = new RevisionStore();
    const entries: SampleRevisionEntry[] = [{ id: "sample", sample: store }];
    store.beforeSubscribe(() => store.revise());

    function Probe() {
      return <output>{useSampleDataRevisionKey(entries)}</output>;
    }

    act(() => root.render(<Probe />));

    expect(store.dataRevision).toBe(1);
    expect(store.listenerCount).toBe(1);
    expect(host.textContent).toBe('[["sample",1]]');
  });
});
