// Regression coverage: a shared (organization or workspace)
// subscription pool runs under a synthetic pool-worker database subject. That
// subject must not change who can see the session the run belongs to, and it
// must not gain visibility of any other private session.
import { TurnExecutionPolicyV1, TURN_EXECUTION_POLICY_METADATA_KEY } from "@opengeni/contracts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { emptyClaudeUsage } from "@opengeni/config";
import { sql } from "drizzle-orm";
import {
  acquireXaiCredentialLease,
  armClaudeCapacityWait,
  armXaiCapacityWait,
  createDb,
  createSession,
  getClaudeCapacityWaitForSession,
  getOrganizationPrivateSessionSettings,
  getXaiCapacityWaitForSession,
  getXaiSessionAccountPin,
  peekSessionWork,
  reconcileClaudeCapacityWait,
  reconcileXaiCapacityWait,
  setXaiSessionAccountPin,
  subscriptionPoolWorkerSubject,
  updateOrganizationPrivateSessionSettings,
  withSessionActivityRlsContext,
  withSessionRlsActorContext,
  withSubscriptionPoolSessionAccess,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type DbClient,
} from "../src";
import {
  acquireClaudeCredentialLease,
  createClaudeSubscriptionAccount,
  getClaudeRotationSettings,
  getClaudeSessionAccountPin,
  recordClaudeSessionLastAccount,
  selectClaudeCredentialForUse,
  setClaudeSessionAccountPin,
  setInitialActiveClaudeCredential,
  updateClaudeRotationSettings,
  type ClaudeAccountSecret,
} from "../src/claude-subscription-accounts";
import { currentSessionRlsActorContext } from "../src/database";
import { withTemporaryPoolSessionAccessInTransaction } from "../src/subscription-session-access";

let shared: SharedTestDatabase;
let client: DbClient;
const encryptionKey = Buffer.alloc(32, 41);
const authoritySnapshot = { version: 1, scope: "workspace" } as const;
const visibilities: Visibility[] = ["user_private", "workspace_shared"];
type Visibility = "user_private" | "workspace_shared";

