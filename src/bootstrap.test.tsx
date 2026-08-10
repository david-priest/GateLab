// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./host/contracts";

vi.mock("./App", () => ({
  default: () => <main>GateLab shared shell</main>,
}));

import { mountGateLab } from "./bootstrap";

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

describe("mountGateLab", () => {
  it("mounts and cleanly disposes a supplied host adapter", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
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
      lifecycle: { mounted, unmounted },
    };

    let app: ReturnType<typeof mountGateLab>;
    act(() => {
      app = mountGateLab(container, { host });
    });
    expect(container.textContent).toContain("GateLab shared shell");
    expect(app!.host).toBe(host);
    expect(mounted).toHaveBeenCalledOnce();

    act(() => app!.unmount());
    app!.unmount();
    expect(unmounted).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  });

  it("rejects an incompatible host before mounting the application", () => {
    const host = {
      ...createMinimalHost(),
      contractVersion: 99,
    } as unknown as GateLabHostAdapter;

    expect(() => mountGateLab(container, { host })).toThrow(
      "Unsupported GateLab host contract 99; expected 1.",
    );
    expect(container.textContent).toBe("");
  });
});

function createMinimalHost(): GateLabHostAdapter {
  return {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "minimal-host",
    kind: "browser",
    label: "Minimal host",
    capabilities: {
      dataSources: { fcsFiles: true, singleCellExperiment: false },
      dataModel: {
        multipleAssays: true,
        sampleMetadata: true,
        writeBackColumns: false,
      },
      persistence: {
        workspaceFiles: true,
        hostObject: false,
        fileSystemAccess: false,
        directoryAccess: false,
      },
      compute: { location: "browser" },
    },
  };
}
