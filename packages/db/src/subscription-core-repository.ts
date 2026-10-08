import { sql } from "drizzle-orm";
import type { ProviderId, SubscriptionSettingValues } from "@opengeni/subscriptions";
import { rawRows, type Database } from "./database";

export type EffectiveSubscriptionSettingsRow = {
  values: SubscriptionSettingValues;
  sources: {
    rotation: Record<string, "organization" | "workspace">;
    providers: Record<string, "organization" | "workspace">;
    fallbackOrder: Record<string, "organization" | "workspace">;
    crossProviderFailover: "organization" | "workspace";
    personalConnectionsAllowed: "organization" | "workspace";
    personalFallbackAllowed: "organization" | "workspace";
  };
};

/** Typed M2 persistence seam; no production selector calls this repository yet. */
export async function readSubscriptionEffectiveSettings(
  db: Database,
  accountId: string,
  workspaceId: string,
): Promise<EffectiveSubscriptionSettingsRow> {
  const [row] = await rawRows<{ effective: EffectiveSubscriptionSettingsRow }>(
    db,
    sql`select subscription_effective_settings(${accountId}::uuid, ${workspaceId}::uuid) as effective`,
  );
  if (!row) throw new Error("Subscription settings were not found");
  return row.effective;
}

export type SubscriptionConnectionAssignmentPolicy = {
  connectionId: string;
  provider: ProviderId;
  workspaceId: string;
  inferencePool: "workspace" | "organization";
  allocatorEnabled: boolean;
  allowedModelIds: string[] | null;
  excludedModels: string[];
  managedByWorkspaceId: string | null;
};

/** Reads both source memberships independently; policy values are never unioned. */
export async function listSubscriptionConnectionAssignmentPolicies(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    provider?: ProviderId;
    inferencePool?: "workspace" | "organization";
  },
): Promise<SubscriptionConnectionAssignmentPolicy[]> {
  const rows = await rawRows<{
    connection_id: string;
    provider: ProviderId;
    workspace_id: string;
    inference_pool: "workspace" | "organization";
    allocator_enabled: boolean;
    allowed_model_ids: string[] | null;
    excluded_models: string[];
    managed_by_workspace_id: string | null;
  }>(
    db,
    sql`select policy.connection_id::text as connection_id, connection.provider,
      policy.workspace_id::text as workspace_id, policy.inference_pool,
      policy.allocator_enabled, policy.allowed_model_ids, policy.excluded_models,
      policy.managed_by_workspace_id::text as managed_by_workspace_id
    from subscription_connection_assignment_policies policy
    join subscription_connections connection
      on connection.account_id = policy.account_id and connection.id = policy.connection_id
    where policy.account_id = ${input.accountId}::uuid
      and policy.workspace_id = ${input.workspaceId}::uuid
      and (${input.provider ?? null}::text is null or connection.provider = ${input.provider ?? null})
      and (${input.inferencePool ?? null}::text is null or policy.inference_pool = ${input.inferencePool ?? null})
    order by policy.connection_id, policy.inference_pool`,
  );
  return rows.map((row) => ({
    connectionId: row.connection_id,
    provider: row.provider,
    workspaceId: row.workspace_id,
    inferencePool: row.inference_pool,
    allocatorEnabled: row.allocator_enabled,
    allowedModelIds: row.allowed_model_ids,
    excludedModels: row.excluded_models,
    managedByWorkspaceId: row.managed_by_workspace_id,
  }));
}

