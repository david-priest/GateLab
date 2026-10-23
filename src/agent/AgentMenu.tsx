// AgentMenu.tsx — the header's way to put an agent on the other end of the gating: connect to
// the relay an agent's session printed, see that it is there and what it has done, and cut it off.

import { useEffect, useRef, useState } from "react";
import { MenuButton, type MenuEntry } from "../ui/MenuButton";
import { useI18n } from "../ui/i18n";
import { ModalEscape } from "../ui/useModalEscape";
import { parseAgentUrl, type AgentLinkStatus } from "./agentLink";
import type { AgentGatingTask } from "./protocol";

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

export function AgentMenu({ status, task, onEndSearch, onConnect, onDisconnect }: {
  status: AgentLinkStatus;
  task?: AgentGatingTask | null;
  onEndSearch?: () => void;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();
  const [dialog, setDialog] = useState(false);
  const [searchDialog, setSearchDialog] = useState(false);
  const [mode, setMode] = useState<"population" | "cluster">("population");
  const [target, setTarget] = useState("");
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
  items.push({ label: task?.status === "searching" ? t("Gating search · {count}/{budget}", { count: task.candidates, budget: task.budget }) : t("Agent-assisted gating…"), onClick: () => setSearchDialog(true) });
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
      setProblem(t("That is not a ws:// address on this computer. Copy the one the agent's session printed."));
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
      {searchDialog && <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchDialog(false); }}>
        <ModalEscape onClose={() => setSearchDialog(false)} />
        <div className="gl-modal gl-agent-dialog" role="dialog" aria-modal="true" aria-label={t("Agent-assisted gating")}>
          <div className="gl-modal-title">{t("Agent-assisted gating")}</div>
          <p>{t("Choose a goal to discuss with your connected agent. The agent proposes and revises strategies using read-only previews. Applying gates and saving remain separate review steps.")}</p>
          <label className="gl-modal-field">{t("Mode")}<select value={task?.status === "searching" ? task.mode : mode} disabled={task?.status === "searching"} onChange={(event) => setMode(event.target.value as "population" | "cluster")}>
            <option value="population">{t("Fit a known or described population")}</option>
            <option value="cluster">{t("Fit cluster labels")}</option>
          </select></label>
          {(task?.status === "searching" ? task.mode : mode) === "population"
            ? <p>{t("Population mode uses your phenotype description, marker distributions and biological reasoning. It does not report cluster concordance without reference labels.")}</p>
            : <p>{t("Cluster mode requires aligned labels and separate training and validation samples. The agent receives training precision, recall, F1 and ancestor losses. Validation selects a frozen proposal once; final test samples remain excluded.")}</p>}
          <label className="gl-modal-field">{t("Target definition")}<textarea value={task?.status === "searching" ? task.target : target} disabled={task?.status === "searching"} onChange={(event) => setTarget(event.target.value)} /></label>
          {!task || task.status !== "searching" ? <p>{t("Ask your connected agent to start this mode with the target above, an explicit sample selection, candidate budget and a new local history file. This dialog does not start a model or transfer labels automatically.")}</p> : null}
          {task && <div role="status"><p>{t("{mode} mode · {status} · {count}/{budget} candidates", { mode: task.mode, status: task.status, count: task.candidates, budget: task.budget })}</p><p>{task.target}</p><p>{task.message}</p></div>}
          <div className="gl-modal-actions">
            {task?.status !== "searching" && <button type="button" disabled={!target.trim()} onClick={() => copy(`Start a GateLab ${mode}-mode gating fit. Target: ${target.trim()}. Agree an explicit sample selection, candidate budget and new history file; preview revisions without applying gates. ${mode === "cluster" ? "Use training labels for feedback and disjoint validation samples for one final selection; exclude final test samples." : "Explain the phenotype and marker choices; do not report cluster concordance without labels."}`)}>{copied ? t("Copied") : t("Copy request for agent")}</button>}
            {task?.status === "searching" && onEndSearch && <button type="button" onClick={onEndSearch}>{t("End search")}</button>}
            <button type="button" onClick={() => setSearchDialog(false)}>{t("Close")}</button>
          </div>
        </div>
      </div>}
      {dialog && (
        <div className="gl-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(false); }}>
          <ModalEscape onClose={() => setDialog(false)} />
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
