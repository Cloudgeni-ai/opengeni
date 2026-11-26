import type { AppPackageStatus } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

type StatusClient = {
  listAppPackageStatus?: (
    workspaceId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<AppPackageStatus[]>;
};

// Every open view refreshes after an install, upgrade or restore anywhere.
const listeners = new Set<() => void>();

/** Tells open views that an app's package state changed. */
export function invalidateAppPackageStatus() {
  for (const listener of listeners) listener();
}

/**
 * Installed apps' package state by app id: version, Customized, Skills,
 * automations, a previous version and any ready-made update. Empty while
 * loading, on failure, or with an embed's older client.
 */
export function useAppPackageStatus(client: StatusClient, workspaceId: string, enabled = true) {
  const [apps, setApps] = useState<ReadonlyMap<string, AppPackageStatus>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (!enabled || typeof client.listAppPackageStatus !== "function") {
      setLoaded(true);
      return;
    }
    const abort = new AbortController();
    client.listAppPackageStatus(workspaceId, { signal: abort.signal }).then(
      (list) => {
        if (abort.signal.aborted) return;
        setApps(new Map((Array.isArray(list) ? list : []).map((entry) => [entry.appId, entry])));
        setLoaded(true);
      },
      () => {
        if (!abort.signal.aborted) setLoaded(true);
      },
    );
    return () => abort.abort();
  }, [client, workspaceId, generation, enabled]);
  return { apps, loaded, refresh };
}