/** Canonical IDs win; otherwise resolve one visible provider-scoped alias. */
export async function resolveSubscriptionConnectionId(
  db: Database,
  input: { accountId: string; provider: ProviderId; connectionId: string },
): Promise<string | null> {
  const [row] = await rawRows<{ id: string }>(
    db,
    sql`select coalesce(
      (select direct.id::text
       from subscription_connections direct
       where direct.account_id = ${input.accountId}::uuid
         and direct.provider = ${input.provider} and direct.id = ${input.connectionId}::uuid),
      (select canonical.id::text
       from subscription_connection_aliases alias
       join subscription_connections canonical
         on canonical.account_id = alias.account_id and canonical.provider = alias.provider
           and canonical.id = alias.connection_id
       where alias.account_id = ${input.accountId}::uuid
         and alias.provider = ${input.provider}
         and alias.alias_connection_id = ${input.connectionId}::uuid)
    ) as id`,
  );
  return row?.id ?? null;
}

export type SubscriptionSessionBinding = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  provider: ProviderId;
  connectionId: string | null;
  modelId: string;
  choice: "automatic" | "explicit";
  onlyThisModel: boolean;
  lastModelCallAt: Date | null;
  lastSwitchReason:
    | "initial"
    | "reselected_cold"
    | "failover_same_provider"
    | "failover_cross_provider"
    | "return_to_preferred"
    | "explicit_choice"
    | "revoked"
    | null;
  version: number;
};

export async function readSubscriptionSessionBinding(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<SubscriptionSessionBinding | null> {
  const [row] = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    provider: ProviderId;
    connection_id: string | null;
    model_id: string;
    choice: "automatic" | "explicit";
    only_this_model: boolean;
    last_model_call_at: Date | string | null;
    last_switch_reason: SubscriptionSessionBinding["lastSwitchReason"];
    version: number | string;
  }>(
    db,
    sql`select account_id::text as account_id, workspace_id::text as workspace_id,
      session_id::text as session_id, provider, connection_id::text as connection_id,
      model_id, choice, only_this_model, last_model_call_at, last_switch_reason, version
    from subscription_session_bindings
    where workspace_id = ${input.workspaceId}::uuid and session_id = ${input.sessionId}::uuid`,
  );
  if (!row) return null;
  return {
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    provider: row.provider,
    connectionId: row.connection_id,
    modelId: row.model_id,
    choice: row.choice,
    onlyThisModel: row.only_this_model,
    lastModelCallAt: row.last_model_call_at === null ? null : new Date(row.last_model_call_at),
    lastSwitchReason: row.last_switch_reason,
    version: Number(row.version),
  };
}

/** Inserts once or compare-and-swaps an existing binding version. */
export async function writeSubscriptionSessionBinding(
  db: Database,
  input: Omit<SubscriptionSessionBinding, "version"> & { expectedVersion?: number | null },
): Promise<number | null> {
  if (
    input.expectedVersion != null &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
  )
    throw new Error("Subscription binding expected version must be a positive safe integer");
  const [row] = await rawRows<{ version: number | string }>(
    db,
    sql`insert into subscription_session_bindings (
      account_id, workspace_id, session_id, provider, connection_id, model_id,
      choice, only_this_model, last_model_call_at, last_switch_reason, version
    ) values (
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
      ${input.provider}, ${input.connectionId ?? null}::uuid, ${input.modelId},
      ${input.choice}, ${input.onlyThisModel},
      ${input.lastModelCallAt?.toISOString() ?? null}::timestamptz,
      ${input.lastSwitchReason ?? null}, 1
    )
    on conflict (workspace_id, session_id) do update
      set provider = excluded.provider,
          connection_id = excluded.connection_id,
          model_id = excluded.model_id,
          choice = excluded.choice,
          only_this_model = excluded.only_this_model,
          last_model_call_at = excluded.last_model_call_at,
          last_switch_reason = excluded.last_switch_reason,
          version = subscription_session_bindings.version + 1
      where ${input.expectedVersion ?? null}::bigint is not null
        and subscription_session_bindings.account_id = excluded.account_id
        and subscription_session_bindings.version = ${input.expectedVersion ?? null}::bigint
    returning version`,
  );
  return row ? Number(row.version) : null;
}

