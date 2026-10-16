import type { BillingPlanBalance } from "@opengeni/sdk";
import { Notice } from "@/components/ui/notice";
import { RowButton } from "@/components/ui/page-actions";
import { planSeats } from "@/lib/subscription-plans";

export function PlanSeats({ plan }: { plan: BillingPlanBalance | null }) {
  return plan ? (
    <p className="text-xs text-fg-muted">
      {plan.label} · {planSeats(plan)}. Pending invitations reserve seats.
    </p>
  ) : null;
}

export function SeatLimitNotice({
  canManage,
  onUpgrade,
}: {
  canManage: boolean;
  onUpgrade: () => void;
}) {
  return (
    <Notice
      tone="waiting"
      title="Your plan's seat limit is reached"
      live="assertive"
      actionLayout="responsive"
      action={
        canManage ? (
          <RowButton variant="default" onClick={onUpgrade}>
            View upgrade options
          </RowButton>
        ) : undefined
      }
    >
      {canManage
        ? "Upgrade your plan to invite more people."
        : "Ask an organization owner to upgrade the plan before inviting more people."}
    </Notice>
  );
}
