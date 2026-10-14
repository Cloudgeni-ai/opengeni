import { useNavigate } from "@tanstack/react-router";

import {
  LearningSettings,
  useIdentityLearningPolicy,
  useLearningDefaults,
} from "@/components/knowledge/knowledge-learning";
import { useReviewQueue } from "@/components/knowledge/knowledge-review";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { orgLabel } from "@/lib/org";
import { organizationSettingsAccess } from "@/lib/organization-settings-access";
import { canManageWorkspaceSettings } from "@/lib/permissions";

/**
 * Settings > Agent learning: what agents may change on their own in this
 * workspace's shared chats and in your private chats, and what waits in
 * Knowledge > Review for your OK.
 */
export function AgentLearningSettingsPage({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const workspace = context.workspaces.find((each) => each.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const organizationName = workspace?.accountId
    ? orgLabel(workspace.accountId, context.accessContext.accountGrants)
    : null;
  const canManageWorkspace = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  // Owner-only, the same rule as Organization settings > Organization identity.
  const ownsOrganization = Boolean(
    workspace?.accountId &&
    organizationSettingsAccess({
      accessContext: context.accessContext,
      clientConfig: context.clientConfig,
      accountId: workspace.accountId,
    }).canManageCompanyProfileAgentPolicy,
  );
  const shared = useLearningDefaults(workspaceId, personal ? "personal" : "workspace");
  const mine = useLearningDefaults(workspaceId, "personal");
  const identity = useIdentityLearningPolicy(workspaceId, ownsOrganization);
  const queue = useReviewQueue(workspaceId, 0);

  return (
    <LearningSettings
      workspaceName={workspace?.name ?? "this workspace"}
      organizationName={organizationName}
      personal={personal}
      canManageWorkspace={canManageWorkspace}
      shared={shared}
      mine={mine}
      identity={identity}
      review={{
        count: queue.loading ? null : queue.count,
        partial: queue.partial,
        failed: queue.error !== null,
        onOpen: () =>
          void navigate({
            to: "/workspaces/$workspaceId/state",
            params: { workspaceId },
            search: { view: "review" },
          }),
      }}
    />
  );
}
