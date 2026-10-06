// agentLink.ts — the tab's end of the wire. It opens one WebSocket to the relay the user named,
// sends a hello, answers each request through the handler, and says "changed" when the gating
// moves. One link at a time; a dropped connection is reported, not retried, so the user always
// knows whether an agent is on the other end.

import type { AgentHandler } from "./handler";
import { AGENT_PROTOCOL_VERSION, type AgentHostInfo, type AgentMessage, type AgentRequest } from "./protocol";

export type AgentLinkStatus =
  | { state: "idle" }
  | { state: "connecting"; url: string }
  | { state: "connected"; url: string; writer: string | null; requests: number }
  | { state: "closed"; url: string; reason: string };

/** What a WebSocket needs to look like here, so a test can stand one in. */
export interface LinkSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface AgentLinkOptions {
  handler: AgentHandler;
  info: () => AgentHostInfo;
  onStatus: (status: AgentLinkStatus) => void;
  /** Makes the socket; the browser's WebSocket by default. */
  openSocket?: (url: string) => LinkSocket;
}

/** The URL a relay prints: ws:// or wss://, on this computer. */
export function parseAgentUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  return url;
}

export class AgentLink {
  #socket: LinkSocket | null = null;
  #status: AgentLinkStatus = { state: "idle" };
  #requests = 0;
  #writer: string | null = null;
  #lastRevision = -1;

  constructor(private readonly options: AgentLinkOptions) {}

  get status(): AgentLinkStatus {
    return this.#status;
  }

  get connected(): boolean {
    return this.#status.state === "connected";
  }

  connect(url: string): void {
    this.disconnect("replaced");
    const open = this.options.openSocket ?? ((target: string) => new WebSocket(target) as unknown as LinkSocket);
    let socket: LinkSocket;
    try {
      socket = open(url);
    } catch (error) {
      this.#set({ state: "closed", url, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    this.#socket = socket;
    this.#requests = 0;
    this.#writer = null;
    this.#set({ state: "connecting", url });
    socket.onopen = () => {
      this.#send({ kind: "hello", protocol: AGENT_PROTOCOL_VERSION, info: this.options.info() });
      this.#lastRevision = this.options.handler.revision();
      this.#set({ state: "connected", url, writer: null, requests: 0 });
    };
    socket.onmessage = (event) => {
      void this.#receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#set({ state: "closed", url, reason: event.reason || (event.code === 1000 ? "closed" : `closed (${event.code})`) });
    };
    socket.onerror = () => {
      // The close that follows carries the reason; nothing to do here.
    };
  }

  disconnect(reason = "disconnected"): void {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    socket.onclose = null;
    try {
      socket.close(1000, reason);
    } catch {
      // Already gone.
    }
    if (this.#status.state !== "idle") this.#set({ state: "closed", url: this.#status.url, reason });
  }

  /** Called by the app when its gating state may have moved: tells the relay the revision. */
  notifyChanged(): void {
    if (!this.#socket || this.#status.state !== "connected") return;
    const revision = this.options.handler.revision();
    if (revision === this.#lastRevision) return;
    this.#lastRevision = revision;
    this.#send({ kind: "event", event: "changed", revision });
  }

  #set(status: AgentLinkStatus): void {
    this.#status = status;
    this.options.onStatus(status);
  }

  #send(message: AgentMessage | { kind: "hello"; protocol: number; info: AgentHostInfo }): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(message));
  }

  async #receive(data: unknown): Promise<void> {
    let message: Partial<AgentMessage> & { writer?: unknown };
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    if (message.kind === "hello") {
      // The relay's own hello names the agent; its gates carry that name.
      const writer = typeof message.writer === "string" && message.writer ? message.writer : null;
      this.#writer = writer;
      this.options.handler.setWriter(writer ?? "agent");
      if (this.#status.state === "connected") this.#set({ ...this.#status, writer });
      return;
    }
    if (message.kind !== "request" || typeof message.id !== "string" || typeof message.method !== "string") return;
    const response = await this.options.handler.handle(message as AgentRequest);
    this.#requests++;
    if (this.#status.state === "connected") this.#set({ ...this.#status, writer: this.#writer, requests: this.#requests });
    this.#send(response);
    // A command moved the gating; say so without waiting for the app's next change notice.
    this.notifyChanged();
  }
}
