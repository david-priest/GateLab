// The GateLabR channel for strategy proposals: the envelope R must send, what a refusal says, and
// the Shiny wiring (a handler of one argument, proposals held until the app listens, results sent
// back as an event-priority input).
import { describe, expect, it, vi } from "vitest";
import {
  HOST_PROPOSAL_CONTRACT_VERSION, HOST_PROPOSAL_MESSAGE, HOST_PROPOSAL_RESULT_INPUT,
  createShinyProposalChannel, hostProposalId, parseHostProposal, type ShinyMessaging,
} from "./hostProposals";

const message = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: HOST_PROPOSAL_CONTRACT_VERSION, proposalId: "p1", source: "file", by: "GateLabR",
  rationale: "Sent from R.",
  steps: [{ key: "a", command: { type: "createGate", shape: "polygon", name: "CD4_positive", parentId: "@root", x: "CD4", y: "CD8", space: "display", vertices: [[0, 0], [1, 0], [0, 1]] } }],
  targets: { CD4_positive: "@a.population" },
  ...overrides,
});

const refusal = (value: unknown) => {
  try { parseHostProposal(value); } catch (error) { return (error as Error).message; }
  return null;
};

describe("parseHostProposal", () => {
  it("reads the envelope and leaves the steps to the replay", () => {
    const proposal = parseHostProposal(message());
    expect(proposal).toEqual({
      proposalId: "p1", source: "file", by: "GateLabR", rationale: "Sent from R.",
      steps: message().steps, targets: { CD4_positive: "@a.population" },
    });
  });

  it("takes defaults for source and writer, and one sample id written as a scalar by R's JSON", () => {
    const { source: _s, by: _b, ...rest } = message({ sampleIds: "D1" });
    void _s; void _b;
    expect(parseHostProposal(rest)).toMatchObject({ source: "host", by: "GateLabR", sampleIds: ["D1"] });
    expect(parseHostProposal(message({ sampleIds: ["D1", "D2"] })).sampleIds).toEqual(["D1", "D2"]);
  });

  it("refuses an envelope it cannot read, naming what is wrong", () => {
    expect(refusal(message({ contractVersion: 2 }))).toBe("Unsupported strategy proposal contract 2; expected 1.");
    expect(refusal(message({ proposalId: "" }))).toBe("proposalId must be a string of 1 to 128 characters.");
    expect(refusal(message({ source: "agent" }))).toBe("source must be one of host, file.");
    expect(refusal(message({ by: " " }))).toBe("by must be a name of 1 to 80 characters.");
    expect(refusal(message({ rationale: "  " }))).toBe("A rationale is required.");
    expect(refusal(message({ targets: ["@a.population"] }))).toBe("targets must name each target's population id or @key.population alias.");
    expect(refusal(message({ targets: { CD4_positive: 3 } }))).toBe("targets must name each target's population id or @key.population alias.");
    expect(refusal(message({ sampleIds: [1] }))).toBe("sampleIds must be a list of sample ids.");
    expect(refusal("not a proposal")).toBe("Unsupported strategy proposal contract undefined; expected 1.");
  });

  it("finds the proposal id to answer a refusal with, where there is one", () => {
    expect(hostProposalId(message())).toBe("p1");
    expect(hostProposalId({ proposalId: 7 })).toBeNull();
    expect(hostProposalId(null)).toBeNull();
  });
});

describe("createShinyProposalChannel", () => {
  const fakeShiny = () => {
    const handlers = new Map<string, (message: unknown) => void>();
    const inputs: [string, unknown, unknown][] = [];
    const shiny: ShinyMessaging = {
      addCustomMessageHandler: (type, handler) => { handlers.set(type, handler); },
      setInputValue: (name, value, options) => { inputs.push([name, value, options]); },
    };
    return { shiny, handlers, inputs };
  };

  it("holds proposals until the app listens, then passes each on as it arrives", () => {
    const { shiny, handlers } = fakeShiny();
    const channel = createShinyProposalChannel(shiny)!;
    const handler = handlers.get(HOST_PROPOSAL_MESSAGE)!;
    // Shiny refuses a custom message handler of any other arity.
    expect(handler).toHaveLength(1);
    handler(message({ proposalId: "early" }));
    const received = vi.fn();
    const stop = channel.listen(received);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "early" }));
    handler(message({ proposalId: "later" }));
    expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ proposalId: "later" }));
    stop();
    handler(message({ proposalId: "held" }));
    expect(received).toHaveBeenCalledTimes(2);
    const next = vi.fn();
    channel.listen(next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "held" }));
  });

  it("answers R through an event-priority input", () => {
    const { shiny, inputs } = fakeShiny();
    createShinyProposalChannel(shiny)!.reply({ proposalId: "p1", status: "rejected" });
    expect(inputs).toEqual([[HOST_PROPOSAL_RESULT_INPUT, { proposalId: "p1", status: "rejected" }, { priority: "event" }]]);
  });

  it("is absent where there is no Shiny client", () => {
    expect(createShinyProposalChannel(null)).toBeNull();
  });
});
