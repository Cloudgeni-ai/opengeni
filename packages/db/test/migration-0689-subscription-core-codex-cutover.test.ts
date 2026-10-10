/**
 * Migration 0689: the drained, one-way Codex cutover onto the shared
 * subscription core (design 5.1.1 steps 1-8). The legacy state is seeded as
 * the database superuser (an upgrade fixture, not current admission), the
 * migration runs as the NOSUPERUSER/NOBYPASSRLS schema owner exactly as in
 * production, and runtime behaviour afterward is asserted as the restricted
 * application role `opengeni_app`.
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
import { rawRows } from "../src/database";
import {
  adoptCodexResetRedemptionAttempt,
  assertOrganizationCodexAdministrator,
  claimCodexResetRedemption,
  createDb,
  disconnectSubscriptionCoreCodexConnection,
  fenceSubscriptionCoreCodexResetCredit,
  getSubscriptionCoreCodexCapacityWaitById,
  getSubscriptionCoreCodexWorkspaceProjection,
  nestedPostgresSqlState,
  readCodexCutoverDisposition,
  resolveSubscriptionConnectionId,
  resolveSubscriptionCoreCodexAppsDesignation,
  readSubscriptionCoreCodexResetAuthority,
  wakeSubscriptionCoreCodexCapacityWaiters,
  updateScheduledTask,
  withRlsContext,
  withSessionRlsActorContext,
  type CodexResetRedemptionCredentialAuthority,
  type DbClient,
} from "../src";

const MIGRATION = "0689_subscription_core_codex_cutover.sql";
// 0712 renames and rekeys objects 0689 creates: held back with it and
// replayed right after it, so these cases also cover the provider-keyed
// reach, auto-assignment and plan-change paths on cutover data.
const PROVIDER_KEYED_REACH = "0712_subscription_core_provider_keyed_reach.sql";
const key = Buffer.alloc(32, 72);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

/** A fixture id_token; `person` is the signed-in ChatGPT user (null: unknown). */
function idToken(
  chatgptAccountId: string | null,
  person: string | null = "person-default",
): string {
  const auth: Record<string, string> = {};
  if (chatgptAccountId) auth.chatgpt_account_id = chatgptAccountId;
  if (person) auth.chatgpt_user_id = person;
  const payload = Buffer.from(
    JSON.stringify(Object.keys(auth).length > 0 ? { "https://api.openai.com/auth": auth } : {}),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

const a = {
  account: randomUUID(),
  owner: "user:cutover-owner",
  bob: "user:cutover-bob",
  ownerMembership: randomUUID(),
  bobMembership: randomUUID(),
  personalOwner: randomUUID(),
  personalBob: randomUUID(),
  w1: randomUUID(),
  w2: randomUUID(),
  w3: randomUUID(),
  w4: randomUUID(),
  // Credentials.
  c1: randomUUID(), // W1 local, acct-dup, healthiest: canonical
  c2: randomUUID(), // W2 local, acct-dup, error: alias of c1
  c3: randomUUID(), // organization, all workspaces: organization scope
  c4: randomUUID(), // organization, allowlist [W2], no Personal: enumerated
  c5: randomUUID(), // owner's Personal workspace: personal connection
  c5Alias: randomUUID(), // same personal login, older unhealthy credential
  c6: randomUUID(), // W3 local, no identity anywhere
  restricted: randomUUID(),
  disabledDuplicate: randomUUID(),
  // Sessions and turns.
  s1: randomUUID(), // W2 shared, manual pin on alias c2
  s2: randomUUID(), // W1 shared, last c1, waiting for capacity
  s3: randomUUID(), // owner's Personal workspace, last c5
  s4: randomUUID(), // W1 bob's, manual pin on the owner's personal c5
  s5: randomUUID(), // W3 ownerless, last c6
  t1: randomUUID(),
  t2: randomUUID(),
  t3: randomUUID(),
  t4: randomUUID(),
  t5: randomUUID(),
  t6: randomUUID(),
  waiter: randomUUID(),
  resumedUpdate: randomUUID(),
  taskPersonal: randomUUID(),
  taskShared: randomUUID(),
  update: randomUUID(),
  outbox: randomUUID(),
  // Reset-credit ledger.
  resetStarted: randomUUID(), // W2 on alias c2, provider_started: ambiguous outcome
  resetStartedKey: randomUUID(),
  resetDone: randomUUID(), // W1 on canonical c1, completed reset
  resetOrphan: randomUUID(), // a credential disconnected long ago
};
const b = {
  account: randomUUID(),
  owner: "user:cutover-other-owner",
  membership: randomUUID(),
  personal: randomUUID(),
  w1: randomUUID(),
  c1: randomUUID(),
  session: randomUUID(),
};
const c = { account: randomUUID(), w1: randomUUID() };
// Organization D: people and reach.
const d = {
  account: randomUUID(),
  owner: "user:cutover-d-owner",
  ownerMembership: randomUUID(),
  personalOwner: randomUUID(),
  w1: randomUUID(),
  w2: randomUUID(),
  w3: randomUUID(),
  alice: randomUUID(), // W1 local, one ChatGPT Team workspace, person alice, W1 Apps
  bob: randomUUID(), // W2 local, the same ChatGPT workspace, person bob, W2 Apps
  unknown: randomUUID(), // W3 local, the same ChatGPT workspace, person unknown
  org: randomUUID(), // organization, every workspace
  orgLocal: randomUUID(), // W1 local copy of the organization account (same person)
  allow: randomUUID(), // organization, allowlist [W2] and Personal workspaces
  shared: randomUUID(), // organization, every shared workspace, no Personal workspaces
  later: randomUUID(), // a shared workspace created after the cutover
  laterPersonal: randomUUID(), // a Personal workspace created after the cutover
  laterMembership: randomUUID(),
};

const MODEL = "codex/gpt-5.5";
const policyMetadata = (providerId: string, productModelId: string) => ({
  turnExecutionPolicyV1: { providerId, productModelId },
});
const claudeV1 = { version: 1, scope: "organization" } as const;
const xaiV1 = { version: 1, scope: "workspace" } as const;

let owned: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
const SEEDED_TABLES = [
  "managed_accounts",
  "workspaces",
  "organization_memberships",
  "sessions",
  "session_turns",
  "codex_subscription_credentials",
  "codex_rotation_settings",
  "organization_codex_rotation_settings",
  "workspace_codex_subscription_preferences",
  "codex_apps_settings",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "scheduled_tasks",
  "scheduled_task_revision_authorities",
  "session_system_updates",
  "session_system_update_outbox",
  "model_call_facts",
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
  scope: "workspace" | "organization";
  chatgpt: string | null;
  tokenChatgpt?: string | null;
  person?: string | null;
  status?: string;
  lastRefreshAt?: Date | null;
  allocator?: boolean;
  allowedModels?: string[] | null;
  allowedWorkspaces?: string[] | null;
  allowPersonal?: boolean;
  extra?: Record<string, unknown>;
}) {
  const secret = {
    access_token: `access-${input.id}`,
    refresh_token: `refresh-${input.id}`,
    id_token: idToken(
      input.tokenChatgpt === undefined ? input.chatgpt : input.tokenChatgpt,
      input.person === undefined ? "person-default" : input.person,
    ),
  };
  const admin = owned.admin;
  await admin`INSERT INTO codex_subscription_credentials (
      id, account_id, workspace_id, organization_id, authority_scope, credential_encrypted,
      chatgpt_account_id, plan_type, status, version, last_refresh_at, allocator_enabled,
      allowed_model_ids, allowed_workspace_ids, allow_personal_workspaces, label, account_email,
      connected_by_subject_id, created_at
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace},
      ${input.scope === "organization" ? input.account : null}, ${input.scope},
      ${encryptEnvironmentValue(key, JSON.stringify(secret))}, ${input.chatgpt}, 'pro',
      ${input.status ?? "active"}, 7, ${input.lastRefreshAt ?? null}, ${input.allocator ?? true},
      ${input.allowedModels ?? null}::text[], ${input.allowedWorkspaces ?? null}::uuid[],
      ${input.allowPersonal ?? true}, ${`Label ${input.id.slice(0, 4)}`}, NULL,
      'user:connector', now() - interval '1 day'
    )`;
  if (input.extra && Object.keys(input.extra).length > 0) {
    for (const [column, value] of Object.entries(input.extra)) {
      await admin.unsafe(`UPDATE codex_subscription_credentials SET ${column} = $1 WHERE id = $2`, [
        value as never,
        input.id,
      ]);
    }
  }
  return secret;
}

async function session(input: {
  id: string;
  account: string;
  workspace: string;
  ownerSubject: string | null;
  ownerMembership: string | null;
  visibility?: "user_private" | "workspace_shared";
  pinned?: string | null;
  pinSource?: "manual" | "policy" | null;
  last?: string | null;
}) {
  await owned.admin`INSERT INTO sessions (
      id, account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
      sandbox_backend, sandbox_group_id, root_session_id, nested_agent_depth,
      effective_max_nested_agent_depth, nested_agent_depth_policy_source, tool_policy,
      owner_subject_id, owner_organization_membership_id, visibility,
      codex_pinned_credential_id, codex_pin_source, codex_last_credential_id
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, 'Retained work', ${MODEL}, 'high',
      'standard', 'none', ${input.id}, ${input.id}, 0, 8, 'deployment',
      '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,
      ${input.ownerSubject}, ${input.ownerMembership}, ${input.visibility ?? "workspace_shared"},
      ${input.pinned ?? null}, ${input.pinSource ?? null}, ${input.last ?? null}
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
  codexV1?: Record<string, unknown>;
}) {
  await owned.admin`INSERT INTO session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status,
      source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, metadata,
      initiating_human_subject_id, codex_provider_account_authority_snapshot,
      claude_provider_account_authority_snapshot, xai_provider_account_authority_snapshot,
      execution_generation
    ) VALUES (
      ${input.id}, ${input.account}, ${input.workspace}, ${input.session}, ${randomUUID()},
      ${`session-${input.session}`}, ${input.status}, 'user', ${input.position}, 'Retained prompt',
      ${MODEL}, 'high', 'standard', 'none',
      ${owned.admin.json(policyMetadata("codex-subscription", MODEL))}, ${input.human},
      ${owned.admin.json((input.codexV1 ?? { version: 1, scope: "workspace" }) as never)},
      ${owned.admin.json(claudeV1)}, ${owned.admin.json(xaiV1)}, 2
    )`;
}

async function seed() {
  const admin = owned.admin;
  await withSeedTriggersOff(async () => {
    for (const account of [a.account, b.account, c.account, d.account]) {
      await admin`INSERT INTO managed_accounts (id, name) VALUES (${account}, 'Cutover fixture')`;
    }
    for (const [id, account] of [
      [a.personalOwner, a.account],
      [a.personalBob, a.account],
      [a.w1, a.account],
      [a.w2, a.account],
      [a.w3, a.account],
      [a.w4, a.account],
      [b.personal, b.account],
      [b.w1, b.account],
      [c.w1, c.account],
      [d.personalOwner, d.account],
      [d.w1, d.account],
      [d.w2, d.account],
      [d.w3, d.account],
    ] as const) {
      await admin`INSERT INTO workspaces (id, account_id, name) VALUES (${id}, ${account}, 'Cutover workspace')`;
    }
    for (const [id, account, subject, personal, role] of [
      [a.ownerMembership, a.account, a.owner, a.personalOwner, "owner"],
      [a.bobMembership, a.account, a.bob, a.personalBob, "member"],
      [b.membership, b.account, b.owner, b.personal, "owner"],
      [d.ownerMembership, d.account, d.owner, d.personalOwner, "owner"],
    ] as const) {
      await admin`INSERT INTO organization_memberships (id, account_id, subject_id, status, personal_workspace_id, role)
        VALUES (${id}, ${account}, ${subject}, 'active', ${personal}, ${role})`;
    }

    // Organization A: duplicates, aliases, both pools, Personal workspace.
    await credential({
      id: a.c1,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      chatgpt: "acct-dup",
      lastRefreshAt: new Date(Date.now() - 60_000),
      extra: {
        primary_used_percent: 42,
        primary_reset_at: new Date(Date.now() + 3_600_000),
        usage_checked_at: new Date(Date.now() - 30_000),
        reset_credit_available_count: 2,
        selection_count: 5,
        plan_previous_type: "plus",
        plan_changed_at: new Date(Date.now() - 86_400_000),
        plan_checked_at: new Date(Date.now() - 60_000),
        plan_entitlement_exclusion: {
          planType: "pro",
          models: [
            { modelId: "codex/gpt-5", excludedAt: new Date(Date.now() - 3_600_000).toISOString() },
          ],
        },
      },
    });
    await credential({
      id: a.c2,
      account: a.account,
      workspace: a.w2,
      scope: "workspace",
      chatgpt: "acct-dup",
      status: "error",
      lastRefreshAt: new Date(Date.now() - 600_000),
      allocator: false,
      allowedModels: ["codex/gpt-5"],
      extra: { selection_count: 3 },
    });
    await credential({
      id: a.c3,
      account: a.account,
      workspace: null,
      scope: "organization",
      chatgpt: "acct-org",
      extra: {
        exhausted_until: new Date(Date.now() + 1_800_000),
        exhausted_kind: "quota",
        is_fedramp: false,
      },
    });
    await credential({
      id: a.c4,
      account: a.account,
      workspace: null,
      scope: "organization",
      chatgpt: "acct-list",
      allowedWorkspaces: [a.w2],
      allowPersonal: false,
      allowedModels: ["codex/gpt-5.5"],
    });
    await credential({
      id: a.c5,
      account: a.account,
      workspace: a.personalOwner,
      scope: "workspace",
      chatgpt: "acct-personal",
      extra: { extra_credits_enabled: true, extra_credits_version: 2 },
    });
    await credential({
      id: a.c6,
      account: a.account,
      workspace: a.w3,
      scope: "workspace",
      chatgpt: null,
    });
    await credential({
      id: a.restricted,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      chatgpt: "acct-policy-pair",
      allowedModels: [MODEL],
      extra: { extra_credits_enabled: true, extra_credits_version: 3 },
    });
    await credential({
      id: a.disabledDuplicate,
      account: a.account,
      workspace: a.w1,
      scope: "workspace",
      chatgpt: null,
      tokenChatgpt: "acct-policy-pair",
      allocator: false,
      status: "error",
      extra: { extra_credits_enabled: false },
    });
    await credential({
      id: a.c5Alias,
      account: a.account,
      workspace: a.personalOwner,
      scope: "workspace",
      chatgpt: null,
      tokenChatgpt: "acct-personal",
      extra: { extra_credits_enabled: true, extra_credits_version: 2 },
      status: "error",
      lastRefreshAt: new Date(Date.now() - 600_000),
    });
    await admin`INSERT INTO codex_rotation_settings (account_id, workspace_id, active_credential_id, rotation_enabled)
      VALUES (${a.account}, ${a.w1}, ${a.c1}, true),
             (${a.account}, ${a.w2}, ${a.c2}, false),
             (${a.account}, ${a.personalOwner}, ${a.c5}, false)`;
    await admin`INSERT INTO organization_codex_rotation_settings (account_id, active_credential_id, rotation_enabled)
      VALUES (${a.account}, ${a.c3}, false)`;
    await admin`INSERT INTO workspace_codex_subscription_preferences (workspace_id, account_id, mode)
      VALUES (${a.w2}, ${a.account}, 'workspace'), (${a.w3}, ${a.account}, 'organization'),
             (${a.w4}, ${a.account}, 'disabled')`;
    await admin`INSERT INTO codex_apps_settings (account_id, workspace_id, credential_id, version, designated_at)
      VALUES (${a.account}, ${a.w2}, ${a.c2}, 3, now() - interval '1 hour'),
             (${a.account}, ${a.personalOwner}, ${a.c5}, 2, now() - interval '1 hour')`;
    await admin`INSERT INTO codex_reset_redemption_attempts (
        id, account_id, workspace_id, credential_id, subject_id, browser_session_hash, credit_id,
        upstream_idempotency_key, status, outcome, claim_holder_id, claim_expires_at,
        confirmation_expires_at, provider_started_at, completed_at, retry_count
      ) VALUES
        (${a.resetStarted}, ${a.account}, ${a.w2}, ${a.c2}, ${a.owner}, 'browser-hash-1',
         'credit-started', ${a.resetStartedKey}, 'provider_started', NULL, NULL, NULL,
         now() + interval '10 minutes', now() - interval '2 minutes', NULL, 1),
        (${a.resetDone}, ${a.account}, ${a.w1}, ${a.c1}, ${a.owner}, 'browser-hash-1',
         'credit-done', ${randomUUID()}, 'completed', 'reset', NULL, NULL,
         now() - interval '1 day', now() - interval '1 day', now() - interval '1 day', 0),
        (${a.resetOrphan}, ${a.account}, ${a.w1}, ${randomUUID()}, ${a.owner}, 'browser-hash-1',
         'credit-orphan', ${randomUUID()}, 'completed', 'noCredit', NULL, NULL,
         now() - interval '9 days', now() - interval '9 days', now() - interval '9 days', 0)`;

    await session({
      id: a.s1,
      account: a.account,
      workspace: a.w2,
      ownerSubject: a.owner,
      ownerMembership: a.ownerMembership,
      pinned: a.c2,
      pinSource: "manual",
      last: a.c2,
    });
    await session({
      id: a.s2,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.owner,
      ownerMembership: a.ownerMembership,
      last: a.c1,
    });
    await session({
      id: a.s3,
      account: a.account,
      workspace: a.personalOwner,
      ownerSubject: a.owner,
      ownerMembership: a.ownerMembership,
      visibility: "user_private",
      last: a.c5,
    });
    await session({
      id: a.s4,
      account: a.account,
      workspace: a.w1,
      ownerSubject: a.bob,
      ownerMembership: a.bobMembership,
      pinned: a.c5,
      pinSource: "manual",
    });
    await session({
      id: a.s5,
      account: a.account,
      workspace: a.w3,
      ownerSubject: null,
      ownerMembership: null,
      last: a.c6,
    });
    await turn({
      id: a.t1,
      account: a.account,
      workspace: a.w2,
      session: a.s1,
      status: "running",
      position: 1,
      human: a.owner,
    });
    await turn({
      id: a.t5,
      account: a.account,
      workspace: a.w2,
      session: a.s1,
      status: "completed",
      position: 0,
      human: a.owner,
    });
    await turn({
      id: a.t2,
      account: a.account,
      workspace: a.w1,
      session: a.s2,
      status: "waiting_capacity",
      position: 1,
      human: a.owner,
    });
    await turn({
      id: a.t3,
      account: a.account,
      workspace: a.personalOwner,
      session: a.s3,
      status: "queued",
      position: 1,
      human: a.owner,
    });
    await turn({
      id: a.t4,
      account: a.account,
      workspace: a.w1,
      session: a.s4,
      status: "queued",
      position: 1,
      human: a.bob,
    });
    await turn({
      id: a.t6,
      account: a.account,
      workspace: a.w3,
      session: a.s5,
      status: "queued",
      position: 1,
      human: null,
    });
    await admin`INSERT INTO model_call_facts (account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api, model, billing_path, occurred_at)
      VALUES (${a.account}, ${a.w2}, ${a.s1}, ${a.t5}, 'fixture-fact', 'codex-subscription', 'responses', ${MODEL}, 'external', now() - interval '5 minutes')`;
    await admin`INSERT INTO codex_credential_leases (account_id, workspace_id, credential_id, turn_id, holder_id, generation, leased_until)
      VALUES (${a.account}, ${a.w2}, ${a.c2}, ${a.t1}, 'attempt-t1', 3, now() + interval '10 minutes'),
             (${a.account}, ${a.w1}, ${a.c1}, ${a.t4}, 'attempt-expired', 1, now() - interval '1 minute')`;
    await admin`INSERT INTO session_system_updates (id, account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, state)
      VALUES (${a.resumedUpdate}, ${a.account}, ${a.w1}, ${a.s2}, 'child_terminal_result', 'resumed-source', 'resumed-update', 'Resumed', 'cancelled'),
             (${a.update}, ${a.account}, ${a.w2}, ${a.s1}, 'child_terminal_result', 'pending-source', 'pending-update', 'Pending', 'pending')`;
    await admin`INSERT INTO codex_capacity_waiters (
        id, account_id, workspace_id, session_id, blocked_turn_id, workflow_id, generation, status,
        policy_hash, earliest_reset_at, next_check_at, reset_kind, refresh_attempt, wake_revision,
        observed_wake_revision, last_wake_reason, resumed_update_id, blocked_turn_generation
      ) VALUES (
        ${a.waiter}, ${a.account}, ${a.w1}, ${a.s2}, ${a.t2}, ${`session-${a.s2}`}, 2, 'waiting',
        'policy-hash', now() + interval '30 minutes', now() + interval '1 minute', 'authoritative', 1,
        5, 4, 'usage_refreshed', ${a.resumedUpdate}, 2
      )`;
    await admin`INSERT INTO session_system_update_outbox (id, account_id, workspace_id, source_session_id, target_session_id, dedupe_key, kind, classification, source_id, summary, payload)
      VALUES (${a.outbox}, ${a.account}, ${a.w2}, ${a.s1}, ${a.s1}, 'cutover-outbox', 'child_terminal_result', 'result', 'outbox-source', 'Outbox', '{"type":"child_terminal_result"}'::jsonb)`;
    for (const [id, workspace, subject] of [
      [a.taskPersonal, a.personalOwner, a.owner],
      [a.taskShared, a.w1, a.bob],
    ] as const) {
      await admin`INSERT INTO scheduled_tasks (id, account_id, workspace_id, name, schedule, temporal_schedule_id, execution_digest, agent_config, owner_subject_id, created_by_kind, created_by_subject_id)
        VALUES (${id}, ${a.account}, ${workspace}, 'Cutover task', '{}'::jsonb, ${`schedule-${id}`}, ${"0".repeat(64)}, ${admin.json({ model: MODEL })}, ${subject}, 'subject', ${subject})`;
      await admin`update scheduled_tasks task set execution_digest = scheduled_task_execution_digest(task) where id = ${id}`;
      await admin`INSERT INTO scheduled_task_revision_authorities (task_id, task_authority_revision, account_id, workspace_id, subject_id, organization_membership_id, membership_authorization_revision, execution_digest)
        SELECT ${id}, task.authority_revision, ${a.account}, ${workspace}, ${subject},
          ${subject === a.owner ? a.ownerMembership : a.bobMembership}, 1, task.execution_digest
        FROM scheduled_tasks task WHERE task.id = ${id}`;
    }

    // Organization D: three people's logins of one ChatGPT Team workspace (one
    // person unknown), an organization account with a local copy, and two
    // organization accounts whose reach covers workspaces created later.
    for (const [id, workspace, person] of [
      [d.alice, d.w1, "person-alice"],
      [d.bob, d.w2, "person-bob"],
      [d.unknown, d.w3, null],
    ] as const) {
      await credential({
        id,
        account: d.account,
        workspace,
        scope: "workspace",
        chatgpt: "acct-team",
        person,
      });
    }
    for (const [workspace, credentialId] of [
      [d.w1, d.alice],
      [d.w2, d.bob],
    ] as const) {
      await admin`INSERT INTO codex_apps_settings (account_id, workspace_id, credential_id, version, designated_at)
        VALUES (${d.account}, ${workspace}, ${credentialId}, 1, now())`;
    }
    await credential({
      id: d.org,
      account: d.account,
      workspace: null,
      scope: "organization",
      chatgpt: "acct-org-d",
      lastRefreshAt: new Date(Date.now() - 60_000),
    });
    await credential({
      id: d.orgLocal,
      account: d.account,
      workspace: d.w1,
      scope: "workspace",
      chatgpt: "acct-org-d",
      allowedModels: ["codex/gpt-5"],
      lastRefreshAt: new Date(Date.now() - 3_600_000),
    });
    await credential({
      id: d.allow,
      account: d.account,
      workspace: null,
      scope: "organization",
      chatgpt: "acct-allow",
      allowedWorkspaces: [d.w2],
      allowPersonal: true,
    });
    await credential({
      id: d.shared,
      account: d.account,
      workspace: null,
      scope: "organization",
      chatgpt: "acct-shared",
      allowPersonal: false,
      allocator: false,
    });

    // Organization B: one workspace credential and an explicit pin.
    await credential({
      id: b.c1,
      account: b.account,
      workspace: b.w1,
      scope: "workspace",
      chatgpt: "acct-b",
    });
    await session({
      id: b.session,
      account: b.account,
      workspace: b.w1,
      ownerSubject: b.owner,
      ownerMembership: b.membership,
      pinned: b.c1,
      pinSource: "manual",
    });
  });
}

async function noPartialCutover() {
  const [state] = await owned.admin`SELECT
    (SELECT count(*)::int FROM subscription_connections WHERE provider = 'codex') AS connections,
    (SELECT count(*)::int FROM subscription_provider_cutovers WHERE provider = 'codex') AS cutovers,
    (SELECT count(*)::int FROM codex_subscription_credentials WHERE credential_encrypted = '') AS wiped,
    (SELECT count(*)::int FROM codex_capacity_waiters WHERE status = 'waiting') AS waiting,
    to_regprocedure('opengeni_private.subscription_codex_cutover_v1_active()') AS receipt,
    to_regclass('opengeni_private.subscription_codex_cutover_report') AS report,
    (SELECT count(*)::int FROM scheduled_tasks WHERE subscription_authority IS NOT NULL) AS frozen_tasks,
    (SELECT count(*)::int FROM session_system_updates WHERE subscription_authority IS NOT NULL) AS frozen_updates`;
  expect(state).toMatchObject({
    connections: 0,
    cutovers: 0,
    wiped: 0,
    waiting: 1,
    receipt: null,
    report: null,
    frozen_tasks: 0,
    frozen_updates: 0,
  });
  const forced = await owned.admin`SELECT relname FROM pg_class
    WHERE relname IN ('codex_subscription_credentials', 'subscription_connections', 'session_turns')
      AND NOT relforcerowsecurity`;
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

describe.skipIf(!realDb)(
  "SUB-COMPAT-01 migration 0689: Codex onto the shared subscription core",
  () => {
    beforeAll(async () => {
      const fixture = await acquireOwnerMigratedTestDatabase("codex-core-cutover");
      if (!fixture) throw new Error("Real PostgreSQL required");
      owned = fixture;
      owner = postgres(owned.ownerUrl, { max: 1 });
      await owner`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await owner`INSERT INTO schema_migrations(name) VALUES(${MIGRATION}), (${PROVIDER_KEYED_REACH})`;
      await migrate(owned.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
      await owner`DELETE FROM schema_migrations WHERE name IN (${MIGRATION}, ${PROVIDER_KEYED_REACH})`;
      await seed();
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
      expect(wrong).toBeInstanceOf(Error);
      expect((wrong as Error).message).toBe(
        "Codex subscription cutover could not decode a legacy credential",
      );
      expect((wrong as Error).message).not.toContain("refresh-");
      await noPartialCutover();
    }, 180_000);

    test("a failed core write leaves no secret, label or identity in the error", async () => {
      // Force the driver to fail on the first credential insert: postgres.js
      // attaches that statement's parameters (ciphertext, label, identity)
      // to its error; none of it may leave the migration.
      await owned.admin`ALTER TABLE subscription_connections
        ADD CONSTRAINT codex_cutover_forced_failure CHECK (provider <> 'codex') NOT VALID`;
      try {
        const failed = await migrateCutover({ key }).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(Error);
        const error = failed as Error & Record<string, unknown>;
        expect(error.message).toBe(
          "Codex subscription cutover could not write the shared core (SQLSTATE 23514, codex_cutover_forced_failure); see the runbook",
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
        for (const secret of ["access-", "refresh-", "Label ", "acct-", "person-", "v1:"]) {
          expect(everything).not.toContain(secret);
        }
        expect((error as { parameters?: unknown }).parameters).toBeUndefined();
      } finally {
        await owned.admin`ALTER TABLE subscription_connections
          DROP CONSTRAINT codex_cutover_forced_failure`;
      }
      await noPartialCutover();
    }, 180_000);

    test("identity ambiguity aborts before any mutation", async () => {
      const extra = randomUUID();
      await withSeedTriggersOff(async () => {
        await credential({
          id: extra,
          account: b.account,
          workspace: b.personal,
          scope: "workspace",
          chatgpt: "acct-column",
          tokenChatgpt: "acct-token",
        });
      });
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("provider_identity_mismatch");
        expect((error as Error).message).not.toContain("acct-");
        await noPartialCutover();
      } finally {
        await owned.admin`DELETE FROM codex_subscription_credentials WHERE id = ${extra}`;
      }
    }, 180_000);

    test("a parity mismatch rolls the activation back", async () => {
      // A rule silently drops moved leases, which only the parity check can see.
      await owned.admin`CREATE RULE codex_cutover_parity_probe AS ON INSERT TO subscription_leases DO INSTEAD NOTHING`;
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect((error as Error).message).toContain("0689 parity mismatch (live_leases)");
        await noPartialCutover();
      } finally {
        await owned.admin`DROP RULE codex_cutover_parity_probe ON subscription_leases`;
      }
    }, 180_000);

    test("ambiguous session ownership on live work aborts activation", async () => {
      // A live turn in a session whose owner subject is not its membership's
      // subject: no owner can be derived, so nothing may be minted for it.
      const ambiguous = randomUUID();
      const live = randomUUID();
      await withSeedTriggersOff(async () => {
        await session({
          id: ambiguous,
          account: a.account,
          workspace: a.w1,
          ownerSubject: a.owner,
          ownerMembership: a.bobMembership,
        });
        await turn({
          id: live,
          account: a.account,
          workspace: a.w1,
          session: ambiguous,
          status: "queued",
          position: 1,
          human: a.owner,
        });
      });
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("session_owner_ambiguous");
        await noPartialCutover();
      } finally {
        await withSeedTriggersOff(async () => {
          await owned.admin`DELETE FROM session_turns WHERE id = ${live}`;
          await owned.admin`DELETE FROM sessions WHERE id = ${ambiguous}`;
        });
      }
    }, 180_000);

    test("two credit-holding redemption attempts meeting on one canonical credit abort activation", async () => {
      // The canonical c1 already holds an open attempt in W2 for the same
      // provider credit that the alias c2's provider_started attempt holds.
      const competing = randomUUID();
      await owned.admin`INSERT INTO codex_reset_redemption_attempts (
          id, account_id, workspace_id, credential_id, subject_id, browser_session_hash,
          credit_id, status, confirmation_expires_at
        ) VALUES (${competing}, ${a.account}, ${a.w2}, ${a.c1}, ${a.owner}, 'browser-hash-2',
          'credit-started', 'processing', now() + interval '10 minutes')`;
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("reset_redemption_credit_ambiguous");
        expect((error as Error).message).not.toContain("credit-started");
        await noPartialCutover();
        const [kept] = await owned.admin`SELECT credential_id::text AS credential
          FROM codex_reset_redemption_attempts WHERE id = ${a.resetStarted}`;
        expect(kept!.credential).toBe(a.c2);
      } finally {
        await owned.admin`DELETE FROM codex_reset_redemption_attempts WHERE id = ${competing}`;
      }
    }, 180_000);

    test("pre-existing core Codex state is refused", async () => {
      // (kept before the ledger case so both leave the seed untouched)
      const [row] = await owned.admin<{ id: string }[]>`INSERT INTO subscription_connections
      (account_id, provider, credential_encrypted, ownership, scope_kind)
      VALUES (${c.account}, 'codex', 'x', 'shared', 'organization') RETURNING id::text`;
      try {
        const error = await migrateCutover({ key }).catch((caught: Error) => caught);
        expect((error as Error).message).toContain("refuses pre-existing core Codex state");
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

      test("step 2: one canonical connection per upstream identity, aliases and readable secrets", async () => {
        const connections =
          await owned.admin`SELECT id::text, account_id::text, provider_account_id,
          status, ownership, scope_kind, allow_personal_workspaces, managed_by_workspace_id::text,
          allocator_enabled, allowed_model_ids, refresh_generation, credential_encrypted,
          owner_organization_membership_id::text AS owner, authority_generation, provider_state
        FROM subscription_connections WHERE provider = 'codex' ORDER BY id`;
        const byId = new Map(connections.map((row) => [row.id, row]));
        // A: c1 (with alias c2), c3, c4, c5, c6; B: c1; D: alice, bob, the
        // unknown person, org (with alias orgLocal), allow, shared.
        expect(connections).toHaveLength(13);
        expect(byId.has(a.c2)).toBe(false);
        expect(byId.get(a.c1)).toMatchObject({
          provider_account_id: "acct-dup",
          status: "active",
          ownership: "shared",
          scope_kind: "workspaces",
          allow_personal_workspaces: false,
          managed_by_workspace_id: null,
          allocator_enabled: true,
          allowed_model_ids: null,
          refresh_generation: "7",
        });
        expect(byId.get(a.c1)!.provider_state).toMatchObject({ resetCreditAvailableCount: 2 });
        expect(byId.get(a.c3)).toMatchObject({
          scope_kind: "organization",
          allow_personal_workspaces: true,
        });
        expect(byId.get(a.c4)).toMatchObject({
          scope_kind: "workspaces",
          allowed_model_ids: ["codex/gpt-5.5"],
        });
        expect(byId.get(a.c5)).toMatchObject({
          ownership: "personal",
          scope_kind: "people",
          owner: a.ownerMembership,
          authority_generation: "1",
        });
        expect(byId.get(a.c6)).toMatchObject({
          provider_account_id: null,
          managed_by_workspace_id: a.w3,
        });
        for (const row of connections) {
          const plaintext = JSON.parse(decryptEnvironmentValue(key, row.credential_encrypted));
          expect(plaintext.access_token).toBe(`access-${row.id}`);
          expect(Object.keys(plaintext).sort()).toEqual([
            "access_token",
            "id_token",
            "refresh_token",
          ]);
        }
        const aliases =
          await owned.admin`SELECT alias_connection_id::text AS alias, connection_id::text AS target
        FROM subscription_connection_aliases WHERE provider = 'codex'`;
        expect(new Set(aliases.map((row) => `${row.alias}>${row.target}`))).toEqual(
          new Set([
            `${a.c2}>${a.c1}`,
            `${a.c5Alias}>${a.c5}`,
            `${d.orgLocal}>${d.org}`,
            `${a.disabledDuplicate}>${a.restricted}`,
          ]),
        );
        const wiped =
          await owned.admin`SELECT count(*)::int AS total FROM codex_subscription_credentials
        WHERE credential_encrypted <> ''`;
        expect(wiped[0]!.total).toBe(0);
        const [authority] =
          await owned.admin`SELECT generation, status, resource_kind, origin_workspace_id::text AS origin
        FROM organization_user_resource_authorities WHERE resource_id = ${a.c5}`;
        expect(authority).toMatchObject({
          generation: "1",
          status: "active",
          resource_kind: "subscription_connection",
          origin: a.personalOwner,
        });
      });

      test("disabled unrestricted duplicates cannot broaden allocation or extra-credit consent", async () => {
        const [policy] = await owned.admin`select allocator_enabled, allowed_model_ids
          from subscription_connection_assignment_policies where connection_id = ${a.restricted}::uuid`;
        expect(policy).toMatchObject({ allocator_enabled: true, allowed_model_ids: [MODEL] });
        const [consent] = await owned.admin`select extra_credits_enabled, extra_credits_version
          from subscription_connections where id = ${a.restricted}::uuid`;
        expect(consent).toMatchObject({ extra_credits_enabled: false, extra_credits_version: 3 });
        const [retained] = await owned.admin`select extra_credits_enabled, extra_credits_version
          from subscription_connections where id = ${a.c5}::uuid`;
        expect(retained).toMatchObject({ extra_credits_enabled: true, extra_credits_version: 2 });
      });

      test("step 3: assignments keep each source's exact pool policy, manager and quota facts", async () => {
        const policies =
          await owned.admin`SELECT connection_id::text AS connection, workspace_id::text AS workspace,
          inference_pool AS pool, allocator_enabled, allowed_model_ids, managed_by_workspace_id::text AS manager
        FROM subscription_connection_assignment_policies ORDER BY connection_id, workspace_id, inference_pool`;
        expect(policies).toContainEqual({
          connection: a.c1,
          workspace: a.w1,
          pool: "workspace",
          allocator_enabled: true,
          allowed_model_ids: null,
          manager: a.w1,
        });
        expect(policies).toContainEqual({
          connection: a.c1,
          workspace: a.w2,
          pool: "workspace",
          allocator_enabled: false,
          allowed_model_ids: ["codex/gpt-5"],
          manager: a.w2,
        });
        expect(policies).toContainEqual({
          connection: a.c4,
          workspace: a.w2,
          pool: "organization",
          allocator_enabled: true,
          allowed_model_ids: ["codex/gpt-5.5"],
          manager: null,
        });
        expect(policies.filter((policy) => policy.connection === a.c3)).toHaveLength(0);
        const assignments =
          await owned.admin`SELECT connection_id::text AS connection, workspace_id::text AS workspace
        FROM subscription_connection_workspaces ORDER BY connection_id, workspace_id`;
        expect(assignments).toContainEqual({ connection: a.c4, workspace: a.w2 });
        expect(assignments.filter((row) => row.connection === a.c4)).toHaveLength(1);
        const [quota] = await owned.admin`SELECT quota, observed_refresh_generation, selection_count
        FROM subscription_connection_quota WHERE connection_id = ${a.c1}`;
        expect(quota!.observed_refresh_generation).toBe("7");
        expect(quota!.selection_count).toBe("8");
        expect(quota!.quota.windows[0]).toMatchObject({
          id: "primary",
          usedPercent: 42,
          status: "ok",
        });
        const [unknown] =
          await owned.admin`SELECT observed_refresh_generation FROM subscription_connection_quota
        WHERE connection_id = ${a.c4}`;
        expect(unknown!.observed_refresh_generation).toBeNull();
        const [exhausted] =
          await owned.admin`SELECT quota FROM subscription_connection_quota WHERE connection_id = ${a.c3}`;
        expect(exhausted!.quota.exhaustedKind).toBe("quota");
        expect(
          exhausted!.quota.windows.every(
            (window: { status: string }) => window.status === "unknown",
          ),
        ).toBe(true);
      });

      test("step 4: settings from the effective legacy source and rotation", async () => {
        const rows = await owned.admin`SELECT workspace_id::text AS workspace, rotation, providers,
          codex_primary_connection_id::text AS primary, personal_fallback_allowed
        FROM subscription_settings WHERE account_id = ${a.account}`;
        const by = (workspace: string | null) => rows.find((row) => row.workspace === workspace);
        expect(by(null)).toMatchObject({
          rotation: { codex: { mode: "primary_first" } },
          primary: a.c3,
        });
        expect(by(a.w1)).toMatchObject({
          rotation: { codex: { mode: "spread" } },
          providers: null,
        });
        expect(by(a.w2)).toMatchObject({
          rotation: { codex: { mode: "primary_first" } },
          primary: a.c1,
          providers: { codex: { inferenceSource: "workspace", useOrganizationAccounts: false } },
        });
        expect(by(a.w3)).toMatchObject({
          rotation: null,
          providers: { codex: { inferenceSource: "organization" } },
        });
        expect(by(a.w4)).toMatchObject({ providers: { codex: { enabled: false } } });
        expect(by(a.personalOwner)).toMatchObject({
          rotation: null,
          personal_fallback_allowed: true,
        });
        const [preference] =
          await owned.admin`SELECT personal_fallback_opt_in FROM subscription_person_preferences
        WHERE organization_membership_id = ${a.ownerMembership}`;
        expect(preference!.personal_fallback_opt_in).toBe(true);
        const [orgC] = await owned.admin`SELECT rotation FROM subscription_settings
        WHERE account_id = ${c.account} AND workspace_id IS NULL`;
        expect(orgC!.rotation).toEqual({ codex: { mode: "spread" } });
      });

      test("step 5: pins and last accounts become bindings through aliases", async () => {
        const bindings =
          await owned.admin`SELECT session_id::text AS session, connection_id::text AS connection,
          choice, model_id, last_model_call_at IS NOT NULL AS has_call
        FROM subscription_session_bindings ORDER BY session_id`;
        const by = (sessionId: string) => bindings.find((row) => row.session === sessionId);
        expect(by(a.s1)).toMatchObject({
          connection: a.c1,
          choice: "explicit",
          model_id: MODEL,
          has_call: true,
        });
        expect(by(a.s2)).toMatchObject({ connection: a.c1, choice: "automatic", has_call: false });
        expect(by(a.s3)).toMatchObject({ connection: a.c5, choice: "automatic" });
        expect(by(a.s4)).toBeUndefined();
        expect(by(a.s5)).toBeUndefined();
        expect(by(b.session)).toMatchObject({ connection: b.c1, choice: "explicit" });
      });

      test("step 6: live leases and waiters keep their fences and ids", async () => {
        const leases =
          await owned.admin`SELECT turn_id::text AS turn, connection_id::text AS connection,
          holder_id, generation FROM subscription_leases`;
        expect([...leases]).toEqual([
          { turn: a.t1, connection: a.c1, holder_id: "attempt-t1", generation: "3" },
        ]);
        const [waiter] =
          await owned.admin`SELECT waiter_id::text AS id, turn_id::text AS turn, generation,
          wake_revision, observed_wake_revision, blocked_turn_generation, refresh_attempt, reset_kind,
          resumed_update_id::text AS resumed, wait_reason, policy_hash
        FROM subscription_capacity_waiters`;
        expect(waiter).toMatchObject({
          id: a.waiter,
          turn: a.t2,
          generation: "2",
          wake_revision: "5",
          observed_wake_revision: "4",
          blocked_turn_generation: "2",
          refresh_attempt: 1,
          reset_kind: "authoritative",
          resumed: a.resumedUpdate,
          wait_reason: "no_eligible_capacity",
          policy_hash: "policy-hash",
        });
        const [legacy] =
          await owned.admin`SELECT status FROM codex_capacity_waiters WHERE id = ${a.waiter}`;
        expect(legacy!.status).toBe("superseded");
      });

      test("step 6: v2 authority only for exact owner-caused work; v1 bytes untouched", async () => {
        const turns = await owned.admin`SELECT id::text, subscription_authority AS v2,
          claude_provider_account_authority_snapshot AS claude, xai_provider_account_authority_snapshot AS xai
        FROM session_turns WHERE account_id = ${a.account}`;
        const by = (id: string) => turns.find((row) => row.id === id)!;
        const empty = { version: 2, personal: [] };
        expect(by(a.t3).v2).toEqual({
          version: 2,
          personal: [
            { provider: "codex", ownerMembershipId: a.ownerMembership, authorityGeneration: 1 },
          ],
        });
        for (const id of [a.t1, a.t2, a.t4, a.t6]) expect(by(id).v2).toEqual(empty);
        expect(by(a.t5).v2).toBeNull();
        for (const row of turns) {
          expect(row.claude).toEqual(claudeV1);
          expect(row.xai).toEqual(xaiV1);
        }
        const tasks = await owned.admin`SELECT task.id::text, task.subscription_authority AS v2,
          revision.subscription_authority AS revision_v2
        FROM scheduled_tasks task JOIN scheduled_task_revision_authorities revision ON revision.task_id = task.id`;
        expect(tasks.find((row) => row.id === a.taskPersonal)).toMatchObject({
          v2: {
            version: 2,
            personal: [
              { provider: "codex", ownerMembershipId: a.ownerMembership, authorityGeneration: 1 },
            ],
          },
        });
        expect(tasks.find((row) => row.id === a.taskShared)).toMatchObject({
          v2: empty,
          revision_v2: empty,
        });
        const [update] =
          await owned.admin`SELECT subscription_authority AS v2 FROM session_system_updates WHERE id = ${a.update}`;
        expect(update!.v2).toEqual(empty);
        const [outbox] =
          await owned.admin`SELECT subscription_authority AS v2 FROM session_system_update_outbox WHERE id = ${a.outbox}`;
        expect(outbox!.v2).toEqual(empty);
      });

      test("backfilled personal authority does not change the next rename or pause digest", async () => {
        const [before] = await owned.admin`select execution_digest, authority_revision
          from scheduled_tasks where id = ${a.taskPersonal}`;
        for (const patch of [
          { name: "renamed after backfill" },
          { status: "paused" as const },
          { status: "active" as const },
        ]) {
          await withSessionRlsActorContext({ subjectId: a.owner }, () =>
            updateScheduledTask(client.db, a.personalOwner, a.taskPersonal, patch),
          );
          const [after] = await owned.admin`select execution_digest, authority_revision,
            scheduled_task_execution_digest(task) as computed from scheduled_tasks task where id = ${a.taskPersonal}`;
          expect(after).toMatchObject(before!);
          expect(after!.computed).toBe(before!.execution_digest);
        }
      });

      test("step 7: the parity report covers every organization and source", async () => {
        const report =
          await owned.admin`SELECT account_id::text AS account, metric, legacy_count, core_count
        FROM opengeni_private.subscription_codex_cutover_report`;
        const parity = report.filter((row) => !String(row.metric).startsWith("disposition:"));
        expect(parity.every((row) => row.legacy_count === row.core_count)).toBe(true);
        const metrics = new Set(
          parity.filter((row) => row.account === a.account).map((row) => row.metric),
        );
        for (const metric of [
          "credentials",
          "connections",
          "aliases",
          "unique_upstream_identities",
          "workspace_pool_policies",
          "connection_model_policies",
          "organization_pool_admissions",
          "personal_connections",
          "source_modes",
          "organization_rotation",
          "workspace_rotation",
          "session_pointers",
          "session_bindings",
          "apps_designations",
          "live_leases",
          "waiting_waiters",
          "live_turn_authority",
        ])
          expect(metrics.has(metric)).toBe(true);
        const dispositions = report.filter((row) => String(row.metric).startsWith("disposition:"));
        expect(dispositions.map((row) => row.metric)).toEqual(
          expect.arrayContaining([
            "disposition:binding_not_eligible",
            "disposition:apps_designation_personal_dropped",
            "disposition:personal_rotation_dropped",
            "disposition:expired_leases_dropped",
          ]),
        );
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain("acct-");
        expect(serialized).not.toContain("refresh-");
      });

      test("step 8: FORCE row security and trigger modes are restored; activation is complete", async () => {
        const relations = await owned.admin`SELECT relname FROM pg_class
        WHERE (relname LIKE 'subscription_%' OR relname LIKE 'codex_%' OR relname IN ('sessions', 'session_turns', 'scheduled_tasks'))
          AND relkind = 'r' AND relrowsecurity AND NOT relforcerowsecurity
          AND relnamespace = 'public'::regnamespace`;
        expect(relations).toHaveLength(0);
        const [disabled] = await owned.admin`SELECT count(*)::int AS total FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled = 'D' AND tgrelid IN (
          'subscription_session_bindings'::regclass, 'subscription_leases'::regclass,
          'session_turns'::regclass, 'codex_subscription_credentials'::regclass)`;
        expect(disabled!.total).toBe(0);
        const cutovers = await owned.admin`SELECT account_id::text AS account, enabled
        FROM subscription_provider_cutovers WHERE provider = 'codex'`;
        expect(new Set(cutovers.map((row) => row.account))).toEqual(
          new Set([a.account, b.account, c.account, d.account]),
        );
        expect(cutovers.every((row) => row.enabled)).toBe(true);
        const [receipt] = await owned.admin`SELECT
        to_regprocedure('opengeni_private.subscription_codex_cutover_v1_active()') IS NOT NULL AS present`;
        expect(receipt!.present).toBe(true);
      });

      test("retrying the ledger is a no-op without the key", async () => {
        await migrateCutover();
        const [count] =
          await owned.admin`SELECT count(*)::int AS total FROM subscription_connections WHERE provider = 'codex'`;
        expect(count!.total).toBe(13);
      }, 180_000);

      test("runs as the restricted application role", async () => {
        const [role] = await rawRows<{
          current_user: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          client.db,
          sql`select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        );
        expect(role).toEqual({
          current_user: "opengeni_app",
          rolsuper: false,
          rolbypassrls: false,
        });
      });

      test("RLS isolates organizations and resolves legacy aliases to the canonical connection", async () => {
        const resolved = await withRlsContext(
          client.db,
          { accountId: a.account, workspaceId: a.w2 },
          (tx) =>
            resolveSubscriptionConnectionId(tx, {
              accountId: a.account,
              provider: "codex",
              connectionId: a.c2,
            }),
        );
        expect(resolved).toBe(a.c1);
        const crossOrg = await withRlsContext(
          client.db,
          { accountId: b.account, workspaceId: b.w1 },
          (tx) =>
            resolveSubscriptionConnectionId(tx, {
              accountId: b.account,
              provider: "codex",
              connectionId: a.c2,
            }),
        );
        expect(crossOrg).toBeNull();
        const visible = await withRlsContext(
          client.db,
          { accountId: b.account, workspaceId: b.w1 },
          (tx) => rawRows<{ id: string }>(tx, sql`select id::text from subscription_connections`),
        );
        expect(visible.map((row) => row.id)).toEqual([b.c1]);
        const personal = await withRlsContext(
          client.db,
          { accountId: a.account, workspaceId: a.personalOwner },
          (tx) =>
            rawRows<{ id: string }>(
              tx,
              sql`select id::text from subscription_connections where id = ${a.c5}::uuid`,
            ),
        );
        expect(personal).toHaveLength(0);
      });

      test("the core compatibility projection matches the legacy workspace view", async () => {
        const w2 = await getSubscriptionCoreCodexWorkspaceProjection(client.db, {
          accountId: a.account,
          workspaceId: a.w2,
        });
        expect(w2.source).toMatchObject({
          mode: "workspace",
          effectiveSource: "workspace",
          workspaceAvailable: true,
        });
        expect(w2.rotation).toMatchObject({ activeCredentialId: a.c1, rotationEnabled: false });
        const w2Accounts = new Map(w2.accounts.map((account) => [account.id, account]));
        expect(w2Accounts.get(a.c1)).toMatchObject({
          source: "workspace",
          allocatorEnabled: false,
        });
        // The workspace source lists only the workspace pool (legacy parity).
        expect(w2Accounts.has(a.c4)).toBe(false);
        // Plan history and the plan-entitlement cooldown survive as projections.
        expect(w2Accounts.get(a.c1)).toMatchObject({
          planPreviousType: "plus",
          planChangedAt: expect.any(Date),
          planEntitlementExclusion: { planType: "pro", models: [{ modelId: "codex/gpt-5" }] },
        });
        const w3 = await getSubscriptionCoreCodexWorkspaceProjection(client.db, {
          accountId: a.account,
          workspaceId: a.w3,
        });
        expect(w3.source).toMatchObject({ mode: "organization", effectiveSource: "organization" });
        // The organization source lists organization accounts, not W3's local one.
        const w3Ids = w3.accounts.map((account) => account.id);
        expect(w3Ids).toContain(a.c3);
        expect(w3Ids).not.toContain(a.c6);
        const w4 = await getSubscriptionCoreCodexWorkspaceProjection(client.db, {
          accountId: a.account,
          workspaceId: a.w4,
        });
        expect(w4.source).toMatchObject({ mode: "disabled", effectiveSource: "disabled" });
        expect(await readCodexCutoverDisposition(client.db, a.account)).toBe("core");
      });

      test("a later plan change on the core records the previous plan", async () => {
        await owned.admin`UPDATE subscription_connections SET plan_type = 'plus' WHERE id = ${a.c3}`;
        const [row] =
          await owned.admin`SELECT provider_state FROM subscription_connections WHERE id = ${a.c3}`;
        expect(row!.provider_state).toMatchObject({
          planPreviousType: "pro",
          planChangedAt: expect.any(String),
        });
      });

      test("the Apps designation resolves through the alias to the canonical connection", async () => {
        const designation = await resolveSubscriptionCoreCodexAppsDesignation(client.db, {
          accountId: a.account,
          workspaceId: a.w2,
        });
        expect(designation?.connectionId).toBe(a.c1);
        const personal = await resolveSubscriptionCoreCodexAppsDesignation(client.db, {
          accountId: a.account,
          workspaceId: a.personalOwner,
        });
        expect(personal).toBeNull();
      });

      test("people: different people's logins of one ChatGPT workspace stay distinct, with their own secrets and Apps", async () => {
        const rows = await owned.admin`SELECT id::text, provider_account_id, provider_subject_id,
            credential_encrypted, managed_by_workspace_id::text AS managed
          FROM subscription_connections
          WHERE account_id = ${d.account} AND provider_account_id = 'acct-team' ORDER BY id`;
        const byId = new Map(rows.map((row) => [row.id as string, row]));
        expect(rows).toHaveLength(3);
        for (const [id, subject, workspace] of [
          [d.alice, "person-alice", d.w1],
          [d.bob, "person-bob", d.w2],
          [d.unknown, `legacy:${d.unknown}`, d.w3],
        ] as const) {
          const row = byId.get(id)!;
          expect(row).toMatchObject({ provider_subject_id: subject, managed: workspace });
          // Each keeps its own credential: nobody's secret replaced anyone's.
          const secret = JSON.parse(
            decryptEnvironmentValue(key, row.credential_encrypted as string),
          ) as { access_token: string };
          expect(secret.access_token).toBe(`access-${id}`);
        }
        const aliases = await owned.admin`SELECT count(*)::int AS total
          FROM subscription_connection_aliases
          WHERE account_id = ${d.account} AND alias_connection_id = ANY(${[d.alice, d.bob, d.unknown]}::uuid[])`;
        expect(aliases[0]!.total).toBe(0);
        // Each workspace's Apps designation resolves to its own person's login.
        for (const [workspace, connection] of [
          [d.w1, d.alice],
          [d.w2, d.bob],
        ] as const) {
          const designation = await resolveSubscriptionCoreCodexAppsDesignation(client.db, {
            accountId: d.account,
            workspaceId: workspace,
          });
          expect(designation?.connectionId).toBe(connection);
        }
        const [disposition] = await owned.admin`SELECT legacy_count::int AS count
          FROM opengeni_private.subscription_codex_cutover_report
          WHERE account_id = ${d.account} AND metric = 'disposition:person_identity_unknown_kept_separate'`;
        expect(disposition!.count).toBe(1);
      });

      test("scope: an organization account with a local copy keeps both pools in that workspace", async () => {
        const [connection] = await owned.admin`SELECT scope_kind, allow_personal_workspaces
          FROM subscription_connections WHERE id = ${d.org}`;
        expect(connection).toMatchObject({
          scope_kind: "organization",
          allow_personal_workspaces: true,
        });
        const policies = await owned.admin`SELECT workspace_id::text AS workspace, inference_pool,
            allowed_model_ids, managed_by_workspace_id::text AS managed
          FROM subscription_connection_assignment_policies WHERE connection_id = ${d.org}
          ORDER BY inference_pool`;
        expect([...policies]).toEqual([
          {
            workspace: d.w1,
            inference_pool: "organization",
            allowed_model_ids: null,
            managed: null,
          },
          {
            workspace: d.w1,
            inference_pool: "workspace",
            allowed_model_ids: ["codex/gpt-5"],
            managed: d.w1,
          },
        ]);
      });

      test("scope: organization reach covers workspaces created after the cutover, Personal or not as legacy did", async () => {
        // 0712 keeps the rows the cutover wrote, each keyed by its provider.
        const reach = await owned.admin`SELECT connection_id::text AS connection, provider,
            shared_workspaces, personal_workspaces, allocator_enabled
          FROM opengeni_private.subscription_core_auto_assignments
          WHERE account_id = ${d.account} ORDER BY connection_id`;
        expect(new Map(reach.map((row) => [row.connection, row]))).toEqual(
          new Map([
            [
              d.allow,
              {
                connection: d.allow,
                provider: "codex",
                shared_workspaces: false,
                personal_workspaces: true,
                allocator_enabled: true,
              },
            ],
            [
              d.shared,
              {
                connection: d.shared,
                provider: "codex",
                shared_workspaces: true,
                personal_workspaces: false,
                allocator_enabled: false,
              },
            ],
          ]),
        );
        const [allow] = await owned.admin`SELECT scope_kind, allow_personal_workspaces
          FROM subscription_connections WHERE id = ${d.allow}`;
        expect(allow).toMatchObject({ scope_kind: "workspaces", allow_personal_workspaces: true });
        const assigned = async (workspace: string) =>
          (
            await owned.admin`SELECT assignment.connection_id::text AS connection,
                policy.inference_pool AS pool, policy.allocator_enabled AS allocator
              FROM subscription_connection_workspaces assignment
              LEFT JOIN subscription_connection_assignment_policies policy
                ON policy.connection_id = assignment.connection_id
               AND policy.workspace_id = assignment.workspace_id
              WHERE assignment.account_id = ${d.account} AND assignment.workspace_id = ${workspace}
                AND assignment.connection_id = ANY(${[d.allow, d.shared]}::uuid[])
              ORDER BY assignment.connection_id`
          ).map((row) => ({ ...row }));
        // Today's workspaces were enumerated.
        expect(await assigned(d.w2)).toEqual(
          [
            { connection: d.allow, pool: "organization", allocator: true },
            { connection: d.shared, pool: "organization", allocator: false },
          ].sort((x, y) => (x.connection < y.connection ? -1 : 1)),
        );
        expect(await assigned(d.personalOwner)).toEqual([
          { connection: d.allow, pool: "organization", allocator: true },
        ]);
        // A shared workspace created later: every-shared-workspace reach only.
        await owned.admin`INSERT INTO workspaces (id, account_id, name)
          VALUES (${d.later}, ${d.account}, 'Created after the cutover')`;
        expect(await assigned(d.later)).toEqual([
          { connection: d.shared, pool: "organization", allocator: false },
        ]);
        // A Personal workspace created later: the Personal-workspace reach only.
        await owned.admin`INSERT INTO workspaces (id, account_id, name)
          VALUES (${d.laterPersonal}, ${d.account}, 'Personal, after the cutover')`;
        await owned.admin`INSERT INTO organization_memberships (id, account_id, subject_id, status, personal_workspace_id, role)
          VALUES (${d.laterMembership}, ${d.account}, 'user:cutover-d-later', 'active', ${d.laterPersonal}, 'member')`;
        expect(await assigned(d.laterPersonal)).toEqual([
          { connection: d.allow, pool: "organization", allocator: true },
        ]);
      });

      test("reset credits: the ledger follows the canonical connection with its recovery state", async () => {
        const rows = await owned.admin`SELECT id::text, credential_id::text AS credential, status,
            upstream_idempotency_key::text AS upstream_key, retry_count, credit_id
          FROM codex_reset_redemption_attempts WHERE account_id = ${a.account}`;
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get(a.resetStarted)).toMatchObject({
          credential: a.c1,
          status: "provider_started",
          upstream_key: a.resetStartedKey,
          retry_count: 1,
          credit_id: "credit-started",
        });
        expect(byId.get(a.resetDone)!.credential).toBe(a.c1);
        expect([a.c1, a.c2]).not.toContain(byId.get(a.resetOrphan)!.credential);
        const report = await owned.admin`SELECT metric, legacy_count::int AS legacy,
            core_count::int AS core
          FROM opengeni_private.subscription_codex_cutover_report
          WHERE account_id = ${a.account} AND metric LIKE '%reset_redemption%' ORDER BY metric`;
        expect([...report]).toEqual([
          { metric: "disposition:reset_redemption_history_unmapped", legacy: 1, core: 1 },
          { metric: "reset_redemption_attempts", legacy: 2, core: 2 },
          { metric: "reset_redemption_open", legacy: 1, core: 1 },
        ]);
      });

      test("reset credits: a core claim cannot redeem a legacy in-flight credit twice and recovers it", async () => {
        const scope = { accountId: a.account, workspaceId: a.w2 };
        const asOwner = <T>(fn: () => Promise<T>) =>
          withSessionRlsActorContext({ subjectId: a.owner }, fn);
        // c1 merged duplicates from two workspaces, so it is managed by the
        // organization: only an organization administrator may redeem it
        // (organization-level redemption, M3 PR 3b), and the owner is one.
        const authority = await asOwner(() =>
          readSubscriptionCoreCodexResetAuthority(client.db, {
            ...scope,
            credentialId: a.c1,
            subjectId: a.owner,
          }),
        );
        expect(authority).toMatchObject({ status: "active" });
        // The ledger fences themselves run as the application role under the
        // attempt's workspace RLS, with that organization-level authority.
        const organizationAdmin: CodexResetRedemptionCredentialAuthority = async () => authority;
        // A new browser attempt on the same provider credit, through the
        // canonical id: the per-credit fence sees the migrated attempt.
        const fresh = await asOwner(() =>
          claimCodexResetRedemption(
            client.db,
            {
              ...scope,
              id: randomUUID(),
              credentialId: a.c1,
              subjectId: a.owner,
              browserSessionHash: "browser-hash-new",
              creditId: "credit-started",
              confirmationExpiresAt: new Date(Date.now() + 300_000),
              claimHolderId: randomUUID(),
            },
            organizationAdmin,
          ),
        );
        expect(fresh.kind).toBe("conflict");
        // The ambiguous attempt is adopted and reclaimed under the canonical
        // id with its one upstream idempotency key.
        const adopted = await asOwner(() =>
          adoptCodexResetRedemptionAttempt(
            client.db,
            {
              ...scope,
              attemptId: a.resetStarted,
              credentialId: a.c1,
              creditId: "credit-started",
              subjectId: a.owner,
              browserSessionHash: "browser-hash-new",
            },
            organizationAdmin,
          ),
        );
        expect(adopted.kind).toBe("adopted");
        const resumed = await asOwner(() =>
          claimCodexResetRedemption(
            client.db,
            {
              ...scope,
              id: a.resetStarted,
              credentialId: a.c1,
              subjectId: a.owner,
              browserSessionHash: "browser-hash-new",
              creditId: "credit-started",
              confirmationExpiresAt: new Date(Date.now() + 300_000),
              claimHolderId: randomUUID(),
            },
            organizationAdmin,
          ),
        );
        expect(resumed.kind).toBe("claimed");
        if (resumed.kind !== "claimed") throw new Error("unreachable");
        expect(resumed.attempt.status).toBe("provider_started");
        expect(resumed.attempt.upstreamIdempotencyKey).toBe(a.resetStartedKey);
        const [count] = await owned.admin`SELECT count(*)::int AS total
          FROM codex_reset_redemption_attempts WHERE credit_id = 'credit-started'`;
        expect(count!.total).toBe(1);
      });

      test("reset credits: the cross-workspace fence sees the migrated attempt kept in its legacy workspace", async () => {
        // The migrated provider_started attempt stays filed in W2 under the
        // canonical id. An organization-level redemption from W1 for the same
        // credit must neither start a second logical redemption nor take over
        // a live claim; once the claim lapses, the same person's same attempt
        // is re-filed into W1 with its one upstream idempotency key.
        const fence = (attemptId: string) =>
          withSessionRlsActorContext({ subjectId: a.owner }, () =>
            fenceSubscriptionCoreCodexResetCredit(client.db, {
              accountId: a.account,
              workspaceId: a.w1,
              credentialId: a.c1,
              subjectId: a.owner,
              creditId: "credit-started",
              attemptId,
            }),
          );
        expect(await fence(randomUUID())).toBe("held_elsewhere");
        expect(await fence(a.resetStarted)).toBe("held_elsewhere");
        await owned.admin`UPDATE codex_reset_redemption_attempts
          SET claim_expires_at = now() - interval '1 second'
          WHERE id = ${a.resetStarted}`;
        expect(await fence(a.resetStarted)).toBe("refiled");
        const rows =
          await owned.admin`SELECT workspace_id::text AS workspace, credential_id::text AS credential,
            status, upstream_idempotency_key AS key
          FROM codex_reset_redemption_attempts WHERE credit_id = 'credit-started'`;
        expect([...rows]).toEqual([
          { workspace: a.w1, credential: a.c1, status: "provider_started", key: a.resetStartedKey },
        ]);
      });

      test("a recorded legacy waiter id reconciles against the migrated waiter and keeps waking", async () => {
        const before = await getSubscriptionCoreCodexCapacityWaitById(client.db, {
          workspaceId: a.w1,
          sessionId: a.s2,
          waiterId: a.waiter,
        });
        expect(before).toMatchObject({
          waiterId: a.waiter,
          generation: 2,
          wakeRevision: 5,
          observedWakeRevision: 4,
        });
        await wakeSubscriptionCoreCodexCapacityWaiters(client.db, {
          accountId: a.account,
          reason: "cutover_test",
        });
        const after = await getSubscriptionCoreCodexCapacityWaitById(client.db, {
          workspaceId: a.w1,
          sessionId: a.s2,
          waiterId: a.waiter,
        });
        expect(after!.wakeRevision).toBe(6);
        expect(after!.generation).toBe(2);
      });

      test("the organization Codex administrator check reads no legacy Codex table", async () => {
        const [held] = await owned.admin`SELECT has_table_privilege('opengeni_app',
          'organization_codex_rotation_settings', 'SELECT') AS select`;
        expect(held!.select).toBe(true);
        await owned.admin`REVOKE SELECT ON organization_codex_rotation_settings FROM opengeni_app`;
        try {
          await assertOrganizationCodexAdministrator(client.db, {
            organizationId: a.account,
            actorSubjectId: a.owner,
          });
          const refused = await assertOrganizationCodexAdministrator(client.db, {
            organizationId: a.account,
            actorSubjectId: a.bob,
          }).catch((error: unknown) => error);
          expect(nestedPostgresSqlState(refused)).toBe("42501");
        } finally {
          await owned.admin`GRANT SELECT ON organization_codex_rotation_settings TO opengeni_app`;
        }
      });

      test("the application role cannot use the backfill seam, rewrite authority or remove the switch", async () => {
        const url = new URL(owned.ownerUrl);
        url.username = "opengeni_app";
        url.password = owned.appPassword;
        const app = postgres(url.toString(), { max: 1 });
        try {
          await expect(
            Promise.resolve(
              app.unsafe("ALTER TABLE subscription_session_bindings DISABLE TRIGGER USER"),
            ),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            Promise.resolve(
              app.begin(async (tx) => {
                await tx`select set_config('opengeni.account_id', ${a.account}, true),
              set_config('opengeni.workspace_id', ${a.personalOwner}, true)`;
                await tx`update scheduled_tasks set subscription_authority = '{"version":2,"personal":[]}'::jsonb
              where id = ${a.taskPersonal}`;
              }),
            ),
          ).rejects.toBeDefined();
          const deleted = await app.begin(async (tx) => {
            await tx`select set_config('opengeni.account_id', ${a.account}, true),
            set_config('opengeni.subject_id', ${a.owner}, true)`;
            return await tx`delete from subscription_provider_cutovers where account_id = ${a.account} returning 1`;
          });
          expect(deleted).toHaveLength(0);
          // ...nor turn it into another provider's (deletable) row.
          await expect(
            Promise.resolve(
              app.begin(async (tx) => {
                await tx`select set_config('opengeni.account_id', ${a.account}, true),
                set_config('opengeni.subject_id', ${a.owner}, true)`;
                await tx`update subscription_provider_cutovers set provider = 'xai'
                  where account_id = ${a.account} and provider = 'codex'`;
              }),
            ),
          ).rejects.toMatchObject({ code: "42501" });
          const [still] = await owned.admin`SELECT count(*)::int AS total
            FROM subscription_provider_cutovers WHERE account_id = ${a.account} AND provider = 'codex'`;
          expect(still!.total).toBe(1);
        } finally {
          await app.end();
        }
      });

      test("migrated personal aliases disconnect only for the owner in their Personal workspace", async () => {
        const disconnect = (subjectId: string, workspaceId: string) =>
          withSessionRlsActorContext({ subjectId }, () =>
            disconnectSubscriptionCoreCodexConnection(client.db, {
              accountId: a.account,
              workspaceId,
              subjectId,
              connectionId: a.c5Alias,
            }),
          );
        expect((await disconnect(a.bob, a.personalOwner)).outcome).toBe("not_found");
        expect((await disconnect(a.owner, a.w1)).outcome).toBe("not_found");
        const result = await disconnect(a.owner, a.personalOwner);
        expect(result).toMatchObject({ outcome: "removed", connectionId: a.c5 });
        // The current disconnect contract keeps nonsecret request history,
        // while removing credentials and making the connection ineligible.
        const [remaining] = await owned.admin`select disconnected_at, status,
          credential_encrypted, provider_account_id, allocator_enabled
          from subscription_connections where id = ${a.c5}`;
        expect(remaining).toMatchObject({
          disconnected_at: expect.any(Date),
          status: "disabled",
          credential_encrypted: "",
          provider_account_id: null,
          allocator_enabled: false,
        });
      });

      test("an organization created after the cutover is born on the core", async () => {
        const fresh = randomUUID();
        const url = new URL(owned.ownerUrl);
        url.username = "opengeni_app";
        url.password = owned.appPassword;
        await owned.admin`INSERT INTO managed_accounts (id, name) VALUES (${fresh}, 'Born after cutover')`;
        const [row] = await owned.admin`SELECT enabled FROM subscription_provider_cutovers
        WHERE account_id = ${fresh} AND provider = 'codex'`;
        expect(row!.enabled).toBe(true);
        // ...with the organization settings row every organization has, so
        // placement and the compatibility projections resolve its settings.
        const [settings] = await owned.admin`SELECT
            subscription_effective_settings(${fresh}::uuid, NULL) AS effective,
            (SELECT count(*)::int FROM subscription_settings WHERE account_id = ${fresh}::uuid) AS rows`;
        expect(settings!.rows).toBe(1);
        expect(settings!.effective).toMatchObject({
          values: {
            rotation: { codex: { mode: "spread" } },
            personalConnectionsAllowed: true,
            personalFallbackAllowed: false,
          },
        });
      });
    });
  },
);
