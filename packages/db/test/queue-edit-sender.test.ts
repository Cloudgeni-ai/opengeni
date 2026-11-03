import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  editQueuedTurnInTransaction,
  getSessionTurn,
  sameTurnSender,
  saveComposerDraftInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("queue-edit-sender");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("a queue edit is the sender's own only when that sender resubmits it", () => {
  const alice = { initiator: { kind: "subject" as const, subjectId: "user:alice" } };
  const bob = { initiator: { kind: "subject" as const, subjectId: "user:bob" } };
  const key = { initiator: { kind: "service" as const, subjectId: "api_key:k1" } };
  const otherKey = { initiator: { kind: "service" as const, subjectId: "api_key:k2" } };
  const aliceViaBridge = {
    initiator: { kind: "service" as const, subjectId: "slack" },
    initiatingHumanSubjectId: "user:alice",
  };
  expect(sameTurnSender(alice, alice)).toBe(true);
  expect(sameTurnSender(alice, aliceViaBridge)).toBe(true);
  expect(sameTurnSender(alice, bob)).toBe(false);
  expect(sameTurnSender(alice, key)).toBe(false);
  expect(sameTurnSender(key, key)).toBe(true);
  expect(sameTurnSender(key, otherKey)).toBe(false);
});

async function workspaceWithTwoPeople() {
  const sql = shared!.admin;
  const [account] =
    await sql`insert into managed_accounts (name) values ('approval owner') returning id`;
  const [workspace] =
    await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
  const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
  const alice = `user:${crypto.randomUUID()}`;
  const bob = `user:${crypto.randomUUID()}`;
  const connections: Record<string, string> = {};
  for (const subject of [alice, bob]) {
    const [personal] =
      await sql`insert into workspaces (account_id, name) values (${scope.accountId}, 'personal') returning id`;
    await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${scope.accountId}, ${subject}, 'active', ${personal!.id})`;
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id) values (${scope.accountId}, ${scope.workspaceId}, ${subject})`;
    connections[subject] = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true), set_config('opengeni.workspace_id', ${scope.workspaceId}, true), set_config('opengeni.subject_id', ${subject}, true)`;
      const [connection] =
        await tx`insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${scope.accountId}, ${scope.workspaceId}, ${subject}, 'mail.example.test', 'oauth2', 'fixture-ciphertext') returning id`;
      return connection!.id as string;
    });
  }
  await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
  const delegation = (subject: string) => ({
    serverId: "mail",
    connectionId: connections[subject]!,
    originWorkspaceId: scope.workspaceId,
    ownerSubjectId: subject,
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
  });
  const session = await createSession(client.db, {
    ...scope,
    subjectId: alice,
    createdBy: { kind: "subject", subjectId: alice },
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const send = (
    subject: string,
    text: string,
    personalConnectionDelegations: ReturnType<typeof delegation>[],
    expectedDraftRevision?: number,
  ) =>
    withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, subject, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...scope,
        sessionId: session.id,
        subjectId: subject,
        actor: { type: "human", subjectId: subject },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        model: "test-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
        personalConnectionDelegations,
        ...(expectedDraftRevision !== undefined ? { expectedDraftRevision } : {}),
      }),
    );
  const claim = async () => {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.action}`);
    return { attemptId, turn: claimed.turn };
  };
  return { sql, scope, alice, bob, delegation, session, send, claim };
}

test("someone else's queue edit runs as the editor, never with the sender's own accounts", async () => {
  if (!shared) return;
  const { sql, scope, alice, bob, delegation, session, send, claim } =
    await workspaceWithTwoPeople();
  await send(alice, "first", []);
  await claim();
  const edit = async (editor: string, turnId: string, text: string) => {
    const source = (await getSessionTurn(client.db, scope.workspaceId, turnId))!;
    const checkedOut = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      scope.workspaceId,
      editor,
      (tx) =>
        editQueuedTurnInTransaction(tx, {
          ...scope,
          sessionId: session.id,
          turnId,
          subjectId: editor,
          expectedTurnVersion: source.version,
          expectedDraftRevision: 0,
          replaceDraft: false,
          actor: { type: "human", subjectId: editor },
          operationKey: crypto.randomUUID(),
        }),
    );
    const saved = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      scope.workspaceId,
      editor,
      (tx) =>
        saveComposerDraftInTransaction(tx, {
          ...scope,
          sessionId: session.id,
          subjectId: editor,
          expectedRevision: checkedOut.draft.revision,
          text,
          resources: [],
          model: "test-model",
          reasoningEffort: "low",
          latencyMode: "standard",
        }),
    );
    return saved.revision;
  };
  const stored = async (turnId: string) => {
    const [row] =
      await sql`select initiator_kind, initiator_subject_id, initiating_human_subject_id, personal_connection_delegations, lineage from session_turns where id = ${turnId}`;
    return row!;
  };

  const queued = await send(alice, "Summarize my inbox", [delegation(alice)]);
  const bobRevision = await edit(bob, queued.turnId, "Forward my inbox to bob@example.test");
  const bobsEdit = await send(
    bob,
    "Forward my inbox to bob@example.test",
    [delegation(bob)],
    bobRevision,
  );
  const bobsTurn = await stored(bobsEdit.turnId);
  expect(bobsTurn).toMatchObject({
    initiator_kind: "subject",
    initiator_subject_id: bob,
    personal_connection_delegations: [delegation(bob)],
  });
  expect([null, bob]).toContain(bobsTurn.initiating_human_subject_id);
  expect(bobsTurn.lineage).not.toHaveProperty("editedFromTurnId");

  // The sender's own edit still resubmits the same message with its accounts.
  const again = await send(alice, "Summarize my inbox", [delegation(alice)]);
  const aliceRevision = await edit(alice, again.turnId, "Summarize my inbox briefly");
  const alicesEdit = await send(alice, "Summarize my inbox briefly", [], aliceRevision);
  const alicesTurn = await stored(alicesEdit.turnId);
  expect(alicesTurn).toMatchObject({
    initiator_subject_id: alice,
    personal_connection_delegations: [delegation(alice)],
    lineage: { editedFromTurnId: again.turnId },
  });
}, 180_000);