export async function createSubscriptionConnection(
  db: Database,
  input: {
    accountId: string;
    provider: ProviderId;
    kind: "subscription" | "api_key";
    credentialEncrypted: string;
    providerAccountId?: string | null;
  },
): Promise<string> {
  const [row] = await rawRows<{ id: string }>(
    db,
    sql`insert into subscription_connections (
      account_id, provider, kind, credential_encrypted, provider_account_id
    ) values (
      ${input.accountId}::uuid, ${input.provider}, ${input.kind},
      ${input.credentialEncrypted}, ${input.providerAccountId ?? null}
    ) returning id::text as id`,
  );
  if (!row) throw new Error("Subscription connection insert returned no row");
  return row.id;
}

export type SubscriptionOperationKind = "image" | "realtime" | "transcription";

export type SubscriptionOperationLeaseIdentity = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  attemptId: string;
  operationKind: SubscriptionOperationKind;
  sessionId?: string | null;
  turnId?: string | null;
  provider: ProviderId;
  connectionId: string;
  holderId: string;
  generation: number;
};

export type SubscriptionOperationLease = SubscriptionOperationLeaseIdentity & {
  leasedUntil: Date;
};

/**
 * Acquire a lease for one durable operation. Replays of the same exact
 * generation are idempotent; a later generation can replace only an expired
 * lease. A caller must first own the corresponding operation-ledger claim.
 */
export async function acquireSubscriptionOperationLease(
  db: Database,
  input: SubscriptionOperationLeaseIdentity & { ttlMs: number },
): Promise<SubscriptionOperationLease | null> {
  assertPositiveLeaseTtl(input.ttlMs);
  assertPositiveGeneration(input.generation);
  const [row] = await rawRows<{
    leased_until: Date | string;
  }>(
    db,
    sql`insert into subscription_operation_leases (
      account_id, workspace_id, operation_id, attempt_id, operation_kind,
      session_id, turn_id, provider, connection_id, holder_id, generation,
      leased_until, updated_at
    ) values (
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.operationId}::uuid,
      ${input.attemptId}::uuid, ${input.operationKind},
      ${input.sessionId ?? null}::uuid, ${input.turnId ?? null}::uuid,
      ${input.provider}, ${input.connectionId}::uuid, ${input.holderId}, ${input.generation},
      clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'), clock_timestamp()
    )
    on conflict (account_id, operation_id) do update
      set attempt_id = excluded.attempt_id,
          operation_kind = excluded.operation_kind,
          session_id = excluded.session_id,
          turn_id = excluded.turn_id,
          provider = excluded.provider,
          connection_id = excluded.connection_id,
          holder_id = excluded.holder_id,
          generation = excluded.generation,
          leased_until = clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'),
          updated_at = clock_timestamp()
      where (
        subscription_operation_leases.generation = excluded.generation
        and subscription_operation_leases.attempt_id = excluded.attempt_id
        and subscription_operation_leases.operation_kind = excluded.operation_kind
        and subscription_operation_leases.session_id is not distinct from excluded.session_id
        and subscription_operation_leases.turn_id is not distinct from excluded.turn_id
        and subscription_operation_leases.provider = excluded.provider
        and subscription_operation_leases.holder_id = excluded.holder_id
        and subscription_operation_leases.connection_id = excluded.connection_id
        and subscription_operation_leases.leased_until > clock_timestamp()
      ) or (
        subscription_operation_leases.generation < excluded.generation
        and subscription_operation_leases.leased_until <= clock_timestamp()
        and subscription_operation_leases.operation_kind = excluded.operation_kind
        and subscription_operation_leases.session_id is not distinct from excluded.session_id
        and subscription_operation_leases.turn_id is not distinct from excluded.turn_id
        and subscription_operation_leases.provider = excluded.provider
        and subscription_operation_leases.connection_id = excluded.connection_id
      )
    returning leased_until`,
  );
  return row ? { ...operationLeaseIdentity(input), leasedUntil: new Date(row.leased_until) } : null;
}

