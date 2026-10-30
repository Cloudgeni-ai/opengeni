import type { BillingPlanBalance } from "@opengeni/sdk";
import { Notice } from "@opengeni/react/ui/notice";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { planSeats, type SeatUpgrade } from "@opengeni/react/app/lib/subscription-plans";

export function PlanSeats({ plan }: { plan: BillingPlanBalance | null }) {
  return plan ? (
    <p className="text-xs text-fg-muted">
      {plan.label} · {planSeats(plan)}. Pending invitations reserve seats.
    </p>
  ) : null;
}

/**
 * A seat refusal names its one fix once: on the one button for people who
 * manage billing ("Upgrade to Pro"). Everyone else is told to ask an owner.
 */
export function SeatLimitNotice({
  canManage,
  upgrade,
  onUpgrade,
}: {
  canManage: boolean;
  upgrade: SeatUpgrade | null;
  onUpgrade: () => void;
}) {
  const enterprise = upgrade?.key === "enterprise";
  const fix = !upgrade
    ? null
    : enterprise
      ? `Talk to us about ${upgrade.label}`
      : `Upgrade to ${upgrade.label}`;
  return (
    <Notice
      tone="waiting"
      title="Your plan's seat limit is reached"
      live="assertive"
      actionLayout="responsive"
      action={
        canManage ? (
          <RowButton variant="default" onClick={onUpgrade}>
            {!upgrade ? "View upgrade options" : enterprise ? `View ${upgrade.label}` : fix}
          </RowButton>
        ) : undefined
      }
    >
      {canManage
        ? !upgrade
          ? "Upgrade your plan to invite more people."
          : enterprise
            ? `${fix} to add more people.`
            : null
        : !upgrade
          ? "Ask an organization owner to upgrade the plan before inviting more people."
          : enterprise
            ? `Ask an organization owner about ${upgrade.label}.`
            : `Ask an organization owner to upgrade to ${upgrade.label}.`}
    </Notice>
  );
}
