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
  createDb,
  createSession,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  withSessionActivityRlsContext,
  withSessionRlsActorContext,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type DbClient,
} from "../src";
import { currentSessionRlsActorContext } from "../src/database";
import {
  subscriptionPoolWorkerSubject,
  withSubscriptionPoolSessionAccess,
  withPoolWakeServiceScopeInTransaction,
  withTemporaryPoolSessionAccessInTransaction,
} from "./fixtures/legacy-subscription-session-access";

// Retains the low-level session-authority isolation contract on the current
// schema. Allocation and waiter regressions run for every provider in
// helpers/subscription-core-conformance.ts; no retired selector is executable.

let shared: SharedTestDatabase;
let client: DbClient;
const authoritySnapshot: { version: 1; scope: "workspace" | "organization" } = {
  version: 1,
  scope: "workspace",
};
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
      sql`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, source, position, prompt, model, reasoning_effort, latency_mode, sandbox_backend, execution_generation, active_attempt_id, metadata, initiating_human_subject_id, claude_provider_account_authority_snapshot) values (${turnId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${randomUUID()}, ${workflowId}, 'running', 'user', 1, 'Fixture', 'fixture-model', 'high', 'standard', 'none', 1, ${attemptId}, ${JSON.stringify(metadata)}::jsonb, ${initiatingHumanSubjectId}, ${JSON.stringify(input.authoritySnapshot)}::jsonb)`,
    );
    await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
    await tx.execute(
      sql`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id, execution_generation, state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id, verified_control_revision, mcp_approval_policies) values (${attemptId}, ${input.accountId}, ${input.workspaceId}, ${sessionId}, ${turnId}, 1, 'running', ${workflowId}, ${"fixture-run-" + attemptId}, 'fixture-activity', 0, '{}'::jsonb)`,
    );
  });
  return { sessionId, turnId, attemptId, workflowId };
}

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
  const worker = subscriptionPoolWorkerSubject("claude");
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
}, 60_000);

test("a turn id from another session restores nothing", async () => {
  const input = await fixture();
  const mine = await turn(input, "user_private");
  const theirs = await turn(input, "workspace_shared", input.otherSubjectId);
  const observed = await withSubscriptionPoolSessionAccess(
    client.db,
    {
      workspaceId: input.workspaceId,
      subjectId: subscriptionPoolWorkerSubject("claude"),
      sessionId: theirs.sessionId,
      turnId: mine.turnId,
    },
    async () => ({
      actor: currentSessionRlsActorContext(),
      visible: await poolVisibleSessions(input, "claude", [mine.sessionId]),
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
