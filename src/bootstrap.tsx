import ReactDOM from "react-dom/client";
import App from "./App";
import { createBrowserHost } from "./host/browserHost";
import { GateLabHostProvider } from "./host/HostContext";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./host/contracts";
import { installNumberInputSteppers } from "./ui/numberInputSteppers";
import { I18nProvider } from "./ui/i18n";
import { setHostWording } from "./ui/hostWording";
import { createShinyProposalChannel, type HostProposalChannel } from "./proposals/hostProposals";
import "./styles.css";

export interface GateLabMountOptions {
  host?: GateLabHostAdapter;
  /**
   * Where the host's strategy proposals arrive (proposals/hostProposals.ts). An R/SCE host gets a
   * channel on GateLabR's Shiny client by default, made here, before the plots' stand-in replaces
   * window.Shiny; null for none.
   */
  proposals?: HostProposalChannel | null;
}

export interface MountedGateLab {
  readonly host: GateLabHostAdapter;
  unmount(): void;
}

/**
 * Mount the canonical GateLab React application into any host container.
 *
 * GateLab's normal web entry point uses the browser adapter. GateLabR can use
 * the same function with an R/SCE adapter rather than maintaining a second UI.
 */
export function mountGateLab(
  container: HTMLElement,
  options: GateLabMountOptions = {},
): MountedGateLab {
  const host = options.host ?? createBrowserHost();
  if (host.contractVersion !== GATELAB_HOST_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported GateLab host contract ${String(host.contractVersion)}; ` +
      `expected ${GATELAB_HOST_CONTRACT_VERSION}.`,
    );
  }
  // An SCE's samples are not files, and the app's text says so there; a GatingSet is named as
  // what it is where the text says SCE.
  setHostWording(host.kind === "r-sce" ? "samples" : "files", host.objectName);
  const proposals = options.proposals !== undefined ? options.proposals
    : host.kind === "r-sce" ? createShinyProposalChannel() : null;
  host.lifecycle?.mounted?.();
  const root = ReactDOM.createRoot(container);
  const removeNumberInputSteppers = installNumberInputSteppers();
  let mounted = true;

  // No StrictMode: its dev-only double-mount orphans the imperative D3 canvas
  // managed by cytof_plot.js, causing a brief render → blank flash.
  root.render(
    <GateLabHostProvider host={host}>
      <I18nProvider>
        <App hostProposals={proposals} />
      </I18nProvider>
    </GateLabHostProvider>,
  );

  return {
    host,
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount();
      removeNumberInputSteppers();
      host.lifecycle?.unmounted?.();
    },
  };
}
