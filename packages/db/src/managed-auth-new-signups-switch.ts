import { sql } from "drizzle-orm";

import type { Database } from "./database";
import { rawRows } from "./database";

/**
 * The newest revision of the deployment-level runtime switch for new managed
 * account sign-ups (migration 0585). The API creates a new Better Auth user
 * only while both this switch and its `OPENGENI_MANAGED_AUTH_NEW_SIGNUPS_ENABLED`
 * master ceiling allow it. Operators change it only through the owner-only
 * audited SQL setter `set_managed_auth_new_signups_enabled`; runtime roles can
 * only read it.
 */
export type ManagedAuthNewSignupsSwitchState = {
  revision: number;
  signupsEnabled: boolean;
  changedAt: Date;
};

/** Returns null when no revision exists (or before migration 0585 is applied). */
export async function readManagedAuthNewSignupsSwitch(
  db: Database,
): Promise<ManagedAuthNewSignupsSwitchState | null> {
  const [row] = await rawRows<{
    revision: number | string;
    signups_enabled: boolean;
    changed_at: Date | string;
  }>(
    db,
    sql`
    select revision.revision, revision.signups_enabled, revision.changed_at
    from opengeni_private.managed_auth_new_signups_switch_revisions revision
    order by revision.revision desc
    limit 1
  `,
  );
  if (!row) return null;
  return {
    revision: Number(row.revision),
    signupsEnabled: row.signups_enabled === true,
    changedAt: row.changed_at instanceof Date ? row.changed_at : new Date(row.changed_at),
  };
}
