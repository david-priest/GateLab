// mcp.mjs — a Model Context Protocol server over stdio, the small part of it that tools need:
// initialize, ping, tools/list and tools/call as JSON-RPC 2.0, one message per line. Written here
// rather than taken from the SDK so the relay has one dependency (ws) and no build step.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * @param {{
 *   name: string; version: string; instructions?: string;
 *   tools: { name: string; description: string; inputSchema: object; run: (args: any) => Promise<ToolResult> }[];
 *   input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; log?: (line: string) => void;
 * }} options
 * @typedef {{ content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean }} ToolResult
 */
export function serveMcp(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? (() => {});
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  const send = (message) => {
    output.write(JSON.stringify(message) + "\n");
  };
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      switch (method) {
        case "initialize": {
          const asked = params?.protocolVersion;
          const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          });
          return;
        }
        case "notifications/initialized":
        case "notifications/cancelled":
        case "notifications/roots/list_changed":
          return;
        case "ping":
          if (isRequest) reply(id, {});
          return;
        case "tools/list":
          reply(id, { tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
          return;
        case "tools/call": {
          const tool = tools.get(params?.name);
          if (!tool) {
            fail(id, -32602, `Unknown tool ${String(params?.name)}.`);
            return;
          }
          let result;
          try {
            result = await tool.run(params?.arguments ?? {});
          } catch (error) {
            result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
          reply(id, result);
          return;
        }
        default:
          if (isRequest) fail(id, -32601, `Method not found: ${String(method)}`);
      }
    } catch (error) {
      log(`error handling ${String(method)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (isRequest) fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void handle(message);
    }
  });
  return { handle };
}

/** A tool result holding one JSON value, as text. */
export const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
