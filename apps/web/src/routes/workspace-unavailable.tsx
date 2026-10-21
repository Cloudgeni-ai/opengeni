import { useEffect } from "react";

import { LoadingPanel, ProblemPanel } from "@opengeni/react/app/components/common";
import { Button } from "@opengeni/react/ui/button";
import { CrossSlotDeepLinkRecovery } from "@opengeni/react/app/components/cross-slot-deep-link-recovery";
import {
  resolveAuthorizedWorkspaceFallback,
  type RouteRecoveryLocation,
  workspaceSessionIdFromPath,
} from "@/lib/authorized-route-recovery";
import { SessionUnavailableRoute } from "@opengeni/react/app/routes/session-unavailable";
import type { AccessContext, Workspace } from "@opengeni/react/app/types";

export function WorkspaceUnavailableRoute(props: {
  requestedWorkspaceId: string;
  workspaces: readonly Workspace[];
  accessContext: AccessContext;
  location?: RouteRecoveryLocation;
  suppressAuthorizedFallback?: boolean;
}) {
  const location =
    props.location ??
    (typeof window === "undefined" ? { pathname: "", search: "", hash: "" } : window.location);
  const fallback = props.suppressAuthorizedFallback
    ? null
    : resolveAuthorizedWorkspaceFallback({
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
  const unavailable = (
    <ProblemPanel
      title="Workspace unavailable"
      description="You don't have access to this workspace. It may no longer exist, and no authorized equivalent destination was found."
      action={
        <Button asChild type="button" variant="outline">
          <a href="/">Open default workspace</a>
        </Button>
      }
    />
  );
  return <CrossSlotDeepLinkRecovery path={location.pathname} fallback={unavailable} />;
}
