import { ProblemPanel } from "@/components/common";
import { useAppContext } from "@/context";
import {
  ReplaceLocation,
  workspaceIntegrationsCallbackHref,
} from "@/lib/integrations-callback-return";
import {
  readLastWorkspaceId,
  resolveLandingWorkspaceId,
  workspaceNavigationPreferenceStorageId,
} from "@/lib/workspace-navigation-preference";

// Both forwarders load with the Capabilities route chunk, the page they forward
// to, so neither adds a route chunk or code to the eager session graph.

/**
 * Older callbacks still return to `/capabilities`; forward every callback
 * outcome parameter (not only Slack's) so the Plugins page shows the result.
 */
export function CapabilitiesLegacyRedirect({
  workspaceId,
  section,
}: {
  workspaceId: string;
  section?: "skills";
}) {
  return (
    <ReplaceLocation
      href={workspaceIntegrationsCallbackHref(workspaceId, window.location.search, section)}
    />
  );
}

/**
 * `/integrations` is where the API sends an integration callback whose state
 * names no usable workspace (missing, tampered, or unreadable). Forward it to
 * the viewer's current workspace Plugins page with the callback outcome intact,
 * so the page explains what happened and offers Connect again, instead of
 * rendering "Page not found".
 */
export function IntegrationsReturnRoute() {
  const context = useAppContext();
  const workspaceId = resolveLandingWorkspaceId({
    rememberedWorkspaceId: readLastWorkspaceId(
      workspaceNavigationPreferenceStorageId(context.accessContext.subjectId),
    ),
    workspaces: context.workspaces,
    accessContext: context.accessContext,
  });
  if (!workspaceId) {
    return (
      <ProblemPanel
        title="No workspace access"
        description="You don't have access to any workspace yet, so there is nowhere to finish connecting this integration."
      />
    );
  }
  return (
    <ReplaceLocation
      href={workspaceIntegrationsCallbackHref(workspaceId, window.location.search)}
    />
  );
}
