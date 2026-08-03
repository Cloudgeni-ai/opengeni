import { useEffect, useState } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { useAppContext } from "@/context";
import {
  canonicalSessionDeepLinkTarget,
  resolveAuthorizedSessionWorkspace,
  shouldRedirectSessionDeepLink,
} from "@/lib/session-deep-link";

export function SessionDeepLinkRoute({ sessionId }: { sessionId: string }) {
  const context = useAppContext();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "not-found" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");

    void resolveAuthorizedSessionWorkspace(
      context.client,
      context.accessContext.workspaceGrants,
      sessionId,
    ).then((resolution) => {
      if (cancelled) {
        return;
      }
      if (resolution.status === "resolved") {
        const targetPath = canonicalSessionDeepLinkTarget(
          resolution.workspaceId,
          sessionId,
          window.location,
        );
        const targetPathname = targetPath.split(/[?#]/, 1)[0] ?? targetPath;
        if (shouldRedirectSessionDeepLink(window.location.pathname, targetPathname)) {
          // A full-document replace keeps the compatibility URL out of the
          // back stack and preserves the original query/hash for the canonical
          // session view. The canonical route never renders this component,
          // so a successful redirect cannot loop.
          window.location.replace(targetPath);
          return;
        }
      }
      setState(resolution.status === "error" ? "error" : "not-found");
    });

    return () => {
      cancelled = true;
    };
  }, [attempt, context.accessContext.workspaceGrants, context.client, sessionId]);

  if (state === "loading") {
    return <LoadingPanel label="Opening session" />;
  }
  if (state === "error") {
    return (
      <ProblemPanel
        title="Session unavailable"
        description="We couldn't verify this session right now. Try again in a moment."
        action={
          <button
            type="button"
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-medium hover:bg-surface-3"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        }
      />
    );
  }
  return (
    <ProblemPanel
      title="Session not found"
      description="This session doesn't exist or you don't have access to it."
    />
  );
}
