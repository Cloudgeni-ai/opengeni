// A turn's connection account intent: its shape, immutability, and the claim
// guarantees around resolving it again for work that continues the turn.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  ConnectionAccountIntent,
  McpConnectionAccountBinding,
  McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { seedSenderConnections } from "./sender-connection-fixture";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  listSessionSystemUpdatesForTurn,
  requestSessionCompaction,
  sendAgentMessageInTransaction,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type ClaimSessionWorkForAttemptInput,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("continued-connection-account-intent");
  if (!acquired) throw new Error("PostgreSQL fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Resolver = NonNullable<ClaimSessionWorkForAttemptInput["resolveContinuedConnectionAccounts"]>;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Account intent",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Account intent",
    subjectId: `subject-${suffix}`,
  });
  const g = access.workspaceGrants[0]!;
  const s = await newSession(g);
  return { g, sessionId: s.id };
}
type World = Awaited<ReturnType<typeof fixture>>;

async function newSession(g: { accountId: string; workspaceId: string | null }) {
  return await createSession(client.db, {
    accountId: g.accountId,
    workspaceId: g.workspaceId!,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    tools: [{ kind: "mcp", id: "notes" }],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}

async function account(w: World, ownerSubjectId: string) {
  const delegation: McpPersonalConnectionDelegation = {
    serverId: "notes",
    connectionId: crypto.randomUUID(),
    ownerSubjectId,
    providerDomain: "notes.example.test",
    kind: "oauth2",
    connectionType: "mcp",
  };
  await seedSenderConnections(
    shared.admin,
    { accountId: w.g.accountId, workspaceId: w.g.workspaceId! },
    [delegation],
  );
  const binding: McpConnectionAccountBinding = {
    serverId: "notes",
    canonicalServerId: "notes",
    connectionId: delegation.connectionId,
    originWorkspaceId: delegation.originWorkspaceId!,
    subjectScope: "subject",
    ownerSubjectId,
    accountLabel: "Notes account",
    providerDomain: delegation.providerDomain,
    kind: "oauth2",
    connectionRef: {
      connectionId: delegation.connectionId,
      subjectScope: "subject",
      providerDomain: delegation.providerDomain,
      kind: "oauth2",
    },
  };
  return { delegation, binding };
}

async function submit(w: World, intent: ConnectionAccountIntent | null, sessionId = w.sessionId) {
  return withWorkspaceSubjectSessionActivityRls(client.db, w.g.workspaceId!, w.g.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: w.g.accountId,
      workspaceId: w.g.workspaceId!,
      sessionId,
      subjectId: w.g.subjectId,
      actor: { type: "human", subjectId: w.g.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Continue",
      resources: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      reasoningEffortFallback: "medium",
      source: "user",
      personalConnectionDelegations: [],
      mcpAccountBindings: [],
      connectionAccountIntent: intent,
    }),
  );
}

async function claim(w: World, resolver?: Resolver, sessionId = w.sessionId) {
  const attemptId = crypto.randomUUID();
  const r = await claimSessionWorkForAttempt(client.db, w.g.workspaceId!, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
    ...(resolver ? { resolveContinuedConnectionAccounts: resolver } : {}),
  });
  if (r.action !== "claimed") throw new Error(`Expected claim: ${r.reason}`);
  return { turn: r.turn, attemptId };
}

async function finish(w: World, active: Awaited<ReturnType<typeof claim>>) {
  for (const started of [true, false]) {
    const r = await applySessionTurnSettlement(client.db, w.g.workspaceId!, {
      sessionId: w.sessionId,
      turnId: active.turn.id,
      triggerEventId: active.turn.triggerEventId,
      attemptId: active.attemptId,
      turnStatus: started ? "running" : "completed",
      sessionStatus: started ? "running" : "idle",
      activeTurnId: started ? active.turn.id : null,
      events: started ? [{ type: "turn.started", payload: { turnId: active.turn.id } }] : [],
    });
    expect(r.action).toBe("settled");
  }
}

async function childResult(w: World, parentTurnId: string) {
  const childSessionId = crypto.randomUUID();
  await addSessionSystemUpdate(client.db, {
    accountId: w.g.accountId,
    workspaceId: w.g.workspaceId!,
    sessionId: w.sessionId,
    kind: "child_terminal_result",
    classification: "info",
    sourceId: childSessionId,
    dedupeKey: `child:${childSessionId}`,
    summary: "Child finished",
    lineage: { parentTurnId, parentSessionId: w.sessionId },
    payload: { type: "child_terminal_result", childSessionId, status: "idle" },
    mcpAccountBindings: [],
  });
}

