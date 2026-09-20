import { useCallback, useEffect, useRef, useState } from "react";
import { discardSearchResultsOnError, searchAccessDenied } from "./use-conversation-search";

/** One bounded read. Identity includes the client/authority and every request parameter. */
export function useSessionSearchResource<T>(
  identity: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  debounceMs = 180,
) {
  const [result, setResult] = useState<{
    identity: string;
    loader: typeof load;
    value: T | null;
    error: string | null;
    accessDenied: boolean;
  } | null>(null);
  const retryFrom = useRef<typeof result>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!enabled) {
      retryFrom.current = null;
      setPending(false);
      return;
    }
    const controller = new AbortController();
    const retained = retryFrom.current;
    retryFrom.current = null;
    const value =
      retained?.identity === identity && retained.loader === load ? retained.value : null;
    setResult({ identity, loader: load, value, error: null, accessDenied: false });
    setPending(true);
    const timer = window.setTimeout(() => {
      void Promise.resolve()
        .then(() => load(controller.signal))
        .then(
          (value) => {
            if (!active) return;
            setResult({ identity, loader: load, value, error: null, accessDenied: false });
            setPending(false);
          },
          (error: unknown) => {
            if (!active || controller.signal.aborted) return;
            // Do not expose server diagnostics or present a failed read as no matches.
            setResult({
              identity,
              loader: load,
              value: discardSearchResultsOnError(error) ? null : value,
              error: "Search could not be loaded. Try again.",
              accessDenied: searchAccessDenied(error),
            });
            setPending(false);
          },
        );
    }, debounceMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [identity, load, enabled, debounceMs, revision]);

  const current = result?.identity === identity && result.loader === load ? result : null;
  return {
    value: current?.value ?? null,
    error: current?.error ?? null,
    accessDenied: current?.accessDenied ?? false,
    loading: enabled && (pending || !current),
    retry: useCallback(() => {
      retryFrom.current = current;
      setRevision((value) => value + 1);
    }, [current]),
  };
}
