import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
function useStartupClock(session: SessionStartupSource | null): SessionStartup {
  // The provider remains mounted while the route/detail read is unresolved.
  const eligible = session !== null && sessionStartupPhase(session, 0) !== null;
  const key = `${session?.workspaceId}:${session?.id}:${eligible}`;
  const [clock, setClock] = useState(() => startupClock(key, session?.updatedAt ?? ""));
  const updatedAt =
    clock.key === `${session?.workspaceId}:${session?.id}:false` && eligible
      ? new Date().toISOString()
      : (session?.updatedAt ?? "");
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
  return session ? sessionStartupPhase(session, current.now - current.since) : null;
}

const StartupContext = createContext<{ key: string; phase: SessionStartup } | null>(null);

/** One clock inside the authorized shell; actor/workspace unmount clears it. */
export function SessionStartupProvider({
  session,
  children,
}: {
  session: SessionStartupSource | null;
  children: ReactNode;
}) {
  const phase = useStartupClock(session);
  return createElement(
    StartupContext.Provider,
    { value: { key: `${session?.workspaceId}:${session?.id}`, phase } },
    children,
  );
}

export function useSessionStartup(session: SessionStartupSource): SessionStartup {
  const shared = useContext(StartupContext);
  // Standalone components/previews may have no shell. Never run a second clock
  // for real header/wait consumers, including their conditional first mount.
  const local = useStartupClock(shared ? null : session);
  return shared
    ? shared.key === `${session.workspaceId}:${session.id}`
      ? shared.phase
      : null
    : local;
}

function startupClock(key: string, updatedAt: string) {
  const now = Date.now();
  const durableTime = Date.parse(updatedAt);
  return { key, now, since: Number.isFinite(durableTime) ? Math.min(now, durableTime) : now };
}
