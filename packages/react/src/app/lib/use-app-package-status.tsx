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
    // A stale response is ignored rather than aborted: the request is small,
    // and an aborted fetch shows up as a network error in diagnostics.
    let live = true;
    client.listAppPackageStatus(workspaceId).then(
      (list) => {
        if (!live) return;
        setApps(new Map((Array.isArray(list) ? list : []).map((entry) => [entry.appId, entry])));
        setLoaded(true);
      },
      () => {
        if (live) setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, generation, enabled]);
  return { apps, loaded, refresh };
}
