/**
 * Migration 0720: the drained, one-way Claude cutover onto the shared
 * subscription core (design 5.3 "Data mapping", "Accepted authority across
 * the cutover", "Personal authority generations", "Cutover protocol",
 * "Claude track"). The legacy state is seeded as the database superuser in
 * the shapes staging holds (OAuth sign-ins and pasted setup tokens, account
 * UUID and `oauth:`/`setup:` HMAC ids, organization, workspace, Personal
 * workspace and `user` scope, usage rows with per-model cooldowns, the
 * revoked model connections 0598 left behind, live `claudeAuthRecovery`
 * values). The migration runs as the NOSUPERUSER/NOBYPASSRLS schema owner
 * exactly as in production, and runtime behaviour afterward is asserted as
 * the restricted application role `opengeni_app`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "../src/environment-crypto";
import { rawRows, withRlsContext } from "../src/database";
import {
  createDb,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { decodeSubscriptionCoreClaudeCredential } from "../src/subscription-core-claude-adapter";
import { SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES } from "../src/runtime-posture";
import { deleteSubscriptionCoreWaitersForTurns } from "../src/subscription-core/waiters";
import { subscriptionCoreOperations } from "../src/subscription-core/operations";
import { subscriptionCoreProvider } from "../src/subscription-core-providers";

const MIGRATION = "0720_subscription_core_claude_cutover.sql";
const key = Buffer.alloc(32, 79);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const PROVIDER = "organization-claude-subscription";
const MODEL = `${PROVIDER}/claude-opus-5-5`;
const CODEX_MODEL = "codex/gpt-5.5";
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const a = {
  account: randomUUID(),
  owner: "user:c3-owner",
  bob: "user:c3-bob",
  om: randomUUID(),
  bm: randomUUID(),
  pa: randomUUID(), // the owner's Personal workspace
  pb: randomUUID(), // bob's Personal workspace
  w1: randomUUID(),
  w2: randomUUID(),
  w3: randomUUID(),
  // Upstream Claude accounts.
  u1: randomUUID(),
  u4: randomUUID(),
  u5: randomUUID(),
  u6: randomUUID(),
  u8: randomUUID(),
  // Credentials.
  c1: randomUUID(), // W1 local OAuth u1, healthiest: canonical; current usage + cooldown
  c2: randomUUID(), // W2 local OAuth u1, error: alias of c1; its live cooldown moves to c1
  c3: randomUUID(), // organization setup token, `setup:` HMAC id, exhausted, no usage
  c4: randomUUID(), // organization OAuth u4, allowlist [W2], no Personal workspaces
  c5: randomUUID(), // the owner's Personal workspace (OAuth u5): personal connection
  c6: randomUUID(), // owner `user` in W1 (OAuth u6), generation 3: personal connection
  c7: randomUUID(), // owner `user` in W2, same login u6, generation 2: alias of c6
  c8: randomUUID(), // bob `user` in W3 (OAuth u8): bob's personal connection
  c9: randomUUID(), // W3 local setup token without an account id; a stale usage row
  c10: randomUUID(), // W3 local setup token stored under u1: never merged with OAuth c1
  c11: randomUUID(), // W1 local OAuth `oauth:` HMAC id; an unreadable current usage row
  a6: randomUUID(),
  a7: randomUUID(),
  a8: randomUUID(),
  // Sessions and turns.
  s1: randomUUID(), // W2 shared, manual pin on alias c2, waiting
  s2: randomUUID(), // W1 private, owner `user` pool, running with a live lease + auth recovery
  s3: randomUUID(), // owner's Personal workspace, last c5
  s4: randomUUID(), // W3 private, bob's `user` pool, queued; auth recovery of a removed account
  s5: randomUUID(), // W1 shared, no turn yet (initial snapshot organization)
  s6: randomUUID(), // W1 shared, bob's session pinned to the owner's personal c6
  s7: randomUUID(), // child of s1 (parent turn t5)
  t1: randomUUID(),
  t2: randomUUID(),
  t3: randomUUID(),
  t4: randomUUID(),
  t5: randomUUID(),
  t6: randomUUID(), // withdrawn for edit; a composer draft still edits it
  t12: randomUUID(), // W1 shared, queued with a malformed auth recovery value
  t13: randomUUID(), // W1 shared, queued with an auth recovery of an older c1 version
  s12: randomUUID(),
  waiter: randomUUID(),
  goal: randomUUID(),
  collapsed: randomUUID(),
  draft: randomUUID(),
  update: randomUUID(),
  outbox: randomUUID(),
  taskUser: randomUUID(),
  taskPersonal: randomUUID(),
  // Revoked legacy model connections (0598 moved them to the pools).
  revokedConnection: randomUUID(),
  revokedOrganizationConnection: randomUUID(),
  // Codex state in the same organization that the cutover must keep.
  cx: randomUUID(),
  s8: randomUUID(), // W1 shared, current model Codex, Codex binding, legacy Claude pin
  t8: randomUUID(),
  s9: randomUUID(), // W1 shared, current model Claude, Codex binding, legacy Claude pin
  t9: randomUUID(),
};
// Organization B forbids personal connections.
const b = {
  account: randomUUID(),
  owner: "user:c3-b-owner",
  membership: randomUUID(),
  personal: randomUUID(),
  w1: randomUUID(),
  y1: randomUUID(),
  authority: randomUUID(),
  session: randomUUID(),
  turn: randomUUID(),
};
// Organization D locks rotation (with the primaries) and providers.
const d = {
  account: randomUUID(),
  w1: randomUUID(), // local account; a pre-existing override row
  w2: randomUUID(), // local account, no override row
  z1: randomUUID(),
  z2: randomUUID(),
};
// Organization C: SuperGrok legacy and Codex core rows the cutover must not touch.
const c = {
  account: randomUUID(),
  w1: randomUUID(),
  codex: randomUUID(),
  xai: randomUUID(),
};

let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
const SEEDED_TABLES = [
  "managed_accounts",
  "workspaces",
  "organization_memberships",
  "organization_user_resource_authorities",
  "sessions",
  "session_turns",
  "composer_drafts",
  "session_goals",
  "claude_subscription_credentials",
  "claude_subscription_account_usage",
  "claude_rotation_settings",
  "claude_credential_leases",
  "claude_session_account_pins",
  "claude_capacity_waiters",
  "connections",
  "organization_model_provider_connections",
  "scheduled_tasks",
  "scheduled_task_revision_authorities",
  "session_system_updates",
  "session_system_update_outbox",
  "subscription_connections",
  "subscription_settings",
  "subscription_session_bindings",
  "subscription_leases",
  "workspace_memberships",
  "xai_subscription_credentials",
] as const;

async function withSeedTriggersOff(fn: () => Promise<void>) {
  for (const table of SEEDED_TABLES)
    await owned.admin.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    for (const table of SEEDED_TABLES)
      await owned.admin.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

/** The legacy stored secret: an OAuth sign-in or a pasted setup token. */
function secret(id: string, accountUuid: string, oauth: boolean) {
  return {
    version: 1,
    token: `sk-ant-oat01-access-${id}`,
    identity: { accountUuid, deviceId: "d".repeat(64) },
    ...(oauth
      ? {
          oauth: {
            refreshToken: `refresh-${id}`,
            expiresAt: iso(HOUR),
            scopes: ["user:inference", "user:profile"],
          },
        }
      : {}),
  };
}

async function credential(input: {
  id: string;
  account: string;
  workspace: string | null;
  scope: "workspace" | "organization" | "user";
  /** The token's Claude account UUID ("" when the token reports none). */
  accountUuid: string;
  oauth?: boolean;
  /** The stored `provider_account_id` (default: the account UUID, or NULL when empty). */
  column?: string | null;
  owner?: string;
  authority?: string;
  generation?: number;
  status?: string;
  version?: number;
  lastRefreshAt?: Date | null;
  allocator?: boolean;
  allowedModels?: string[] | null;
  allowedWorkspaces?: string[] | null;
  allowPersonal?: boolean;
  selections?: number;
  exhaustedUntil?: Date | null;
}) {
  const oauth = input.oauth ?? true;
  if (input.scope === "user") {
    await owned.admin`INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id,
        generation, status
      ) VALUES (${input.authority!}, ${input.account}, ${input.owner!}, 'claude_subscription',
        ${input.id}, ${input.workspace}, ${input.generation!}, 'active')`;
  }
  await owned.admin`INSERT INTO claude_subscription_credentials (
      id, account_id, workspace_id, authority_scope, credential_encrypted, provider_account_id,
      label, account_email, plan_type, status, version, expires_at, last_refresh_at,
      allocator_enabled, allowed_model_ids, allowed_workspace_ids, allow_personal_workspaces,
      selection_count, last_selected_at, exhausted_until, owner_organization_membership_id,
      organization_user_resource_authority_id, organization_user_resource_kind,
      organization_user_resource_authority_generation, connected_by_subject_id, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.scope},
      ${encryptEnvironmentValue(key, JSON.stringify(secret(input.id, input.accountUuid, oauth)))},
      ${input.column === undefined ? input.accountUuid || null : input.column},
      ${`Label ${input.id.slice(0, 4)}`}, NULL, ${oauth ? "max" : null},
      ${input.status ?? "active"}, ${input.version ?? 4}, ${oauth ? new Date(Date.now() + HOUR) : null},
      ${input.lastRefreshAt ?? null}, ${input.allocator ?? true},
      ${input.allowedModels ?? null}::text[], ${input.allowedWorkspaces ?? null}::uuid[],
      ${input.allowPersonal ?? true}, ${input.selections ?? 0},
      ${input.selections ? new Date(Date.now() - 120_000) : null}, ${input.exhaustedUntil ?? null},
      ${input.owner ?? null}, ${input.authority ?? null},
      ${input.scope === "user" ? "claude_subscription" : null}, ${input.generation ?? null},
      'user:connector', now() - interval '1 day'
    )`;
}

