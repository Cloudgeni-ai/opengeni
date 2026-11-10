import type { AccessContext, BillingCreditNotification, Workspace } from "@opengeni/sdk";

/** Account grants, never workspace administration, authorize billing presentation. */
export function inboxBillingAccountIds(context: AccessContext): string[] {
  return context.accountGrants
    .filter(
      (grant) =>
        grant.subjectId === context.subjectId &&
        (grant.role === "owner" || grant.role === "admin") &&
        (grant.permissions.includes("billing:read") || grant.permissions.includes("account:admin")),
    )
    .map((grant) => grant.accountId);
}

/** Accept only the exact billing destination in an accessible same-org workspace. */
export function billingInboxActionPath(
  notice: BillingCreditNotification,
  workspaces: Pick<Workspace, "id" | "accountId">[],
): string | null {
  // Older recipients may have no Personal workspace pointer. Resolve the
  // backend's generic fallback locally, never through another org's default.
  if (notice.action.path === "/billing") {
    const workspace = workspaces.find((candidate) => candidate.accountId === notice.accountId);
    return workspace ? `/workspaces/${workspace.id}/organization?section=billing` : null;
  }
  return workspaces.some(
    (workspace) =>
      workspace.accountId === notice.accountId &&
      notice.action.path === `/workspaces/${workspace.id}/organization?section=billing`,
  )
    ? notice.action.path
    : null;
}

const dollars = (micros: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);

export function billingInboxCopy(notice: BillingCreditNotification): {
  title: string;
  body: string;
} {
  const details = notice.details;
  switch (notice.kind) {
    case "low_balance":
      return {
        title: "Credits are running low",
        body: `${dollars(details.availableBalanceMicros)} in general credits remains.`,
      };
    case "exhausted":
      return {
        title: "General credits are used up",
        body: "Model-specific credits may still be available.",
      };
    case "unusual_spend":
      return {
        title: "Spending is higher than usual",
        body:
          details.lastHourSpendMicros === undefined
            ? "Review your recent usage."
            : `${dollars(details.lastHourSpendMicros)} used in the last hour. Review your recent usage.`,
      };
    case "topup_success":
      return {
        title: "Credits added",
        body:
          details.amountMicros === undefined
            ? "Your top-up succeeded."
            : `${dollars(details.amountMicros)} added to your credits.`,
      };
    case "topup_failed":
      return {
        title: "Credit top-up failed",
        body: "Review your payment method and top-up settings.",
      };
    case "cap_reached":
      return {
        title: "Auto top-up limit reached",
        body: "Review your top-up limit to keep credits available.",
      };
  }
}
