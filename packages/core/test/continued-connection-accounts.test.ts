// Work that continues a person's turn (a goal continuation, a wait wake-up,
// a command or child result; exercised here with a child's result) resolves that person's
// current connector accounts again, exactly as their next message with the
// same picks would. It never copies the accounts an earlier turn froze.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { McpConnectionAccountSelection } from "@opengeni/contracts";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurnConnectionAccountIntent,
  getSessionTurnMcpAccountBindings,
  getSessionTurnPersonalConnectionDelegations,
  type ClaimSessionWorkForAttemptInput,
  type DbClient,
} from "@opengeni/db";
import { seedSenderConnections } from "../../db/test/sender-connection-fixture";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";
import { freezeConnectionAccounts } from "../src/domain/personal-connection-delegations";
import { resolveContinuedConnectionAccounts } from "../src/domain/session-connection-accounts";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-continued-connection-accounts");
  if (!shared) {
    if (realDb) throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const server = {
  id: "mail",
  url: "https://mail.example.test/mcp",
  cacheToolsList: false,
  connectionRef: {
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
  },
};
const settings = testSettings({ sandboxBackend: "none", mcpServers: [server] });

async function world() {
  const sql = shared!.admin;
  const db = client!.db;
  const [account] =
    await sql`insert into managed_accounts (name) values ('continued accounts') returning id`;
  const [workspace] =
    await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
  const scope = {
    accountId: account!.id as string,
    workspaceId: workspace!.id as string,
  };
  await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
  const alice = `alice-${crypto.randomUUID()}`;
  const connect = async (ownerSubjectId: string) => {
    const created = {
      serverId: "mail",
      connectionId: crypto.randomUUID(),
      ownerSubjectId,
      providerDomain: "mail.example.test",
      kind: "oauth2" as const,
    };
    await seedSenderConnections(sql, scope, [created]);
    return created.connectionId;
  };
  const session = await createSession(db, {
    ...scope,
    subjectId: alice,
    initialMessage: "shared session",
    resources: [],
    tools: [{ kind: "mcp", id: "mail" }],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const deps = {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => {} },
    objectStorage: null,
  };
  const send = async (subjectId: string, connectionAccounts?: McpConnectionAccountSelection[]) =>
    (
      await acceptSessionUserMessageWithOutcome(
        deps,
        {
          ...scope,
          subjectId,
          permissions: ["admin"],
          principalKind: "human_session",
        },
        scope.workspaceId,
        session.id,
        {
          text: "Work",
          clientEventId: crypto.randomUUID(),
          delivery: "send",
          ...(connectionAccounts ? { connectionAccounts } : {}),
        },
      )
    ).turn;
  const resolver: NonNullable<
    ClaimSessionWorkForAttemptInput["resolveContinuedConnectionAccounts"]
  > = async (tx, { sessionId, intent }) =>
    await resolveContinuedConnectionAccounts({
      db: tx,
      settings,
      ...scope,
      sessionId,
      intent,
    });
  const claim = async (resolve: boolean) => {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      ...(resolve ? { resolveContinuedConnectionAccounts: resolver } : {}),
    });
    if (claimed.action !== "claimed") throw new Error(`Expected claim: ${claimed.reason}`);
    return { turn: claimed.turn, attemptId };
  };
  // A started turn becomes the receiving context of later input; one that
  // settles without starting leaves the input to its causal turn.
  const finish = async (active: Awaited<ReturnType<typeof claim>>, start = true) => {
    for (const started of start ? [true, false] : [false]) {
      const settled = await applySessionTurnSettlement(db, scope.workspaceId, {
        sessionId: session.id,
        turnId: active.turn.id,
        triggerEventId: active.turn.triggerEventId,
        attemptId: active.attemptId,
        turnStatus: started ? "running" : "completed",
        sessionStatus: started ? "running" : "idle",
        activeTurnId: started ? active.turn.id : null,
        events: started ? [{ type: "turn.started", payload: { turnId: active.turn.id } }] : [],
      });
      expect(settled.action).toBe("settled");
    }
  };
  // A child's result wakes the parent turn that spawned it, carrying that
  // turn's accepted accounts exactly as the real producers do.
  const wake = async (_kind: "child_terminal_result", turnId: string) => {
    const childSessionId = crypto.randomUUID();
    await addSessionSystemUpdate(db, {
      ...scope,
      sessionId: session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: childSessionId,
      dedupeKey: `child_terminal_result:${childSessionId}`,
      summary: "Child finished",
      lineage: { parentTurnId: turnId, parentSessionId: session.id },
      payload: {
        type: "child_terminal_result",
        childSessionId,
        status: "idle" as const,
      },
      mcpAccountBindings: await getSessionTurnMcpAccountBindings(
        db,
        scope.workspaceId,
        session.id,
        turnId,
      ),
      personalConnectionDelegations: await getSessionTurnPersonalConnectionDelegations(
        db,
        scope.workspaceId,
        session.id,
        turnId,
      ),
    });
  };
  const bound = async (turnId: string) =>
    (await getSessionTurnMcpAccountBindings(db, scope.workspaceId, session.id, turnId))?.map(
      (binding) => binding.connectionId,
    ) ?? null;
  const intent = (turnId: string) =>
    getSessionTurnConnectionAccountIntent(db, scope.workspaceId, session.id, turnId);
  const gaps = async (turnId: string) => {
    const [row] = await sql`select metadata from session_turns where id = ${turnId}`;
    return (row!.metadata as Record<string, unknown>).connectionAccountGaps ?? null;
  };
  return {
    sql,
    db,
    scope,
    alice,
    session,
    connect,
    send,
    claim,
    finish,
    wake,
    bound,
    intent,
    gaps,
  };
}