/** Renew only the exact, still-live operation lease generation. */
export async function renewSubscriptionOperationLease(
  db: Database,
  input: SubscriptionOperationLeaseIdentity & { ttlMs: number },
): Promise<Date | null> {
  assertPositiveLeaseTtl(input.ttlMs);
  const identity = operationLeaseWhere(input);
  const [locked] = await rawRows<{ operation_id: string }>(
    db,
    sql`select operation_id::text as operation_id
      from subscription_operation_leases where ${identity} for update`,
  );
  if (!locked) return null;
  const [row] = await rawRows<{ leased_until: Date | string }>(
    db,
    sql`update subscription_operation_leases
      set leased_until = clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'),
          updated_at = clock_timestamp()
      where ${identity} and leased_until > clock_timestamp()
      returning leased_until`,
  );
  return row ? new Date(row.leased_until) : null;
}

/** Pre-dispatch fence; the caller must separately recheck current eligibility. */
export async function assertSubscriptionOperationLeaseCurrent(
  db: Database,
  input: SubscriptionOperationLeaseIdentity,
): Promise<boolean> {
  const [row] = await rawRows<{ current: boolean }>(
    db,
    sql`select exists (
      select 1 from subscription_operation_leases
      where ${operationLeaseWhere(input)} and leased_until > clock_timestamp()
    ) as current`,
  );
  return row?.current ?? false;
}

/** Release is fenced by operation, attempt, holder and generation. */
export async function releaseSubscriptionOperationLease(
  db: Database,
  input: SubscriptionOperationLeaseIdentity,
): Promise<boolean> {
  const rows = await rawRows<{ operation_id: string }>(
    db,
    sql`delete from subscription_operation_leases
      where ${operationLeaseWhere(input)} returning operation_id::text as operation_id`,
  );
  return rows.length === 1;
}

export type SubscriptionCapacityWaiter = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  waiterId: string;
  provider: ProviderId;
  waitReason: string;
  policyHash?: string | null;
  resetKind?: string | null;
  refreshAttempt?: number;
  resumedUpdateId?: string | null;
  earliestResetAt?: Date | null;
  generation: number;
  wakeRevision: number;
  observedWakeRevision: number;
  nextCheckAt?: Date | null;
  blockedTurnGeneration?: number | null;
};

