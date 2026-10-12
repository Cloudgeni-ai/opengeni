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
  declaredCacheLifetimeMs,
  decidePlacement,
  type Ineligibility,
  type PlacementDecision,
  type PlacementInput,
  subscriptionCoreCredentialRefresher,
  type ProviderErrorOutcome,
  type ReselectionReason,
  type SubscriptionQuota,
} from "@opengeni/subscriptions";
import { checkPlacementDecision } from "@opengeni/subscriptions/reference";
import { sql } from "drizzle-orm";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  deliverSubscriptionCoreProviderWakes,
  enqueueSessionWorkflowWakeInTransaction,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  transitionSessionVisibility,
  withRlsContext,
  withSessionRlsActorContext,
  type DbClient,
} from "../../src";
import {
  chooseSubscriptionCoreSessionAccount,
  readSubscriptionCoreSessionAccountChoice,
  readSubscriptionPersonPreferences,
  writeSubscriptionPersonPreferences,
} from "../../src/subscription-core/session-choice";
import {
  rawRows,
  setSubjectRlsContext,
  withWorkspaceSubjectSessionActivityRls,
} from "../../src/database";
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
import { wakeSubscriptionCoreCapacityWaiters } from "../../src/subscription-core/waiters";
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
  /**
   * Whether this subject's credentials are expected to renew; the suite
   * checks the adapter agrees (a subject without it takes the adapter's word).
   */
  renews?: boolean;
  /**
   * Whether the adapter must declare its usage readings complete (design
   * 5.3, Claude track): a complete reading ends an omitted exhausted window,
   * a partial one keeps it until its reset. Every subject states it, and the
   * suite checks the adapter's declaration against it, so a removed or
   * flipped declaration fails the suite instead of switching branches.
   */
  usageReadingsComplete: boolean;
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
  // Whether the subject's credentials renew: the adapter's refresher applies
  // only to credential formats whose capabilities say so (a provider may
  // offer renewable and non-renewable formats, such as OAuth and a setup
  // token), so the format of the subject's credentials decides.
  const renews =
    subscriptionCoreCredentialRefresher(provider.adapter, subject.credential("renewal-probe")) !==
    null;
  if (subject.renews !== undefined && subject.renews !== renews)
    throw new Error(
      `The conformance subject expects credentials that ${subject.renews ? "renew" : "never renew"}`,
    );
  const usageReadingsComplete = provider.adapter.usageReadingsComplete === true;
  if (usageReadingsComplete !== subject.usageReadingsComplete)
    throw new Error(
      `The conformance subject expects ${subject.usageReadingsComplete ? "complete" : "partial"} usage readings`,
    );
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
    id: string = crypto.randomUUID(),
  ): Promise<string> {
    const [workspace] = await admin()<{ id: string }[]>`
      insert into workspaces (id, account_id, name)
      values (${id}::uuid, ${accountId}::uuid, ${name}) returning id::text as id`;
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

  /** Another human member of the organization and of its shared workspace. */
  async function workspaceMember(org: Org): Promise<string> {
    const subjectId = `user:conformance-member-${crypto.randomUUID()}`;
    const [personalWorkspace] = await admin()<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Conformance member Personal') returning id::text as id`;
    await admin()`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${org.accountId}::uuid, ${subjectId}, 'member', 'active', ${personalWorkspace!.id}::uuid
      )`;
    await admin()`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${subjectId}, 'member')`;
    return subjectId;
  }

  type Turn = {
    identity: SubscriptionCoreTurnIdentity;
    triggerEventId: string;
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
      /** Who sends the turn: the owner, a service, or another human member. */
      initiator?: "owner" | "service" | { subjectId: string };
      /** The frozen personal entry: current generation (true), none (false), or a given generation. */
      personalAuthority?: boolean | { authorityGeneration: number };
      /** The membership the frozen personal entry names (default: the owner's). */
      personalMembershipId?: string;
      model?: { productModelId: string; upstreamModelId: string };
      frozenUpstreamModel?: boolean;
      /** The next turn of this idle session instead of a new session (see `nextTurn`). */
      sessionId?: string;
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
    const session =
      input.sessionId !== undefined
        ? { id: input.sessionId }
        : ownerless
          ? await createSessionCall()
          : await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, createSessionCall);
    const service = input.initiator === "service" || ownerless;
    const sender =
      typeof input.initiator === "object" ? input.initiator.subjectId : org.ownerSubjectId;
    // A service turn in an owned session is accepted in the owner's session
    // context (it sees the session) with no initiating human.
    const actor = ownerless
      ? { subjectId: "service:subscription-core", initiatingHumanSubjectId: null }
      : { subjectId: service ? org.ownerSubjectId : sender };
    const triggerEventId = crypto.randomUUID();
    const turn = await withSessionRlsActorContext(actor, () =>
      enqueueSessionTurn(db(), {
        accountId: org.accountId,
        workspaceId,
        sessionId: session.id,
        triggerEventId,
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
          : { kind: "subject", subjectId: sender },
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
      triggerEventId,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      holderId: `${providerId}-turn:${session.id}:${turn.id}:${attemptId}`,
      productModelId: model.productModelId,
    };
  }

  function place(
    turn: Turn,
    options: { now?: Date; holderId?: string; provider?: SubscriptionCoreProvider } = {},
  ) {
    const turns = options.provider ? subscriptionCoreTurns(options.provider) : runtime();
    return turns.placeSubscriptionCoreTurn(db(), {
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
   * Finish a placed turn as a worker does (its lease released, the turn
   * completed and the session idle) and claim the session's next turn: the
   * placement that cache-aware stickiness decides (SUB-STICK-02).
   */
  async function nextTurn(
    org: Org,
    previous: Turn,
    next: {
      initiator?: "owner" | "service" | { subjectId: string };
      model?: { productModelId: string; upstreamModelId: string };
      personalAuthority?: boolean;
      /** Runs while the session is idle between the two turns. */
      between?: () => Promise<void>;
    } = {},
  ): Promise<Turn> {
    const { workspaceId, sessionId, turnId } = previous.identity;
    const tenant = { accountId: org.accountId, workspaceId };
    const [lease] = await admin()<{ connection_id: string }[]>`
      select connection_id::text as connection_id from subscription_leases
      where workspace_id = ${workspaceId}::uuid and turn_id = ${turnId}::uuid`;
    if (lease)
      expect(
        await withRlsContext(db(), tenant, (tx) =>
          releaseSubscriptionTurnLease(tx, {
            ...tenant,
            sessionId,
            turnId,
            provider: providerId,
            ...leaseOf(previous, lease.connection_id),
          }),
        ),
      ).toBe(true);
    const settled = await applySessionTurnSettlement(db(), workspaceId, {
      sessionId,
      turnId,
      triggerEventId: previous.triggerEventId,
      attemptId: previous.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.completed", payload: {} },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    });
    expect(settled.action).toBe("settled");
    await next.between?.();
    return runningTurn(org, {
      workspaceId,
      sessionId,
      initiator: next.initiator ?? "owner",
      ...(next.personalAuthority !== undefined
        ? { personalAuthority: next.personalAuthority }
        : {}),
      model:
        next.model ??
        subject.models.find((model) => model.productModelId === previous.productModelId)!,
    });
  }

  /** The session binding as stored: account, choice and cache clock (epoch ms or null). */
  async function bindingOf(turn: Turn) {
    const [row] = await admin()<
      {
        connection_id: string | null;
        choice: string;
        last_model_call_at: Date | null;
        version: number;
      }[]
    >`select connection_id::text as connection_id, choice, last_model_call_at,
        version::int as version
      from subscription_session_bindings
      where workspace_id = ${turn.identity.workspaceId}::uuid
        and session_id = ${turn.identity.sessionId}::uuid`;
    if (!row) return null;
    return {
      connectionId: row.connection_id,
      choice: row.choice,
      clock: row.last_model_call_at === null ? null : new Date(row.last_model_call_at).getTime(),
      version: row.version,
    };
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

    test("SUB-STICK-01, SUB-STICK-02, SUB-STICK-04: a session keeps its account while the cache is warm, whoever sends, and re-runs selection once it is cold", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `warm-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `warm-b-${crypto.randomUUID()}`);
      const lifetime = declaredCacheLifetimeMs(provider.adapter.cacheFacts);
      // The first turn binds the session; its cache clock starts at the placement.
      const placedAt = Date.now() - 60_000;
      const first = await runningTurn(org);
      const bound = await placeChecked(first, new Date(placedAt));
      if (bound.kind !== "run") throw new Error("expected a run");
      expect(bound.reselection).toMatchObject({ reason: "unbound" });
      // Normal selection ranks this account first for the session.
      const preferred = bound.connectionId;
      const other = preferred === a ? b : a;
      expect(await bindingOf(first)).toEqual({
        connectionId: preferred,
        choice: "automatic",
        clock: placedAt,
        version: 1,
      });
      // A model request on the bound account advances the clock in the
      // transaction that reserves it.
      expect(await callUpstream(first, preferred, [])).toBeNull();
      const requested = (await bindingOf(first))!.clock!;
      expect(requested).toBeGreaterThan(placedAt);
      // Forced away (switched off for new work): the clock starts again on
      // the new account and the old account's warmth is not carried over.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${preferred}::uuid`;
      const second = await nextTurn(org, first);
      const movedAt = requested + 1_000;
      expect(await placeChecked(second, new Date(movedAt))).toMatchObject({
        kind: "run",
        connectionId: other,
        previousConnectionId: preferred,
        reselection: { reason: "account_ineligible", ineligibility: ["allocator_disabled"] },
      });
      expect(await bindingOf(second)).toMatchObject({ connectionId: other, clock: movedAt });
      // Back on, normal selection would rank it first again, yet the warm
      // session stays, up to and including the adapter's declared lifetime,
      // also for work no person sent (a goal continuation or scheduled run).
      await admin()`update subscription_connections set allocator_enabled = true
        where id = ${preferred}::uuid`;
      const third = await nextTurn(org, second, { initiator: "service" });
      const warmEdge = movedAt + lifetime;
      expect(await placeChecked(third, new Date(warmEdge))).toMatchObject({
        kind: "run",
        connectionId: other,
        switch: "sticky",
        reselection: null,
      });
      expect((await bindingOf(third))!.clock).toBe(warmEdge);
      // One millisecond past the lifetime the cache is predictably cold:
      // normal selection runs again (rotation applies) and moves the session.
      const fourth = await nextTurn(org, third);
      const cold = warmEdge + lifetime + 1;
      expect(await placeChecked(fourth, new Date(cold))).toMatchObject({
        kind: "run",
        connectionId: preferred,
        previousConnectionId: other,
        reselection: { reason: "cache_cold" },
      });
      expect(await bindingOf(fourth)).toMatchObject({ connectionId: preferred, clock: cold });
    });

    test("SUB-STICK-01: another human member sending the warm turn keeps the session's account", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `sender-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `sender-b-${crypto.randomUUID()}`);
      const member = await workspaceMember(org);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const preferred = bound.connectionId;
      const other = preferred === a ? b : a;
      // Bind the session to the account selection does not rank first, so
      // only the session's binding can keep it there.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${preferred}::uuid`;
      const second = await nextTurn(org, first);
      expect(await placeChecked(second)).toMatchObject({ kind: "run", connectionId: other });
      await admin()`update subscription_connections set allocator_enabled = true
        where id = ${preferred}::uuid`;
      // The other member sends the next turn while the cache is warm.
      const third = await nextTurn(org, second, { initiator: { subjectId: member } });
      expect(third.identity).toMatchObject({
        sessionOwnerSubjectId: org.ownerSubjectId,
        initiatingHumanSubjectId: member,
      });
      expect(await placeChecked(third)).toMatchObject({
        kind: "run",
        connectionId: other,
        switch: "sticky",
        previousConnectionId: other,
        reselection: null,
      });
      expect(await stickLeaseOf(third)).toBe(other);
      expect(await bindingOf(third)).toMatchObject({ connectionId: other, choice: "automatic" });
    });

    test("SUB-STICK-03, SUB-STICK-07: a warm account is left only when forced (limited, refused, switched off, disconnected, out of scope)", async () => {
      type Forced = {
        name: string;
        /** Applied while the first turn still runs on the account. */
        during?: (turn: Turn, connectionId: string) => Promise<void>;
        /** Applied between the turns. */
        between?: (org: Org, connectionId: string) => Promise<void>;
        reason: ReselectionReason;
        ineligibility?: Ineligibility[];
      };
      const forced: Forced[] = [
        {
          name: "rate-limited",
          during: async (turn, connectionId) => {
            expect(
              await callUpstream(turn, connectionId, [
                { kind: "rate_limited", retryAfterSeconds: 600 },
              ]),
            ).toMatchObject({ kind: "rate_limited" });
          },
          reason: "account_ineligible",
        },
        {
          name: "refused and quarantined",
          during: async (turn, connectionId) => {
            expect(await callUpstream(turn, connectionId, [{ kind: "forbidden" }])).toEqual({
              kind: "forbidden",
            });
          },
          reason: "account_ineligible",
          ineligibility: ["unhealthy"],
        },
        {
          name: "switched off",
          between: async (_org, connectionId) => {
            await admin()`update subscription_connections set allocator_enabled = false
              where id = ${connectionId}::uuid`;
          },
          reason: "account_ineligible",
          ineligibility: ["allocator_disabled"],
        },
        {
          name: "disconnected",
          between: async (org, connectionId) => {
            const removed = await withSessionRlsActorContext(
              { subjectId: org.ownerSubjectId },
              () =>
                disconnectSubscriptionCoreConnection(db(), provider, {
                  accountId: org.accountId,
                  workspaceId: null,
                  subjectId: org.ownerSubjectId,
                  connectionId,
                }),
            );
            expect(removed.outcome).toBe("removed");
          },
          // A disconnected account stays in the world, ineligible.
          reason: "account_ineligible",
        },
        {
          name: "no longer in the session's scope",
          between: async (org, connectionId) => {
            // An organization administrator narrows it to another workspace.
            const route = {
              accountId: org.accountId,
              workspaceId: null,
              subjectId: org.ownerSubjectId,
              connectionId,
            };
            const current = await getSubscriptionCoreModelConnectionAccess(db(), providerId, route);
            expect(
              await updateSubscriptionCoreModelConnectionAccess(db(), providerId, route, {
                allowedModels: null,
                allowedWorkspaces: [org.otherWorkspaceId],
                allowPersonalWorkspaces: false,
                version: current!.version,
              }),
            ).toMatchObject({ allowedWorkspaces: [org.otherWorkspaceId] });
          },
          reason: "account_unavailable",
        },
      ];
      for (const entry of forced) {
        const org = await organization();
        const a = await sharedConnection(org, `forced-a-${crypto.randomUUID()}`);
        const b = await sharedConnection(org, `forced-b-${crypto.randomUUID()}`);
        const first = await runningTurn(org);
        const bound = await placeChecked(first);
        if (bound.kind !== "run") throw new Error("expected a run");
        const other = bound.connectionId === a ? b : a;
        await entry.during?.(first, bound.connectionId);
        const second = await nextTurn(org, first);
        await entry.between?.(org, bound.connectionId);
        // The cache is warm (the first turn just ran), yet the session moves.
        const moved = await placeChecked(second);
        expect({ name: entry.name, moved }).toMatchObject({
          name: entry.name,
          moved: {
            kind: "run",
            connectionId: other,
            previousConnectionId: bound.connectionId,
            reselection: { reason: entry.reason },
          },
        });
        if (moved.kind !== "run") continue;
        if (entry.ineligibility)
          expect({ name: entry.name, ineligibility: moved.reselection?.ineligibility }).toEqual({
            name: entry.name,
            ineligibility: entry.ineligibility,
          });
        else if (entry.reason === "account_ineligible")
          expect(moved.reselection?.ineligibility.length ?? 0).toBeGreaterThan(0);
        expect(await bindingOf(second)).toMatchObject({ connectionId: other });
        await expectForeignUntouched(org);
      }
    });

    test("SUB-STICK-05: a model change re-runs selection although the cache is warm", async () => {
      const org = await organization();
      await sharedConnection(org, `model-a-${crypto.randomUUID()}`);
      await sharedConnection(org, `model-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      expect(await placeChecked(first)).toMatchObject({ kind: "run" });
      const second = await nextTurn(org, first, { model: m1 });
      const placedAt = Date.now();
      expect(await placeChecked(second, new Date(placedAt))).toMatchObject({
        kind: "run",
        reselection: { reason: "reselection_point", points: ["model_changed"] },
      });
      // The clock starts on the new model at this placement.
      expect((await bindingOf(second))!.clock).toBe(placedAt);
      const [binding] = await admin()<{ model_id: string }[]>`
        select model_id from subscription_session_bindings
        where workspace_id = ${second.identity.workspaceId}::uuid
          and session_id = ${second.identity.sessionId}::uuid`;
      expect(binding!.model_id).toBe(m1.productModelId);
    });

    test("SUB-STICK-05: a compaction after the session's latest request re-runs selection although the cache is warm", async () => {
      const org = await organization();
      await sharedConnection(org, `compact-a-${crypto.randomUUID()}`);
      await sharedConnection(org, `compact-b-${crypto.randomUUID()}`);
      const compacted = async (turn: Turn, at: number) => {
        await admin()`
          insert into session_events (
            account_id, workspace_id, session_id, sequence, type, payload, occurred_at
          ) select ${org.accountId}::uuid, ${turn.identity.workspaceId}::uuid,
            ${turn.identity.sessionId}::uuid, coalesce(max(sequence), 0) + 1,
            'session.context.compacted', '{}'::jsonb, ${new Date(at).toISOString()}::timestamptz
          from session_events where session_id = ${turn.identity.sessionId}::uuid`;
      };
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      // A compaction the session has made requests since is no re-selection
      // point: the cache was rebuilt on this account from the compacted context.
      const clock = (await bindingOf(first))!.clock!;
      await compacted(first, clock - 1_000);
      const second = await nextTurn(org, first);
      const keptAt = clock + 1_000;
      expect(await placeChecked(second, new Date(keptAt))).toMatchObject({
        kind: "run",
        connectionId: bound.connectionId,
        switch: "sticky",
        reselection: null,
      });
      // A compaction after the latest request replaced the cached prefix.
      await compacted(second, keptAt + 1_000);
      const third = await nextTurn(org, second);
      const placedAt = keptAt + 2_000;
      expect(await placeChecked(third, new Date(placedAt))).toMatchObject({
        kind: "run",
        reselection: { reason: "reselection_point", points: ["compaction_completed"] },
      });
      expect((await bindingOf(third))!.clock).toBe(placedAt);
    });

    test("SUB-STICK-04: a completed call advances the cache clock only for a declared idle cut-off", async () => {
      const org = await organization();
      await sharedConnection(org, `completed-${crypto.randomUUID()}`);
      const placedAt = Date.now() - 60_000;
      const turn = await runningTurn(org);
      const bound = await placeChecked(turn, new Date(placedAt));
      if (bound.kind !== "run") throw new Error("expected a run");
      const completedAt = new Date(placedAt + 30_000);
      const touched = await runtime().touchSubscriptionCoreBinding(
        db(),
        turn.identity,
        leaseOf(turn, bound.connectionId),
        completedAt,
      );
      // An exact lifetime is refreshed when a request starts, so the end of a
      // call never extends it; an idle cut-off is measured from the call's end.
      const exact = provider.adapter.cacheFacts.kind === "exact_ttl";
      expect(touched).toBe(!exact);
      expect((await bindingOf(turn))!.clock).toBe(exact ? placedAt : completedAt.getTime());
    });

    test("SUB-STICK-04: an adapter whose declared cache lifetime is unusable fails placement closed", async () => {
      const org = await organization();
      await sharedConnection(org, `lifetime-a-${crypto.randomUUID()}`);
      await sharedConnection(org, `lifetime-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const second = await nextTurn(org, first);
      const before = await bindingOf(second);
      const declared = provider.adapter.cacheFacts;
      // Each would otherwise read as always cold (zero, negative, NaN) or
      // always warm (Infinity) instead of the provider's real lifetime.
      for (const lifetime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const misdeclared: SubscriptionCoreProvider = {
          ...provider,
          adapter: {
            ...provider.adapter,
            cacheFacts:
              declared.kind === "exact_ttl"
                ? { kind: "exact_ttl", ttlMs: lifetime }
                : { kind: "measured_idle_cutoff", cutoffMs: lifetime },
          },
        };
        const outcome = await place(second, { provider: misdeclared }).then(
          (placed) => ({ lifetime, placed: placed.kind }),
          (error: unknown) => ({ lifetime, failed: (error as Error).message }),
        );
        expect(outcome).toEqual({
          lifetime,
          failed: "A provider adapter must declare a positive whole-millisecond cache lifetime",
        });
        // Nothing was leased or bound.
        expect(await stickLeaseOf(second)).toBeNull();
        expect(await bindingOf(second)).toEqual(before);
      }
      // The adapter's real declaration places the same turn.
      expect(await placeChecked(second)).toMatchObject({
        kind: "run",
        connectionId: bound.connectionId,
        switch: "sticky",
      });
    });

    test("SUB-STICK-07: a session shared while warm on its owner's personal account leaves it at once", async () => {
      const org = await organization();
      const personal = await personalConnection(org, `stick-personal-${crypto.randomUUID()}`);
      const organizationAccount = await sharedConnection(
        org,
        `stick-shared-${crypto.randomUUID()}`,
      );
      // Only the owner's personal account can serve the private session at first.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${organizationAccount}::uuid`;
      const first = await runningTurn(org, { visibility: "user_private", personalAuthority: true });
      expect(await placeChecked(first)).toMatchObject({
        kind: "run",
        connectionId: personal,
        personal: true,
      });
      await admin()`update subscription_connections set allocator_enabled = true
        where id = ${organizationAccount}::uuid`;
      // Still private and warm: the session keeps the personal account.
      const second = await nextTurn(org, first, { personalAuthority: true });
      expect(await placeChecked(second)).toMatchObject({
        kind: "run",
        connectionId: personal,
        switch: "sticky",
        reselection: null,
      });
      // Shared while its cache is warm: the personal account is out of scope
      // for the session now, whatever authority the turn carries.
      const share = async () => {
        const [session] = await admin()<{ authority_epoch: number }[]>`
          select authority_epoch::int as authority_epoch from sessions
          where id = ${second.identity.sessionId}::uuid`;
        expect(
          await transitionSessionVisibility(db(), {
            workspaceId: second.identity.workspaceId,
            sessionId: second.identity.sessionId,
            actorSubjectId: org.ownerSubjectId,
            targetVisibility: "workspace_shared",
            expectedAuthorityEpoch: session!.authority_epoch,
            operationKey: `stick-share-${crypto.randomUUID()}`,
          }),
        ).toMatchObject({ visibility: "workspace_shared", changed: true });
      };
      const third = await nextTurn(org, second, { personalAuthority: true, between: share });
      const moved = await placeChecked(third);
      expect(moved).toMatchObject({
        kind: "run",
        connectionId: organizationAccount,
        personal: false,
        previousConnectionId: personal,
      });
      if (moved.kind !== "run") return;
      expect(["account_unavailable", "account_ineligible"]).toContain(
        moved.reselection?.reason ?? "kept",
      );
      expect(await bindingOf(third)).toMatchObject({
        connectionId: organizationAccount,
        choice: "automatic",
      });
    });

    test("SUB-STICK-06: a pin is kept whatever the cache; a pin change restarts the clock and unpinning re-runs selection", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `pin-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `pin-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const preferred = bound.connectionId;
      const other = preferred === a ? b : a;
      expect((await bindingOf(first))!.clock).not.toBeNull();
      // A person pins the other account. A pin writes the account and the
      // choice, never the clock: the database starts the clock cold, so the
      // first account's warmth is not carried to the pinned one.
      // Written as the application role in a pin's context: the choosing
      // human, under the binding guard and the binding row lock.
      const pin = (connectionId: string, choice: "explicit" | "automatic") =>
        withWorkspaceSubjectSessionActivityRls(
          db(),
          first.identity.workspaceId,
          org.ownerSubjectId,
          async (scoped) => {
            const tx = scoped as unknown as Parameters<typeof rawRows>[0];
            await tx.execute(
              sql`select set_config('opengeni.initiating_human_subject_id', ${org.ownerSubjectId}, true)`,
            );
            const [locked] = await rawRows<{ version: number | string }>(
              tx,
              sql`select version from subscription_session_bindings
                where workspace_id = ${first.identity.workspaceId}::uuid
                  and session_id = ${first.identity.sessionId}::uuid for update`,
            );
            const written = await rawRows(
              tx,
              sql`update subscription_session_bindings
                set connection_id = ${connectionId}::uuid, choice = ${choice},
                  last_switch_reason = 'explicit_choice', version = version + 1
                where workspace_id = ${first.identity.workspaceId}::uuid
                  and session_id = ${first.identity.sessionId}::uuid
                  and version = ${Number(locked!.version)}
                returning version`,
            );
            expect(written).toHaveLength(1);
          },
        );
      await pin(other, "explicit");
      expect(await bindingOf(first)).toMatchObject({
        connectionId: other,
        choice: "explicit",
        clock: null,
      });
      // The pin is honoured, cold or not, and is no re-selection.
      const second = await nextTurn(org, first);
      expect(await placeChecked(second)).toMatchObject({
        kind: "run",
        connectionId: other,
        explicit: true,
        reselection: null,
      });
      expect((await bindingOf(second))!.clock).not.toBeNull();
      // Unpinning keeps the account but restarts the clock, so the next turn
      // re-runs normal selection and goes back to the account it ranks first.
      await pin(other, "automatic");
      expect(await bindingOf(second)).toMatchObject({ choice: "automatic", clock: null });
      const third = await nextTurn(org, second);
      expect(await placeChecked(third)).toMatchObject({
        kind: "run",
        connectionId: preferred,
        reselection: { reason: "cache_cold" },
      });
    });

    // A smoke test only: the racers place one turn, so its lease serializes
    // them even without the binding row lock. The two deterministic race
    // tests below are the ones that fail without that protection.
    test("smoke: parallel placements of one turn around its cache lifetime agree on one account", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `parallel-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `parallel-b-${crypto.randomUUID()}`);
      const lifetime = declaredCacheLifetimeMs(provider.adapter.cacheFacts);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const preferred = bound.connectionId;
      const other = preferred === a ? b : a;
      // Bind the session to the account selection does not rank first.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${preferred}::uuid`;
      const second = await nextTurn(org, first);
      const movedAt = Date.now();
      expect(await placeChecked(second, new Date(movedAt))).toMatchObject({
        kind: "run",
        connectionId: other,
      });
      await admin()`update subscription_connections set allocator_enabled = true
        where id = ${preferred}::uuid`;
      // Racing placements of the next turn on both sides of the cache
      // lifetime: a warm one keeps the account, a cold one would move it.
      // Whichever commits first decides; the rest follow it or find the turn
      // leased, so the lease and the binding never name different accounts.
      const third = await nextTurn(org, second);
      const instants = [movedAt + lifetime, movedAt + lifetime + 1];
      const raced = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          place(third, { now: new Date(instants[index % 2]!) }),
        ),
      );
      for (const result of raced) expect(["run", "lease_busy"]).toContain(result.kind);
      const chosen = new Set(
        raced.flatMap((result) => (result.kind === "run" ? [result.connectionId] : [])),
      );
      expect(chosen.size).toBe(1);
      const [connectionId] = [...chosen];
      expect([preferred, other]).toContain(connectionId!);
      const [lease] = await admin()<{ connection_id: string }[]>`
        select connection_id::text as connection_id from subscription_leases
        where workspace_id = ${third.identity.workspaceId}::uuid
          and turn_id = ${third.identity.turnId}::uuid`;
      expect(lease?.connection_id).toBe(connectionId!);
      expect((await bindingOf(third))!.connectionId).toBe(connectionId!);
      // And the session's next placement agrees with both.
      expect(await place(third)).toMatchObject({ kind: "run", connectionId, reusedLease: true });
    });

    /** Whether some backend is waiting on a lock the given backend holds (polls up to 5s). */
    async function stickBlockedBy(pid: number): Promise<boolean> {
      for (let index = 0; index < 200; index += 1) {
        const [row] = await admin()<{ blocked: number }[]>`
          select count(*)::int as blocked from pg_stat_activity
          where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`;
        if (row!.blocked > 0) return true;
        await Bun.sleep(25);
      }
      return false;
    }

    /**
     * A person's pin as the application role, in the real route's lock order
     * (session row, binding row, then the account's lock through the binding
     * trigger), paused after the binding row lock until `proceed` resolves.
     */
    function stickPausedPin(
      org: Org,
      turn: Turn,
      connectionId: string,
      choice: "explicit" | "automatic",
    ) {
      let proceed!: () => void;
      const mayProceed = new Promise<void>((resolve) => (proceed = resolve));
      let markLocked!: (pid: number) => void;
      const locked = new Promise<number>((resolve) => (markLocked = resolve));
      const done = withWorkspaceSubjectSessionActivityRls(
        db(),
        turn.identity.workspaceId,
        org.ownerSubjectId,
        async (scoped) => {
          const tx = scoped as unknown as Parameters<typeof rawRows>[0];
          await tx.execute(
            sql`select set_config('opengeni.initiating_human_subject_id', ${org.ownerSubjectId}, true)`,
          );
          const [me] = await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`);
          await rawRows(
            tx,
            sql`select id from sessions where workspace_id = ${turn.identity.workspaceId}::uuid
              and id = ${turn.identity.sessionId}::uuid for no key update`,
          );
          const [row] = await rawRows<{ version: number | string }>(
            tx,
            sql`select version from subscription_session_bindings
              where workspace_id = ${turn.identity.workspaceId}::uuid
                and session_id = ${turn.identity.sessionId}::uuid for update`,
          );
          markLocked(me!.pid);
          await mayProceed;
          const written = await rawRows(
            tx,
            sql`update subscription_session_bindings
              set connection_id = ${connectionId}::uuid, choice = ${choice},
                last_switch_reason = 'explicit_choice', version = version + 1
              where workspace_id = ${turn.identity.workspaceId}::uuid
                and session_id = ${turn.identity.sessionId}::uuid
                and version = ${Number(row!.version)}
              returning version`,
          );
          return written.length;
        },
      ).then(
        (rows) => `pin committed (${rows})`,
        (error: unknown) => `pin failed ${postgresCode(error)}`,
      );
      return { locked, proceed, done };
    }

    async function stickLeaseOf(turn: Turn): Promise<string | null> {
      const [lease] = await admin()<{ connection_id: string }[]>`
        select connection_id::text as connection_id from subscription_leases
        where workspace_id = ${turn.identity.workspaceId}::uuid
          and turn_id = ${turn.identity.turnId}::uuid`;
      return lease?.connection_id ?? null;
    }

    test("SUB-STICK-06: a pin of the bound account never deadlocks with a model request or the next placement on it", async () => {
      const org = await organization();
      await sharedConnection(org, `pin-order-a-${crypto.randomUUID()}`);
      await sharedConnection(org, `pin-order-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const account = bound.connectionId;
      // A person pins the account the session is on while its turn reserves a
      // model request on it: both lock the binding before the account.
      const pin = stickPausedPin(org, first, account, "explicit");
      const pinPid = await pin.locked;
      const reservation = subscriptionCoreRequests(provider)
        .reserveSubscriptionCoreRequest(db(), first.identity, leaseOf(first, account), {
          requestId: crypto.randomUUID(),
          transportAttempt: 1,
          attemptId: first.attemptId,
          executionGeneration: first.executionGeneration,
        })
        .then(
          () => "reservation committed",
          (error: unknown) => `reservation failed ${postgresCode(error)}`,
        );
      expect(await stickBlockedBy(pinPid)).toBe(true);
      pin.proceed();
      expect(await Promise.all([pin.done, reservation])).toEqual([
        "pin committed (1)",
        "reservation committed",
      ]);
      // Unpinned again while the next turn is being placed on the same account.
      const second = await nextTurn(org, first);
      const unpin = stickPausedPin(org, second, account, "automatic");
      const unpinPid = await unpin.locked;
      const placement = place(second).then(
        (placed) => placed,
        (error: unknown) => `placement failed ${postgresCode(error)}`,
      );
      expect(await stickBlockedBy(unpinPid)).toBe(true);
      unpin.proceed();
      const [unpinned, placed] = await Promise.all([unpin.done, placement]);
      expect(unpinned).toBe("pin committed (1)");
      // The placement waited for the unpin and decided from it: the clock
      // was cleared, so normal selection ran again.
      expect(placed).toMatchObject({ kind: "run", explicit: false });
      if (typeof placed === "string" || placed.kind !== "run") return;
      expect(placed.reselection).toMatchObject({ reason: "cache_cold" });
      expect(await stickLeaseOf(second)).toBe(placed.connectionId);
      expect(await bindingOf(second)).toMatchObject({
        connectionId: placed.connectionId,
        choice: "automatic",
      });
    });

    test("SUB-STICK-02: a placement that waits for a concurrent pin decides from the pin", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `pin-race-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `pin-race-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const other = bound.connectionId === a ? b : a;
      const second = await nextTurn(org, first);
      // The pin holds the binding when the warm placement starts; the
      // placement waits instead of keeping the old account from a stale read.
      const pin = stickPausedPin(org, second, other, "explicit");
      const pinPid = await pin.locked;
      const placement = place(second);
      expect(await stickBlockedBy(pinPid)).toBe(true);
      pin.proceed();
      expect(await pin.done).toBe("pin committed (1)");
      expect(await placement).toMatchObject({ kind: "run", connectionId: other, explicit: true });
      expect(await stickLeaseOf(second)).toBe(other);
      expect(await bindingOf(second)).toMatchObject({ connectionId: other, choice: "explicit" });
    });

    test("SUB-STICK-02: a placement that waits for a concurrent use of the account sees the warm clock", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `use-race-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `use-race-b-${crypto.randomUUID()}`);
      const lifetime = declaredCacheLifetimeMs(provider.adapter.cacheFacts);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const preferred = bound.connectionId;
      const other = preferred === a ? b : a;
      // Bind the session to the account selection does not rank first.
      await admin()`update subscription_connections set allocator_enabled = false
        where id = ${preferred}::uuid`;
      const second = await nextTurn(org, first);
      const movedAt = Date.now();
      expect(await placeChecked(second, new Date(movedAt))).toMatchObject({
        kind: "run",
        connectionId: other,
      });
      await admin()`update subscription_connections set allocator_enabled = true
        where id = ${preferred}::uuid`;
      const third = await nextTurn(org, second);
      // A use of the bound account (as a request's clock advance) holds the
      // binding when a placement starts that would find the cache cold.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let markHeld!: (pid: number) => void;
      const held = new Promise<number>((resolve) => (markHeld = resolve));
      const use = admin().begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        await tx`update subscription_session_bindings
          set last_model_call_at = ${new Date(movedAt + lifetime)}
          where workspace_id = ${third.identity.workspaceId}::uuid
            and session_id = ${third.identity.sessionId}::uuid`;
        markHeld(me!.pid);
        await released;
      });
      const holder = await held;
      const placement = place(third, { now: new Date(movedAt + lifetime + 1) });
      expect(await stickBlockedBy(holder)).toBe(true);
      release();
      await use;
      expect(await placement).toMatchObject({
        kind: "run",
        connectionId: other,
        switch: "sticky",
        reselection: null,
      });
      expect(await stickLeaseOf(third)).toBe(other);
      expect(await bindingOf(third)).toMatchObject({ connectionId: other });
    });

    test("SUB-STICK-05: removing a pin while a turn runs re-runs selection at the next turn, whatever the running turn still uses", async () => {
      const org = await organization();
      await sharedConnection(org, `unpin-mid-a-${crypto.randomUUID()}`);
      await sharedConnection(org, `unpin-mid-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const account = bound.connectionId;
      // A person pins the account and removes the pin while the turn runs.
      for (const choice of ["explicit", "automatic"] as const) {
        const pin = stickPausedPin(org, first, account, choice);
        await pin.locked;
        pin.proceed();
        expect(await pin.done).toBe("pin committed (1)");
      }
      expect(await bindingOf(first)).toMatchObject({ choice: "automatic", clock: null });
      // The running turn keeps requesting on the account and completes a
      // call: neither restarts the cleared clock.
      expect(await callUpstream(first, account, [])).toBeNull();
      await runtime().touchSubscriptionCoreBinding(
        db(),
        first.identity,
        leaseOf(first, account),
        new Date(),
      );
      expect((await bindingOf(first))!.clock).toBeNull();
      // A retry of the same attempt keeps its lease and makes no new selection.
      expect(await place(first)).toMatchObject({
        kind: "run",
        connectionId: account,
        reusedLease: true,
      });
      expect((await bindingOf(first))!.clock).toBeNull();
      const second = await nextTurn(org, first);
      const placedAt = Date.now();
      expect(await placeChecked(second, new Date(placedAt))).toMatchObject({
        kind: "run",
        explicit: false,
        reselection: { reason: "cache_cold" },
      });
      expect((await bindingOf(second))!.clock).toBe(placedAt);
    });

    test("SUB-STICK-05: a retried attempt whose binding moved to another account mid-turn rebinds to its kept lease cold, so the next turn re-selects", async () => {
      const org = await organization();
      const a = await sharedConnection(org, `retry-moved-a-${crypto.randomUUID()}`);
      const b = await sharedConnection(org, `retry-moved-b-${crypto.randomUUID()}`);
      const first = await runningTurn(org);
      const bound = await placeChecked(first);
      if (bound.kind !== "run") throw new Error("expected a run");
      const leased = bound.connectionId;
      const other = leased === a ? b : a;
      // While the turn runs on its lease, a person pins the other account and
      // then removes the pin: the binding names the other account, cold.
      for (const choice of ["explicit", "automatic"] as const) {
        const pin = stickPausedPin(org, first, other, choice);
        await pin.locked;
        pin.proceed();
        expect(await pin.done).toBe("pin committed (1)");
      }
      expect(await bindingOf(first)).toMatchObject({
        connectionId: other,
        choice: "automatic",
        clock: null,
      });
      // A retry of the same attempt keeps its lease and makes no new
      // selection: the binding follows the lease's account with no clock.
      expect(await place(first)).toMatchObject({
        kind: "run",
        connectionId: leased,
        reusedLease: true,
        previousConnectionId: other,
      });
      expect(await stickLeaseOf(first)).toBe(leased);
      expect(await bindingOf(first)).toMatchObject({
        connectionId: leased,
        choice: "automatic",
        clock: null,
      });
      // So the next turn runs normal selection instead of keeping it as warm.
      const second = await nextTurn(org, first);
      const placedAt = Date.now();
      expect(await placeChecked(second, new Date(placedAt))).toMatchObject({
        kind: "run",
        explicit: false,
        reselection: { reason: "cache_cold" },
      });
      expect((await bindingOf(second))!.clock).toBe(placedAt);
    });

    test("SUB-STICK-05, SUB-STICK-06: a personal account pinned and unpinned mid-turn is not kept without personal fallback", async () => {
      const org = await organization();
      const organizationAccount = await sharedConnection(
        org,
        `unpin-personal-shared-${crypto.randomUUID()}`,
      );
      const personal = await personalConnection(org, `unpin-personal-${crypto.randomUUID()}`);
      // The owner has not opted in to personal fallback.
      await admin()`update subscription_person_preferences set personal_fallback_opt_in = false
        where account_id = ${org.accountId}::uuid
          and organization_membership_id = ${org.ownerMembershipId}::uuid`;
      const first = await runningTurn(org, { visibility: "user_private", personalAuthority: true });
      expect(await placeChecked(first)).toMatchObject({
        kind: "run",
        connectionId: organizationAccount,
      });
      // The owner pins their personal account; the next turn runs on it.
      const pin = stickPausedPin(org, first, personal, "explicit");
      await pin.locked;
      pin.proceed();
      expect(await pin.done).toBe("pin committed (1)");
      const second = await nextTurn(org, first, { personalAuthority: true });
      expect(await placeChecked(second)).toMatchObject({
        kind: "run",
        connectionId: personal,
        explicit: true,
      });
      // The pin is removed while that turn runs, which keeps requesting on it.
      const unpin = stickPausedPin(org, second, personal, "automatic");
      await unpin.locked;
      unpin.proceed();
      expect(await unpin.done).toBe("pin committed (1)");
      expect(await callUpstream(second, personal, [])).toBeNull();
      await runtime().touchSubscriptionCoreBinding(
        db(),
        second.identity,
        leaseOf(second, personal),
        new Date(),
      );
      expect(await place(second)).toMatchObject({ kind: "run", reusedLease: true });
      expect(await bindingOf(second)).toMatchObject({ choice: "automatic", clock: null });
      // Without the pin and without fallback consent, the next turn leaves it.
      const third = await nextTurn(org, second, { personalAuthority: true });
      expect(await placeChecked(third)).toMatchObject({
        kind: "run",
        connectionId: organizationAccount,
        personal: false,
        reselection: { reason: "cache_cold" },
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

    /** A core waiter armed for a running turn, as the worker persists it. */
    async function armedWaiter(
      org: Org,
      turn: Turn,
      input: { workspaceId?: string; waiterId?: string } = {},
    ): Promise<string> {
      const tenant = {
        accountId: org.accountId,
        workspaceId: input.workspaceId ?? org.sharedWorkspaceId,
      };
      const waiter = await withRlsContext(db(), tenant, (tx) =>
        upsertSubscriptionCapacityWaiter(tx, {
          ...tenant,
          sessionId: turn.identity.sessionId,
          turnId: turn.identity.turnId,
          waiterId: input.waiterId ?? crypto.randomUUID(),
          provider: providerId,
          waitReason: "capacity",
          generation: 1,
          wakeRevision: 1,
          observedWakeRevision: 1,
          blockedTurnGeneration: turn.executionGeneration,
        }),
      );
      if (!waiter) throw new Error("Fixture failed to arm a waiter");
      return waiter.waiterId;
    }

    /** The provider's bulk capacity wake with the production session wake producer. */
    const wakePool = (org: Org, reason: string, sessionIds?: readonly string[]) =>
      wakeSubscriptionCoreCapacityWaiters(
        db(),
        providerId,
        {
          accountId: org.accountId,
          reason,
          ...(sessionIds
            ? { workspaceIds: [org.sharedWorkspaceId], sessionIds }
            : { workspaceIds: [org.sharedWorkspaceId] }),
        },
        enqueueSessionWorkflowWakeInTransaction,
      );

    const waiterRevision = async (waiterId: string) => {
      const [row] = await admin()<{ wake_revision: string }[]>`
        select wake_revision::text from subscription_capacity_waiters
        where waiter_id = ${waiterId}::uuid`;
      return Number(row!.wake_revision);
    };

    /**
     * Waits until some backend is blocked on a lock the holder's backend
     * holds. Fails with the wake's own outcome if it settles first.
     */
    async function waitUntilBlockedBy(holder: Sql, wake: Promise<unknown>): Promise<void> {
      const settled: { outcome: string | null } = { outcome: null };
      wake.then(
        () => {
          settled.outcome = "it returned";
        },
        (error: unknown) => {
          settled.outcome = `it failed: ${error instanceof Error ? error.message : String(error)}`;
        },
      );
      const [self] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [row] = await admin()<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where datname = current_database() and ${self!.pid}::int = any(pg_blocking_pids(pid))`;
        if (row!.count > 0) return;
        if (settled.outcome !== null)
          throw new Error(
            `The wake settled before it waited on the holder's lock: ${settled.outcome}`,
          );
        await Bun.sleep(25);
      }
      throw new Error("No backend started waiting on the holder's lock");
    }

    /** Whether another transaction could lock the session row right now. */
    async function sessionLockable(sessionId: string): Promise<boolean> {
      const probe = await admin().reserve();
      try {
        await probe`begin`;
        await probe`select id from sessions where id = ${sessionId}::uuid for no key update nowait`;
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") return false;
        throw error;
      } finally {
        await probe`rollback`.catch(() => undefined);
        probe.release();
      }
    }

    /** Whether another transaction could lock the workspace row FOR UPDATE right now. */
    async function workspaceLockable(workspaceId: string): Promise<boolean> {
      const probe = await admin().reserve();
      try {
        await probe`begin`;
        await probe`select id from workspaces where id = ${workspaceId}::uuid for update nowait`;
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") return false;
        throw error;
      } finally {
        await probe`rollback`.catch(() => undefined);
        probe.release();
      }
    }

    /** Whether another transaction could lock the session row in this mode right now. */
    async function sessionLockableAs(
      sessionId: string,
      mode: "for key share" | "for share",
    ): Promise<boolean> {
      const probe = await admin().reserve();
      try {
        await probe`begin`;
        if (mode === "for key share")
          await probe`select id from sessions where id = ${sessionId}::uuid for key share nowait`;
        else await probe`select id from sessions where id = ${sessionId}::uuid for share nowait`;
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") return false;
        throw error;
      } finally {
        await probe`rollback`.catch(() => undefined);
        probe.release();
      }
    }

    test("a capacity wake locks the workspace before its sessions, like a runnable wake or a context clear", async () => {
      const org = await organization();
      const turn = await runningTurn(org);
      const waiterId = await armedWaiter(org, turn);
      const sessionId = turn.identity.sessionId;
      // A runnable wake and a context clear hold the workspace FOR UPDATE,
      // then lock the session. A wake that held the session while waiting for
      // its workspace (an outbox foreign key) would deadlock with them.
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from workspaces where id = ${org.sharedWorkspaceId}::uuid for update`;
        wake = wakePool(org, "fixture_workspace_order");
        await waitUntilBlockedBy(holder, wake);
        const locked = await holder<{ id: string }[]>`
          select id::text as id from sessions where id = ${sessionId}::uuid for no key update nowait`;
        expect(locked.map((row) => row.id)).toEqual([sessionId]);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(waiterId)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("a capacity wake takes the tenancy fence before the workspace row, like a visibility change or a fork", async () => {
      const org = await organization();
      const turn = await runningTurn(org);
      const waiterId = await armedWaiter(org, turn);
      // A visibility change and a session fork take the tenancy fence
      // exclusively, then lock the workspace FOR UPDATE. A wake that held the
      // workspace while waiting for the fence would deadlock with them.
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${org.sharedWorkspaceId}`}, 0))`;
        wake = wakePool(org, "fixture_tenancy_order");
        await waitUntilBlockedBy(holder, wake);
        const locked = await holder<{ id: string }[]>`
          select id::text as id from workspaces where id = ${org.sharedWorkspaceId}::uuid
          for update nowait`;
        expect(locked.map((row) => row.id)).toEqual([org.sharedWorkspaceId]);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(waiterId)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("a capacity wake locks each session before its waiter, like Steer, Cancel and a resume", async () => {
      const org = await organization();
      const turn = await runningTurn(org);
      const waiterId = await armedWaiter(org, turn);
      const sessionId = turn.identity.sessionId;
      // Steer and Cancel hold the session, then delete its waiter. A wake that
      // held the waiter while waiting for the session would deadlock with them.
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${sessionId}::uuid for update`;
        wake = wakePool(org, "fixture_lock_order");
        await waitUntilBlockedBy(holder, wake);
        const locked = await holder<{ waiter_id: string }[]>`
          select waiter_id::text as waiter_id from subscription_capacity_waiters
          where workspace_id = ${org.sharedWorkspaceId}::uuid and session_id = ${sessionId}::uuid
          for update nowait`;
        expect(locked.map((row) => row.waiter_id)).toEqual([waiterId]);
        // The wake holds the workspace only as a key share, the weakest lock
        // that excludes its FOR UPDATE lockers: anything stronger (FOR SHARE,
        // FOR NO KEY UPDATE, FOR UPDATE) conflicts with this probe and would
        // hold off workspace updates, authority checks and other wakes.
        const workspace = await holder<{ id: string }[]>`
          select id::text as id from workspaces where id = ${org.sharedWorkspaceId}::uuid
          for no key update nowait`;
        expect(workspace.map((row) => row.id)).toEqual([org.sharedWorkspaceId]);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(waiterId)).toBe(2);
      const [typed] = await admin()<{ count: number }[]>`
        select count(*)::int as count from subscription_capacity_wake_outbox
        where waiter_id = ${waiterId}::uuid and wake_revision = 2`;
      expect(typed!.count).toBe(1);
      const [generic] = await admin()<{ reason: string }[]>`
        select reason from session_workflow_wake_outbox where session_id = ${sessionId}::uuid`;
      expect(generic?.reason).toBe("subscription_capacity");
      await expectForeignUntouched(org);
    });

    test("a capacity wake locks sessions in ascending order and bumps only the sessions it names", async () => {
      const org = await organization();
      const turns: Turn[] = [];
      for (let index = 0; index < 5; index += 1) turns.push(await runningTurn(org));
      const waiterBySession = new Map<string, string>();
      for (const turn of turns)
        waiterBySession.set(turn.identity.sessionId, await armedWaiter(org, turn));
      // Four named sessions in ascending order; the fifth is not named.
      const [unnamed, ...rest] = turns.map((turn) => turn.identity.sessionId);
      const named = rest.sort();
      const [first, second, third, fourth] = named as [string, string, string, string];
      // Multi-session lockers (lockSessionEventWriteRows, a subtree Cancel)
      // lock sessions in ascending order. Holding the third session, an
      // ascending wake holds the first two and waits on the third, leaving
      // the fourth free; any other order holds the fourth or leaves the
      // first free.
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${third}::uuid for update`;
        // Name them out of order: the wake must sort them itself.
        wake = wakePool(org, "fixture_session_order", [fourth, second, third, first]);
        await waitUntilBlockedBy(holder, wake);
        expect({
          first: await sessionLockable(first),
          second: await sessionLockable(second),
          fourth: await sessionLockable(fourth),
        }).toEqual({ first: false, second: false, fourth: true });
        // The sessions it holds are locked FOR NO KEY UPDATE, the generic
        // wake's archive guard's mode: key shares (foreign keys) still pass,
        // shares do not.
        expect({
          keyShare: await sessionLockableAs(first, "for key share"),
          share: await sessionLockableAs(first, "for share"),
        }).toEqual({ keyShare: true, share: false });
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      for (const sessionId of named)
        expect(await waiterRevision(waiterBySession.get(sessionId)!)).toBe(2);
      expect(await waiterRevision(waiterBySession.get(unnamed!)!)).toBe(1);
      const [unnamedWake] = await admin()<{ count: number }[]>`
        select count(*)::int as count from session_workflow_wake_outbox
        where session_id = ${unnamed!}::uuid and reason = 'subscription_capacity'`;
      expect(unnamedWake!.count).toBe(0);
      await expectForeignUntouched(org);
    });

    test("a pool-wide capacity wake locks sessions in ascending order whatever the waiters' storage order", async () => {
      const org = await organization();
      const turns: Turn[] = [];
      for (let index = 0; index < 4; index += 1) turns.push(await runningTurn(org));
      const sessions = turns.map((turn) => turn.identity.sessionId).sort();
      const [first, second, third, fourth] = sessions as [string, string, string, string];
      // Arm the waiters in descending session order, with waiter ids that
      // ascend as the sessions descend, so both the table's insertion order
      // and its waiter-id order are the reverse of session order. Only the
      // wake's own session ordering can then take the first session first.
      const waiterIds = Array.from({ length: 4 }, () => crypto.randomUUID()).sort();
      const descending = [...sessions].reverse();
      const waiterBySession = new Map<string, string>();
      for (const [index, sessionId] of descending.entries()) {
        const turn = turns.find((candidate) => candidate.identity.sessionId === sessionId)!;
        waiterBySession.set(
          sessionId,
          await armedWaiter(org, turn, { waiterId: waiterIds[index]! }),
        );
      }
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${third}::uuid for update`;
        wake = wakePool(org, "fixture_pool_session_order");
        await waitUntilBlockedBy(holder, wake);
        expect({
          first: await sessionLockable(first),
          second: await sessionLockable(second),
          fourth: await sessionLockable(fourth),
        }).toEqual({ first: false, second: false, fourth: true });
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      for (const sessionId of sessions)
        expect(await waiterRevision(waiterBySession.get(sessionId)!)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("a capacity wake visits the workspaces it names once each, in ascending order", async () => {
      const org = await organization();
      const [lower, higher] = [org.sharedWorkspaceId, org.otherWorkspaceId].sort() as [
        string,
        string,
      ];
      const lowerTurn = await runningTurn(org, { workspaceId: lower });
      const higherTurn = await runningTurn(org, { workspaceId: higher });
      const lowerWaiter = await armedWaiter(org, lowerTurn, { workspaceId: lower });
      const higherWaiter = await armedWaiter(org, higherTurn, { workspaceId: higher });
      // Concurrent wakes share the tenancy lock, so two wakes given the same
      // workspaces in opposite orders would deadlock unless the wake sorts
      // them. Holding the lower workspace's session, a sorted wake waits on it
      // before it touches the higher workspace.
      const holder = await admin().reserve();
      let wake: Promise<unknown> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${lowerTurn.identity.sessionId}::uuid for update`;
        wake = wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          {
            accountId: org.accountId,
            reason: "fixture_workspace_list_order",
            workspaceIds: [higher, lower, higher],
          },
          enqueueSessionWorkflowWakeInTransaction,
        );
        await waitUntilBlockedBy(holder, wake);
        expect(await sessionLockable(higherTurn.identity.sessionId)).toBe(true);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: lower },
        { accountId: org.accountId, workspaceId: higher },
      ]);
      // Named twice, the higher workspace is still woken once.
      expect(await waiterRevision(lowerWaiter)).toBe(2);
      expect(await waiterRevision(higherWaiter)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("an organization-wide capacity wake visits its workspaces in ascending order", async () => {
      const org = await organization();
      // Two more workspaces, the higher id created first: the organization's
      // workspace inventory has no order of its own, so only the wake's
      // ordering visits the lower one first.
      const [lowerId, higherId] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [
        string,
        string,
      ];
      const higher = await sharedWorkspace(org.accountId, org.ownerSubjectId, "Higher", higherId);
      const lower = await sharedWorkspace(org.accountId, org.ownerSubjectId, "Lower", lowerId);
      const lowerTurn = await runningTurn(org, { workspaceId: lower });
      const higherTurn = await runningTurn(org, { workspaceId: higher });
      const lowerWaiter = await armedWaiter(org, lowerTurn, { workspaceId: lower });
      const higherWaiter = await armedWaiter(org, higherTurn, { workspaceId: higher });
      const holder = await admin().reserve();
      let wake: Promise<unknown> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${lowerTurn.identity.sessionId}::uuid for update`;
        wake = wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          { accountId: org.accountId, reason: "fixture_organization_order" },
          enqueueSessionWorkflowWakeInTransaction,
        );
        await waitUntilBlockedBy(holder, wake);
        expect(await sessionLockable(higherTurn.identity.sessionId)).toBe(true);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: lower },
        { accountId: org.accountId, workspaceId: higher },
      ]);
      expect(await waiterRevision(lowerWaiter)).toBe(2);
      expect(await waiterRevision(higherWaiter)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("an organization-wide capacity wake locks only the workspaces where it wakes a waiter", async () => {
      const org = await organization();
      const [lowerId, higherId] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [
        string,
        string,
      ];
      const lower = await sharedWorkspace(org.accountId, org.ownerSubjectId, "Lower", lowerId);
      const higher = await sharedWorkspace(org.accountId, org.ownerSubjectId, "Higher", higherId);
      // A waiter only in the higher workspace: the wake visits the lower one
      // first and finds nothing to wake there.
      const turn = await runningTurn(org, { workspaceId: higher });
      const waiterId = await armedWaiter(org, turn, { workspaceId: higher });
      const others = [org.personalWorkspaceId, org.sharedWorkspaceId, org.otherWorkspaceId, lower];
      const holder = await admin().reserve();
      let wake: Promise<unknown> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${turn.identity.sessionId}::uuid for update`;
        wake = wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          { accountId: org.accountId, reason: "fixture_workspace_footprint" },
          enqueueSessionWorkflowWakeInTransaction,
        );
        await waitUntilBlockedBy(holder, wake);
        // A runnable wake or a context clear in a workspace without waiters
        // locks it FOR UPDATE; the blocked wake must not hold it off.
        const lockable: Record<string, boolean> = {};
        for (const workspaceId of others)
          lockable[workspaceId] = await workspaceLockable(workspaceId);
        expect(lockable).toEqual(Object.fromEntries(others.map((id) => [id, true])));
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([{ accountId: org.accountId, workspaceId: higher }]);
      expect(await waiterRevision(waiterId)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("concurrent wakes of one pool all succeed and bump each waiter once per wake", async () => {
      const org = await organization();
      const sessions: string[] = [];
      const waiters: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const turn = await runningTurn(org);
        sessions.push(turn.identity.sessionId);
        waiters.push(await armedWaiter(org, turn));
      }
      // Pool-wide wakes and session-scoped wakes naming the sessions in
      // reverse overlap on every waiter, in different statement shapes.
      const reversed = [...sessions].reverse();
      const rounds = 6;
      const perRound = 6;
      for (let round = 0; round < rounds; round += 1)
        await Promise.all(
          Array.from({ length: perRound }, (_, index) =>
            index % 2 === 0
              ? wakePool(org, "fixture_concurrent_wake")
              : wakePool(org, "fixture_concurrent_wake", reversed),
          ),
        );
      for (const waiterId of waiters) {
        expect(await waiterRevision(waiterId)).toBe(1 + rounds * perRound);
        const [typed] = await admin()<{ count: number }[]>`
          select count(*)::int as count from subscription_capacity_wake_outbox
          where waiter_id = ${waiterId}::uuid`;
        expect(typed!.count).toBe(rounds * perRound);
      }
      await expectForeignUntouched(org);
    });

    test("a session deleted while a capacity wake waits drops out; the wake still wakes the rest", async () => {
      const org = await organization();
      const turns = [await runningTurn(org), await runningTurn(org)];
      const waiterBySession = new Map<string, string>();
      for (const turn of turns)
        waiterBySession.set(turn.identity.sessionId, await armedWaiter(org, turn));
      const [lower, higher] = turns.map((turn) => turn.identity.sessionId).sort() as [
        string,
        string,
      ];
      // The wake reads both waiters, then waits on the lower session. Cancel
      // then a quiescent delete removes the higher session meanwhile; the wake
      // must skip it rather than fail (and roll back) the whole wake.
      const holder = await admin().reserve();
      let wake: ReturnType<typeof wakePool> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select id from sessions where id = ${lower}::uuid for update`;
        wake = wakePool(org, "fixture_deleted_session");
        await waitUntilBlockedBy(holder, wake);
        // Bounded: a wake that locked the higher session out of order would
        // block this delete on a wait PostgreSQL cannot see as a deadlock.
        await admin().begin(async (tx) => {
          await tx`set local lock_timeout = '5s'`;
          await tx`delete from sessions where id = ${higher}::uuid`;
        });
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(waiterBySession.get(lower)!)).toBe(2);
      const [generic] = await admin()<{ count: number }[]>`
        select count(*)::int as count from session_workflow_wake_outbox
        where session_id = ${higher}::uuid`;
      expect(generic!.count).toBe(0);
      await expectForeignUntouched(org);
    });

    test("a capacity wake skips an archived session and still wakes the rest", async () => {
      const org = await organization();
      const archivedTurn = await runningTurn(org);
      const liveTurn = await runningTurn(org);
      const archivedWaiter = await armedWaiter(org, archivedTurn);
      const liveWaiter = await armedWaiter(org, liveTurn);
      // The generic wake's archive guard refuses an archiving session's wake;
      // the capacity wake must leave it out instead of failing for everyone.
      await admin()`update sessions
        set content_archive_state = 'archiving', content_archive_started_at = now(),
          content_archive = '{"format":"fixture","version":1,"objectKeys":[]}'::jsonb
        where id = ${archivedTurn.identity.sessionId}::uuid`;
      expect(await wakePool(org, "fixture_archived_session")).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(liveWaiter)).toBe(2);
      expect(await waiterRevision(archivedWaiter)).toBe(1);
      const [generic] = await admin()<{ count: number }[]>`
        select count(*)::int as count from session_workflow_wake_outbox
        where session_id = ${archivedTurn.identity.sessionId}::uuid`;
      expect(generic!.count).toBe(0);
      await expectForeignUntouched(org);
    });

    test("a capacity wake skips a workspace whose only waiting session is archived", async () => {
      const org = await organization();
      const [lower, higher] = [org.sharedWorkspaceId, org.otherWorkspaceId].sort() as [
        string,
        string,
      ];
      const archivedTurn = await runningTurn(org, { workspaceId: lower });
      const liveTurn = await runningTurn(org, { workspaceId: higher });
      const archivedWaiter = await armedWaiter(org, archivedTurn, { workspaceId: lower });
      const liveWaiter = await armedWaiter(org, liveTurn, { workspaceId: higher });
      // Archiving keeps turns, so a stale waiter can outlive its session's
      // archive. Nothing in the lower workspace is left to wake; the wake
      // must move on to the higher one rather than fail.
      await admin()`update sessions
        set content_archive_state = 'archived', content_archive_started_at = now(),
          content_archived_at = now(),
          content_archive = '{"format":"fixture","version":1,"objectKeys":[],"sha256":"fixture"}'::jsonb
        where id = ${archivedTurn.identity.sessionId}::uuid`;
      expect(
        await wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          {
            accountId: org.accountId,
            reason: "fixture_archived_workspace",
            workspaceIds: [higher, lower],
          },
          enqueueSessionWorkflowWakeInTransaction,
        ),
      ).toEqual([{ accountId: org.accountId, workspaceId: higher }]);
      expect(await waiterRevision(archivedWaiter)).toBe(1);
      expect(await waiterRevision(liveWaiter)).toBe(2);
      await expectForeignUntouched(org);
    });

    test("a workspace deleted while a capacity wake waits on it is skipped", async () => {
      const org = await organization();
      const doomed = await sharedWorkspace(
        org.accountId,
        org.ownerSubjectId,
        "Doomed",
        crypto.randomUUID(),
      );
      const turn = await runningTurn(org, { workspaceId: doomed });
      await armedWaiter(org, turn, { workspaceId: doomed });
      // The wake reads the waiter, then waits on the workspace row that an
      // uncommitted delete holds; once the delete commits it has nothing to
      // wake there.
      const holder = await admin().reserve();
      let wake: Promise<unknown> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`delete from workspaces where id = ${doomed}::uuid`;
        wake = wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          { accountId: org.accountId, reason: "fixture_deleted_workspace", workspaceIds: [doomed] },
          enqueueSessionWorkflowWakeInTransaction,
        );
        await waitUntilBlockedBy(holder, wake);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([]);
      await expectForeignUntouched(org);
    });

    test("a capacity wake given an uppercase workspace id uses its canonical form", async () => {
      const org = await organization();
      const turn = await runningTurn(org);
      const waiterId = await armedWaiter(org, turn);
      // Workspace scope and the tenancy fence key are the lowercase uuid text.
      // An uppercase id alone must still take the canonical fence and wake.
      const holder = await admin().reserve();
      let wake: Promise<unknown> | null = null;
      let failed = false;
      try {
        await holder`begin`;
        await holder`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${org.sharedWorkspaceId}`}, 0))`;
        wake = wakeSubscriptionCoreCapacityWaiters(
          db(),
          providerId,
          {
            accountId: org.accountId,
            reason: "fixture_uppercase_workspace",
            workspaceIds: [org.sharedWorkspaceId.toUpperCase()],
          },
          enqueueSessionWorkflowWakeInTransaction,
        );
        await waitUntilBlockedBy(holder, wake);
        await holder`commit`;
      } catch (error) {
        failed = true;
        await holder`rollback`.catch(() => undefined);
        throw error;
      } finally {
        holder.release();
        if (failed) await wake?.catch(() => undefined);
      }
      expect(await wake).toEqual([
        { accountId: org.accountId, workspaceId: org.sharedWorkspaceId },
      ]);
      expect(await waiterRevision(waiterId)).toBe(2);
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
      // The subject's stated completeness, asserted before it chooses a branch.
      expect(usageReadingsComplete).toBe(subject.usageReadingsComplete);
      if (!subject.usageReadingsComplete) {
        // A partial usage reading (the adapter declares no complete
        // readings) cannot tell that the refused limit ended: it never
        // reports the fallback window, which stays until its own reset.
        expect(recorded).toEqual({ applied: true, recovered: false });
        expect(await placeChecked(turn, new Date(now + 2_000))).toMatchObject({ kind: "wait" });
        expect(await evaluateChecked(turn, new Date(fallback + 1_000))).toMatchObject({
          kind: "run",
          connectionId,
        });
        return;
      }
      expect(recorded).toEqual({ applied: true, recovered: true });
      expect(await placeChecked(turn, new Date(now + 2_000))).toMatchObject({
        kind: "run",
        connectionId,
      });
    });

    test("a header reading that omits a stored exhausted window keeps it and reports no recovery", async () => {
      const org = await organization();
      const connectionId = await sharedConnection(org, `partial-${crypto.randomUUID()}`);
      const turn = await runningTurn(org);
      const now = Date.now();
      const resetsAt = now + 3_600_000;
      expect(await placeChecked(turn, new Date(now))).toMatchObject({ kind: "run", connectionId });
      const [connection] = await admin()<{ refresh_generation: number }[]>`
        select refresh_generation::int as refresh_generation from subscription_connections
        where id = ${connectionId}::uuid`;
      const reading = (
        observedAt: number,
        windows: SubscriptionQuota["windows"],
      ): SubscriptionQuota => ({
        windows,
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        revision: 0,
        observedAt,
        observedRefreshGeneration: connection!.refresh_generation,
        source: "response_headers",
      });
      const short = { id: "fixture_short", usedPercent: 20, resetsAt: now + 600_000 };
      const lease = leaseOf(turn, connectionId);
      expect(
        await runtime().applySubscriptionCoreQuotaObservation(
          db(),
          turn.identity,
          lease,
          reading(now, [
            { ...short, status: "ok" },
            { id: "fixture_long", usedPercent: 100, resetsAt, status: "exhausted" },
          ]),
        ),
      ).toEqual({ applied: true, recovered: false });
      // A later header reading reports only the short window: the long
      // window's block stands, so nothing recovered and no waiter is woken.
      expect(
        await runtime().applySubscriptionCoreQuotaObservation(
          db(),
          turn.identity,
          lease,
          reading(now + 1_000, [{ ...short, usedPercent: 25, status: "ok" }]),
        ),
      ).toEqual({ applied: true, recovered: false });
      const waiting = await placeChecked(turn, new Date(now + 2_000));
      expect(waiting).toMatchObject({ kind: "wait" });
      expect(instantOf(waiting, "earliestResetAt")).toBe(resetsAt);
      expect(await evaluateChecked(turn, new Date(resetsAt + 1_000))).toMatchObject({
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

    test.skipIf(renews)(
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

    test.skipIf(!renews)(
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

    describe("explicit account choice and personal preferences", () => {
      const providers = [provider];
      const sessionOf = (turn: Turn) => ({
        accountId: turn.identity.accountId,
        workspaceId: turn.identity.workspaceId,
        sessionId: turn.identity.sessionId,
      });
      const choose = (turn: Turn, subjectId: string, connectionId: string | null) =>
        chooseSubscriptionCoreSessionAccount(
          db(),
          { ...sessionOf(turn), subjectId, connectionId },
          providers,
        );
      const picker = (turn: Turn, subjectId: string) =>
        readSubscriptionCoreSessionAccountChoice(
          db(),
          { ...sessionOf(turn), subjectId },
          providers,
        );
      const offered = async (turn: Turn, subjectId: string) =>
        Object.fromEntries(
          ((await picker(turn, subjectId))?.connections ?? []).map((connection) => [
            connection.connectionId,
            connection.choosable ? "choosable" : connection.refusal,
          ]),
        );
      const disablePersonal = (org: Org) => admin()`
        update subscription_settings set personal_connections_allowed = false
        where account_id = ${org.accountId}::uuid and workspace_id is null`;
      /** A member's own private session in the shared workspace. */
      const memberPrivateSession = async (org: Org, subjectId: string): Promise<string> => {
        const session = await withSessionRlsActorContext({ subjectId }, () =>
          createSession(db(), {
            accountId: org.accountId,
            workspaceId: org.sharedWorkspaceId,
            initialMessage: "conformance",
            resources: [],
            metadata: {},
            model: m0.productModelId,
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
            visibility: "user_private",
            subjectId,
            createdBy: { kind: "subject" as const, subjectId },
            createdByContext: {},
          }),
        );
        return session.id;
      };

      test("SUB-SEL-02, SUB-ELIG-05: the picker offers the pool and only the caller's own personal accounts", async () => {
        const org = await organization();
        const pooled = await sharedConnection(org, `pick-shared-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `pick-personal-${crypto.randomUUID()}`);
        const foreignPersonal = await foreignPersonalConnection(org);
        const member = await workspaceMember(org);
        const privateTurn = await runningTurn(org, { visibility: "user_private" });
        const sharedTurn = await runningTurn(org, { visibility: "workspace_shared" });
        // The owner's private session may use the pool and their own account.
        expect(await offered(privateTurn, org.ownerSubjectId)).toEqual({
          [pooled]: "choosable",
          [personal]: "choosable",
        });
        // In a shared session the personal account is listed for its owner but
        // cannot be chosen; another person never sees it.
        expect(await offered(sharedTurn, org.ownerSubjectId)).toEqual({
          [pooled]: "choosable",
          [personal]: "personal_not_owner_work",
        });
        expect(await offered(sharedTurn, member)).toEqual({ [pooled]: "choosable" });
        // Another person cannot read the owner's private session at all.
        expect(await picker(privateTurn, member)).toBeNull();
        // The foreign provider's and the other kind's rows are never offered.
        const listed = Object.keys(await offered(privateTurn, org.ownerSubjectId));
        for (const id of [
          org.foreign.healthy,
          org.foreign.quarantined,
          foreignPersonal,
          org.otherKind.identified,
          org.otherKind.unidentified,
        ])
          expect(listed).not.toContain(id);
        // The organization turns personal accounts off.
        await disablePersonal(org);
        const off = await picker(privateTurn, org.ownerSubjectId);
        expect(off!.personal).toMatchObject({ connectionsAllowed: false });
        expect(await offered(privateTurn, org.ownerSubjectId)).toEqual({
          [pooled]: "choosable",
          [personal]: "personal_not_allowed",
        });
      });

      test("SUB-SEL-04, D-28: the owner chooses their personal account for their private session; the database refuses it anywhere else", async () => {
        const org = await organization();
        const pooled = await sharedConnection(org, `choose-shared-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `choose-personal-${crypto.randomUUID()}`);
        const member = await workspaceMember(org);
        // Without fallback consent, automatic placement prefers the pool.
        await admin()`update subscription_person_preferences set personal_fallback_opt_in = false
          where account_id = ${org.accountId}::uuid
            and organization_membership_id = ${org.ownerMembershipId}::uuid`;
        const first = await runningTurn(org, {
          visibility: "user_private",
          personalAuthority: true,
        });
        expect(await placeChecked(first)).toMatchObject({ kind: "run", connectionId: pooled });
        const chosen = await choose(first, org.ownerSubjectId, personal);
        expect(chosen).toMatchObject({
          outcome: "changed",
          provider: providerId,
          connectionId: personal,
        });
        expect(chosen.events.map((event) => [event.type, event.payload])).toEqual([
          [
            "model_account.selection.changed",
            expect.objectContaining({
              provider: providerId,
              connectionId: personal,
              choice: "explicit",
              subjectId: org.ownerSubjectId,
            }),
          ],
        ]);
        expect(chosen.wakes.map((wake) => wake.provider)).toEqual([providerId]);
        expect(await bindingOf(first)).toMatchObject({
          connectionId: personal,
          choice: "explicit",
        });
        // The same id in upper case names the same account (no change).
        expect(await choose(first, org.ownerSubjectId, personal.toUpperCase())).toMatchObject({
          outcome: "unchanged",
        });
        expect((await picker(first, org.ownerSubjectId))!.binding).toEqual({
          provider: providerId,
          connectionId: personal,
          choice: "explicit",
        });
        // The same choice again changes nothing.
        expect((await choose(first, org.ownerSubjectId, personal)).outcome).toBe("unchanged");
        // The next turn runs on the chosen personal account.
        const second = await nextTurn(org, first, { personalAuthority: true });
        expect(await placeChecked(second)).toMatchObject({
          kind: "run",
          connectionId: personal,
          explicit: true,
        });
        // Back to automatic; again is a no-op.
        expect(await choose(second, org.ownerSubjectId, null)).toMatchObject({
          outcome: "changed",
          connectionId: null,
        });
        expect(await bindingOf(second)).toMatchObject({ choice: "automatic" });
        expect((await choose(second, org.ownerSubjectId, null)).outcome).toBe("unchanged");

        // A shared session of the owner: the binding guard refuses the
        // personal account (the picker listed it as not choosable).
        const sharedTurn = await runningTurn(org, { visibility: "workspace_shared" });
        expect((await choose(sharedTurn, org.ownerSubjectId, personal)).outcome).toBe("refused");
        // Any member may choose a pool account for a shared session.
        expect(await choose(sharedTurn, member, pooled)).toMatchObject({
          outcome: "changed",
          connectionId: pooled,
        });
        // Another person's personal account is never found, in their own
        // private session or the owner's shared one.
        const memberSession = await memberPrivateSession(org, member);
        expect(
          (
            await chooseSubscriptionCoreSessionAccount(
              db(),
              {
                accountId: org.accountId,
                workspaceId: org.sharedWorkspaceId,
                sessionId: memberSession,
                subjectId: member,
                connectionId: personal,
              },
              providers,
            )
          ).outcome,
        ).toBe("not_found");
        expect((await choose(sharedTurn, member, personal)).outcome).toBe("not_found");
        // The database itself refuses the member's direct write of the
        // owner's account into the member's own private session.
        await expect(
          withWorkspaceSubjectSessionActivityRls(
            db(),
            org.sharedWorkspaceId,
            member,
            async (tx) => {
              await tx.execute(
                sql`select set_config('opengeni.initiating_human_subject_id', ${member}, true)`,
              );
              await tx.execute(sql`insert into subscription_session_bindings (
                account_id, workspace_id, session_id, provider, connection_id, model_id,
                choice, only_this_model, version
              ) values (
                ${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${memberSession}::uuid,
                ${providerId}, ${personal}::uuid, ${m0.productModelId}, 'explicit', false, 1
              )`);
            },
          ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
        // Connections of the foreign provider are not found.
        expect((await choose(first, org.ownerSubjectId, org.foreign.healthy)).outcome).toBe(
          "not_found",
        );
        // Personal accounts turned off: the database refuses the choice.
        await disablePersonal(org);
        const third = await nextTurn(org, second, { personalAuthority: true });
        expect((await choose(third, org.ownerSubjectId, personal)).outcome).toBe("refused");
        expect(await bindingOf(third)).not.toMatchObject({
          connectionId: personal,
          choice: "explicit",
        });
      });

      test("SUB-OWN-05, D-24, D-27: turning personal accounts off makes an explicit personal choice wait as ineligible", async () => {
        const org = await organization();
        await sharedConnection(org, `off-shared-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `off-personal-${crypto.randomUUID()}`);
        const first = await runningTurn(org, {
          visibility: "user_private",
          personalAuthority: true,
        });
        await placeChecked(first);
        expect((await choose(first, org.ownerSubjectId, personal)).outcome).toBe("changed");
        await disablePersonal(org);
        const second = await nextTurn(org, first, { personalAuthority: true });
        expect(await placeChecked(second)).toMatchObject({
          kind: "wait",
          reason: "pinned_account_ineligible",
        });
        // Returning to automatic lets the pool serve it again.
        expect((await choose(second, org.ownerSubjectId, null)).outcome).toBe("changed");
        expect(await placeChecked(second)).toMatchObject({ kind: "run", personal: false });
      });

      test("SUB-SEL-02: a person reads and changes only their own fallback opt-in, and placement honours it", async () => {
        const org = await organization();
        const member = await workspaceMember(org);
        const owner = { accountId: org.accountId, subjectId: org.ownerSubjectId };
        // The fixture saved the owner's opt-in once.
        expect(await readSubscriptionPersonPreferences(db(), owner)).toEqual({
          personalFallbackOptIn: true,
          version: 1,
        });
        expect(
          await writeSubscriptionPersonPreferences(db(), {
            ...owner,
            personalFallbackOptIn: false,
            expectedVersion: 1,
          }),
        ).toEqual({
          outcome: "written",
          preferences: { personalFallbackOptIn: false, version: 2 },
          // Turning the opt-in off wakes nothing (no forced move).
          wakes: [],
        });
        expect(
          await writeSubscriptionPersonPreferences(db(), {
            ...owner,
            personalFallbackOptIn: true,
            expectedVersion: 1,
          }),
        ).toEqual({
          outcome: "conflict",
          preferences: { personalFallbackOptIn: false, version: 2 },
        });
        // A member without a saved preference starts at version 0.
        const memberScope = { accountId: org.accountId, subjectId: member };
        expect(await readSubscriptionPersonPreferences(db(), memberScope)).toEqual({
          personalFallbackOptIn: false,
          version: 0,
        });
        expect(
          await writeSubscriptionPersonPreferences(db(), {
            ...memberScope,
            personalFallbackOptIn: true,
            expectedVersion: 0,
          }),
        ).toMatchObject({
          outcome: "written",
          preferences: { personalFallbackOptIn: true, version: 1 },
        });
        expect(
          (
            await writeSubscriptionPersonPreferences(db(), {
              ...memberScope,
              personalFallbackOptIn: false,
              expectedVersion: 0,
            })
          ).outcome,
        ).toBe("conflict");
        // The member sees and changes nothing of the owner's, as the app role.
        await withRlsContext(db(), { accountId: org.accountId, workspaceId: null }, async (tx) => {
          await setSubjectRlsContext(tx, member);
          const visible = await rawRows<{ id: string }>(
            tx,
            sql`select organization_membership_id::text as id from subscription_person_preferences
              where account_id = ${org.accountId}::uuid`,
          );
          expect(visible.map((row) => row.id)).not.toContain(org.ownerMembershipId);
          const updated = await rawRows<{ version: number }>(
            tx,
            sql`update subscription_person_preferences set personal_fallback_opt_in = true
              where account_id = ${org.accountId}::uuid
                and organization_membership_id = ${org.ownerMembershipId}::uuid
              returning version`,
          );
          expect(updated).toEqual([]);
        });
        await expect(
          withRlsContext(db(), { accountId: org.accountId, workspaceId: null }, async (tx) => {
            await setSubjectRlsContext(tx, member);
            await tx.execute(sql`insert into subscription_person_preferences
                (account_id, organization_membership_id, personal_fallback_opt_in)
              values (${org.accountId}::uuid, ${crypto.randomUUID()}::uuid, true)`);
          }),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
        // Agents, services and people who left have no preferences here.
        expect(
          await readSubscriptionPersonPreferences(db(), {
            accountId: org.accountId,
            subjectId: "service:subscription-core",
          }),
        ).toBeNull();
        await admin()`update organization_memberships set status = 'revoked', revoked_at = now()
          where account_id = ${org.accountId}::uuid and subject_id = ${member}`;
        expect(await readSubscriptionPersonPreferences(db(), memberScope)).toBeNull();
        expect(
          (
            await writeSubscriptionPersonPreferences(db(), {
              ...memberScope,
              personalFallbackOptIn: false,
            })
          ).outcome,
        ).toBe("not_member");

        // Placement: with only a personal account, the owner's private turn
        // waits while they have not opted in, and runs on it once they have.
        const fallback = await organization();
        const personal = await personalConnection(fallback, `opt-in-${crypto.randomUUID()}`);
        const fallbackOwner = { accountId: fallback.accountId, subjectId: fallback.ownerSubjectId };
        await writeSubscriptionPersonPreferences(db(), {
          ...fallbackOwner,
          personalFallbackOptIn: false,
        });
        const waiting = await runningTurn(fallback, {
          visibility: "user_private",
          personalAuthority: true,
        });
        expect(await placeChecked(waiting)).toMatchObject({ kind: "wait" });
        await writeSubscriptionPersonPreferences(db(), {
          ...fallbackOwner,
          personalFallbackOptIn: true,
        });
        expect(await placeChecked(waiting)).toMatchObject({
          kind: "run",
          connectionId: personal,
          personal: true,
        });
        // The picker reports the opt-in and the effective settings.
        expect((await picker(waiting, fallback.ownerSubjectId))!.personal).toEqual({
          connectionsAllowed: true,
          fallbackAllowed: true,
          fallbackOptIn: true,
        });
      });

      test("SUB-SEL-02, D-26: the picker offers nothing an ownerless session or a provider switched off for the workspace could use", async () => {
        const org = await organization();
        const pooled = await sharedConnection(org, `none-shared-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `none-personal-${crypto.randomUUID()}`);
        // An ownerless session (for example a scheduled run started with an
        // API key): the binding guard admits no explicit choice, so nothing
        // is offered as choosable, and a choice is refused.
        const ownerless = await runningTurn(org, { owner: "none" });
        expect(await offered(ownerless, org.ownerSubjectId)).toEqual({
          [pooled]: "session_has_no_owner",
          [personal]: "session_has_no_owner",
        });
        expect((await choose(ownerless, org.ownerSubjectId, pooled)).outcome).toBe("refused");
        // The provider switched off for the workspace: nothing is listed,
        // shared or personal, and naming an account finds nothing.
        const privateTurn = await runningTurn(org, {
          visibility: "user_private",
          personalAuthority: true,
        });
        const off = admin().json({ [providerId]: { enabled: false } });
        const updated = await admin()`update subscription_settings
          set providers = coalesce(providers, '{}'::jsonb) || ${off}::jsonb
          where account_id = ${org.accountId}::uuid and workspace_id = ${org.sharedWorkspaceId}::uuid
          returning 1`;
        if (updated.length === 0)
          await admin()`insert into subscription_settings (account_id, workspace_id, providers)
            values (${org.accountId}::uuid, ${org.sharedWorkspaceId}::uuid, ${off}::jsonb)`;
        expect(await offered(privateTurn, org.ownerSubjectId)).toEqual({});
        expect((await choose(privateTurn, org.ownerSubjectId, personal)).outcome).toBe("not_found");
      });

      test("SUB-SEL-04: an API key or service may choose a shared account for a person's shared session, never a personal one", async () => {
        const org = await organization();
        const pooled = await sharedConnection(org, `key-shared-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `key-personal-${crypto.randomUUID()}`);
        const sharedTurn = await runningTurn(org, { visibility: "workspace_shared" });
        for (const caller of [`api_key:${crypto.randomUUID()}`, `service:${crypto.randomUUID()}`]) {
          // The caller sees only the pool: never someone's personal account.
          expect(await offered(sharedTurn, caller)).toEqual({ [pooled]: "choosable" });
          // Naming the owner's personal account finds nothing for this caller.
          expect((await choose(sharedTurn, caller, personal)).outcome).toBe("not_found");
          expect(await choose(sharedTurn, caller, pooled)).toMatchObject({
            outcome: "changed",
            connectionId: pooled,
          });
          expect(await bindingOf(sharedTurn)).toMatchObject({
            connectionId: pooled,
            choice: "explicit",
          });
          expect((await choose(sharedTurn, caller, null)).outcome).toBe("changed");
        }
      });

      test("SUB-WAIT-02, SUB-SEL-04: a choice for a waiting turn wakes it, and turning the fallback opt-in on wakes only the person's own waiting turns", async () => {
        const armWaiter = async (org: Org, turn: Turn): Promise<string> => {
          const tenant = { accountId: org.accountId, workspaceId: org.sharedWorkspaceId };
          const waiter = await withRlsContext(db(), tenant, (tx) =>
            upsertSubscriptionCapacityWaiter(tx, {
              ...tenant,
              sessionId: turn.identity.sessionId,
              turnId: turn.identity.turnId,
              waiterId: crypto.randomUUID(),
              provider: providerId,
              waitReason: "capacity",
              generation: 1,
              wakeRevision: 1,
              observedWakeRevision: 1,
              blockedTurnGeneration: turn.executionGeneration,
            }),
          );
          if (!waiter) throw new Error("Fixture failed to arm a waiter");
          return waiter.waiterId;
        };
        const revisionOf = async (waiterId: string) => {
          const [row] = await admin()<{ wake_revision: string }[]>`
            select wake_revision::text from subscription_capacity_waiters
            where waiter_id = ${waiterId}::uuid`;
          return Number(row!.wake_revision);
        };

        // A turn waiting for capacity: the choice applies to it at once.
        const org = await organization();
        const pooled = await sharedConnection(org, `wake-shared-${crypto.randomUUID()}`);
        const turn = await runningTurn(org, { visibility: "user_private" });
        await placeChecked(turn);
        await admin()`update sessions set status = 'waiting_capacity'
          where id = ${turn.identity.sessionId}::uuid`;
        const waiter = await armWaiter(org, turn);
        const chosen = await choose(turn, org.ownerSubjectId, pooled);
        expect(chosen).toMatchObject({ outcome: "changed", appliedTo: "waiting_turn" });
        expect(chosen.events[0]!.payload).toMatchObject({
          appliedTo: "waiting_turn",
          turnId: turn.identity.turnId,
        });
        await deliverSubscriptionCoreProviderWakes(db(), chosen.wakes);
        expect(await revisionOf(waiter)).toBe(2);

        // Only a personal account, and the owner has not opted in: the
        // owner's private turn waits. Turning the opt-in on wakes it.
        const fallback = await organization();
        const personal = await personalConnection(fallback, `wake-personal-${crypto.randomUUID()}`);
        const owner = { accountId: fallback.accountId, subjectId: fallback.ownerSubjectId };
        await writeSubscriptionPersonPreferences(db(), { ...owner, personalFallbackOptIn: false });
        const waiting = await runningTurn(fallback, {
          visibility: "user_private",
          personalAuthority: true,
        });
        expect(await placeChecked(waiting)).toMatchObject({ kind: "wait" });
        const fallbackWaiter = await armWaiter(fallback, waiting);
        // Waiting turns that the person's accounts can never serve: an
        // ownerless session and a colleague's session. Placement offers a
        // personal account only to its owner's sessions, so the opt-in wake
        // leaves them alone.
        const ownerless = await runningTurn(fallback, { owner: "none" });
        const ownerlessWaiter = await armWaiter(fallback, ownerless);
        const colleague = await workspaceMember(fallback);
        const [colleagueMembership] = await admin()<{ id: string }[]>`
          select id::text as id from organization_memberships
          where account_id = ${fallback.accountId}::uuid and subject_id = ${colleague}`;
        const theirs = await runningTurn(fallback, { visibility: "workspace_shared" });
        // Fixture only: hand the session to the colleague. Session authority
        // is guarded by triggers, which this superuser transaction skips.
        await admin().begin(async (fixture) => {
          await fixture`set local session_replication_role = replica`;
          await fixture`update sessions
            set owner_subject_id = ${colleague},
              owner_organization_membership_id = ${colleagueMembership!.id}::uuid
            where id = ${theirs.identity.sessionId}::uuid`;
        });
        const colleagueWaiter = await armWaiter(fallback, theirs);
        const on = await writeSubscriptionPersonPreferences(
          db(),
          { ...owner, personalFallbackOptIn: true },
          providers,
        );
        expect(on.outcome).toBe("written");
        const wakes = on.outcome === "written" ? on.wakes : [];
        expect(wakes.map((wake) => wake.provider)).toEqual([providerId]);
        expect(wakes.map((wake) => wake.ownerMembershipId)).toEqual([fallback.ownerMembershipId]);
        await deliverSubscriptionCoreProviderWakes(db(), wakes);
        expect(await revisionOf(fallbackWaiter)).toBe(2);
        expect(await revisionOf(ownerlessWaiter)).toBe(1);
        expect(await revisionOf(colleagueWaiter)).toBe(1);
        expect(await placeChecked(waiting)).toMatchObject({
          kind: "run",
          connectionId: personal,
          personal: true,
        });
        // Saving the same value again, or turning it off, wakes nothing (D-27).
        for (const optIn of [true, false]) {
          const again = await writeSubscriptionPersonPreferences(
            db(),
            { ...owner, personalFallbackOptIn: optIn },
            providers,
          );
          expect(again.outcome === "written" ? again.wakes : null).toEqual([]);
        }
      });

      test("concurrent choices and placements serialize on the binding and never lose a choice", async () => {
        const org = await organization();
        const a = await sharedConnection(org, `race-a-${crypto.randomUUID()}`);
        const b = await sharedConnection(org, `race-b-${crypto.randomUUID()}`);
        const personal = await personalConnection(org, `race-personal-${crypto.randomUUID()}`);
        // A fresh session without a binding: the choice and the first
        // placement race to create it.
        for (let round = 0; round < 4; round += 1) {
          const turn = await runningTurn(org, {
            visibility: "user_private",
            personalAuthority: true,
          });
          const [chosen] = await Promise.all([
            choose(turn, org.ownerSubjectId, personal),
            place(turn),
          ]);
          expect(chosen.outcome).toBe("changed");
          expect(await bindingOf(turn)).toMatchObject({
            connectionId: personal,
            choice: "explicit",
          });
        }
        // Two people choose different pool accounts for one shared session at
        // once: both commit in some order, each recorded once.
        const member = await workspaceMember(org);
        const sharedTurn = await runningTurn(org, { visibility: "workspace_shared" });
        await placeChecked(sharedTurn);
        const before = (await bindingOf(sharedTurn))!.version;
        const results = await Promise.all([
          choose(sharedTurn, org.ownerSubjectId, a),
          choose(sharedTurn, member, b),
        ]);
        const changed = results.filter((result) => result.outcome === "changed");
        expect(changed.length + results.filter((r) => r.outcome === "unchanged").length).toBe(2);
        const final = (await bindingOf(sharedTurn))!;
        expect(final.choice).toBe("explicit");
        expect([a, b]).toContain(final.connectionId as string);
        expect(final.version).toBe(before + changed.length);
        const sequences = changed.flatMap((result) => result.events.map((event) => event.sequence));
        expect(new Set(sequences).size).toBe(changed.length);
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
