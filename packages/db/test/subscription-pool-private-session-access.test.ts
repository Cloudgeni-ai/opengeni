// Regression coverage: a shared (organization or workspace)
// subscription pool runs under a synthetic pool-worker database subject. That
// subject must not change who can see the session the run belongs to, and it
// must not gain visibility of any other private session.
import { TurnExecutionPolicyV1, TURN_EXECUTION_POLICY_METADATA_KEY } from "@opengeni/contracts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  acquireXaiCredentialLease,
  armXaiCapacityWait,
  createDb,
  createSession,
  getOrganizationPrivateSessionSettings,
  getXaiCapacityWaitForSession,
  getXaiSessionAccountPin,
  peekSessionWork,
  reconcileXaiCapacityWait,
  setXaiSessionAccountPin,
  subscriptionPoolWorkerSubject,
  updateOrganizationPrivateSessionSettings,
  wakeXaiCapacityWaiters,
  withSessionActivityRlsContext,
  withSessionRlsActorContext,
  withSubscriptionPoolSessionAccess,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type DbClient,
} from "../src";
import { currentSessionRlsActorContext } from "../src/database";
import {
  withPoolWakeServiceScopeInTransaction,
  withTemporaryPoolSessionAccessInTransaction,
} from "../src/subscription-session-access";
import { SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS } from "../src/runtime-posture";

// Characterizes the legacy SuperGrok runtime, which runs only before its
// drained subscription-core cutover: the database withholds that migration.
// Removed with the legacy runtime. (The legacy Claude runtime is deleted,
// design 5.3, C4; the shared scoped waiter cases run on the SuperGrok pool.)
const LEGACY_SUBSCRIPTION_WORLD = {
  withheldMigrations: [SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS.xai!],
};

let shared: SharedTestDatabase;
let client: DbClient;
const authoritySnapshot: { version: 1; scope: "workspace" | "organization" } = {
  version: 1,
  scope: "workspace",
};
const visibilities: Visibility[] = ["user_private", "workspace_shared"];
type Visibility = "user_private" | "workspace_shared";

