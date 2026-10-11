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
import {
  subscriptionCoreProvider,
  subscriptionCoreProviderIds,
} from "./subscription-core-providers";
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
  return await providerAuthorityV2ForAcceptance(tx, provider, input);
}

async function providerAuthorityV2ForAcceptance(
  tx: Database,
  provider: ProviderId,
  input: Parameters<typeof subscriptionAuthorityV2ForAcceptanceInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
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

/**
 * One v2 value from each registered provider's own value (design 5.3,
 * "Accepted authority across the cutover"): `null` when no provider wrote
 * one, else every provider's personal entries, in provider order. With one
 * registered provider it is that provider's value.
 */
function mergedAuthorityV2(
  values: readonly (SubscriptionPersonalAuthorityV2 | null)[],
): SubscriptionPersonalAuthorityV2 | null {
  const written = values.filter(
    (value): value is SubscriptionPersonalAuthorityV2 => value !== null,
  );
  if (written.length === 0) return null;
  return SubscriptionPersonalAuthorityV2.parse({
    version: 2,
    personal: written.flatMap((value) => value.personal),
  });
}

/**
 * The v2 value a new acceptance freezes, for every provider on the shared
 * core: each registered provider's entry (its own cutover gate, owner and
 * generation rules), merged into the one value the carrier stores. A
 * provider whose cutover is not enabled for the account contributes nothing;
 * `null` when none does (v1 stays authoritative).
 */
export async function coreSubscriptionAuthorityV2ForAcceptanceInTransaction(
  tx: Database,
  input: Parameters<typeof subscriptionAuthorityV2ForAcceptanceInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  if (!(await acceptanceWriterPresent(tx))) return null;
  const values: (SubscriptionPersonalAuthorityV2 | null)[] = [];
  for (const provider of subscriptionCoreProviderIds()) {
    values.push(await providerAuthorityV2ForAcceptance(tx, provider as ProviderId, input));
  }
  return mergedAuthorityV2(values);
}

/** Whether any registered provider's accepted work carries v2 in this organization. */
export async function coreSubscriptionAuthorityV2ActiveInTransaction(
  tx: Database,
  accountId: string,
): Promise<boolean> {
  if (!(await acceptanceWriterPresent(tx))) return false;
  for (const provider of subscriptionCoreProviderIds()) {
    const cutover = await readSubscriptionProviderCutoverState(tx, {
      accountId,
      provider: provider as ProviderId,
    });
    if (cutover === "enabled") return true;
  }
  return false;
}

/**
 * A derived carrier's value: its source's frozen value verbatim (every
 * provider's entries), or the empty value once any provider's v2 is active.
 */
export async function coreSubscriptionAuthorityV2OrEmptyInTransaction(
  tx: Database,
  accountId: string,
  frozen: SubscriptionPersonalAuthorityV2 | null | undefined,
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  if (frozen !== null && frozen !== undefined) return frozen;
  return (await coreSubscriptionAuthorityV2ActiveInTransaction(tx, accountId))
    ? EMPTY_SUBSCRIPTION_AUTHORITY_V2
    : null;
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
  if (!(await taskWriterPresent(tx))) return null;
  return await providerTaskAuthorityV2(tx, provider, input);
}

async function taskWriterPresent(tx: Database): Promise<boolean> {
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)'
      ) is not null as present`,
  );
  return present?.present === true;
}

async function providerTaskAuthorityV2(
  tx: Database,
  provider: ProviderId,
  input: Parameters<typeof subscriptionAuthorityV2ForScheduledTaskInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
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

/** A scheduled task's frozen v2 value at creation, merged over every registered provider. */
export async function coreSubscriptionAuthorityV2ForScheduledTaskInTransaction(
  tx: Database,
  input: Parameters<typeof subscriptionAuthorityV2ForScheduledTaskInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  if (!(await taskWriterPresent(tx))) return null;
  const values: (SubscriptionPersonalAuthorityV2 | null)[] = [];
  for (const provider of subscriptionCoreProviderIds()) {
    values.push(await providerTaskAuthorityV2(tx, provider as ProviderId, input));
  }
  return mergedAuthorityV2(values);
}

/** A carrier of delivered inbox input (0713 carrier kinds). */
export type InboxAuthorityCarrier = {
  kind: "session_turn" | "session_system_update";
  id: string;
};

/** A carrier of accepted authority (the compatibility migration's carrier kinds). */
export type SubscriptionAuthorityCarrier = {
  kind:
    | "session_initial"
    | "session_turn"
    | "scheduled_task"
    | "scheduled_task_revision"
    | "session_system_update"
    | "session_system_update_outbox";
  workspaceId: string;
  id: string;
  /** The revision of a `scheduled_task_revision` carrier; null for every other kind. */
  taskAuthorityRevision?: number | null;
};

/**
 * The providers whose own drained cutover holds compatibility records (a
 * receipt with a real commit time): empty while only providers cut over
 * before receipts (`-infinity`) are on the core, and
 * on historical ledgers without the routine. One read.
 */
async function compatProvidersInTransaction(tx: Database): Promise<string[]> {
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_authority_compat_providers()'
      ) is not null as present`,
  );
  if (present?.present !== true) return [];
  const [row] = await rawRows<{ providers: string[] | null }>(
    tx,
    sql`select opengeni_private.subscription_authority_compat_providers() as providers`,
  );
  return row?.providers ?? [];
}

