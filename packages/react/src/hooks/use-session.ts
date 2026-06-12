import type { Session } from "@opengeni/sdk";
import { useCallback } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseSessionOptions = ClientOverride & {
  /** Re-fetch on an interval (ms). Off by default — pair with `useSessionEvents` for live status. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseSessionResult = {
  session: Session | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** Fetch one session (with optional polling). */
export function useSession(sessionId: string | null | undefined, options: UseSessionOptions = {}): UseSessionResult {
  const { client, workspaceId } = useOpenGeni(options);
  const load = useCallback(async () => {
    if (!sessionId) {
      return null;
    }
    return await client.getSession(workspaceId, sessionId);
  }, [client, workspaceId, sessionId]);
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: (options.enabled ?? true) && Boolean(sessionId),
  });
  return { session: state.data ?? null, loading: state.loading, error: state.error, refresh: state.refresh };
}
