import type { Settings } from "@opengeni/config";
import { readManagedAuthNewSignupsSwitch, type Database } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";

/**
 * Decides whether a new managed account may be created right now.
 *
 * `OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED` is the deployment ceiling (read at
 * startup). While it allows sign-ups, the newest revision of the operator
 * runtime switch (migration 0585) decides, read on every call so a flip
 * applies to the next request on every API replica without a restart.
 *
 * Fail-safe: if the read fails, the last value this process observed wins;
 * before any successful read, the deployment ceiling wins. A missing revision
 * (pre-0585 schema) also follows the ceiling.
 */
export type ManagedAuthNewSignupsGate = {
  signupsOpen(): Promise<boolean>;
};

export function createManagedAuthNewSignupsGate(input: {
  db: Database;
  settings: Pick<Settings, "managedAuthNewSignupsEnabled">;
  observability?: Pick<Observability, "warn"> | undefined;
}): ManagedAuthNewSignupsGate {
  const ceiling = input.settings.managedAuthNewSignupsEnabled !== false;
  let lastKnown: boolean | null = null;
  return {
    async signupsOpen() {
      if (!ceiling) return false;
      try {
        const current = await readManagedAuthNewSignupsSwitch(input.db);
        lastKnown = current ? current.signupsEnabled : true;
        return lastKnown;
      } catch (error) {
        try {
          input.observability?.warn("Managed auth new signups switch read failed", {
            dependency: "managed_auth_new_signups_switch",
            fallback: lastKnown === null ? "deployment_ceiling" : "last_known",
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
        } catch {
          // An observer failure must not decide a sign-up.
        }
        return lastKnown ?? ceiling;
      }
    },
  };
}
