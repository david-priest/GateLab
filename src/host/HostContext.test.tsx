// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateLabHostProvider, useGateLabHost } from "./HostContext";
import { createBrowserHost } from "./browserHost";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./contracts";

function HostProbe() {
  const host = useGateLabHost();
  return (
    <output>
      {host.kind}:{host.capabilities.compute.location}:
      {String(host.capabilities.dataSources.singleCellExperiment)}
    </output>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("GateLab host contract", () => {
  it("describes the standalone browser capabilities explicitly", () => {
    const host = createBrowserHost({
      fileSystemAccess: true,
      directoryAccess: false,
    });

    expect(host.kind).toBe("browser");
    expect(host.capabilities.dataSources).toEqual({
      fcsFiles: true,
      singleCellExperiment: false,
    });
    expect(host.capabilities.persistence.fileSystemAccess).toBe(true);
    expect(host.capabilities.persistence.directoryAccess).toBe(false);
    expect(host.capabilities.compute.location).toBe("browser");
  });

  it("injects an R/SCE host without changing the React application shell", () => {
    const rHost: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "gatelabr-shiny",
      kind: "r-sce",
      label: "GateLabR",
      capabilities: {
        dataSources: { fcsFiles: true, singleCellExperiment: true },
        dataModel: {
          multipleAssays: true,
          sampleMetadata: true,
          writeBackColumns: true,
        },
        persistence: {
          workspaceFiles: true,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
    };

    act(() => {
      root.render(
        <GateLabHostProvider host={rHost}>
          <HostProbe />
        </GateLabHostProvider>,
      );
    });

    expect(container.textContent).toBe("r-sce:host:true");
  });
});