/** Upsert is monotonic: stale generations cannot replace the current waiter. */
export async function upsertSubscriptionCapacityWaiter(
  db: Database,
  input: SubscriptionCapacityWaiter,
): Promise<SubscriptionCapacityWaiter | null> {
  assertPositiveGeneration(input.generation);
  if (!Number.isSafeInteger(input.wakeRevision) || input.wakeRevision < 1)
    throw new Error("Subscription waiter wake revision must be a positive safe integer");
  if (
    !Number.isSafeInteger(input.observedWakeRevision) ||
    input.observedWakeRevision < 0 ||
    input.observedWakeRevision > input.wakeRevision
  ) {
    throw new Error("Subscription waiter observed revision must be between zero and wake revision");
  }
  const [row] = await rawRows<{
    waiter_id: string;
    provider: ProviderId;
    wait_reason: string;
    policy_hash: string | null;
    reset_kind: string | null;
    refresh_attempt: number | string;
    resumed_update_id: string | null;
    earliest_reset_at: Date | string | null;
    generation: number | string;
    wake_revision: number | string;
    observed_wake_revision: number | string;
    next_check_at: Date | string | null;
    blocked_turn_generation: number | string | null;
  }>(
    db,
    sql`insert into subscription_capacity_waiters (
      account_id, workspace_id, session_id, turn_id, waiter_id, provider, wait_reason,
      policy_hash, reset_kind, refresh_attempt, resumed_update_id, earliest_reset_at,
      generation, wake_revision, observed_wake_revision, next_check_at,
      blocked_turn_generation, updated_at
    ) values (
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.sessionId}::uuid,
      ${input.turnId}::uuid, ${input.waiterId}::uuid, ${input.provider}, ${input.waitReason},
      ${input.policyHash ?? null}, ${input.resetKind ?? null}, ${input.refreshAttempt ?? 0},
      ${input.resumedUpdateId ?? null}::uuid, ${input.earliestResetAt?.toISOString() ?? null}::timestamptz,
      ${input.generation}, ${input.wakeRevision}, ${input.observedWakeRevision},
      ${input.nextCheckAt?.toISOString() ?? null}::timestamptz, ${input.blockedTurnGeneration ?? null},
      clock_timestamp()
    )
    on conflict (workspace_id, session_id) do update
      set turn_id = excluded.turn_id,
          provider = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.provider ELSE subscription_capacity_waiters.provider END,
          wait_reason = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.wait_reason ELSE subscription_capacity_waiters.wait_reason END,
          policy_hash = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.policy_hash ELSE subscription_capacity_waiters.policy_hash END,
          reset_kind = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.reset_kind ELSE subscription_capacity_waiters.reset_kind END,
          refresh_attempt = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.refresh_attempt ELSE subscription_capacity_waiters.refresh_attempt END,
          resumed_update_id = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.resumed_update_id ELSE subscription_capacity_waiters.resumed_update_id END,
          earliest_reset_at = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.earliest_reset_at ELSE subscription_capacity_waiters.earliest_reset_at END,
          generation = greatest(subscription_capacity_waiters.generation, excluded.generation),
          wake_revision = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              THEN excluded.wake_revision
            ELSE greatest(subscription_capacity_waiters.wake_revision, excluded.wake_revision) END,
          observed_wake_revision = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              THEN excluded.observed_wake_revision
            ELSE greatest(subscription_capacity_waiters.observed_wake_revision, excluded.observed_wake_revision) END,
          next_check_at = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.next_check_at ELSE subscription_capacity_waiters.next_check_at END,
          blocked_turn_generation = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN excluded.blocked_turn_generation ELSE subscription_capacity_waiters.blocked_turn_generation END,
          updated_at = CASE WHEN excluded.generation > subscription_capacity_waiters.generation
              OR excluded.wake_revision > subscription_capacity_waiters.wake_revision
            THEN clock_timestamp() ELSE subscription_capacity_waiters.updated_at END
      where subscription_capacity_waiters.account_id = excluded.account_id
        and (subscription_capacity_waiters.generation < excluded.generation
          or (subscription_capacity_waiters.generation = excluded.generation
            and subscription_capacity_waiters.waiter_id = excluded.waiter_id
            and subscription_capacity_waiters.turn_id = excluded.turn_id))
    returning waiter_id::text as waiter_id, provider, wait_reason, policy_hash, reset_kind,
      refresh_attempt, resumed_update_id::text as resumed_update_id, earliest_reset_at,
      generation, wake_revision, observed_wake_revision, next_check_at, blocked_turn_generation`,
  );
  if (!row) return null;
  return {
    ...input,
    waiterId: row.waiter_id,
    provider: row.provider,
    waitReason: row.wait_reason,
    policyHash: row.policy_hash,
    resetKind: row.reset_kind,
    refreshAttempt: Number(row.refresh_attempt),
    resumedUpdateId: row.resumed_update_id,
    earliestResetAt: row.earliest_reset_at === null ? null : new Date(row.earliest_reset_at),
    generation: Number(row.generation),
    wakeRevision: Number(row.wake_revision),
    observedWakeRevision: Number(row.observed_wake_revision),
    nextCheckAt: row.next_check_at === null ? null : new Date(row.next_check_at),
    blockedTurnGeneration:
      row.blocked_turn_generation === null ? null : Number(row.blocked_turn_generation),
  };
}

