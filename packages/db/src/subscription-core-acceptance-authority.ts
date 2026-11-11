/**
 * The v2 accepted-authority writer at acceptance (M3 PR 2a, inventory
 * EP-T11..T15), for one provider on the shared core. It returns the
 * immutable v2 value to freeze on the accepted turn:
 *
 * - a personal entry for the provider only for exact owner-caused acceptance
 *   (the authenticated request subject, or the session's frozen creator in
 *   the trusted session-start context, is the session owner) in the owner's
 *   private session or Personal workspace, with the owner's one current
 *   active authority generation;
 * - an exact session-and-connection-restricted entry for an authenticated
 *   participant's own explicit personal choice in a shared session (the
 *   participant need not be the session creator). Only fresh human acceptance
 *   captures this; retained work copies its existing value verbatim;
 * - an empty v2 value for other shared sessions, another sender's choice,
 *   service, API-key and agent acceptance, ownerless sessions, or an ambiguous
 *   private generation set. Shared visibility never enables personal fallback.
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
  return await providerAuthorityV2ForAcceptance(tx, provider, input);
}

async function providerAuthorityV2ForAcceptance(
  tx: Database,
  provider: ProviderId,
  input: Parameters<typeof subscriptionAuthorityV2ForAcceptanceInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
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
 * core: each registered provider's entry (its own owner and generation
 * rules), merged into the one value the carrier stores; `null` when no
 * provider wrote one.
 */
export async function coreSubscriptionAuthorityV2ForAcceptanceInTransaction(
  tx: Database,
  input: Parameters<typeof subscriptionAuthorityV2ForAcceptanceInTransaction>[2],
): Promise<SubscriptionPersonalAuthorityV2 | null> {
  const values: (SubscriptionPersonalAuthorityV2 | null)[] = [];
  for (const provider of subscriptionCoreProviderIds()) {
    values.push(await providerAuthorityV2ForAcceptance(tx, provider as ProviderId, input));
  }
  return mergedAuthorityV2(values);
}

/** The v2 value that grants no personal authority (shared capacity only). */
export const EMPTY_SUBSCRIPTION_AUTHORITY_V2: SubscriptionPersonalAuthorityV2 = Object.freeze({
  version: 2,
  personal: [],
}) as SubscriptionPersonalAuthorityV2;

/**
 * A carrier's frozen value verbatim (every provider's entries), or the empty
 * value when it froze none: a missing value never widens to personal
 * authority.
 */
export function subscriptionAuthorityV2OrEmpty(
  frozen: SubscriptionPersonalAuthorityV2 | null | undefined,
): SubscriptionPersonalAuthorityV2 {
  return frozen ?? EMPTY_SUBSCRIPTION_AUTHORITY_V2;
}

/**
 * A scheduled task's frozen v2 value at creation (M3 PR 3b, EP-T15), from
 * `subscription_core_task_authority_v2`: the acceptance rule for the exact
 * accepting human.
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
  return await providerTaskAuthorityV2(tx, provider, input);
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
  const values: (SubscriptionPersonalAuthorityV2 | null)[] = [];
  for (const provider of subscriptionCoreProviderIds()) {
    values.push(await providerTaskAuthorityV2(tx, provider as ProviderId, input));
  }
  return mergedAuthorityV2(values);
}

/** A carrier of delivered inbox input (0716 carrier kinds). */
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
 * before receipts (`-infinity`) are on the core. One read.
 */
async function compatProvidersInTransaction(tx: Database): Promise<string[]> {
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
 * updated an existing row, a task revision an earlier transaction inserted
 * and a replayed or detached materialization returned) is
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
    // Task revisions are not readable by the application role, so 0728's
    // owner-run predicate answers "inserted by this transaction" for them: a
    // replayed or detached materialization returns an earlier revision, which
    // already holds whatever record its insertion copied.
    const inserted =
      carrier.kind === "scheduled_task_revision"
        ? sql`opengeni_private.subscription_authority_carrier_inserted_now(
            ${carrier.kind}, ${carrier.workspaceId}::uuid, ${carrier.id}::uuid, ${revision}::bigint)`
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
 * The effective accepted authority of each inbox carrier (0716's reader), per
 * provider whose own drained cutover holds compatibility records (design 5.3,
 * inbox batching): keyed `kind:id`, one value per provider. Empty while no
 * provider has a receipt with a real commit time, so batching keys are
 * unchanged until then.
 */
export async function subscriptionAuthorityCompatForCarriersInTransaction(
  tx: Database,
  input: { workspaceId: string; carriers: readonly InboxAuthorityCarrier[] },
): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
  const effective = new Map<string, Record<string, unknown>>();
  if (input.carriers.length === 0) return effective;
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
