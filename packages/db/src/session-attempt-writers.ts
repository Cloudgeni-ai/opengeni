import { sql, type SQL } from "drizzle-orm";

/** Physical writers retain ownership after logical settlement. A durably
 * adopted background command owns its lifetime independently of the turn. */
export function sessionAttemptPendingWritersSql(
  attempt: SQL,
  options: { excludeCredentialCleanupOperation?: string } = {},
): SQL {
  return sql`sandbox_v2_attempt_writers_pending(
    ${attempt}.account_id, ${attempt}.workspace_id, ${attempt}.session_id, ${attempt}.id,
    ${options.excludeCredentialCleanupOperation ?? null}::uuid)`;
}
