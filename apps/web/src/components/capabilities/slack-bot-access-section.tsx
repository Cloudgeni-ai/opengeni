import { useAppContext } from "@opengeni/react/app/app-context";
import type { AccessContext, ClientConfig, ConnectionMetadata } from "@opengeni/react/app/types";
import { canManageIntegrationReach, IntegrationReachSection } from "./integration-reach-section";

/**
 * Who may share a workspace's Slack bot with other workspaces: an
 * organization owner or admin who also manages this workspace's
 * integrations, the same rule the server applies.
 */
export function canShareSlackBotWithOrganization(input: {
  accessContext: AccessContext;
  clientConfig: Pick<ClientConfig, "productAccessMode"> & {
    auth: Pick<ClientConfig["auth"], "mode">;
  };
  connection: Pick<ConnectionMetadata, "accountId" | "workspaceId">;
}): boolean {
  return canManageIntegrationReach({
    accessContext: input.accessContext,
    clientConfig: input.clientConfig,
    accountId: input.connection.accountId,
    workspaceId: input.connection.workspaceId,
  });
}

/**
 * Where a workspace's Slack bot works in Opengeni. It belongs to the workspace
 * it was installed in and always works there; organization owners can let
 * other shared workspaces use it too. Never anyone's Personal workspace.
 * Slack stores this as on/off plus a selection; off is the owner alone.
 */
export function SlackBotAccessSection({
  connection,
  onSaved,
}: {
  connection: ConnectionMetadata;
  onSaved: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const reach = (access: { enabled: boolean; workspaceIds?: string[] | null }) => ({
    workspaceIds: access.enabled ? (access.workspaceIds ?? null) : [],
    personalWorkspaces: false,
  });
  return (
    <IntegrationReachSection
      accountId={connection.accountId}
      workspaceId={connection.workspaceId}
      personalWorkspaces="none"
      reloadKey={`${connection.workspaceId}:${connection.id}`}
      load={async () =>
        reach(
          await client.getOpenGeniSlackBotOrganizationAccess(connection.workspaceId, connection.id),
        )
      }
      save={async (next) =>
        reach(
          await client.setOpenGeniSlackBotOrganizationAccess(
            connection.workspaceId,
            connection.id,
            {
              enabled: next.workspaceIds === null || next.workspaceIds.length > 0,
              workspaceIds: next.workspaceIds ? [...next.workspaceIds] : null,
            },
          ),
        )
      }
      onSaved={onSaved}
    />
  );
}