beforeAll(async () => {
  const databaseFixture = await acquireSharedTestDatabase(
    "subscription-pool-private-access",
    LEGACY_SUBSCRIPTION_WORLD,
  );
  if (!databaseFixture) throw new Error("Real PostgreSQL required");
  shared = databaseFixture;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const [organization] = await shared.admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('Subscription fixture') returning id`;
  const [workspace] = await shared.admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${organization!.id}, 'Account fixture') returning id`;
  const subjects = ["user:" + randomUUID(), "user:" + randomUUID()];
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${organization!.id})`;
  for (const subjectId of subjects) {
    const [personal] = await shared.admin<
      { id: string }[]
    >`insert into workspaces (account_id, name) values (${organization!.id}, 'Personal fixture') returning id`;
    await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${organization!.id}, ${workspace!.id}, ${subjectId}, 'owner', '[]'::jsonb)`;
    await shared.admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id, role) values (${organization!.id}, ${subjectId}, 'active', ${personal!.id}, 'owner')`;
  }
  await shared.admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by) values (${organization!.id}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')`;
  const privateSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: organization!.id,
    actorSubjectId: subjects[0]!,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: organization!.id,
    actorSubjectId: subjects[0]!,
    enabled: true,
    expectedVersion: privateSettings.version,
    operationId: randomUUID(),
  });
  return {
    accountId: organization!.id,
    workspaceId: workspace!.id,
    subjectId: subjects[0]!,
    otherSubjectId: subjects[1]!,
    authoritySnapshot,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function turn(
  input: Fixture,
  visibility: Visibility,
  ownerSubjectId = input.subjectId,
  initiatingHumanSubjectId: string | null = ownerSubjectId,
) {
  const policy = TurnExecutionPolicyV1.parse({
    schemaVersion: 1,
    productModelId: "fixture-model",
    requestedModelId: "fixture-model",
    modelSource: "explicit",
    reasoningEffort: "high",
    reasoningSource: "explicit",
    providerId: "fixture-claude",
    upstreamModelId: "claude-opus-fixture",
    wireApi: "anthropic-messages",
    credentialSource: { kind: "workspace_connection", mechanism: "api_key" },
    billing: { upstreamPayer: "workspace", metering: "external" },
    definitionVersion: "sha256:" + "1".repeat(64),
  });
  const metadata = { [TURN_EXECUTION_POLICY_METADATA_KEY]: policy };
  const sessionId = randomUUID(),
    turnId = randomUUID(),
    attemptId = randomUUID(),
    workflowId = "fixture-" + sessionId;
  await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    requestedSessionId: sessionId,
    visibility,
    initialMessage: "Fixture",
    resources: [],
    metadata: {},
    model: "fixture-model",
    reasoningEffort: "high",
    latencyMode: "standard",
    sandboxBackend: "none",
    subjectId: ownerSubjectId,
    createdBy: { kind: "subject", subjectId: ownerSubjectId },
    createdByContext: {},
  });
  await withSessionActivityRlsContext(client.db, input, async (tx) => {
    await tx.execute(
      sql`update sessions set status = 'running', temporal_workflow_id = ${workflowId} where id = ${sessionId}`,
    );
    await tx.execute(
      sql`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, execution_generation, active_attempt_id, metadata, initiating_human_subject_id, claude_provider_account_authority_snapshot, xai_provider_account_authority_snapshot) values (${turnId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${randomUUID()}, ${workflowId}, 'running', 'user', 1, 'Fixture', 'fixture-model', 'high', 'standard', 'none', 1, ${attemptId}, ${JSON.stringify(metadata)}::jsonb, ${initiatingHumanSubjectId}, ${JSON.stringify(input.authoritySnapshot)}::jsonb, ${JSON.stringify(input.authoritySnapshot)}::jsonb)`,
    );
    await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
    await tx.execute(
      sql`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation, state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies) values (${attemptId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${turnId}, 1, 'running', ${workflowId}, ${"fixture-run-" + attemptId}, 'fixture-activity', 0, '{}'::jsonb)`,
    );
  });
  return { sessionId, turnId, attemptId, workflowId };
}

const capacityFailure = { code: "synthetic_capacity_unavailable" };

for (const provider of ["xai"] as const) {
  test.each(visibilities)(
    `SUB-ACCESS-03: ${provider} capacity arming under the pool worker subject succeeds for %s sessions`,
    async (visibility) => {
      const arm = armXaiCapacityWait;
      const input = await fixture();
      const running = await turn(input, visibility);
      const armed = await arm(client.db, {
        ...input,
        ...running,
        subjectId: subscriptionPoolWorkerSubject(provider),
        earliestResetAt: null,
        failurePayload: capacityFailure,
      });
      expect(armed.action).toBe("waiting");
      const [stored] = await shared.admin<
        { status: string }[]
      >`select status from sessions where id = ${running.sessionId}`;
      expect(stored!.status).toBe("waiting_capacity");
      const peek = await peekSessionWork(client.db, input.workspaceId, running.sessionId);
      expect(peek.kind).toBe("capacity-wait");
    },
    60_000,
  );
}

test.each(visibilities)(
  "SUB-ACCESS-03: SuperGrok %s capacity waiter stays visible to recovery",
  async (visibility) => {
    const input = await fixture(),
      running = await turn(input, visibility);
    const armed = await armXaiCapacityWait(client.db, {
      ...input,
      ...running,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      earliestResetAt: null,
      failurePayload: capacityFailure,
    });
    if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
    expect(
      (await getXaiCapacityWaitForSession(client.db, input.workspaceId, running.sessionId))?.id,
    ).toBe(armed.waiter.id);
    // No SuperGrok account is connected, so recovery keeps waiting instead of
    // reporting the waiter as stale.
    const reconciled = await reconcileXaiCapacityWait(client.db, {
      ...input,
      sessionId: running.sessionId,
      waiterId: armed.waiter.id,
      generation: armed.waiter.generation,
    });
    expect(reconciled.action).toBe("waiting");
  },
  60_000,
);

