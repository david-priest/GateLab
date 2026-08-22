// @vitest-environment jsdom
//
// Importing a Gating-ML file or FlowJo workspace into an EMPTY workspace used to open the
// "merge or replace?" dialog anyway — a choice between two identical outcomes, since there is
// no strategy to merge with or replace. The dialog must still appear the moment a real decision
// exists, which is what these pin.

import { describe, it, expect } from "vitest";
import { gatingImportNeedsDecision } from "./App";

type Pending = Parameters<typeof gatingImportNeedsDecision>[0];
type State = Parameters<typeof gatingImportNeedsDecision>[1];

const pending = (over: Partial<Pending> = {}): Pending => ({
  compensation: { requiresConfirmation: false },
  externalSpillover: null,
  ...over,
} as Pending);

const EMPTY: State = { gates: {}, populations: {}, root_population_id: null };
const ROOT_ONLY: State = {
  gates: {},
  populations: { root: { id: "root", name: "All Events" } },
  root_population_id: "root",
} as unknown as State;
const WITH_STRATEGY: State = {
  gates: { g1: {} },
  populations: { root: { id: "root" }, p1: { id: "p1" } },
  root_population_id: "root",
} as unknown as State;

describe("whether a gating import needs the user to decide", () => {
  it("does not, on a workspace with no populations at all", () => {
    expect(gatingImportNeedsDecision(pending(), EMPTY)).toBe(false);
  });

  it("does not, on a fresh workspace holding only its root — the reported case", () => {
    // A file is loaded, so a root population exists; there is still no strategy to replace.
    expect(gatingImportNeedsDecision(pending(), ROOT_ONLY)).toBe(false);
  });

  it("does, once there is a strategy that merge or replace would treat differently", () => {
    expect(gatingImportNeedsDecision(pending(), WITH_STRATEGY)).toBe(true);
  });

  it("does when compensation must be confirmed, even on an empty workspace", () => {
    // This one rewrites every fluorescence value, so it is never applied unasked.
    const p = pending({ compensation: { requiresConfirmation: true } } as Partial<Pending>);
    expect(gatingImportNeedsDecision(p, EMPTY)).toBe(true);
  });

  it("does when the file and the workspace carry different spillover matrices", () => {
    // Both are legitimate; the user picks. Skipping would silently choose for them.
    const p = pending({
      externalSpillover: { differsFromEmbedded: true },
    } as unknown as Partial<Pending>);
    expect(gatingImportNeedsDecision(p, EMPTY)).toBe(true);
  });

  it("does not when a spillover matrix is present but matches the file's", () => {
    const p = pending({
      externalSpillover: { differsFromEmbedded: false },
    } as unknown as Partial<Pending>);
    expect(gatingImportNeedsDecision(p, EMPTY)).toBe(false);
  });
});
