// Optional transport audit. Model identity is declared by the caller, never inferred from writer.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sha256 } from "./feedback.mjs";

export const MCP_VERSION = "0.3.0";
/**
 * Tools that run beside the queue: they read nothing a mutation could change halfway (status,
 * guide) or wait on the user rather than the tab (wait_for_change, up to 600 s). Queued, every
 * other call waited behind a pending wait_for_change until the user acted or it timed out.
 */
export const UNQUEUED_TOOLS = new Set(["gatelab_wait_for_change", "gatelab_status", "gatelab_guide"]);
export async function auditTools(tools, { path, writer, declaredModel = null } = {}) {
  const sessionId = randomUUID();
  const write = (row) => path ? appendFile(path, JSON.stringify({ sessionId, ...row }) + "\n", { mode: 0o600 }) : Promise.resolve();
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    const root = dirname(fileURLToPath(import.meta.url));
    const files = ["server.mjs", "tools.mjs", "feedback.mjs", "gating-fit.mjs", "audit.mjs", "relay.mjs", "mcp.mjs", "replay.mjs", "AGENT_SPEC.md"];
    const sources = Object.fromEntries(await Promise.all(files.map(async (name) => [name, sha256(await readFile(join(root, name), "utf8"))])));
    await write({ event: "session", at: new Date().toISOString(), mcpVersion: MCP_VERSION, writer, declaredModel, modelIdentitySource: declaredModel ? "caller-declared" : "unknown", sources });
  }
  // Serialize whole tools, including multi-request reads, so a second MCP call cannot interleave
  // a mutation or change the viewed sample midway through a feedback snapshot.
  let tail = Promise.resolve();
  return tools.map((tool) => ({ ...tool, run(args) {
    const unqueued = UNQUEUED_TOOLS.has(tool.name);
    const operation = (unqueued ? Promise.resolve() : tail).then(async () => {
      const callId = randomUUID(), start = Date.now();
      await write({ event: "request", callId, tool: tool.name, at: new Date(start).toISOString(), arguments: args });
      let result;
      try { result = await tool.run(args); }
      catch (error) { result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      // Do not store image pixels or exported membership payloads in the transport log.
      const content = result.content?.map((c) => c.type === "image" ? { type: "image", sha256: sha256(c.data) } : c);
      try { await write({ event: "response", callId, tool: tool.name, at: new Date().toISOString(), elapsedMs: Date.now() - start, result: { ...result, content } }); }
      catch (error) {
        // Apply may already have succeeded. Do not misreport it as refused and invite a duplicate.
        return { ...result, content: [...(result.content ?? []), { type: "text", text: `Audit response write failed after the tool completed: ${String(error)}. Inspect the current state before retrying any mutation.` }] };
      }
      return result;
    });
    if (!unqueued) tail = operation.catch(() => {});
    return operation;
  } }));
}