beforeAll(async () => {
  const databaseFixture = await acquireSharedTestDatabase("subscription-pool-private-access");
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

function secret(): ClaudeAccountSecret {
  return {
    version: 1,
    token: "sk-ant-oat01-fixture-" + randomUUID(),
    identity: { accountUuid: randomUUID(), deviceId: "a".repeat(64) },
    oauth: {
      refreshToken: "fixture-refresh-" + randomUUID(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ["user:inference", "user:profile"],
    },
  };
}

async function account(input: Fixture) {
  const credential = secret();
  return createClaudeSubscriptionAccount(client.db, {
    ...input,
    scope: "workspace",
    encryptionKey,
    secret: credential,
    providerAccountId: credential.identity.accountUuid,
    label: null,
    accountEmail: "account@example.test",
    planType: "claude_max",
    expiresAt: new Date(credential.oauth!.expiresAt),
  });
}

async function pool(input: Fixture) {
  const a = await account(input),
    b = await account(input);
  await setInitialActiveClaudeCredential(client.db, { ...input, credentialId: a.account.id });
  const settings = (await getClaudeRotationSettings(client.db, input))!;
  await updateClaudeRotationSettings(client.db, {
    ...input,
    expectedVersion: settings.version,
    rotationEnabled: true,
  });
  return { a, b };
}

async function rejectOpus(input: Fixture, id: string, version: number, now: Date) {
  const snapshot = {
    ...emptyClaudeUsage(version),
    windows: [
      {
        id: "seven_day_opus",
        usedPercent: 100,
        status: "rejected",
        resetsAt: new Date(now.getTime() + 3600_000).toISOString(),
        observedAt: now.toISOString(),
      },
    ],
    observedAt: now.toISOString(),
    source: "response_headers",
  };
  await shared.admin`insert into claude_subscription_account_usage (credential_id, account_id, credential_version, snapshot) values (${id}, ${input.accountId}, ${version}, ${JSON.stringify(snapshot)}::jsonb) on conflict (credential_id) do update set snapshot = excluded.snapshot, credential_version = excluded.credential_version`;
}

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

for (const provider of ["claude", "xai"] as const) {
  test.each(visibilities)(
    `${provider} capacity arming under the pool worker subject succeeds for %s sessions`,
    async (visibility) => {
      const arm = provider === "claude" ? armClaudeCapacityWait : armXaiCapacityWait;
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
  "Claude %s capacity wait resumes after quota recovery",
  async (visibility) => {
    const input = await fixture(),
      { a, b } = await pool(input),
      running = await turn(input, visibility),
      now = new Date();
    await rejectOpus(input, a.account.id, a.account.version, now);
    await rejectOpus(input, b.account.id, b.account.version, now);
    const armed = await armClaudeCapacityWait(client.db, {
      ...input,
      ...running,
      subjectId: subscriptionPoolWorkerSubject("claude"),
      earliestResetAt: new Date(now.getTime() + 3600_000),
      failurePayload: capacityFailure,
      now,
    });
    expect(armed.action).toBe("waiting");
    if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
    expect(
      (await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId))?.id,
    ).toBe(armed.waiter.id);
    const afterReset = new Date(now.getTime() + 3600_001);
    expect(
      (
        await selectClaudeCredentialForUse(client.db, {
          ...input,
          shardKey: running.sessionId,
          upstreamModelId: "claude-opus-fixture",
          now: afterReset,
        })
      ).credentialId,
    ).not.toBeNull();
    const reconciled = await reconcileClaudeCapacityWait(client.db, {
      ...input,
      sessionId: running.sessionId,
      waiterId: armed.waiter.id,
      generation: armed.waiter.generation,
      now: afterReset,
    });
    expect(reconciled.action).toBe("resumed");
    const [stored] = await shared.admin<
      { status: string }[]
    >`select status from claude_capacity_waiters where id = ${armed.waiter.id}`;
    expect(stored!.status).toBe("resumed");
  },
  60_000,
);

test.each(visibilities)(
  "SuperGrok %s capacity waiter stays visible to recovery",
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

test.each(visibilities)(
  "Claude %s session pin and last-account metadata work under the pool worker subject",
  async (visibility) => {
    const input = await fixture(),
      { a } = await pool(input),
      running = await turn(input, visibility);
    const pin = await setClaudeSessionAccountPin(client.db, {
      ...input,
      ...running,
      credentialId: a.account.id,
      pinSource: "manual",
      expectedVersion: null,
    });
    const worker = { ...input, ...running, subjectId: subscriptionPoolWorkerSubject("claude") };
    expect((await getClaudeSessionAccountPin(client.db, worker))?.id).toBe(pin.id);
    const recorded = await recordClaudeSessionLastAccount(client.db, {
      ...worker,
      credentialId: a.account.id,
    });
    expect(recorded.lastCredentialId).toBe(a.account.id);
  },
  60_000,
);

test("restored session access admits only the acting turn's human, never another member's private session", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const theirs = await turn(input, "user_private", input.otherSubjectId);
  const shared_ = await turn(input, "workspace_shared", input.otherSubjectId);
  const worker = subscriptionPoolWorkerSubject("claude");
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

test("an ambient actor carrying a different human is never overridden", async () => {
  const input = await fixture(),
    running = await turn(input, "user_private");
  const armed = await armClaudeCapacityWait(client.db, {
    ...input,
    ...running,
    subjectId: subscriptionPoolWorkerSubject("claude"),
    earliestResetAt: null,
    failurePayload: capacityFailure,
  });
  if (armed.action !== "waiting") throw new Error("Fixture failed to arm");
  const seen = await withSessionRlsActorContext(
    { subjectId: "service:agent-turn", initiatingHumanSubjectId: input.otherSubjectId },
    async () =>
      await getClaudeCapacityWaitForSession(client.db, input.workspaceId, running.sessionId),
  );
  expect(seen).toBeNull();
}, 60_000);

test("non-pool subjects run unchanged", async () => {
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
  provider: "claude" | "xai",
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
            subjectId: subscriptionPoolWorkerSubject("claude"),
            sessionId: sharedByMe.sessionId,
            turnId: sharedByMe.turnId,
          },
          async () => ({
            actor: currentSessionRlsActorContext(),
            visible: await poolVisibleSessions(input, "claude", [
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
  const worker = subscriptionPoolWorkerSubject("claude");
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

for (const provider of ["claude", "xai"] as const) {
  test.each(visibilities)(
    `${provider} lease acquisition under the pool worker subject succeeds for %s sessions`,
    async (visibility) => {
      const input = await fixture();
      if (provider === "claude") await pool(input);
      const running = await turn(input, visibility);
      const acquire =
        provider === "claude" ? acquireClaudeCredentialLease : acquireXaiCredentialLease;
      const leased = await acquire(client.db, {
        ...input,
        sessionId: running.sessionId,
        turnId: running.turnId,
        subjectId: subscriptionPoolWorkerSubject(provider),
        holderId: "fixture-holder-" + randomUUID(),
        upstreamModelId: "claude-opus-fixture",
        modelId: "fixture-model",
      });
      if (provider === "claude") expect(leased.credentialId).not.toBeNull();
      else expect(leased.credentialId).toBeNull();
    },
    60_000,
  );

  test.each(visibilities)(
    `${provider} %s session pin uses the acting turn, not the session's active turn`,
    async (visibility) => {
      const input = await fixture();
      const credentialId = provider === "claude" ? (await pool(input)).a.account.id : null;
      const running = await turn(input, visibility);
      // The acting turn is no longer the session's active turn.
      await shared.admin`update sessions set active_turn_id = null where id = ${running.sessionId}`;
      const setPin = provider === "claude" ? setClaudeSessionAccountPin : setXaiSessionAccountPin;
      const getPin = provider === "claude" ? getClaudeSessionAccountPin : getXaiSessionAccountPin;
      const worker = {
        ...input,
        sessionId: running.sessionId,
        turnId: running.turnId,
        subjectId: subscriptionPoolWorkerSubject(provider),
      };
      const pin = await setPin(client.db, {
        ...worker,
        credentialId,
        pinSource: credentialId ? "policy" : null,
        expectedVersion: null,
      });
      expect((await getPin(client.db, worker))?.id).toBe(pin.id);
      if (credentialId) {
        const recorded = await recordClaudeSessionLastAccount(client.db, {
          ...worker,
          credentialId,
        });
        expect(recorded.lastCredentialId).toBe(credentialId);
      }
      if (visibility === "user_private") {
        // Without the acting turn nothing is restored and the private pin stays hidden.
        expect(await getPin(client.db, { ...worker, turnId: null })).toBeNull();
      }
    },
    60_000,
  );
}

test("a turn without an initiating human restores nothing and private sessions stay hidden", async () => {
  const input = await fixture();
  const serviceTurn = await turn(input, "user_private", input.subjectId, null);
  const worker = subscriptionPoolWorkerSubject("claude");
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
      visible: await poolVisibleSessions(input, "claude", [serviceTurn.sessionId]),
    }),
  );
  expect(observed).toEqual({ actor: undefined, visible: [] });
  await expect(
    armClaudeCapacityWait(client.db, {
      ...input,
      ...serviceTurn,
      subjectId: worker,
      earliestResetAt: null,
      failurePayload: capacityFailure,
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
