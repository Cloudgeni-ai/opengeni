import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { GetStartedStatusIcon } from "@/components/onboarding/get-started-status";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import { isAppCreatedSession } from "@/lib/coding-agent-setup";

const FIRST_API_SESSION_POLL_MS = 4_000;

export type FirstApiSession =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "found"; sessionId: string }
  | { status: "error" };

/**
 * Polls the shared workspace for a chat an app created (with its API key, or
 * as one of its users), until one exists.
 */
export function useFirstApiSession(
  workspaceId: string | null,
  watch: boolean,
  onFound: () => void,
): FirstApiSession {
  const { client } = useAppContext();
  const [state, setState] = useState<FirstApiSession>({ status: "idle" });
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const sessions = await client.listSessions(workspaceId, { limit: 25 });
        if (!active) return;
        const found = sessions.find(isAppCreatedSession);
        if (found) {
          setState({ status: "found", sessionId: found.id });
          if (watch) {
            onFoundRef.current();
            captureAnalyticsEvent("first_api_session_created", {
              workspace_id: workspaceId,
              session_id: found.id,
              $insert_id: `first_api_session_created:${workspaceId}`,
            });
          }
          return;
        }
        setState({ status: "waiting" });
      } catch {
        if (active) setState({ status: "error" });
      }
      if (active && watch && document.visibilityState !== "hidden")
        timer = setTimeout(() => void check(), FIRST_API_SESSION_POLL_MS);
      else if (active && watch)
        timer = setTimeout(() => void check(), FIRST_API_SESSION_POLL_MS * 4);
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, watch, workspaceId]);
  return state;
}

export function FirstApiSessionStatus({
  state,
  done,
  workspaceId,
  workspaceName,
}: {
  state: FirstApiSession;
  done: boolean;
  workspaceId: string;
  workspaceName: string;
}) {
  return (
    <div className="mt-3 min-h-5 text-sm" aria-live="polite">
      {state.status === "found" ? (
        <p className="flex items-start gap-2 text-fg">
          <GetStartedStatusIcon done className="mt-0.5" />
          <span className="min-w-0">
            It worked. Your product's first chat is in {workspaceName}.{" "}
            <Link
              to="/workspaces/$workspaceId/sessions/$sessionId"
              params={{ workspaceId, sessionId: state.sessionId }}
              className="font-medium whitespace-nowrap text-fg underline underline-offset-2"
            >
              Open the chat
            </Link>
          </span>
        </p>
      ) : done ? null : state.status === "waiting" ? (
        <p className="flex items-center gap-2 text-fg-muted">
          <span className="relative flex size-2.5 items-center justify-center" aria-hidden="true">
            <span className="absolute size-2.5 animate-ping rounded-full bg-status-running/40 motion-reduce:hidden" />
            <span className="size-1.5 rounded-full bg-status-running" />
          </span>
          Waiting for your first request…
        </p>
      ) : state.status === "error" ? (
        <p className="text-fg-muted">
          Couldn't check for new chats. Send a message from your product, then reload this page.
        </p>
      ) : null}
    </div>
  );
}
