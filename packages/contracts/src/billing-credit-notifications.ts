import { z } from "zod";

export const DEFAULT_LOW_BALANCE_THRESHOLD_MICROS = 10_000_000;

export const BillingAlertSettings = z.object({
  accountId: z.uuid(),
  lowBalanceThresholdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type BillingAlertSettings = z.infer<typeof BillingAlertSettings>;
export const UpdateBillingAlertSettingsRequest = BillingAlertSettings.strict();
export type UpdateBillingAlertSettingsRequest = z.infer<typeof UpdateBillingAlertSettingsRequest>;

export const BillingCreditNotificationKind = z.enum([
  "low_balance",
  "exhausted",
  "unusual_spend",
  "topup_success",
  "topup_failed",
  "cap_reached",
]);
export type BillingCreditNotificationKind = z.infer<typeof BillingCreditNotificationKind>;
export const BILLING_CREDIT_EVENT_TYPES = [
  "billing.credits.low_balance",
  "billing.credits.exhausted",
  "billing.credits.unusual_spend",
  "billing.credits.topup_success",
  "billing.credits.topup_failed",
  "billing.credits.cap_reached",
] as const;

export const BillingCreditNotificationDetails = z
  .object({
    availableBalanceMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    amountMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    lowBalanceThresholdMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    lastHourSpendMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    baselineHourlySpendMicros: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
export type BillingCreditNotificationDetails = z.infer<typeof BillingCreditNotificationDetails>;

/** Organization events deliberately do not enter a workspace's event feed. */
export const BillingCreditNotification = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  kind: BillingCreditNotificationKind,
  eventType: z.enum(BILLING_CREDIT_EVENT_TYPES),
  details: BillingCreditNotificationDetails,
  createdAt: z.iso.datetime(),
  read: z.boolean(),
  action: z.object({ label: z.literal("Manage billing"), path: z.string() }),
});
export type BillingCreditNotification = z.infer<typeof BillingCreditNotification>;
export const ListBillingCreditNotificationsResponse = z.object({
  notifications: z.array(BillingCreditNotification),
});
export type ListBillingCreditNotificationsResponse = z.infer<
  typeof ListBillingCreditNotificationsResponse
>;