async function startedTurnWithIntent(w: World, intent: ConnectionAccountIntent) {
  await submit(w, intent);
  const first = await claim(w);
  await finish(w, first);
  return first.turn.id;
}

const intentOf = (subjectId: string): ConnectionAccountIntent => ({
  version: 1,
  principal: { kind: "subject", subjectId },
  selections: [],
});

test("an accepted turn's intent is stored with it and can never change", async () => {
  const w = await fixture();
  const turnId = await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  const [row] =
    await shared.admin`select connection_account_intent from session_turns where id=${turnId}`;
  expect(row!.connection_account_intent).toEqual(intentOf(w.g.subjectId));
  // postgres.js queries run only when awaited, so each is wrapped.
  await expect(
    (async () => {
      await shared.admin`update session_turns set connection_account_intent = ${JSON.stringify({
        version: 1,
        principal: { kind: "none" },
        selections: [],
      })}::jsonb where id=${turnId}`;
    })(),
  ).rejects.toThrow(/immutable/);
}, 60_000);

test.each([
  { version: 2, principal: { kind: "none" }, selections: [] },
  { version: 1, principal: { kind: "none", subjectId: "x" }, selections: [] },
  {
    version: 1,
    principal: { kind: "subject", subjectId: "x", extra: true },
    selections: [],
  },
  { version: 1, principal: { kind: "subject", subjectId: "" }, selections: [] },
  { version: 1, principal: { kind: "none" }, selections: {} },
  { version: 1, principal: { kind: "none" }, selections: [], extra: 1 },
])(
  "a malformed intent %j is refused by the database",
  async (intent) => {
    const w = await fixture();
    await expect(
      (async () => {
        await shared.admin`update sessions set initial_connection_account_intent = ${JSON.stringify(
          intent,
        )}::jsonb where id=${w.sessionId}`;
      })(),
    ).rejects.toThrow(/initial_connection_account_intent_shape/);
  },
  60_000,
);

test("continued work resolves the context's intent and records it unchanged", async () => {
  const w = await fixture();
  const intent = intentOf(w.g.subjectId);
  const origin = await startedTurnWithIntent(w, intent);
  const fresh = await account(w, w.g.subjectId);
  const seen: ConnectionAccountIntent[] = [];
  await childResult(w, origin);
  const next = await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return {
      mcpAccountBindings: [fresh.binding],
      personalConnectionDelegations: [fresh.delegation],
    };
  });
  expect(seen).toEqual([intent]);
  const [row] =
    await shared.admin`select connection_account_intent, mcp_account_bindings, execution_context_turn_id
      from session_turns where id=${next.turn.id}`;
  expect(row!.execution_context_turn_id).toBe(origin);
  expect(row!.connection_account_intent).toEqual(intent);
  expect(row!.mcp_account_bindings.map((b: { connectionId: string }) => b.connectionId)).toEqual([
    fresh.binding.connectionId,
  ]);
  const receipts =
    await shared.admin`select connection_id from turn_connection_authority_snapshots where turn_id=${next.turn.id}`;
  expect(receipts.map((r) => r.connection_id)).toEqual([fresh.binding.connectionId]);
}, 60_000);

test("an intent naming someone other than the turn's person resolves no personal accounts", async () => {
  const w = await fixture();
  const origin = await startedTurnWithIntent(w, intentOf(`someone-else-${crypto.randomUUID()}`));
  const seen: ConnectionAccountIntent[] = [];
  await childResult(w, origin);
  await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return { mcpAccountBindings: [], personalConnectionDelegations: [] };
  });
  expect(seen).toEqual([{ version: 1, principal: { kind: "none" }, selections: [] }]);
}, 60_000);

test("a resolver can never bind another person's personal account", async () => {
  const w = await fixture();
  const origin = await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  const foreign = await account(w, `other-${crypto.randomUUID()}`);
  await childResult(w, origin);
  await expect(
    claim(w, async () => ({
      mcpAccountBindings: [foreign.binding],
      personalConnectionDelegations: [foreign.delegation],
    })),
  ).rejects.toThrow();
  const [row] =
    await shared.admin`select count(*)::int as n from session_turns where session_id=${w.sessionId}`;
  expect(row!.n).toBe(1);
}, 60_000);

test("a turn without an intent never calls the resolver and keeps copying", async () => {
  const w = await fixture();
  await submit(w, null);
  const first = await claim(w);
  await finish(w, first);
  await childResult(w, first.turn.id);
  let called = false;
  const next = await claim(w, async () => {
    called = true;
    return { mcpAccountBindings: [], personalConnectionDelegations: [] };
  });
  expect(called).toBe(false);
  const [row] =
    await shared.admin`select connection_account_intent from session_turns where id=${next.turn.id}`;
  expect(row!.connection_account_intent).toBeNull();
}, 60_000);

