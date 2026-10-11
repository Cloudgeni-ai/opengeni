/**
 * Which runtime serves one provider for one organization: the provider's
 * legacy path until its drained cutover commits, then the shared core.
 *
 * - `legacy`: the provider has no cutover receipt. Its accepted v1
 *   authority, tables and decision paths stay authoritative (design 5.3,
 *   decision 1); the core is never read for it. This costs one receipt read.
 * - `core`: the receipt exists and the organization's switch row is enabled.
 * - `maintenance`: the receipt exists but the switch row is disabled or
 *   missing. Fail closed: never the legacy path again after the one-way
 *   cutover, and never the core while an operator holds the organization.
 *
 * The receipt is read only through its boolean readiness function, never as
 * a date (a provider cut over before receipts existed has `-infinity`).
 */
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "../database";

export type SubscriptionCoreProviderRoute = "legacy" | "core" | "maintenance";

export async function readSubscriptionCoreProviderRoute(
  db: Database,
  input: { accountId: string; provider: string },
): Promise<SubscriptionCoreProviderRoute> {
  const [row] = await rawRows<{ committed: boolean; enabled: boolean | null }>(
    db,
    sql`select opengeni_private.subscription_provider_cutover_committed(${input.provider})
        as committed,
      (select cutover.enabled from subscription_provider_cutovers cutover
        where cutover.account_id = ${input.accountId}::uuid
          and cutover.provider = ${input.provider}) as enabled`,
  );
  if (row?.committed !== true) return "legacy";
  return row.enabled === true ? "core" : "maintenance";
}
