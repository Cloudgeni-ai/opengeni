// M3 PR 3b: Codex v2 accepted authority on the remaining carriers — scheduled
// tasks and their firings, agent messages and Steer (the receiving source),
// child-result notices (the outbox), and the internal turn that delivers an
// update — as the restricted application role. Values are copied, never
// recomputed; non-human acceptance freezes the empty value; nothing is
// written before the cutover.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SubscriptionPersonalAuthorityV2 } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  addSessionSystemUpdate,
  claimPendingSessionSystemUpdateOutbox,
  claimSessionWorkForAttempt,
  connectSubscriptionCoreCodexConnection,
  createDb,
  createScheduledTask,
  createSession,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getOrCreateSessionSystemUpdateOutbox,
  getScheduledTaskSubscriptionAuthority,
  receiverCodexSubscriptionAuthorityV2InTransaction,
  withRlsContext,
  withSessionRlsActorContext,
  updateScheduledTask,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import { encryptEnvironmentValue } from "../src/environment-crypto";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const key = Buffer.alloc(32, 59);
const MODEL = "codex/gpt-5.5";
const EMPTY: SubscriptionPersonalAuthorityV2 = { version: 2, personal: [] };

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-codex-v2-carriers-v1");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

type Org = {
  accountId: string;
  ownerSubjectId: string;
  ownerMembershipId: string;
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
};

async function organization(): Promise<Org> {
  const userId = `core-codex-v2-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Core Codex v2 carriers fixture",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  // Migration 0680 seeds every organization enabled on the shared core. These
  // dormant-gate fixtures start from the pre-cutover world (no Codex row) and
  // enable the gate explicitly.
  await shared!.admin`
    delete from subscription_provider_cutovers
    where account_id = ${accountId}::uuid and provider = 'codex'`;
  // ...and its seeded organization settings row, which the fixture writes itself.
  await shared!.admin`
    delete from subscription_settings
    where account_id = ${accountId}::uuid and workspace_id is null`;
  const ownerSubjectId = `user:${userId}`;
  const [membership] = await shared!.admin<{ id: string; personal_workspace_id: string }[]>`
    select id::text as id, personal_workspace_id::text as personal_workspace_id
    from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${ownerSubjectId}
      and status = 'active' and revoked_at is null limit 1`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Core Codex v2 shared') returning id::text as id`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspace!.id}::uuid, ${ownerSubjectId}, 'owner')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}::uuid, ${accountId}::uuid)`;
  await shared!.admin`
    insert into subscription_settings (
      account_id, rotation, providers, cross_provider_failover, fallback_order,
      personal_connections_allowed, personal_fallback_allowed
    ) values (
      ${accountId}::uuid, ${shared!.admin.json({ codex: { mode: "spread" } })}::jsonb,
      '{}'::jsonb, false, '{}'::jsonb, true, true
    )`;
  return {
    accountId,
    ownerSubjectId,
    ownerMembershipId: membership!.id,
    personalWorkspaceId: membership!.personal_workspace_id,
    sharedWorkspaceId: workspace!.id,
  };
}

async function setCutover(accountId: string, enabled: boolean): Promise<void> {
  await shared!.admin`
    insert into subscription_provider_cutovers (account_id, provider, enabled)
    values (${accountId}::uuid, 'codex', ${enabled})
    on conflict (account_id, provider) do update set enabled = excluded.enabled`;
}

/** The owner's personal Codex connection, through the owner-scoped writer. */
async function personalConnection(org: Org): Promise<string> {
  const connected = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
    connectSubscriptionCoreCodexConnection(client!.db, {
      accountId: org.accountId,
      workspaceId: org.personalWorkspaceId,
      subjectId: org.ownerSubjectId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "a", refresh_token: "r", id_token: "i" }),
      ),
      providerAccountId: `chatgpt-${crypto.randomUUID()}`,
      providerSubjectId: "verified-fixture-person",
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastRefreshAt: new Date(),
      accountEmail: null,
      label: "personal",
    }),
  );
  if (connected.kind !== "connected") throw new Error(`connect refused: ${connected.reason}`);
  return connected.id;
}

function personal(org: Org, generation = 1): SubscriptionPersonalAuthorityV2 {
  return {
    version: 2,
    personal: [
      {
        provider: "codex",
        ownerMembershipId: org.ownerMembershipId,
        authorityGeneration: generation,
      },
    ],
  };
}

function task(
  org: Org,
  workspaceId: string,
  createdBy: { kind: "subject" | "service"; subjectId: string },
) {
  const create = () =>
    createScheduledTask(client!.db, {
      accountId: org.accountId,
      workspaceId,
      name: "Core Codex v2 scheduled fixture",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `core-codex-v2-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Check the deployment", resources: [], tools: [], metadata: {} },
      createdBy,
      metadata: {},
    } as never);
  return createdBy.kind === "subject"
    ? withSessionRlsActorContext({ subjectId: createdBy.subjectId }, create)
    : create();
}

