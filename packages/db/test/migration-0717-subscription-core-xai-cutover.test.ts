/**
 * Migration 0717: the drained, one-way SuperGrok cutover onto the shared
 * subscription core (design 5.3 "Data mapping", "Accepted authority across
 * the cutover", "Personal authority generations", "Cutover protocol"). The
 * legacy state is seeded as the database superuser (an upgrade fixture, not
 * current admission), the migration runs as the NOSUPERUSER/NOBYPASSRLS
 * schema owner exactly as in production, and runtime behaviour afterward is
 * asserted as the restricted application role `opengeni_app`.
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
  type DbClient,
} from "../src";
import { decodeSubscriptionCoreXaiCredential } from "../src/subscription-core-xai-adapter";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import { SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES } from "../src/runtime-posture";

const MIGRATION = "0717_subscription_core_xai_cutover.sql";
const key = Buffer.alloc(32, 73);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const NIL = "00000000-0000-0000-0000-000000000000";
const MODEL = "xai/grok-4";

/** A fixture access token whose principal is `subject` (null: none). */
function accessToken(subject: string | null): string {
  const payload = Buffer.from(
    JSON.stringify(subject ? { principal_id: subject, exp: 4_102_444_800 } : { exp: 4_102_444_800 }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const a = {
  account: randomUUID(),
  owner: "user:x3-owner",
  bob: "user:x3-bob",
  om: randomUUID(),
  bm: randomUUID(),
  pa: randomUUID(), // the owner's Personal workspace
  pb: randomUUID(), // bob's Personal workspace
  w1: randomUUID(),
  w2: randomUUID(),
  w3: randomUUID(),
  // Credentials.
  x1: randomUUID(), // W1 local, sub-dup, healthiest: canonical
  x2: randomUUID(), // W2 local, sub-dup, error: alias of x1
  x3: randomUUID(), // organization, every workspace
  x4: randomUUID(), // organization, allowlist [W2], no Personal workspaces
  x5: randomUUID(), // the owner's Personal workspace: personal connection
  x6: randomUUID(), // owner `user` in W1, generation 3: personal connection
  x7: randomUUID(), // owner `user` in W2, same login, generation 2: alias of x6
  x8: randomUUID(), // bob `user` in W3: bob's personal connection
  x9: randomUUID(), // W3 local, no identity, rate limited
  a6: randomUUID(),
  a7: randomUUID(),
  a8: randomUUID(),
  // Sessions and turns.
  s1: randomUUID(), // W2 shared, manual pin on alias x2, waiting
  s2: randomUUID(), // W1 private, owner `user` pool, running with a live lease
  s3: randomUUID(), // owner's Personal workspace, last x5
  s4: randomUUID(), // W3 private, bob's `user` pool, queued
  s5: randomUUID(), // W1 shared, no turn yet (initial snapshot organization)
  s6: randomUUID(), // W1 shared, bob's session pinned to the owner's personal x6
  s7: randomUUID(), // child of s1 (parent turn t5)
  t1: randomUUID(),
  t2: randomUUID(),
  t3: randomUUID(),
  t4: randomUUID(),
  t5: randomUUID(),
  t6: randomUUID(), // withdrawn for edit; a composer draft still edits it
  waiter: randomUUID(),
  collapsed: randomUUID(),
  draft: randomUUID(),
  update: randomUUID(),
  outbox: randomUUID(),
  taskUser: randomUUID(),
  taskPersonal: randomUUID(),
  video: randomUUID(),
  videoUnmapped: randomUUID(),
  image: randomUUID(),
};
// Organization B forbids personal connections.
const b = {
  account: randomUUID(),
  owner: "user:x3-b-owner",
  membership: randomUUID(),
  personal: randomUUID(),
  w1: randomUUID(),
  y1: randomUUID(),
  authority: randomUUID(),
  session: randomUUID(),
  turn: randomUUID(),
};
// Organization C: Codex and Claude state the cutover must not touch.
const c = {
  account: randomUUID(),
  w1: randomUUID(),
  codex: randomUUID(),
  claude: randomUUID(),
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
  "xai_subscription_credentials",
  "xai_rotation_settings",
  "xai_credential_leases",
  "xai_session_account_pins",
  "xai_capacity_waiters",
  "scheduled_tasks",
  "scheduled_task_revision_authorities",
  "session_system_updates",
  "session_system_update_outbox",
  "video_generation_operations",
  "image_generation_operations",
  "subscription_connections",
  "subscription_settings",
  "claude_subscription_credentials",
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

async function credential(input: {
  id: string;
  account: string;
  workspace: string | null;
  scope: "workspace" | "organization" | "user";
  subject: string | null;
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
  lastError?: string | null;
  exhaustedUntil?: Date | null;
  quota?: { used: number; resetAt: Date; checkedAt: Date };
}) {
  const secret = {
    version: 1,
    accessToken: accessToken(input.subject),
    refreshToken: `refresh-${input.id}`,
  };
  if (input.scope === "user") {
    await owned.admin`INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id,
        generation, status
      ) VALUES (${input.authority!}, ${input.account}, ${input.owner!}, 'xai_subscription',
        ${input.id}, ${input.workspace}, ${input.generation!}, 'active')`;
  }
  await owned.admin`INSERT INTO xai_subscription_credentials (
      id, account_id, workspace_id, authority_scope, credential_encrypted, provider_account_id,
      label, status, version, last_refresh_at, last_error, allocator_enabled, allowed_model_ids,
      allowed_workspace_ids, allow_personal_workspaces, selection_count, last_selected_at,
      exhausted_until, quota_used_percent, quota_reset_at, quota_checked_at,
      owner_organization_membership_id, organization_user_resource_authority_id,
      organization_user_resource_kind, organization_user_resource_authority_generation,
      connected_by_subject_id, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.scope},
      ${encryptEnvironmentValue(key, JSON.stringify(secret))},
      ${input.column === undefined ? input.subject : input.column}, ${`Label ${input.id.slice(0, 4)}`},
      ${input.status ?? "active"}, ${input.version ?? 4}, ${input.lastRefreshAt ?? null},
      ${input.lastError ?? null}, ${input.allocator ?? true}, ${input.allowedModels ?? null}::text[],
      ${input.allowedWorkspaces ?? null}::uuid[], ${input.allowPersonal ?? true},
      ${input.selections ?? 0}, ${input.selections ? new Date(Date.now() - 120_000) : null},
      ${input.exhaustedUntil ?? null}, ${input.quota?.used ?? null}, ${input.quota?.resetAt ?? null},
      ${input.quota?.checkedAt ?? null}, ${input.owner ?? null}, ${input.authority ?? null},
      ${input.scope === "user" ? "xai_subscription" : null}, ${input.generation ?? null},
      'user:connector', now() - interval '1 day'
    )`;
}

const userV1 = (generation: number) => ({ version: 1, scope: "user", authorityGeneration: generation });
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
      created_by_subject_id, initial_xai_provider_account_authority_snapshot, parent_session_id,
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
}) {
  await owned.admin`INSERT INTO session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
      source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, metadata,
      initiating_human_subject_id, initiator_kind, initiator_subject_id,
      xai_provider_account_authority_snapshot, execution_generation, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.session}, ${randomUUID()},
      ${`session-${input.session}`}, ${input.status}, 'user', ${input.position}, 'Retained prompt',
      ${MODEL}, 'high', 'standard', 'none',
      ${owned.admin.json({
        turnExecutionPolicyV1: { providerId: "supergrok-subscription", productModelId: MODEL },
      })},
      ${input.human}, ${input.human ? "subject" : "service"}, ${input.human ?? "service:fixture"},
      ${owned.admin.json(input.v1 as never)}, 2,
      now() - make_interval(secs => ${100 - input.position})
    )`;
}

const hex = (seed: string) => seed.repeat(64).slice(0, 64);

async function video(id: string, envelope: Record<string, unknown>) {
  await owned.admin`INSERT INTO video_generation_operations (
      id, account_id, workspace_id, session_id, turn_id, tool_call_id, admission_key,
      request_digest, prompt_digest, model_id, source_mode, capability_revision, credential_version,
      credential_encrypted, provider_idempotency_key, expected_artifact_id, expected_file_id,
      reserved_bytes, status, recovery_deadline_at, funding_source
    ) VALUES (
      ${id}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, ${`call-${id}`}, ${hex(id.slice(0, 1).replace(/[^0-9a-f]/, "a"))},
      ${hex("b")}, ${hex("c")}, 'xai/grok-imagine-video', 'text', ${hex("d")}, 1,
      ${encryptEnvironmentValue(key, JSON.stringify(envelope))}, ${`idem-${id}`}, ${randomUUID()},
      ${randomUUID()}, 1024, 'accepted', now() + interval '1 hour', 'supergrok_subscription'
    )`;
}

async function seed() {
  const admin = owned.admin;
  await withSeedTriggersOff(async () => {
    for (const account of [a.account, b.account, c.account]) {
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
      id: a.x1,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      subject: "sub-dup",
      lastRefreshAt: new Date(Date.now() - 60_000),
      selections: 5,
      quota: {
        used: 42,
        resetAt: new Date(Date.now() + 3_600_000),
        checkedAt: new Date(Date.now() - 30_000),
      },
    });
    await credential({
      id: a.x2,
      account: a.account,
      workspace: a.w2,
      scope: "workspace",
      subject: "sub-dup",
      status: "error",
      version: 2,
      selections: 3,
      allowedModels: [MODEL],
    });
    await credential({
      id: a.x3,
      account: a.account,
      workspace: null,
      scope: "organization",
      subject: "sub-org",
      exhaustedUntil: new Date(Date.now() + 1_800_000),
    });
    await credential({
      id: a.x4,
      account: a.account,
      workspace: null,
      scope: "organization",
      subject: "sub-list",
      allowedWorkspaces: [a.w2],
      allowPersonal: false,
      allowedModels: [MODEL],
    });
    await credential({
      id: a.x5,
      account: a.account,
      workspace: a.pa,
      scope: "workspace",
      subject: "sub-personal",
    });
    await credential({
      id: a.x6,
      account: a.account,
      workspace: a.w1,
      scope: "user",
      subject: "sub-user",
      owner: a.om,
      authority: a.a6,
      generation: 3,
    });
    await credential({
      id: a.x7,
      account: a.account,
      workspace: a.w2,
      scope: "user",
      subject: "sub-user",
      owner: a.om,
      authority: a.a7,
      generation: 2,
      status: "error",
    });
    await credential({
      id: a.x8,
      account: a.account,
      workspace: a.w3,
      scope: "user",
      subject: "sub-bob",
      owner: a.bm,
      authority: a.a8,
      generation: 1,
    });
    await credential({
      id: a.x9,
      account: a.account,
      workspace: a.w3,
      scope: "workspace",
      subject: null,
      lastError: "429 Too Many Requests",
      exhaustedUntil: new Date(Date.now() + 600_000),
    });
    await admin`INSERT INTO xai_rotation_settings (account_id, workspace_id, authority_scope, owner_organization_membership_id, active_credential_id, rotation_enabled, fairness_cursor)
      VALUES (${a.account}, NULL, 'organization', NULL, ${a.x3}, false, 0),
             (${a.account}, ${a.w1}, 'workspace', NULL, ${a.x1}, false, 7),
             (${a.account}, ${a.pa}, 'workspace', NULL, ${a.x5}, true, 0),
             (${a.account}, ${a.w1}, 'user', ${a.om}, ${a.x6}, false, 0)`;

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
    });
    await session({
      id: a.s2,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.owner,
      ownerMembership: a.om,
      visibility: "user_private",
    });
    await turn({
      id: a.t2,
      account: a.account,
      workspace: a.w1,
      session: a.s2,
      status: "running",
      position: 0,
      human: a.owner,
      v1: userV1(3),
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
    });
    await session({
      id: a.s4,
      account: a.account,
      workspace: a.w3,
      ownerSubject: a.bob,
      ownerMembership: a.bm,
      visibility: "user_private",
    });
    await turn({
      id: a.t4,
      account: a.account,
      workspace: a.w3,
      session: a.s4,
      status: "queued",
      position: 0,
      human: a.bob,
      v1: userV1(1),
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
    await admin`INSERT INTO xai_session_account_pins (account_id, workspace_id, session_id, authority_scope, owner_organization_membership_id, pinned_credential_id, pin_source, last_credential_id)
      VALUES (${a.account}, ${a.w2}, ${a.s1}, 'workspace', NULL, ${a.x2}, 'manual', ${a.x2}),
             (${a.account}, ${a.w1}, ${a.s2}, 'user', ${a.om}, NULL, NULL, ${a.x6}),
             (${a.account}, ${a.pa}, ${a.s3}, 'workspace', NULL, NULL, NULL, ${a.x5}),
             (${a.account}, ${a.w3}, ${a.s4}, 'user', ${a.bm}, NULL, NULL, ${a.x8}),
             (${a.account}, ${a.w1}, ${a.s6}, 'user', ${a.om}, ${a.x6}, 'manual', NULL)`;
    await admin`INSERT INTO xai_credential_leases (account_id, workspace_id, authority_scope, owner_organization_membership_id, credential_id, turn_id, holder_id, generation, leased_until)
      VALUES (${a.account}, ${a.w1}, 'user', ${a.om}, ${a.x6}, ${a.t2}, 'attempt-t2', 2, now() + interval '10 minutes'),
             (${a.account}, ${a.w2}, 'workspace', NULL, ${a.x2}, ${a.t5}, 'attempt-expired', 1, now() - interval '1 minute')`;
    await admin`INSERT INTO xai_capacity_waiters (
        id, account_id, workspace_id, session_id, blocked_turn_id, blocked_turn_generation,
        workflow_id, authority_scope, owner_organization_membership_id, status, generation,
        earliest_reset_at, next_check_at, wake_revision, observed_wake_revision, last_wake_reason,
        updated_at
      ) VALUES
        (${a.waiter}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, 2, ${`session-${a.s1}`}, 'workspace',
         NULL, 'waiting', 3, now() + interval '20 minutes', now() + interval '1 minute', 5, 4,
         'usage_refreshed', now() - interval '1 minute'),
        (${a.collapsed}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, 2, ${`session-${a.s1}`},
         'organization', NULL, 'waiting', 1, NULL, now() + interval '1 minute', 1, 1,
         'capacity_wait_armed', now())`;
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
      await admin`INSERT INTO scheduled_tasks (id, account_id, workspace_id, name, schedule, temporal_schedule_id, execution_digest, agent_config, owner_subject_id, created_by_kind, created_by_subject_id, xai_provider_account_authority_snapshot)
        VALUES (${id}, ${a.account}, ${workspace}, 'Cutover task', '{}'::jsonb, ${`schedule-${id}`}, ${"0".repeat(64)}, ${admin.json({ model: MODEL })}, ${a.owner}, 'subject', ${a.owner}, ${admin.json(v1 as never)})`;
      await admin`update scheduled_tasks task set execution_digest = scheduled_task_execution_digest(task) where id = ${id}`;
      await admin`INSERT INTO scheduled_task_revision_authorities (task_id, task_authority_revision, account_id, workspace_id, subject_id, organization_membership_id, membership_authorization_revision, execution_digest)
        SELECT ${id}, task.authority_revision, ${a.account}, ${workspace}, ${a.owner}, ${a.om}, 1, task.execution_digest
        FROM scheduled_tasks task WHERE task.id = ${id}`;
    }
    // In-flight SuperGrok media: one video funded by the alias x2, one whose
    // credential no longer exists, and an image operation.
    await video(a.video, {
      kind: "xai-subscription",
      credentialId: a.x2,
      accessToken: "access-video",
      subjectId: a.owner,
    });
    await video(a.videoUnmapped, {
      kind: "xai-subscription",
      credentialId: randomUUID(),
      accessToken: "access-gone",
      subjectId: a.owner,
    });
    await admin`INSERT INTO image_generation_operations (id, account_id, workspace_id, session_id, turn_id, operation_key, tool_call_id, provider_id, provider_binding_hash, model_id, request_digest, expected_artifact_id)
      VALUES (${a.image}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, ${hex("e")}, 'call-image', 'supergrok-subscription', ${hex("f")}, 'xai/grok-imagine-image', ${hex("1")}, ${randomUUID()})`;

    // Organization B: personal connections are not allowed.
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order)
      VALUES (${b.account}, NULL, false, false, false, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`;
    await credential({
      id: b.y1,
      account: b.account,
      workspace: b.w1,
      scope: "user",
      subject: "sub-b",
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

    // Organization C: Codex core and Claude legacy rows.
    await admin`INSERT INTO subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, label)
      VALUES (${c.codex}, ${c.account}, 'codex', 'codex-ciphertext', 'shared', 'organization', 'Codex C')`;
    await admin`INSERT INTO claude_subscription_credentials (id, account_id, workspace_id, credential_encrypted)
      VALUES (${c.claude}, ${c.account}, ${c.w1}, 'claude-ciphertext')`;
  });
}

async function snapshotUntouched() {
  const [row] = await owned.admin`SELECT
    (SELECT md5(string_agg(to_jsonb(connection)::text, ',' ORDER BY id)) FROM subscription_connections connection
      WHERE provider <> 'xai') AS core,
    (SELECT md5(string_agg(to_jsonb(credential)::text, ',' ORDER BY id)) FROM claude_subscription_credentials credential) AS claude,
    (SELECT md5(string_agg(to_jsonb(turn)::text, ',' ORDER BY id)) FROM session_turns turn) AS turns,
    (SELECT md5(string_agg(to_jsonb(task)::text, ',' ORDER BY id)) FROM scheduled_tasks task) AS tasks,
    (SELECT count(*)::int FROM host_export_outbox) AS facts`;
  return row!;
}

async function noPartialCutover() {
  const [state] = await owned.admin`SELECT
    (SELECT count(*)::int FROM subscription_connections WHERE provider = 'xai') AS connections,
    (SELECT count(*)::int FROM subscription_provider_cutovers WHERE provider = 'xai') AS cutovers,
    (SELECT count(*)::int FROM opengeni_private.subscription_core_providers WHERE provider = 'xai') AS registry,
    opengeni_private.subscription_provider_cutover_committed('xai') AS receipt,
    (SELECT count(*)::int FROM opengeni_private.subscription_cutover_report WHERE provider = 'xai') AS report,
    (SELECT count(*)::int FROM opengeni_private.subscription_authority_compat WHERE provider = 'xai') AS records,
    (SELECT count(*)::int FROM xai_subscription_credentials WHERE credential_encrypted = '') AS wiped,
    (SELECT count(*)::int FROM xai_capacity_waiters WHERE status = 'waiting') AS waiting,
    (SELECT count(*)::int FROM xai_credential_leases) AS leases,
    (SELECT count(*)::int FROM schema_migrations WHERE name = ${MIGRATION}) AS ledger`;
  expect(state).toMatchObject({
    connections: 0,
    cutovers: 0,
    registry: 0,
    receipt: false,
    report: 0,
    records: 0,
    wiped: 0,
    waiting: 2,
    leases: 2,
    ledger: 0,
  });
  const forced = await owned.admin`SELECT relname FROM pg_class
    WHERE relname IN ('xai_subscription_credentials', 'subscription_connections', 'session_turns',
      'video_generation_operations')
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

async function abortMessage(): Promise<string> {
  const error = await migrateCutover({ key }).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  for (const secret of ["refresh-", "sub-", "Label ", "access-"]) {
    expect(message).not.toContain(secret);
  }
  await noPartialCutover();
  return message;
}

describe.skipIf(!realDb)(
  "SUB-COMPAT-02 migration 0717: SuperGrok onto the shared subscription core",
  () => {
    let before: Awaited<ReturnType<typeof snapshotUntouched>>;
    beforeAll(async () => {
      const fixture = await acquireOwnerMigratedTestDatabase("xai-core-cutover");
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

    test("a missing or wrong key rolls everything back without leaking material", async () => {
      await expect(migrateCutover()).rejects.toThrow(
        "requires the existing environments encryption key",
      );
      await noPartialCutover();
      const wrong = await migrateCutover({ key: Buffer.alloc(32, 9) }).catch(
        (error: Error) => error,
      );
      expect((wrong as Error).message).toBe(
        "SuperGrok subscription cutover could not decode a legacy credential (credential_undecodable); see the runbook",
      );
      await noPartialCutover();
    }, 180_000);

    test("a failed core write leaves no secret, label or identity in the error", async () => {
      await owned.admin`ALTER TABLE subscription_connections
        ADD CONSTRAINT xai_cutover_forced_failure CHECK (provider <> 'xai') NOT VALID`;
      try {
        const failed = await migrateCutover({ key }).catch((error: unknown) => error);
        const error = failed as Error & Record<string, unknown>;
        expect(error.message).toBe(
          "SuperGrok subscription cutover could not write the shared core (SQLSTATE 23514, xai_cutover_forced_failure); see the runbook",
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
        for (const secret of ["access", "refresh-", "Label ", "sub-", "v1:"]) {
          expect(everything).not.toContain(secret);
        }
        expect((error as { parameters?: unknown }).parameters).toBeUndefined();
      } finally {
        await owned.admin`ALTER TABLE subscription_connections DROP CONSTRAINT xai_cutover_forced_failure`;
      }
      await noPartialCutover();
    }, 180_000);

    test("identity ambiguity aborts before any mutation", async () => {
      const extra = randomUUID();
      await withSeedTriggersOff(() =>
        credential({
          id: extra,
          account: c.account,
          workspace: c.w1,
          scope: "workspace",
          subject: "sub-token",
          column: "sub-column",
        }),
      );
      try {
        expect(await abortMessage()).toContain("provider_identity_mismatch");
      } finally {
        await owned.admin`DELETE FROM xai_subscription_credentials WHERE id = ${extra}`;
      }
    }, 180_000);

    test("a parity mismatch rolls the activation back", async () => {
      // A rule silently drops moved leases, which only the parity check can see.
      await owned.admin`CREATE RULE xai_cutover_parity_probe AS ON INSERT TO subscription_leases DO INSTEAD NOTHING`;
      try {
        expect(await abortMessage()).toContain("0717 parity mismatch (live_leases)");
      } finally {
        await owned.admin`DROP RULE xai_cutover_parity_probe ON subscription_leases`;
      }
    }, 180_000);

    test("ambiguous session ownership on live work aborts activation", async () => {
      const ambiguous = randomUUID();
      const live = randomUUID();
      await withSeedTriggersOff(async () => {
        await session({
          id: ambiguous,
          account: a.account,
          workspace: a.w1,
          ownerSubject: a.owner,
          ownerMembership: a.bm,
        });
        await turn({
          id: live,
          account: a.account,
          workspace: a.w1,
          session: ambiguous,
          status: "queued",
          position: 0,
          human: a.owner,
          v1: workspaceV1,
        });
      });
      try {
        expect(await abortMessage()).toContain("session_owner_ambiguous");
      } finally {
        await withSeedTriggersOff(async () => {
          await owned.admin`DELETE FROM session_turns WHERE id = ${live}`;
          await owned.admin`DELETE FROM sessions WHERE id = ${ambiguous}`;
        });
      }
    }, 180_000);

    test("a waiter of another workflow aborts activation", async () => {
      await owned.admin`UPDATE xai_capacity_waiters SET workflow_id = 'session-elsewhere' WHERE id = ${a.waiter}`;
      try {
        expect(await abortMessage()).toContain("waiter_workflow_mismatch");
      } finally {
        await owned.admin`UPDATE xai_capacity_waiters SET workflow_id = ${`session-${a.s1}`} WHERE id = ${a.waiter}`;
      }
    }, 180_000);

    test("pre-existing core SuperGrok state is refused", async () => {
      const [row] = await owned.admin<{ id: string }[]>`INSERT INTO subscription_connections
        (account_id, provider, credential_encrypted, ownership, scope_kind)
        VALUES (${c.account}, 'xai', 'x', 'shared', 'organization') RETURNING id::text`;
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect((error as Error).message).toContain("refuses pre-existing core SuperGrok state");
      } finally {
        await owned.admin`DELETE FROM subscription_connections WHERE id = ${row!.id}`;
      }
      await noPartialCutover();
    }, 180_000);

    describe("after the cutover commits", () => {
      let client: DbClient;
      let appUrl: string;
      beforeAll(async () => {
        await migrateCutover({ key });
        await provisionRoles(owned.adminUrl, {
          appRole: "opengeni_app",
          appPassword: owned.appPassword,
        });
        const url = new URL(owned.ownerUrl);
        url.username = "opengeni_app";
        url.password = owned.appPassword;
        appUrl = url.toString();
        client = createDb(appUrl, { max: 4 });
      }, 180_000);
      afterAll(async () => {
        await client?.close();
      });

      test("connections: one per upstream login and owner, aliases, one readable secret copy", async () => {
        const rows = await owned.admin`SELECT id::text, account_id::text, provider_account_id,
            provider_subject_id, status, ownership, scope_kind, allow_personal_workspaces,
            allocator_enabled, allowed_model_ids, version, refresh_generation, credential_encrypted,
            credential_format, owner_organization_membership_id::text AS owner, authority_generation
          FROM subscription_connections WHERE provider = 'xai' ORDER BY id`;
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(rows).toHaveLength(8);
        expect(byId.has(a.x2)).toBe(false);
        expect(byId.has(a.x7)).toBe(false);
        expect(byId.get(a.x1)).toMatchObject({
          provider_account_id: "sub-dup",
          status: "active",
          ownership: "shared",
          scope_kind: "workspaces",
          version: 4,
          refresh_generation: "4",
          credential_format: "xai_oauth_v1",
        });
        expect(byId.get(a.x3)).toMatchObject({ scope_kind: "organization", allow_personal_workspaces: true });
        expect(byId.get(a.x4)).toMatchObject({ scope_kind: "workspaces", allowed_model_ids: [MODEL] });
        for (const id of [a.x5, a.x6]) {
          expect(byId.get(id)).toMatchObject({ ownership: "personal", scope_kind: "people", owner: a.om });
        }
        expect(byId.get(a.x8)).toMatchObject({ ownership: "personal", owner: a.bm });
        expect(byId.get(b.y1)).toMatchObject({ ownership: "personal", owner: b.membership });
        expect(byId.get(a.x9)).toMatchObject({ provider_account_id: null, scope_kind: "workspaces" });
        // The canonical secret decrypts to the adapter format with the same tokens.
        const secret = decodeSubscriptionCoreXaiCredential(
          decryptEnvironmentValue(key, byId.get(a.x1)!.credential_encrypted),
        );
        expect(secret).toMatchObject({ accessToken: accessToken("sub-dup"), refreshToken: `refresh-${a.x1}` });
        const aliases = await owned.admin`SELECT alias_connection_id::text AS alias, connection_id::text AS target
          FROM subscription_connection_aliases WHERE provider = 'xai' ORDER BY alias`;
        expect(new Map(aliases.map((row) => [row.alias, row.target]))).toEqual(
          new Map([
            [a.x2, a.x1],
            [a.x7, a.x6],
          ]),
        );
        const [legacy] = await owned.admin`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE credential_encrypted = '')::int AS blank
          FROM xai_subscription_credentials`;
        expect(legacy).toEqual({ total: 10, blank: 10 });
        // Quota: one window; the rate-limited exhaustion keeps its kind.
        const quotas = await owned.admin`SELECT connection_id::text AS id, quota, selection_count::int AS selection_count
          FROM subscription_connection_quota WHERE connection_id IN (${a.x1}, ${a.x3}, ${a.x9})`;
        const quota = new Map(quotas.map((row) => [row.id, row]));
        expect(quota.get(a.x1)!.selection_count).toBe(8);
        expect(quota.get(a.x1)!.quota.windows[0]).toMatchObject({ usedPercent: 42, status: "ok" });
        expect(quota.get(a.x3)!.quota.exhaustedKind).toBe("quota");
        expect(quota.get(a.x9)!.quota.exhaustedKind).toBe("rate_limit");
      });

      test("generations: one owner with `user` credentials in two workspaces and a Personal one has one current generation", async () => {
        const rows = await owned.admin`SELECT connection.owner_organization_membership_id::text AS owner,
            array_agg(DISTINCT connection.authority_generation) AS generations,
            bool_and(authority.status = 'active' AND authority.generation = connection.authority_generation
              AND authority.resource_kind = 'subscription_connection') AS verified
          FROM subscription_connections connection
          JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
          WHERE connection.provider = 'xai' AND connection.ownership = 'personal'
          GROUP BY connection.owner_organization_membership_id`;
        const byOwner = new Map(rows.map((row) => [row.owner, row]));
        expect(byOwner.get(a.om)!.generations).toHaveLength(1);
        expect(byOwner.get(a.om)!.verified).toBe(true);
        expect(byOwner.get(a.bm)!.generations).toHaveLength(1);
        // Legacy authorities stay, unchanged, for forensics.
        const legacy = await owned.admin`SELECT id::text, generation, status
          FROM organization_user_resource_authorities WHERE resource_kind = 'xai_subscription' ORDER BY id`;
        expect(legacy).toHaveLength(4);
        expect(legacy.every((row) => row.status === "active")).toBe(true);
      });

      test("pools, rotation and source: organization rows, local pools frozen on the workspace source", async () => {
        const policies = await owned.admin`SELECT connection_id::text AS id, workspace_id::text AS workspace,
            inference_pool, allocator_enabled, allowed_model_ids, managed_by_workspace_id::text AS manager
          FROM subscription_connection_assignment_policies policy
          WHERE account_id = ${a.account} AND connection_id IN (${a.x1}, ${a.x4}) ORDER BY id, workspace`;
        expect(policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: a.x1, workspace: a.w1, inference_pool: "workspace", manager: a.w1, allowed_model_ids: null }),
            expect.objectContaining({ id: a.x1, workspace: a.w2, inference_pool: "workspace", manager: a.w2, allowed_model_ids: [MODEL] }),
            expect.objectContaining({ id: a.x4, workspace: a.w2, inference_pool: "organization", manager: null }),
          ]),
        );
        const settings = await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
            xai_primary_connection_id::text AS primary, personal_fallback_allowed
          FROM subscription_settings WHERE account_id = ${a.account}`;
        const byWorkspace = new Map(settings.map((row) => [row.workspace, row]));
        expect(byWorkspace.get(null)).toMatchObject({
          rotation: { xai: { mode: "primary_first" } },
          primary: a.x3,
        });
        expect(byWorkspace.get(a.w1)).toMatchObject({
          rotation: { xai: { mode: "primary_first" } },
          providers: { xai: { inferenceSource: "workspace", useOrganizationAccounts: false } },
          primary: a.x1,
        });
        expect(byWorkspace.get(a.w2)).toMatchObject({
          rotation: { xai: { mode: "spread" } },
          providers: { xai: { inferenceSource: "workspace" } },
          primary: null,
        });
        expect(byWorkspace.get(a.w3)!.providers.xai.inferenceSource).toBe("workspace");
        expect(byWorkspace.get(a.pa)).toMatchObject({ personal_fallback_allowed: true, providers: null });
        expect(byWorkspace.has(a.pb)).toBe(false);
        const preferences = await owned.admin`SELECT organization_membership_id::text AS membership,
            personal_fallback_opt_in FROM subscription_person_preferences WHERE account_id = ${a.account}`;
        expect(new Set(preferences.filter((row) => row.personal_fallback_opt_in).map((row) => row.membership))).toEqual(
          new Set([a.om, a.bm]),
        );
        // Organization B kept its own settings; only the SuperGrok key changed.
        const [orgB] = await owned.admin`SELECT personal_connections_allowed, rotation FROM subscription_settings
          WHERE account_id = ${b.account} AND workspace_id IS NULL`;
        expect(orgB).toEqual({ personal_connections_allowed: false, rotation: { xai: { mode: "spread" } } });
      });

      test("pins become bindings through aliases; an ineligible pin is a disposition", async () => {
        const bindings = await owned.admin`SELECT session_id::text AS session, connection_id::text AS connection,
            choice, model_id FROM subscription_session_bindings WHERE provider = 'xai'`;
        const bySession = new Map(bindings.map((row) => [row.session, row]));
        expect(bySession.get(a.s1)).toMatchObject({ connection: a.x1, choice: "explicit", model_id: MODEL });
        expect(bySession.get(a.s2)).toMatchObject({ connection: a.x6, choice: "automatic" });
        expect(bySession.get(a.s3)).toMatchObject({ connection: a.x5, choice: "automatic" });
        expect(bySession.get(a.s4)).toMatchObject({ connection: a.x8, choice: "automatic" });
        expect(bySession.has(a.s6)).toBe(false);
      });

      test("live leases and waiters keep their fences, ids and pending wakes", async () => {
        const leases = await owned.admin`SELECT turn_id::text AS turn, connection_id::text AS connection,
            holder_id, generation::int AS generation FROM subscription_leases WHERE provider = 'xai'`;
        expect([...leases]).toEqual([{ turn: a.t2, connection: a.x6, holder_id: "attempt-t2", generation: 2 }]);
        const [legacyLeases] = await owned.admin`SELECT count(*)::int AS total FROM xai_credential_leases`;
        expect(legacyLeases!.total).toBe(0);
        const waiters = await owned.admin`SELECT waiter_id::text AS id, turn_id::text AS turn, generation::int AS generation,
            wake_revision::int AS wake_revision,
            observed_wake_revision::int AS observed_wake_revision,
            blocked_turn_generation::int AS blocked_turn_generation, reset_kind, wait_reason,
            last_wake_reason FROM subscription_capacity_waiters WHERE provider = 'xai'`;
        expect([...waiters]).toEqual([
          {
            id: a.waiter,
            turn: a.t1,
            generation: 3,
            wake_revision: 5,
            observed_wake_revision: 4,
            blocked_turn_generation: 2,
            reset_kind: "quota",
            wait_reason: "pinned_account_unavailable",
            last_wake_reason: "usage_refreshed",
          },
        ]);
        const wakes = await owned.admin`SELECT waiter_id::text AS id, generation::int AS generation,
            wake_revision::int AS wake_revision
          FROM subscription_capacity_wake_outbox WHERE account_id = ${a.account}`;
        expect([...wakes]).toEqual([{ id: a.waiter, generation: 3, wake_revision: 5 }]);
        const legacyWaiters = await owned.admin`SELECT status FROM xai_capacity_waiters`;
        expect(legacyWaiters.every((row) => row.status === "superseded")).toBe(true);
      });

      test("accepted authority: one record per carrier with exact personal entries; v1 bytes untouched", async () => {
        const records = await owned.admin`SELECT carrier_kind,
            coalesce(turn_id, session_id, scheduled_task_id, system_update_id, outbox_id)::text AS carrier,
            personal, shared_pool, legacy_scope, owner_subject_id
          FROM opengeni_private.subscription_authority_compat WHERE provider = 'xai'`;
        const by = new Map(records.map((row) => [`${row.carrier_kind}:${row.carrier}`, row]));
        const [generation] = await owned.admin`SELECT authority_generation FROM subscription_connections WHERE id = ${a.x6}`;
        const g = Number(generation!.authority_generation);
        // Live turns.
        expect(by.get(`session_turn:${a.t1}`)).toMatchObject({ personal: [], shared_pool: "workspace", legacy_scope: "workspace" });
        expect(by.get(`session_turn:${a.t2}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.x6] }],
          shared_pool: "none",
          legacy_scope: "user",
          owner_subject_id: a.owner,
        });
        expect(by.get(`session_turn:${a.t4}`)!.personal).toHaveLength(1);
        // The latest turn of a Personal-workspace session keeps the owner's entry.
        expect(by.get(`session_turn:${a.t3}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.x5] }],
          legacy_scope: "workspace",
        });
        // Child parent turn, the withdrawn turn a draft edits, a session without turns.
        expect(by.has(`session_turn:${a.t5}`)).toBe(true);
        expect(by.has(`session_turn:${a.t6}`)).toBe(true);
        expect(by.get(`session_initial:${a.s5}`)).toMatchObject({ shared_pool: "organization", legacy_scope: "organization" });
        expect(by.has(`session_initial:${a.s7}`)).toBe(true);
        // Schedules: the `user` task follows its alias to the canonical connection.
        expect(by.get(`scheduled_task:${a.taskUser}`)).toMatchObject({
          personal: [{ ownerMembershipId: a.om, authorityGeneration: g, connectionIds: [a.x6] }],
          legacy_scope: "user",
        });
        expect(by.get(`scheduled_task_revision:${a.taskUser}`)!.personal).toHaveLength(1);
        expect(by.get(`scheduled_task:${a.taskPersonal}`)!.personal).toHaveLength(1);
        expect(by.has(`session_system_update:${a.update}`)).toBe(true);
        expect(by.has(`session_system_update_outbox:${a.outbox}`)).toBe(true);
        // Organization B forbids personal connections: the work waits.
        expect(by.get(`session_turn:${b.turn}`)).toMatchObject({ personal: [], shared_pool: "none", legacy_scope: "user" });
        // v1 snapshots and v2 values are unchanged.
        const after = await snapshotUntouched();
        expect(after.turns).toBe(before.turns);
        expect(after.tasks).toBe(before.tasks);
      });

      test("media: in-flight videos keep a connection reference instead of a token envelope", async () => {
        const videos = await owned.admin`SELECT id::text, connection_id, credential_encrypted
          FROM video_generation_operations WHERE id IN (${a.video}, ${a.videoUnmapped})`;
        const byId = new Map(videos.map((row) => [row.id, row]));
        for (const row of videos) expect(row.connection_id).toBeNull();
        expect(JSON.parse(decryptEnvironmentValue(key, byId.get(a.video)!.credential_encrypted))).toEqual({
          kind: "subscription-connection",
          provider: "xai",
          connectionId: a.x1,
        });
        expect(
          JSON.parse(decryptEnvironmentValue(key, byId.get(a.videoUnmapped)!.credential_encrypted)),
        ).toEqual({ kind: "subscription-connection", provider: "xai", connectionId: NIL });
        const [image] = await owned.admin`SELECT status FROM image_generation_operations WHERE id = ${a.image}`;
        expect(image!.status).toBe("prepared");
      });

      test("the parity report has every metric equal, with dispositions and impact rows", async () => {
        const report = await owned.admin`SELECT metric, account_id::text AS account, legacy_count::int AS legacy,
            core_count::int AS core FROM opengeni_private.subscription_cutover_report WHERE provider = 'xai'`;
        const mismatched = report.filter((row) => row.legacy !== row.core);
        expect(mismatched).toEqual([]);
        const metric = (name: string, account = a.account) =>
          report.find((row) => row.metric === name && row.account === account);
        expect(metric("credentials")).toMatchObject({ legacy: 9 });
        expect(metric("connections")).toMatchObject({ legacy: 7 });
        expect(metric("aliases")).toMatchObject({ legacy: 2 });
        expect(metric("live_leases")).toMatchObject({ legacy: 1 });
        expect(metric("waiting_waiters")).toMatchObject({ legacy: 2 });
        expect(metric("pending_wakes")).toMatchObject({ legacy: 1 });
        expect(metric("compat:dependent_sources_without_record")).toMatchObject({ legacy: 0, core: 0 });
        expect(metric("video_operations_open")).toMatchObject({ legacy: 2 });
        expect(metric("image_operations_open")).toMatchObject({ legacy: 1 });
        expect(metric("personal_generations")).toMatchObject({ legacy: 2 });
        expect(metric("disposition:waiters_collapsed")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:expired_leases_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:pin_owner_ineligible")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:user_rotation_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:personal_rotation_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:video_operation_unmapped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:personal_connections_disallowed", b.account)).toMatchObject({ legacy: 1 });
        expect(metric("disposition:compat_personal_connections_disallowed", b.account)).toMatchObject({ legacy: 1 });
        expect(metric("compat:carriers_that_will_wait", b.account)).toMatchObject({ legacy: 1 });
        expect(metric("readiness:owners_with_multiple_current_personal_generations", null as never)).toMatchObject({ core: 0 });
        expect(metric("xai_cutover_rows", null as never)).toBeDefined();
        // Only this provider's rows.
        const [others] = await owned.admin`SELECT count(*)::int AS total FROM opengeni_private.subscription_cutover_report
          WHERE provider NOT IN ('xai', 'codex')`;
        expect(others!.total).toBe(0);
      });

      test("activation: receipt, registry, switch rows, FORCE and triggers restored, no lifecycle facts", async () => {
        const [state] = await owned.admin`SELECT
            opengeni_private.subscription_provider_cutover_committed('xai') AS committed,
            (SELECT committed_at > '-infinity'::timestamptz FROM opengeni_private.subscription_provider_cutover_receipts WHERE provider = 'xai') AS real_time,
            (SELECT primary_setting_column FROM opengeni_private.subscription_core_providers WHERE provider = 'xai') AS primary_column,
            (SELECT count(*)::int FROM subscription_provider_cutovers WHERE provider = 'xai' AND enabled) AS enabled,
            (SELECT count(*)::int FROM managed_accounts) AS accounts`;
        expect(state).toMatchObject({
          committed: true,
          real_time: true,
          primary_column: "xai_primary_connection_id",
        });
        expect(state!.enabled).toBe(state!.accounts);
        expect(subscriptionCoreProviderIds()).toEqual(["codex", "xai"]);
        const relaxed = await owned.admin`SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity
            AND NOT relforcerowsecurity
            AND (relname LIKE 'subscription_%' OR relname LIKE 'xai_%' OR relname IN (
              'sessions', 'session_turns', 'scheduled_tasks', 'video_generation_operations'))`;
        expect(relaxed).toHaveLength(0);
        const [disabled] = await owned.admin`SELECT count(*)::int AS total FROM pg_trigger
          WHERE NOT tgisinternal AND tgenabled = 'D' AND tgrelid IN (
            'subscription_session_bindings'::regclass, 'subscription_leases'::regclass,
            'session_turns'::regclass, 'xai_subscription_credentials'::regclass,
            'subscription_connections'::regclass)`;
        expect(disabled!.total).toBe(0);
        const after = await snapshotUntouched();
        expect(after.facts).toBe(before.facts);
        // Codex and Claude rows are byte-for-byte unchanged.
        expect(after.core).toBe(before.core);
        expect(after.claude).toBe(before.claude);
      });

      test("retrying the ledger is a no-op without the key", async () => {
        await migrateCutover();
        const [count] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections WHERE provider = 'xai'`;
        expect(count!.total).toBe(8);
      }, 180_000);

      test("provisioning withdraws runtime writes on the legacy tables and the posture contract holds", async () => {
        const privileges = await owned.admin`SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS granted
          FROM information_schema.role_table_grants
          WHERE grantee = 'opengeni_app' AND table_name = ANY(${[...SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES.xai!]})
          GROUP BY table_name`;
        expect(privileges).toHaveLength(5);
        for (const row of privileges) expect(row.granted).toEqual(["SELECT"]);
        await expect(
          withRlsContext(client.db, { accountId: a.account, workspaceId: a.w1 }, (tx) =>
            tx.execute(sql`delete from xai_session_account_pins where session_id = ${a.s2}::uuid`),
          ),
        ).rejects.toThrow();
        const options = {
          rlsStrategy: "force" as const,
          expectedRole: "opengeni_app",
          targetSchema: "public",
        };
        const posture = await inspectRuntimeDatabasePosture(client.db, options);
        expect(posture.subscriptionProviderCutoverReceipts).toEqual(["codex", "xai"]);
        expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
      }, 180_000);

      test("the application role adds no legacy SuperGrok authority after the receipt", async () => {
        await expect(
          withRlsContext(client.db, { accountId: a.account, workspaceId: a.w1 }, (tx) =>
            tx.execute(sql`insert into organization_user_resource_authorities (
                account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id,
                generation, status
              ) values (${a.account}::uuid, ${a.bm}::uuid, 'xai_subscription', ${randomUUID()}::uuid,
                ${a.w1}::uuid, 1, 'active')`),
          ),
        ).rejects.toThrow();
      }, 60_000);

      test("pre-cutover schedules and inbox rows read their records as the application role", async () => {
        const read = (kind: string, workspace: string, id: string, revision: number | null) =>
          withRlsContext(client.db, { accountId: a.account, workspaceId: workspace }, async (tx) => {
            const [row] = await rawRows<{ authority: Record<string, unknown> | null }>(
              tx,
              sql`select opengeni_private.read_subscription_authority_compat('xai', ${kind},
                ${workspace}::uuid, ${id}::uuid, ${revision}::bigint) as authority`,
            );
            return row!.authority;
          });
        const [task] = await owned.admin`SELECT authority_revision FROM scheduled_tasks WHERE id = ${a.taskUser}`;
        const revision = await read("scheduled_task_revision", a.w2, a.taskUser, Number(task!.authority_revision));
        expect(revision).toMatchObject({ authority: "record", legacyScope: "user", sharedPool: "none" });
        expect((revision!.personal as unknown[]).length).toBe(1);
        expect(await read("session_system_update_outbox", a.w2, a.outbox, null)).toMatchObject({
          authority: "record",
        });
        expect(await read("session_turn", a.w1, a.t2, null)).toMatchObject({ authority: "record" });
      }, 60_000);
    });
  },
);
