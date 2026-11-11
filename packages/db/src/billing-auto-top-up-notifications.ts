import { sql } from "drizzle-orm";
import { BillingCreditNotificationDetails } from "@opengeni/contracts/billing-credit-notifications";
import type { AutoTopUpNotificationPort } from "./billing-auto-top-up";
import { enqueueBillingCreditNotification } from "./billing-credit-notifications";
import { generalAvailableCreditMicros, getBillingBalance } from "./credit-balances";
import { rawRows, withAccountRls } from "./database";

/** Adapter to the shared billing outbox, not a second delivery mechanism.
 * The automatic top-up journal invokes it under its organization fence and in
 * the same transaction as settlement/delivery checkpointing. */
export const enqueueBillingAutoTopUpNotification: AutoTopUpNotificationPort = async (db, event) => {
  await withAccountRls(db, event.accountId, async (tx) => {
    const [existing] = await rawRows<{ kind: string; details: unknown }>(
      tx,
      sql`select kind, details from billing_credit_notifications
      where account_id = ${event.accountId}::uuid and operation_key = ${event.operationKey}`,
    );
    // A cap is observed repeatedly under one month/settings key while the wallet
    // can keep changing. Replay its committed snapshot, not today's balance.
    const details = existing
      ? BillingCreditNotificationDetails.parse(existing.details)
      : {
          availableBalanceMicros: generalAvailableCreditMicros(
            await getBillingBalance(tx, event.accountId),
          ),
          amountMicros: event.amountMicros,
        };
    if (existing && (existing.kind !== event.kind || details.amountMicros !== event.amountMicros))
      throw new Error("Automatic top-up notification key already belongs to a different event");
    await enqueueBillingCreditNotification(tx, {
      accountId: event.accountId,
      operationKey: event.operationKey,
      kind: event.kind,
      details,
    });
  });
};
