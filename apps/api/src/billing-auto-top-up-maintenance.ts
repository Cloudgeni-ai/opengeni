import type { ApiRouteDeps } from "@opengeni/core";
import { listBillingCreditAlertAccounts } from "@opengeni/db";
import { createBillingAutoTopUpService } from "./routes/billing-auto-top-up";

const PAGE_SIZE = 50;
const PERIOD_MS = 60_000;
type MaintenancePorts = {
  discover(after: string | null, limit: number): Promise<string[]>;
  process(accountId: string): Promise<void>;
  onError(error: unknown, accountId?: string): void;
};

/** One keyset page at a time; neither overlapping timer ticks nor one broken
 * account can monopolize this replica. Cross-replica authority stays in the DB
 * reservation/confirmation fence, never in this advisory cursor. */
export function billingAutoTopUpMaintenance(ports: MaintenancePorts) {
  let cursor: string | null = null;
  let active = false;
  let stopped = false;
  let currentPass = Promise.resolve();
  const report = (error: unknown, accountId?: string) => {
    try {
      ports.onError(error, accountId);
    } catch {
      // An observability failure must not lose recovery's next pass.
    }
  };
  return {
    run(): Promise<void> {
      if (active || stopped) return Promise.resolve();
      active = true;
      currentPass = (async () => {
        try {
          const accounts = await ports.discover(cursor, PAGE_SIZE);
          for (const accountId of accounts) {
            if (stopped) break;
            try {
              await ports.process(accountId);
            } catch (error) {
              report(error, accountId);
            }
            cursor = accountId;
          }
          if (accounts.length < PAGE_SIZE) cursor = null;
        } catch (error) {
          report(error);
        } finally {
          active = false;
        }
      })();
      return currentPass;
    },
    stop() {
      stopped = true;
      return currentPass;
    },
  };
}

type Maintenance = ReturnType<typeof billingAutoTopUpMaintenance>;
type MaintenanceHandle = { stop(): Promise<void> };
const started = new WeakMap<object, MaintenanceHandle>();

/** Stripe I/O belongs to the API process. Start even with fresh charging off:
 * already-reserved payments still need reconciliation and outbox delivery. */
export function startBillingAutoTopUpMaintenance(
  deps: ApiRouteDeps,
  createMaintenance: (deps: ApiRouteDeps) => Maintenance = (current) => {
    const service = createBillingAutoTopUpService(current);
    return billingAutoTopUpMaintenance({
      discover: (after, limit) => listBillingCreditAlertAccounts(current.db, after, limit),
      process: (accountId) => service.process(accountId),
      onError: (_error, accountId) => {
        current.observability?.warn("Automatic top-up reconciliation will retry", {
          ...(accountId ? { accountId } : {}),
        });
      },
    });
  },
): MaintenanceHandle | null {
  if (deps.settings.billingMode !== "stripe" || !deps.settings.stripeSecretKey) return null;
  const existing = started.get(deps.db);
  if (existing) return existing;
  const maintenance = createMaintenance(deps);
  const timer = setInterval(() => void maintenance.run(), PERIOD_MS);
  timer.unref?.();
  const handle = {
    stop() {
      clearInterval(timer);
      const stopped = maintenance.stop();
      if (started.get(deps.db) === handle) started.delete(deps.db);
      return stopped;
    },
  };
  started.set(deps.db, handle);
  void maintenance.run();
  return handle;
}
