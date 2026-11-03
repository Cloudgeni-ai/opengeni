import { deliverBillingCreditNotification, type ManagedEmailTransport } from "@opengeni/core";
import { listBillingCreditAlertAccounts, type Database } from "@opengeni/db";

const started = new WeakMap<object, () => Promise<void>>();
/** Server-owned managed-email pump, with one pass at a time and a draining stop. */
export function startBillingCreditNotificationDelivery(
  db: Database,
  transport: ManagedEmailTransport,
  appUrl: string,
  intervalMs = 60_000,
): () => Promise<void> {
  const existing = started.get(db);
  if (existing) return existing;
  let stopped = false;
  let running: Promise<void> | undefined;
  let cursor: string | null = null;
  const drain = async () => {
    try {
      const accounts = await listBillingCreditAlertAccounts(db, cursor);
      for (const accountId of accounts) {
        if (stopped) break;
        try {
          for (let count = 0; count < 4; count++) {
            if (stopped) break;
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
    }
  };
  const tick = () => {
    if (stopped || running) return;
    running = drain().finally(() => {
      running = undefined;
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    await running;
    // An old stop can be called again after another server has restarted.
    if (started.get(db) === stop) started.delete(db);
  };
  started.set(db, stop);
  queueMicrotask(tick);
  return stop;
}
