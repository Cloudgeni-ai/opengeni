import { useEffect, useState } from "react";
import type { Session } from "@opengeni/sdk";

export const SESSION_STARTUP_GRACE_MS = 30_000;

export type SessionStartupSource = Pick<
  Session,
  | "id"
  | "workspaceId"
  | "status"
  | "activeTurnId"
  | "effectiveControl"
  | "dispatchWait"
  | "updatedAt"
>;

export type SessionStartup = "starting" | "delayed" | "retrying" | null;

/** Presentation only: queued is durable admission, not proof of execution. */
export function sessionStartupPhase(
  session: SessionStartupSource,
  elapsedMs: number,
): SessionStartup {
  if (
    session.status !== "queued" ||
    session.activeTurnId ||
    session.effectiveControl.state !== "active"
  )
    return null;
  if (session.dispatchWait?.lastError || (session.dispatchWait?.attempts ?? 0) > 1)
    return "retrying";
  return elapsedMs >= SESSION_STARTUP_GRACE_MS ? "delayed" : "starting";
}

/** Bound the quiet phase per queued episode, including reload/reconnect.
 * Polling updatedAt must not continually restart the clock. On a fresh mount,
 * the durable timestamp can shorten (never lengthen) the local grace period.
 */
export function useSessionStartup(session: SessionStartupSource): SessionStartup {
  const eligible = sessionStartupPhase(session, 0) !== null;
  const key = `${session.workspaceId}:${session.id}:${eligible}`;
  const [clock, setClock] = useState(() => startupClock(key, session.updatedAt));
  const updatedAt =
    clock.key === `${session.workspaceId}:${session.id}:false` && eligible
      ? new Date().toISOString()
      : session.updatedAt;
  const current = clock.key === key ? clock : startupClock(key, updatedAt);
  if (clock.key !== key) setClock(current);
  useEffect(() => {
    if (!eligible) return;
    const remaining = SESSION_STARTUP_GRACE_MS - (Date.now() - current.since);
    if (remaining <= 0) {
      if (current.now - current.since < SESSION_STARTUP_GRACE_MS)
        setClock((value) => ({ ...value, now: Date.now() }));
      return;
    }
    const timer = setTimeout(() => setClock((value) => ({ ...value, now: Date.now() })), remaining);
    return () => clearTimeout(timer);
  }, [eligible, key, current.since, current.now]);
  return sessionStartupPhase(session, current.now - current.since);
}

function startupClock(key: string, updatedAt: string) {
  const now = Date.now();
  const durableTime = Date.parse(updatedAt);
  return { key, now, since: Number.isFinite(durableTime) ? Math.min(now, durableTime) : now };
}