/** A legacy usage snapshot as the legacy writer stores it. */
function usageSnapshot(version: number, usedPercent: number) {
  const observedAt = iso(-30_000);
  return {
    connected: true,
    credentialVersion: version,
    windows: [
      {
        id: "five_hour",
        usedPercent,
        resetsAt: iso(HOUR),
        status: "allowed",
        observedAt,
        source: "response_headers",
      },
    ],
    observedAt,
    source: "response_headers",
    refreshStatus: "available",
    refreshCheckedAt: observedAt,
    requestStatus: null,
    requestRestrictions: [],
  };
}

async function usage(input: {
  credential: string;
  account: string;
  version: number;
  snapshot: unknown;
  cooldowns?: Record<string, string>;
}) {
  await owned.admin`INSERT INTO claude_subscription_account_usage (
      credential_id, account_id, credential_version, snapshot, model_cooldowns
    ) VALUES (${input.credential}, ${input.account}, ${input.version},
      ${owned.admin.json(input.snapshot as never)}, ${owned.admin.json((input.cooldowns ?? {}) as never)})`;
}

const userV1 = (generation: number) => ({
  version: 1,
  scope: "user",
  authorityGeneration: generation,
});
const workspaceV1 = { version: 1, scope: "workspace" } as const;
const organizationV1 = { version: 1, scope: "organization" } as const;

async function session(input: {
  id: string;
  account: string;
  workspace: string;
  ownerSubject: string | null;
  ownerMembership: string | null;
  visibility?: "user_private" | "workspace_shared";
  initialV1?: Record<string, unknown>;
  parent?: { session: string; turn: string };
}) {
  await owned.admin`INSERT INTO sessions (
      id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
      sandbox_backend, sandbox_group_id, root_session_id, nested_agent_depth,
      effective_max_nested_agent_depth, nested_agent_depth_policy_source, tool_policy,
      owner_subject_id, owner_organization_membership_id, visibility, created_by_kind,
      created_by_subject_id, initial_claude_provider_account_authority_snapshot, parent_session_id,
      parent_turn_id
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, 'Retained work', ${MODEL}, 'high',
      'standard', 'none', ${input.id}, ${input.parent?.session ?? input.id},
      ${input.parent ? 1 : 0}, 8, 'deployment',
      '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,
      ${input.ownerSubject}, ${input.ownerMembership}, ${input.visibility ?? "workspace_shared"},
      ${input.ownerSubject ? "subject" : "service"}, ${input.ownerSubject ?? "service:fixture"},
      ${owned.admin.json((input.initialV1 ?? workspaceV1) as never)}, ${input.parent?.session ?? null},
      ${input.parent?.turn ?? null}
    )`;
}

async function turn(input: {
  id: string;
  account: string;
  workspace: string;
  session: string;
  status: string;
  position: number;
  human: string | null;
  v1: Record<string, unknown>;
  provider?: typeof PROVIDER | "codex-subscription";
  authRecovery?: unknown;
}) {
  const model = input.provider === "codex-subscription" ? CODEX_MODEL : MODEL;
  await owned.admin`INSERT INTO session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
      source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, metadata,
      initiating_human_subject_id, initiator_kind, initiator_subject_id,
      claude_provider_account_authority_snapshot, execution_generation, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.session}, ${randomUUID()},
      ${`session-${input.session}`}, ${input.status}, 'user', ${input.position}, 'Retained prompt',
      ${model}, 'high', 'standard', 'none',
      ${owned.admin.json({
        turnExecutionPolicyV1: { providerId: input.provider ?? PROVIDER, productModelId: model },
        ...(input.authRecovery === undefined ? {} : { claudeAuthRecovery: input.authRecovery }),
      } as never)},
      ${input.human}, ${input.human ? "subject" : "service"}, ${input.human ?? "service:fixture"},
      ${owned.admin.json(input.v1 as never)}, 2,
      now() - make_interval(secs => ${100 - input.position})
    )`;
}

