/**
 * The v2 accepted-authority writer at acceptance (M3 PR 2a, inventory
 * EP-T11..T15), for one provider on the shared core. Inert until the
 * account's cutover for that provider is enabled: the database function
 * returns NULL and the turn keeps no v2 value, so v1 stays authoritative.
 * With the cutover enabled it returns the immutable v2 value to freeze on the
 * accepted turn:
 *
 * - a personal entry for the provider only for exact owner-caused acceptance
 *   (the authenticated request subject, or the session's frozen creator in
 *   the trusted session-start context, is the session owner) in the owner's
 *   private session or Personal workspace, with the owner's one current
 *   active authority generation;
 * - an empty v2 value for everything else (shared sessions, co-members,
 *   service, API-key and agent acceptance, ownerless sessions, an ambiguous
 *   generation set).
 *
 * Providers not yet on the core keep their v1 snapshots.
 */
import { sql } from "drizzle-orm";
import { SubscriptionPersonalAuthorityV2 } from "@opengeni/contracts";
import type { ProviderId } from "@opengeni/subscriptions";
import { rawRows, type Database } from "./database";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import { readSubscriptionProviderCutoverState } from "./subscription-core-repository";

/**
 * Acceptance runs on every prompt, including against databases whose ledger
 * predates the shared subscription core (historical migration fixtures stage
 * old schemas and still accept prompts) or predates the writer itself (an
 * enabled cutover row cannot make acceptance call a routine that is not
 * there yet). Without the writer routine nothing is written, so v1 stays
 * authoritative. The presence is checked on the accepting connection every
 * time: a process can hold connections to databases at different ledger
 * positions (the test runner does), so a process-wide positive cache would
 * let an older database read a relation it does not have. The routine's
 * migration comes after the cutover relation's, so its presence also proves
 * the relation.
 */
async function acceptanceWriterPresent(tx: Database): Promise<boolean> {
  const [row] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  return row?.present === true;
}

export async function subscriptionAuthorityV2ForAcceptanceInTransaction(
  tx: Database,
  provider: ProviderId,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    /** The exact human whose acceptance this is; null for non-human acceptance. */
    acceptingSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  subscriptionCoreProvider(provider);
  // The common case (no enabled cutover) writes nothing and never
  // reaches the database routine; it rechecks the gate itself.
  if (!(await acceptanceWriterPresent(tx))) return null;
  const cutover = await readSubscriptionProviderCutoverState(tx, {
    accountId: input.accountId,
    provider,
  });
  if (cutover !== "enabled") return null;
  const [row] = await rawRows<{ authority: unknown }>(
    tx,
    sql`select opengeni_private.subscription_core_acceptance_authority_v2(${provider},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
        ${input.acceptingSubjectId}
      ) as authority`,
  );
  if (!row || row.authority === null || row.authority === undefined) return null;
  return SubscriptionPersonalAuthorityV2.parse(row.authority);
}

/** The v2 value that grants no personal authority (shared capacity only). */
export const EMPTY_SUBSCRIPTION_AUTHORITY_V2: SubscriptionPersonalAuthorityV2 = Object.freeze({
  version: 2,
  personal: [],
}) as SubscriptionPersonalAuthorityV2;

/**
 * Whether accepted work in this organization carries a v2 value for the
 * provider: the
 * acceptance writer exists and the cutover is enabled. Carriers write nothing
 * otherwise (v1 stays authoritative).
 */
export async function subscriptionAuthorityV2ActiveInTransaction(
  tx: Database,
  provider: ProviderId,
  accountId: string,
): Promise<boolean> {
  subscriptionCoreProvider(provider);
  if (!(await acceptanceWriterPresent(tx))) return false;
  return (await readSubscriptionProviderCutoverState(tx, { accountId, provider })) === "enabled";
}

/**
 * A carrier's frozen value, or (once the cutover is active) the empty value
 * when it froze none: work accepted after the cutover always carries v2, and
 * a missing value never widens to personal authority.
 */
export async function subscriptionAuthorityV2OrEmptyInTransaction(
  tx: Database,
  provider: ProviderId,
  accountId: string,
  frozen: SubscriptionPersonalAuthorityV2 | null | undefined,
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  subscriptionCoreProvider(provider);
  if (frozen !== null && frozen !== undefined) return frozen;
  return (await subscriptionAuthorityV2ActiveInTransaction(tx, provider, accountId))
    ? EMPTY_SUBSCRIPTION_AUTHORITY_V2
    : null;
}

/**
 * A scheduled task's frozen v2 value at creation (M3 PR 3b, EP-T15), from
 * `subscription_core_task_authority_v2`: the acceptance rule for the exact
 * accepting human. `null` without an enabled cutover (or before 0688).
 */
export async function subscriptionAuthorityV2ForScheduledTaskInTransaction(
  tx: Database,
  provider: ProviderId,
  input: {
    accountId: string;
    workspaceId: string;
    reusableSessionId: string | null;
    acceptingSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  subscriptionCoreProvider(provider);
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  if (present?.present !== true) return null;
  const [row] = await rawRows<{ authority: unknown }>(
    tx,
    sql`select opengeni_private.subscription_core_task_authority_v2(${provider},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid,
        ${input.reusableSessionId}::uuid, ${input.acceptingSubjectId}
      ) as authority`,
  );
  if (!row || row.authority === null || row.authority === undefined) return null;
  return SubscriptionPersonalAuthorityV2.parse(row.authority);
}
