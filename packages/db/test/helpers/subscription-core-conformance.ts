/**
 * The shared subscription-core conformance suite (design
 * docs/design/subscription-core-2026-10-07.md, 5.3 step F): one set of tests
 * every source of model access must pass through the real shared core, on
 * real PostgreSQL, as the non-owner application role. A subject is a
 * provider binding plus the few facts the suite cannot derive (a credential
 * per connection, a sign-in identity, models). The suite reads everything
 * else (connection kind, refresh, primary column, health durations) from the
 * binding, so it runs unchanged for a subscription or an API-key connector:
 *
 *   describeSubscriptionCoreConformance({ name, databaseLabel, provider, ... })
 *
 * Each placement is compared with the pure policy on the world the core read
 * in the same state, and that decision with the independent reference model
 * (`checkPlacementDecision`). Outcomes are classified by the subject and
 * settled by the core's provider-neutral settlement step
 * (`subscriptionCoreSettlement`, planned by `planSubscriptionCoreRefusal`).
 * Every organization also holds a connection of another provider
 * (`foreignProvider`), which nothing of this provider may place, lease,
 * list, count or recover. All upstream traffic goes to a scripted local
 * upstream; any other network access fails the suite.
 *
 * Run each conformance file in its own process: a subject registered for the
 * test replaces module bindings (`mock.module`) for the whole process.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { Sql } from "postgres";
import type { Settings } from "@opengeni/config";
import {
  decidePlacement,
  type PlacementDecision,
  type PlacementInput,
  type ProviderErrorOutcome,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";
import { checkPlacementDecision } from "@opengeni/subscriptions/reference";
import { sql } from "drizzle-orm";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../../src";
import { rawRows, setSubjectRlsContext } from "../../src/database";
import { encryptEnvironmentValue } from "../../src/environment-crypto";
import {
  subscriptionAuthorityV2ForAcceptanceInTransaction,
  subscriptionAuthorityV2ForScheduledTaskInTransaction,
} from "../../src/subscription-core-acceptance-authority";
import { withSubscriptionCoreProviderPlacementWorld } from "../../src/subscription-core-placement-world";
import {
  acquireSubscriptionTurnLease,
  listDueSubscriptionCapacityWaiters,
  observeSubscriptionCapacityWaiterWake,
  releaseSubscriptionTurnLease,
  renewSubscriptionTurnLease,
  upsertSubscriptionCapacityWaiter,
  wakeSubscriptionCapacityWaiter,
} from "../../src/subscription-core-repository";
import {
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCoreWorkspacePool,
  renameSubscriptionCoreConnection,
  setSubscriptionCoreAllocator,
  setSubscriptionCorePrimary,
  setSubscriptionCoreRotation,
} from "../../src/subscription-core/administration";
import {
  getSubscriptionCoreModelConnectionAccess,
  updateSubscriptionCoreModelConnectionAccess,
  withModelConnectionAccessScope,
} from "../../src/subscription-core/access-editor";
import {
  connectSubscriptionCoreConnection,
  disconnectSubscriptionCoreConnection,
} from "../../src/subscription-core/connections";
import { subscriptionCoreOperations } from "../../src/subscription-core/operations";
import { listSubscriptionCoreServingConnections } from "../../src/subscription-core/catalog";
import { subscriptionCoreRequests } from "../../src/subscription-core/requests";
import { subscriptionCoreSettlement } from "../../src/subscription-core/settlement";
import {
  subscriptionCoreConnectionKind,
  type SubscriptionCoreProvider,
} from "../../src/subscription-core/provider";
import {
  readSubscriptionCoreTurnIdentity,
  subscriptionCoreReselectionPoints,
  subscriptionCoreTurns,
  type SubscriptionCoreLeaseRef,
  type SubscriptionCoreTurnIdentity,
} from "../../src/subscription-core/turns";
/**
 * The provider-neutral vocabulary of upstream replies the suite scripts. A
 * subject's upstream renders each one in its own wire format (status codes,
 * headers, bodies), and its classifier must map the refusal back to the
 * shared outcome named in each comment.
 */
export type ScriptedReply =
  /** Success. */
  | { kind: "ok" }
  /** `rate_limited` with the given retry time. */
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  /** `exhausted` (usage limit or spend budget) with the given reset. */
  | { kind: "budget_exhausted"; resetsAt: number | null }
  /** `unauthorized`. */
  | { kind: "unauthorized" }
  /** `forbidden`. */
  | { kind: "forbidden" }
  /** `entitlement_missing` for the requested model. */
  | { kind: "model_unavailable" }
  /** `rate_limited` for the requested model only (a gateway's per-model limit). */
  | { kind: "model_rate_limited"; retryAfterSeconds: number | null }
  /** `overloaded`: the provider is busy; not a refusal of the connection. */
  | { kind: "overloaded" }
  /** `transient`: a server error; not a refusal of the connection. */
  | { kind: "server_error" }
  /** No reply ever arrives; the connector cannot classify it (unknown outcome). */
  | { kind: "connection_lost" };

/**
 * A scripted local upstream: the only network a conformance run may use.
 * The suite starts and stops it, and denies every other origin.
 */
export interface SubscriptionCoreConformanceUpstream<Credential> {
  readonly origin: string;
  start(): void;
  stop(): Promise<void>;
  /** Accept this credential (a new connection's credential is always accepted). */
  accept(credential: Credential): void;
  /** Queue replies for this credential's next requests (default: ok). */
  script(credential: Credential, replies: readonly ScriptedReply[]): void;
  /** The connector's transport: one model request with this credential. */
  complete(credential: Credential, upstreamModelId: string): Promise<void>;
  /** The connector's error classification of what `complete` threw. */
  classify(error: unknown, now: number, productModelId: string): ProviderErrorOutcome | null;
  /**
   * Usage reading, for a connector whose usage endpoint can show recovered
   * capacity: raise the credential's limit upstream, then read its usage
   * through the connector into the shared quota model.
   */
  usage?: {
    restore(credential: Credential): void;
    read(
      credential: Credential,
      observedAt: number,
      refreshGeneration: number,
    ): Promise<SubscriptionQuota>;
  };
}

export type SubscriptionCoreConformanceSubject<Credential> = {
  /** Suite title. */
  name: string;
  /** Its own shared test database. */
  databaseLabel: string;
  /** The binding every runtime call uses (registered, or registered for the test). */
  provider: SubscriptionCoreProvider<Credential>;
  /** Product model ids this provider serves, with their upstream ids (at least three). */
  models: ReadonlyArray<{ productModelId: string; upstreamModelId: string }>;
  /** A distinct credential for one connection. */
  credential(label: string): Credential;
  /** The identity a completed sign-in reports for a credential. */
  identity(
    label: string,
    credential: Credential,
  ): Promise<{
    providerAccountId: string;
    providerSubjectId: string;
  }>;
  /** Adapter-owned provider state stored on a connection. */
  providerState: Record<string, unknown>;
  /**
   * The frozen execution policy's credential source and billing for this
   * provider's turns (`turnExecutionPolicyV1`).
   */
  executionPolicy: {
    wireApi: string;
    credentialSource: Record<string, string>;
    billing: Record<string, string>;
  };
  /**
   * Another provider id the subject's database admits (with its connection
   * kind): every organization holds one healthy and one quarantined,
   * exhausted connection of it, which this provider must never touch.
   */
  foreignProvider: string;
  /** Expiry stored with a fresh credential (null for one that never expires). */
  expiresAt(): Date | null;
  /** Test-database setup run once as the owner (for example a test registration). */
  prepareDatabase?(shared: SharedTestDatabase): Promise<void>;
  /** The scripted upstream all traffic goes to (started by the suite). */
  upstream: SubscriptionCoreConformanceUpstream<Credential>;
  /** The network-denial guard the suite installs around the run. */
  denyNetwork(allowedOrigins: () => readonly string[]): {
    restore(): void;
    assertNoEscapes(): void;
  };
};

