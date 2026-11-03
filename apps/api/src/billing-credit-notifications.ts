import { deliverBillingCreditNotification, type ManagedEmailTransport } from "@opengeni/core";
import { listBillingCreditAlertAccounts, type Database } from "@opengeni/db";

const started = new WeakSet<object>();
/** The API already owns managed-email delivery. Reuse it, not a new service. */
export function startBillingCreditNotificationDelivery(
  db: Database,
  transport: ManagedEmailTransport,
  appUrl: string,
): void {
  if (started.has(db)) return;
  started.add(db);
  let active = false;
  let cursor: string | null = null;
  const drain = async () => {
    if (active) return;
    active = true;
    try {
      const accounts = await listBillingCreditAlertAccounts(db, cursor);
      for (const accountId of accounts) {
        try {
          for (let count = 0; count < 4; count++) {
            if (!(await deliverBillingCreditNotification({ db, accountId, transport, appUrl })))
              break;
          }
        } catch {
          /* The committed claim is recovered on the next pass. */
        }
        cursor = accountId;
      }
      if (accounts.length < 50) cursor = null;
    } catch {
      /* Discovery may retry without losing a delivery obligation. */
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => void drain(), 60_000);
  timer.unref?.();
  void drain();
}
