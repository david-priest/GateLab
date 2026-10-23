# GateLab agent relay

The Agent menu offers two assisted-gating goals: fit a known/user-described population, or reconstruct explicit cluster labels. The `gatelab_fit_start` → `gatelab_fit_candidate` → `gatelab_fit_finish` tools support a bounded read-only search, including multi-plot shared strategies and polygons. Cluster mode returns training feedback and makes one validation selection after closing search. Population mode records phenotype rationales without inventing reference scores. Every proposal is retained in a new local history file; applying gates and saving are separate actions. See the [agent specification](AGENT_SPEC.md#two-gating-modes-and-a-bounded-feedback-loop) for the protocol and its limits.

An MCP server that lets an agent (a Claude Code session, or anything that speaks MCP) read the gating in an open GateLab tab and propose gates, which appear in the tab at once. The tab does all the gating: the relay only carries requests to it and answers back. Works with GateLab in the browser and with GateLabR's tab alike.

## Setup, step by step

1. **Get the source on the computer the agent runs on.** The server is part of GateLab's repository; a hosted copy of the app (GitHub Pages) cannot start it for you. Node.js 22 or later is needed.

   ```bash
   git clone https://github.com/david-priest/GateLab && cd GateLab && npm install
   ```

2. **Register the server with the agent**, once. For Claude Code:

   ```bash
   claude mcp add --scope user gatelab -- node "$PWD/tools/agent-mcp/server.mjs"
   ```

   For a session that runs inside this folder, the `.mcp.json` at the repository root does the same. Any other MCP client registers `node tools/agent-mcp/server.mjs` the way it registers a stdio server. Options: `--port N` (default 48123), `--writer NAME` (the name on the gates the agent makes, default "agent"), `--token T` (otherwise a token is made once and kept in `~/.gatelab/agent-relay.json`, so the address stays the same from one session to the next).

3. **Start the agent's session.** The server starts with it, listens for a tab, and prints its address on stderr: `ws://127.0.0.1:48123/?token=…`. The same address is in `~/.gatelab/agent-relay.json`, and the agent can tell you it (`gatelab_status`).

4. **Connect the tab** (next section). The agent's first tool call then reaches your gating.

What the agent reads (counts, histograms, medians, pictures of the plot) goes to the agent's model provider; the FCS files stay on the computer. The relay accepts connections from this computer only, and only with its token.

## Connecting a tab

In GateLab, open the Agent menu in the header, choose "Connect to an agent…" and paste the address the session printed (`ws://127.0.0.1:48123/?token=…`; the `gatelab_status` tool returns it). The menu then reads "Agent · connected" and counts the requests; Disconnect cuts the agent off. A launcher can put the address on the page's URL as `?agent=<encoded address>` so the tab connects on open.

Only this computer can reach the relay (it listens on 127.0.0.1), only a tab with the token is admitted, and one tab at a time: a second connection replaces the first.

## What the agent reads

`AGENT_SPEC.md`, next to the server, is the contract an agent works from: the data model, the coordinate spaces, every command with its fields and refusals, what the user sees, the rules of good gating, and the GateLabR host. The `gatelab_guide` tool returns it, and the server's instructions tell an agent to read it before the first gate. Change the behaviour and the specification together.

## What the agent can and cannot do

Read: the files, the channels as drawn, the tree with counts per sample and pooled, every gate's coordinates, distributions and marker medians, a PNG of the plot or of the Strategy tab's grid. Show: a population on chosen channels on the Gating plot, or the Strategy tab opened on chosen populations (one population's path, or several in one grid) for the user to inspect, export or print; neither changes the gating. Change: create a rectangle, polygon, range or quadrant, edit or rename or delete a gate, rename a population, undo, redo — each with a rationale that is shown on the gate's badge in the tab. It cannot save the workspace or write to an SCE; saving is the user's, in the tab. `gatelab_export` writes the current gating and memberships to a file for another process (an R session) to read. A whole strategy at once is a strategy proposal, which the agent reads on a copy of the gating; a host such as GateLabR can send the same kind of proposal, which the user reviews and applies in the tab, and every gate records which source it came from (section 16 of `AGENT_SPEC.md`).

## Files

- `server.mjs` — the entry point: starts the relay, speaks MCP on stdin/stdout.
- `relay.mjs` — the WebSocket end the tab connects to.
- `mcp.mjs` — MCP over stdio (initialize, tools/list, tools/call), without the SDK.
- `tools.mjs` — the tools and their descriptions; keep them in step with `src/agent/commands.ts` and `src/agent/protocol.ts`.
- `AGENT_SPEC.md` — the specification `gatelab_guide` serves.
- `relay.test.mjs` — the relay with a stand-in tab, and the MCP framing.

## Context, feedback and audit

`gatelab_context` distinguishes the displayed pool from checked files and reports the assay, transforms and active ancestor chain. `gatelab_evaluate` compares cumulative memberships with an aligned local reference-mask file on explicitly selected samples. It reports prevalence, precision, recall, F1, false-positive rate, abundance bias and target losses at each ancestor, with per-sample and optional metadata-group results. It does not fit gates or turn supplied labels into biological truth. The file format and alignment limits are in sections 13–14 of `AGENT_SPEC.md`.

To retain tool requests and results locally, add `--audit /absolute/path/agent-calls.jsonl`. Optional `--model <identifier>` records a caller-declared model; the relay cannot establish which model a client actually used. The writer badge is recorded separately. The audit retains source hashes and contains tool outputs and sample metadata; store it with the experiment's approved private records. GateLab's gating engine, workspace schema and Save to SCE behaviour are unchanged.

## Deterministic hosted replay

With development dependencies installed, `node tools/agent-mcp/replay.mjs --input /absolute/input.json --out /absolute/fresh-run-directory` loads a retained hosted workspace and recomputes memberships through the real MCP tools, relay and handler. Each sample is gated under the hierarchy the workspace assigns it (per-file hierarchies and groups by sample position, as the app restores a hosted workspace). It runs in an isolated process with a random loopback relay port, writes no relay settings, exposes read tools only, and never contacts a live R object or browser. The output directory must be new.

Input format `gatelab-hosted-replay`, version 1, contains `dataset` (the descriptor defined in `src/host/datasetContract.ts`), `payloads` keyed by sample ID (`assay` channel-major float32-le and `eventIndex` uint32-le, both base64), the saved `workspace`, and `expectedMemberships` in the agent-export structure. Optional `references` contain `label`, `populationIds` and aligned `sampleMasks`; optional `groupBy` names a metadata column. The runner creates reference manifests from that same loaded input. Reference and expected masks must have their event identities independently checked before replay.

It retains an MCP audit, export, reloaded export and report with input hash, source revision/dirty state, event disagreements and reference feedback. A nonzero disagreement exits with an error after writing the report. This is a headless hosted-adapter check; browser selection/drag behaviour and GateLabR's R write-back require separate integration checks.