async function seed() {
  const admin = owned.admin;
  await withSeedTriggersOff(async () => {
    for (const account of [a.account, b.account, c.account, d.account]) {
      await admin`INSERT INTO managed_accounts (id, name) VALUES (${account}, 'Cutover fixture')`;
    }
    for (const [id, account] of [
      [a.pa, a.account],
      [a.pb, a.account],
      [a.w1, a.account],
      [a.w2, a.account],
      [a.w3, a.account],
      [b.personal, b.account],
      [b.w1, b.account],
      [c.w1, c.account],
      [d.w1, d.account],
      [d.w2, d.account],
    ] as const) {
      await admin`INSERT INTO workspaces (id, account_id, name) VALUES (${id}, ${account}, 'Cutover workspace')`;
    }
    for (const [id, account, subject, personal, role] of [
      [a.om, a.account, a.owner, a.pa, "owner"],
      [a.bm, a.account, a.bob, a.pb, "member"],
      [b.membership, b.account, b.owner, b.personal, "owner"],
    ] as const) {
      await admin`INSERT INTO organization_memberships (id, account_id, subject_id, status, personal_workspace_id, role)
        VALUES (${id}, ${account}, ${subject}, 'active', ${personal}, ${role})`;
    }

    // Organization A.
    await credential({
      id: a.c1,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      accountUuid: a.u1,
      lastRefreshAt: new Date(Date.now() - 60_000),
      selections: 5,
    });
    await credential({
      id: a.c2,
      account: a.account,
      workspace: a.w2,
      scope: "workspace",
      accountUuid: a.u1,
      status: "error",
      version: 2,
      selections: 3,
      allowedModels: [MODEL],
    });
    await credential({
      id: a.c3,
      account: a.account,
      workspace: null,
      scope: "organization",
      accountUuid: "",
      oauth: false,
      column: `setup:${"a".repeat(64)}`,
      exhaustedUntil: new Date(Date.now() + 1_800_000),
    });
    await credential({
      id: a.c4,
      account: a.account,
      workspace: null,
      scope: "organization",
      accountUuid: a.u4,
      allowedWorkspaces: [a.w2],
      allowPersonal: false,
      allowedModels: [MODEL],
    });
    await credential({
      id: a.c5,
      account: a.account,
      workspace: a.pa,
      scope: "workspace",
      accountUuid: a.u5,
    });
    await credential({
      id: a.c6,
      account: a.account,
      workspace: a.w1,
      scope: "user",
      accountUuid: a.u6,
      owner: a.om,
      authority: a.a6,
      generation: 3,
    });
    await credential({
      id: a.c7,
      account: a.account,
      workspace: a.w2,
      scope: "user",
      accountUuid: a.u6,
      owner: a.om,
      authority: a.a7,
      generation: 2,
      status: "error",
    });
    await credential({
      id: a.c8,
      account: a.account,
      workspace: a.w3,
      scope: "user",
      accountUuid: a.u8,
      owner: a.bm,
      authority: a.a8,
      generation: 1,
    });
    await credential({
      id: a.c9,
      account: a.account,
      workspace: a.w3,
      scope: "workspace",
      accountUuid: "",
      oauth: false,
      exhaustedUntil: new Date(Date.now() + 600_000),
    });
    await credential({
      id: a.c10,
      account: a.account,
      workspace: a.w3,
      scope: "workspace",
      accountUuid: a.u1,
      oauth: false,
    });
    await credential({
      id: a.c11,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      accountUuid: "",
      column: `oauth:${"b".repeat(64)}`,
    });
    // Usage: c1 current with a live Opus cooldown; the alias c2 current with
    // a live Sonnet cooldown (moves to c1) and an ended one; c9 stale (an
    // older credential version); c11 current but unreadable.
    await usage({
      credential: a.c1,
      account: a.account,
      version: 4,
      snapshot: usageSnapshot(4, 42),
      cooldowns: { "claude-opus-5-5": iso(2 * HOUR) },
    });
    await usage({
      credential: a.c2,
      account: a.account,
      version: 2,
      snapshot: usageSnapshot(2, 10),
      cooldowns: { "claude-sonnet-5-5": iso(3 * HOUR), "claude-haiku-5-5": iso(-HOUR) },
    });
    await usage({
      credential: a.c9,
      account: a.account,
      version: 1,
      snapshot: usageSnapshot(1, 99),
      cooldowns: { "claude-opus-5-5": iso(HOUR) },
    });
    await usage({
      credential: a.c11,
      account: a.account,
      version: 4,
      snapshot: { connected: true, credentialVersion: 4, windows: "not-a-list" },
    });
    // c5 current, but its last usage refresh asked for a reconnect.
    await usage({
      credential: a.c5,
      account: a.account,
      version: 4,
      snapshot: { ...usageSnapshot(4, 5), refreshStatus: "reconnect" },
    });
    await admin`INSERT INTO claude_rotation_settings (account_id, workspace_id, authority_scope, owner_organization_membership_id, active_credential_id, rotation_enabled, fairness_cursor)
      VALUES (${a.account}, NULL, 'organization', NULL, ${a.c3}, false, 0),
             (${a.account}, ${a.w1}, 'workspace', NULL, ${a.c1}, false, 7),
             (${a.account}, ${a.pa}, 'workspace', NULL, ${a.c5}, true, 0),
             (${a.account}, ${a.w1}, 'user', ${a.om}, ${a.c6}, false, 0)`;
    // 0598 revoked and blanked every legacy Claude model connection.
    await admin`INSERT INTO connections (id, account_id, workspace_id, provider_domain, kind,
        credential_encrypted, version, metadata, status)
      VALUES (${a.revokedConnection}, ${a.account}, ${a.w1}, 'api.anthropic.com', 'api_key', '', 3,
        '{"credentialRole":"claude_subscription"}'::jsonb, 'revoked')`;
    await admin`INSERT INTO organization_model_provider_connections (id, account_id, provider_kind,
        credential_encrypted, version, operation_id, request_hash, updated_by_subject_id, status)
      VALUES (${a.revokedOrganizationConnection}, ${a.account}, 'claude_subscription', '', 2,
        ${randomUUID()}, ${"a".repeat(64)}, 'user:fixture', 'revoked')`;

    await session({
      id: a.s1,
      account: a.account,
      workspace: a.w2,
      ownerSubject: a.owner,
      ownerMembership: a.om,
    });
    await turn({
      id: a.t5,
      account: a.account,
      workspace: a.w2,
      session: a.s1,
      status: "completed",
      position: 0,
      human: a.owner,
      v1: workspaceV1,
    });
    await turn({
      id: a.t6,
      account: a.account,
      workspace: a.w2,
      session: a.s1,
      status: "withdrawn_for_edit",
      position: 1,
      human: a.owner,
      v1: workspaceV1,
    });
    await turn({
      id: a.t1,
      account: a.account,
      workspace: a.w2,
      session: a.s1,
      status: "waiting_capacity",
      position: 2,
      human: a.owner,
      v1: workspaceV1,
      // A renewal of the duplicate login c2 (version 2), now an alias of c1:
      // never a receipt on c1, whose own credential was not renewed.
      authRecovery: { credentialId: a.c2, credentialVersion: 2 },
    });
    await session({
      id: a.s2,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.owner,
      ownerMembership: a.om,
      visibility: "user_private",
    });
    // The worker renewed c6's token for this turn after a 401 at version 4.
    await turn({
      id: a.t2,
      account: a.account,
      workspace: a.w1,
      session: a.s2,
      status: "running",
      position: 0,
      human: a.owner,
      v1: userV1(3),
      authRecovery: { credentialId: a.c6, credentialVersion: 4 },
    });
    await session({
      id: a.s3,
      account: a.account,
      workspace: a.pa,
      ownerSubject: a.owner,
      ownerMembership: a.om,
      visibility: "user_private",
    });
    await turn({
      id: a.t3,
      account: a.account,
      workspace: a.pa,
      session: a.s3,
      status: "completed",
      position: 0,
      human: a.owner,
      v1: workspaceV1,
      // A finished turn's value is history: never converted.
      authRecovery: { credentialId: a.c5, credentialVersion: 4 },
    });
    await session({
      id: a.s4,
      account: a.account,
      workspace: a.w3,
      ownerSubject: a.bob,
      ownerMembership: a.bm,
      visibility: "user_private",
    });
    // An account removed since the renewal: nothing to bound.
    await turn({
      id: a.t4,
      account: a.account,
      workspace: a.w3,
      session: a.s4,
      status: "queued",
      position: 0,
      human: a.bob,
      v1: userV1(1),
      authRecovery: { credentialId: randomUUID(), credentialVersion: 2 },
    });
    await session({
      id: a.s5,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.owner,
      ownerMembership: a.om,
      initialV1: organizationV1,
    });
    await session({
      id: a.s6,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.bob,
      ownerMembership: a.bm,
    });
    await session({
      id: a.s7,
      account: a.account,
      workspace: a.w2,
      ownerSubject: a.owner,
      ownerMembership: a.om,
      parent: { session: a.s1, turn: a.t5 },
    });
    await session({
      id: a.s12,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.owner,
      ownerMembership: a.om,
    });
    // A value legacy never read (its version is not a number).
    await turn({
      id: a.t12,
      account: a.account,
      workspace: a.w1,
      session: a.s12,
      status: "queued",
      position: 0,
      human: a.owner,
      v1: workspaceV1,
      authRecovery: { credentialId: a.c1, credentialVersion: "4" },
    });
    // A renewal of c1 at version 3, before its current version 4: not about
    // the current credential.
    await turn({
      id: a.t13,
      account: a.account,
      workspace: a.w1,
      session: a.s12,
      status: "queued",
      position: 1,
      human: a.owner,
      v1: workspaceV1,
      authRecovery: { credentialId: a.c1, credentialVersion: 3 },
    });
    await admin`INSERT INTO claude_session_account_pins (account_id, workspace_id, session_id, authority_scope, owner_organization_membership_id, pinned_credential_id, pin_source, last_credential_id)
      VALUES (${a.account}, ${a.w2}, ${a.s1}, 'workspace', NULL, ${a.c2}, 'manual', ${a.c2}),
             (${a.account}, ${a.w1}, ${a.s2}, 'user', ${a.om}, NULL, NULL, ${a.c6}),
             (${a.account}, ${a.pa}, ${a.s3}, 'workspace', NULL, NULL, NULL, ${a.c5}),
             (${a.account}, ${a.w3}, ${a.s4}, 'user', ${a.bm}, NULL, NULL, ${a.c8}),
             (${a.account}, ${a.w1}, ${a.s6}, 'user', ${a.om}, ${a.c6}, 'manual', NULL)`;
    await admin`INSERT INTO claude_credential_leases (account_id, workspace_id, authority_scope, owner_organization_membership_id, credential_id, turn_id, holder_id, generation, leased_until)
      VALUES (${a.account}, ${a.w1}, 'user', ${a.om}, ${a.c6}, ${a.t2}, 'attempt-t2', 2, now() + interval '10 minutes'),
             (${a.account}, ${a.w2}, 'workspace', NULL, ${a.c2}, ${a.t5}, 'attempt-expired', 1, now() - interval '1 minute')`;
    await admin`INSERT INTO session_goals (id, account_id, workspace_id, session_id, text, version)
      VALUES (${a.goal}, ${a.account}, ${a.w2}, ${a.s1}, 'Finish the retained work', 3)`;
    await admin`INSERT INTO claude_capacity_waiters (
        id, account_id, workspace_id, session_id, blocked_turn_id, blocked_turn_generation,
        workflow_id, authority_scope, owner_organization_membership_id, status, generation,
        earliest_reset_at, next_check_at, wake_revision, observed_wake_revision, last_wake_reason,
        updated_at, goal_id, goal_version
      ) VALUES
        (${a.waiter}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, 2, ${`session-${a.s1}`}, 'workspace',
         NULL, 'waiting', 3, now() + interval '20 minutes', now() + interval '1 minute', 5, 4,
         'usage_refreshed', now() - interval '1 minute', ${a.goal}, 3),
        (${a.collapsed}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, 2, ${`session-${a.s1}`},
         'organization', NULL, 'waiting', 1, NULL, now() + interval '1 minute', 1, 1,
         'capacity_wait_armed', now(), NULL, NULL)`;
    await admin`INSERT INTO composer_drafts (id, account_id, workspace_id, session_id, subject_id, text, model, reasoning_effort, source_turn_id, source_turn_version)
      VALUES (${a.draft}, ${a.account}, ${a.w2}, ${a.s1}, ${a.owner}, 'Edited prompt', ${MODEL}, 'high', ${a.t6}, 1)`;
    await admin`INSERT INTO session_system_updates (id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, state)
      VALUES (${a.update}, ${a.account}, ${a.w2}, ${a.s1}, 'child_terminal_result', 'pending-source', 'pending-update', 'Pending', 'pending')`;
    await admin`INSERT INTO session_system_update_outbox (id, account_id, workspace_id, source_session_id, target_session_id, dedupe_key, kind, classification, source_id, summary, payload)
      VALUES (${a.outbox}, ${a.account}, ${a.w2}, ${a.s7}, ${a.s1}, 'cutover-outbox', 'child_terminal_result', 'result', 'outbox-source', 'Outbox', '{"type":"child_terminal_result"}'::jsonb)`;
    for (const [id, workspace, v1] of [
      [a.taskUser, a.w2, userV1(2)],
      [a.taskPersonal, a.pa, workspaceV1],
    ] as const) {
      await admin`INSERT INTO scheduled_tasks (id, account_id, workspace_id, name, schedule, temporal_schedule_id, execution_digest, agent_config, owner_subject_id, created_by_kind, created_by_subject_id, claude_provider_account_authority_snapshot)
        VALUES (${id}, ${a.account}, ${workspace}, 'Cutover task', '{}'::jsonb, ${`schedule-${id}`}, ${"0".repeat(64)}, ${admin.json({ model: MODEL })}, ${a.owner}, 'subject', ${a.owner}, ${admin.json(v1 as never)})`;
      await admin`update scheduled_tasks task set execution_digest = scheduled_task_execution_digest(task) where id = ${id}`;
      await admin`INSERT INTO scheduled_task_revision_authorities (task_id, task_authority_revision, account_id, workspace_id, subject_id, organization_membership_id, membership_authorization_revision, execution_digest)
        SELECT ${id}, task.authority_revision, ${a.account}, ${workspace}, ${a.owner}, ${a.om}, 1, task.execution_digest
        FROM scheduled_tasks task WHERE task.id = ${id}`;
    }

    // Organization A also runs Codex on the shared core.
    await admin`INSERT INTO workspace_memberships (account_id, workspace_id, subject_id, role)
      VALUES (${a.account}, ${a.w1}, ${a.owner}, 'owner')`;
    await admin`INSERT INTO subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, label)
      VALUES (${a.cx}, ${a.account}, 'codex', 'codex-ciphertext-a', 'shared', 'organization', 'Codex A')`;
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order,
        codex_primary_connection_id, version, updated_by_subject_id)
      VALUES (${a.account}, NULL, true, false, true, '{"codex":{"mode":"primary_first"}}'::jsonb,
          '{}'::jsonb, '{"codex":["claude"]}'::jsonb, ${a.cx}, 3, ${a.owner}),
        (${a.account}, ${a.w1}, NULL, NULL, NULL, '{"codex":{"mode":"spread"}}'::jsonb,
          '{"codex":{"inferenceSource":"organization"}}'::jsonb, NULL, NULL, 2, ${a.owner})`;
    for (const [s, t, provider] of [
      [a.s8, a.t8, "codex-subscription"],
      [a.s9, a.t9, PROVIDER],
    ] as const) {
      await session({
        id: s,
        account: a.account,
        workspace: a.w1,
        ownerSubject: a.owner,
        ownerMembership: a.om,
      });
      await turn({
        id: t,
        account: a.account,
        workspace: a.w1,
        session: s,
        status: "completed",
        position: 0,
        human: a.owner,
        v1: workspaceV1,
        provider,
      });
    }
    await admin`INSERT INTO claude_session_account_pins (account_id, workspace_id, session_id, authority_scope, owner_organization_membership_id, pinned_credential_id, pin_source, last_credential_id)
      VALUES (${a.account}, ${a.w1}, ${a.s8}, 'workspace', NULL, NULL, NULL, ${a.c1}),
             (${a.account}, ${a.w1}, ${a.s9}, 'workspace', NULL, NULL, NULL, ${a.c1})`;
    await admin`INSERT INTO subscription_session_bindings (account_id, workspace_id, session_id, provider, connection_id, model_id, choice, version)
      VALUES (${a.account}, ${a.w1}, ${a.s8}, 'codex', ${a.cx}, ${CODEX_MODEL}, 'explicit', 2),
             (${a.account}, ${a.w1}, ${a.s9}, 'codex', ${a.cx}, ${CODEX_MODEL}, 'automatic', 4)`;

    // Organization B: personal connections are not allowed.
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order)
      VALUES (${b.account}, NULL, false, false, false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
    await credential({
      id: b.y1,
      account: b.account,
      workspace: b.w1,
      scope: "user",
      accountUuid: randomUUID(),
      owner: b.membership,
      authority: b.authority,
      generation: 1,
    });
    await session({
      id: b.session,
      account: b.account,
      workspace: b.w1,
      ownerSubject: b.owner,
      ownerMembership: b.membership,
      visibility: "user_private",
    });
    await turn({
      id: b.turn,
      account: b.account,
      workspace: b.w1,
      session: b.session,
      status: "queued",
      position: 0,
      human: b.owner,
      v1: userV1(1),
    });

    // Organization D: rotation and providers locked on the organization row.
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order,
        locked_settings, version)
      VALUES (${d.account}, NULL, true, false, false, '{}'::jsonb,
          '{"claude":{"inferenceSource":"organization"}}'::jsonb, '{}'::jsonb,
          ARRAY['rotation', 'providers'], 5),
        (${d.account}, ${d.w1}, NULL, NULL, NULL, '{"codex":{"mode":"spread"}}'::jsonb,
          '{"codex":{"inferenceSource":"organization"}}'::jsonb, NULL, '{}', 2)`;
    await credential({
      id: d.z1,
      account: d.account,
      workspace: d.w1,
      scope: "workspace",
      accountUuid: randomUUID(),
    });
    await credential({
      id: d.z2,
      account: d.account,
      workspace: d.w2,
      scope: "workspace",
      accountUuid: "",
      oauth: false,
      column: `setup:${"c".repeat(64)}`,
    });
    await admin`INSERT INTO claude_rotation_settings (account_id, workspace_id, authority_scope, owner_organization_membership_id, active_credential_id, rotation_enabled, fairness_cursor)
      VALUES (${d.account}, ${d.w1}, 'workspace', NULL, ${d.z1}, false, 0)`;

    // Organization C: Codex core and SuperGrok legacy rows.
    await admin`INSERT INTO subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, label)
      VALUES (${c.codex}, ${c.account}, 'codex', 'codex-ciphertext', 'shared', 'organization', 'Codex C')`;
    await admin`INSERT INTO xai_subscription_credentials (id, account_id, workspace_id, credential_encrypted)
      VALUES (${c.xai}, ${c.account}, ${c.w1}, 'xai-ciphertext')`;
  });
}

