/**
 * Migration 0718: the drained, one-way SuperGrok cutover onto the shared
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
import { createXaiSubscriptionCredential } from "../src/xai-subscription";
import {
  createDb,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";
import { decodeSubscriptionCoreXaiCredential } from "../src/subscription-core-xai-adapter";
import { subscriptionCoreProviderIds } from "../src/subscription-core-providers";
import { SUBSCRIPTION_CUTOVER_READ_ONLY_TABLES } from "../src/runtime-posture";
import { deleteSubscriptionCoreWaitersForTurns } from "../src/subscription-core/waiters";

const MIGRATION = "0718_subscription_core_xai_cutover.sql";
const key = Buffer.alloc(32, 73);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const NIL = "00000000-0000-0000-0000-000000000000";
const MODEL = "xai/grok-4";
const CODEX_MODEL = "codex/gpt-5.5";

/** A fixture access token whose principal is `subject` (null: none). */
function accessToken(subject: string | null): string {
  const payload = Buffer.from(
    JSON.stringify(
      subject ? { principal_id: subject, exp: 4_102_444_800 } : { exp: 4_102_444_800 },
    ),
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
  goal: randomUUID(), // the goal fence of the moved waiter
  collapsed: randomUUID(),
  draft: randomUUID(),
  update: randomUUID(),
  outbox: randomUUID(),
  taskUser: randomUUID(),
  taskPersonal: randomUUID(),
  video: randomUUID(),
  videoUnmapped: randomUUID(),
  image: randomUUID(),
  // Codex state in the same organization that the cutover must keep.
  cx: randomUUID(), // shared Codex connection, the organization's Codex primary
  s8: randomUUID(), // W1 shared, current model Codex, Codex binding, legacy SuperGrok pin
  t8: randomUUID(),
  s9: randomUUID(), // W1 shared, current model SuperGrok, Codex binding, legacy SuperGrok pin
  t9: randomUUID(),
  s10: randomUUID(), // W1 shared, a running Codex turn with a live Codex lease
  t10: randomUUID(),
  s11: randomUUID(), // W1 shared, a Codex turn parked on a Codex waiter
  t11: randomUUID(),
  codexWaiter: randomUUID(),
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
// Organization D locks rotation (with the primaries) and providers: its
// workspaces with local accounts keep following the organization's values.
const d = {
  account: randomUUID(),
  w1: randomUUID(), // local account, rotation off; a pre-existing override row
  w2: randomUUID(), // local account, no override row
  z1: randomUUID(),
  z2: randomUUID(),
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
  "session_goals",
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
  "subscription_session_bindings",
  "subscription_leases",
  "subscription_capacity_waiters",
  "subscription_person_preferences",
  "workspace_memberships",
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
  provider?: "supergrok-subscription" | "codex-subscription";
}) {
  const model = input.provider === "codex-subscription" ? CODEX_MODEL : MODEL;
  await owned.admin`INSERT INTO session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
      source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, metadata,
      initiating_human_subject_id, initiator_kind, initiator_subject_id,
      xai_provider_account_authority_snapshot, execution_generation, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.session}, ${randomUUID()},
      ${`session-${input.session}`}, ${input.status}, 'user', ${input.position}, 'Retained prompt',
      ${model}, 'high', 'standard', 'none',
      ${owned.admin.json({
        turnExecutionPolicyV1: {
          providerId: input.provider ?? "supergrok-subscription",
          productModelId: model,
        },
      })},
      ${input.human}, ${input.human ? "subject" : "service"}, ${input.human ?? "service:fixture"},
      ${owned.admin.json(input.v1 as never)}, 2,
      now() - make_interval(secs => ${100 - input.position})
    )`;
}

const hex = (pattern: string) => pattern.repeat(64).slice(0, 64);

async function video(id: string, envelope: Record<string, unknown>) {
  await owned.admin`INSERT INTO video_generation_operations (
      id, account_id, workspace_id, session_id, turn_id, tool_call_id, admission_key,
      request_digest, prompt_digest, model_id, source_mode, capability_revision, credential_version,
      credential_encrypted, provider_idempotency_key, expected_artifact_id, expected_file_id,
      reserved_bytes, status, recovery_deadline_at, funding_source
    ) VALUES (
      ${id}, ${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, ${`call-${id}`}, ${id.replaceAll("-", "").repeat(2)},
      ${hex("b")}, ${hex("c")}, 'xai/grok-imagine-video', 'text', ${hex("d")}, 1,
      ${encryptEnvironmentValue(key, JSON.stringify(envelope))}, ${`idem-${id}`}, ${randomUUID()},
      ${randomUUID()}, 1024, 'accepted', now() + interval '1 hour', 'supergrok_subscription'
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
    await admin`INSERT INTO session_goals (id, account_id, workspace_id, session_id, text, version)
      VALUES (${a.goal}, ${a.account}, ${a.w2}, ${a.s1}, 'Finish the retained work', 3)`;
    await admin`INSERT INTO xai_capacity_waiters (
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

    // Organization A also runs Codex on the shared core. Its settings, a
    // binding of a session whose current model is Codex, a live lease, a
    // waiter and a person's preference are not the cutover's to change.
    await admin`INSERT INTO workspace_memberships (account_id, workspace_id, subject_id, role)
      VALUES (${a.account}, ${a.w1}, ${a.owner}, 'owner')`;
    await admin`INSERT INTO subscription_connections (id, account_id, provider, credential_encrypted, ownership, scope_kind, label)
      VALUES (${a.cx}, ${a.account}, 'codex', 'codex-ciphertext-a', 'shared', 'organization', 'Codex A')`;
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order,
        codex_primary_connection_id, version, updated_by_subject_id)
      VALUES (${a.account}, NULL, true, false, true, '{"codex":{"mode":"primary_first"}}'::jsonb,
          '{}'::jsonb, '{"codex":["xai"]}'::jsonb, ${a.cx}, 3, ${a.owner}),
        (${a.account}, ${a.w1}, NULL, NULL, NULL, '{"codex":{"mode":"spread"}}'::jsonb,
          '{"codex":{"inferenceSource":"organization"}}'::jsonb, NULL, NULL, 2, ${a.owner})`;
    await admin`INSERT INTO subscription_person_preferences (account_id, organization_membership_id, personal_fallback_opt_in, version)
      VALUES (${a.account}, ${a.bm}, false, 2)`;
    for (const [s, t, status, provider] of [
      [a.s8, a.t8, "completed", "codex-subscription"],
      [a.s9, a.t9, "completed", "supergrok-subscription"],
      [a.s10, a.t10, "running", "codex-subscription"],
      [a.s11, a.t11, "waiting_capacity", "codex-subscription"],
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
        status,
        position: 0,
        human: a.owner,
        v1: workspaceV1,
        provider,
      });
    }
    await admin`INSERT INTO xai_session_account_pins (account_id, workspace_id, session_id, authority_scope, owner_organization_membership_id, pinned_credential_id, pin_source, last_credential_id)
      VALUES (${a.account}, ${a.w1}, ${a.s8}, 'workspace', NULL, NULL, NULL, ${a.x1}),
             (${a.account}, ${a.w1}, ${a.s9}, 'workspace', NULL, NULL, NULL, ${a.x1})`;
    await admin`INSERT INTO subscription_session_bindings (account_id, workspace_id, session_id, provider, connection_id, model_id, choice, version)
      VALUES (${a.account}, ${a.w1}, ${a.s8}, 'codex', ${a.cx}, ${CODEX_MODEL}, 'explicit', 2),
             (${a.account}, ${a.w1}, ${a.s9}, 'codex', ${a.cx}, ${CODEX_MODEL}, 'automatic', 4)`;
    await admin`INSERT INTO subscription_leases (account_id, workspace_id, session_id, turn_id, connection_id, provider, holder_id, generation, leased_until)
      VALUES (${a.account}, ${a.w1}, ${a.s10}, ${a.t10}, ${a.cx}, 'codex', 'attempt-codex', 3, now() + interval '10 minutes')`;
    await admin`INSERT INTO subscription_capacity_waiters (account_id, workspace_id, session_id, turn_id, waiter_id, provider, wait_reason, generation, wake_revision, observed_wake_revision, next_check_at, blocked_turn_generation)
      VALUES (${a.account}, ${a.w1}, ${a.s11}, ${a.t11}, ${a.codexWaiter}, 'codex', 'no_eligible_capacity', 2, 3, 2, now() + interval '1 minute', 2)`;

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

    // Organization D: rotation and providers locked on the organization row.
    await admin`INSERT INTO subscription_settings (account_id, workspace_id, personal_connections_allowed,
        personal_fallback_allowed, cross_provider_failover, rotation, providers, fallback_order,
        locked_settings, version)
      VALUES (${d.account}, NULL, true, false, false, '{}'::jsonb,
          '{"xai":{"inferenceSource":"organization"}}'::jsonb, '{}'::jsonb,
          ARRAY['rotation', 'providers'], 5),
        (${d.account}, ${d.w1}, NULL, NULL, NULL, '{"codex":{"mode":"spread"}}'::jsonb,
          '{"codex":{"inferenceSource":"organization"}}'::jsonb, NULL, '{}', 2)`;
    await credential({
      id: d.z1,
      account: d.account,
      workspace: d.w1,
      scope: "workspace",
      subject: "sub-d-one",
    });
    await credential({
      id: d.z2,
      account: d.account,
      workspace: d.w2,
      scope: "workspace",
      subject: "sub-d-two",
    });
    await admin`INSERT INTO xai_rotation_settings (account_id, workspace_id, authority_scope, owner_organization_membership_id, active_credential_id, rotation_enabled, fairness_cursor)
      VALUES (${d.account}, ${d.w1}, 'workspace', NULL, ${d.z1}, false, 0)`;

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
    (SELECT count(*)::int FROM host_export_outbox) AS facts,
    (SELECT md5(string_agg(to_jsonb(binding)::text, ',' ORDER BY workspace_id, session_id))
      FROM subscription_session_bindings binding
      WHERE provider <> 'xai' AND session_id <> ${a.s9}) AS bindings,
    (SELECT md5(string_agg(to_jsonb(lease)::text, ',' ORDER BY turn_id))
      FROM subscription_leases lease WHERE provider <> 'xai') AS leases,
    (SELECT md5(string_agg(to_jsonb(waiter)::text, ',' ORDER BY waiter_id))
      FROM subscription_capacity_waiters waiter WHERE provider <> 'xai') AS waiters,
    (SELECT md5(string_agg(to_jsonb(preference)::text, ',' ORDER BY account_id, organization_membership_id))
      FROM subscription_person_preferences preference
      WHERE organization_membership_id <> ${a.om}) AS preferences,
    (SELECT md5(string_agg((to_jsonb(setting) - 'rotation' - 'providers' - 'xai_primary_connection_id'
        - 'xai_primary_provider' - 'version' - 'updated_by_subject_id' - 'updated_at'
        || jsonb_build_object('rotation', setting.rotation - 'xai', 'providers', setting.providers - 'xai'))::text,
        ',' ORDER BY setting.account_id, setting.workspace_id NULLS FIRST))
      FROM subscription_settings setting
      WHERE (setting.account_id = ${a.account} AND (setting.workspace_id IS NULL OR setting.workspace_id = ${a.w1}))
        OR (setting.account_id = ${b.account} AND setting.workspace_id IS NULL)) AS settings`;
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
  "SUB-COMPAT-02 migration 0718: SuperGrok onto the shared subscription core",
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

    test("the drain check refuses a connected writer the role list does not name", async () => {
      const role = `x3_unlisted_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const password = randomUUID();
      const database = new URL(owned.ownerUrl).pathname.slice(1);
      await owned.admin.unsafe(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
      );
      await owned.admin.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
      await owned.admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await owned.admin.unsafe(`GRANT INSERT, UPDATE, DELETE ON sessions TO ${role}`);
      const url = new URL(owned.ownerUrl);
      url.username = role;
      url.password = password;
      const writer = postgres(url.toString(), { max: 1 });
      try {
        await writer`SELECT 1`;
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect(error).toMatchObject({ code: "55000" });
        expect((error as Error).message).toContain(
          "a connected role outside the listed application roles can write moved relations",
        );
      } finally {
        await writer.end();
        await owned.admin.unsafe(`REVOKE ALL ON sessions FROM ${role}`);
        await owned.admin.unsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`);
        await owned.admin.unsafe(`REVOKE ALL ON DATABASE "${database}" FROM ${role}`);
        await owned.admin.unsafe(`DROP ROLE ${role}`);
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
        expect(await abortMessage()).toContain("0718 parity mismatch (live_leases)");
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

    test("a session waiting on both runtimes aborts activation", async () => {
      await withSeedTriggersOff(() =>
        owned.admin`INSERT INTO subscription_capacity_waiters (account_id, workspace_id,
            session_id, turn_id, waiter_id, provider, wait_reason, generation, wake_revision,
            observed_wake_revision, next_check_at, blocked_turn_generation)
          VALUES (${a.account}, ${a.w2}, ${a.s1}, ${a.t1}, ${randomUUID()}, 'codex',
            'no_eligible_capacity', 1, 1, 1, now(), 2)`.then(() => undefined),
      );
      try {
        expect(await abortMessage()).toContain("waiter_conflict");
      } finally {
        await owned.admin`DELETE FROM subscription_capacity_waiters WHERE session_id = ${a.s1}`;
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

    test("two moving pins on one session abort activation", async () => {
      // The legacy unique index makes this unreachable through the runtime;
      // the guard still has to hold if the index were ever missing.
      const definition = await owned.admin<{ definition: string }[]>`SELECT
          pg_get_indexdef('xai_session_account_pins_workspace_session_uq'::regclass) AS definition`;
      await owned.admin`DROP INDEX xai_session_account_pins_workspace_session_uq`;
      const duplicate = randomUUID();
      try {
        await withSeedTriggersOff(() =>
          owned.admin`INSERT INTO xai_session_account_pins (id, account_id, workspace_id,
              session_id, authority_scope, owner_organization_membership_id, pinned_credential_id,
              pin_source, last_credential_id)
            VALUES (${duplicate}, ${a.account}, ${a.w2}, ${a.s1}, 'workspace', NULL, NULL, NULL,
              ${a.x1})`.then(() => undefined),
        );
        expect(await abortMessage()).toContain("pin_pool_ambiguous");
      } finally {
        await owned.admin`DELETE FROM xai_session_account_pins WHERE id = ${duplicate}`;
        await owned.admin.unsafe(definition[0]!.definition);
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
          FROM subscription_connections WHERE provider = 'xai' AND account_id <> ${d.account} ORDER BY id`;
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
        expect(byId.get(a.x3)).toMatchObject({
          scope_kind: "organization",
          allow_personal_workspaces: true,
        });
        expect(byId.get(a.x4)).toMatchObject({
          scope_kind: "workspaces",
          allowed_model_ids: [MODEL],
        });
        for (const id of [a.x5, a.x6]) {
          expect(byId.get(id)).toMatchObject({
            ownership: "personal",
            scope_kind: "people",
            owner: a.om,
          });
        }
        expect(byId.get(a.x8)).toMatchObject({ ownership: "personal", owner: a.bm });
        expect(byId.get(b.y1)).toMatchObject({ ownership: "personal", owner: b.membership });
        expect(byId.get(a.x9)).toMatchObject({
          provider_account_id: null,
          scope_kind: "workspaces",
        });
        // The canonical secret decrypts to the adapter format with the same tokens.
        const secret = decodeSubscriptionCoreXaiCredential(
          decryptEnvironmentValue(key, byId.get(a.x1)!.credential_encrypted),
        );
        expect(secret).toMatchObject({
          accessToken: accessToken("sub-dup"),
          refreshToken: `refresh-${a.x1}`,
        });
        const aliases =
          await owned.admin`SELECT alias_connection_id::text AS alias, connection_id::text AS target
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
        expect(legacy).toEqual({ total: 12, blank: 12 });
        // Quota: one window; the rate-limited exhaustion keeps its kind.
        const quotas =
          await owned.admin`SELECT connection_id::text AS id, quota, selection_count::int AS selection_count
          FROM subscription_connection_quota WHERE connection_id IN (${a.x1}, ${a.x3}, ${a.x9})`;
        const quota = new Map(quotas.map((row) => [row.id, row]));
        expect(quota.get(a.x1)!.selection_count).toBe(8);
        expect(quota.get(a.x1)!.quota.windows[0]).toMatchObject({ usedPercent: 42, status: "ok" });
        expect(quota.get(a.x3)!.quota.exhaustedKind).toBe("quota");
        expect(quota.get(a.x9)!.quota.exhaustedKind).toBe("rate_limit");
      });

      test("generations: one owner with `user` credentials in two workspaces and a Personal one has one current generation", async () => {
        const rows =
          await owned.admin`SELECT connection.owner_organization_membership_id::text AS owner,
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
        const policies =
          await owned.admin`SELECT connection_id::text AS id, workspace_id::text AS workspace,
            inference_pool, allocator_enabled, allowed_model_ids, managed_by_workspace_id::text AS manager
          FROM subscription_connection_assignment_policies policy
          WHERE account_id = ${a.account} AND connection_id IN (${a.x1}, ${a.x4}) ORDER BY id, workspace`;
        expect(policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: a.x1,
              workspace: a.w1,
              inference_pool: "workspace",
              manager: a.w1,
              allowed_model_ids: null,
            }),
            expect.objectContaining({
              id: a.x1,
              workspace: a.w2,
              inference_pool: "workspace",
              manager: a.w2,
              allowed_model_ids: [MODEL],
            }),
            expect.objectContaining({
              id: a.x4,
              workspace: a.w2,
              inference_pool: "organization",
              manager: null,
            }),
          ]),
        );
        const settings =
          await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
            xai_primary_connection_id::text AS primary, personal_fallback_allowed
          FROM subscription_settings WHERE account_id = ${a.account}`;
        const byWorkspace = new Map(settings.map((row) => [row.workspace, row]));
        expect(byWorkspace.get(null)).toMatchObject({
          rotation: { codex: { mode: "primary_first" }, xai: { mode: "primary_first" } },
          primary: a.x3,
        });
        expect(byWorkspace.get(a.w1)).toMatchObject({
          rotation: { codex: { mode: "spread" }, xai: { mode: "primary_first" } },
          providers: {
            codex: { inferenceSource: "organization" },
            xai: { inferenceSource: "workspace", useOrganizationAccounts: false },
          },
          primary: a.x1,
        });
        // Pre-existing rows: only the SuperGrok keys, the version and the
        // writer changed (every other column is hashed in snapshotUntouched).
        const versions =
          await owned.admin`SELECT workspace_id::text AS workspace, version::int AS version,
            codex_primary_connection_id::text AS codex, updated_by_subject_id AS writer
          FROM subscription_settings WHERE account_id = ${a.account}
            AND (workspace_id IS NULL OR workspace_id = ${a.w1})`;
        expect(new Map(versions.map((row) => [row.workspace, row]))).toEqual(
          new Map([
            [
              null,
              {
                workspace: null,
                version: 4,
                codex: a.cx,
                writer: "service:subscription-core-cutover",
              },
            ],
            [
              a.w1,
              {
                workspace: a.w1,
                version: 3,
                codex: null,
                writer: "service:subscription-core-cutover",
              },
            ],
          ]),
        );
        expect(byWorkspace.get(a.w2)).toMatchObject({
          rotation: { xai: { mode: "spread" } },
          providers: { xai: { inferenceSource: "workspace" } },
          primary: null,
        });
        expect(byWorkspace.get(a.w3)!.providers.xai.inferenceSource).toBe("workspace");
        expect(byWorkspace.get(a.pa)).toMatchObject({
          personal_fallback_allowed: true,
          providers: null,
        });
        expect(byWorkspace.has(a.pb)).toBe(false);
        const preferences = await owned.admin`SELECT organization_membership_id::text AS membership,
            personal_fallback_opt_in FROM subscription_person_preferences WHERE account_id = ${a.account}`;
        expect(
          new Set(
            preferences.filter((row) => row.personal_fallback_opt_in).map((row) => row.membership),
          ),
        ).toEqual(new Set([a.om]));
        // Organization B kept its own settings; only the SuperGrok key changed.
        const [orgB] =
          await owned.admin`SELECT personal_connections_allowed, rotation FROM subscription_settings
          WHERE account_id = ${b.account} AND workspace_id IS NULL`;
        expect(orgB).toEqual({
          personal_connections_allowed: false,
          rotation: { xai: { mode: "spread" } },
        });
      });

      test("an organization that locks rotation and providers keeps its workspaces on the locked values, each listed", async () => {
        const settings =
          await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
            xai_primary_connection_id::text AS primary, version::int AS version,
            updated_by_subject_id AS writer
          FROM subscription_settings WHERE account_id = ${d.account} ORDER BY workspace_id NULLS FIRST`;
        const byWorkspace = new Map(settings.map((row) => [row.workspace, row]));
        // The organization row gains the SuperGrok rotation entry as usual.
        expect(byWorkspace.get(null)).toMatchObject({
          rotation: { xai: { mode: "spread" } },
          providers: { xai: { inferenceSource: "organization" } },
          primary: null,
          version: 6,
        });
        // The pre-existing workspace row is not written at all; the workspace
        // without a row gets none.
        expect(byWorkspace.get(d.w1)).toEqual({
          workspace: d.w1,
          rotation: { codex: { mode: "spread" } },
          providers: { codex: { inferenceSource: "organization" } },
          primary: null,
          version: 2,
          writer: null,
        });
        expect(byWorkspace.has(d.w2)).toBe(false);
        // The effective settings of both workspaces follow the organization.
        for (const workspace of [d.w1, d.w2]) {
          const [effective] = await owned.admin`SELECT
              subscription_effective_settings(${d.account}::uuid, ${workspace}::uuid) AS value`;
          expect(effective!.value.values.providers.xai).toMatchObject({
            inferenceSource: "organization",
          });
          expect(effective!.value.values.rotation.xai).toEqual({ mode: "spread" });
          expect(effective!.value.sources.providers.xai).toBe("organization");
          expect(effective!.value.sources.rotation.xai).toBe("organization");
        }
        // The local accounts still moved, assigned to their workspace.
        const [moved] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections
          WHERE account_id = ${d.account} AND provider = 'xai' AND ownership = 'shared'`;
        expect(moved!.total).toBe(2);
        // Parity holds, and the report lists each workspace per locked key.
        const report =
          await owned.admin`SELECT metric, legacy_count::int AS legacy, core_count::int AS core
          FROM opengeni_private.subscription_cutover_report
          WHERE provider = 'xai' AND account_id = ${d.account} ORDER BY metric`;
        expect(report.filter((row) => row.legacy !== row.core)).toEqual([]);
        const metrics = new Map(report.map((row) => [row.metric, row.legacy]));
        expect(metrics.get("locked_workspace_keys_untouched")).toBe(4);
        expect(metrics.has("source_modes")).toBe(false);
        expect(metrics.has("workspace_rotation")).toBe(false);
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
            choice, model_id FROM subscription_session_bindings WHERE provider = 'xai'`;
        const bySession = new Map(bindings.map((row) => [row.session, row]));
        expect(bySession.get(a.s1)).toMatchObject({
          connection: a.x1,
          choice: "explicit",
          model_id: MODEL,
        });
        expect(bySession.get(a.s2)).toMatchObject({ connection: a.x6, choice: "automatic" });
        expect(bySession.get(a.s3)).toMatchObject({ connection: a.x5, choice: "automatic" });
        expect(bySession.get(a.s4)).toMatchObject({ connection: a.x8, choice: "automatic" });
        expect(bySession.has(a.s6)).toBe(false);
        // A session whose current model is SuperGrok takes the SuperGrok
        // binding in place of another provider's; a session whose current
        // model is Codex keeps its Codex binding (hashed in snapshotUntouched).
        expect(bySession.get(a.s9)).toMatchObject({ connection: a.x1, choice: "automatic" });
        expect(bySession.has(a.s8)).toBe(false);
        const [kept] =
          await owned.admin`SELECT provider, connection_id::text AS connection, choice, version::int AS version
          FROM subscription_session_bindings WHERE session_id = ${a.s8}`;
        expect(kept).toEqual({
          provider: "codex",
          connection: a.cx,
          choice: "explicit",
          version: 2,
        });
        const [replaced] =
          await owned.admin`SELECT version::int AS version FROM subscription_session_bindings WHERE session_id = ${a.s9}`;
        expect(replaced!.version).toBe(5);
      });

      test("live leases and waiters keep their fences, ids and pending wakes", async () => {
        const leases =
          await owned.admin`SELECT turn_id::text AS turn, connection_id::text AS connection,
            holder_id, generation::int AS generation FROM subscription_leases WHERE provider = 'xai'`;
        expect([...leases]).toEqual([
          { turn: a.t2, connection: a.x6, holder_id: "attempt-t2", generation: 2 },
        ]);
        const [legacyLeases] =
          await owned.admin`SELECT count(*)::int AS total FROM xai_credential_leases`;
        expect(legacyLeases!.total).toBe(0);
        const waiters =
          await owned.admin`SELECT waiter_id::text AS id, turn_id::text AS turn, generation::int AS generation,
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
            reset_kind: "authoritative",
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
        // The timer and the goal fence the workflow depends on are the legacy row's.
        const [fences] = await owned.admin`SELECT
            core.next_check_at = legacy.next_check_at AS next_check,
            core.earliest_reset_at = legacy.earliest_reset_at AS earliest_reset,
            core.goal_id::text AS goal_id, core.goal_version::int AS goal_version
          FROM subscription_capacity_waiters core
          JOIN xai_capacity_waiters legacy ON legacy.id = core.waiter_id
          WHERE core.provider = 'xai' AND core.waiter_id = ${a.waiter}`;
        expect(fences).toEqual({
          next_check: true,
          earliest_reset: true,
          goal_id: a.goal,
          goal_version: 3,
        });
      });

      test("accepted authority: one record per carrier with exact personal entries; v1 bytes untouched", async () => {
        const records = await owned.admin`SELECT carrier_kind,
            coalesce(turn_id, session_id, scheduled_task_id, system_update_id, outbox_id)::text AS carrier,
            personal, shared_pool, legacy_scope, owner_subject_id
          FROM opengeni_private.subscription_authority_compat WHERE provider = 'xai'`;
        const by = new Map(records.map((row) => [`${row.carrier_kind}:${row.carrier}`, row]));
        const [generation] =
          await owned.admin`SELECT authority_generation FROM subscription_connections WHERE id = ${a.x6}`;
        const g = Number(generation!.authority_generation);
        // Live turns.
        expect(by.get(`session_turn:${a.t1}`)).toMatchObject({
          personal: [],
          shared_pool: "workspace",
          legacy_scope: "workspace",
        });
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
        expect(by.get(`session_initial:${a.s5}`)).toMatchObject({
          shared_pool: "organization",
          legacy_scope: "organization",
        });
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
        expect(by.get(`session_turn:${b.turn}`)).toMatchObject({
          personal: [],
          shared_pool: "none",
          legacy_scope: "user",
        });
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
        expect(
          JSON.parse(decryptEnvironmentValue(key, byId.get(a.video)!.credential_encrypted)),
        ).toEqual({
          kind: "subscription-connection",
          provider: "xai",
          connectionId: a.x1,
        });
        expect(
          JSON.parse(decryptEnvironmentValue(key, byId.get(a.videoUnmapped)!.credential_encrypted)),
        ).toEqual({ kind: "subscription-connection", provider: "xai", connectionId: NIL });
        const [image] =
          await owned.admin`SELECT status FROM image_generation_operations WHERE id = ${a.image}`;
        expect(image!.status).toBe("prepared");
      });

      test("the parity report has every metric equal, with dispositions and impact rows", async () => {
        const report =
          await owned.admin`SELECT metric, account_id::text AS account, legacy_count::int AS legacy,
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
        expect(metric("compat:dependent_sources_without_record")).toMatchObject({
          legacy: 0,
          core: 0,
        });
        expect(metric("video_operations_open")).toMatchObject({ legacy: 2 });
        expect(metric("image_operations_open")).toMatchObject({ legacy: 1 });
        expect(metric("personal_generations")).toMatchObject({ legacy: 2 });
        expect(metric("disposition:waiters_collapsed")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:expired_leases_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:pin_owner_ineligible")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:pin_other_provider_binding_kept")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:user_rotation_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:personal_rotation_dropped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:video_operation_unmapped")).toMatchObject({ legacy: 1 });
        expect(metric("disposition:personal_connections_disallowed", b.account)).toMatchObject({
          legacy: 1,
        });
        expect(
          metric("disposition:compat_personal_connections_disallowed", b.account),
        ).toMatchObject({ legacy: 1 });
        expect(metric("compat:carriers_that_will_wait", b.account)).toMatchObject({ legacy: 1 });
        expect(
          metric("readiness:owners_with_multiple_current_personal_generations", null as never),
        ).toMatchObject({ core: 0 });
        expect(metric("xai_cutover_rows", null as never)).toBeDefined();
        // Only this provider's rows.
        const [others] =
          await owned.admin`SELECT count(*)::int AS total FROM opengeni_private.subscription_cutover_report
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
        // Codex and Claude rows are byte-for-byte unchanged: connections,
        // bindings, leases, waiters, preferences, and the settings columns
        // other than the SuperGrok keys.
        expect(after.core).toBe(before.core);
        expect(after.claude).toBe(before.claude);
        expect(after.bindings).toBe(before.bindings);
        expect(after.leases).toBe(before.leases);
        expect(after.waiters).toBe(before.waiters);
        expect(after.preferences).toBe(before.preferences);
        expect(after.settings).toBe(before.settings);
        expect(before.bindings).not.toBeNull();
        expect(before.leases).not.toBeNull();
        expect(before.waiters).not.toBeNull();
        expect(before.preferences).not.toBeNull();
      });

      test("retrying the ledger is a no-op without the key", async () => {
        await migrateCutover();
        const [count] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections
            WHERE provider = 'xai' AND account_id <> ${d.account}`;
        expect(count!.total).toBe(8);
      }, 180_000);

      test("provisioning withdraws runtime writes on the legacy tables and the posture contract holds", async () => {
        const privileges =
          await owned.admin`SELECT table_name, array_agg(privilege_type ORDER BY privilege_type) AS granted
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

      test("the legacy connect routine cannot write a SuperGrok account after the receipt", async () => {
        // The routine is reachable (EXECUTE is still granted and its checks
        // pass), so each failure is the receipt-gated policy on its insert.
        const connect = (scope: "user" | "workspace") =>
          createXaiSubscriptionCredential(client.db, {
            accountId: a.account,
            workspaceId: a.w1,
            subjectId: a.owner,
            scope,
            encryptionKey: key,
            secret: { version: 1, accessToken: accessToken("sub-after") },
            providerAccountId: "sub-after",
          }).then(
            () => "connected",
            (error: unknown) => errorChain(error),
          );
        expect(await connect("user")).toContain("xai_subscription_authority_closed");
        expect(await connect("workspace")).toContain("xai_subscription_credentials_closed");
        const [count] = await owned.admin`SELECT
            (SELECT count(*)::int FROM xai_subscription_credentials
              WHERE account_id <> ${d.account}) AS credentials,
            (SELECT count(*)::int FROM organization_user_resource_authorities
              WHERE resource_kind = 'xai_subscription') AS authorities`;
        expect(count).toEqual({ credentials: 10, authorities: 4 });
      }, 60_000);

      test("no definer can update a legacy SuperGrok row after the receipt", async () => {
        // The schema owner is what SECURITY DEFINER routines run as; FORCE RLS
        // applies the restrictive `_closed` policies to it (inserts are driven
        // through the connect routine above).
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
            `UPDATE xai_rotation_settings SET fairness_cursor = fairness_cursor + 1 WHERE account_id = '${a.account}'`,
          ),
        ).toContain("xai_rotation_settings_closed");
        expect(
          await asOwner(
            `UPDATE xai_subscription_credentials SET label = 'Renamed' WHERE id = '${a.x1}'`,
          ),
        ).toContain("xai_subscription_credentials_closed");
      }, 60_000);

      test("the legacy disconnect refuses after the receipt and changes nothing", async () => {
        const disconnect = await withSessionRlsActorContext({ subjectId: a.owner }, () =>
          withRlsContext(client.db, { accountId: a.account, workspaceId: a.w1 }, (tx) =>
            rawRows(
              tx,
              sql`select disconnect_xai_subscription_credential(${a.account}::uuid, ${a.w1}::uuid,
                ${a.owner}, ${a.x1}::uuid, '{"version":1,"scope":"workspace"}'::jsonb) as disconnected`,
            ),
          ),
        ).then(
          () => "disconnected",
          (error: unknown) => errorChain(error),
        );
        expect(disconnect).toContain(
          "SuperGrok accounts are disconnected on the shared subscription core after the cutover",
        );
        const [state] = await owned.admin`SELECT
            (SELECT count(*)::int FROM xai_subscription_credentials WHERE id = ${a.x1}) AS legacy,
            (SELECT count(*)::int FROM xai_session_account_pins WHERE last_credential_id = ${a.x1}) AS pins,
            (SELECT status FROM subscription_connections WHERE id = ${a.x1}) AS core`;
        expect(state).toEqual({ legacy: 1, pins: 2, core: "active" });
      }, 60_000);

      test("new work accepted after the cutover carries the owner's current SuperGrok generation", async () => {
        const [generation] =
          await owned.admin`SELECT authority_generation FROM subscription_connections WHERE id = ${a.x6}`;
        const g = Number(generation!.authority_generation);
        const scope = (workspaceId: string) => ({
          accountId: a.account,
          workspaceId,
          subjectId: a.owner,
        });
        const acceptance = (workspaceId: string, sessionId: string) =>
          withSessionRlsActorContext({ subjectId: a.owner }, () =>
            withRlsContext(client.db, scope(workspaceId), async (tx) => {
              const [row] = await rawRows<{ v2: unknown }>(
                tx,
                sql`select opengeni_private.subscription_core_acceptance_authority_v2('xai',
                  ${a.account}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${a.owner}) as v2`,
              );
              return row!.v2;
            }),
          );
        const task = (workspaceId: string) =>
          withSessionRlsActorContext({ subjectId: a.owner }, () =>
            withRlsContext(client.db, scope(workspaceId), async (tx) => {
              const [row] = await rawRows<{ v2: unknown }>(
                tx,
                sql`select opengeni_private.subscription_core_task_authority_v2('xai',
                  ${a.account}::uuid, ${workspaceId}::uuid, null::uuid, ${a.owner}) as v2`,
              );
              return row!.v2;
            }),
          );
        const personal = [{ provider: "xai", ownerMembershipId: a.om, authorityGeneration: g }];
        // The owner's private session in a team workspace and the Personal one.
        expect(await acceptance(a.w1, a.s2)).toMatchObject({ version: 2, personal });
        expect(await acceptance(a.pa, a.s3)).toMatchObject({ version: 2, personal });
        expect(await task(a.pa)).toMatchObject({ version: 2, personal });
      }, 60_000);

      test("pre-cutover schedules and inbox rows read their records as the application role", async () => {
        const read = (kind: string, workspace: string, id: string, revision: number | null) =>
          withRlsContext(
            client.db,
            { accountId: a.account, workspaceId: workspace },
            async (tx) => {
              const [row] = await rawRows<{ authority: Record<string, unknown> | null }>(
                tx,
                sql`select opengeni_private.read_subscription_authority_compat('xai', ${kind},
                ${workspace}::uuid, ${id}::uuid, ${revision}::bigint) as authority`,
              );
              return row!.authority;
            },
          );
        const [task] =
          await owned.admin`SELECT authority_revision FROM scheduled_tasks WHERE id = ${a.taskUser}`;
        const revision = await read(
          "scheduled_task_revision",
          a.w2,
          a.taskUser,
          Number(task!.authority_revision),
        );
        expect(revision).toMatchObject({
          authority: "record",
          legacyScope: "user",
          sharedPool: "none",
        });
        expect((revision!.personal as unknown[]).length).toBe(1);
        expect(await read("session_system_update_outbox", a.w2, a.outbox, null)).toMatchObject({
          authority: "record",
        });
        expect(await read("session_turn", a.w1, a.t2, null)).toMatchObject({ authority: "record" });
      }, 60_000);

      test("a Steer or Cancel ends a migrated SuperGrok wait through the provider-neutral cleanup", async () => {
        const [waiter] =
          await owned.admin`SELECT workspace_id::text AS workspace FROM subscription_capacity_waiters
          WHERE provider = 'xai' AND waiter_id = ${a.waiter}`;
        expect(waiter).toBeDefined();
        const deleted = await withRlsContext(
          client.db,
          { accountId: a.account, workspaceId: waiter!.workspace },
          (tx) =>
            deleteSubscriptionCoreWaitersForTurns(tx, null, {
              workspaceId: waiter!.workspace,
              turnIds: [a.t1],
            }),
        );
        expect(deleted).toBe(1);
        const [left] = await owned.admin`SELECT
            (SELECT count(*)::int FROM subscription_capacity_waiters WHERE provider = 'xai') AS waiters,
            (SELECT count(*)::int FROM subscription_capacity_wake_outbox WHERE account_id = ${a.account}) AS wakes`;
        expect(left).toEqual({ waiters: 0, wakes: 0 });
      }, 60_000);

      test("organization retention deletion of an offboarded member still runs after the receipt", async () => {
        await withSeedTriggersOff(() =>
          owned.admin`UPDATE organization_memberships SET status = 'revoked', revoked_at = now(),
              personal_retention_until = now() - interval '1 day'
            WHERE id = ${a.bm}`.then(() => undefined),
        );
        const operation = randomUUID();
        await owned.admin`INSERT INTO organization_user_retention_deletions (
            account_id, membership_id, retention_until, state, claim_operation_id, claim_expires_at
          ) SELECT account_id, id, personal_retention_until, 'claimed', ${operation}::uuid,
            now() + interval '15 minutes'
          FROM organization_memberships WHERE id = ${a.bm}`;
        const [finalized] = await withSessionRlsActorContext({ subjectId: a.owner }, () =>
          withRlsContext(client.db, { accountId: a.account }, (tx) =>
            rawRows<{ result: { deletedResources: Record<string, number> } }>(
              tx,
              sql`select finalize_organization_retention_deletion(${a.account}::uuid, ${a.bm}::uuid,
                ${operation}::uuid, 'xai-cutover-test-bucket') as result`,
            ),
          ),
        );
        // The member's migrated personal connection is deleted with their
        // Personal workspace. The legacy row stays: the retention delete has no
        // workspace context and the legacy `user` row is not visible to it, the
        // same as before the receipt (its ciphertext is blank since 0718).
        expect(finalized!.result.deletedResources).toMatchObject({
          subscriptionConnections: 1,
          personalWorkspaces: 1,
          xaiSubscriptions: 0,
        });
        const [left] = await owned.admin`SELECT
            (SELECT count(*)::int FROM subscription_connections WHERE id = ${a.x8}) AS core,
            (SELECT credential_encrypted FROM xai_subscription_credentials WHERE id = ${a.x8}) AS legacy`;
        expect(left).toEqual({ core: 0, legacy: "" });
      }, 60_000);

      test("the owner can still delete a legacy SuperGrok row after the receipt", async () => {
        // Deletes stay open on the legacy tables (USING (true) on the `_closed`
        // policies); referential actions null what pointed at the row.
        const deleted = await owner.begin(async (tx) => {
          await tx`SELECT set_config('opengeni.account_id', ${a.account}, true),
            set_config('opengeni.workspace_id', ${a.w3}, true)`;
          return await tx`DELETE FROM xai_subscription_credentials WHERE id = ${a.x9} RETURNING id`;
        });
        expect(deleted).toHaveLength(1);
        const [left] =
          await owned.admin`SELECT count(*)::int AS total FROM xai_subscription_credentials WHERE id = ${a.x9}`;
        expect(left!.total).toBe(0);
      }, 60_000);
    });
  },
);
