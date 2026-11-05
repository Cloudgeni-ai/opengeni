import type {
  BillingCreditNotificationDetails,
  BillingCreditNotificationKind,
} from "@opengeni/contracts/billing-credit-notifications";
import {
  claimBillingCreditNotification,
  settleBillingCreditNotification,
  withBillingCreditDeliveryAuthority,
  type Database,
  type BillingCreditEmailMessage,
} from "@opengeni/db";
import type { ManagedEmailTransport, ManagedEmailDeliveryResult } from "./dependencies";

export { enqueueBillingCreditNotification } from "@opengeni/db";
export type { EnqueueBillingCreditNotificationInput } from "@opengeni/db";

const TITLES: Record<BillingCreditNotificationKind, string> = {
  low_balance: "Your organization's general credits are low",
  exhausted: "Your organization's general credits are exhausted",
  unusual_spend: "Unusual credit spending in your organization",
  topup_success: "Your organization's credits were topped up",
  topup_failed: "Your organization's credit top-up failed",
  cap_reached: "Your organization's automatic top-up cap was reached",
};
const dollars = (micros: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function billingCreditEmail(input: {
  kind: BillingCreditNotificationKind;
  details: BillingCreditNotificationDetails;
  sender: string;
  email: string;
  billingUrl: string;
}): BillingCreditEmailMessage {
  const title = TITLES[input.kind];
  const lines = [
    title + ".",
    `General credits available: ${dollars(input.details.availableBalanceMicros)}.`,
  ];
  if (input.details.amountMicros !== undefined)
    lines.push(`Amount: ${dollars(input.details.amountMicros)}.`);
  if (input.details.lastHourSpendMicros !== undefined)
    lines.push(`Spent in the last hour: ${dollars(input.details.lastHourSpendMicros)}.`);
  lines.push(
    "Model-scoped promotional and Free-plan credits are separate and may still be available for eligible use.",
  );
  return {
    from: input.sender,
    to: input.email,
    subject: title,
    text: `${lines.join("\n")}\n\nManage billing: ${input.billingUrl}`,
    html: `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(input.billingUrl)}">Manage billing</a></p>`,
  };
}

/** Uses the existing managed-email provider. Never substitutes a second provider
 * or retries outside the frozen provider's idempotency retention window. */
export async function deliverBillingCreditNotification(input: {
  db: Database;
  accountId: string;
  transport: ManagedEmailTransport;
  appUrl: string;
}): Promise<boolean> {
  const claim = await claimBillingCreditNotification(input.db, {
    accountId: input.accountId,
    sender: input.transport.sender,
    providerScope: input.transport.idempotency.scope,
    retentionSeconds: input.transport.idempotency.retentionSeconds,
    message: (kind, details, email, path) =>
      billingCreditEmail({
        kind,
        details,
        email,
        sender: input.transport.sender,
        billingUrl: new URL(path, input.appUrl).href,
      }),
  });
  if (!claim) return false;
  let result: ManagedEmailDeliveryResult | { status: "suppressed" };
  try {
    result = (await withBillingCreditDeliveryAuthority(input.db, claim, async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          input.transport.send({
            ...claim.message,
            kind: "billing_credit_notification",
            idempotencyKey: `billing-credit:${claim.id}`,
          }),
          new Promise<ManagedEmailDeliveryResult>((resolve) => {
            timer = setTimeout(
              () => resolve({ status: "outcome_unknown", errorClass: "timeout" }),
              5_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })) ?? { status: "suppressed" };
  } catch {
    result = { status: "outcome_unknown", errorClass: "transport_or_database" };
  }
  await settleBillingCreditNotification(input.db, claim, result);
  return true;
}