async function snapshotUntouched() {
  const [row] = await owned.admin`SELECT
    (SELECT md5(string_agg(to_jsonb(connection)::text, ',' ORDER BY id)) FROM subscription_connections connection
      WHERE provider <> 'claude') AS core,
    (SELECT md5(string_agg(to_jsonb(credential)::text, ',' ORDER BY id)) FROM xai_subscription_credentials credential) AS xai,
    (SELECT md5(string_agg(to_jsonb(turn)::text, ',' ORDER BY id)) FROM session_turns turn) AS turns,
    (SELECT md5(string_agg(to_jsonb(task)::text, ',' ORDER BY id)) FROM scheduled_tasks task) AS tasks,
    (SELECT md5(string_agg(to_jsonb(connection)::text, ',' ORDER BY id)) FROM connections connection) AS model_connections,
    (SELECT md5(string_agg(to_jsonb(connection)::text, ',' ORDER BY id))
      FROM organization_model_provider_connections connection) AS organization_model_connections,
    (SELECT count(*)::int FROM host_export_outbox) AS facts,
    (SELECT md5(string_agg(to_jsonb(binding)::text, ',' ORDER BY workspace_id, session_id))
      FROM subscription_session_bindings binding
      WHERE provider <> 'claude' AND session_id <> ${a.s9}) AS bindings,
    (SELECT md5(string_agg((to_jsonb(setting) - 'rotation' - 'providers' - 'claude_primary_connection_id'
        - 'claude_primary_provider' - 'version' - 'updated_by_subject_id' - 'updated_at'
        || jsonb_build_object('rotation', setting.rotation - 'claude', 'providers', setting.providers - 'claude'))::text,
        ',' ORDER BY setting.account_id, setting.workspace_id NULLS FIRST))
      FROM subscription_settings setting
      WHERE (setting.account_id = ${a.account} AND (setting.workspace_id IS NULL OR setting.workspace_id = ${a.w1}))
        OR (setting.account_id = ${b.account} AND setting.workspace_id IS NULL)) AS settings`;
  return row!;
}

async function noPartialCutover() {
  const [state] = await owned.admin`SELECT
    (SELECT count(*)::int FROM subscription_connections WHERE provider = 'claude') AS connections,
    (SELECT count(*)::int FROM subscription_provider_cutovers WHERE provider = 'claude') AS cutovers,
    (SELECT count(*)::int FROM opengeni_private.subscription_core_providers WHERE provider = 'claude') AS registry,
    opengeni_private.subscription_provider_cutover_committed('claude') AS receipt,
    (SELECT count(*)::int FROM opengeni_private.subscription_cutover_report WHERE provider = 'claude') AS report,
    (SELECT count(*)::int FROM opengeni_private.subscription_authority_compat WHERE provider = 'claude') AS records,
    (SELECT count(*)::int FROM subscription_turn_failures WHERE provider = 'claude') AS failures,
    (SELECT count(*)::int FROM claude_subscription_credentials WHERE credential_encrypted = '') AS wiped,
    (SELECT count(*)::int FROM claude_capacity_waiters WHERE status = 'waiting') AS waiting,
    (SELECT count(*)::int FROM claude_credential_leases) AS leases,
    (SELECT count(*)::int FROM claude_subscription_account_usage) AS usage,
    (SELECT count(*)::int FROM schema_migrations WHERE name = ${MIGRATION}) AS ledger`;
  expect(state).toMatchObject({
    connections: 0,
    cutovers: 0,
    registry: 0,
    receipt: false,
    report: 0,
    records: 0,
    failures: 0,
    wiped: 0,
    waiting: 2,
    leases: 2,
    usage: 5,
    ledger: 0,
  });
  const forced = await owned.admin`SELECT relname FROM pg_class
    WHERE relname IN ('claude_subscription_credentials', 'claude_subscription_account_usage',
      'subscription_connections', 'subscription_turn_failures', 'session_turns', 'connections')
      AND relnamespace = 'public'::regnamespace AND NOT relforcerowsecurity`;
  expect(forced).toHaveLength(0);
  const [role] =
    await owned.admin`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${owned.ownerRole}`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
}

const migrateCutover = (options: { key?: Uint8Array } = {}) =>
  migrate(owned.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    ...(options.key ? { environmentsEncryptionKey: options.key } : {}),
  });

const SECRETS = ["sk-ant-", "refresh-", "Label ", "oauth:", "setup:", "v1:"];

async function abortMessage(): Promise<string> {
  const error = await migrateCutover({ key }).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  for (const leaked of SECRETS) expect(message).not.toContain(leaked);
  await noPartialCutover();
  return message;
}

/** Every message along an error's cause chain. */
function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
    messages.push(error.message);
    error = (error as { cause?: unknown }).cause;
  }
  return messages.join("\n");
}