/** Bump one exact waiter's revision; workflow signalling remains outbox-owned. */
export async function wakeSubscriptionCapacityWaiter(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    waiterId: string;
    generation: number;
    nextCheckAt?: Date | null;
  },
): Promise<number | null> {
  const [row] = await rawRows<{ wake_revision: number | string }>(
    db,
    sql`with bumped as (
      update subscription_capacity_waiters
      set wake_revision = wake_revision + 1,
          next_check_at = ${input.nextCheckAt?.toISOString() ?? null}::timestamptz,
          updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid
        and waiter_id = ${input.waiterId}::uuid
        and generation = ${input.generation}
      returning account_id, workspace_id, session_id, waiter_id, generation, wake_revision
    )
    insert into subscription_capacity_wake_outbox (
      account_id, workspace_id, session_id, waiter_id, generation, wake_revision
    ) select account_id, workspace_id, session_id, waiter_id, generation, wake_revision from bumped
    on conflict (account_id, waiter_id, generation, wake_revision) do nothing
    returning wake_revision`,
  );
  return row ? Number(row.wake_revision) : null;
}

export type SubscriptionCapacityWakeDelivery = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  waiterId: string;
  generation: number;
  wakeRevision: number;
  claimGeneration: number;
};

/**
 * Claims due wake obligations under the trusted empty-subject worker scope.
 * Claim generations fence a delayed Temporal signaler from a later retry.
 */
export async function claimSubscriptionCapacityWakeDeliveries(
  db: Database,
  input: { limit: number; claimTtlMs: number },
): Promise<SubscriptionCapacityWakeDelivery[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
    throw new Error("Subscription wake claim limit must be between 1 and 500");
  assertPositiveLeaseTtl(input.claimTtlMs);
  return await rawRows<{
    id: string;
    account_id: string;
    workspace_id: string;
    session_id: string;
    waiter_id: string;
    generation: number | string;
    wake_revision: number | string;
    claim_generation: number | string;
  }>(
    db,
    sql`with due as (
      select id from subscription_capacity_wake_outbox
      where delivered_at is null and next_attempt_at <= clock_timestamp()
      order by next_attempt_at, created_at, id
      for update skip locked
      limit ${input.limit}
    )
    update subscription_capacity_wake_outbox outbox
    set attempt_count = attempt_count + 1,
        claim_generation = claim_generation + 1,
        next_attempt_at = clock_timestamp() + (${input.claimTtlMs} * interval '1 millisecond')
    from due
    where outbox.id = due.id and outbox.delivered_at is null
    returning outbox.id::text as id, outbox.account_id::text as account_id,
      outbox.workspace_id::text as workspace_id, outbox.session_id::text as session_id,
      outbox.waiter_id::text as waiter_id, outbox.generation, outbox.wake_revision,
      outbox.claim_generation`,
  ).then((rows) =>
    rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      waiterId: row.waiter_id,
      generation: Number(row.generation),
      wakeRevision: Number(row.wake_revision),
      claimGeneration: Number(row.claim_generation),
    })),
  );
}

export async function markSubscriptionCapacityWakeDelivered(
  db: Database,
  input: { id: string; claimGeneration: number },
): Promise<boolean> {
  const rows = await rawRows<{ id: string }>(
    db,
    sql`update subscription_capacity_wake_outbox
      set delivered_at = clock_timestamp(), last_error = null
      where id = ${input.id}::uuid and claim_generation = ${input.claimGeneration}
        and delivered_at is null
      returning id::text as id`,
  );
  return rows.length === 1;
}

/** Failure codes are deliberately bounded identifiers, never exception text. */
export async function retrySubscriptionCapacityWakeDelivery(
  db: Database,
  input: {
    id: string;
    claimGeneration: number;
    retryInMs: number;
    failureCode: string;
  },
): Promise<boolean> {
  assertPositiveLeaseTtl(input.retryInMs);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.failureCode))
    throw new Error("Subscription wake failure code must be a bounded identifier");
  const rows = await rawRows<{ id: string }>(
    db,
    sql`update subscription_capacity_wake_outbox
      set next_attempt_at = clock_timestamp() + (${input.retryInMs} * interval '1 millisecond'),
          last_error = ${input.failureCode}
      where id = ${input.id}::uuid and claim_generation = ${input.claimGeneration}
        and delivered_at is null
      returning id::text as id`,
  );
  return rows.length === 1;
}

