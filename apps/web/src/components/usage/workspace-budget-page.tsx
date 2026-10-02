import { UsageMeterView, summarizeUsage } from "@opengeni/react/usage";
import { SquareStackIcon } from "lucide-react";
import { useMemo } from "react";

import { useOrganizationDirectory } from "@/components/organization/organization-directory";
import { DetailPage, DetailPageHeader } from "@/components/ui/detail-page";
import { DetailSkeleton } from "@/components/ui/detail-sheet";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { FLUSH_DETAIL_PAGE_CLASS } from "@/components/ui/flush-form-page";
import { LogoTile } from "@/components/ui/logo-tile";
import { RowButton } from "@/components/ui/page-actions";
import { Section, SectionStack } from "@/components/ui/section";
import { useAppContext } from "@/context";
import { apiErrorDetails, userErrorTextWithoutReference } from "@/lib/api-error";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { formatBudget, formatCredits, ordinalDay } from "@/lib/usage-allowances";
import { BudgetForm } from "./budget-form";
import { MemberLimitsSection, type MemberName } from "./member-limits-section";
import { useWorkspaceBudget } from "./use-workspace-budget";

/**
 * Organization settings > Billing & usage > one workspace: its monthly budget,
 * this month's usage, and every member against their own limit.
 */
export function WorkspaceBudgetPage({
  workspaceId,
  onBack,
}: {
  workspaceId: string;
  onBack: () => void;
}) {
  const context = useAppContext();
  const directory = useOrganizationDirectory();
  const overview = directory.overview.value;
  const workspace = overview?.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const organizationId = directory.identity.organizationId;
  // Budgets are organization authority (owners); member limits are workspace authority.
  const canEditBudget = hasAccountPermission(
    context.accessContext,
    organizationId,
    "account:admin",
  );
  const canEditMembers = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const budget = useWorkspaceBudget(context.client, workspaceId, { roster: true, budget: true });
  const back = { label: "Billing & usage", onClick: onBack };

  const names = useMemo(() => {
    const map = new Map<string, MemberName>();
    for (const member of workspace?.members ?? []) {
      map.set(member.subjectId, {
        name: member.name ?? member.subjectLabel,
        email: member.email,
      });
    }
    return map;
  }, [workspace]);

  if (!overview) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <DetailSkeleton />
      </DetailPage>
    );
  }
  if (!workspace) {
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        <EmptyState
          variant="page"
          icon={<SquareStackIcon />}
          title="This workspace is gone"
          description="It may have been deleted. Budgets apply to shared workspaces in this organization."
          action={<RowButton onClick={onBack}>Back to Billing & usage</RowButton>}
        />
      </DetailPage>
    );
  }

  const state = budget.allowance.value;
  const config = state?.config ?? null;
  const usage = budget.usage.value;
  const meta = config
    ? [
        `${formatBudget(config.includedCredits)} a month`,
        `resets on the ${ordinalDay(config.anchorDay ?? 1)}`,
      ]
    : ["No budget"];

  return (
    <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
      <DetailPageHeader
        leading={<LogoTile name={workspace.name} />}
        title={`${workspace.name} budget`}
        meta={meta}
      />
      <div className="mt-8 min-w-0">
        <SectionStack>
          {config && usage && usage.workspace.limit !== null ? (
            <Section title="This month">
              <div className="py-1">
                <UsageMeterView
                  summary={summarizeUsage({ ...usage, members: [] })}
                  density="hero"
                  formatAmount={formatCredits}
                  labels={{
                    workspaceTitle: "",
                    amountLeft: (amount) => `${amount} left this month`,
                  }}
                />
              </div>
            </Section>
          ) : null}

          {budget.allowance.error ? (
            <ErrorMessage
              variant="inline"
              title="Couldn't load the budget"
              action={<RowButton onClick={() => void budget.reload()}>Try again</RowButton>}
              {...apiErrorDetails(budget.allowance.error)}
            >
              {userErrorTextWithoutReference(budget.allowance.error)}
            </ErrorMessage>
          ) : state ? (
            <BudgetForm
              workspaceName={workspace.name}
              state={state}
              memberCount={usage && !budget.rosterDenied ? usage.members.length : null}
              canEdit={canEditBudget}
              onSave={budget.saveBudget}
              onRemove={budget.removeBudget}
            />
          ) : (
            <DetailSkeleton />
          )}

          {config && usage && !budget.rosterDenied ? (
            <MemberLimitsSection
              usage={usage}
              memberDefault={config.memberDefault}
              names={names}
              viewerSubjectId={context.accessContext.subjectId}
              canEdit={canEditMembers}
              onChangeRule={budget.setMemberRule}
            />
          ) : config && budget.rosterDenied ? (
            <Section title="Members">
              <p className="text-xs leading-[18px] text-fg-muted">
                Only {workspace.name}'s admins can see each member's usage and set member limits.
              </p>
            </Section>
          ) : null}
        </SectionStack>
      </div>
    </DetailPage>
  );
}
