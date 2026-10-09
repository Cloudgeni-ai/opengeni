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
 * authoritative. A present routine is cached; an absent one is re-checked,
 * since a schema only moves forward. The routine's migration comes after the
 * cutover relation's, so its presence also proves the relation.
 */
let acceptanceWriterPresent = false;
async function codexAcceptanceWriterPresent(tx: Database): Promise<boolean> {
  if (acceptanceWriterPresent) return true;
  const [row] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_codex_acceptance_authority_v2(uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  acceptanceWriterPresent = row?.present === true;
  return acceptanceWriterPresent;
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
