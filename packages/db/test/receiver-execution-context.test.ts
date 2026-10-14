import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  McpPersonalConnectionDelegation,
  McpConnectionAccountBinding,
  TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { seedSenderConnections } from "./sender-connection-fixture";
import {
  createDb,
  bootstrapWorkspace,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  createSession,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  submitHumanPromptInTransaction,
  sendAgentMessageInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceSessionActivityRls,
  getSessionQueueSnapshot,
  listSessionSystemUpdatesForTurn,
  addSessionSystemUpdate,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("receiver-execution-context");
  if (!acquired) throw new Error("PostgreSQL fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(privateSession = false) {
  const suffix = crypto.randomUUID();
  if (privateSession) {
    const access = await ensureManagedAccessForUser(client.db, {
      userId: suffix,
      email: `${suffix}@example.test`,
      name: "Inbox context owner",
    });
    const grant = access.workspaceGrants.find((g) => g.workspaceId === access.defaultWorkspaceId)!;
    await shared.admin`insert into session_tenancy_activations
      (account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values (${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'database-test')
      on conflict (account_id) do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
    });
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    return grant;
  }
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Inbox context",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Inbox context",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function session(g: Scope, tools: string[] = [], privateSession = false) {
  return createSession(client.db, {
    accountId: g.accountId,
    workspaceId: g.workspaceId!,
    initialMessage: "Work",
    resources: [],
    metadata: {},
    ...(privateSession
      ? {
          visibility: "user_private" as const,
          subjectId: g.subjectId,
          createdBy: { kind: "subject" as const, subjectId: g.subjectId },
        }
      : {}),
    tools: tools.map((id) => ({ kind: "mcp", id })),
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}
async function submit(
  g: Scope,
  id: string,
  selected: McpPersonalConnectionDelegation[] = [],
  options: {
    turnExecutionPolicy?: TurnExecutionPolicyV1;
    turnMetadata?: Record<string, unknown>;
  } = {},
) {
  await seedSenderConnections(
    shared.admin,
    { accountId: g.accountId, workspaceId: g.workspaceId! },
    selected,
  );
  const bindings: McpConnectionAccountBinding[] = selected.map((c) => ({
    serverId: c.serverId,
    canonicalServerId: c.serverId,
    connectionId: c.connectionId,
    originWorkspaceId: c.originWorkspaceId!,
    subjectScope: "subject",
    ownerSubjectId: c.ownerSubjectId,
    accountLabel: "Selected account",
    providerDomain: c.providerDomain,
    kind: "oauth2",
    connectionRef: {
      connectionId: c.connectionId,
      subjectScope: "subject",
      providerDomain: c.providerDomain,
      kind: "oauth2",
    },
  }));
  return withWorkspaceSubjectSessionActivityRls(client.db, g.workspaceId!, g.subjectId, (tx) =>
    submitHumanPromptInTransaction(tx, {
      accountId: g.accountId,
      workspaceId: g.workspaceId!,
      sessionId: id,
      subjectId: g.subjectId,
      actor: { type: "human", subjectId: g.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "Continue",
      resources: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      reasoningEffortFallback: "medium",
      source: "user",
      personalConnectionDelegations: selected,
      mcpAccountBindings: bindings,
      ...options,
    }),
  );
}
async function claim(g: Scope, id: string) {
  const attemptId = crypto.randomUUID();
  const r = await claimSessionWorkForAttempt(client.db, g.workspaceId!, {
    sessionId: id,
    workflowId: `session-${id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (r.action !== "claimed") throw new Error(`Expected claim: ${r.reason}`);
  return { turn: r.turn, attemptId };
}
async function settle(g: Scope, active: Awaited<ReturnType<typeof claim>>, started: boolean) {
  const r = await applySessionTurnSettlement(client.db, g.workspaceId!, {
    sessionId: active.turn.sessionId,
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
async function message(g: Scope, sender: Awaited<ReturnType<typeof claim>>, target: string) {
  return withWorkspaceSessionActivityRls(client.db, g.workspaceId!, (tx) =>
    sendAgentMessageInTransaction(tx, {
      accountId: g.accountId,
      workspaceId: g.workspaceId!,
      targetSessionId: target,
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
}
async function pointer(id: string) {
  const [r] = await shared.admin`select execution_context_turn_id from sessions where id=${id}`;
  return r!.execution_context_turn_id;
}

for (const [queuedHuman, privateSession] of [
  [false, false],
  [true, false],
  [false, true],
])
  test(`different sender selections join receiver context (human queued=${queuedHuman}, private=${privateSession})`, async () => {
    const g = await fixture(privateSession);
    const receiving = await session(g, ["notes", "issues"], privateSession);
    const sending = await session(g, ["issues"], privateSession);
    const selected: McpPersonalConnectionDelegation[] = [
      {
        serverId: "notes",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: g.subjectId,
        providerDomain: "notes.example.test",
        kind: "oauth2",
        connectionType: "mcp",
      },
    ];
    await submit(g, receiving.id, selected);
    let previous: Awaited<ReturnType<typeof claim>> | undefined;
    if (!queuedHuman) {
      previous = await claim(g, receiving.id);
      expect(await pointer(receiving.id)).toBeNull();
      await settle(g, previous, true);
      expect(await pointer(receiving.id)).toBe(previous.turn.id);
      await settle(g, previous, false);
    }
    await submit(g, sending.id);
    const sender = await claim(g, sending.id);
    const first = await message(g, sender, receiving.id);
    const second = await message(g, sender, receiving.id);
    if (queuedHuman) {
      const preview = await getSessionQueueSnapshot(client.db, g.workspaceId!, receiving.id);
      expect(preview?.pendingInputAttachment?.inputIds).toEqual([first.updateId, second.updateId]);
    }
    const next = await claim(g, receiving.id);
    expect(next.turn.source).toBe(queuedHuman ? "user" : "system");
    expect(next.turn.personalConnectionDelegations).toHaveLength(1);
    expect(next.turn.initiatingHumanSubjectId).toBe(g.subjectId);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      g.workspaceId!,
      receiving.id,
      next.turn.id,
    );
    expect(delivered.map((row) => row.id)).toEqual([first.updateId, second.updateId]);
    const [receipt] =
      await shared.admin`select mcp_account_bindings, execution_context_turn_id from session_turns where id=${next.turn.id}`;
    expect(receipt!.mcp_account_bindings).toHaveLength(1);
    expect(receipt!.execution_context_turn_id).toBe(previous?.turn.id ?? null);
    const history =
      await shared.admin`select item from session_history_items where turn_id=${next.turn.id}`;
    expect(JSON.stringify(history)).toContain("The sending agent has these tools selected");
    expect(JSON.stringify(history)).toContain("You have these tools selected");
    const events =
      await shared.admin`select payload from session_events where turn_id=${next.turn.id} and type='system.update.delivered'`;
    expect(JSON.stringify(events)).not.toContain("selectionNote");
    if (previous) {
      expect(await pointer(receiving.id)).toBe(previous.turn.id);
      const receipts =
        await shared.admin`select turn_id,connection_generation,authority_generation,membership_authorization_revision,session_authority_epoch
      from turn_connection_authority_snapshots where turn_id in (${previous.turn.id},${next.turn.id}) order by turn_id`;
      expect(receipts).toHaveLength(2);
      const { turn_id: _a, ...a } = receipts[0]!;
      const { turn_id: _b, ...b } = receipts[1]!;
      expect(a).toEqual(b);
    }
  }, 60_000);

test("queued and refused requests never replace the last started context", async () => {
  const g = await fixture(),
    s = await session(g);
  await submit(g, s.id);
  const first = await claim(g, s.id);
  await settle(g, first, true);
  await settle(g, first, false);
  await submit(g, s.id);
  expect(await pointer(s.id)).toBe(first.turn.id);
  const refused = await claim(g, s.id);
  expect(await pointer(s.id)).toBe(first.turn.id);
  await settle(g, refused, false);
  expect(await pointer(s.id)).toBe(first.turn.id);
  await submit(g, s.id);
  const next = await claim(g, s.id);
  await settle(g, next, true);
  expect(await pointer(s.id)).toBe(next.turn.id);
}, 60_000);

test("a malformed origin remains isolated even when it names the same human", async () => {
  const g = await fixture(),
    s = await session(g),
    sender = await session(g);
  await submit(g, s.id);
  const first = await claim(g, s.id);
  await settle(g, first, true);
  await settle(g, first, false);
  await submit(g, sender.id);
  const origin = await claim(g, sender.id);
  await addSessionSystemUpdate(client.db, {
    accountId: g.accountId,
    workspaceId: g.workspaceId!,
    sessionId: s.id,
    kind: "agent_message",
    classification: "info",
    sourceId: crypto.randomUUID(),
    dedupeKey: crypto.randomUUID(),
    summary: "Old input",
    payload: { type: "agent_message", text: "Old input", operationId: crypto.randomUUID() },
    lineage: { callerSessionId: sender.id, callerTurnId: origin.turn.id },
    mcpAccountBindings: [],
  });
  const next = await claim(g, s.id);
  const [row] =
    await shared.admin`select execution_context_turn_id from session_turns where id=${next.turn.id}`;
  expect(row!.execution_context_turn_id).toBeNull();
}, 60_000);

test.each([{ lineage: null }, { lineage: [] }, { lineage: "legacy" }])(
  "malformed lineage %j cannot wedge queue preview or claim",
  async ({ lineage }) => {
    const g = await fixture(),
      receiver = await session(g),
      source = await session(g);
    await submit(g, receiver.id);
    const original = await claim(g, receiver.id);
    await settle(g, original, true);
    await settle(g, original, false);
    await submit(g, source.id);
    const sender = await claim(g, source.id);
    const sent = await message(g, sender, receiver.id);
    await shared.admin`update session_system_updates set lineage=${JSON.stringify(lineage)}::jsonb where id=${sent.updateId}`;
    expect(await getSessionQueueSnapshot(client.db, g.workspaceId!, receiver.id)).not.toBeNull();
    const next = await claim(g, receiver.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      g.workspaceId!,
      receiver.id,
      next.turn.id,
    );
    expect(delivered.map((item) => item.id)).toEqual([sent.updateId]);
    const [row] =
      await shared.admin`select execution_context_turn_id from session_turns where id=${next.turn.id}`;
    expect(row!.execution_context_turn_id).toBeNull();
  },
  60_000,
);

test.each(["revoked", "generation"] as const)(
  "follow-up keeps accepted receipt after connection %s; credential use denies",
  async (change) => {
    const g = await fixture(),
      s = await session(g),
      senderSession = await session(g);
    const selected: McpPersonalConnectionDelegation[] = [
      {
        serverId: "notes",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: g.subjectId,
        providerDomain: "notes.example.test",
        kind: "oauth2",
        connectionType: "mcp",
      },
    ];
    await submit(g, s.id, selected);
    const first = await claim(g, s.id);
    await settle(g, first, true);
    await settle(g, first, false);
    await submit(g, senderSession.id);
    const sender = await claim(g, senderSession.id);
    await message(g, sender, s.id);
    if (change === "revoked")
      await shared.admin`update connections set status='revoked' where id=${selected[0]!.connectionId}`;
    else
      await shared.admin`update connections set authority_generation=authority_generation+1 where id=${selected[0]!.connectionId}`;
    const next = await claim(g, s.id);
    const { resolveAcceptedConnectionUse } = await import("../src/connection-authority");
    const result = await resolveAcceptedConnectionUse(client.db, {
      accountId: g.accountId,
      workspaceId: g.workspaceId!,
      sessionId: s.id,
      turnId: next.turn.id,
      attemptId: next.attemptId,
      executionGeneration: next.turn.executionGeneration,
      physicalRequestId: crypto.randomUUID(),
      usePhase: "credential_resolution",
      serverId: "notes",
      connectionId: selected[0]!.connectionId,
      providerDomain: selected[0]!.providerDomain,
      connectionKind: "oauth2",
      subjectScope: "subject",
      ownerSubjectId: g.subjectId,
    });
    expect(result).toMatchObject({
      status: "denied",
      reason: change === "revoked" ? "connection_status_inactive" : "connection_generation_changed",
    });
    const [oldReceipt] =
      await shared.admin`select connection_generation from turn_connection_authority_snapshots where turn_id=${first.turn.id}`;
    const [newReceipt] =
      await shared.admin`select connection_generation from turn_connection_authority_snapshots where turn_id=${next.turn.id}`;
    expect(newReceipt!.connection_generation).toBe(oldReceipt!.connection_generation);
  },
  60_000,
);

test("receiving context cannot be reassigned to a foreign session or a queued request", async () => {
  const g = await fixture(),
    s = await session(g),
    foreign = await session(g);
  await submit(g, s.id);
  const first = await claim(g, s.id);
  await settle(g, first, true);
  await settle(g, first, false);
  await submit(g, foreign.id);
  const other = await claim(g, foreign.id);
  await settle(g, other, true);
  const { sql } = await import("drizzle-orm");
  await expect(
    withWorkspaceSessionActivityRls(client.db, g.workspaceId!, (tx) =>
      tx.execute(sql`
    update sessions set execution_context_turn_id=${other.turn.id}::uuid where id=${s.id}::uuid`),
    ),
  ).rejects.toBeTruthy();
  await submit(g, s.id);
  const [queued] =
    await shared.admin`select id from session_turns where session_id=${s.id} and status='queued'`;
  await expect(
    withWorkspaceSessionActivityRls(client.db, g.workspaceId!, (tx) =>
      tx.execute(sql`
    update sessions set execution_context_turn_id=${queued!.id}::uuid where id=${s.id}::uuid`),
    ),
  ).rejects.toBeTruthy();
  expect(await pointer(s.id)).toBe(first.turn.id);
}, 60_000);

test("provider-delegated human turn keeps informational input pending in preview and claim", async () => {
  const g = await fixture(),
    receiver = await session(g),
    source = await session(g);
  await submit(g, source.id);
  const sender = await claim(g, source.id);
  await submit(g, receiver.id, [], {
    turnMetadata: {
      realtimeDelegation: {
        realtimeId: crypto.randomUUID(),
        connectionEpoch: 1,
        delegationItemId: crypto.randomUUID(),
        ledgerEntryId: crypto.randomUUID(),
      },
    },
  });
  const sent = await message(g, sender, receiver.id);
  const preview = await getSessionQueueSnapshot(client.db, g.workspaceId!, receiver.id);
  expect(preview?.pendingInputAttachment).toBeNull();
  const next = await claim(g, receiver.id);
  expect(
    await listSessionSystemUpdatesForTurn(client.db, g.workspaceId!, receiver.id, next.turn.id),
  ).toEqual([]);
  const [row] =
    await shared.admin`select state from session_system_updates where id=${sent.updateId}`;
  expect(row!.state).toBe("pending");
}, 60_000);

test("receiving request retains its metadata-only developer credential ceiling", async () => {
  const { resolveTurnExecutionPolicyV1 } = await import("@opengeni/config");
  const { testSettings } = await import("@opengeni/testing");
  const g = await fixture(),
    receiver = await session(g),
    source = await session(g);
  const policy: TurnExecutionPolicyV1 = {
    ...resolveTurnExecutionPolicyV1(testSettings(), {
      modelId: "scripted-model",
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "medium",
      reasoningSource: "session",
      latencyMode: "standard",
      latencyModeSource: "session",
    }),
    credentialRestriction: "developer_setup",
  };
  await submit(g, receiver.id, [], { turnExecutionPolicy: policy });
  const first = await claim(g, receiver.id);
  await settle(g, first, true);
  await settle(g, first, false);
  await submit(g, source.id);
  const sender = await claim(g, source.id);
  await message(g, sender, receiver.id);
  const next = await claim(g, receiver.id);
  const [row] =
    await shared.admin`select initiator_context from session_turns where id=${next.turn.id}`;
  expect(row!.initiator_context.credentialRestriction).toBe("developer_setup");
}, 60_000);
