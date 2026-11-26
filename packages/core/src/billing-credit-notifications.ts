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
  type BillingCreditSpend,
  type BillingCreditSpendWorkspace,
} from "@opengeni/db";
import type { ManagedEmailTransport, ManagedEmailDeliveryResult } from "./dependencies";

export { enqueueBillingCreditNotification } from "@opengeni/db";
export type { EnqueueBillingCreditNotificationInput } from "@opengeni/db";

const TITLES: Record<BillingCreditNotificationKind, (organization: string) => string> = {
  low_balance: (org) => `General credits are low in ${org}`,
  exhausted: (org) => `General credits are exhausted in ${org}`,
  unusual_spend: (org) => `Unusual credit spending in ${org}`,
  topup_success: (org) => `Credits were topped up in ${org}`,
  topup_failed: (org) => `Credit top-up failed in ${org}`,
  cap_reached: (org) => `Automatic top-up cap reached in ${org}`,
};
const dollars = (micros: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(micros / 1_000_000);
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
/** One display line: user-chosen names must not inject headers, lines or
 * direction overrides. Truncation keeps whole code points. */
const displayName = (value: string | null | undefined, max: number) => {
  const clean = (value ?? "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(clean);
  return points.length > max
    ? `${points
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : clean;
};

/** Deployments other than `production` name their app host, so a staging or
 * preview notice is never mistaken for a production one. */
export function billingCreditEnvironmentLabel(environment: string, appUrl: string): string | null {
  if (environment === "production") return null;
  try {
    return new URL(appUrl).host || environment;
  } catch {
    return environment;
  }
}

const workspaceLabel = (workspace: BillingCreditSpendWorkspace) =>
  workspace.kind === "personal"
    ? "Personal workspaces"
    : workspace.kind === "other"
      ? "Other usage"
      : displayName(workspace.name, 80) || "Unnamed workspace";

export function billingCreditEmail(input: {
  kind: BillingCreditNotificationKind;
  details: BillingCreditNotificationDetails;
  sender: string;
  email: string;
  billingUrl: string;
  organizationName?: string | null;
  /** Non-production label, from billingCreditEnvironmentLabel. */
  environmentLabel?: string | null;
  /** Top spend groups in the notice's window, when its kind shows them. */
  spend?: BillingCreditSpend | null;
  workspaceUrl?: (workspaceId: string) => string | null;
}): BillingCreditEmailMessage {
  const title = TITLES[input.kind](displayName(input.organizationName, 80) || "your organization");
  const environment = displayName(input.environmentLabel, 80);
  const lines = [
    title + ".",
    ...(environment ? [`Sent from ${environment}.`] : []),
    `General credits available: ${dollars(input.details.availableBalanceMicros)}.`,
  ];
  if (input.details.amountMicros !== undefined && input.kind !== "cap_reached")
    lines.push(
      `${input.kind === "topup_success" ? "Credits added" : input.kind === "topup_failed" ? "Requested credits" : "Amount"}: ${dollars(input.details.amountMicros)}.`,
    );
  if (input.details.lastHourSpendMicros !== undefined)
    lines.push(`Spent in the last hour: ${dollars(input.details.lastHourSpendMicros)}.`);
  const workspaces = input.spend?.workspaces ?? [];
  const hours = input.spend?.windowHours ?? 1;
  const window = hours === 1 ? "the last hour" : `the last ${hours} hours`;
  const notes: string[] = [];
  if (input.kind === "topup_failed")
    notes.push(
      "Automatic top-ups are off. Review your card and settings before enabling them again.",
    );
  else if (input.kind === "cap_reached")
    notes.push(
      "The next automatic top-up would exceed your monthly limit. No payment was started.",
    );
  else if (input.kind !== "topup_success")
    notes.push(
      "Model-scoped promotional and Free-plan credits are separate and may still be available for eligible use.",
    );
  const heading = `Top workspaces in ${window}:`;
  const textBreakdown = workspaces.length
    ? [heading, ...workspaces.map((w) => `- ${workspaceLabel(w)}: ${dollars(w.spendMicros)}`)]
    : [];
  const htmlBreakdown = workspaces.length
    ? `<p>${escapeHtml(heading)}</p><ul>${workspaces
        .map((w) => {
          const url =
            w.kind === "workspace" && w.workspaceId ? input.workspaceUrl?.(w.workspaceId) : null;
          const label = escapeHtml(workspaceLabel(w));
          return `<li>${url ? `<a href="${escapeHtml(url)}">${label}</a>` : label}: ${escapeHtml(dollars(w.spendMicros))}</li>`;
        })
        .join("")}</ul>`
    : "";
  const paragraphs = (values: string[]) =>
    values.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return {
    from: input.sender,
    to: input.email,
    subject: environment ? `[${environment}] ${title}` : title,
    text: `${[...lines, ...textBreakdown, ...notes].join("\n")}\n\nManage billing: ${input.billingUrl}`,
    html: `${paragraphs(lines)}${htmlBreakdown}${paragraphs(notes)}<p><a href="${escapeHtml(input.billingUrl)}">Manage billing</a></p>`,
  };
}

/** Uses the existing managed-email provider. Never substitutes a second provider
 * or retries outside the frozen provider's idempotency retention window. */
export async function deliverBillingCreditNotification(input: {
  db: Database;
  accountId: string;
  transport: ManagedEmailTransport;
  appUrl: string;
  /** Deployment environment (OPENGENI_ENVIRONMENT); production adds no label. */
  environment?: string;
}): Promise<boolean> {
  const environmentLabel = billingCreditEnvironmentLabel(
    input.environment ?? "production",
    input.appUrl,
  );
  const claim = await claimBillingCreditNotification(input.db, {
    accountId: input.accountId,
    sender: input.transport.sender,
    providerScope: input.transport.idempotency.scope,
    retentionSeconds: input.transport.idempotency.retentionSeconds,
    message: (kind, details, email, path, context) =>
      billingCreditEmail({
        kind,
        details,
        email,
        sender: input.transport.sender,
        billingUrl: new URL(path, input.appUrl).href,
        organizationName: context.organizationName,
        environmentLabel,
        spend: context.spend,
        workspaceUrl: (workspaceId) => {
          const workspacePath = context.workspacePath(workspaceId);
          return workspacePath ? new URL(workspacePath, input.appUrl).href : null;
        },
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