test.skipIf(!realDb).each([
  ["receiving context", true],
  ["causal turn", false],
] as const)(
  "a child result through the %s binds the person's current account after a reconnect",
  async (_path, start) => {
    const w = await world();
    const first = await w.connect(w.alice);
    const origin = await w.send(w.alice);
    expect(await w.intent(origin.id)).toEqual({
      version: 1,
      principal: { kind: "subject", subjectId: w.alice },
      selections: [],
    });
    const active = await w.claim(true);
    expect(await w.bound(active.turn.id)).toEqual([first]);
    await w.finish(active, start);
    await w.sql`update connections set status = 'revoked' where id = ${first}`;
    const reconnected = await w.connect(w.alice);
    await w.wake("child_terminal_result", origin.id);
    const continued = await w.claim(true);
    expect(continued.turn.id).not.toBe(origin.id);
    expect(await w.bound(continued.turn.id)).toEqual([reconnected]);
    expect(await w.intent(continued.turn.id)).toEqual(await w.intent(origin.id));
    expect(await w.gaps(continued.turn.id)).toBeNull();
  },
  120_000,
);

test.skipIf(!realDb).each([
  ["receiving context", true],
  ["causal turn", false],
] as const)(
  "through the %s a carried pick is honoured; once revoked its connector is left out",
  async (_path, start) => {
    const w = await world();
    const picked = await w.connect(w.alice);
    const other = await w.connect(w.alice);
    const origin = await w.send(w.alice, [{ serverId: "mail", connectionId: picked }]);
    const active = await w.claim(true);
    expect(await w.bound(active.turn.id)).toEqual([picked]);
    await w.finish(active, start);

    await w.wake("child_terminal_result", origin.id);
    const kept = await w.claim(true);
    expect(await w.bound(kept.turn.id)).toEqual([picked]);
    await w.finish(kept, start);

    await w.sql`update connections set status = 'revoked' where id = ${picked}`;
    await w.wake("child_terminal_result", origin.id);
    const degraded = await w.claim(true);
    const accounts = await w.bound(degraded.turn.id);
    expect(accounts ?? []).not.toContain(other);
    expect(accounts ?? []).not.toContain(picked);
    expect(await w.gaps(degraded.turn.id)).toEqual([
      expect.objectContaining({ serverId: "mail", connectionId: picked }),
    ]);
    expect(await w.intent(degraded.turn.id)).toEqual(await w.intent(origin.id));
  },
  120_000,
);

test.skipIf(!realDb)(
  "work without a person behind it never gains personal accounts",
  async () => {
    const w = await world();
    await w.connect(w.alice);
    const resolved = await resolveContinuedConnectionAccounts({
      db: w.db,
      settings,
      ...w.scope,
      sessionId: w.session.id,
      intent: { version: 1, principal: { kind: "none" }, selections: [] },
    });
    expect(resolved.personalConnectionDelegations).toEqual([]);
    expect(
      (resolved.mcpAccountBindings ?? []).filter((binding) => binding.subjectScope === "subject"),
    ).toEqual([]);
  },
  120_000,
);

test.skipIf(!realDb)(
  "a child carries its parent turn's intent, not only its accounts",
  async () => {
    const w = await world();
    const picked = await w.connect(w.alice);
    await w.connect(w.alice);
    const origin = await w.send(w.alice, [{ serverId: "mail", connectionId: picked }]);
    const child = await freezeConnectionAccounts({
      db: w.db,
      ...w.scope,
      settings,
      tools: [{ kind: "mcp", id: "mail" }],
      source: { kind: "turn", sessionId: w.session.id, turnId: origin.id },
    });
    expect(child.connectionAccountIntent).toEqual({
      version: 1,
      principal: { kind: "subject", subjectId: w.alice },
      selections: [{ serverId: "mail", connectionId: picked }],
    });
  },
  120_000,
);

test.skipIf(!realDb).each([
  ["receiving context", true],
  ["causal turn", false],
] as const)(
  "through the %s without the live resolver a continuation keeps the exact accounts",
  async (_path, start) => {
    const w = await world();
    const first = await w.connect(w.alice);
    const origin = await w.send(w.alice);
    const active = await w.claim(false);
    await w.finish(active, start);
    await w.sql`update connections set status = 'revoked' where id = ${first}`;
    await w.connect(w.alice);
    await w.wake("child_terminal_result", origin.id);
    const copied = await w.claim(false);
    expect(await w.bound(copied.turn.id)).toEqual([first]);
  },
  120_000,
);