test("SUB-ACCESS-02, SUB-ACCESS-04: restored session access admits only the acting turn's human, never another member's private session", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const theirs = await turn(input, "user_private", input.otherSubjectId);
  const shared_ = await turn(input, "workspace_shared", input.otherSubjectId);
  const worker = subscriptionPoolWorkerSubject("xai");
  const visible = await withSubscriptionPoolSessionAccess(
    client.db,
    { workspaceId: input.workspaceId, subjectId: worker, sessionId: mine.sessionId },
    async () =>
      await withWorkspaceSubjectRls(client.db, input.workspaceId, worker, async (tx) => {
        const rows = await tx.execute<{ id: string }>(
          sql`select id from sessions where id in (${mine.sessionId}, ${theirs.sessionId}, ${shared_.sessionId})`,
        );
        return [...rows].map((row) => row.id).sort();
      }),
  );
  expect(visible).toEqual([mine.sessionId, shared_.sessionId].sort());

  // Without the helper the pool worker sees no private session at all.
  const bare = await withWorkspaceSubjectRls(client.db, input.workspaceId, worker, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from sessions where id in (${mine.sessionId}, ${theirs.sessionId})`,
    );
    return [...rows].length;
  });
  expect(bare).toBe(0);
}, 60_000);

test("SUB-ACCESS-04: an ambient actor carrying a different human is never overridden", async () => {
  const input = await fixture(),
    running = await turn(input, "user_private");
  const armed = await armXaiCapacityWait(client.db, {
    ...input,
    ...running,
    subjectId: subscriptionPoolWorkerSubject("xai"),
    earliestResetAt: null,
    failurePayload: capacityFailure,
  });
  if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
  const seen = await withSessionRlsActorContext(
    { subjectId: "service:agent-turn", initiatingHumanSubjectId: input.otherSubjectId },
    async () => await getXaiCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  );
  expect(seen).toBeNull();
}, 60_000);

test("SUB-ACCESS-02: non-pool subjects run unchanged", async () => {
  const input = await fixture(),
    running = await turn(input, "user_private");
  const seen = await withSubscriptionPoolSessionAccess(
    client.db,
    {
      workspaceId: input.workspaceId,
      subjectId: input.otherSubjectId,
      sessionId: running.sessionId,
    },
    async () =>
      await withWorkspaceSubjectRls(
        client.db,
        input.workspaceId,
        input.otherSubjectId,
        async (tx) => {
          const rows = await tx.execute<{ id: string }>(
            sql`select id from sessions where id = ${running.sessionId}`,
          );
          return [...rows].length;
        },
      ),
  );
  expect(seen).toBe(0);
}, 60_000);

async function poolVisibleSessions(
  input: Fixture,
  provider: "xai",
  sessionIds: string[],
): Promise<string[]> {
  return await withWorkspaceSubjectRls(
    client.db,
    input.workspaceId,
    subscriptionPoolWorkerSubject(provider),
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from sessions where id in (${sql.join(
          sessionIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
      return [...rows].map((row) => row.id).sort();
    },
  );
}

test.each([
  ["a workspace member without a human", (input: Fixture) => ({ subjectId: input.otherSubjectId })],
  [
    "a service turn actor whose initiating human is null",
    () => ({ subjectId: "service:agent-turn", initiatingHumanSubjectId: null }),
  ],
  [
    "a service turn actor carrying another human",
    (input: Fixture) => ({
      subjectId: "service:agent-turn",
      initiatingHumanSubjectId: input.otherSubjectId,
    }),
  ],
] as const)(
  "an ambient actor (%s) runs unchanged and never borrows the turn's human",
  async (_label, actorFor) => {
    const input = await fixture();
    // Both sessions belong to the same human; the shared one's turn is readable
    // by the ambient actor, so only the short-circuit keeps the private one hidden.
    const mine = await turn(input, "user_private");
    const sharedByMe = await turn(input, "workspace_shared");
    const ambient = actorFor(input);
    const observed = await withSessionRlsActorContext(
      ambient,
      async () =>
        await withSubscriptionPoolSessionAccess(
          client.db,
          {
            workspaceId: input.workspaceId,
            subjectId: subscriptionPoolWorkerSubject("xai"),
            sessionId: sharedByMe.sessionId,
            turnId: sharedByMe.turnId,
          },
          async () => ({
            actor: currentSessionRlsActorContext(),
            visible: await poolVisibleSessions(input, "xai", [
              mine.sessionId,
              sharedByMe.sessionId,
            ]),
          }),
        ),
    );
    expect(observed.actor).toBe(ambient);
    expect(observed.visible).toEqual([sharedByMe.sessionId]);
  },
  60_000,
);

test("without an ambient actor the helper restores exactly the pool-worker subject and the turn's human", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const worker = subscriptionPoolWorkerSubject("xai");
  const actor = await withSubscriptionPoolSessionAccess(
    client.db,
    { workspaceId: input.workspaceId, subjectId: worker, sessionId: mine.sessionId },
    async () => currentSessionRlsActorContext(),
  );
  expect(actor).toEqual({ subjectId: worker, initiatingHumanSubjectId: input.subjectId });
}, 60_000);

test("restoring pool session access refuses an open transaction handle", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const worker = subscriptionPoolWorkerSubject("xai");
  let ran = false;
  await expect(
    withWorkspaceSubjectRls(
      client.db,
      input.workspaceId,
      worker,
      async (tx) =>
        await withSubscriptionPoolSessionAccess(
          tx,
          { workspaceId: input.workspaceId, subjectId: worker, sessionId: mine.sessionId },
          async () => {
            ran = true;
          },
        ),
    ),
  ).rejects.toThrow("not an open transaction");
  expect(ran).toBe(false);
}, 60_000);

test.each(visibilities)(
  "SUB-ACCESS-03: xai lease acquisition under the pool worker subject succeeds for %s sessions",
  async (visibility) => {
    const input = await fixture();
    const running = await turn(input, visibility);
    const leased = await acquireXaiCredentialLease(client.db, {
      ...input,
      sessionId: running.sessionId,
      turnId: running.turnId,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      holderId: "fixture-holder-" + randomUUID(),
    });
    expect(leased.credentialId).toBeNull();
  },
  60_000,
);

test.each(visibilities)(
  "xai %s session pin uses the acting turn, not the session's active turn",
  async (visibility) => {
    const input = await fixture();
    const running = await turn(input, visibility);
    // The acting turn is no longer the session's active turn.
    await shared.admin`update sessions set active_turn_id = null where id = ${running.sessionId}`;
    const worker = {
      ...input,
      sessionId: running.sessionId,
      turnId: running.turnId,
      subjectId: subscriptionPoolWorkerSubject("xai"),
    };
    const pin = await setXaiSessionAccountPin(client.db, {
      ...worker,
      credentialId: null,
      pinSource: null,
      expectedVersion: null,
    });
    expect((await getXaiSessionAccountPin(client.db, worker))?.id).toBe(pin.id);
    if (visibility === "user_private") {
      // Without the acting turn nothing is restored and the private pin stays hidden.
      expect(await getXaiSessionAccountPin(client.db, { ...worker, turnId: null })).toBeNull();
    }
  },
  60_000,
);

test("SUB-ACCESS-04: a turn without an initiating human restores nothing and private sessions stay hidden", async () => {
  const input = await fixture();
  const serviceTurn = await turn(input, "user_private", input.subjectId, null);
  const worker = subscriptionPoolWorkerSubject("xai");
  const observed = await withSubscriptionPoolSessionAccess(
    client.db,
    {
      workspaceId: input.workspaceId,
      subjectId: worker,
      sessionId: serviceTurn.sessionId,
      turnId: serviceTurn.turnId,
    },
    async () => ({
      actor: currentSessionRlsActorContext(),
      visible: await poolVisibleSessions(input, "xai", [serviceTurn.sessionId]),
    }),
  );
  expect(observed).toEqual({ actor: undefined, visible: [] });
  // Lease acquisition is a wrapped path: it fails closed instead of borrowing
  // anyone's access. (Shared-pool arm and reconcile do not use the turn's
  // human; they run without a subject, see withScopedCapacityWaiterRls.)
  await expect(
    acquireXaiCredentialLease(client.db, {
      ...input,
      sessionId: serviceTurn.sessionId,
      turnId: serviceTurn.turnId,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      holderId: "fixture-holder-" + randomUUID(),
    }),
  ).rejects.toThrow();
}, 60_000);

test("a turn id from another session restores nothing", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const theirs = await turn(input, "workspace_shared", input.otherSubjectId);
  const observed = await withSubscriptionPoolSessionAccess(
    client.db,
    {
      workspaceId: input.workspaceId,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      sessionId: theirs.sessionId,
      turnId: mine.turnId,
    },
    async () => ({
      actor: currentSessionRlsActorContext(),
      visible: await poolVisibleSessions(input, "xai", [mine.sessionId]),
    }),
  );
  expect(observed).toEqual({ actor: undefined, visible: [] });
}, 60_000);

test("temporary in-transaction pool session access restores the prior initiating human", async () => {
  const input = await fixture();
  const readHuman = async (tx: Parameters<typeof withTemporaryPoolSessionAccessInTransaction>[0]) =>
    (
      await tx.execute<{ value: string | null }>(
        sql`select current_setting('opengeni.initiating_human_subject_id', true) as value`,
      )
    )[0]?.value ?? "";
  const observed = await withWorkspaceRls(client.db, input.workspaceId, async (tx) => {
    const before = await readHuman(tx);
    const inside = await withTemporaryPoolSessionAccessInTransaction(
      tx,
      input.subjectId,
      async () => await readHuman(tx),
    );
    const afterSuccess = await readHuman(tx);
    let insideFailure = "";
    const failure = new Error("fixture failure");
    const thrown = await withTemporaryPoolSessionAccessInTransaction(
      tx,
      input.subjectId,
      async () => {
        insideFailure = await readHuman(tx);
        throw failure;
      },
    ).catch((error: unknown) => error);
    const afterError = await readHuman(tx);
    // An initiating human already on the transaction is kept, never replaced.
    await tx.execute(
      sql`select set_config('opengeni.initiating_human_subject_id', ${input.otherSubjectId}, true)`,
    );
    const kept = await withTemporaryPoolSessionAccessInTransaction(
      tx,
      input.subjectId,
      async () => await readHuman(tx),
    );
    return { before, inside, afterSuccess, insideFailure, thrown, afterError, kept };
  });
  expect(observed).toEqual({
    before: "",
    inside: input.subjectId,
    afterSuccess: "",
    insideFailure: input.subjectId,
    thrown: expect.any(Error),
    afterError: "",
    kept: input.otherSubjectId,
  });
}, 60_000);

type GucSnapshot = { subjectId: string; initiatingHuman: string };
async function readActorSettings(tx: Parameters<typeof withPoolWakeServiceScopeInTransaction>[0]) {
  const [row] = await tx.execute<{ subject_id: string | null; initiating_human: string | null }>(
    sql`select current_setting('opengeni.subject_id', true) as subject_id,
      current_setting('opengeni.initiating_human_subject_id', true) as initiating_human`,
  );
  return {
    subjectId: row?.subject_id ?? "",
    initiatingHuman: row?.initiating_human ?? "",
  } satisfies GucSnapshot;
}

for (const provider of ["xai"] as const) {
  test(`${provider}: another member's shared-pool change wakes a private waiter of exactly that pool, without granting access to it`, async () => {
    const arm = armXaiCapacityWait;
    const wake = wakeXaiCapacityWaiters;
    const worker = subscriptionPoolWorkerSubject(provider);
    const armWaiter = async (input: Fixture) => {
      const running = await turn(input, "user_private");
      const armed = await arm(client.db, {
        ...input,
        ...running,
        subjectId: worker,
        earliestResetAt: null,
        failurePayload: capacityFailure,
      });
      if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
      return { ...running, waiterId: armed.waiter.id };
    };
    const input = await fixture();
    const mine = await armWaiter(input);
    const elsewhere = await fixture();
    const otherWorkspace = await armWaiter(elsewhere);
    const table = sql.identifier(provider + "_capacity_waiters");
    const revisions = async () =>
      Object.fromEntries(
        (
          await shared.admin<{ id: string; wake_revision: number }[]>`
            select id, wake_revision from ${shared.admin(provider + "_capacity_waiters")}
            where id in (${mine.waiterId}, ${otherWorkspace.waiterId})`
        ).map((row) => [row.id, Number(row.wake_revision)]),
      );
    expect(await revisions()).toEqual({ [mine.waiterId]: 1, [otherWorkspace.waiterId]: 1 });

    // A different pool scope in the same workspace is not woken.
    await wake(client.db, {
      workspaceId: input.workspaceId,
      subjectId: input.otherSubjectId,
      authoritySnapshot: { version: 1, scope: "organization" },
      reason: "fixture_other_scope",
    });
    expect(await revisions()).toEqual({ [mine.waiterId]: 1, [otherWorkspace.waiterId]: 1 });

    // Member B changes the workspace pool inside B's own transaction.
    const observed = await withWorkspaceSubjectRls(
      client.db,
      input.workspaceId,
      input.otherSubjectId,
      async (tx) => {
        await wake(tx, {
          workspaceId: input.workspaceId,
          subjectId: input.otherSubjectId,
          authoritySnapshot: input.authoritySnapshot,
          reason: "fixture_reconnect",
        });
        const sessions = await tx.execute<{ id: string }>(
          sql`select id from sessions where id = ${mine.sessionId}`,
        );
        const waiters = await tx.execute<{ id: string }>(
          sql`select id from ${table} where id = ${mine.waiterId}`,
        );
        return {
          settings: await readActorSettings(tx),
          visibleSessions: [...sessions].length,
          visibleWaiters: [...waiters].length,
        };
      },
    );
    expect(observed).toEqual({
      settings: { subjectId: input.otherSubjectId, initiatingHuman: "" },
      visibleSessions: 0,
      visibleWaiters: 0,
    });
    expect(await revisions()).toEqual({ [mine.waiterId]: 2, [otherWorkspace.waiterId]: 1 });
    const [outbox] = await shared.admin<{ reason: string }[]>`
      select reason from session_workflow_wake_outbox where session_id = ${mine.sessionId}`;
    expect(outbox?.reason).toBe(provider + "_capacity");
  }, 60_000);
}

