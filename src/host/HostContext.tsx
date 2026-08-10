import { createContext, useContext, type PropsWithChildren } from "react";
import type { GateLabHostAdapter } from "./contracts";

const GateLabHostContext = createContext<GateLabHostAdapter | null>(null);

export interface GateLabHostProviderProps extends PropsWithChildren {
  host: GateLabHostAdapter;
}

export function GateLabHostProvider({ host, children }: GateLabHostProviderProps) {
  return (
    <GateLabHostContext.Provider value={host}>
      {children}
    </GateLabHostContext.Provider>
  );
}

export function useGateLabHost(): GateLabHostAdapter {
  const host = useContext(GateLabHostContext);
  if (!host) {
    throw new Error("GateLab must be mounted inside a GateLabHostProvider.");
  }
  return host;
}

/** Used only by direct App test harnesses; production mounts always provide a host. */
export function useOptionalGateLabHost(): GateLabHostAdapter | null {
  return useContext(GateLabHostContext);
}
