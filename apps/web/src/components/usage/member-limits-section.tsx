import { UsageMemberList, type UsageMemberIdentity } from "@opengeni/react/usage";
import type {
  MemberAllowanceDefault,
  MemberAllowanceRule,
  MemberAllowanceUsage,
  WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { toast } from "sonner";

import { Section } from "@/components/ui/section";
import { CONSOLE_USAGE_AMOUNTS } from "@/lib/usage-allowances";

export type MemberName = { name: string | null; email?: string | null };

/**
 * Every member's usage this period against their own limit. Workspace admins
 * edit a limit with a share-of-budget slider (or a fixed amount); limits are
 * ceilings, so they may add up to more than the budget.
 */
export function MemberLimitsSection({
  usage,
  memberDefault,
  names,
  viewerSubjectId,
  canEdit,
  onChangeRule,
}: {
  usage: WorkspaceUsageResponse;
  memberDefault: MemberAllowanceDefault | null | undefined;
  names: ReadonlyMap<string, MemberName>;
  viewerSubjectId: string;
  canEdit: boolean;
  onChangeRule: (member: MemberAllowanceUsage, rule: MemberAllowanceRule) => Promise<void>;
}) {
  const describe = (member: MemberAllowanceUsage): UsageMemberIdentity => {
    const known = names.get(member.subjectId);
    const you = member.subjectId === viewerSubjectId;
    const name =
      known?.name ?? known?.email ?? member.externalIdentity?.externalId ?? "Former member";
    return {
      name: you ? `${name} (you)` : name,
      detail: known?.name && known.email ? known.email : null,
    };
  };
  return (
    <Section
      title="Members"
      description={
        canEdit
          ? "Each member's limit is a ceiling on their own usage. Limits can add up to more than the budget; the budget still caps the total."
          : "Workspace admins set member limits."
      }
    >
      <UsageMemberList
        usage={usage}
        memberDefault={memberDefault}
        describe={describe}
        amounts={CONSOLE_USAGE_AMOUNTS}
        framed={false}
        onChangeRule={
          canEdit
            ? async (member, rule) => {
                await onChangeRule(member, rule);
                toast.success(`Saved ${describe(member).name.replace(/ \(you\)$/, "")}'s limit`);
              }
            : undefined
        }
      />
    </Section>
  );
}