test("another agent's message delivered into the receiving context resolves its intent afresh", async () => {
  // A chat mostly driven by other agents' messages must not keep the accounts
  // its person had at their last message: after a reconnect the frozen copy
  // names a superseded authority generation and every connector call fails.
  const w = await fixture();
  const intent = intentOf(w.g.subjectId);
  const origin = await startedTurnWithIntent(w, intent);
  const fresh = await account(w, w.g.subjectId);
  const sending = await newSession(w.g);
  await submit(w, null, sending.id);
  const sender = await claim(w, undefined, sending.id);
  const sent = await withWorkspaceSessionActivityRls(client.db, w.g.workspaceId!, (tx) =>
    sendAgentMessageInTransaction(tx, {
      accountId: w.g.accountId,
      workspaceId: w.g.workspaceId!,
      targetSessionId: w.sessionId,
      actor: {
        type: "agent_attempt",
        sessionId: sender.turn.sessionId,
        turnId: sender.turn.id,
        attemptId: sender.attemptId,
        executionGeneration: sender.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
      text: "Result from another agent session",
    }),
  );
  const seen: ConnectionAccountIntent[] = [];
  const next = await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return {
      mcpAccountBindings: [fresh.binding],
      personalConnectionDelegations: [fresh.delegation],
    };
  });
  const delivered = await listSessionSystemUpdatesForTurn(
    client.db,
    w.g.workspaceId!,
    w.sessionId,
    next.turn.id,
  );
  expect(delivered.map((row) => row.id)).toEqual([sent.updateId]);
  expect(seen).toEqual([intent]);
  const [row] =
    await shared.admin`select connection_account_intent, mcp_account_bindings, execution_context_turn_id
      from session_turns where id=${next.turn.id}`;
  expect(row!.execution_context_turn_id).toBe(origin);
  expect(row!.connection_account_intent).toEqual(intent);
  expect(row!.mcp_account_bindings.map((b: { connectionId: string }) => b.connectionId)).toEqual([
    fresh.binding.connectionId,
  ]);
}, 60_000);

test("a compaction resolves the compacted turn's intent and records it unchanged", async () => {
  const w = await fixture();
  const intent = intentOf(w.g.subjectId);
  const origin = await startedTurnWithIntent(w, intent);
  const fresh = await account(w, w.g.subjectId);
  const seen: ConnectionAccountIntent[] = [];
  await requestSessionCompaction(client.db, w.g.workspaceId!, w.sessionId);
  const compaction = await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return {
      mcpAccountBindings: [fresh.binding],
      personalConnectionDelegations: [fresh.delegation],
    };
  });
  expect(compaction.turn.source).toBe("compaction");
  expect(seen).toEqual([intent]);
  const [row] = await shared.admin`select connection_account_intent, mcp_account_bindings,
      personal_connection_delegations, initiating_human_subject_id
      from session_turns where id=${compaction.turn.id}`;
  expect(row!.connection_account_intent).toEqual(intent);
  expect(row!.initiating_human_subject_id).toBe(w.g.subjectId);
  expect(row!.mcp_account_bindings.map((b: { connectionId: string }) => b.connectionId)).toEqual([
    fresh.binding.connectionId,
  ]);
  expect(
    row!.personal_connection_delegations.map((d: { connectionId: string }) => d.connectionId),
  ).toEqual([fresh.delegation.connectionId]);
  const receipts =
    await shared.admin`select connection_id from turn_connection_authority_snapshots where turn_id=${compaction.turn.id}`;
  expect(receipts.map((r) => r.connection_id)).toEqual([fresh.binding.connectionId]);
  const [previous] =
    await shared.admin`select initiating_human_subject_id from session_turns where id=${origin}`;
  expect(previous!.initiating_human_subject_id).toBe(w.g.subjectId);
}, 60_000);

test("a compaction after a turn whose intent names someone else resolves no personal accounts", async () => {
  const w = await fixture();
  await startedTurnWithIntent(w, intentOf(`someone-else-${crypto.randomUUID()}`));
  const seen: ConnectionAccountIntent[] = [];
  await requestSessionCompaction(client.db, w.g.workspaceId!, w.sessionId);
  const compaction = await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return { mcpAccountBindings: [], personalConnectionDelegations: [] };
  });
  expect(compaction.turn.source).toBe("compaction");
  expect(seen).toEqual([{ version: 1, principal: { kind: "none" }, selections: [] }]);
}, 60_000);

