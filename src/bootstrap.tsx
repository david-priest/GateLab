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
import "./styles.css";

export interface GateLabMountOptions {
  host?: GateLabHostAdapter;
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
  host.lifecycle?.mounted?.();
  const root = ReactDOM.createRoot(container);
  const removeNumberInputSteppers = installNumberInputSteppers();
  let mounted = true;

  // No StrictMode: its dev-only double-mount orphans the imperative D3 canvas
  // managed by cytof_plot.js, causing a brief render → blank flash.
  root.render(
    <GateLabHostProvider host={host}>
      <I18nProvider>
        <App />
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
