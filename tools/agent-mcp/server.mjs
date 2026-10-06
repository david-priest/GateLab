#!/usr/bin/env node
// server.mjs — the GateLab agent relay as an MCP server: `node tools/agent-mcp/server.mjs`.
// Speaks MCP on stdin/stdout, listens for one GateLab tab on a local WebSocket, and keeps the
// relay's token in ~/.gatelab/agent-relay.json so the tab's remembered address stays valid from
// one session to the next. Options: --port N (default 48123), --writer NAME (the name on the
// gates, default "agent"), --token T (otherwise read from or written to the file).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serveMcp } from "./mcp.mjs";
import { DEFAULT_PORT, startRelay } from "./relay.mjs";
import { gatelabTools, INSTRUCTIONS } from "./tools.mjs";

const SETTINGS = join(homedir(), ".gatelab", "agent-relay.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg === "--writer") out.writer = argv[++i];
    else if (arg === "--token") out.token = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

async function rememberedToken() {
  try {
    const saved = JSON.parse(await readFile(SETTINGS, "utf8"));
    return typeof saved.token === "string" && saved.token ? saved.token : null;
  } catch {
    return null;
  }
}

async function remember(relay) {
  await mkdir(join(homedir(), ".gatelab"), { recursive: true });
  await writeFile(SETTINGS, JSON.stringify({ token: relay.token, port: relay.port, url: relay.url, savedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stderr.write("GateLab agent relay (MCP over stdio). Options: --port N, --writer NAME, --token T.\n");
  process.exit(0);
}
const log = (line) => process.stderr.write(`[gatelab-mcp] ${line}\n`);
const relay = await startRelay({
  port: Number.isFinite(args.port) ? args.port : DEFAULT_PORT,
  writer: args.writer ?? "agent",
  token: args.token ?? (await rememberedToken()) ?? undefined,
  log,
});
await remember(relay);
log(`listening; connect a GateLab tab to ${relay.url}`);
serveMcp({
  name: "gatelab",
  version: "0.1.0",
  instructions: INSTRUCTIONS,
  tools: gatelabTools(relay),
  log,
});
const shutdown = () => { void relay.close().finally(() => process.exit(0)); };
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