export function describeSubscriptionCoreConformance<Credential>(
  subject: SubscriptionCoreConformanceSubject<Credential>,
): void {
  setDefaultTimeout(180_000);
  const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
  const provider = subject.provider as SubscriptionCoreProvider;
  const providerId = provider.adapter.provider;
  const connectionKind = subscriptionCoreConnectionKind(provider);
  const runtime = () => subscriptionCoreTurns(provider);
  const key = Buffer.alloc(32, 73);
  const settings = { environmentsEncryptionKey: key.toString("base64") } as Settings;
  const TTL = 120_000;
  if (subject.models.length < 3)
    throw new Error("A conformance subject needs at least three models");
  const m0 = subject.models[0]!;
  const m1 = subject.models[1]!;
  const m2 = subject.models[2]!;

  let shared: SharedTestDatabase | null = null;
  let client: DbClient | null = null;
  let guard: ReturnType<SubscriptionCoreConformanceSubject<Credential>["denyNetwork"]> | null =
    null;
  const credentials = new Map<string, Credential>();
  const encryptedByLabel = new Map<string, string>();

  const db = () => client!.db;
  const admin = () => shared!.admin;

  type Org = {
    accountId: string;
    ownerSubjectId: string;
    ownerMembershipId: string;
    personalWorkspaceId: string;
    sharedWorkspaceId: string;
    otherWorkspaceId: string;
    /** The foreign provider's connections: one healthy, one quarantined and exhausted. */
    foreign: { healthy: string; quarantined: string; retryAt: Date };
    /**
     * Rows of this provider with the other connection kind: one with a full
     * identity (`other-kind-identified-<org>` as account and subject id) and
     * one with only an account id (`other-kind-unidentified-<org>`).
     */
    otherKind: { identified: string; unidentified: string };
  };

  /** A shared workspace of the organization the owner belongs to. */
  async function sharedWorkspace(
    accountId: string,
    ownerSubjectId: string,
    name: string,
  ): Promise<string> {
    const [workspace] = await admin()<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}::uuid, ${name}) returning id::text as id`;
    await admin()`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
    await admin()`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}::uuid, ${accountId}::uuid)`;
    return workspace!.id;
  }

  async function organization(): Promise<Org> {
    const userId = `conformance-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(db(), {
      userId,
      email: `${userId}@example.test`,
      name: "Subscription-core conformance",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const ownerSubjectId = `user:${userId}`;
    const [membership] = await admin()<{ id: string; personal_workspace_id: string }[]>`
      select id::text as id, personal_workspace_id::text as personal_workspace_id
      from organization_memberships
      where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
        and status = 'active' and revoked_at is null limit 1`;
    const workspaces: string[] = [];
    for (const name of ["Conformance shared", "Conformance other"])
      workspaces.push(await sharedWorkspace(accountId, ownerSubjectId, name));
    // The fixture writes the organization's settings and cutover itself.
    await admin()`
      delete from subscription_settings
      where account_id = ${accountId}::uuid and workspace_id is null`;
    await admin()`
      insert into subscription_settings (
        account_id, rotation, providers, cross_provider_failover, fallback_order,
        personal_connections_allowed, personal_fallback_allowed
      ) values (
        ${accountId}::uuid, ${admin().json({ [providerId]: { mode: "spread" } })}::jsonb,
        '{}'::jsonb, false, '{}'::jsonb, true, true
      )`;
    await admin()`
      insert into subscription_person_preferences (
        account_id, organization_membership_id, personal_fallback_opt_in
      ) values (${accountId}::uuid, ${membership!.id}::uuid, true)
      on conflict do nothing`;
    await admin()`
      insert into subscription_provider_cutovers (account_id, provider, enabled)
      values (${accountId}::uuid, ${providerId}, true)
      on conflict (account_id, provider) do update set enabled = true`;
    // Another provider's connections in the same organization and pool: the
    // quarantined one recovers sooner and is exhausted until sooner than
    // anything this suite creates, so any read that lost its provider filter
    // shows up in a wait, a recovery count, a pool or a lease. They carry
    // this provider's connection kind, so a read that filters by kind and
    // lost only its provider filter is still caught.
    const foreignKind = connectionKind;
    const retryAt = new Date(Date.now() + 20_000);
    const foreignIds: string[] = [];
    for (const [label, quarantined] of [
      ["foreign-healthy", false],
      ["foreign-quarantined", true],
    ] as const) {
      const [row] = await admin()<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, kind, credential_encrypted, ownership, scope_kind,
          allow_personal_workspaces, provider_account_id, provider_subject_id, label,
          status, health_retry_at
        ) values (
          ${accountId}::uuid, ${subject.foreignProvider}, ${foreignKind},
          ${encryptEnvironmentValue(key, "foreign-credential")}, 'shared', 'organization', true,
          ${`${label}-${accountId}`}, ${`${label}-${accountId}`}, ${label},
          ${quarantined ? "error" : "active"}, ${quarantined ? retryAt : null}::timestamptz
        ) returning id::text as id`;
      foreignIds.push(row!.id);
      if (quarantined) {
        await admin()`
          insert into subscription_connection_quota (
            account_id, connection_id, quota, observed_refresh_generation, revision, updated_at
          ) values (
            ${accountId}::uuid, ${row!.id}::uuid, ${admin().json({
              windows: [],
              modelCooldowns: {},
              exhaustedUntil: retryAt.getTime(),
              exhaustedKind: "quota",
              source: "refusal",
            })}::jsonb, 1, 1, clock_timestamp()
          )`;
      }
    }
    // This provider's rows of the other connection kind (no production writer
    // creates them; the kind filters must keep them out of every read and
    // writer of this provider).
    const otherKindIds: string[] = [];
    for (const [label, subjectId] of [
      ["other-kind-identified", `other-kind-identified-${accountId}`],
      ["other-kind-unidentified", null],
    ] as const) {
      const [row] = await admin()<{ id: string }[]>`
        insert into subscription_connections (
          account_id, provider, kind, credential_encrypted, ownership, scope_kind,
          allow_personal_workspaces, provider_account_id, provider_subject_id, label
        ) values (
          ${accountId}::uuid, ${providerId}, ${connectionKind === "api_key" ? "subscription" : "api_key"},
          ${encryptEnvironmentValue(key, "other-kind")}, 'shared', 'organization', true,
          ${`${label}-${accountId}`}, ${subjectId}, ${label}
        ) returning id::text as id`;
      otherKindIds.push(row!.id);
    }
    return {
      accountId,
      ownerSubjectId,
      ownerMembershipId: membership!.id,
      personalWorkspaceId: membership!.personal_workspace_id,
      sharedWorkspaceId: workspaces[0]!,
      otherWorkspaceId: workspaces[1]!,
      foreign: { healthy: foreignIds[0]!, quarantined: foreignIds[1]!, retryAt },
      otherKind: { identified: otherKindIds[0]!, unidentified: otherKindIds[1]! },
    };
  }

  /**
   * Nothing of this provider touched the foreign provider's connections or
   * this provider's rows of the other connection kind.
   */
  async function expectForeignUntouched(org: Org): Promise<void> {
    const ids = [
      org.foreign.healthy,
      org.foreign.quarantined,
      org.otherKind.identified,
      org.otherKind.unidentified,
    ];
    const [touched] = await admin()<
      {
        leases: number;
        failures: number;
        operations: number;
        quarantined: string;
        otherKind: string[];
      }[]
    >`
      select
        (select count(*)::int from subscription_leases
          where connection_id = any(${ids}::uuid[])) as leases,
        (select count(*)::int from subscription_turn_failures
          where connection_id = any(${ids}::uuid[])) as failures,
        (select count(*)::int from subscription_operation_leases
          where connection_id = any(${ids}::uuid[])) as operations,
        (select status from subscription_connections
          where id = ${org.foreign.quarantined}::uuid) as quarantined,
        (select array_agg(label || ':' || status || ':' || allocator_enabled::text order by label)
          from subscription_connections
          where id = any(${[org.otherKind.identified, org.otherKind.unidentified]}::uuid[])) as "otherKind"`;
    expect(touched).toEqual({
      leases: 0,
      failures: 0,
      operations: 0,
      quarantined: "error",
      otherKind: ["other-kind-identified:active:true", "other-kind-unidentified:active:true"],
    });
  }

  function encrypted(label: string): string {
    const credential = subject.credential(label);
    credentials.set(label, credential);
    subject.upstream.accept(credential);
    return encryptEnvironmentValue(key, provider.adapter.credential.encode(credential));
  }

  type Scope =
    | { kind: "organization" }
    | { kind: "workspaces"; workspaceIds: string[] }
    | { kind: "people"; membershipIds: string[] };

  /** A shared connection of this provider's kind, inserted as the owner would store it. */
  async function sharedConnection(
    org: Org,
    label: string,
    scope: Scope = { kind: "organization" },
    allowedModelIds: string[] | null = null,
  ): Promise<string> {
    const credentialEncrypted = encrypted(label);
    const identity = await subject.identity(label, credentials.get(label)!);
    const [row] = await admin()<{ id: string }[]>`
      insert into subscription_connections (
        account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        allow_personal_workspaces, provider_account_id, provider_subject_id, plan_type,
        provider_state, expires_at, allowed_model_ids, label
      ) values (
        ${org.accountId}::uuid, ${providerId}, ${connectionKind}, ${credentialEncrypted},
        'shared', ${scope.kind}, ${scope.kind !== "workspaces"},
        ${identity.providerAccountId}, ${identity.providerSubjectId}, null,
        ${admin().json(subject.providerState as Parameters<Sql["json"]>[0])}::jsonb,
        ${subject.expiresAt()?.toISOString() ?? null}::timestamptz,
        ${allowedModelIds === null ? null : admin().array(allowedModelIds)}, ${label}
      ) returning id::text as id`;
    if (scope.kind === "workspaces") {
      for (const workspaceId of scope.workspaceIds) {
        await admin()`
          insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
          values (${org.accountId}::uuid, ${row!.id}::uuid, ${workspaceId}::uuid)`;
      }
    }
    if (scope.kind === "people") {
      for (const membershipId of scope.membershipIds) {
        await admin()`
          insert into subscription_connection_people
            (account_id, connection_id, organization_membership_id)
          values (${org.accountId}::uuid, ${row!.id}::uuid, ${membershipId}::uuid)`;
      }
    }
    return row!.id;
  }

  /** The owner's personal connection with its resource authority (generation 1 by default). */
  async function personalConnection(org: Org, label: string, generation = 1): Promise<string> {
    const connectionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    const credentialEncrypted = encrypted(label);
    const identity = await subject.identity(label, credentials.get(label)!);
    await admin()`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
        'subscription_connection', ${connectionId}::uuid, ${generation}, 'active'
      )`;
    await admin()`
      insert into subscription_connections (
        id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, provider_account_id,
        provider_subject_id, provider_state, expires_at, label
      ) values (
        ${connectionId}::uuid, ${org.accountId}::uuid, ${providerId}, ${connectionKind},
        ${credentialEncrypted}, 'personal', 'people', ${org.ownerMembershipId}::uuid,
        ${org.ownerSubjectId}, ${authorityId}::uuid, 'subscription_connection', ${generation},
        ${identity.providerAccountId}, ${identity.providerSubjectId},
        ${admin().json(subject.providerState as Parameters<Sql["json"]>[0])}::jsonb,
        ${subject.expiresAt()?.toISOString() ?? null}::timestamptz, ${label}
      )`;
    return connectionId;
  }

  /**
   * The owner's personal connection of the foreign provider, with this
   * provider's connection kind and authority generation 2: only the
   * provider filters of the personal routines keep it out of this
   * provider's frozen authority, personal list, connect and management.
   */
  async function foreignPersonalConnection(
    org: Org,
    identity = `foreign-personal-${org.accountId}`,
    subjectId: string | null = identity,
  ): Promise<string> {
    const connectionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    await admin()`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
        'subscription_connection', ${connectionId}::uuid, 2, 'active'
      )`;
    await admin()`
      insert into subscription_connections (
        id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, provider_account_id,
        provider_subject_id, label
      ) values (
        ${connectionId}::uuid, ${org.accountId}::uuid, ${subject.foreignProvider},
        ${connectionKind}, ${encryptEnvironmentValue(key, "foreign-personal")}, 'personal',
        'people', ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId},
        ${authorityId}::uuid, 'subscription_connection', 2,
        ${identity}, ${subjectId},
        'foreign personal'
      )`;
    return connectionId;
  }

  /**
   * The owner's personal connection of this provider with the other
   * connection kind, at authority generation 7 (no production writer creates
   * one; every personal read and writer of this provider must ignore it).
   */
  async function otherKindPersonalConnection(org: Org): Promise<string> {
    const connectionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    const identity = `other-kind-personal-${org.accountId}`;
    await admin()`
      insert into organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, generation, status
      ) values (
        ${authorityId}::uuid, ${org.accountId}::uuid, ${org.ownerMembershipId}::uuid,
        'subscription_connection', ${connectionId}::uuid, 7, 'active'
      )`;
    await admin()`
      insert into subscription_connections (
        id, account_id, provider, kind, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, provider_account_id,
        provider_subject_id, label
      ) values (
        ${connectionId}::uuid, ${org.accountId}::uuid, ${providerId},
        ${connectionKind === "api_key" ? "subscription" : "api_key"},
        ${encryptEnvironmentValue(key, "other-kind-personal")}, 'personal', 'people',
        ${org.ownerMembershipId}::uuid, ${org.ownerSubjectId}, ${authorityId}::uuid,
        'subscription_connection', 7, ${identity}, ${identity}, 'other kind personal'
      )`;
    return connectionId;
  }

  /** A connection's frozen personal authority generation. */
  async function authorityGeneration(connectionId: string): Promise<number> {
    const [row] = await admin()<{ generation: number }[]>`
      select authority_generation::int as generation from subscription_connections
      where id = ${connectionId}::uuid`;
    return row!.generation;
  }

  /** A row's mutable administration state, to show a writer left it alone. */
  async function connectionState(connectionId: string) {
    const [row] = await admin()<
      { label: string | null; status: string; allocator_version: number }[]
    >`select label, status, allocator_version::int as allocator_version
      from subscription_connections where id = ${connectionId}::uuid`;
    return row ?? null;
  }

  type Turn = {
    identity: SubscriptionCoreTurnIdentity;
    attemptId: string;
    executionGeneration: number;
    holderId: string;
    productModelId: string;
  };

  /** A claimed, running turn: the exact state the worker places from. */
  async function runningTurn(
    org: Org,
    input: {
      workspaceId?: string;
      visibility?: "user_private" | "workspace_shared";
      owner?: "owner" | "none";
      initiator?: "owner" | "service";
      /** The frozen personal entry: current generation (true), none (false), or a given generation. */
      personalAuthority?: boolean | { authorityGeneration: number };
      /** The membership the frozen personal entry names (default: the owner's). */
      personalMembershipId?: string;
      model?: { productModelId: string; upstreamModelId: string };
      frozenUpstreamModel?: boolean;
    } = {},
  ): Promise<Turn> {
    const workspaceId = input.workspaceId ?? org.sharedWorkspaceId;
    const model = input.model ?? m0;
    const ownerless = input.owner === "none";
    const createSessionCall = () =>
      createSession(db(), {
        accountId: org.accountId,
        workspaceId,
        initialMessage: "conformance",
        resources: [],
        metadata: {},
        model: model.productModelId,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        ...(input.visibility ? { visibility: input.visibility } : {}),
        ...(ownerless
          ? {}
          : {
              subjectId: org.ownerSubjectId,
              createdBy: { kind: "subject" as const, subjectId: org.ownerSubjectId },
              createdByContext: {},
            }),
      });
    const session = ownerless
      ? await createSessionCall()
      : await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, createSessionCall);
    const service = input.initiator === "service" || ownerless;
    // A service turn in an owned session is accepted in the owner's session
    // context (it sees the session) with no initiating human.
    const actor = ownerless
      ? { subjectId: "service:subscription-core", initiatingHumanSubjectId: null }
      : { subjectId: org.ownerSubjectId };
    const turn = await withSessionRlsActorContext(actor, () =>
      enqueueSessionTurn(db(), {
        accountId: org.accountId,
        workspaceId,
        sessionId: session.id,
        triggerEventId: crypto.randomUUID(),
        temporalWorkflowId: `session-${session.id}`,
        source: "user",
        prompt: "conformance",
        resources: [],
        tools: [],
        model: model.productModelId,
        reasoningEffort: "medium",
        sandboxBackend: "none",
        metadata: {},
        initiator: service
          ? { kind: "service", subjectId: "service:subscription-core" }
          : { kind: "subject", subjectId: org.ownerSubjectId },
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db(), workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
    expect(claimed.turn.id).toBe(turn.id);
    if (input.frozenUpstreamModel) {
      // The frozen execution policy names the upstream model, so the
      // connection's observed catalog decides entitlement.
      await admin()`
        update session_turns set metadata = metadata || ${admin().json({
          turnExecutionPolicyV1: {
            schemaVersion: 1,
            productModelId: model.productModelId,
            requestedModelId: null,
            modelSource: "session",
            reasoningEffort: "medium",
            reasoningSource: "session",
            latencyMode: "standard",
            latencyModeSource: "deployment",
            providerId: provider.adapter.modelPolicyProviderId,
            upstreamModelId: model.upstreamModelId,
            wireApi: subject.executionPolicy.wireApi,
            credentialSource: subject.executionPolicy.credentialSource,
            billing: subject.executionPolicy.billing,
            definitionVersion: `sha256:${"0".repeat(64)}`,
          },
        })}::jsonb
        where account_id = ${org.accountId}::uuid and id = ${turn.id}::uuid`;
    }
    if (input.personalAuthority !== undefined) {
      // The accepted snapshot, set exactly: this provider's entry, or none.
      await admin()`
        update session_turns set subscription_authority = ${admin().json({
          version: 2,
          personal:
            input.personalAuthority === false
              ? []
              : [
                  {
                    provider: providerId,
                    ownerMembershipId: input.personalMembershipId ?? org.ownerMembershipId,
                    authorityGeneration:
                      input.personalAuthority === true
                        ? 1
                        : input.personalAuthority.authorityGeneration,
                  },
                ],
        })}::jsonb
        where account_id = ${org.accountId}::uuid and id = ${turn.id}::uuid`;
    }
    const identity = await readSubscriptionCoreTurnIdentity(db(), {
      accountId: org.accountId,
      workspaceId,
      sessionId: session.id,
      turnId: turn.id,
    });
    if (!identity) throw new Error("accepted turn identity was not readable");
    return {
      identity,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      holderId: `${providerId}-turn:${session.id}:${turn.id}:${attemptId}`,
      productModelId: model.productModelId,
    };
  }

  function place(turn: Turn, options: { now?: Date; holderId?: string } = {}) {
    return runtime().placeSubscriptionCoreTurn(db(), {
      identity: turn.identity,
      attemptId: turn.attemptId,
      executionGeneration: turn.executionGeneration,
      holderId: options.holderId ?? turn.holderId,
      productModelId: turn.productModelId,
      reasoningLevel: "medium",
      leaseTtlMs: TTL,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  function leaseOf(turn: Turn, connectionId: string): SubscriptionCoreLeaseRef {
    return { connectionId, holderId: turn.holderId, generation: turn.executionGeneration };
  }

  /**
   * The world the core reads for this turn now, made strict exactly as core
   * placement makes it (this provider only, no cross-provider failover, the
   * frozen upstream model's catalog entitlement).
   */
  async function strictWorld(turn: Turn, now: Date, upstreamModelId: string | null = null) {
    const result = await withSubscriptionCoreProviderPlacementWorld(
      db(),
      provider,
      {
        ...turn.identity,
        preferredModelId: turn.productModelId,
        reasoningLevel: "medium",
        models: [{ id: turn.productModelId, provider: providerId, reasoningLevels: ["medium"] }],
        reselectionPoints: [],
        now,
      },
      async (_tx, input) => input,
    );
    if (result.status !== "completed") throw new Error("placement world was not visible");
    const world = result.value;
    const binding = world.session.binding;
    return {
      ...world,
      session: {
        ...world.session,
        reselectionPoints: subscriptionCoreReselectionPoints({
          binding: binding
            ? { modelId: binding.modelId, lastModelCallAt: binding.lastModelCallAt }
            : null,
          productModelId: turn.productModelId,
          lastContextReplacedAt: null,
        }),
      },
      settings: { ...world.settings, crossProviderFailover: false, fallbackOrder: {} },
      connections: world.connections
        .filter((connection) => connection.provider === providerId)
        .map((connection) =>
          upstreamModelId !== null && connection.observedModelSlugs != null
            ? {
                ...connection,
                entitledModelIds: connection.observedModelSlugs.includes(upstreamModelId)
                  ? [turn.productModelId]
                  : [],
              }
            : connection,
        ),
    } satisfies PlacementInput;
  }

  /**
   * The pure decision on the core's own world, checked against the
   * independent reference model; the caller compares it with the core's.
   */
  async function referenceDecision(
    turn: Turn,
    now: Date,
    upstreamModelId: string | null = null,
  ): Promise<PlacementDecision> {
    const input = await strictWorld(turn, now, upstreamModelId);
    const decision = decidePlacement(input);
    expect(checkPlacementDecision(input, decision)).toEqual([]);
    return decision;
  }

  /** Place, and require the core to agree with the pure policy and the reference model. */
  async function placeChecked(turn: Turn, now = new Date(), upstreamModelId: string | null = null) {
    const expected = await referenceDecision(turn, now, upstreamModelId);
    const placed = await place(turn, { now });
    if (expected.kind === "run") {
      expect(placed).toMatchObject({
        kind: "run",
        connectionId: expected.connectionId,
        switch: expected.switch,
        personal: expected.personal,
      });
    } else {
      expect(placed).toMatchObject({ kind: "wait", reason: expected.reason });
      expect(instantOf(placed, "earliestResetAt")).toBe(expected.earliestResetAt);
    }
    return placed;
  }

  async function evaluateChecked(turn: Turn, now: Date) {
    const expected = await referenceDecision(turn, now);
    const evaluated = await runtime().evaluateSubscriptionCorePlacement(db(), {
      identity: turn.identity,
      productModelId: turn.productModelId,
      reasoningLevel: "medium",
      now,
    });
    if (expected.kind === "run")
      expect(evaluated).toMatchObject({ kind: "run", connectionId: expected.connectionId });
    else {
      expect(evaluated).toMatchObject({ kind: "wait", reason: expected.reason });
      expect(instantOf(evaluated, "earliestResetAt")).toBe(expected.earliestResetAt);
    }
    return evaluated;
  }

  /**
   * A Date field's instant in milliseconds (null when absent). Bun's
   * `toMatchObject` does not compare a Date's value, so every reset and retry
   * time is compared through this.
   */
  function instantOf(value: unknown, field: string): number | null {
    const raw = (value as Record<string, unknown> | null | undefined)?.[field];
    if (raw === null || raw === undefined) return null;
    return new Date(raw as Date | string | number).getTime();
  }

  /** The PostgreSQL error code of a failed query (the driver's error or its cause). */
  function postgresCode(error: unknown): string | null {
    let current: unknown = error;
    while (current !== null && typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
    }
    return null;
  }

  /**
   * Call the scripted upstream with the leased connection's credential and
   * settle the outcome through the core's settlement step, as a turn does:
   * null for a response, the classified outcome, or `unknown_outcome` when
   * the connector could not classify what happened. A refusal the step
   * answers with a refresh is retried once on the same connection, with the
   * same replies scripted for the renewed credential unless the refusal is
   * one the refresh cures (`survivesRefresh: false`).
   */
  async function callUpstream(
    turn: Turn,
    connectionId: string,
    replies: ScriptedReply[],
    now = Date.now(),
    survivesRefresh = true,
  ): Promise<ProviderErrorOutcome | null | "unknown_outcome"> {
    const lease = leaseOf(turn, connectionId);
    const model = subject.models.find((entry) => entry.productModelId === turn.productModelId)!;
    const requests = subscriptionCoreRequests(provider);
    for (let refreshed = false; ; refreshed = true) {
      const loaded = await runtime().loadSubscriptionCoreCredential(
        db(),
        settings,
        turn.identity,
        lease,
      );
      if (loaded.kind !== "loaded") throw new Error(`credential not loaded: ${loaded.kind}`);
      const credential = loaded.credential.credential as Credential;
      if (refreshed) subject.upstream.accept(credential);
      if (replies.length > 0 && (!refreshed || survivesRefresh))
        subject.upstream.script(credential, replies);
      // Every physical request is reserved before it is sent and settled after.
      const { operationId } = await requests.reserveSubscriptionCoreRequest(
        db(),
        turn.identity,
        lease,
        {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
          attemptId: turn.attemptId,
          executionGeneration: turn.executionGeneration,
        },
      );
      const request = {
        operationId,
        attemptId: turn.attemptId,
        executionGeneration: turn.executionGeneration,
      };
      try {
        await subject.upstream.complete(credential, model.upstreamModelId);
        await requests.settleSubscriptionCoreRequest(db(), turn.identity, lease, {
          ...request,
          outcome: "response_received",
        });
        expect(await requestOutcome(operationId)).toBe("response_received");
        return null;
      } catch (error) {
        const outcome = subject.upstream.classify(error, now, turn.productModelId);
        const settled = await subscriptionCoreSettlement(provider).settleSubscriptionCoreOutcome(
          db(),
          settings,
          turn.identity,
          lease,
          {
            outcome,
            refreshGeneration: loaded.credential.refreshGeneration,
            credential,
            refreshed,
            request,
            now,
          },
        );
        if (outcome === null) {
          expect(settled).toEqual({ kind: "no_failover" });
          expect(await requestOutcome(operationId)).toBe("unknown");
          return "unknown_outcome";
        }
        if (settled.kind === "retry_same_connection" && !refreshed) continue;
        if (settled.kind === "settled") {
          expect(settled).toEqual({ kind: "settled", receipt: true, health: true });
          expect(await requestOutcome(operationId)).toBe("refused");
        } else {
          expect(settled).toEqual({ kind: "no_failover" });
        }
        return outcome;
      }
    }
  }

  async function requestOutcome(operationId: string): Promise<string | null> {
    const [row] = await admin()<{ request_outcome: string | null }[]>`
      select request_outcome from subscription_operation_leases
      where operation_id = ${operationId}::uuid`;
    return row?.request_outcome ?? null;
  }

  async function connectionRow(connectionId: string) {
    const [row] = await admin()<
      { kind: string; status: string; health_retry_at: Date | null; provider: string }[]
    >`select kind, status, health_retry_at, provider from subscription_connections
      where id = ${connectionId}::uuid`;
    return row!;
  }

  describe.skipIf(!realDb)(`${subject.name}: shared subscription-core conformance`, () => {
    beforeAll(async () => {
      if (!realDb) return;
      subject.upstream.start();
      guard = subject.denyNetwork(() => [subject.upstream.origin]);
      shared = await acquireSharedTestDatabase(subject.databaseLabel);
      if (!shared) throw new Error("Real PostgreSQL is required");
      await subject.prepareDatabase?.(shared);
      client = createDb(shared.appUrl, { max: 6 });
    }, 180_000);

    afterAll(async () => {
      await client?.close();
      await shared?.release();
      await subject.upstream.stop();
      guard?.restore();
      guard?.assertNoEscapes();
    }, 180_000);

    test("runs as the non-superuser, non-bypass application role", async () => {
      const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
        db(),
        sql`select current_user as "currentUser", rolsuper as superuser,
            rolbypassrls as "bypassRls"
          from pg_catalog.pg_roles where rolname = current_user`,
      );
      expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
    });

    test("connects shared and personal connections of the provider's kind; identity fails closed", async () => {
      const org = await organization();
      const connect = (
        label: string,
        workspaceId: string | null,
        identity: {
          providerAccountId: string | null;
          providerSubjectId: string | null;
        },
      ) =>
        withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
          connectSubscriptionCoreConnection(db(), provider, {
            accountId: org.accountId,
            workspaceId,
            subjectId: org.ownerSubjectId,
            credentialEncrypted: encryptedByLabel.get(label) ?? encrypted(label),
            ...identity,
            planType: null,
            expiresAt: subject.expiresAt(),
            lastRefreshAt: new Date(),
            accountEmail: null,
            label,
            providerState: subject.providerState,
          }),
        );
      // Sign-in reads the identity the provider reports for the stored credential.
      const signIn = async (label: string) => {
        encryptedByLabel.set(label, encrypted(label));
        return await subject.identity(label, credentials.get(label)!);
      };
      const label = `shared-${crypto.randomUUID()}`;
      const identity = await signIn(label);
      const first = await connect(label, null, identity);
      expect(first).toMatchObject({ kind: "connected", isNew: true, ownership: "shared" });
      if (first.kind !== "connected") throw new Error("not connected");
      expect(await connectionRow(first.id)).toMatchObject({
        kind: connectionKind,
        provider: providerId,
      });
      // The same identity reconnects in place.
      expect(await connect(label, null, identity)).toMatchObject({
        kind: "connected",
        id: first.id,
        isNew: false,
      });
      // A row of this provider with the other connection kind is never
      // reconnected in place (taken over) by a connect of the same identity.
      // The identity index spans kinds, so such a connect cannot succeed at
      // all; the row keeps its label, status and allocator state (checked
      // by `expectForeignUntouched` below).
      const sameIdentity = `other-kind-identified-${org.accountId}`;
      const takeover = await connect(`takeover-${crypto.randomUUID()}`, null, {
        providerAccountId: sameIdentity,
        providerSubjectId: sameIdentity,
      }).catch((error: unknown) => error);
      expect(takeover).not.toMatchObject({ kind: "connected", id: org.otherKind.identified });
      // An unverified row of the other kind does not block this kind's
      // connect of the same provider account (only this kind's unverified
      // rows do).
      const besideUnverified = `other-kind-unidentified-${org.accountId}`;
      const beside = await connect(`beside-${crypto.randomUUID()}`, null, {
        providerAccountId: besideUnverified,
        providerSubjectId: `beside-${crypto.randomUUID()}`,
      });
      expect(beside).toMatchObject({ kind: "connected", isNew: true });
      expect(beside).not.toMatchObject({ id: org.otherKind.unidentified });
      // No identity, no connection.
      for (const missing of [
        { providerAccountId: null, providerSubjectId: identity.providerSubjectId },
        { providerAccountId: identity.providerAccountId, providerSubjectId: null },
      ]) {
        expect(await connect(`missing-${crypto.randomUUID()}`, null, missing)).toEqual({
          kind: "refused",
          reason: "identity_unverified",
        });
      }
      // A personal connection from the person's own Personal workspace.
      const personalLabel = `personal-${crypto.randomUUID()}`;
      const personal = await connect(
        personalLabel,
        org.personalWorkspaceId,
        await signIn(personalLabel),
      );
      expect(personal).toMatchObject({ kind: "connected", isNew: true, ownership: "personal" });
      if (personal.kind !== "connected") throw new Error("not connected");
      // A personal connect of this provider never takes over the owner's
      // personal connection of the foreign provider with the same identity,
      // and joins this provider's own authority generation (1): not the
      // foreign provider's (2) nor that of the owner's personal connection of
      // this provider with the other kind (7).
      const foreignPersonal = await foreignPersonalConnection(org);
      const foreignPersonalBefore = await connectionState(foreignPersonal);
      await otherKindPersonalConnection(org);
      const foreignIdentity = `foreign-personal-${org.accountId}`;
      const besideForeign = await connect(
        `beside-foreign-${crypto.randomUUID()}`,
        org.personalWorkspaceId,
        { providerAccountId: foreignIdentity, providerSubjectId: foreignIdentity },
      );
      expect(besideForeign).toMatchObject({
        kind: "connected",
        isNew: true,
        ownership: "personal",
      });
      expect(besideForeign).not.toMatchObject({ id: foreignPersonal });
      if (besideForeign.kind !== "connected") throw new Error("not connected");
      expect(await authorityGeneration(besideForeign.id)).toBe(1);
      expect(await connectionState(foreignPersonal)).toEqual(foreignPersonalBefore);
      // The foreign provider's unverified personal connection (no subject id)
      // with an account id does not make this provider's identity unverified.
      const unverifiedForeign = `foreign-unverified-${org.accountId}`;
      await foreignPersonalConnection(org, unverifiedForeign, null);
      expect(
        await connect(`beside-unverified-${crypto.randomUUID()}`, org.personalWorkspaceId, {
          providerAccountId: unverifiedForeign,
          providerSubjectId: unverifiedForeign,
        }),
      ).toMatchObject({ kind: "connected", isNew: true, ownership: "personal" });
      expect(await connectionRow(personal.id)).toMatchObject({
        kind: connectionKind,
        provider: providerId,
      });
      // Disconnecting goes through the same writers.
      const removed = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        disconnectSubscriptionCoreConnection(db(), provider, {
          accountId: org.accountId,
          workspaceId: null,
          subjectId: org.ownerSubjectId,
          connectionId: first.id,
        }),
      );
      expect(removed.outcome).toBe("removed");
      for (const connectionId of [org.otherKind.identified, org.otherKind.unidentified]) {
        const other = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
          disconnectSubscriptionCoreConnection(db(), provider, {
            accountId: org.accountId,
            workspaceId: null,
            subjectId: org.ownerSubjectId,
            connectionId,
          }),
        );
        // Refused before the routine: the target lookup reads only this
        // provider's kind, so no other-kind connection is even named.
        expect(other).toMatchObject({ outcome: "not_found", connectionId: null });
      }
      await expectForeignUntouched(org);
    });

    test("placement honours shared scopes and keeps ownerless sessions shared-only", async () => {
      const org = await organization();
      const otherWorkspace = await sharedConnection(org, `other-${crypto.randomUUID()}`, {
        kind: "workspaces",
        workspaceIds: [org.otherWorkspaceId],
      });
      const people = await sharedConnection(org, `people-${crypto.randomUUID()}`, {
        kind: "people",
        membershipIds: [org.ownerMembershipId],
      });
      // A people-scoped connection serves its person; never the other workspace's.
      const owned = await runningTurn(org, { visibility: "workspace_shared" });
      expect(await placeChecked(owned)).toMatchObject({ kind: "run", connectionId: people });
      // An ownerless session uses no people-scoped (or personal) capacity.
      const ownerless = await runningTurn(org, { owner: "none" });
      expect(await placeChecked(ownerless)).toMatchObject({ kind: "wait" });
      // The organization's rows of this provider with the other connection
      // kind are organization-scoped and healthy, yet never this provider's
      // capacity (placement reads only the registered kind).
      const organizationScoped = await sharedConnection(org, `org-${crypto.randomUUID()}`);
      expect(await placeChecked(ownerless)).toMatchObject({
        kind: "run",
        connectionId: organizationScoped,
      });
      // The serving catalog (model lists, readiness) reads the same rows.
      const serving = (
        await listSubscriptionCoreServingConnections(db(), provider, {
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: null,
        })
      ).map((entry) => entry.connectionId);
      expect(serving).toContain(organizationScoped);
      for (const connectionId of [org.otherKind.identified, org.otherKind.unidentified])
        expect(serving).not.toContain(connectionId);
      // The other workspace's connection serves turns there.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${organizationScoped}::uuid`;
      const there = await runningTurn(org, { workspaceId: org.otherWorkspaceId, owner: "none" });
      expect(await placeChecked(there)).toMatchObject({
        kind: "run",
        connectionId: otherWorkspace,
      });
    });

    test("personal connections serve only the owner's own turns with frozen authority", async () => {
      const org = await organization();
      const personal = await personalConnection(org, `personal-${crypto.randomUUID()}`);
      // The owner's personal connection of the foreign provider (same kind,
      // another authority generation) is never this provider's authority.
      await foreignPersonalConnection(org);
      const cases: Array<[string, Parameters<typeof runningTurn>[1], "run" | "wait"]> = [
        [
          "private session with frozen authority",
          { visibility: "user_private", personalAuthority: true },
          "run",
        ],
        [
          "Personal workspace with frozen authority",
          { workspaceId: org.personalWorkspaceId, personalAuthority: true },
          "run",
        ],
        [
          "private session without frozen authority",
          { visibility: "user_private", personalAuthority: false },
          "wait",
        ],
        [
          "private session with a future authority generation",
          { visibility: "user_private", personalAuthority: { authorityGeneration: 2 } },
          "wait",
        ],
        [
          "shared session in a shared workspace",
          { visibility: "workspace_shared", personalAuthority: true },
          "wait",
        ],
        [
          "service turn in the owner's private session",
          { visibility: "user_private", personalAuthority: true, initiator: "service" },
          "wait",
        ],
        ["ownerless session", { owner: "none" }, "wait"],
      ];
      for (const [name, input, expected] of cases) {
        const turn = await runningTurn(org, input);
        const placed = await placeChecked(turn);
        expect({ name, kind: placed.kind }).toEqual({ name, kind: expected });
        if (placed.kind === "run")
          expect(placed).toMatchObject({ connectionId: personal, personal: true });
      }
      // Accepted background work freezes the owner's personal authority for this provider.
      const session = await runningTurn(org, { visibility: "user_private" });
      const frozen = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, org.ownerSubjectId);
          return await subscriptionAuthorityV2ForAcceptanceInTransaction(tx, providerId, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            sessionId: session.identity.sessionId,
            acceptingSubjectId: org.ownerSubjectId,
          });
        },
      );
      expect(frozen as unknown).toEqual({
        version: 2,
        personal: [
          {
            provider: providerId,
            ownerMembershipId: org.ownerMembershipId,
            authorityGeneration: 1,
          },
        ],
      });
      // A scheduled task freezes the same authority only when its accepting
      // human creates it in their own Personal workspace; anywhere else, or
      // without an accepting human, it freezes shared capacity only.
      const taskAuthority = async (workspaceId: string, acceptingSubjectId: string | null) =>
        await withRlsContext(db(), { accountId: org.accountId, workspaceId }, async (tx) => {
          await setSubjectRlsContext(tx, org.ownerSubjectId);
          return await subscriptionAuthorityV2ForScheduledTaskInTransaction(tx, providerId, {
            accountId: org.accountId,
            workspaceId,
            reusableSessionId: null,
            acceptingSubjectId,
          });
        });
      expect((await taskAuthority(org.personalWorkspaceId, org.ownerSubjectId)) as unknown).toEqual(
        frozen,
      );
      const sharedOnly = { version: 2, personal: [] };
      expect((await taskAuthority(org.sharedWorkspaceId, org.ownerSubjectId)) as unknown).toEqual(
        sharedOnly,
      );
      expect((await taskAuthority(org.personalWorkspaceId, null)) as unknown).toEqual(sharedOnly);
      expect(
        (await taskAuthority(
          org.personalWorkspaceId,
          `user:not-${crypto.randomUUID()}`,
        )) as unknown,
      ).toEqual(sharedOnly);
    });

    test("personal access fails closed: another membership, a stale or revoked authority, personal connections off", async () => {
      const outcome = async (turn: Turn) => {
        const placed = await placeChecked(turn);
        return placed.kind === "run"
          ? `run:${placed.personal ? "personal" : "shared"}`
          : placed.kind === "wait"
            ? `wait:${placed.reason}`
            : placed.kind;
      };
      const privateTurn = (org: Org, extra: Parameters<typeof runningTurn>[1] = {}) =>
        runningTurn(org, { visibility: "user_private", personalAuthority: true, ...extra });
      // Exact owner membership: an entry naming any other membership is not this connection's.
      const named = await organization();
      await personalConnection(named, `named-${crypto.randomUUID()}`);
      expect(await outcome(await privateTurn(named))).toBe("run:personal");
      expect(
        await outcome(await privateTurn(named, { personalMembershipId: crypto.randomUUID() })),
      ).toBe("wait:no_eligible_capacity");
      // Current authority generation: the connection moved to generation 2.
      const moved = await organization();
      await personalConnection(moved, `moved-${crypto.randomUUID()}`, 2);
      expect(
        await outcome(await privateTurn(moved, { personalAuthority: { authorityGeneration: 1 } })),
      ).toBe("wait:no_eligible_capacity");
      expect(
        await outcome(await privateTurn(moved, { personalAuthority: { authorityGeneration: 2 } })),
      ).toBe("run:personal");
      // A revoked resource authority.
      const revoked = await organization();
      const revokedConnection = await personalConnection(revoked, `revoked-${crypto.randomUUID()}`);
      await admin()`
        update organization_user_resource_authorities
        set status = 'revoked', revoked_at = clock_timestamp()
        where account_id = ${revoked.accountId}::uuid and resource_id = ${revokedConnection}::uuid`;
      expect(await outcome(await privateTurn(revoked))).toBe("wait:no_eligible_capacity");
      // The organization turned personal connections off.
      const off = await organization();
      await personalConnection(off, `off-${crypto.randomUUID()}`);
      await admin()`
        update subscription_settings set personal_connections_allowed = false
        where account_id = ${off.accountId}::uuid and workspace_id is null`;
      expect(await outcome(await privateTurn(off))).toBe("wait:no_eligible_capacity");
    });

    test("spreads across connections, and a primary is honoured or refused by the binding", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `b-${crypto.randomUUID()}`);
      const spread = await placeChecked(await runningTurn(org));
      expect(spread.kind === "run" && [a, b].includes(spread.connectionId)).toBe(true);
      const administration = {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
      };
      if (provider.settings.primaryColumn === null) {
        await expect(
          setSubscriptionCorePrimary(db(), provider, { ...administration, connectionId: b }),
        ).rejects.toMatchObject({ code: "subscription_core_primary_unsupported" });
        return;
      }
      expect(
        await setSubscriptionCoreRotation(db(), provider, {
          ...administration,
          rotationEnabled: false,
        }),
      ).not.toBeNull();
      expect(
        await setSubscriptionCorePrimary(db(), provider, { ...administration, connectionId: b }),
      ).toMatchObject({ activated: b });
      expect(await placeChecked(await runningTurn(org))).toMatchObject({
        kind: "run",
        connectionId: b,
      });
    });

    test("administration lists and manages exactly this provider's connections of its kind", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `admin-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `admin-b-${crypto.randomUUID()}`, {
        kind: "workspaces",
        workspaceIds: [org.sharedWorkspaceId],
      });
      const personal = await personalConnection(org, `admin-personal-${crypto.randomUUID()}`);
      const foreignPersonal = await foreignPersonalConnection(org);
      const foreignPersonalBefore = await connectionState(foreignPersonal);
      const foreign = [org.foreign.healthy, org.foreign.quarantined];
      const otherKind = [org.otherKind.identified, org.otherKind.unidentified];
      const organizationRoute = {
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
      };
      const workspaceRoute = { ...organizationRoute, workspaceId: org.sharedWorkspaceId };
      // The organization's pool and the workspace's effective pool.
      const organizationPool = await readSubscriptionCoreOrganizationPool(db(), provider, {
        organizationId: org.accountId,
        subjectId: org.ownerSubjectId,
      });
      expect(organizationPool!.rows.map((row) => row.id).sort()).toEqual([a, b].sort());
      const workspacePool = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, org.ownerSubjectId);
          return await readSubscriptionCoreWorkspacePool(tx, provider, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
          });
        },
      );
      expect(workspacePool.connections.map((entry) => entry.row.id).sort()).toEqual([a, b].sort());
      // Rename through the workspace route (which resolves through the pool)
      // and the organization route; the foreign provider's rows are not found.
      expect(
        await renameSubscriptionCoreConnection(db(), provider, {
          ...workspaceRoute,
          connectionId: b,
          label: "renamed in workspace",
        }),
      ).toBe(b);
      for (const route of [workspaceRoute, organizationRoute])
        for (const connectionId of [...foreign, ...otherKind])
          expect(
            await renameSubscriptionCoreConnection(db(), provider, {
              ...route,
              connectionId,
              label: "not mine",
            }),
          ).toBeNull();
      // The owner manages their personal connection from their Personal workspace.
      expect(
        await renameSubscriptionCoreConnection(db(), provider, {
          ...organizationRoute,
          workspaceId: org.personalWorkspaceId,
          connectionId: personal,
          label: "my key",
        }),
      ).toBe(personal);
      // The owner's personal list and personal management are this
      // provider's only: their personal connection of the foreign provider
      // is neither listed, renamed nor disconnected here.
      const personalRows = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
        (tx) =>
          listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, {
            accountId: org.accountId,
            workspaceId: org.personalWorkspaceId,
            subjectId: org.ownerSubjectId,
          }),
      );
      expect(personalRows.map((row) => row.id)).toEqual([personal]);
      expect(
        await renameSubscriptionCoreConnection(db(), provider, {
          ...organizationRoute,
          workspaceId: org.personalWorkspaceId,
          connectionId: foreignPersonal,
          label: "not mine",
        }),
      ).toBeNull();
      const foreignDisconnect = await withSessionRlsActorContext(
        { subjectId: org.ownerSubjectId },
        () =>
          disconnectSubscriptionCoreConnection(db(), provider, {
            ...organizationRoute,
            workspaceId: org.personalWorkspaceId,
            connectionId: foreignPersonal,
          }),
      );
      expect(foreignDisconnect.outcome).toBe("not_found");
      expect(await connectionState(foreignPersonal)).toEqual(foreignPersonalBefore);
      // New-allocation eligibility.
      const allocatorVersion = async (connectionId: string) => {
        const [row] = await admin()<{ version: number }[]>`
          select allocator_version::int as version from subscription_connections
          where id = ${connectionId}::uuid`;
        return row!.version;
      };
      const toggled = await setSubscriptionCoreAllocator(db(), provider, {
        ...organizationRoute,
        connectionId: a,
        enabled: false,
        expectedVersion: await allocatorVersion(a),
      });
      expect(toggled.result).toMatchObject({ kind: "updated", allocatorEnabled: false });
      for (const connectionId of [...foreign, ...otherKind])
        expect(
          (
            await setSubscriptionCoreAllocator(db(), provider, {
              ...organizationRoute,
              connectionId,
              enabled: false,
              expectedVersion: await allocatorVersion(connectionId),
            })
          ).result,
        ).toEqual({ kind: "not_found" });
      // A primary, where the binding has one.
      if (provider.settings.primaryColumn !== null) {
        expect(
          await setSubscriptionCorePrimary(db(), provider, { ...workspaceRoute, connectionId: b }),
        ).toMatchObject({ activated: b });
        expect(
          await setSubscriptionCorePrimary(db(), provider, {
            ...organizationRoute,
            connectionId: org.foreign.healthy,
          }),
        ).toMatchObject({ activated: null });
        for (const connectionId of otherKind)
          expect(
            await setSubscriptionCorePrimary(db(), provider, {
              ...organizationRoute,
              connectionId,
            }),
          ).toMatchObject({ activated: null });
      }
      // The owner's personal connection of this provider with the other kind,
      // at another authority generation: no personal read or writer of this
      // provider lists, disconnects, manages, counts or takes it over.
      const otherPersonal = await otherKindPersonalConnection(org);
      const otherPersonalBefore = await connectionState(otherPersonal);
      const personalRoute = { ...organizationRoute, workspaceId: org.personalWorkspaceId };
      const listedBeside = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
        (tx) =>
          listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, {
            accountId: org.accountId,
            workspaceId: org.personalWorkspaceId,
            subjectId: org.ownerSubjectId,
          }),
      );
      expect(listedBeside.map((row) => row.id)).toEqual([personal]);
      expect(
        await renameSubscriptionCoreConnection(db(), provider, {
          ...personalRoute,
          connectionId: otherPersonal,
          label: "not mine",
        }),
      ).toBeNull();
      expect(
        (
          await setSubscriptionCoreAllocator(db(), provider, {
            ...personalRoute,
            connectionId: otherPersonal,
            enabled: false,
            expectedVersion: await allocatorVersion(otherPersonal),
          })
        ).result,
      ).toEqual({ kind: "not_found" });
      const otherDisconnect = await withSessionRlsActorContext(
        { subjectId: org.ownerSubjectId },
        () =>
          disconnectSubscriptionCoreConnection(db(), provider, {
            ...personalRoute,
            connectionId: otherPersonal,
          }),
      );
      expect(otherDisconnect.outcome).toBe("not_found");
      // Acceptance and scheduled-task authority stay this kind's generation 1.
      const expectedAuthority = {
        version: 2,
        personal: [
          {
            provider: providerId,
            ownerMembershipId: org.ownerMembershipId,
            authorityGeneration: 1,
          },
        ],
      };
      const session = await runningTurn(org, { visibility: "user_private" });
      const accepted = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, org.ownerSubjectId);
          return await subscriptionAuthorityV2ForAcceptanceInTransaction(tx, providerId, {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            sessionId: session.identity.sessionId,
            acceptingSubjectId: org.ownerSubjectId,
          });
        },
      );
      expect(accepted as unknown).toEqual(expectedAuthority);
      const task = await withRlsContext(
        db(),
        { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, org.ownerSubjectId);
          return await subscriptionAuthorityV2ForScheduledTaskInTransaction(tx, providerId, {
            accountId: org.accountId,
            workspaceId: org.personalWorkspaceId,
            reusableSessionId: null,
            acceptingSubjectId: org.ownerSubjectId,
          });
        },
      );
      expect(task as unknown).toEqual(expectedAuthority);
      // A personal connect with its identity never takes it over. (The
      // identity's uniqueness is per provider, not per kind, so the connect
      // is refused by the unique index: one provider has one kind in
      // production. The connect test checks a new connection's generation.)
      const otherIdentity = `other-kind-personal-${org.accountId}`;
      const sameIdentity = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
        connectSubscriptionCoreConnection(db(), provider, {
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          subjectId: org.ownerSubjectId,
          credentialEncrypted: encrypted(`same-identity-${crypto.randomUUID()}`),
          providerAccountId: otherIdentity,
          providerSubjectId: otherIdentity,
          planType: null,
          expiresAt: subject.expiresAt(),
          lastRefreshAt: new Date(),
          accountEmail: null,
          label: "same identity",
          providerState: subject.providerState,
        }),
      ).catch((error: unknown) => error);
      expect(sameIdentity).not.toMatchObject({ id: otherPersonal });
      expect(await connectionState(otherPersonal)).toEqual(otherPersonalBefore);
      const [labels] = await admin()<{ labels: string[] }[]>`
        select array_agg(label order by label) as labels from subscription_connections
        where id = any(${foreign}::uuid[])`;
      expect(labels!.labels).toEqual(["foreign-healthy", "foreign-quarantined"]);
      await expectForeignUntouched(org);
    });

    test("organization access and reach are edited for exactly this provider's connections of its kind", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `access-${crypto.randomUUID()}`);
      const route = (connectionId: string) => ({
        accountId: org.accountId,
        workspaceId: null,
        subjectId: org.ownerSubjectId,
        connectionId,
      });
      const ownerless = (workspaceId: string) => runningTurn(org, { workspaceId, owner: "none" });
      const untouchedIds = [
        org.otherKind.identified,
        org.otherKind.unidentified,
        org.foreign.healthy,
        org.foreign.quarantined,
      ];
      const accessState = async () =>
        await admin()<
          {
            id: string;
            scope: string;
            personal: boolean;
            models: string[] | null;
            version: number;
            assigned: number;
            policies: number;
            reach: number;
          }[]
        >`
          select connection.id::text as id, connection.scope_kind as scope,
            connection.allow_personal_workspaces as personal, connection.allowed_model_ids as models,
            connection.access_version::int as version,
            (select count(*)::int from subscription_connection_workspaces assignment
              where assignment.connection_id = connection.id) as assigned,
            (select count(*)::int from subscription_connection_assignment_policies policy
              where policy.connection_id = connection.id) as policies,
            (select count(*)::int from opengeni_private.subscription_core_auto_assignments auto
              where auto.connection_id = connection.id) as reach
          from subscription_connections connection
          where connection.id = any(${untouchedIds}::uuid[]) order by connection.id`;
      const before = await accessState();
      const initial = await getSubscriptionCoreModelConnectionAccess(db(), providerId, route(a));
      expect(initial).toMatchObject({
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
      });
      // One shared workspace only: placement follows the new assignment.
      const narrowed = await updateSubscriptionCoreModelConnectionAccess(
        db(),
        providerId,
        route(a),
        {
          allowedModels: null,
          allowedWorkspaces: [org.otherWorkspaceId],
          allowPersonalWorkspaces: false,
          version: initial!.version,
        },
      );
      expect(narrowed).toEqual({
        allowedModels: null,
        allowedWorkspaces: [org.otherWorkspaceId],
        allowPersonalWorkspaces: false,
        version: initial!.version + 1,
      });
      expect(await getSubscriptionCoreModelConnectionAccess(db(), providerId, route(a))).toEqual(
        narrowed,
      );
      expect(await placeChecked(await ownerless(org.otherWorkspaceId))).toMatchObject({
        kind: "run",
        connectionId: a,
      });
      expect(await placeChecked(await ownerless(org.sharedWorkspaceId))).toMatchObject({
        kind: "wait",
      });
      // Every shared workspace, including ones created later: the reach row
      // assigns a new workspace, and placement serves it there.
      const everywhere = await updateSubscriptionCoreModelConnectionAccess(
        db(),
        providerId,
        route(a),
        {
          allowedModels: null,
          allowedWorkspaces: null,
          allowPersonalWorkspaces: false,
          version: narrowed!.version,
        },
      );
      expect(everywhere).toEqual({
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        version: narrowed!.version + 1,
      });
      const [reach] = await admin()<{ provider: string; shared: boolean; personal: boolean }[]>`
        select provider, shared_workspaces as shared, personal_workspaces as personal
        from opengeni_private.subscription_core_auto_assignments
        where connection_id = ${a}::uuid`;
      expect(reach).toEqual({ provider: providerId, shared: true, personal: false });
      const later = await sharedWorkspace(org.accountId, org.ownerSubjectId, "Conformance later");
      expect(await placeChecked(await ownerless(later))).toMatchObject({
        kind: "run",
        connectionId: a,
      });
      // The provider's rows of the other kind and the foreign provider's rows
      // are neither read nor edited through this provider's access routes.
      for (const connectionId of untouchedIds) {
        expect(
          await getSubscriptionCoreModelConnectionAccess(db(), providerId, route(connectionId)),
        ).toBeNull();
        expect(
          await updateSubscriptionCoreModelConnectionAccess(db(), providerId, route(connectionId), {
            allowedModels: [m0.productModelId],
            allowedWorkspaces: [org.otherWorkspaceId],
            allowPersonalWorkspaces: false,
            version: before.find((row) => row.id === connectionId)!.version,
          }),
        ).toBeNull();
        // The reach routines refuse them themselves, whatever their caller
        // checked: the setter and the organization's rotation switch.
        const direct = await withModelConnectionAccessScope(db(), route(connectionId), (tx) =>
          tx.execute(sql`select opengeni_private.set_subscription_core_reach(
            ${providerId}, ${org.accountId}::uuid, ${connectionId}::uuid, true, false)`),
        ).catch((error: unknown) => error);
        expect(postgresCode(direct)).toBe("P0002");
        const allocator = await withModelConnectionAccessScope(db(), route(connectionId), (tx) =>
          tx.execute(sql`select opengeni_private.set_subscription_core_reach_allocator(
            ${providerId}, ${org.accountId}::uuid, ${connectionId}::uuid, false)`),
        ).catch((error: unknown) => error);
        expect(postgresCode(allocator)).toBe("P0002");
      }
      expect(await accessState()).toEqual(before);
      // A workspace's own connections are edited through the workspace route,
      // which never calls the reach routine: it reads only this provider's
      // kind, so the workspace's row of the other kind is neither read nor
      // changed.
      const workspaceManaged = async (kind: string, label: string) => {
        const [row] = await admin()<{ id: string }[]>`
          insert into subscription_connections (
            account_id, provider, kind, credential_encrypted, ownership, scope_kind,
            allow_personal_workspaces, provider_account_id, provider_subject_id, label,
            managed_by_workspace_id
          ) values (
            ${org.accountId}::uuid, ${providerId}, ${kind},
            ${encryptEnvironmentValue(key, label)}, 'shared', 'workspaces', false,
            ${`${label}-${org.accountId}`}, ${`${label}-${org.accountId}`}, ${label},
            ${org.sharedWorkspaceId}::uuid
          ) returning id::text as id`;
        await admin()`
          insert into subscription_connection_workspaces (account_id, connection_id, workspace_id)
          values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.sharedWorkspaceId}::uuid)`;
        await admin()`
          insert into subscription_connection_assignment_policies (
            account_id, connection_id, workspace_id, inference_pool, managed_by_workspace_id
          ) values (${org.accountId}::uuid, ${row!.id}::uuid, ${org.sharedWorkspaceId}::uuid,
            'workspace', ${org.sharedWorkspaceId}::uuid)`;
        return row!.id;
      };
      const local = await workspaceManaged(connectionKind, `local-${crypto.randomUUID()}`);
      const localOtherKind = await workspaceManaged(
        connectionKind === "api_key" ? "subscription" : "api_key",
        `local-other-kind-${crypto.randomUUID()}`,
      );
      const workspaceRoute = (connectionId: string) => ({
        ...route(connectionId),
        workspaceId: org.sharedWorkspaceId,
      });
      const localAccess = await getSubscriptionCoreModelConnectionAccess(
        db(),
        providerId,
        workspaceRoute(local),
      );
      expect(localAccess).toMatchObject({
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
      });
      expect(
        await updateSubscriptionCoreModelConnectionAccess(db(), providerId, workspaceRoute(local), {
          ...localAccess!,
          allowedModels: [m0.productModelId],
        }),
      ).toEqual({
        ...localAccess!,
        allowedModels: [m0.productModelId],
        version: localAccess!.version + 1,
      });
      const [otherKindVersion] = await admin()<{ version: number }[]>`
        select access_version::int as version from subscription_connections
        where id = ${localOtherKind}::uuid`;
      expect(
        await getSubscriptionCoreModelConnectionAccess(
          db(),
          providerId,
          workspaceRoute(localOtherKind),
        ),
      ).toBeNull();
      expect(
        await updateSubscriptionCoreModelConnectionAccess(
          db(),
          providerId,
          workspaceRoute(localOtherKind),
          {
            allowedModels: [m0.productModelId],
            allowedWorkspaces: null,
            allowPersonalWorkspaces: false,
            version: otherKindVersion!.version,
          },
        ),
      ).toBeNull();
      const [otherKindAfter] = await admin()<{ models: string[] | null; version: number }[]>`
        select allowed_model_ids as models, access_version::int as version
        from subscription_connections where id = ${localOtherKind}::uuid`;
      expect(otherKindAfter).toEqual({ models: null, version: otherKindVersion!.version });
      await expectForeignUntouched(org);
    });

    test("leases are generation-fenced: replay, renew, foreign holders, release", async () => {
      const org = await organization();
      const connectionId = await sharedConnection(org, `lease-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      expect(await placeChecked(turn)).toMatchObject({
        kind: "run",
        connectionId,
        reusedLease: false,
      });
      // The same attempt's retry keeps its live lease.
      expect(await place(turn)).toMatchObject({ kind: "run", connectionId, reusedLease: true });
      // Another holder at the same generation is not this attempt.
      expect(await place(turn, { holderId: `${turn.holderId}:other` })).toEqual({
        kind: "attempt_fenced",
      });
      const tenant = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
      const leaseIdentity = {
        ...tenant,
        sessionId: turn.identity.sessionId,
        turnId: turn.identity.turnId,
        provider: providerId,
        ...leaseOf(turn, connectionId),
      };
      const renewed = await withRlsContext(db(), tenant, (tx) =>
        renewSubscriptionTurnLease(tx, { ...leaseIdentity, ttlMs: TTL * 2 }),
      );
      expect(renewed).toBeInstanceOf(Date);
      // Renew and release are fenced by holder, generation and connection:
      // a stale or foreign identity changes nothing.
      const strangers = [
        { ...leaseIdentity, holderId: `${turn.holderId}:other` },
        { ...leaseIdentity, generation: leaseIdentity.generation + 1 },
        { ...leaseIdentity, generation: leaseIdentity.generation - 1 },
        { ...leaseIdentity, connectionId: org.foreign.healthy },
        { ...leaseIdentity, connectionId: org.otherKind.identified },
      ];
      const leasedUntil = async () => {
        const [row] = await admin()<{ leased_until: Date }[]>`
          select leased_until from subscription_leases
          where turn_id = ${turn.identity.turnId}::uuid and connection_id = ${connectionId}::uuid`;
        return row?.leased_until.getTime() ?? null;
      };
      const before = await leasedUntil();
      for (const stranger of strangers) {
        expect(
          await withRlsContext(db(), tenant, (tx) =>
            renewSubscriptionTurnLease(tx, { ...stranger, ttlMs: TTL * 4 }),
          ),
        ).toBeNull();
        expect(
          await withRlsContext(db(), tenant, (tx) => releaseSubscriptionTurnLease(tx, stranger)),
        ).toBe(false);
      }
      expect(await leasedUntil()).toBe(before);
      // The credential is the adapter's own decoding, for this lease only.
      const loaded = await runtime().loadSubscriptionCoreCredential(
        db(),
        settings,
        turn.identity,
        leaseOf(turn, connectionId),
      );
      expect(loaded).toMatchObject({ kind: "loaded", credential: { connectionId } });
      expect(await callUpstream(turn, connectionId, [])).toBeNull();
      expect(
        await runtime().loadSubscriptionCoreCredential(db(), settings, turn.identity, {
          ...leaseOf(turn, connectionId),
          holderId: `${turn.holderId}:other`,
        }),
      ).toEqual({ kind: "lease_lost" });
      expect(
        await withRlsContext(db(), tenant, (tx) => releaseSubscriptionTurnLease(tx, leaseIdentity)),
      ).toBe(true);
      expect(
        await runtime().loadSubscriptionCoreCredential(
          db(),
          settings,
          turn.identity,
          leaseOf(turn, connectionId),
        ),
      ).toEqual({ kind: "lease_lost" });
      expect(
        await withRlsContext(db(), tenant, (tx) =>
          renewSubscriptionTurnLease(tx, { ...leaseIdentity, ttlMs: TTL }),
        ),
      ).toBeNull();
      expect(await place(turn)).toMatchObject({ kind: "run", connectionId, reusedLease: false });
      // A lease written directly on a row of this provider's other connection
      // kind (placement never offers one) loads no credential: the credential
      // load checks the registered kind itself. The turn's placed lease is
      // released first, and the direct lease is written in the placement
      // world placement itself uses; the database lease guard admits the row
      // (it checks provider, session authority and status, not kind).
      expect(
        await withRlsContext(db(), tenant, (tx) => releaseSubscriptionTurnLease(tx, leaseIdentity)),
      ).toBe(true);
      const otherLease = leaseOf(turn, org.otherKind.identified);
      const leasedOther = await withSubscriptionCoreProviderPlacementWorld(
        db(),
        provider,
        {
          ...turn.identity,
          preferredModelId: turn.productModelId,
          reasoningLevel: "medium",
          models: [{ id: turn.productModelId, provider: providerId, reasoningLevels: ["medium"] }],
          reselectionPoints: [],
          now: new Date(),
        },
        (tx) => acquireSubscriptionTurnLease(tx, { ...leaseIdentity, ...otherLease, ttlMs: TTL }),
      );
      // If the lease guard ever refuses such a row itself, assert that
      // refusal here instead: either way no credential may load.
      expect(leasedOther).toMatchObject({ status: "completed", value: expect.anything() });
      expect(
        await runtime().loadSubscriptionCoreCredential(db(), settings, turn.identity, otherLease),
      ).toEqual({ kind: "unavailable" });
    });

    test("each request is reserved and settled; an unknown outcome is never replayed", async () => {
      const org = await organization();
      const connectionId = await sharedConnection(org, `request-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId });
      // A received response settles its reservation (asserted in callUpstream).
      expect(await callUpstream(turn, connectionId, [])).toBeNull();
      const requests = subscriptionCoreRequests(provider);
      const lease = leaseOf(turn, connectionId);
      const request = (requestId: string) => ({
        requestId,
        transportAttempt: 1,
        attemptId: turn.attemptId,
        executionGeneration: turn.executionGeneration,
      });
      // A lease another holder took is not this request's authority.
      const leaseLost = provider.errors.leaseLost().constructor;
      await expect(
        requests.reserveSubscriptionCoreRequest(
          db(),
          turn.identity,
          { ...lease, holderId: `${lease.holderId}:other` },
          request(crypto.randomUUID()),
        ),
      ).rejects.toBeInstanceOf(leaseLost);
      // A request whose outcome is unknown (the connection dropped mid-call)
      // blocks every later model request of the turn instead of a replay.
      const { operationId } = await requests.reserveSubscriptionCoreRequest(
        db(),
        turn.identity,
        lease,
        request(crypto.randomUUID()),
      );
      await requests.settleSubscriptionCoreRequest(db(), turn.identity, lease, {
        operationId,
        attemptId: turn.attemptId,
        executionGeneration: turn.executionGeneration,
        outcome: "unknown",
      });
      expect(await requestOutcome(operationId)).toBe("unknown");
      const unknownOutcome = provider.errors.requestOutcomeUnknown().constructor;
      await expect(
        requests.reserveSubscriptionCoreRequest(
          db(),
          turn.identity,
          lease,
          request(crypto.randomUUID()),
        ),
      ).rejects.toBeInstanceOf(unknownOutcome);
    });

    test("a rate-limited connection fails over to another and counts the refusal", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `b-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      const first = await placeChecked(turn);
      if (first.kind !== "run") throw new Error("expected a run");
      const other = first.connectionId === a ? b : a;
      expect(
        await callUpstream(turn, first.connectionId, [
          { kind: "rate_limited", retryAfterSeconds: 30 },
        ]),
      ).toEqual({ kind: "rate_limited", retryAfterMs: 30_000 });
      const second = await placeChecked(turn);
      expect(second).toMatchObject({
        kind: "run",
        connectionId: other,
        previousConnectionId: first.connectionId,
      });
      expect(await runtime().countSubscriptionCoreTurnRefusals(db(), turn.identity)).toBe(1);
      expect(await callUpstream(turn, other, [])).toBeNull();
      await expectForeignUntouched(org);
    });

    test("rate limits and an exhausted spend budget wait for the earliest reset, then wake and resume", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `b-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      const now = Date.now();
      const resetA = now + 60_000;
      const resetB = now + 120_000;
      // Whichever connection serves first is refused until the later reset,
      // then the other until the earlier one.
      const first = await placeChecked(turn, new Date(now));
      if (first.kind !== "run") throw new Error("expected a run");
      const [budget, rateLimited] = first.connectionId === a ? [a, b] : [b, a];
      expect(
        await callUpstream(turn, budget, [{ kind: "budget_exhausted", resetsAt: resetB }], now),
      ).toEqual({ kind: "exhausted", resetAt: resetB });
      expect(await placeChecked(turn, new Date(now))).toMatchObject({
        kind: "run",
        connectionId: rateLimited,
      });
      expect(
        await callUpstream(
          turn,
          rateLimited,
          [{ kind: "rate_limited", retryAfterSeconds: 60 }],
          now,
        ),
      ).toMatchObject({ kind: "rate_limited" });
      // Nothing can serve: a durable wait at the earliest known reset.
      const waiting = await placeChecked(turn, new Date(now));
      expect(waiting).toMatchObject({ kind: "wait" });
      expect(instantOf(waiting, "earliestResetAt")).toBe(resetA);
      if (waiting.kind !== "wait" || waiting.earliestResetAt === null)
        throw new Error("expected a wait with a reset");
      expect(await leaseCount(org, turn)).toBe(0);
      const tenant = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
      const waiter = await withRlsContext(db(), tenant, (tx) =>
        upsertSubscriptionCapacityWaiter(tx, {
          ...tenant,
          sessionId: turn.identity.sessionId,
          turnId: turn.identity.turnId,
          waiterId: crypto.randomUUID(),
          provider: providerId,
          waitReason: waiting.kind === "wait" ? waiting.reason : "unknown",
          resetKind: "authoritative",
          // Armed with the earliest reset the placement returned.
          earliestResetAt: waiting.earliestResetAt,
          nextCheckAt: waiting.earliestResetAt,
          generation: 1,
          wakeRevision: 1,
          observedWakeRevision: 1,
          blockedTurnGeneration: turn.executionGeneration,
        }),
      );
      expect(waiter).toMatchObject({ provider: providerId });
      expect(instantOf(waiter, "earliestResetAt")).toBe(resetA);
      const due = () =>
        withRlsContext(db(), tenant, (tx) =>
          listDueSubscriptionCapacityWaiters(tx, { provider: providerId, limit: 50 }),
        );
      expect((await due()).some((row) => row.waiterId === waiter!.waiterId)).toBe(false);
      // Before the reset nothing changes; after it the rate-limited connection serves.
      expect(await evaluateChecked(turn, new Date(resetA - 1_000))).toMatchObject({ kind: "wait" });
      expect(await evaluateChecked(turn, new Date(resetA + 1_000))).toMatchObject({
        kind: "run",
        connectionId: rateLimited,
      });
      // A capacity change wakes the waiter durably (outbox), the workflow
      // observes that exact revision and the same turn resumes.
      const revision = await withRlsContext(db(), tenant, (tx) =>
        wakeSubscriptionCapacityWaiter(tx, {
          ...tenant,
          sessionId: turn.identity.sessionId,
          waiterId: waiter!.waiterId,
          generation: 1,
        }),
      );
      expect(revision).toBe(2);
      expect((await due()).find((row) => row.waiterId === waiter!.waiterId)).toMatchObject({
        provider: providerId,
        wakeRevision: 2,
        observedWakeRevision: 1,
      });
      const [outbox] = await admin()<{ count: number }[]>`
        select count(*)::int as count from subscription_capacity_wake_outbox
        where waiter_id = ${waiter!.waiterId}::uuid and wake_revision = 2`;
      expect(outbox!.count).toBe(1);
      expect(
        await withRlsContext(db(), tenant, (tx) =>
          observeSubscriptionCapacityWaiterWake(tx, {
            ...tenant,
            sessionId: turn.identity.sessionId,
            waiterId: waiter!.waiterId,
            generation: 1,
            wakeRevision: 2,
          }),
        ),
      ).toBe(true);
      expect(await placeChecked(turn, new Date(resetA + 1_000))).toMatchObject({
        kind: "run",
        connectionId: rateLimited,
      });
      await expectForeignUntouched(org);
    });

    test("an exhausted budget with no known reset waits for the adapter's fallback or a usage reading", async () => {
      const org = await organization();
      const label = `budget-${crypto.randomUUID()}`;
      const connectionId = await sharedConnection(org, label);
      const turn = await runningTurn(org);
      const now = Date.now();
      const fallback = now + provider.adapter.health.exhaustedFallbackMs;
      expect(await placeChecked(turn, new Date(now))).toMatchObject({ kind: "run", connectionId });
      expect(
        await callUpstream(turn, connectionId, [{ kind: "budget_exhausted", resetsAt: null }], now),
      ).toEqual({ kind: "exhausted", resetAt: null });
      // Without a reset the connection rests for the adapter's fallback, so
      // it recovers on its own even when no usage reading exists.
      const resting = await placeChecked(turn, new Date(now));
      expect(resting).toMatchObject({ kind: "wait" });
      expect(instantOf(resting, "earliestResetAt")).toBe(fallback);
      expect(await evaluateChecked(turn, new Date(fallback - 1_000))).toMatchObject({
        kind: "wait",
      });
      expect(await evaluateChecked(turn, new Date(fallback + 1_000))).toMatchObject({
        kind: "run",
        connectionId,
      });
      const usage = subject.upstream.usage;
      if (!usage) return;
      // The limit is raised upstream; the connector's usage read recovers it
      // early, and that recovery is what wakes the account's waiters.
      usage.restore(credentials.get(label)!);
      const observation = await usage.read(credentials.get(label)!, now + 1_000, 1);
      const operations = subscriptionCoreOperations(provider);
      const recorded = await operations.recordSubscriptionCoreUsageObservation(
        db(),
        {
          kind: "workspace",
          accountId: org.accountId,
          workspaceId: org.sharedWorkspaceId,
          subjectId: org.ownerSubjectId,
        },
        connectionId,
        observation,
      );
      expect(recorded).toEqual({ applied: true, recovered: true });
      expect(await placeChecked(turn, new Date(now + 2_000))).toMatchObject({
        kind: "run",
        connectionId,
      });
    });

    test("overloaded, failed and lost requests neither fail over nor change health", async () => {
      const org = await organization();
      await sharedConnection(org, `a-${crypto.randomUUID()}`);
      await sharedConnection(org, `b-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      const first = await placeChecked(turn);
      if (first.kind !== "run") throw new Error("expected a run");
      expect(await callUpstream(turn, first.connectionId, [{ kind: "overloaded" }])).toEqual({
        kind: "overloaded",
      });
      expect(await callUpstream(turn, first.connectionId, [{ kind: "server_error" }])).toEqual({
        kind: "transient",
      });
      // Not refusals: the turn keeps its connection, nothing is counted.
      expect(await runtime().countSubscriptionCoreTurnRefusals(db(), turn.identity)).toBe(0);
      expect(await connectionRow(first.connectionId)).toMatchObject({ status: "active" });
      expect(await place(turn)).toMatchObject({
        kind: "run",
        connectionId: first.connectionId,
        reusedLease: true,
      });
      // A request whose reply never came is unknown and blocks any replay.
      expect(await callUpstream(turn, first.connectionId, [{ kind: "connection_lost" }])).toBe(
        "unknown_outcome",
      );
      expect(await runtime().countSubscriptionCoreTurnRefusals(db(), turn.identity)).toBe(0);
      await expect(callUpstream(turn, first.connectionId, [])).rejects.toBeInstanceOf(
        provider.errors.requestOutcomeUnknown().constructor,
      );
      await expectForeignUntouched(org);
    });

    test("a forbidden connection is quarantined, excluded, and recovers when its retry time passes", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `b-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      const first = await placeChecked(turn);
      if (first.kind !== "run") throw new Error("expected a run");
      const [refused, other] = first.connectionId === a ? [a, b] : [b, a];
      const refusedAt = Date.now();
      expect(await callUpstream(turn, refused, [{ kind: "forbidden" }], refusedAt)).toEqual({
        kind: "forbidden",
      });
      const quarantined = await connectionRow(refused);
      expect(quarantined.status).toBe("error");
      // Quarantined for the adapter's forbidden quarantine, not longer or shorter.
      const quarantineEnd = refusedAt + provider.adapter.health.forbiddenQuarantineMs;
      expect(
        Math.abs(new Date(quarantined.health_retry_at!).getTime() - quarantineEnd),
      ).toBeLessThan(5_000);
      expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId: other });
      // The other one is rate-limited too: the wait reports the quarantine's end.
      expect(
        await callUpstream(turn, other, [{ kind: "rate_limited", retryAfterSeconds: 600 }]),
      ).toMatchObject({
        kind: "rate_limited",
      });
      // This provider's row of the other kind is quarantined too, until
      // sooner: the wait's retry time is still this kind's quarantine end.
      await admin()`update subscription_connections set status = 'error',
        health_retry_at = clock_timestamp() + interval '30 seconds'
        where id = ${org.otherKind.identified}::uuid`;
      // And its other row of the other kind, active, holds a current model
      // catalog that expires sooner still (the wait's second deadline).
      await admin()`update subscription_connections
        set refresh_generation = greatest(refresh_generation, 1)
        where id = ${org.otherKind.unidentified}::uuid`;
      await admin()`
        insert into subscription_connection_quota (
          account_id, connection_id, quota, observed_refresh_generation, revision, updated_at,
          model_catalog_slugs, model_catalog_refresh_generation, model_catalog_observed_at,
          model_catalog_expires_at
        )
        select connection.account_id, connection.id, ${admin().json({
          windows: [],
          modelCooldowns: {},
        })}::jsonb, connection.refresh_generation, 1, clock_timestamp(),
          ${admin().array([m0.upstreamModelId])}, connection.refresh_generation,
          clock_timestamp(), clock_timestamp() + interval '20 seconds'
        from subscription_connections connection
        where connection.id = ${org.otherKind.unidentified}::uuid`;
      const waiting = await placeChecked(turn);
      expect(waiting).toMatchObject({ kind: "wait" });
      expect(instantOf(waiting, "healthRetryAt")).toBe(
        new Date(quarantined.health_retry_at!).getTime(),
      );
      // When the retry time passes, the core's recovery returns it to service
      // (and only it: the foreign provider's quarantine and that of this
      // provider's row of the other kind have passed too).
      await admin()`update subscription_connections set health_retry_at = clock_timestamp() - interval '1 second'
        where id = any(${[refused, org.foreign.quarantined]}::uuid[])`;
      await admin()`update subscription_connections set status = 'error',
        health_retry_at = clock_timestamp() - interval '1 second'
        where id = ${org.otherKind.identified}::uuid`;
      expect(await runtime().recoverSubscriptionCoreConnectionHealth(db(), turn.identity)).toBe(1);
      expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId: refused });
      expect((await connectionRow(org.otherKind.identified)).status).toBe("error");
      await admin()`update subscription_connections set status = 'active', health_retry_at = null
        where id = ${org.otherKind.identified}::uuid`;
      await expectForeignUntouched(org);
    });

    test.skipIf(provider.adapter.refresh !== null)(
      "a refused static credential becomes needs-relogin instead of being refreshed",
      async () => {
        const org = await organization();
        const connectionId = await sharedConnection(org, `static-${crypto.randomUUID()}`);
        const turn = await runningTurn(org);
        expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId });
        expect(await callUpstream(turn, connectionId, [{ kind: "unauthorized" }])).toEqual({
          kind: "unauthorized",
        });
        expect(await connectionRow(connectionId)).toMatchObject({ status: "needs_relogin" });
        expect(
          await runtime().loadSubscriptionCoreCredential(
            db(),
            settings,
            turn.identity,
            leaseOf(turn, connectionId),
          ),
        ).toEqual({ kind: "needs_relogin" });
        expect(await placeChecked(turn)).toMatchObject({ kind: "wait" });
      },
    );

    test.skipIf(provider.adapter.refresh === null)(
      "a refused renewable credential is refreshed once and retried on the same connection",
      async () => {
        const org = await organization();
        const connectionId = await sharedConnection(org, `renewable-${crypto.randomUUID()}`);
        const turn = await runningTurn(org);
        expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId });
        const generation = async () => {
          const [row] = await admin()<{ refresh_generation: number | string }[]>`
            select refresh_generation from subscription_connections where id = ${connectionId}::uuid`;
          return Number(row!.refresh_generation);
        };
        const before = await generation();
        // A refusal the refresh cures: refreshed, retried here, answered.
        expect(
          await callUpstream(turn, connectionId, [{ kind: "unauthorized" }], Date.now(), false),
        ).toBeNull();
        expect(await generation()).toBe(before + 1);
        expect(await connectionRow(connectionId)).toMatchObject({ status: "active" });
        expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId });
        // A refusal that survives the refresh: refreshed once, then quarantined
        // for sign-in, and the turn no longer runs on the connection.
        expect(await callUpstream(turn, connectionId, [{ kind: "unauthorized" }])).toEqual({
          kind: "unauthorized",
        });
        expect(await generation()).toBe(before + 2);
        expect(await connectionRow(connectionId)).toMatchObject({ status: "needs_relogin" });
        expect(await placeChecked(turn)).toMatchObject({ kind: "wait" });
        await expectForeignUntouched(org);
      },
    );

    test("a limit on one model cools that model only; the connection serves the others", async () => {
      const org = await organization();
      const connectionId = await sharedConnection(org, `per-model-${crypto.randomUUID()}`);
      const now = Date.now();
      const limited = await runningTurn(org, { model: m0 });
      expect(await placeChecked(limited, new Date(now))).toMatchObject({
        kind: "run",
        connectionId,
      });
      expect(
        await callUpstream(
          limited,
          connectionId,
          [{ kind: "model_rate_limited", retryAfterSeconds: 600 }],
          now,
        ),
      ).toEqual({ kind: "rate_limited", retryAfterMs: 600_000, modelId: m0.productModelId });
      // The limited model waits for its own end; another model still runs here.
      expect(await placeChecked(limited, new Date(now))).toMatchObject({ kind: "wait" });
      expect(
        await placeChecked(await runningTurn(org, { model: m1 }), new Date(now)),
      ).toMatchObject({ kind: "run", connectionId });
      // The model's cooldown ends at the provider's retry time, not sooner.
      expect(await evaluateChecked(limited, new Date(now + 599_000))).toMatchObject({
        kind: "wait",
      });
      expect(await evaluateChecked(limited, new Date(now + 601_000))).toMatchObject({
        kind: "run",
        connectionId,
      });
      await expectForeignUntouched(org);
    });

    test("each model is placed only on connections that serve it (allowlists, refusal cooldowns)", async () => {
      const org = await organization();
      const narrow = await sharedConnection(
        org,
        `narrow-${crypto.randomUUID()}`,
        { kind: "organization" },
        [m0.productModelId, m1.productModelId],
      );
      const wide = await sharedConnection(org, `wide-${crypto.randomUUID()}`);
      // An administrator's allowlist keeps the third model off the narrow connection.
      expect(await placeChecked(await runningTurn(org, { model: m2 }))).toMatchObject({
        kind: "run",
        connectionId: wide,
      });
      // A model the provider refused cools down on that connection only.
      const turn = await runningTurn(org, { model: m0 });
      const first = await placeChecked(turn);
      if (first.kind !== "run") throw new Error("expected a run");
      const refusedAt = Date.now();
      expect(
        await callUpstream(turn, first.connectionId, [{ kind: "model_unavailable" }], refusedAt),
      ).toEqual({
        kind: "entitlement_missing",
        modelId: m0.productModelId,
      });
      // The model cools down for the adapter's entitlement cooldown.
      const [cooldown] = await admin()<{ until: string | null }[]>`
        select quota->'modelCooldowns'->>${m0.productModelId} as until
        from subscription_connection_quota where connection_id = ${first.connectionId}::uuid`;
      expect(
        Math.abs(
          Number(cooldown?.until) - (refusedAt + provider.adapter.health.entitlementCooldownMs),
        ),
      ).toBeLessThan(5_000);
      const other = first.connectionId === narrow ? wide : narrow;
      expect(await placeChecked(turn)).toMatchObject({ kind: "run", connectionId: other });
      // The refusal cools that model only: the connection stays healthy and,
      // with the other connection off, still serves another model.
      expect(await connectionRow(first.connectionId)).toMatchObject({ status: "active" });
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${other}::uuid`;
      const sibling = await runningTurn(org, { model: m1 });
      expect(await placeChecked(sibling)).toMatchObject({
        kind: "run",
        connectionId: first.connectionId,
      });
    });

    test("a connection's observed model catalog decides a frozen upstream model's entitlement", async () => {
      const org = await organization();
      const broad = await sharedConnection(org, `broad-${crypto.randomUUID()}`);
      const single = await sharedConnection(org, `single-${crypto.randomUUID()}`);
      const operations = subscriptionCoreOperations(provider);
      const scope = {
        kind: "workspace" as const,
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        subjectId: org.ownerSubjectId,
      };
      const catalog = async (connectionId: string, slugs: string[]) => {
        const [row] = await admin()<{ refresh_generation: string }[]>`
          select refresh_generation::text as refresh_generation from subscription_connections
          where id = ${connectionId}::uuid`;
        expect(
          await operations.recordSubscriptionCoreModelCatalog(db(), scope, connectionId, {
            slugs,
            refreshGeneration: Number(row!.refresh_generation),
            observedAt: Date.now() - 1_000,
          }),
        ).toBe(true);
      };
      await catalog(broad, [m0.upstreamModelId, m1.upstreamModelId]);
      await catalog(single, [m1.upstreamModelId]);
      // No connection lists the third vendor's model: the turn waits.
      const unserved = await runningTurn(org, { model: m2, frozenUpstreamModel: true });
      expect(await placeChecked(unserved, new Date(), m2.upstreamModelId)).toMatchObject({
        kind: "wait",
      });
      // Only the connection whose catalog lists the model serves it.
      const served = await runningTurn(org, { model: m0, frozenUpstreamModel: true });
      expect(await placeChecked(served, new Date(), m0.upstreamModelId)).toMatchObject({
        kind: "run",
        connectionId: broad,
      });
    });
  });

  async function leaseCount(org: Org, turn: Turn): Promise<number> {
    const [row] = await admin()<{ count: number }[]>`
      select count(*)::int as count from subscription_leases
      where account_id = ${org.accountId}::uuid and turn_id = ${turn.identity.turnId}::uuid`;
    return row!.count;
  }
}