test("the pool wake service scope clears and then restores the caller's actor settings", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const observed = await withWorkspaceSubjectRls(
    client.db,
    input.workspaceId,
    input.otherSubjectId,
    async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.initiating_human_subject_id', ${input.otherSubjectId}, true)`,
      );
      const visibleCount = async () =>
        [...(await tx.execute(sql`select id from sessions where id = ${mine.sessionId}`))].length;
      const before = { ...(await readActorSettings(tx)), visible: await visibleCount() };
      const inside = await withPoolWakeServiceScopeInTransaction(tx, async () => ({
        ...(await readActorSettings(tx)),
        visible: await visibleCount(),
      }));
      const afterSuccess = { ...(await readActorSettings(tx)), visible: await visibleCount() };
      const thrown = await withPoolWakeServiceScopeInTransaction(tx, async () => {
        throw new Error("fixture failure");
      }).catch((error: unknown) => error);
      const afterError = { ...(await readActorSettings(tx)), visible: await visibleCount() };
      return { before, inside, afterSuccess, thrown, afterError };
    },
  );
  const caller = { subjectId: input.otherSubjectId, initiatingHuman: input.otherSubjectId };
  expect(observed).toEqual({
    before: { ...caller, visible: 0 },
    inside: { subjectId: "", initiatingHuman: "", visible: 1 },
    afterSuccess: { ...caller, visible: 0 },
    thrown: expect.any(Error),
    afterError: { ...caller, visible: 0 },
  });
}, 60_000);