export type DueSubscriptionCapacityWaiter = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  waiterId: string;
  provider: ProviderId;
  generation: number;
  wakeRevision: number;
  observedWakeRevision: number;
  nextCheckAt: Date | null;
};

/** Lists due or newly-woken waiters inside the caller's authorized workspace scope. */
export async function listDueSubscriptionCapacityWaiters(
  db: Database,
  input: { provider?: ProviderId; limit: number },
): Promise<DueSubscriptionCapacityWaiter[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
    throw new Error("Subscription waiter list limit must be between 1 and 500");
  const rows = await rawRows<{
    account_id: string;
    workspace_id: string;
    session_id: string;
    turn_id: string;
    waiter_id: string;
    provider: ProviderId;
    generation: number | string;
    wake_revision: number | string;
    observed_wake_revision: number | string;
    next_check_at: Date | string | null;
  }>(
    db,
    sql`select account_id::text as account_id, workspace_id::text as workspace_id,
      session_id::text as session_id, turn_id::text as turn_id, waiter_id::text as waiter_id,
      provider, generation, wake_revision, observed_wake_revision, next_check_at
    from subscription_capacity_waiters
    where (${input.provider ?? null}::text is null or provider = ${input.provider ?? null})
      and (wake_revision > observed_wake_revision
        or (next_check_at is not null and next_check_at <= clock_timestamp()))
    order by coalesce(next_check_at, updated_at), account_id, waiter_id
    limit ${input.limit}`,
  );
  return rows.map((row) => ({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    waiterId: row.waiter_id,
    provider: row.provider,
    generation: Number(row.generation),
    wakeRevision: Number(row.wake_revision),
    observedWakeRevision: Number(row.observed_wake_revision),
    nextCheckAt: row.next_check_at === null ? null : new Date(row.next_check_at),
  }));
}

/** Acknowledges only the revision actually observed by the workflow. */
export async function observeSubscriptionCapacityWaiterWake(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    waiterId: string;
    generation: number;
    wakeRevision: number;
  },
): Promise<boolean> {
  const rows = await rawRows<{ waiter_id: string }>(
    db,
    sql`update subscription_capacity_waiters
      set observed_wake_revision = ${input.wakeRevision}, updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid
        and workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid
        and waiter_id = ${input.waiterId}::uuid
        and generation = ${input.generation}
        and wake_revision = ${input.wakeRevision}
        and observed_wake_revision <= ${input.wakeRevision}
      returning waiter_id::text as waiter_id`,
  );
  return rows.length === 1;
}

function assertPositiveLeaseTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new Error("Subscription operation lease TTL must be a positive safe integer");
}

function assertPositiveGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0)
    throw new Error("Subscription generation must be a positive safe integer");
}

function operationLeaseIdentity(
  input: SubscriptionOperationLeaseIdentity,
): SubscriptionOperationLeaseIdentity {
  return {
    ...input,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
  };
}

function operationLeaseWhere(input: SubscriptionOperationLeaseIdentity) {
  return sql`account_id = ${input.accountId}::uuid
    and workspace_id = ${input.workspaceId}::uuid
    and operation_id = ${input.operationId}::uuid
    and attempt_id = ${input.attemptId}::uuid
    and operation_kind = ${input.operationKind}
    and session_id is not distinct from ${input.sessionId ?? null}::uuid
    and turn_id is not distinct from ${input.turnId ?? null}::uuid
    and provider = ${input.provider}
    and connection_id = ${input.connectionId}::uuid
    and holder_id = ${input.holderId}
    and generation = ${input.generation}`;
}