test("a compaction never accepts another person's personal account from a resolver", async () => {
  const w = await fixture();
  await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  const foreign = await account(w, `other-${crypto.randomUUID()}`);
  await requestSessionCompaction(client.db, w.g.workspaceId!, w.sessionId);
  const compaction = await claim(w, async () => ({
    mcpAccountBindings: [foreign.binding],
    personalConnectionDelegations: [foreign.delegation],
  }));
  expect(compaction.turn.source).toBe("compaction");
  const [row] =
    await shared.admin`select mcp_account_bindings, personal_connection_delegations, metadata
      from session_turns where id=${compaction.turn.id}`;
  expect(row!.mcp_account_bindings).toEqual([]);
  expect(row!.personal_connection_delegations).toEqual([]);
  expect(row!.metadata.connectionAccountsUnresolved).toEqual({ reason: "owner_mismatch" });
}, 60_000);

/** Request compaction and claim it, recording whether the resolver was asked. */
async function compactWithSpy(w: World) {
  const seen: ConnectionAccountIntent[] = [];
  await requestSessionCompaction(client.db, w.g.workspaceId!, w.sessionId);
  const compaction = await claim(w, async (_tx, input) => {
    seen.push(input.intent);
    return { mcpAccountBindings: [], personalConnectionDelegations: [] };
  });
  expect(compaction.turn.source).toBe("compaction");
  const [row] = await shared.admin`select connection_account_intent, mcp_account_bindings,
      personal_connection_delegations from session_turns where id=${compaction.turn.id}`;
  return { seen, row: row! };
}

test("a compaction with no started turn resolves no accounts", async () => {
  const w = await fixture();
  const { seen, row } = await compactWithSpy(w);
  expect(seen).toEqual([]);
  expect(row.connection_account_intent).toBeNull();
  expect(row.personal_connection_delegations).toEqual([]);
}, 60_000);

test("a compaction after a turn without an intent resolves no accounts", async () => {
  const w = await fixture();
  await submit(w, null);
  await finish(w, await claim(w));
  const { seen, row } = await compactWithSpy(w);
  expect(seen).toEqual([]);
  expect(row.connection_account_intent).toBeNull();
  expect(row.mcp_account_bindings).toEqual([]);
}, 60_000);

test("a compaction in a private chat lends only its owner's personal accounts", async () => {
  // Another member's turn is the latest, and the chat is now private to its
  // owner: the compaction resolves shared accounts only.
  const userId = `compaction-owner-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Compaction owner",
  });
  const grant = access.workspaceGrants.find(
    (candidate) => candidate.workspaceId !== access.defaultWorkspaceId,
  )!;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: subjectId,
  });
  if (!settings.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
  }
  const g = { ...grant, subjectId };
  const session = await createSession(client.db, {
    accountId: g.accountId,
    workspaceId: g.workspaceId!,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    tools: [{ kind: "mcp", id: "notes" }],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const w: World = { g, sessionId: session.id };
  const origin = await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  await transitionSessionVisibility(client.db, {
    workspaceId: g.workspaceId!,
    sessionId: session.id,
    actorSubjectId: subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `visibility-${crypto.randomUUID()}`,
  });
  const member = `member-${crypto.randomUUID()}`;
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set initiating_human_subject_id = ${member},
      connection_account_intent = ${tx.json(intentOf(member))} where id = ${origin}`;
  });
  const { seen } = await compactWithSpy(w);
  expect(seen).toEqual([{ version: 1, principal: { kind: "none" }, selections: [] }]);
}, 60_000);

test("a compaction never borrows a credential-restricted turn's accounts", async () => {
  const w = await fixture();
  const origin = await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set initiator_context = initiator_context
      || '{"credentialRestriction":"developer_setup"}'::jsonb where id = ${origin}`;
  });
  const { seen, row } = await compactWithSpy(w);
  expect(seen).toEqual([]);
  expect(row.personal_connection_delegations).toEqual([]);
}, 60_000);

test("a compaction never borrows an external link turn's accounts", async () => {
  const w = await fixture();
  const origin = await startedTurnWithIntent(w, intentOf(w.g.subjectId));
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into external_link_turn_authorities
      (turn_id, account_id, workspace_id, session_id, link_id, link_revision, canonical_snapshot, source_kind)
      values (${origin}, ${w.g.accountId}, ${w.g.workspaceId!}, ${w.sessionId},
        ${crypto.randomUUID()}, 1, ${tx.json({})}, 'direct')`;
  });
  const { seen, row } = await compactWithSpy(w);
  expect(seen).toEqual([]);
  expect(row.personal_connection_delegations).toEqual([]);
}, 60_000);
