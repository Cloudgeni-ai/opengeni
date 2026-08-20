import { useEffect, useState } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import {
  canonicalSessionDeepLinkTarget,
  resolveAuthorizedSessionWorkspace,
  sessionReadWorkspaceIds,
} from "@/lib/session-deep-link";
import { workspaceSessionsPath } from "@/lib/routes";

export function SessionUnavailableRoute(props: { workspaceId: string; sessionId: string }) {
  const context = useAppContext();
  const [state, setState] = useState<"resolving" | "not-found" | "error">("resolving");
  const listedWorkspaceIds = new Set(context.workspaces.map((workspace) => workspace.id));
  const sessionWorkspaceIds = sessionReadWorkspaceIds(context.accessContext.workspaceGrants).filter(
    (workspaceId) => listedWorkspaceIds.has(workspaceId),
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
    setState("resolving");
    void resolveAuthorizedSessionWorkspace(
      context.client,
      context.accessContext.workspaceGrants,
      props.sessionId,
      {
        authorizedWorkspaceIds: context.workspaces.map((workspace) => workspace.id),
        excludeWorkspaceId: props.workspaceId,
      },
    ).then((resolution) => {
      if (cancelled) return;
      if (resolution.status === "resolved") {
        window.location.replace(
          canonicalSessionDeepLinkTarget(resolution.workspaceId, props.sessionId, window.location),
        );
        return;
      }
      setState(resolution.status === "error" ? "error" : "not-found");
    });
    return () => {
      cancelled = true;
    };
  }, [
    context.accessContext.workspaceGrants,
    context.client,
    context.workspaces,
    props.sessionId,
    props.workspaceId,
  ]);

  if (state === "resolving") return <LoadingPanel label="Looking for this session" />;
  return (
    <ProblemPanel
      title={state === "error" ? "Session unavailable" : "Session not found"}
      description={
        state === "error"
          ? "We couldn't verify another authorized workspace right now. Try again in a moment."
          : "This session doesn't exist or isn't available in any workspace you can access."
      }
      action={
        backWorkspaceId ? (
          <Button asChild type="button" variant="secondary">
            <a href={workspaceSessionsPath(backWorkspaceId)}>Back to sessions</a>
          </Button>
        ) : undefined
      }
    />
  );
}
