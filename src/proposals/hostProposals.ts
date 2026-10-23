// hostProposals.ts — strategy proposals from GateLabR. R sends a proposal as a Shiny custom message
// and is told how it ended through a Shiny input, as the host bridge (host/shinySceHost.ts) talks to
// it, under names of its own, so the host contracts stay as they are. The Shiny client is the one
// GateLabR's page has when the app mounts, before the plots' stand-in takes window.Shiny
// (plots/shiny-shim.ts).
//
// R:   session$sendCustomMessage("gatelabr-strategy-proposal", list(contractVersion = 1,
//        proposalId = "p1", source = "host", by = "GateLabR", rationale = "...",
//        steps = list(list(key = "cd4", command = list(type = "createGate", ...)), ...),
//        targets = list(CD4_positive = "@cd4.population")))
// Tab: input$gatelabr_strategy_proposal_result — status "review" when it is shown, then one of
//      "accepted" (with the live ids), "rejected", "superseded" or "refused" (with the reason).

import { AgentCommandError } from "../agent/commands";
import type { StrategyApplied, StrategyProposal, StrategyProposalSource } from "./strategyProposal";

export const HOST_PROPOSAL_CONTRACT_VERSION = 1 as const;
/** R → tab: the proposal, as a Shiny custom message. */
export const HOST_PROPOSAL_MESSAGE = "gatelabr-strategy-proposal";
/** Tab → R: what became of it, as a Shiny input. */
export const HOST_PROPOSAL_RESULT_INPUT = "gatelabr_strategy_proposal_result";

/** The sources a host may name; "agent" is the relay's. */
export const HOST_PROPOSAL_SOURCES: readonly StrategyProposalSource[] = ["autogate", "host", "file"];

export interface HostStrategyProposal extends StrategyProposal {
  /** R's own name for the proposal, returned with every result. */
  proposalId: string;
}

export type HostProposalResult =
  | { proposalId: string; status: "review"; steps: number; sampleIds: string[] }
  | ({ proposalId: string; status: "accepted" } & StrategyApplied)
  | { proposalId: string; status: "rejected" | "superseded" }
  /** proposalId is null when the message did not carry a usable one. */
  | { proposalId: string | null; status: "refused"; message: string };

export interface HostProposalChannel {
  /** Called with each proposal message, those that arrived before the app listened first. */
  listen(onMessage: (message: unknown) => void): () => void;
  reply(result: HostProposalResult): void;
}

/** What the channel needs of Shiny's client. */
export interface ShinyMessaging {
  addCustomMessageHandler(type: string, handler: (message: unknown) => void): void;
  setInputValue?(name: string, value: unknown, options?: Readonly<{ priority?: "event" | "deferred" | "immediate" }>): void;
}

const refuse = (message: string): never => {
  throw new AgentCommandError(message);
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The message's proposal id, when it has one a reply can carry. */
export function hostProposalId(message: unknown): string | null {
  const id = record(message).proposalId;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
}

/**
 * A proposal message checked for its envelope; its steps and targets are checked when it is
 * replayed, as an agent's are. R's JSON writes a one-element vector as a scalar, so sampleIds may
 * arrive as one string.
 */
export function parseHostProposal(message: unknown): HostStrategyProposal {
  const m = record(message);
  if (m.contractVersion !== HOST_PROPOSAL_CONTRACT_VERSION) refuse(`Unsupported strategy proposal contract ${String(m.contractVersion)}; expected ${HOST_PROPOSAL_CONTRACT_VERSION}.`);
  const proposalId = hostProposalId(m) ?? refuse("proposalId must be a string of 1 to 128 characters.");
  const source = m.source === undefined ? "host" : m.source;
  if (typeof source !== "string" || !(HOST_PROPOSAL_SOURCES as readonly string[]).includes(source)) refuse(`source must be one of ${HOST_PROPOSAL_SOURCES.join(", ")}.`);
  const by = m.by === undefined ? "GateLabR" : typeof m.by === "string" ? m.by.trim() : "";
  if (!by || by.length > 80) refuse("by must be a name of 1 to 80 characters.");
  const rationale = typeof m.rationale === "string" ? m.rationale.trim() : "";
  if (!rationale) refuse("A rationale is required.");
  const targets = record(m.targets);
  if (m.targets !== targets || Object.values(targets).some((id) => typeof id !== "string" || !id)) refuse("targets must name each target's population id or @key.population alias.");
  const sampleIds = m.sampleIds === undefined ? undefined : typeof m.sampleIds === "string" ? [m.sampleIds] : m.sampleIds;
  if (sampleIds !== undefined && (!Array.isArray(sampleIds) || sampleIds.some((id) => typeof id !== "string" || !id))) refuse("sampleIds must be a list of sample ids.");
  return {
    proposalId, source: source as StrategyProposalSource, by, rationale, steps: m.steps,
    targets: targets as Record<string, string>, ...(sampleIds ? { sampleIds: sampleIds as string[] } : {}),
  };
}

/** The channel on GateLabR's Shiny client, or null where there is none. */
export function createShinyProposalChannel(shiny: ShinyMessaging | null | undefined = typeof window === "undefined" ? undefined : window.Shiny): HostProposalChannel | null {
  if (!shiny || typeof shiny.addCustomMessageHandler !== "function") return null;
  const waiting: unknown[] = [];
  let listener: ((message: unknown) => void) | null = null;
  // Shiny takes a handler of exactly one argument.
  shiny.addCustomMessageHandler(HOST_PROPOSAL_MESSAGE, (message) => {
    if (listener) listener(message);
    else waiting.push(message);
  });
  return {
    listen(onMessage) {
      listener = onMessage;
      for (const message of waiting.splice(0)) onMessage(message);
      return () => { if (listener === onMessage) listener = null; };
    },
    reply(result) {
      shiny.setInputValue?.(HOST_PROPOSAL_RESULT_INPUT, result, { priority: "event" });
    },
  };
}