describe.skipIf(!realDb)(
  "SUB-COMPAT-02 migration 0720: Claude onto the shared subscription core",
  () => {
    let before: Awaited<ReturnType<typeof snapshotUntouched>>;
    beforeAll(async () => {
      const fixture = await acquireOwnerMigratedTestDatabase("claude-core-cutover");
      if (!fixture) throw new Error("Real PostgreSQL required");
      owned = fixture;
      owner = postgres(owned.ownerUrl, { max: 1 });
      await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await owner`INSERT INTO schema_migrations(name) VALUES(${MIGRATION})`;
      await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
      await owner`DELETE FROM schema_migrations WHERE name = ${MIGRATION}`;
      await seed();
      before = await snapshotUntouched();
    }, 180_000);

    afterAll(async () => {
      await owner?.end();
      await owned?.release();
    }, 60_000);

    test("plain SQL cannot run the cutover without the codec stage", async () => {
      const source = await readFile(new URL(`../drizzle/${MIGRATION}`, import.meta.url), "utf8");
      await expect(Promise.resolve(owner.unsafe(source))).rejects.toMatchObject({ code: "55000" });
      await noPartialCutover();
    }, 180_000);

    test("the drain check refuses even an idle application connection", async () => {
      const url = new URL(owned.ownerUrl);
      url.username = "opengeni_app";
      url.password = owned.appPassword;
      await provisionRoles(owned.adminUrl, {
        appRole: "opengeni_app",
        appPassword: owned.appPassword,
      });
      const app = postgres(url.toString(), { max: 1 });
      try {
        await app`SELECT 1`;
        await expect(migrateCutover({ key })).rejects.toMatchObject({ code: "55000" });
      } finally {
        await app.end();
      }
      await noPartialCutover();
    }, 180_000);

    test("an isolation level other than READ COMMITTED is refused before any write", async () => {
      const ownerName = new URL(owned.ownerUrl).username;
      await owned.admin.unsafe(
        `ALTER ROLE "${ownerName}" SET default_transaction_isolation = 'repeatable read'`,
      );
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect(error).toMatchObject({ code: "55000" });
        expect(errorChain(error)).toContain("0720 requires READ COMMITTED");
      } finally {
        await owned.admin.unsafe(`ALTER ROLE "${ownerName}" RESET default_transaction_isolation`);
      }
      await noPartialCutover();
    }, 180_000);

    test("a missing or wrong key rolls everything back without leaking material", async () => {
      await expect(migrateCutover()).rejects.toThrow(
        "requires the existing environments encryption key",
      );
      await noPartialCutover();
      const wrong = await migrateCutover({ key: Buffer.alloc(32, 9) }).catch(
        (error: Error) => error,
      );
      expect((wrong as Error).message).toBe(
        "Claude subscription cutover could not decode a legacy credential (credential_undecodable); see the runbook",
      );
      await noPartialCutover();
    }, 180_000);

    test("a failed core write leaves no secret, label or identity in the error", async () => {
      await owned.admin`ALTER TABLE subscription_connections
        ADD CONSTRAINT claude_cutover_forced_failure CHECK (provider <> 'claude') NOT VALID`;
      try {
        const failed = await migrateCutover({ key }).catch((error: unknown) => error);
        const error = failed as Error & Record<string, unknown>;
        expect(error.message).toBe(
          "Claude subscription cutover could not write the shared core (SQLSTATE 23514, claude_cutover_forced_failure); see the runbook",
        );
        const everything = [
          error.message,
          String(error.stack),
          JSON.stringify(error),
          ...Object.getOwnPropertyNames(error).map((name) => {
            try {
              return JSON.stringify(error[name]) ?? "";
            } catch {
              return String(error[name]);
            }
          }),
          String((error as { cause?: unknown }).cause ?? ""),
        ].join("\n");
        for (const leaked of SECRETS) expect(everything).not.toContain(leaked);
        expect((error as { parameters?: unknown }).parameters).toBeUndefined();
      } finally {
        await owned.admin`ALTER TABLE subscription_connections DROP CONSTRAINT claude_cutover_forced_failure`;
      }
      await noPartialCutover();
    }, 180_000);

    test("a stored account id that contradicts the token aborts before any mutation", async () => {
      const extra = randomUUID();
      await withSeedTriggersOff(() =>
        credential({
          id: extra,
          account: c.account,
          workspace: c.w1,
          scope: "workspace",
          accountUuid: randomUUID(),
          column: randomUUID(),
        }),
      );
      try {
        expect(await abortMessage()).toContain("provider_identity_mismatch");
      } finally {
        await owned.admin`DELETE FROM claude_subscription_credentials WHERE id = ${extra}`;
      }
    }, 180_000);

    test("a legacy model connection that is not revoked aborts activation", async () => {
      for (const statement of [
        owned.admin`UPDATE connections SET status = 'active' WHERE id = ${a.revokedConnection}`,
        owned.admin`UPDATE organization_model_provider_connections SET credential_encrypted = 'left-behind'
          WHERE id = ${a.revokedOrganizationConnection}`,
      ]) {
        await withSeedTriggersOff(() => statement.then(() => undefined));
        try {
          expect(await abortMessage()).toContain("legacy_connection_not_revoked");
        } finally {
          await withSeedTriggersOff(async () => {
            await owned.admin`UPDATE connections SET status = 'revoked' WHERE id = ${a.revokedConnection}`;
            await owned.admin`UPDATE organization_model_provider_connections SET credential_encrypted = ''
              WHERE id = ${a.revokedOrganizationConnection}`;
          });
        }
      }
    }, 180_000);

    test("a parity mismatch rolls the activation back", async () => {
      // A rule silently drops the converted receipts, which only parity sees.
      await owned.admin`CREATE RULE claude_cutover_parity_probe AS ON INSERT TO subscription_turn_failures DO INSTEAD NOTHING`;
      try {
        expect(await abortMessage()).toContain("0720 parity mismatch (auth_recovery_live_turns)");
      } finally {
        await owned.admin`DROP RULE claude_cutover_parity_probe ON subscription_turn_failures`;
      }
    }, 180_000);

    test("a waiter of another workflow aborts activation", async () => {
      await owned.admin`UPDATE claude_capacity_waiters SET workflow_id = 'session-elsewhere' WHERE id = ${a.waiter}`;
      try {
        expect(await abortMessage()).toContain("waiter_workflow_mismatch");
      } finally {
        await owned.admin`UPDATE claude_capacity_waiters SET workflow_id = ${`session-${a.s1}`} WHERE id = ${a.waiter}`;
      }
    }, 180_000);

    test("a turn leased on both runtimes aborts activation", async () => {
      await withSeedTriggersOff(() =>
        owned.admin`INSERT INTO subscription_leases (account_id, workspace_id, session_id,
            turn_id, connection_id, provider, holder_id, generation, leased_until)
          VALUES (${a.account}, ${a.w1}, ${a.s2}, ${a.t2}, ${a.cx}, 'codex', 'attempt-both', 1,
            now() + interval '10 minutes')`.then(() => undefined),
      );
      try {
        expect(await abortMessage()).toContain("lease_conflict");
      } finally {
        await owned.admin`DELETE FROM subscription_leases WHERE turn_id = ${a.t2}`;
      }
    }, 180_000);

    test("pre-existing core Claude state is refused", async () => {
      const [row] = await owned.admin<{ id: string }[]>`INSERT INTO subscription_connections
        (account_id, provider, credential_encrypted, ownership, scope_kind)
        VALUES (${c.account}, 'claude', 'x', 'shared', 'organization') RETURNING id::text`;
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect((error as Error).message).toContain("refuses pre-existing core Claude state");
      } finally {
        await owned.admin`DELETE FROM subscription_connections WHERE id = ${row!.id}`;
      }
      await noPartialCutover();
    }, 180_000);

    describe("after the cutover commits", () => {
      let client: DbClient;
      beforeAll(async () => {
        await migrateCutover({ key });
        await provisionRoles(owned.adminUrl, {
          appRole: "opengeni_app",
          appPassword: owned.appPassword,
        });
        const url = new URL(owned.ownerUrl);
        url.username = "opengeni_app";
        url.password = owned.appPassword;
        client = createDb(url.toString(), { max: 4 });
      }, 180_000);
      afterAll(async () => {
        await client?.close();
      });

      test("connections: one per Claude login and owner, OAuth and setup tokens never merged, one readable secret copy", async () => {
        const rows = await owned.admin`SELECT id::text, provider_account_id, provider_subject_id,
            status, ownership, scope_kind, allow_personal_workspaces, allowed_model_ids, version,
            refresh_generation, credential_encrypted, credential_format,
            owner_organization_membership_id::text AS owner
          FROM subscription_connections WHERE provider = 'claude' AND account_id <> ${d.account} ORDER BY id`;
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(rows).toHaveLength(10);
        expect(byId.has(a.c2)).toBe(false);
        expect(byId.has(a.c7)).toBe(false);
        expect(byId.get(a.c1)).toMatchObject({
          provider_account_id: a.u1,
          provider_subject_id: a.u1,
          status: "active",
          ownership: "shared",
          scope_kind: "workspaces",
          version: 4,
          refresh_generation: "4",
          credential_format: "claude_oauth_v1",
        });
        // The setup token stored under the same account stays its own
        // connection (a setup token reports no person).
        expect(byId.get(a.c10)).toMatchObject({
          provider_account_id: a.u1,
          credential_format: "claude_setup_token_v1",
        });
        expect(byId.get(a.c10)!.provider_subject_id).not.toBe(a.u1);
        // HMAC ids are their own person key.
        expect(byId.get(a.c3)).toMatchObject({
          provider_account_id: `setup:${"a".repeat(64)}`,
          provider_subject_id: `setup:${"a".repeat(64)}`,
          scope_kind: "organization",
          credential_format: "claude_setup_token_v1",
        });
        expect(byId.get(a.c11)).toMatchObject({
          provider_account_id: `oauth:${"b".repeat(64)}`,
          credential_format: "claude_oauth_v1",
        });
        expect(byId.get(a.c4)).toMatchObject({
          scope_kind: "workspaces",
          allowed_model_ids: [MODEL],
        });
        for (const id of [a.c5, a.c6]) {
          expect(byId.get(id)).toMatchObject({
            ownership: "personal",
            scope_kind: "people",
            owner: a.om,
          });
        }
        expect(byId.get(a.c8)).toMatchObject({ ownership: "personal", owner: a.bm });
        expect(byId.get(b.y1)).toMatchObject({ ownership: "personal", owner: b.membership });
        expect(byId.get(a.c9)).toMatchObject({
          provider_account_id: null,
          credential_format: "claude_setup_token_v1",
        });
        // The canonical secret is the legacy object unchanged.
        const oauth = decodeSubscriptionCoreClaudeCredential(
          decryptEnvironmentValue(key, byId.get(a.c1)!.credential_encrypted),
        );
        const expected = secret(a.c1, a.u1, true);
        expect(oauth).toMatchObject({
          version: 1,
          token: expected.token,
          identity: expected.identity,
          oauth: { refreshToken: expected.oauth!.refreshToken, scopes: expected.oauth!.scopes },
        });
        const setup = decodeSubscriptionCoreClaudeCredential(
          decryptEnvironmentValue(key, byId.get(a.c3)!.credential_encrypted),
        );
        expect(setup.oauth).toBeUndefined();
        const aliases =
          await owned.admin`SELECT alias_connection_id::text AS alias, connection_id::text AS target
          FROM subscription_connection_aliases WHERE provider = 'claude' ORDER BY alias`;
        expect(new Map(aliases.map((row) => [row.alias, row.target]))).toEqual(
          new Map([
            [a.c2, a.c1],
            [a.c7, a.c6],
          ]),
        );
        const [legacy] = await owned.admin`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE credential_encrypted = '')::int AS blank
          FROM claude_subscription_credentials`;
        expect(legacy).toEqual({ total: 14, blank: 14 });
      });

      test("usage: current readings, re-keyed cooldowns of every member, legacy exhaustion, unknown otherwise", async () => {
        const rows = await owned.admin`SELECT connection_id::text AS id, quota,
            observed_refresh_generation, selection_count::int AS selection_count
          FROM subscription_connection_quota
          WHERE connection_id IN (${a.c1}, ${a.c3}, ${a.c9}, ${a.c11}, ${a.c4}, ${a.c5})`;
        const quota = new Map(rows.map((row) => [row.id, row]));
        const c1 = quota.get(a.c1)!;
        expect(c1.selection_count).toBe(8);
        expect(Number(c1.observed_refresh_generation)).toBe(4);
        expect(c1.quota.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 42 });
        const cooldowns = c1.quota.modelCooldowns as Record<string, number>;
        // Its own Opus cooldown and the alias's live Sonnet cooldown, on both
        // product ids; the ended Haiku cooldown is gone.
        for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
          for (const prefix of [
            "organization-claude-subscription",
            "workspace-claude-subscription",
          ])
            expect(cooldowns[`${prefix}/${model}`]).toBeGreaterThan(Date.now() + HOUR);
        }
        expect(Object.keys(cooldowns).some((model) => model.endsWith("claude-haiku-5-5"))).toBe(
          false,
        );
        // The resting setup token keeps resting as a quota exhaustion.
        expect(quota.get(a.c3)!.quota).toMatchObject({ exhaustedKind: "quota", windows: [] });
        expect(quota.get(a.c3)!.quota.exhaustedUntil).toBeGreaterThan(Date.now());
        // A stale usage row is not read: only the legacy exhaustion moves.
        expect(quota.get(a.c9)!.quota.windows).toEqual([]);
        expect(quota.get(a.c9)!.quota.modelCooldowns).toEqual({});
        expect(quota.get(a.c9)!.quota.exhaustedKind).toBe("quota");
        // An unreadable current usage row and no usage at all are unknown.
        for (const id of [a.c11, a.c4]) {
          expect(quota.get(id)?.observed_refresh_generation ?? null).toBeNull();
        }
        // A pending reconnect stays a quota fact; the status is unchanged.
        expect(quota.get(a.c5)!.quota).toMatchObject({ refreshStatus: "reconnect" });
        expect(Number(quota.get(a.c5)!.observed_refresh_generation)).toBe(4);
        const [c5] = await owned.admin`SELECT status FROM subscription_connections
          WHERE id = ${a.c5}`;
        expect(c5!.status).toBe("active");
      });

      test("generations: one owner with `user` credentials in two workspaces and a Personal one has one current generation", async () => {
        const rows =
          await owned.admin`SELECT connection.owner_organization_membership_id::text AS owner,
            array_agg(DISTINCT connection.authority_generation) AS generations,
            bool_and(authority.status = 'active' AND authority.generation = connection.authority_generation
              AND authority.resource_kind = 'subscription_connection') AS verified
          FROM subscription_connections connection
          JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
          WHERE connection.provider = 'claude' AND connection.ownership = 'personal'
          GROUP BY connection.owner_organization_membership_id`;
        const byOwner = new Map(rows.map((row) => [row.owner, row]));
        expect(byOwner.get(a.om)!.generations).toHaveLength(1);
        expect(byOwner.get(a.om)!.verified).toBe(true);
        expect(byOwner.get(a.bm)!.generations).toHaveLength(1);
        const legacy = await owned.admin`SELECT status FROM organization_user_resource_authorities
          WHERE resource_kind = 'claude_subscription'`;
        expect(legacy).toHaveLength(4);
        expect(legacy.every((row) => row.status === "active")).toBe(true);
      });

      test("pools and settings: organization rows, local pools frozen on the workspace source", async () => {
        const policies =
          await owned.admin`SELECT connection_id::text AS id, workspace_id::text AS workspace,
            inference_pool, allowed_model_ids, managed_by_workspace_id::text AS manager
          FROM subscription_connection_assignment_policies
          WHERE account_id = ${a.account} AND connection_id IN (${a.c1}, ${a.c4})`;
        expect(policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: a.c1, workspace: a.w1, manager: a.w1 }),
            expect.objectContaining({
              id: a.c1,
              workspace: a.w2,
              manager: a.w2,
              allowed_model_ids: [MODEL],
            }),
            expect.objectContaining({ id: a.c4, workspace: a.w2, inference_pool: "organization" }),
          ]),
        );
        const settings =
          await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
            claude_primary_connection_id::text AS primary, codex_primary_connection_id::text AS codex
          FROM subscription_settings WHERE account_id = ${a.account}`;
        const byWorkspace = new Map(settings.map((row) => [row.workspace, row]));
        expect(byWorkspace.get(null)).toMatchObject({
          rotation: { codex: { mode: "primary_first" }, claude: { mode: "primary_first" } },
          primary: a.c3,
          codex: a.cx,
        });
        expect(byWorkspace.get(a.w1)).toMatchObject({
          rotation: { codex: { mode: "spread" }, claude: { mode: "primary_first" } },
          providers: {
            codex: { inferenceSource: "organization" },
            claude: { inferenceSource: "workspace", useOrganizationAccounts: false },
          },
          primary: a.c1,
        });
        expect(byWorkspace.get(a.w3)!.providers.claude.inferenceSource).toBe("workspace");
        const [orgB] =
          await owned.admin`SELECT personal_connections_allowed FROM subscription_settings
          WHERE account_id = ${b.account} AND workspace_id IS NULL`;
        expect(orgB!.personal_connections_allowed).toBe(false);
      });

      test("an organization that locks rotation and providers keeps its workspaces on the locked values, each listed", async () => {
        const settings =
          await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
            claude_primary_connection_id::text AS primary, version::int AS version,
            updated_by_subject_id AS writer
          FROM subscription_settings WHERE account_id = ${d.account} ORDER BY workspace_id NULLS FIRST`;
        const byWorkspace = new Map(settings.map((row) => [row.workspace, row]));
        expect(byWorkspace.get(d.w1)).toEqual({
          workspace: d.w1,
          rotation: { codex: { mode: "spread" } },
          providers: { codex: { inferenceSource: "organization" } },
          primary: null,
          version: 2,
          writer: null,
        });
        expect(byWorkspace.has(d.w2)).toBe(false);
        for (const workspace of [d.w1, d.w2]) {
          const [effective] = await owned.admin`SELECT
              subscription_effective_settings(${d.account}::uuid, ${workspace}::uuid) AS value`;
          expect(effective!.value.sources.providers.claude).toBe("organization");
          expect(effective!.value.sources.rotation.claude).toBe("organization");
        }
        const [moved] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections
          WHERE account_id = ${d.account} AND provider = 'claude' AND ownership = 'shared'`;
        expect(moved!.total).toBe(2);
        const report =
          await owned.admin`SELECT metric, legacy_count::int AS legacy, core_count::int AS core
          FROM opengeni_private.subscription_cutover_report
          WHERE provider = 'claude' AND account_id = ${d.account}`;
        expect(report.filter((row) => row.legacy !== row.core)).toEqual([]);
        expect(
          report
            .map((row) => row.metric)
            .filter((metric) => metric.includes("_locked:"))
            .sort(),
        ).toEqual(
          [
            `disposition:local_pool_freeze_locked:${d.w1}`,
            `disposition:local_pool_freeze_locked:${d.w2}`,
            `disposition:local_rotation_locked:${d.w1}`,
            `disposition:local_rotation_locked:${d.w2}`,
          ].sort(),
        );
      });

      test("pins become bindings through aliases; an ineligible pin is a disposition", async () => {
        const bindings =
          await owned.admin`SELECT session_id::text AS session, connection_id::text AS connection,
            choice, model_id FROM subscription_session_bindings WHERE provider = 'claude'`;
        const bySession = new Map(bindings.map((row) => [row.session, row]));
        expect(bySession.get(a.s1)).toMatchObject({
          connection: a.c1,
          choice: "explicit",
          model_id: MODEL,
        });
        expect(bySession.get(a.s2)).toMatchObject({ connection: a.c6, choice: "automatic" });
        expect(bySession.get(a.s3)).toMatchObject({ connection: a.c5 });
        expect(bySession.get(a.s4)).toMatchObject({ connection: a.c8 });
        expect(bySession.has(a.s6)).toBe(false);
        expect(bySession.get(a.s9)).toMatchObject({ connection: a.c1, choice: "automatic" });
        expect(bySession.has(a.s8)).toBe(false);
      });

      test("live leases and waiters keep their fences, ids and pending wakes", async () => {
        const leases =
          await owned.admin`SELECT turn_id::text AS turn, connection_id::text AS connection,
            holder_id, generation::int AS generation FROM subscription_leases WHERE provider = 'claude'`;
        expect([...leases]).toEqual([
          { turn: a.t2, connection: a.c6, holder_id: "attempt-t2", generation: 2 },
        ]);
        const waiters =
          await owned.admin`SELECT waiter_id::text AS id, turn_id::text AS turn, generation::int AS generation,
            wake_revision::int AS wake_revision, observed_wake_revision::int AS observed,
            blocked_turn_generation::int AS blocked, goal_id::text AS goal,
            goal_version::int AS goal_version, last_wake_reason
          FROM subscription_capacity_waiters WHERE provider = 'claude'`;
        expect([...waiters]).toEqual([
          {
            id: a.waiter,
            turn: a.t1,
            generation: 3,
            wake_revision: 5,
            observed: 4,
            blocked: 2,
            goal: a.goal,
            goal_version: 3,
            last_wake_reason: "usage_refreshed",
          },
        ]);
        const wakes = await owned.admin`SELECT waiter_id::text AS id, generation::int AS generation,
            wake_revision::int AS wake_revision
          FROM subscription_capacity_wake_outbox WHERE account_id = ${a.account}`;
        expect([...wakes]).toEqual([{ id: a.waiter, generation: 3, wake_revision: 5 }]);
        const legacy = await owned.admin`SELECT status FROM claude_capacity_waiters`;
        expect(legacy.every((row) => row.status === "superseded")).toBe(true);
        const [legacyLeases] =
          await owned.admin`SELECT count(*)::int AS total FROM claude_credential_leases`;
        expect(legacyLeases!.total).toBe(0);
      });

      test("authentication recovery: each live value is a turn-failure receipt; history stays", async () => {
        const receipts = await owned.admin`SELECT turn_id::text AS turn,
            connection_id::text AS connection, failure_kind, recovery_evidence
          FROM subscription_turn_failures WHERE provider = 'claude'`;
        expect([...receipts]).toEqual([
          {
            turn: a.t2,
            connection: a.c6,
            failure_kind: "unauthorized",
            recovery_evidence: { refreshGeneration: 4, refusals: 0 },
          },
        ]);
        const after = await snapshotUntouched();
        expect(after.turns).toBe(before.turns);
      });

      test("accepted authority: one record per carrier with exact personal entries", async () => {
        const records = await owned.admin`SELECT carrier_kind,
            coalesce(turn_id, session_id, scheduled_task_id, system_update_id, outbox_id)::text AS carrier,
            personal, shared_pool, legacy_scope
          FROM opengeni_private.subscription_authority_compat WHERE provider = 'claude'`;
        const by = new Map(records.map((row) => [`${row.carrier_kind}:${row.carrier}`, row]));
        const [generation] =
          await owned.admin`SELECT authority_generation FROM subscription_connections WHERE id = ${a.c6}`;
        const g = Number(generation!.authority_generation);
        expect(by.get(`session_turn:${a.t2}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.c6] }],
          shared_pool: "none",
          legacy_scope: "user",
        });
        expect(by.get(`session_turn:${a.t3}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.c5] }],
        });
        expect(by.get(`session_initial:${a.s5}`)).toMatchObject({ shared_pool: "organization" });
        expect(by.get(`scheduled_task:${a.taskUser}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.c6] }],
        });
        expect(by.has(`session_system_update_outbox:${a.outbox}`)).toBe(true);
        expect(by.get(`session_turn:${b.turn}`)).toMatchObject({
          personal: [],
          shared_pool: "none",
        });
      });

      test("the parity report has every metric equal, with Claude dispositions", async () => {
        const report =
          await owned.admin`SELECT metric, account_id::text AS account, legacy_count::int AS legacy,
            core_count::int AS core FROM opengeni_private.subscription_cutover_report WHERE provider = 'claude'`;
        expect(report.filter((row) => row.legacy !== row.core)).toEqual([]);
        const metric = (name: string, account = a.account) =>
          report.find((row) => row.metric === name && row.account === account);
        expect(metric("credentials")).toMatchObject({ legacy: 11 });
        expect(metric("aliases")).toMatchObject({ legacy: 2 });
        expect(metric("live_leases")).toMatchObject({ legacy: 1 });
        expect(metric("waiting_waiters")).toMatchObject({ legacy: 2 });
        expect(metric("auth_recovery_live_turns")).toMatchObject({ legacy: 5 });
        // c1's and c5's current readings and c11's unreadable current row
        // (unknown, listed).
        expect(metric("usage_generations")).toMatchObject({ legacy: 3 });
        expect(metric("model_cooldowns")).toMatchObject({ legacy: 2 });
        expect(metric("compat:dependent_sources_without_record")).toMatchObject({
          legacy: 0,
          core: 0,
        });
        expect(metric("disposition:auth_recovery_unmapped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:auth_recovery_malformed")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:auth_recovery_not_current")).toMatchObject({ legacy: 2 });
        expect(metric("disposition:usage_rows_stale")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:usage_snapshot_unreadable")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:usage_reconnect_pending")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:person_identity_unknown_kept_separate")).toBeDefined();
        expect(metric("disposition:waiters_collapsed")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:pin_owner_ineligible")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:personal_connections_disallowed", b.account)).toMatchObject({
          legacy: 1,
        });
        const [others] =
          await owned.admin`SELECT count(*)::int AS total FROM opengeni_private.subscription_cutover_report
          WHERE provider NOT IN ('claude', 'codex', 'xai')`;
        expect(others!.total).toBe(0);
      });

      test("activation: receipt, registry, switch rows, FORCE restored, others untouched", async () => {
        const [state] = await owned.admin`SELECT
            opengeni_private.subscription_provider_cutover_committed('claude') AS committed,
            (SELECT primary_setting_column FROM opengeni_private.subscription_core_providers WHERE provider = 'claude') AS primary_column,
            (SELECT count(*)::int FROM subscription_provider_cutovers WHERE provider = 'claude' AND enabled) AS enabled,
            (SELECT count(*)::int FROM managed_accounts) AS accounts`;
        expect(state).toMatchObject({
          committed: true,
          primary_column: "claude_primary_connection_id",
        });
        expect(state!.enabled).toBe(state!.accounts);
        const relaxed = await owned.admin`SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity
            AND NOT relforcerowsecurity
            AND (relname LIKE 'subscription_%' OR relname LIKE 'claude_%' OR relname IN (
              'sessions', 'session_turns', 'scheduled_tasks', 'connections',
              'organization_model_provider_connections'))`;
        expect(relaxed).toHaveLength(0);
        const after = await snapshotUntouched();
        expect(after.facts).toBe(before.facts);
        expect(after.core).toBe(before.core);
        expect(after.xai).toBe(before.xai);
        expect(after.bindings).toBe(before.bindings);
        expect(after.settings).toBe(before.settings);
        expect(after.tasks).toBe(before.tasks);
        // The revoked legacy model connections stay as they were.
        expect(after.model_connections).toBe(before.model_connections);
        expect(after.organization_model_connections).toBe(before.organization_model_connections);
      });

      test("retrying the ledger is a no-op without the key", async () => {
        await migrateCutover();
        const [count] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections
            WHERE provider = 'claude' AND account_id <> ${d.account}`;
        expect(count!.total).toBe(10);
      }, 180_000);

      test("provisioning withdraws runtime writes on the legacy tables and the posture contract holds", async () => {
        const privileges =
          await owned.admin`SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS granted
          FROM information_schema.role_table_grants
          WHERE grantee = 'opengeni_app' AND table_name = ANY(${[...SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES.claude!]})
          GROUP BY table_name`;
        expect(privileges).toHaveLength(6);
        for (const row of privileges) expect(row.granted).toEqual(["SELECT"]);
        const [role] =
          await owned.admin`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'opengeni_app'`;
        expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
        const options = {
          rlsStrategy: "force" as const,
          expectedRole: "opengeni_app",
          targetSchema: "public",
        };
        const posture = await inspectRuntimeDatabasePosture(client.db, options);
        expect(posture.subscriptionProviderCutoverReceipts).toEqual(["claude", "codex", "xai"]);
        expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      }, 180_000);

      test("no definer can write a legacy Claude row after the receipt", async () => {
        const asOwner = (statement: string) =>
          owner
            .begin(async (tx) => {
              await tx`SELECT set_config('opengeni.account_id', ${a.account}, true),
                set_config('opengeni.workspace_id', ${a.w1}, true)`;
              await tx.unsafe(statement);
            })
            .then(
              () => "written",
              (error: Error) => error.message,
            );
        expect(
          await asOwner(
            `UPDATE claude_subscription_credentials SET label = 'Renamed' WHERE id = '${a.c1}'`,
          ),
        ).toContain("claude_subscription_credentials_closed_update");
        expect(
          await asOwner(
            `UPDATE claude_subscription_account_usage SET model_cooldowns = '{}' WHERE credential_id = '${a.c1}'`,
          ),
        ).toContain("claude_subscription_account_usage_closed_update");
        // Row security is checked before constraints, so re-inserting an
        // existing row reaches the restrictive insert policy first.
        expect(
          await asOwner(
            `INSERT INTO claude_subscription_credentials
             SELECT * FROM claude_subscription_credentials WHERE id = '${a.c1}'`,
          ),
        ).toContain("claude_subscription_credentials_closed_insert");
        // Write-only restrictive policies: a restrictive policy covering SELECT
        // would be a restrictive read policy, which the lifecycle-facts
        // backfill (0565) refuses for its source tables.
        const closedPolicies = await owned.admin<{ policyname: string; cmd: string }[]>`
          SELECT policyname, cmd FROM pg_policies
          WHERE tablename LIKE 'claude\_%' AND policyname LIKE '%\_closed%'
          ORDER BY policyname`;
        expect(closedPolicies.length).toBe(12);
        expect(closedPolicies.every(({ cmd }) => cmd === "INSERT" || cmd === "UPDATE")).toBe(true);
        // No role adds a legacy Claude personal authority after the receipt.
        const [closed] = await owned.admin`SELECT permissive, cmd, with_check
          FROM pg_policies WHERE tablename = 'organization_user_resource_authorities'
            AND policyname = 'claude_subscription_authority_closed'`;
        expect(closed).toMatchObject({ permissive: "RESTRICTIVE", cmd: "INSERT" });
        expect(closed!.with_check).toContain("subscription_provider_cutover_committed('claude'");
      }, 60_000);

      test("the legacy disconnect refuses after the receipt and changes nothing", async () => {
        const disconnect = await withSessionRlsActorContext({ subjectId: a.owner }, () =>
          withRlsContext(client.db, { accountId: a.account, workspaceId: a.w1 }, (tx) =>
            rawRows(
              tx,
              sql`select disconnect_claude_subscription_credential(${a.account}::uuid, ${a.w1}::uuid,
                ${a.owner}, ${a.c1}::uuid, '{"version":1,"scope":"workspace"}'::jsonb) as disconnected`,
            ),
          ),
        ).then(
          () => "disconnected",
          (error: unknown) => errorChain(error),
        );
        expect(disconnect).toContain(
          "Claude accounts are disconnected on the shared subscription core after the cutover",
        );
        const [state] = await owned.admin`SELECT
            (SELECT count(*)::int FROM claude_subscription_credentials WHERE id = ${a.c1}) AS legacy,
            (SELECT status FROM subscription_connections WHERE id = ${a.c1}) AS core`;
        expect(state).toEqual({ legacy: 1, core: "active" });
      }, 60_000);

      test("new work accepted after the cutover carries the owner's current Claude generation", async () => {
        const [generation] =
          await owned.admin`SELECT authority_generation FROM subscription_connections WHERE id = ${a.c6}`;
        const g = Number(generation!.authority_generation);
        const acceptance = (workspaceId: string, sessionId: string) =>
          withSessionRlsActorContext({ subjectId: a.owner }, () =>
            withRlsContext(client.db, { accountId: a.account, workspaceId }, async (tx) => {
              const [row] = await rawRows<{ v2: unknown }>(
                tx,
                sql`select opengeni_private.subscription_core_acceptance_authority_v2('claude',
                  ${a.account}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${a.owner}) as v2`,
              );
              return row!.v2;
            }),
          );
        const personal = [{ provider: "claude", ownerMembershipId: a.om, authorityGeneration: g }];
        expect(await acceptance(a.w1, a.s2)).toMatchObject({ version: 2, personal });
        expect(await acceptance(a.pa, a.s3)).toMatchObject({ version: 2, personal });
      }, 60_000);

      test("a Steer or Cancel ends a migrated Claude wait through the provider-neutral cleanup", async () => {
        const deleted = await withRlsContext(
          client.db,
          { accountId: a.account, workspaceId: a.w2 },
          (tx) =>
            deleteSubscriptionCoreWaitersForTurns(tx, null, {
              workspaceId: a.w2,
              turnIds: [a.t1],
            }),
        );
        expect(deleted).toBe(1);
        const [left] = await owned.admin`SELECT
            (SELECT count(*)::int FROM subscription_capacity_waiters WHERE provider = 'claude') AS waiters,
            (SELECT count(*)::int FROM subscription_capacity_wake_outbox WHERE account_id = ${a.account}) AS wakes`;
        expect(left).toEqual({ waiters: 0, wakes: 0 });
      }, 60_000);

      test("the owner can still delete a legacy Claude row after the receipt", async () => {
        const deleted = await owner.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.account_id', ${a.account}, true),
            set_config('opengeni.workspace_id', ${a.w3}, true)`;
          return await tx`DELETE FROM claude_subscription_credentials WHERE id = ${a.c10} RETURNING id`;
        });
        expect(deleted).toHaveLength(1);
      }, 60_000);

      // A partial Claude reading must not end a block before its reset. The
      // migrated connection c1 (generation 4) is read through the registered
      // Claude binding as the runtime reads it after the receipt.
      const claudeQuotaScope = () => ({
        kind: "workspace" as const,
        accountId: a.account,
        workspaceId: a.w1,
        subjectId: a.owner,
      });
      const claudeReading = (
        source: "response_headers" | "usage_endpoint",
        at: number,
        windows: {
          id: string;
          usedPercent: number;
          resetsAt: number;
          status: "ok" | "exhausted";
        }[],
      ) => ({
        windows,
        modelCooldowns: {},
        exhaustedUntil: null,
        exhaustedKind: null,
        revision: 0,
        observedAt: at,
        observedRefreshGeneration: 4,
        source,
      });
      const recordClaudeReading = (reading: ReturnType<typeof claudeReading>) =>
        subscriptionCoreOperations(
          subscriptionCoreProvider("claude"),
        ).recordSubscriptionCoreUsageObservation(client.db, claudeQuotaScope(), a.c1, reading);
      const weeklyObservedAt = Date.now();
      const weeklyReset = weeklyObservedAt + 2 * HOUR;
      const migratedC1Windows = async () => {
        const [row] = await owned.admin`SELECT quota FROM subscription_connection_quota
          WHERE connection_id = ${a.c1}`;
        return row!.quota.windows as { id: string; status: string; resetsAt: number }[];
      };

      test("a newer Claude response-header reading that omits a still-exhausted window keeps it until its reset", async () => {
        expect(
          await recordClaudeReading(
            claudeReading("response_headers", weeklyObservedAt, [
              { id: "five_hour", usedPercent: 40, resetsAt: weeklyObservedAt + HOUR, status: "ok" },
              { id: "seven_day", usedPercent: 100, resetsAt: weeklyReset, status: "exhausted" },
            ]),
          ),
        ).toMatchObject({ applied: true });
        expect(
          await recordClaudeReading(
            claudeReading("response_headers", weeklyObservedAt + 1_000, [
              { id: "five_hour", usedPercent: 41, resetsAt: weeklyObservedAt + HOUR, status: "ok" },
            ]),
          ),
        ).toMatchObject({ applied: true });
        expect(await migratedC1Windows()).toContainEqual(
          expect.objectContaining({ id: "seven_day", status: "exhausted", resetsAt: weeklyReset }),
        );
      }, 60_000);

      // Registering Claude also relies on its adapter declaring its usage
      // readings incomplete: a Claude usage reading can omit a window that is
      // still exhausted. That declaration is C2a's (#4130,
      // `usageReadingsComplete: false`); this case stays red until C2a is in
      // the base, so C3 cannot pass its validation, or merge, ahead of it.
      test("a newer Claude usage reading that omits a still-exhausted window keeps it until its reset", async () => {
        // Self-contained: record the exhausted weekly window here rather than
        // relying on the response-header case above.
        expect(
          await recordClaudeReading(
            claudeReading("response_headers", weeklyObservedAt + 1_500, [
              { id: "five_hour", usedPercent: 41, resetsAt: weeklyObservedAt + HOUR, status: "ok" },
              { id: "seven_day", usedPercent: 100, resetsAt: weeklyReset, status: "exhausted" },
            ]),
          ),
        ).toMatchObject({ applied: true });
        await recordClaudeReading(
          claudeReading("usage_endpoint", weeklyObservedAt + 2_000, [
            { id: "five_hour", usedPercent: 42, resetsAt: weeklyObservedAt + HOUR, status: "ok" },
          ]),
        );
        expect(await migratedC1Windows()).toContainEqual(
          expect.objectContaining({
            id: "seven_day",
            status: "exhausted",
            resetsAt: weeklyReset,
          }),
        );
      }, 60_000);
    });
  },
);
