import { useCallback, useEffect, useState } from "react";

/** One bounded read. Identity includes the client/authority and every request parameter. */
export function useSessionSearchResource<T>(
  identity: string,
  load: () => Promise<T>,
  enabled: boolean,
  debounceMs = 180,
) {
  const [result, setResult] = useState<{
    identity: string;
    loader: typeof load;
    value: T | null;
    error: string | null;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!enabled) {
      setPending(false);
      return;
    }
    setPending(true);
    const timer = window.setTimeout(() => {
      void load().then(
        (value) => {
          if (!active) return;
          setResult({ identity, loader: load, value, error: null });
          setPending(false);
        },
        () => {
          if (!active) return;
          // Do not expose server diagnostics or present a failed read as no matches.
          setResult({
            identity,
            loader: load,
            value: null,
            error: "Search could not be loaded. Try again.",
          });
          setPending(false);
        },
      );
    }, debounceMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [identity, load, enabled, debounceMs, revision]);

  const current = result?.identity === identity && result.loader === load ? result : null;
  return {
    value: current?.value ?? null,
    error: current?.error ?? null,
    loading: enabled && (pending || !current),
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