/** The carrier row of one carrier, as a SQL predicate on `carrier` (its relation alias). */
function carrierRelation(
  carrier: SubscriptionAuthorityCarrier & {
    kind: Exclude<SubscriptionAuthorityCarrier["kind"], "scheduled_task_revision">;
  },
) {
  switch (carrier.kind) {
    case "session_initial":
      return sql`sessions carrier where carrier.id = ${carrier.id}::uuid`;
    case "session_turn":
      return sql`session_turns carrier where carrier.id = ${carrier.id}::uuid`;
    case "scheduled_task":
      return sql`scheduled_tasks carrier where carrier.id = ${carrier.id}::uuid`;
    case "session_system_update":
      return sql`session_system_updates carrier where carrier.id = ${carrier.id}::uuid`;
    case "session_system_update_outbox":
      return sql`session_system_update_outbox carrier where carrier.id = ${carrier.id}::uuid`;
  }
}

/**
 * Copy each provider's compatibility record into carriers (design 5.3,
 * "Accepted authority across the cutover", Writing), for every provider whose
 * drained cutover committed a receipt. The database routine resolves each
 * carrier's source itself and accepts no content; the commit-time trigger
 * then requires exactly that copy. Call it once the carrier and every row its
 * source resolver reads (for a delivering turn, its delivered updates) are
 * written. A named carrier this transaction did not insert (an upsert that
 * updated an existing row, a task revision its SQL writer did not record) is
 * skipped: its record, if any, was copied when it was inserted. Inert, after
 * one read, while no provider has such a receipt.
 */
export async function copySubscriptionAuthorityCompatInTransaction(
  tx: Database,
  carriers: readonly SubscriptionAuthorityCarrier[],
): Promise<void> {
  if (carriers.length === 0) return;
  const providers = await compatProvidersInTransaction(tx);
  if (providers.length === 0) return;
  for (const carrier of carriers) {
    const revision = carrier.taskAuthorityRevision ?? null;
    // Task revisions are not readable by the application role: their
    // writers always insert a new revision number in this transaction, so
    // existence (the security-definer reader answers NULL without a row) is
    // the guard; a revision from an earlier transaction fails the copy closed.
    const inserted =
      carrier.kind === "scheduled_task_revision"
        ? sql`opengeni_private.read_subscription_authority_compat(
            listed.provider, ${carrier.kind}, ${carrier.workspaceId}::uuid, ${carrier.id}::uuid,
            ${revision}::bigint) is not null`
        : sql`exists (select 1 from ${carrierRelation({ ...carrier, kind: carrier.kind })}
            and carrier.workspace_id = ${carrier.workspaceId}::uuid
            and carrier.authority_inserted_at = pg_catalog.transaction_timestamp())`;
    await rawRows(
      tx,
      sql`select opengeni_private.copy_subscription_authority_compat(
          listed.provider, ${carrier.kind}, ${carrier.workspaceId}::uuid, ${carrier.id}::uuid,
          ${revision}::bigint
        ) as copied
        from unnest(array[${sql.join(
          providers.map((provider) => sql`${provider}`),
          sql`, `,
        )}]::text[]) listed(provider)
        where ${inserted}`,
    );
  }
}

/**
 * Whether the provider's drained cutover receipt exists (any commit time):
 * after it, no code computes the provider's v1 value from live state (design
 * 5.3, "v1 columns after a provider's cutover"). False on historical ledgers
 * without the receipt routine.
 */
export async function subscriptionProviderCutoverCommittedInTransaction(
  tx: Database,
  provider: string,
): Promise<boolean> {
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_provider_cutover_committed(text)'
      ) is not null as present`,
  );
  if (present?.present !== true) return false;
  const [committed] = await rawRows<{ committed: boolean }>(
    tx,
    sql`select opengeni_private.subscription_provider_cutover_committed(${provider}) as committed`,
  );
  return committed?.committed === true;
}

/**
 * The effective accepted authority of each inbox carrier (0713's reader), per
 * provider whose own drained cutover holds compatibility records (design 5.3,
 * inbox batching): keyed `kind:id`, one value per provider. Empty while no
 * provider has a receipt with a real commit time, and on historical ledgers
 * without the reader, so batching keys are unchanged until then.
 */
export async function subscriptionAuthorityCompatForCarriersInTransaction(
  tx: Database,
  input: { workspaceId: string; carriers: readonly InboxAuthorityCarrier[] },
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const effective = new Map<string, Record<string, unknown>>();
  if (input.carriers.length === 0) return effective;
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.subscription_authority_compat_providers()'
      ) is not null as present`,
  );
  if (present?.present !== true) return effective;
  const carriers = sql.join(
    input.carriers.map((carrier) => sql`(${carrier.kind}::text, ${carrier.id}::uuid)`),
    sql`, `,
  );
  const rows = await rawRows<{ provider: string; kind: string; id: string; authority: unknown }>(
    tx,
    sql`select listed.provider, carrier.kind, carrier.id::text as id,
        opengeni_private.read_subscription_authority_compat(
          listed.provider, carrier.kind, ${input.workspaceId}::uuid, carrier.id, null
        ) as authority
      from unnest(opengeni_private.subscription_authority_compat_providers()) listed(provider)
      cross join (values ${carriers}) carrier(kind, id)`,
  );
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    effective.set(key, { ...effective.get(key), [row.provider]: row.authority ?? null });
  }
  return effective;
}
