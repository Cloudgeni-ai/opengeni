import { useEffect } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  resolveAuthorizedWorkspaceFallback,
  type RouteRecoveryLocation,
  workspaceSessionIdFromPath,
} from "@/lib/authorized-route-recovery";
import { SessionUnavailableRoute } from "@/routes/session-unavailable";
import type { AccessContext, Workspace } from "@/types";

export function WorkspaceUnavailableRoute(props: {
  requestedWorkspaceId: string;
  workspaces: readonly Workspace[];
  accessContext: AccessContext;
  location?: RouteRecoveryLocation;
}) {
  const location =
    props.location ??
    (typeof window === "undefined" ? { pathname: "", search: "", hash: "" } : window.location);
  const fallback = resolveAuthorizedWorkspaceFallback({
    requestedWorkspaceId: props.requestedWorkspaceId,
    location,
    workspaces: props.workspaces,
    accessContext: props.accessContext,
  });
  const fallbackTarget = fallback?.target ?? null;
  const sessionId = workspaceSessionIdFromPath(location.pathname);

  useEffect(() => {
    if (fallbackTarget && typeof window !== "undefined") {
      window.location.replace(fallbackTarget);
    }
  }, [fallbackTarget]);

  if (sessionId) {
    return (
      <SessionUnavailableRoute workspaceId={props.requestedWorkspaceId} sessionId={sessionId} />
    );
  }
  if (fallback) return <LoadingPanel label="Opening an accessible workspace" />;
  return (
    <ProblemPanel
      title="Workspace unavailable"
      description="This workspace doesn't exist or you don't have access to it. No authorized equivalent destination was found."
      action={
        <Button asChild type="button" variant="secondary">
          <a href="/">Open default workspace</a>
        </Button>
      }
    />
  );
}