test("an organization-pool change by another member wakes a private organization-scope waiter only", async () => {
  const base = await fixture();
  const input: Fixture = { ...base, authoritySnapshot: { version: 1, scope: "organization" } };
  await shared.admin`insert into xai_rotation_settings (account_id, workspace_id, authority_scope) values (${base.accountId}, null, 'organization') on conflict do nothing`;
  const running = await turn(input, "user_private");
  const armed = await armXaiCapacityWait(client.db, {
    ...input,
    ...running,
    subjectId: subscriptionPoolWorkerSubject("xai"),
    earliestResetAt: null,
    failurePayload: capacityFailure,
  });
  if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
  const revision = async () =>
    Number(
      (
        await shared.admin<{ wake_revision: number }[]>`
          select wake_revision from xai_capacity_waiters where id = ${armed.waiter.id}`
      )[0]!.wake_revision,
    );
  const wakeAs = async (scope: "workspace" | "organization") =>
    await wakeXaiCapacityWaiters(client.db, {
      workspaceId: input.workspaceId,
      subjectId: input.otherSubjectId,
      authoritySnapshot: { version: 1, scope },
      reason: "fixture_" + scope,
    });
  await wakeAs("workspace");
  expect(await revision()).toBe(1);
  await wakeAs("organization");
  expect(await revision()).toBe(2);
}, 60_000);

