import { useMemo } from "react";
import type { ClaudeSubscriptionAccount } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useSubscriptionAccountPool } from "./use-subscription-account-pool";

export function useClaudeSubscriptions(
  input: {
    client: OpenGeniBrowserClient;
    canManage: boolean;
    enabled?: boolean | undefined;
  } & (
    | { workspaceId: string; organizationId?: never }
    | { organizationId: string; workspaceId?: never }
  ),
) {
  const { client, workspaceId, organizationId } = input;
  const operations = useMemo(
    () => ({
      load: () =>
        organizationId
          ? client.listOrganizationClaudeSubscriptionAccounts(organizationId)
          : client.listClaudeSubscriptionAccounts(workspaceId!),
      rotation: (rotationEnabled: boolean) =>
        organizationId
          ? client.setOrganizationClaudeSubscriptionRotationSettings(organizationId, {
              rotationEnabled,
            })
          : client.setClaudeSubscriptionRotationSettings(workspaceId!, { rotationEnabled }),
      activate: (account: ClaudeSubscriptionAccount) =>
        organizationId
          ? client.activateOrganizationClaudeSubscriptionAccount(organizationId, account.id)
          : client.activateClaudeSubscriptionAccount(workspaceId!, account.id),
      allocator: (account: ClaudeSubscriptionAccount, enabled: boolean) =>
        organizationId
          ? client.setOrganizationClaudeSubscriptionAccountAllocator(organizationId, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            })
          : client.setClaudeSubscriptionAccountAllocator(workspaceId!, account.id, {
              enabled,
              expectedVersion: account.allocatorVersion,
            }),
      rename: (account: ClaudeSubscriptionAccount, label: string | null) =>
        organizationId
          ? client.renameOrganizationClaudeSubscriptionAccount(organizationId, account.id, label)
          : client.renameClaudeSubscriptionAccount(workspaceId!, account.id, label),
      disconnect: (account: ClaudeSubscriptionAccount) =>
        organizationId
          ? client.disconnectOrganizationClaudeSubscriptionAccount(organizationId, account.id)
          : client.disconnectClaudeSubscriptionAccount(workspaceId!, account.id),
    }),
    [client, workspaceId, organizationId],
  );
  return {
    ...useSubscriptionAccountPool({
      ...input,
      operations,
      identity: "claude:" + (organizationId ?? workspaceId),
      providerName: "Claude",
    }),
    client,
    workspaceId,
    organizationId,
    canManage: input.canManage,
  };
}
export type ClaudeSubscriptions = ReturnType<typeof useClaudeSubscriptions>;
