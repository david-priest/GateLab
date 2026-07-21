import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type GlobalScales = Record<string, [number, number]>;

interface ContextualGlobalScales {
  globalScales: GlobalScales;
  setGlobalScales: Dispatch<SetStateAction<GlobalScales>>;
  /** Keep ranges restored from a file when the corresponding target context next becomes active. */
  preserveScalesForContext(contextKey: string): void;
}

/**
 * Retain fixed plot ranges per assay/transform context.
 *
 * Switching context must not apply old-coordinate ranges, but it also must not destroy a user's
 * settings. The most recently used range map for each context is therefore kept in memory and
 * restored when that exact context returns. Only the active map is persisted by today's workspace
 * format; changing `namespaceKey` deliberately drops the in-memory alternatives. A file import can
 * explicitly install its own target ranges with `preserveScalesForContext` before React commits the
 * context transition.
 */
export function useContextualGlobalScales(
  contextKey: string | null,
  namespaceKey: string | number = 0,
): ContextualGlobalScales {
  const [globalScales, setGlobalScales] = useState<GlobalScales>({});
  const scalesByContextRef = useRef(new Map<string, GlobalScales>());
  const displayedContextRef = useRef<string | null>(null);
  const preserveContextRef = useRef<string | null>(null);
  const namespaceRef = useRef(namespaceKey);

  const preserveScalesForContext = useCallback((targetContext: string) => {
    preserveContextRef.current = targetContext;
  }, []);

  useLayoutEffect(() => {
    if (!Object.is(namespaceRef.current, namespaceKey)) {
      // A context string can recur in unrelated workspaces (notably Original and the legacy
      // embedded-compensation identity). Keep the just-restored active ranges, but discard every
      // off-context cache entry from the previous workspace lineage.
      namespaceRef.current = namespaceKey;
      scalesByContextRef.current.clear();
      displayedContextRef.current = contextKey;
      preserveContextRef.current = null;
      if (contextKey) scalesByContextRef.current.set(contextKey, globalScales);
      return;
    }

    const previous = displayedContextRef.current;
    if (!contextKey) {
      // Retain the last non-null context so removing the final sample cannot make the next
      // unrelated sample look like an initial mount and inherit these ranges.
      preserveContextRef.current = null;
      return;
    }

    if (previous === null || previous === contextKey) {
      displayedContextRef.current = contextKey;
      scalesByContextRef.current.set(contextKey, globalScales);
      if (preserveContextRef.current === contextKey) preserveContextRef.current = null;
      return;
    }

    displayedContextRef.current = contextKey;
    if (preserveContextRef.current === contextKey) {
      preserveContextRef.current = null;
      scalesByContextRef.current.set(contextKey, globalScales);
      return;
    }

    preserveContextRef.current = null;
    setGlobalScales(scalesByContextRef.current.get(contextKey) ?? {});
  }, [contextKey, globalScales, namespaceKey]);

  return { globalScales, setGlobalScales, preserveScalesForContext };
}
