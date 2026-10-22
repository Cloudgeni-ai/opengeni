import { isTransientRequestError } from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState } from "react";

import { LoadingPanel, ProblemPanel } from "../components/common";
import { Button } from "../../ui/button";
import { CrossSlotDeepLinkRecovery } from "../components/cross-slot-deep-link-recovery";
import { useAppContext } from "../app-context";
import { DEFAULT_TRANSIENT_READ_RETRY, transientReadRetryStep } from "../../hooks/internal";
import {
  authorizedSessionReadWorkspaceIds,
  canonicalSessionDeepLinkTarget,
  resolveAuthorizedSessionWorkspace,
} from "../lib/session-deep-link";
import { workspaceSessionsPath } from "../lib/routes";
import { usePage } from "../lib/navigation";

export function SessionUnavailableRoute(props: { workspaceId: string; sessionId: string }) {
  const page = usePage();
  const context = useAppContext();
  const [state, setState] = useState<"resolving" | "not-found" | "error" | "transient">(
    "resolving",
  );
  // Each attempt re-runs the lookup; transient failures schedule the next one.
  const [attempt, setAttempt] = useState(0);
  const transientStreakRef = useRef<{
    key: string;
    since: number;
    attempts: number;
    surfaced: boolean;
  } | null>(null);
  const sessionWorkspaceIds = useMemo(
    () => authorizedSessionReadWorkspaceIds(context.accessContext, context.workspaces),
    [context.accessContext, context.workspaces],
  );
  const backWorkspaceId = sessionWorkspaceIds.includes(props.workspaceId)
    ? props.workspaceId
    : (sessionWorkspaceIds.find(
        (workspaceId) => workspaceId === context.accessContext.defaultWorkspaceId,
      ) ??
      sessionWorkspaceIds[0] ??
      null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const key = `${props.workspaceId}\u0000${props.sessionId}`;
    if (transientStreakRef.current?.key !== key) transientStreakRef.current = null;
    // While a transient failure is already shown, background retries keep it.
    setState((current) =>
      current === "transient" && transientStreakRef.current ? current : "resolving",
    );
    void resolveAuthorizedSessionWorkspace(
      context.client,
      context.accessContext.workspaceGrants,
      props.sessionId,
      {
        authorizedWorkspaceIds: sessionWorkspaceIds,
        excludeWorkspaceId: props.workspaceId,
      },
    ).then((resolution) => {
      if (cancelled) return;
      if (resolution.status === "resolved") {
        transientStreakRef.current = null;
        page.assign(
          canonicalSessionDeepLinkTarget(
            resolution.workspaceId,
            props.sessionId,
            new URL(page.href()),
          ),
          { replace: true },
        );
        return;
      }
      if (resolution.status === "error" && isTransientRequestError(resolution.error)) {
        // A deploy or network blip: keep looking quietly, and show the problem
        // only if it outlasts the quiet window. Keep retrying afterwards.
        const now = Date.now();
        const streak = (transientStreakRef.current ??= {
          key,
          since: now,
          attempts: 0,
          surfaced: false,
        });
        const step = transientReadRetryStep(streak, now, DEFAULT_TRANSIENT_READ_RETRY);
        if (!step.quiet) setState("transient");
        retryTimer = setTimeout(() => setAttempt((value) => value + 1), step.delayMs);
        return;
      }
      transientStreakRef.current = null;
      setState(resolution.status === "error" ? "error" : "not-found");
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    page,
    context.accessContext.workspaceGrants,
    context.client,
    sessionWorkspaceIds,
    props.sessionId,
    props.workspaceId,
    attempt,
  ]);

  if (state === "resolving") return <LoadingPanel label="Looking for this session" />;
  if (state === "transient") {
    return (
      <ProblemPanel
        title="Temporarily unavailable"
        description="Retrying automatically."
        action={
          <Button type="button" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </Button>
        }
      />
    );
  }
  const unavailable = (
    <ProblemPanel
      title={state === "error" ? "Session unavailable" : "Session not found"}
      description={
        state === "error"
          ? "We couldn't verify another authorized workspace right now. Try again in a moment."
          : "This session doesn't exist or isn't available in any workspace you can access."
      }
      action={
        backWorkspaceId ? (
          <Button asChild type="button" variant="outline">
            <a href={workspaceSessionsPath(backWorkspaceId)}>Back to sessions</a>
          </Button>
        ) : undefined
      }
    />
  );
  return state === "not-found" ? (
    <CrossSlotDeepLinkRecovery path={new URL(page.href()).pathname} fallback={unavailable} />
  ) : (
    unavailable
  );
}
