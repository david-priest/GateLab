// The link over a stand-in socket: the hello, requests answered in order, the relay's name on the
// handler, "changed" events, and what the user is told at each turn.
import { describe, expect, it } from "vitest";
import { AgentLink, parseAgentUrl, type AgentLinkStatus, type LinkSocket } from "./agentLink";
import type { AgentHandler } from "./handler";

class FakeSocket implements LinkSocket {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(code = 1006, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}

function harness() {
  let revision = 1;
  const handled: string[] = [];
  let writer = "agent";
  const handler: AgentHandler = {
    revision: () => revision,
    setWriter: (name) => { writer = name; },
    handle: async (request) => {
      handled.push(request.method);
      if (request.method === "apply") revision++;
      return { kind: "response", id: request.id, result: { method: request.method, revision } };
    },
  };
  const statuses: AgentLinkStatus[] = [];
  let socket: FakeSocket | null = null;
  const link = new AgentLink({
    handler,
    info: () => ({ app: "GateLab", version: "t", host: "browser", workspaceName: "w.gatelab" }),
    onStatus: (status) => statuses.push(status),
    openSocket: (url) => (socket = new FakeSocket(url)),
  });
  return { link, handler, statuses, handled, socket: () => socket!, writer: () => writer, bump: () => revision++ };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentLink", () => {
  it("accepts only a ws URL", () => {
    expect(parseAgentUrl("ws://127.0.0.1:48123/?token=abc")?.port).toBe("48123");
    expect(parseAgentUrl("wss://127.0.0.1:48123/")?.protocol).toBe("wss:");
    expect(parseAgentUrl("http://127.0.0.1:48123/")).toBeNull();
    expect(parseAgentUrl("not a url")).toBeNull();
  });

  it("says hello on open, answers requests, takes the relay's name, and reports changes", async () => {
    const { link, statuses, handled, socket, writer, bump } = harness();
    link.connect("ws://127.0.0.1:48123/?token=t");
    expect(statuses.at(-1)).toEqual({ state: "connecting", url: "ws://127.0.0.1:48123/?token=t" });
    socket().open();
    expect(JSON.parse(socket().sent[0])).toEqual({ kind: "hello", protocol: 1, info: { app: "GateLab", version: "t", host: "browser", workspaceName: "w.gatelab" } });
    expect(statuses.at(-1)).toMatchObject({ state: "connected", writer: null, requests: 0 });
    socket().receive({ kind: "hello", writer: "claude" });
    expect(writer()).toBe("claude");
    expect(statuses.at(-1)).toMatchObject({ state: "connected", writer: "claude" });
    socket().receive({ kind: "request", id: "a", method: "describe" });
    await flush();
    expect(handled).toEqual(["describe"]);
    expect(JSON.parse(socket().sent[1])).toEqual({ kind: "response", id: "a", result: { method: "describe", revision: 1 } });
    expect(statuses.at(-1)).toMatchObject({ state: "connected", requests: 1 });
    // A command that moves the gating is followed by a changed event; a read is not.
    socket().receive({ kind: "request", id: "b", method: "apply", params: {} });
    await flush();
    expect(JSON.parse(socket().sent[2]).id).toBe("b");
    expect(JSON.parse(socket().sent[3])).toEqual({ kind: "event", event: "changed", revision: 2 });
    expect(socket().sent).toHaveLength(4);
    // The user's own edit: the app calls notifyChanged; once per revision.
    link.notifyChanged();
    expect(socket().sent).toHaveLength(4);
    bump();
    link.notifyChanged();
    link.notifyChanged();
    expect(socket().sent).toHaveLength(5);
    expect(JSON.parse(socket().sent[4])).toEqual({ kind: "event", event: "changed", revision: 3 });
    // Junk is ignored.
    socket().onmessage?.({ data: "{not json" });
    socket().receive({ kind: "request", id: 5, method: "describe" });
    await flush();
    expect(handled).toEqual(["describe", "apply"]);
  });

  it("reports a dropped connection and a disconnect by the user, and replaces a link on reconnect", () => {
    const { link, statuses, socket } = harness();
    link.connect("ws://127.0.0.1:1/");
    socket().open();
    const first = socket();
    first.drop(1006);
    expect(statuses.at(-1)).toEqual({ state: "closed", url: "ws://127.0.0.1:1/", reason: "closed (1006)" });
    expect(link.connected).toBe(false);
    link.connect("ws://127.0.0.1:2/");
    socket().open();
    expect(socket()).not.toBe(first);
    expect(link.connected).toBe(true);
    link.disconnect();
    expect(socket().closed).toEqual({ code: 1000, reason: "disconnected" });
    expect(statuses.at(-1)).toEqual({ state: "closed", url: "ws://127.0.0.1:2/", reason: "disconnected" });
    // The old socket's close, arriving late, changes nothing.
    socket().onclose?.({ code: 1000, reason: "late" });
    expect(statuses.at(-1)).toMatchObject({ reason: "disconnected" });
  });
});