async function armPrivateXaiWaiter(input: Fixture) {
  const running = await turn(input, "user_private");
  const armed = await armXaiCapacityWait(client.db, {
    ...input,
    ...running,
    subjectId: subscriptionPoolWorkerSubject("xai"),
    earliestResetAt: null,
    failurePayload: capacityFailure,
  });
  if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
  return armed.waiter.id;
}

async function xaiWakeRevision(waiterId: string): Promise<number> {
  const [row] = await shared.admin<{ wake_revision: number }[]>`
    select wake_revision from xai_capacity_waiters where id = ${waiterId}`;
  return Number(row!.wake_revision);
}

async function organizationAdminOutsideWorkspace(input: Fixture): Promise<string> {
  const subjectId = "user:" + randomUUID();
  const [personal] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${input.accountId}, 'Admin personal fixture') returning id`;
  await shared.admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id, role) values (${input.accountId}, ${subjectId}, 'active', ${personal!.id}, 'admin')`;
  return subjectId;
}

test("only a subject holding the shared pool wakes another member's private waiter", async () => {
  const input = await fixture();
  const waiterId = await armPrivateXaiWaiter(input);
  const wakeAs = async (subjectId: string, scope: "workspace" | "organization" = "workspace") =>
    await wakeXaiCapacityWaiters(client.db, {
      workspaceId: input.workspaceId,
      subjectId,
      authoritySnapshot: { version: 1, scope },
      reason: "fixture_wake",
    });

  // A subject with no authority here wakes under its own subject and reaches
  // no other member's private waiter.
  await wakeAs("user:" + randomUUID());
  expect(await xaiWakeRevision(waiterId)).toBe(1);
  // An organization member outside this workspace holds the organization
  // pool, not this workspace's pool.
  await wakeAs(await organizationAdminOutsideWorkspace(input));
  expect(await xaiWakeRevision(waiterId)).toBe(1);
  // Worker usage and quota observations wake as the pool-worker subject.
  await wakeAs(subscriptionPoolWorkerSubject("xai"));
  expect(await xaiWakeRevision(waiterId)).toBe(2);
  // A workspace member does too.
  await wakeAs(input.otherSubjectId);
  expect(await xaiWakeRevision(waiterId)).toBe(3);
}, 60_000);

