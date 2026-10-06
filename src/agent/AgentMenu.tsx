// AgentMenu.tsx — the header's way to put an agent on the other end of the gating: connect to
// the relay an agent's session printed, see that it is there and what it has done, and cut it off.

import { useEffect, useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import { parseAgentUrl, type AgentLinkStatus } from "./agentLink";

export const AGENT_URL_STORAGE_KEY = "gatelab.agent.url";

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
  useEffect(() => {
    if (dialog) {
      setUrl(status.state === "idle" ? rememberedAgentUrl() : status.url);
      setProblem(null);
    }
  }, [dialog, status]);

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
            <p>{t("An agent's session on this computer prints an address when it starts. Paste it here. The agent then reads the gating as you see it and proposes gates, which appear in the plot and the tree with a badge; you adjust or undo them as any other. Saving stays yours.")}</p>
            <label className="gl-modal-field">
              {t("Address")}
              <input
                type="text"
                value={url}
                autoFocus
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