async function taskAuthority(taskId: string) {
  const [row] = await shared!.admin<{ task: unknown; revision: unknown }[]>`
    select task.subscription_authority as task, revision.subscription_authority as revision
    from scheduled_tasks task
    left join scheduled_task_revision_authorities revision
      on revision.task_id = task.id and revision.task_authority_revision = task.authority_revision
    where task.id = ${taskId}::uuid`;
  return row!;
}

async function session(
  org: Org,
  workspaceId: string,
  owner = org.ownerSubjectId,
  visibility: "user_private" | "workspace_shared" = "user_private",
) {
  return await withSessionRlsActorContext({ subjectId: owner }, () =>
    createSession(client!.db, {
      accountId: org.accountId,
      workspaceId,
      initialMessage: "core codex v2 fixture",
      resources: [],
      metadata: {},
      model: MODEL,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility,
      subjectId: owner,
      createdBy: { kind: "subject", subjectId: owner },
      createdByContext: {},
    }),
  );
}

/** A turn accepted for `human`, with a fixture-frozen v2 value. */
async function acceptedTurn(
  org: Org,
  workspaceId: string,
  sessionId: string,
  human: string,
  v2: unknown,
): Promise<string> {
  const turn = await withSessionRlsActorContext({ subjectId: human }, () =>
    enqueueSessionTurn(client!.db, {
      accountId: org.accountId,
      workspaceId,
      sessionId,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${sessionId}`,
      source: "user",
      prompt: "core codex v2 fixture",
      resources: [],
      tools: [],
      model: MODEL,
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId: human },
    }),
  );
  // Fixture only: the immutable slot admits only the table owner.
  await shared!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set subscription_authority = ${tx.json(v2 as never)}::jsonb
      where id = ${turn.id}::uuid`;
  });
  return turn.id;
}

function receiver(org: Org, workspaceId: string, sessionId: string, causal: string | null) {
  return withRlsContext(client!.db, { accountId: org.accountId, workspaceId }, (tx) =>
    receiverCodexSubscriptionAuthorityV2InTransaction(tx, {
      accountId: org.accountId,
      workspaceId,
      sessionId,
      causalHumanSubjectId: causal,
    }),
  );
}

describe.skipIf(!realDb)("Codex v2 accepted authority on the remaining carriers (M3 PR 3b)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
  });

  test("scheduled tasks freeze v2 once at creation; firings copy it, narrowed for another authorizer", async () => {
    const org = await organization();
    // Before the cutover nothing is written: v1 stays authoritative.
    const before = await task(org, org.personalWorkspaceId, {
      kind: "subject",
      subjectId: org.ownerSubjectId,
    });
    expect(await taskAuthority(before.id)).toEqual({ task: null, revision: null });

    await setCutover(org.accountId, true);
    await personalConnection(org);
    // The owner, in their own Personal workspace: their one current generation.
    const own = await task(org, org.personalWorkspaceId, {
      kind: "subject",
      subjectId: org.ownerSubjectId,
    });
    expect(await taskAuthority(own.id)).toEqual({ task: personal(org), revision: personal(org) });
    // A shared workspace, or a non-human creator: the empty value.
    const sharedTask = await task(org, org.sharedWorkspaceId, {
      kind: "subject",
      subjectId: org.ownerSubjectId,
    });
    expect((await taskAuthority(sharedTask.id)).task).toEqual(EMPTY);
    const serviceTask = await task(org, org.personalWorkspaceId, {
      kind: "service",
      subjectId: "scheduler",
    });
    expect((await taskAuthority(serviceTask.id)).task).toEqual(EMPTY);

    // Firings copy the frozen value; another authorizer gets the empty value.
    const firing = (authorizer: string | null) =>
      getScheduledTaskSubscriptionAuthority(client!.db, {
        workspaceId: org.personalWorkspaceId,
        taskId: own.id,
        revisionAuthorizerSubjectId: authorizer,
      });
    expect(await firing(org.ownerSubjectId)).toEqual(personal(org));
    expect(await firing("user:someone-else")).toEqual(EMPTY);
    expect(await firing(null)).toEqual(EMPTY);
    // Never recomputed: a later re-grant does not change what the task froze.
    await shared!.admin`update organization_user_resource_authorities set generation = 2
      where account_id = ${org.accountId}::uuid and resource_kind = 'subscription_connection'`;
    expect(await firing(org.ownerSubjectId)).toEqual(personal(org, 1));
    // The application role cannot rewrite a frozen value.
    const rewrite = await withRlsContext(
      client!.db,
      { accountId: org.accountId, workspaceId: org.personalWorkspaceId },
      (tx) =>
        rawRows(
          tx,
          sql`update scheduled_tasks set subscription_authority = ${JSON.stringify(EMPTY)}::jsonb
            where id = ${own.id}::uuid`,
        ),
    ).catch((error: unknown) => error);
    expect(String((rewrite as { cause?: unknown })?.cause ?? rewrite)).toContain("immutable");
    // The revision slot is canonical and its trigger must narrow a foreign
    // human's edit, not merely rely on the reader's defensive narrowing.
    const otherSubject = `user:other-${crypto.randomUUID()}`;
    const [otherWorkspace] = await shared!.admin`insert into workspaces (account_id, name)
      values (${org.accountId}::uuid, 'Other personal') returning id`;
    await shared!
      .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
      values (${org.accountId}::uuid, ${otherSubject}, 'active', ${otherWorkspace!.id}::uuid)`;
    await shared!
      .admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role)
      values (${org.accountId}::uuid, ${org.personalWorkspaceId}::uuid, ${otherSubject}, 'admin')`;
    await withSessionRlsActorContext({ subjectId: otherSubject }, () =>
      updateScheduledTask(client!.db, org.personalWorkspaceId, own.id, {
        refreshPersonalResourceAuthority: true,
        authorityUpdatedBy: { kind: "subject", subjectId: otherSubject },
      }),
    );
    expect((await taskAuthority(own.id)).revision).toEqual(EMPTY);
    expect(await firing(org.ownerSubjectId)).toEqual(EMPTY);
  });

  test("agent-created schedules inherit their exact causal turn, never fresh personal membership", async () => {
    for (const frozen of [EMPTY, "personal"] as const) {
      const org = await organization();
      await setCutover(org.accountId, true);
      const source = await session(org, org.personalWorkspaceId);
      const expected = frozen === "personal" ? personal(org) : EMPTY;
      const turnId = await acceptedTurn(
        org,
        org.personalWorkspaceId,
        source.id,
        org.ownerSubjectId,
        expected,
      );
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client!.db, org.personalWorkspaceId, {
        sessionId: source.id,
        workflowId: `session-${source.id}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("not claimed");
      await personalConnection(org);
      for (const existing of [false, true]) {
        const scheduled = await createScheduledTask(client!.db, {
          accountId: org.accountId,
          workspaceId: org.personalWorkspaceId,
          name: "Inherited Codex authority",
          status: "active",
          schedule: { type: "manual" },
          temporalScheduleId: crypto.randomUUID(),
          runMode: existing ? "existing_session" : "new_session_per_run",
          overlapPolicy: "allow_concurrent",
          agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
          ...(existing ? { targetSessionId: source.id } : {}),
          metadata: {},
          createdByActor: {
            type: "agent_attempt",
            sessionId: source.id,
            turnId,
            attemptId,
            executionGeneration: claimed.turn.executionGeneration,
          },
        });
        expect(await taskAuthority(scheduled.id)).toEqual({ task: expected, revision: expected });
      }
    }
  });

  test("different frozen Codex values cannot coalesce into the same internal turn", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const target = await session(org, org.personalWorkspaceId);
    const parentTurnId = await acceptedTurn(
      org,
      org.personalWorkspaceId,
      target.id,
      org.ownerSubjectId,
      personal(org),
    );
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update session_turns set status = 'completed' where id = ${parentTurnId}::uuid`;
    });
    for (const authority of [personal(org), EMPTY]) {
      await addSessionSystemUpdate(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        sessionId: target.id,
        kind: "child_terminal_result",
        classification: "success",
        sourceId: crypto.randomUUID(),
        dedupeKey: crypto.randomUUID(),
        summary: "Child done",
        payload: {
          type: "child_terminal_result",
          childSessionId: crypto.randomUUID(),
          status: "idle",
        },
        subscriptionAuthority: authority,
        lineage: { parentTurnId },
      });
    }
    const claimed = await claimSessionWorkForAttempt(client!.db, org.personalWorkspaceId, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed.action).toBe("claimed");
    const updates = await shared!
      .admin`select state from session_system_updates where session_id = ${target.id}::uuid order by state`;
    expect(updates.map((update) => update.state)).toEqual(["delivered", "pending"]);
  });

  test("agent messages and Steer copy the receiving source, only for its exact owner", async () => {
    const org = await organization();
    const target = await session(org, org.personalWorkspaceId);
    await acceptedTurn(org, org.personalWorkspaceId, target.id, org.ownerSubjectId, personal(org));
    // Before the cutover: nothing.
    expect(await receiver(org, org.personalWorkspaceId, target.id, org.ownerSubjectId)).toBeNull();
    await setCutover(org.accountId, true);
    // The owner's own work keeps the owner's frozen entry ...
    expect(await receiver(org, org.personalWorkspaceId, target.id, org.ownerSubjectId)).toEqual(
      personal(org),
    );
    // ... another human or no human gets shared capacity only.
    expect(await receiver(org, org.personalWorkspaceId, target.id, "user:other")).toEqual(EMPTY);
    expect(await receiver(org, org.personalWorkspaceId, target.id, null)).toEqual(EMPTY);
    // A receiving source frozen with the empty value is never widened from
    // current membership, even for its owner with a personal connection.
    await personalConnection(org);
    const plain = await session(org, org.personalWorkspaceId);
    await acceptedTurn(org, org.personalWorkspaceId, plain.id, org.ownerSubjectId, EMPTY);
    expect(await receiver(org, org.personalWorkspaceId, plain.id, org.ownerSubjectId)).toEqual(
      EMPTY,
    );
  });

  test("a delivered update's frozen value is copied onto the internal turn", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    const cases = [
      { frozen: personal(org), expected: personal(org) },
      { frozen: undefined, expected: EMPTY },
    ] as const;
    for (const entry of cases) {
      const target = await session(org, org.personalWorkspaceId);
      const update = await addSessionSystemUpdate(client!.db, {
        accountId: org.accountId,
        workspaceId: org.personalWorkspaceId,
        sessionId: target.id,
        kind: "child_terminal_result",
        classification: "success",
        sourceId: crypto.randomUUID(),
        dedupeKey: `v2-carrier:${crypto.randomUUID()}`,
        summary: "Child completed",
        payload: {
          type: "child_terminal_result",
          childSessionId: crypto.randomUUID(),
          status: "idle",
        },
        ...(entry.frozen ? { subscriptionAuthority: entry.frozen as never } : {}),
      });
      expect(update.reason).toBe("added");
      const [stored] = await shared!.admin<{ value: unknown }[]>`
        select subscription_authority as value from session_system_updates
        where session_id = ${target.id}::uuid`;
      expect(stored!.value).toEqual(entry.frozen ?? null);
      const claimed = await claimSessionWorkForAttempt(client!.db, org.personalWorkspaceId, {
        sessionId: target.id,
        workflowId: `session-${target.id}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      expect(claimed.action).toBe("claimed");
      if (claimed.action !== "claimed") throw new Error("not claimed");
      const [turn] = await shared!.admin<{ value: unknown }[]>`
        select subscription_authority as value from session_turns where id = ${claimed.turn.id}::uuid`;
      expect(turn!.value).toEqual(entry.expected);
    }
  });

  test("child-result notices carry the spawning parent turn's value through the outbox", async () => {
    const org = await organization();
    await setCutover(org.accountId, true);
    // Copying does not depend on visibility; a private child needs a real
    // parent attempt, so the fixture uses workspace-shared sessions.
    const parent = await session(
      org,
      org.sharedWorkspaceId,
      org.ownerSubjectId,
      "workspace_shared",
    );
    const parentTurnId = await acceptedTurn(
      org,
      org.sharedWorkspaceId,
      parent.id,
      org.ownerSubjectId,
      personal(org),
    );
    const child = await withSessionRlsActorContext({ subjectId: org.ownerSubjectId }, () =>
      createSession(client!.db, {
        accountId: org.accountId,
        workspaceId: org.sharedWorkspaceId,
        initialMessage: "child",
        resources: [],
        metadata: {},
        model: MODEL,
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        visibility: "workspace_shared",
        subjectId: org.ownerSubjectId,
        createdBy: { kind: "subject", subjectId: org.ownerSubjectId },
        createdByContext: {},
        parentSessionId: parent.id,
      }),
    );
    // Fixture only: the spawning turn, as an agent-created child records it.
    await shared!.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set parent_turn_id = ${parentTurnId}::uuid where id = ${child.id}::uuid`;
    });
    const outbox = await getOrCreateSessionSystemUpdateOutbox(client!.db, {
      accountId: org.accountId,
      workspaceId: org.sharedWorkspaceId,
      sourceSessionId: child.id,
      targetSessionId: parent.id,
      dedupeKey: `child-completion:${child.id}:v2`,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: child.id,
      summary: "Child completed",
      payload: { type: "child_terminal_result", childSessionId: child.id, status: "idle" },
      lineage: { childSessionId: child.id, parentSessionId: parent.id },
      personalConnectionDelegations: [],
      mcpAccountBindings: null,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
    } as never);
    expect(outbox.subscriptionAuthority).toEqual(personal(org));
    const claimedOutbox = await claimPendingSessionSystemUpdateOutbox(client!.db, 100);
    const mine = claimedOutbox.find((delivery) => delivery.id === outbox.id);
    if (mine) expect(mine.subscriptionAuthority).toEqual(personal(org));
  });
});
