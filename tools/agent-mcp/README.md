# GateLab agent relay

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

Read: the files, the channels as drawn, the tree with counts per sample and pooled, every gate's coordinates, distributions and marker medians, a PNG of the plot. Change: create a rectangle, polygon, range or quadrant, edit or rename or delete a gate, rename a population, undo, redo — each with a rationale that is shown on the gate's badge in the tab. It cannot save the workspace or write to an SCE; saving is the user's, in the tab. `gatelab_export` writes the current gating and memberships to a file for another process (an R session) to read.

## Files

- `server.mjs` — the entry point: starts the relay, speaks MCP on stdin/stdout.
- `relay.mjs` — the WebSocket end the tab connects to.
- `mcp.mjs` — MCP over stdio (initialize, tools/list, tools/call), without the SDK.
- `tools.mjs` — the tools and their descriptions; keep them in step with `src/agent/commands.ts` and `src/agent/protocol.ts`.
- `AGENT_SPEC.md` — the specification `gatelab_guide` serves.
- `relay.test.mjs` — the relay with a stand-in tab, and the MCP framing.
