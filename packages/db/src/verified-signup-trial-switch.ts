import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * The newest revision of the deployment-level runtime switch for the one-time
 * verified signup trial credit (migration 0521). A grant needs both this switch
 * and the API's `OPENGENI_VERIFIED_SIGNUP_TRIAL_CREDITS_ENABLED` master opt-in.
 * Operators change it only through the owner-only audited SQL setter
 * `set_verified_signup_trial_credits_enabled`; runtime roles can only read it.
 */
export type VerifiedSignupTrialSwitchState = {
  revision: number;
  grantsEnabled: boolean;
  changedAt: Date;
};

/** Returns null when no revision exists; the grant trigger treats that as off. */
export async function readVerifiedSignupTrialSwitch(
  db: Database,
): Promise<VerifiedSignupTrialSwitchState | null> {
  const [row] = await rawRows<{
    revision: number | string;
    grants_enabled: boolean;
    changed_at: Date | string;
  }>(
    db,
    sql`
    select revision.revision, revision.grants_enabled, revision.changed_at
    from opengeni_private.verified_signup_trial_switch_revisions revision
    order by revision.revision desc
    limit 1
  `,
  );
  if (!row) return null;
  return {
    revision: Number(row.revision),
    grantsEnabled: row.grants_enabled === true,
    changedAt: row.changed_at instanceof Date ? row.changed_at : new Date(row.changed_at),
  };
}