test("an organization administrator outside the workspace wakes the organization pool's private waiters", async () => {
  const base = await fixture();
  const input: Fixture = { ...base, authoritySnapshot: { version: 1, scope: "organization" } };
  await shared.admin`insert into xai_rotation_settings (account_id, workspace_id, authority_scope) values (${base.accountId}, null, 'organization') on conflict do nothing`;
  const waiterId = await armPrivateXaiWaiter(input);
  const wakeAs = async (subjectId: string) =>
    await wakeXaiCapacityWaiters(client.db, {
      workspaceId: input.workspaceId,
      subjectId,
      authoritySnapshot: input.authoritySnapshot,
      reason: "fixture_organization_wake",
    });
  await wakeAs("user:" + randomUUID());
  expect(await xaiWakeRevision(waiterId)).toBe(1);
  await wakeAs(await organizationAdminOutsideWorkspace(input));
  expect(await xaiWakeRevision(waiterId)).toBe(2);
}, 60_000);

test("a wake stays in its workspace even on a connection that bypasses RLS", async () => {
  const input = await fixture();
  const [second] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${input.accountId}, 'Second fixture') returning id`;
  await shared.admin`insert into workspace_inference_controls (workspace_id, account_id) values (${second!.id}, ${input.accountId})`;
  for (const subjectId of [input.subjectId, input.otherSubjectId])
    await shared.admin`insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions) values (${input.accountId}, ${second!.id}, ${subjectId}, 'owner', '[]'::jsonb)`;
  const here = await armPrivateXaiWaiter(input);
  const elsewhere = await armPrivateXaiWaiter({ ...input, workspaceId: second!.id });
  const bypass = createDb(shared.adminUrl);
  try {
    await wakeXaiCapacityWaiters(bypass.db, {
      workspaceId: input.workspaceId,
      subjectId: input.otherSubjectId,
      authoritySnapshot: input.authoritySnapshot,
      reason: "fixture_bypass_wake",
    });
  } finally {
    await bypass.close();
  }
  expect(await xaiWakeRevision(here)).toBe(2);
  expect(await xaiWakeRevision(elsewhere)).toBe(1);
}, 60_000);

async function waitForLockWaiter(text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query ilike ${"%" + text + "%"}`;
    if (row!.count > 0) return;
    await Bun.sleep(25);
  }
  throw new Error("No backend started waiting on a lock");
}

