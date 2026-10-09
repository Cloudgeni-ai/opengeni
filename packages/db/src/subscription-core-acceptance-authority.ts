/**
 * The v2 accepted-authority writer for Codex at acceptance (M3 PR 2a,
 * inventory EP-T11..T15). Inert until the account's Codex cutover is enabled:
 * the database function returns NULL and the turn keeps no v2 value, so v1
 * stays authoritative. With the cutover enabled it returns the immutable v2
 * value to freeze on the accepted turn:
 *
 * - a Codex personal entry only for exact owner-caused acceptance (the
 *   authenticated request subject, or the session's frozen creator in the
 *   trusted session-start context, is the session owner) in the owner's
 *   private session or Personal workspace, with the owner's one current
 *   active authority generation;
 * - an empty v2 value for everything else (shared sessions, co-members,
 *   service, API-key and agent acceptance, ownerless sessions, an ambiguous
 *   generation set).
 *
 * Claude and SuperGrok keep their v1 snapshots; v2 carries only Codex.
 */
import { sql } from "drizzle-orm";
import { SubscriptionPersonalAuthorityV2 } from "@opengeni/contracts";
import { rawRows, type Database } from "./database";
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
async function codexAcceptanceWriterPresent(tx: Database): Promise<boolean> {
  const [row] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_codex_acceptance_authority_v2(uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  return row?.present === true;
}

export async function codexSubscriptionAuthorityV2ForAcceptanceInTransaction(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    /** The exact human whose acceptance this is; null for non-human acceptance. */
    acceptingSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  // The common case (no enabled Codex cutover) writes nothing and never
  // reaches the database routine; it rechecks the gate itself.
  if (!(await codexAcceptanceWriterPresent(tx))) return null;
  const cutover = await readSubscriptionProviderCutoverState(tx, {
    accountId: input.accountId,
    provider: "codex",
  });
  if (cutover !== "enabled") return null;
  const [row] = await rawRows<{ authority: unknown }>(
    tx,
    sql`select opengeni_private.subscription_codex_acceptance_authority_v2(
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
 * Whether accepted work in this organization carries a Codex v2 value: the
 * acceptance writer exists and the cutover is enabled. Carriers write nothing
 * otherwise (v1 stays authoritative).
 */
export async function codexSubscriptionAuthorityV2ActiveInTransaction(
  tx: Database,
  accountId: string,
): Promise<boolean> {
  if (!(await codexAcceptanceWriterPresent(tx))) return false;
  return (
    (await readSubscriptionProviderCutoverState(tx, { accountId, provider: "codex" })) === "enabled"
  );
}

/**
 * A carrier's frozen value, or (once the cutover is active) the empty value
 * when it froze none: work accepted after the cutover always carries v2, and
 * a missing value never widens to personal authority.
 */
export async function codexSubscriptionAuthorityV2OrEmptyInTransaction(
  tx: Database,
  accountId: string,
  frozen: SubscriptionPersonalAuthorityV2 | null | undefined,
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  if (frozen !== null && frozen !== undefined) return frozen;
  return (await codexSubscriptionAuthorityV2ActiveInTransaction(tx, accountId))
    ? EMPTY_SUBSCRIPTION_AUTHORITY_V2
    : null;
}

/**
 * A scheduled task's frozen v2 value at creation (M3 PR 3b, EP-T15), from
 * `subscription_codex_task_authority_v2`: the acceptance rule for the exact
 * accepting human. `null` without an enabled cutover (or before 0679).
 */
export async function codexSubscriptionAuthorityV2ForScheduledTaskInTransaction(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    reusableSessionId: string | null;
    acceptingSubjectId: string | null;
  },
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_codex_task_authority_v2(uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  if (present?.present !== true) return null;
  const [row] = await rawRows<{ authority: unknown }>(
    tx,
    sql`select opengeni_private.subscription_codex_task_authority_v2(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid,
        ${input.reusableSessionId}::uuid, ${input.acceptingSubjectId}
      ) as authority`,
  );
  if (!row || row.authority === null || row.authority === undefined) return null;
  return SubscriptionPersonalAuthorityV2.parse(row.authority);
}
