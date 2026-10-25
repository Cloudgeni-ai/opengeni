import {
  adminAccessDurationHours,
  type AdminAccessDuration,
} from "@opengeni/react/session-admin-access-model";
import type { OpenGeniClient, SessionAdminAccess } from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Full access for one session (named "admin access" in the API), as the web
 * header offers it: whether it is on, until when, and giving or ending it.
 * Null while loading, on servers without it, and for people who can neither
 * see it on nor give it.
 */
export type SessionFullAccess = {
  state: SessionAdminAccess;
  grant: (duration: AdminAccessDuration) => Promise<boolean>;
  revoke: () => Promise<boolean>;
};

export function useSessionFullAccess(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
): SessionFullAccess | null {
  const [state, setState] = useState<SessionAdminAccess | null>(null);
  const [reloads, setReloads] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    setState(null);
  }, [sessionId, workspaceId]);
  useEffect(() => {
    let current = true;
    client
      .getSessionAdminAccess(workspaceId, sessionId)
      .then((value) => {
        if (current) setState(value);
      })
      // Older servers, or no access to read it: nothing to show.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, reloads, sessionId, workspaceId]);

  // When the time limit is reached, read it again so the badge goes away.
  const expiresAt = state?.active ? state.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(
      () => setReloads((count) => count + 1),
      Math.min(Math.max(delay + 1_000, 0), 2_147_000_000),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const grant = useCallback(
    async (duration: AdminAccessDuration) => {
      if (busy.current) return false;
      busy.current = true;
      try {
        setState(
          await client.grantSessionAdminAccess(workspaceId, sessionId, {
            durationHours: adminAccessDurationHours(duration),
          }),
        );
        return true;
      } catch {
        return false;
      } finally {
        busy.current = false;
      }
    },
    [client, sessionId, workspaceId],
  );

  const revoke = useCallback(async () => {
    if (busy.current) return false;
    busy.current = true;
    try {
      setState(await client.revokeSessionAdminAccess(workspaceId, sessionId));
      return true;
    } catch {
      return false;
    } finally {
      busy.current = false;
    }
  }, [client, sessionId, workspaceId]);

  if (!state) return null;
  if (!state.active && !state.canGrant) return null;
  return { state, grant, revoke };
}