test("a capacity wake takes the session lock before the waiter lock, like a resume", async () => {
  const input = await fixture();
  const running = await turn(input, "workspace_shared");
  const armed = await armXaiCapacityWait(client.db, {
    ...input,
    ...running,
    subjectId: subscriptionPoolWorkerSubject("xai"),
    earliestResetAt: null,
    failurePayload: capacityFailure,
  });
  if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
  // A resume holds the session, then locks its waiter. A wake that held the
  // waiter while waiting for the session would deadlock with it.
  const resume = await shared.admin.reserve();
  let wake: Promise<void> | null = null;
  try {
    await resume`begin`;
    await resume`select id from sessions where id = ${running.sessionId} for update`;
    wake = wakeXaiCapacityWaiters(client.db, {
      workspaceId: input.workspaceId,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      authoritySnapshot: input.authoritySnapshot,
      reason: "fixture_lock_order",
    });
    await waitForLockWaiter("session_workflow_wake_outbox");
    const locked = await resume`
      select id from xai_capacity_waiters where id = ${armed.waiter.id} for update nowait`;
    expect(locked.map((row) => row.id)).toEqual([armed.waiter.id]);
    await resume`commit`;
  } catch (error) {
    await resume`rollback`.catch(() => undefined);
    throw error;
  } finally {
    resume.release();
    await wake?.catch(() => undefined);
  }
  expect(await xaiWakeRevision(armed.waiter.id)).toBe(2);
}, 60_000);

test("concurrent wakes of one pool all succeed and each bumps every waiter once", async () => {
  const input = await fixture();
  const waiters: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const running = await turn(input, "workspace_shared");
    const armed = await armXaiCapacityWait(client.db, {
      ...input,
      ...running,
      subjectId: subscriptionPoolWorkerSubject("xai"),
      earliestResetAt: null,
      failurePayload: capacityFailure,
    });
    if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
    waiters.push(armed.waiter.id);
  }
  const concurrency = 12;
  const rounds = 4;
  for (let round = 0; round < rounds; round += 1)
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        wakeXaiCapacityWaiters(client.db, {
          workspaceId: input.workspaceId,
          subjectId: subscriptionPoolWorkerSubject("xai"),
          authoritySnapshot: input.authoritySnapshot,
          reason: "fixture_concurrent_wake",
        }),
      ),
    );
  for (const waiterId of waiters)
    expect(await xaiWakeRevision(waiterId)).toBe(1 + concurrency * rounds);
}, 120_000);
