// AgentMenu.tsx — the header's way to put an agent on the other end of the gating: connect to
// the relay an agent's session printed, see that it is there and what it has done, and cut it off.

import { useEffect, useRef, useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import { parseAgentUrl, type AgentLinkStatus } from "./agentLink";

export const AGENT_URL_STORAGE_KEY = "gatelab.agent.url";

/** The one-line registration of the server with Claude Code, from a clone of GateLab. */
export const REGISTER_COMMAND = "claude mcp add --scope user gatelab -- node /path/to/GateLab/tools/agent-mcp/server.mjs";

export function rememberedAgentUrl(): string {
  try {
    return localStorage.getItem(AGENT_URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberAgentUrl(url: string): void {
  try {
    localStorage.setItem(AGENT_URL_STORAGE_KEY, url);
  } catch {
    // Private windows and the like: nothing to remember into.
  }
}

export function AgentMenu({ status, onConnect, onDisconnect }: {
  status: AgentLinkStatus;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState(false);
  const [url, setUrl] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  useEffect(() => {
    if (dialog) {
      setUrl(status.state === "idle" ? rememberedAgentUrl() : status.url);
      setProblem(null);
    }
  }, [dialog, status]);
  // Focus the address field without scrolling the dialog to it, so a short window still opens on
  // the explanation and the steps rather than on the field at the bottom.
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dialog) addressRef.current?.focus({ preventScroll: true });
  }, [dialog]);

  const label =
    status.state === "connected" ? t("Agent · connected")
    : status.state === "connecting" ? t("Agent · connecting…")
    : status.state === "closed" ? t("Agent · not connected")
    : t("Agent");
  const items: MenuEntry[] = [];
  if (status.state === "connected") {
    items.push({
      label: status.writer ? t("{writer}: {count} requests", { writer: status.writer, count: status.requests }) : t("{count} requests", { count: status.requests }),
      title: status.url,
      disabled: true,
      onClick: () => {},
    });
    items.push({ label: t("Disconnect"), className: "gl-agent-disconnect", onClick: onDisconnect });
  } else if (status.state === "connecting") {
    items.push({ label: t("Connecting to {url}", { url: status.url }), disabled: true, onClick: () => {} });
    items.push({ label: t("Cancel"), className: "gl-agent-disconnect", onClick: onDisconnect });
  } else {
    if (status.state === "closed") {
      items.push({ label: t("Last connection: {reason}", { reason: status.reason }), title: status.url, disabled: true, onClick: () => {} });
      items.push({ label: t("Reconnect"), className: "gl-agent-reconnect", onClick: () => onConnect(status.url) });
    }
    items.push({ label: t("Connect to an agent…"), className: "gl-agent-connect", onClick: () => setDialog(true) });
  }

  const submit = () => {
    const parsed = parseAgentUrl(url);
    if (!parsed) {
      setProblem(t("That is not a ws:// address. Copy the one the agent's session printed."));
      return;
    }
    rememberAgentUrl(parsed.toString());
    setDialog(false);
    onConnect(parsed.toString());
  };

  return (
    <>
      <MenuButton
        label={label}
        className="gl-agent-menu"
        title={t("Let an agent on this computer read the gating and propose gates, which appear here as you work")}
        items={items}
      />
      {dialog && (
        <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(false); }}>
          <div className="gl-modal gl-agent-dialog" role="dialog" aria-modal="true" aria-label={t("Connect to an agent")}>
            <div className="gl-modal-title">{t("Connect to an agent")}</div>
            <p>{t("An agent is an AI assistant on this computer (Claude Code, or anything that speaks MCP) that reads the gating in this tab and proposes gates. They appear in the plot and the tree with a badge and the agent's reason; you adjust or undo them as any other, and saving stays yours.")}</p>
            <p className="gl-agent-setup-head">{t("Setting one up, once:")}</p>
            <ol className="gl-agent-setup">
              <li>
                {t("Get GateLab's source on this computer and install its dependencies (Node.js 22 or later). The agent's server is in tools/agent-mcp; a hosted copy of GateLab cannot start it for you.")}
                <code>git clone https://github.com/david-priest/GateLab && cd GateLab && npm install</code>
              </li>
              <li>
                {t("Register the server with the agent. For Claude Code:")}
                <code>{REGISTER_COMMAND}</code>
                <button type="button" className="gl-agent-copy" onClick={() => copy(REGISTER_COMMAND)}>{copied ? t("Copied") : t("Copy")}</button>
              </li>
              <li>{t("Start the agent's session. The server starts with it and prints its address (ws://127.0.0.1:48123/?token=…); it is also written to ~/.gatelab/agent-relay.json, and the agent can tell you it (ask it for gatelab_status).")}</li>
              <li>{t("Paste the address below. In GateLabR, launchGatingApp(sce, agent = TRUE) does this for you.")}</li>
            </ol>
            <p>{t("What the agent reads, which is counts, histograms, medians and pictures of the plot, goes to the agent's model provider; the FCS files stay on this computer. The server accepts connections from this computer only, and only with its token.")}</p>
            <p>
              <a href="https://github.com/david-priest/GateLab/blob/master/tools/agent-mcp/README.md" target="_blank" rel="noreferrer">{t("Full setup, and the manual the agent itself reads")}</a>
            </p>
            <label className="gl-modal-field">
              {t("Address")}
              <input
                type="text"
                value={url}
                ref={addressRef}
                spellCheck={false}
                placeholder="ws://127.0.0.1:48123/?token=…"
                onChange={(event) => { setUrl(event.target.value); setProblem(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              />
            </label>
            {problem && <p className="gl-agent-problem" role="alert">{problem}</p>}
            <div className="gl-modal-actions">
              <button type="button" onClick={() => setDialog(false)}>{t("Cancel")}</button>
              <button type="button" className="gl-btn-primary" onClick={submit}>{t("Connect")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
