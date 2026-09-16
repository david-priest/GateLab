import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

export type GlobalScales = Record<string, [number, number]>;

interface ContextualGlobalScales {
  globalScales: GlobalScales;
  setGlobalScales: Dispatch<SetStateAction<GlobalScales>>;
  /** Keep ranges restored from a file when the corresponding target context next becomes active. */
  preserveScalesForContext(contextKey: string): void;
  /** Read an active or parked range map without switching the displayed context. */
  scalesForContext(contextKey: string): GlobalScales;
  /** Replace every cached context when the next workspace namespace is installed. */
  replaceScalesForNextNamespace(scalesByContext: ReadonlyMap<string, GlobalScales>): void;
}

/**
 * Retain fixed plot ranges per assay/transform context.
 *
 * Switching context must not apply old-coordinate ranges, but it also must not destroy a user's
 * settings. The most recently used range map for each context is therefore kept in memory and
 * restored when that exact context returns. The workspace persists those parked maps and installs
 * them together on restore; changing `namespaceKey` deliberately drops every context from the old
 * workspace lineage. A mode change can explicitly carry the visible frame into its target context
 * with `preserveScalesForContext` before React commits the transition.
 */
export function useContextualGlobalScales(
  contextKey: string | null,
  namespaceKey: string | number = 0,
): ContextualGlobalScales {
  const [globalScales, setGlobalScales] = useState<GlobalScales>({});
  const scalesByContextRef = useRef(new Map<string, GlobalScales>());
  const displayedContextRef = useRef<string | null>(null);
  const preserveContextRef = useRef<string | null>(null);
  const replacementRef = useRef<ReadonlyMap<string, GlobalScales> | null>(null);
  const namespaceRef = useRef(namespaceKey);

  const preserveScalesForContext = useCallback((targetContext: string) => {
    preserveContextRef.current = targetContext;
  }, []);

  const scalesForContext = useCallback((targetContext: string): GlobalScales => {
    if (displayedContextRef.current === targetContext) return globalScales;
    return scalesByContextRef.current.get(targetContext) ?? {};
  }, [globalScales]);

  const replaceScalesForNextNamespace = useCallback(
    (scalesByContext: ReadonlyMap<string, GlobalScales>) => {
      replacementRef.current = scalesByContext;
    },
    [],
  );

  useLayoutEffect(() => {
    if (!Object.is(namespaceRef.current, namespaceKey)) {
      // A context string can recur in unrelated workspaces. A workspace restore can provide all
      // of its parked per-file maps up front; otherwise keep only the just-restored active map.
      namespaceRef.current = namespaceKey;
      scalesByContextRef.current.clear();
      const replacement = replacementRef.current;
      replacementRef.current = null;
      if (replacement) {
        for (const [key, ranges] of replacement) {
          scalesByContextRef.current.set(key, ranges);
        }
      }
      displayedContextRef.current = contextKey;
      preserveContextRef.current = null;
      if (contextKey) {
        const restored = scalesByContextRef.current.get(contextKey);
        if (restored) {
          setGlobalScales(restored);
        } else {
          scalesByContextRef.current.set(contextKey, globalScales);
        }
      }
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

  return {
    globalScales,
    setGlobalScales,
    preserveScalesForContext,
    scalesForContext,
    replaceScalesForNextNamespace,
  };
}
