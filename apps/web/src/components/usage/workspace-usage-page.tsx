import { UsageMeterView, summarizeUsage } from "@opengeni/react/usage";
import { Link } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRowSkeleton } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { apiErrorDetails, userErrorTextWithoutReference } from "@/lib/api-error";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { CONSOLE_ALLOWANCE_LABELS, formatCredits } from "@/lib/usage-allowances";
import { MemberLimitsSection, type MemberName } from "./member-limits-section";
import { isForbidden, useWorkspaceBudget } from "./use-workspace-budget";

/**
 * Workspace settings > Usage. Everyone sees their own limit and the workspace
 * budget; workspace admins also see every member and can change their limits.
 * The budget itself belongs to organization owners (Billing).
 */
export function WorkspaceUsagePage({
  workspaceId,
  workspaceName,
  organizationId,
}: {
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
}) {
  const context = useAppContext();
  const viewer = context.accessContext.subjectId;
  const isAdmin = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const isOwner =
    Boolean(organizationId) &&
    hasAccountPermission(context.accessContext, organizationId, "account:admin");
  const budget = useWorkspaceBudget(context.client, workspaceId, {
    roster: isAdmin,
    budget: isAdmin || isOwner,
  });
  const names = useWorkspaceMemberNames(workspaceId, isAdmin);
  const usage = budget.usage.value;
  const summary = useMemo(() => (usage ? summarizeUsage(usage, viewer) : null), [usage, viewer]);
  const config = budget.allowance.value?.config ?? null;

  const manageBudget = isOwner ? (
    <Button asChild variant="outline" size="sm" className="pointer-coarse:h-11">
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId }}
        search={{ section: "billing", workspace: workspaceId }}
      >
        {usage?.workspace.limit === null ? "Set a budget" : "Manage budget"}
      </Link>
    </Button>
  ) : null;

  if (budget.usage.error) {
    return isForbidden(budget.usage.error) ? (
      <p className="text-sm text-fg-muted">
        Usage is shown to people who use this workspace. API keys and services don't have a personal
        limit.
      </p>
    ) : (
      <ErrorMessage
        variant="inline"
        title="Couldn't load usage"
        action={<RowButton onClick={() => void budget.reload()}>Try again</RowButton>}
        {...apiErrorDetails(budget.usage.error)}
      >
        {userErrorTextWithoutReference(budget.usage.error)}
      </ErrorMessage>
    );
  }
  if (!usage || !summary) {
    return (
      <Section title="Your usage">
        <SettingRowSkeleton />
      </Section>
    );
  }
  if (summary.state === "unlimited") {
    return (
      <EmptyState
        variant="page"
        icon={<GaugeIcon />}
        title="No usage limits here"
        description={`Work in ${workspaceName} uses the organization's credits with no monthly budget. ${
          isOwner
            ? "Set a budget to cap what this workspace spends each month."
            : "Organization owners can set a monthly budget."
        }`}
        action={manageBudget}
      />
    );
  }
  const own = summary.member;
  return (
    <SectionStack>
      <Section
        title="Your usage"
        description={
          own
            ? "Your limit this month. You can keep reading and exporting everything when it runs out."
            : "You have no personal limit here; the workspace budget applies to everyone."
        }
      >
        {own ? (
          <div className="py-1">
            <UsageMeterView
              summary={{ ...summary, workspace: null }}
              density="hero"
              formatAmount={formatCredits}
              labels={{ title: "", amountLeft: (amount) => `${amount} left this month` }}
              showWorkspace={false}
            />
            {own.status === "exhausted" ? (
              <p className="mt-3 text-xs leading-[18px] text-fg-muted">
                {CONSOLE_ALLOWANCE_LABELS.memberRemedy}
              </p>
            ) : null}
          </div>
        ) : null}
      </Section>

      {usage.workspace.limit !== null ? (
        <Section
          title="Workspace budget"
          description="Shared by everyone in the workspace. Set by organization owners."
          action={manageBudget}
        >
          <div className="py-1">
            <UsageMeterView
              summary={summarizeUsage({ ...usage, members: [] })}
              density="hero"
              formatAmount={formatCredits}
              labels={{ workspaceTitle: "", amountLeft: (amount) => `${amount} left this month` }}
            />
          </div>
        </Section>
      ) : null}

      {isAdmin && !budget.rosterDenied && usage.workspace.limit !== null ? (
        <MemberLimitsSection
          usage={usage}
          memberDefault={config?.memberDefault}
          names={names}
          viewerSubjectId={viewer}
          canEdit={isAdmin}
          onChangeRule={budget.setMemberRule}
        />
      ) : null}
    </SectionStack>
  );
}

/** Display names for the roster: the workspace's own member list. */
function useWorkspaceMemberNames(
  workspaceId: string,
  enabled: boolean,
): ReadonlyMap<string, MemberName> {
  const client = useAppContext().client;
  const [names, setNames] = useState<ReadonlyMap<string, MemberName>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void client
      .listWorkspaceMembers(workspaceId)
      .then((members) => {
        if (!active) return;
        setNames(
          new Map(
            members.map((member) => [member.subjectId, { name: member.subjectLabel, email: null }]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, enabled, workspaceId]);
  return names;
}
