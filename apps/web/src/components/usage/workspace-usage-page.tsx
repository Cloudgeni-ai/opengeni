import { UsageMeterView, summarizeUsage } from "@opengeni/react/usage";
import type { WorkspaceUsageResponse } from "@opengeni/sdk/usage-allowances";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { useAppContext } from "@opengeni/react/app/app-context";
import { apiErrorDetails, userErrorTextWithoutReference } from "@opengeni/react/ui/api-error";
import { hasAccountPermission, hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { CONSOLE_ALLOWANCE_LABELS, formatCredits } from "@/lib/usage-allowances";
import { MemberLimitsSection, type MemberName } from "./member-limits-section";
import { isForbidden, useWorkspaceBudget } from "./use-workspace-budget";

/**
 * Workspace settings > Usage. Everyone sees their own limit and the workspace
 * budget, and what they have used this month even when nothing is limited;
 * workspace admins also see every member and can change their limits. The
 * budget itself belongs to organization owners (Billing).
 */
export function WorkspaceUsagePage({
  workspaceId,
  workspaceName,
  organizationId,
  personalOrganizationLabel,
}: {
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
  /** Set for a Personal workspace: budgets don't apply, only the owner's own use. */
  personalOrganizationLabel?: string | undefined;
}) {
  const context = useAppContext();
  const viewer = context.accessContext.subjectId;
  const isAdmin = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const isOwner =
    Boolean(organizationId) &&
    hasAccountPermission(context.accessContext, organizationId, "account:admin");
  // A Personal workspace has no budget or roster to read, only the owner's own use.
  const shared = personalOrganizationLabel === undefined;
  const budget = useWorkspaceBudget(context.client, workspaceId, {
    roster: shared && isAdmin,
    budget: shared && (isAdmin || isOwner),
  });
  const names = useWorkspaceMemberNames(workspaceId, shared && isAdmin);
  const usage = budget.usage.value;
  // `/usage/me` answers for the viewer alone; a roster read covers everyone.
  const selfOnly = !(shared && isAdmin) || budget.rosterDenied;
  const summary = useMemo(() => (usage ? summarizeUsage(usage, viewer) : null), [usage, viewer]);
  const config = budget.allowance.value?.config ?? null;

  const manageBudget =
    isOwner && shared ? (
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
      <SectionStack>
        <Section
          title="Your usage"
          description={
            !shared
              ? `Your Personal workspace uses ${personalOrganizationLabel}'s credits without a monthly budget. Budgets apply to shared workspaces.`
              : `No usage limits here: work in ${workspaceName} uses the organization's credits with no monthly budget. ${
                  isOwner
                    ? "Set a budget to cap what this workspace spends each month."
                    : "Organization owners can set a monthly budget."
                }`
          }
          action={manageBudget}
        >
          <OwnUsedThisMonth usage={usage} viewer={viewer} selfOnly={selfOnly} />
        </Section>
      </SectionStack>
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
        ) : (
          <OwnUsedThisMonth usage={usage} viewer={viewer} selfOnly={selfOnly} />
        )}
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

/** What the viewer spent this month, for when no personal limit meters it. */
export function ownUsedThisMonth(
  usage: WorkspaceUsageResponse,
  viewer: string,
  selfOnly: boolean,
): number {
  const row =
    usage.members.find((member) => member.subjectId === viewer) ??
    // Only `/usage/me`, which returns the caller's own row, may stand in for
    // the viewer; a roster's single row can be someone else's.
    (selfOnly && usage.members.length === 1 ? usage.members[0] : undefined);
  return row?.used ?? 0;
}

function OwnUsedThisMonth({
  usage,
  viewer,
  selfOnly,
}: {
  usage: WorkspaceUsageResponse;
  viewer: string;
  selfOnly: boolean;
}) {
  return (
    <p className="py-1 text-sm text-fg-muted">
      <span className="text-2xl font-semibold tabular-nums text-fg">
        {formatCredits(ownUsedThisMonth(usage, viewer, selfOnly))}
      </span>{" "}
      used this month
    </p>
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
