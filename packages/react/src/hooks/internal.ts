import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncListState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/**
 * Shared fetch + optional polling loop for the list/read hooks. Stale
 * responses (superseded by a newer load or an unmount) are dropped.
 */
export function usePolledValue<T>(load: () => Promise<T>, options: { pollIntervalMs?: number | undefined; enabled?: boolean | undefined } = {}): AsyncListState<T> {
  const enabled = options.enabled ?? true;
  const pollIntervalMs = options.pollIntervalMs;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const loadRef = useRef(load);

  // A new loader identity means a new query (different session/workspace/...):
  // drop the previous result instead of showing it as the new query's data.
  useEffect(() => {
    if (loadRef.current !== load) {
      loadRef.current = load;
      setData(null);
      setError(null);
    }
  }, [load]);

  const run = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const result = await load();
      if (ticket === generation.current) {
        setData(result);
        setError(null);
        setLoading(false);
      }
    } catch (cause) {
      if (ticket === generation.current) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setLoading(false);
      }
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void run();
    if (pollIntervalMs === undefined || pollIntervalMs <= 0) {
      return () => {
        generation.current += 1;
      };
    }
    const timer = setInterval(() => void run(), pollIntervalMs);
    return () => {
      clearInterval(timer);
      generation.current += 1;
    };
  }, [run, enabled, pollIntervalMs]);

  return { data, loading, error, refresh: run };
}
