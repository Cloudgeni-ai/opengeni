// A compaction-only turn continues the turn it compacts after. It runs with
// that person's current connector accounts, resolved exactly as an internal
// update continuing the same turn would, so the compaction request carries the
// same tool list as the turn before it and can reuse its cached prompt prefix.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { McpConnectionAccountSelection } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurnConnectionAccountIntent,
  getSessionTurnMcpAccountBindings,
  getSessionTurnPersonalConnectionDelegations,
  requestSessionCompaction,
  type ClaimSessionWorkForAttemptInput,
  type DbClient,
} from "@opengeni/db";
import { seedSenderConnections } from "../../db/test/sender-connection-fixture";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";
import { expandMcpAccountRoutes } from "../src/domain/mcp-account-routes";
import { resolveContinuedConnectionAccounts } from "../src/domain/session-connection-accounts";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-compaction-connection-accounts");
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
const sessionTools = [{ kind: "mcp" as const, id: "mail" }];
type Resolver = NonNullable<ClaimSessionWorkForAttemptInput["resolveContinuedConnectionAccounts"]>;

async function world() {
  const sql = shared!.admin;
  const db = client!.db;
  const [account] =
    await sql`insert into managed_accounts (name) values ('compaction accounts') returning id`;
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
    tools: sessionTools,
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
  const liveResolver: Resolver = async (tx, { sessionId, intent, session: claimedSession }) =>
    await resolveContinuedConnectionAccounts({
      db: tx,
      settings,
      ...scope,
      sessionId,
      intent,
      claimedSession,
    });
  const claim = async (resolver: Resolver | null = liveResolver) => {
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
      ...(resolver ? { resolveContinuedConnectionAccounts: resolver } : {}),
    });
    if (claimed.action !== "claimed") throw new Error(`Expected claim: ${claimed.reason}`);
    return { turn: claimed.turn, attemptId };
  };
  const finish = async (active: Awaited<ReturnType<typeof claim>>) => {
    for (const started of [true, false]) {
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
  const compact = async (resolver: Resolver | null = liveResolver) => {
    await requestSessionCompaction(db, scope.workspaceId, session.id);
    const claimed = await claim(resolver);
    expect(claimed.turn.source).toBe("compaction");
    return claimed;
  };
  const bindings = (turnId: string) =>
    getSessionTurnMcpAccountBindings(db, scope.workspaceId, session.id, turnId);
  const bound = async (turnId: string) =>
    (await bindings(turnId))?.map((binding) => binding.connectionId) ?? null;
  const delegations = (turnId: string) =>
    getSessionTurnPersonalConnectionDelegations(db, scope.workspaceId, session.id, turnId);
  const intent = (turnId: string) =>
    getSessionTurnConnectionAccountIntent(db, scope.workspaceId, session.id, turnId);
  const metadata = async (turnId: string) => {
    const [row] = await sql`select metadata from session_turns where id = ${turnId}`;
    return row!.metadata as Record<string, unknown>;
  };
  // The connector tools a turn's model request carries: the session's tools
  // routed through that turn's accepted account bindings, as the worker does.
  const toolList = async (turnId: string) => {
    const routed = expandMcpAccountRoutes({
      settings,
      tools: sessionTools,
      bindings: await bindings(turnId),
    });
    return {
      tools: routed.tools.map((tool) => tool.id),
      servers: routed.settings.mcpServers.map((configured) => configured.id),
    };
  };
  const receipts = async (turnId: string) =>
    (
      await sql`select connection_id from turn_connection_authority_snapshots where turn_id = ${turnId}`
    ).map((row) => row.connection_id as string);
  return {
    sql,
    scope,
    alice,
    connect,
    send,
    claim,
    finish,
    compact,
    liveResolver,
    bound,
    delegations,
    intent,
    metadata,
    toolList,
    receipts,
  };
}

/** A person's ordinary turn, accepted and finished with their current accounts. */
async function finishedTurn(
  w: Awaited<ReturnType<typeof world>>,
  picks?: McpConnectionAccountSelection[],
) {
  const origin = await w.send(w.alice, picks);
  const active = await w.claim();
  await w.finish(active);
  return { origin, active };
}

test.skipIf(!realDb)(
  "a compaction keeps the person's accounts and the tool list of the turn before it",
  async () => {
    const w = await world();
    const connection = await w.connect(w.alice);
    const { origin, active } = await finishedTurn(w);
    expect(await w.bound(active.turn.id)).toEqual([connection]);

    const compaction = await w.compact();
    expect(await w.bound(compaction.turn.id)).toEqual([connection]);
    const delegations = await w.delegations(compaction.turn.id);
    expect(delegations).toHaveLength(1);
    expect(delegations).toEqual(await w.delegations(active.turn.id));
    expect(await w.intent(compaction.turn.id)).toEqual(await w.intent(origin.id));
    expect(compaction.turn.initiatingHumanSubjectId).toBe(w.alice);
    // The same connector tools reach the model, so the cached prefix holds.
    const before = await w.toolList(active.turn.id);
    // The person's account route for the session's one connector.
    expect(before.tools).toHaveLength(1);
    expect(await w.toolList(compaction.turn.id)).toEqual(before);
    // Its accepted personal authority is captured like any accepted turn's,
    // so those tools pass the execution-time authority checks.
    expect(await w.receipts(compaction.turn.id)).toEqual([connection]);
    expect((await w.metadata(compaction.turn.id)).connectionAccountGaps).toBeUndefined();
  },
  120_000,
);

test.skipIf(!realDb)(
  "after a reconnect a compaction binds the person's current account",
  async () => {
    const w = await world();
    const first = await w.connect(w.alice);
    await finishedTurn(w);
    await w.sql`update connections set status = 'revoked' where id = ${first}`;
    const reconnected = await w.connect(w.alice);

    const compaction = await w.compact();
    expect(await w.bound(compaction.turn.id)).toEqual([reconnected]);
    expect(await w.receipts(compaction.turn.id)).toEqual([reconnected]);
  },
  120_000,
);

test.skipIf(!realDb)(
  "a revoked pick leaves its connector out of the compaction and records why",
  async () => {
    const w = await world();
    const picked = await w.connect(w.alice);
    const other = await w.connect(w.alice);
    const { active } = await finishedTurn(w, [{ serverId: "mail", connectionId: picked }]);
    expect(await w.bound(active.turn.id)).toEqual([picked]);
    await w.sql`update connections set status = 'revoked' where id = ${picked}`;

    const compaction = await w.compact();
    const accounts = (await w.bound(compaction.turn.id)) ?? [];
    expect(accounts).not.toContain(picked);
    expect(accounts).not.toContain(other);
    expect((await w.toolList(compaction.turn.id)).tools).toEqual([]);
    expect((await w.metadata(compaction.turn.id)).connectionAccountGaps).toEqual([
      expect.objectContaining({ serverId: "mail", connectionId: picked }),
    ]);
  },
  120_000,
);

test.skipIf(!realDb)(
  "a compaction whose accounts cannot be resolved still runs, without them",
  async () => {
    const w = await world();
    await w.connect(w.alice);
    await finishedTurn(w);

    const compaction = await w.compact(async (tx) => {
      // A failed read inside the resolver aborts only its own savepoint.
      await tx.execute("select * from missing_relation_for_compaction_accounts");
      throw new Error("unreachable");
    });
    expect(await w.bound(compaction.turn.id)).toEqual([]);
    expect(await w.delegations(compaction.turn.id)).toEqual([]);
    // Undefined relation: the class and SQLSTATE are kept, never the message.
    expect((await w.metadata(compaction.turn.id)).connectionAccountsUnresolved).toEqual(
      expect.objectContaining({ reason: "resolution_failed", sqlState: "42P01" }),
    );
  },
  120_000,
);

test.skipIf(!realDb)(
  "a resolver can never give a compaction another person's personal account",
  async () => {
    const w = await world();
    await w.connect(w.alice);
    await finishedTurn(w);

    const compaction = await w.compact(async (tx, input) => {
      const resolved = await w.liveResolver(tx, input);
      return {
        ...resolved,
        personalConnectionDelegations: resolved.personalConnectionDelegations.map((delegation) => ({
          ...delegation,
          ownerSubjectId: `other-${crypto.randomUUID()}`,
        })),
      };
    });
    expect(await w.delegations(compaction.turn.id)).toEqual([]);
    expect(await w.bound(compaction.turn.id)).toEqual([]);
    expect(await w.receipts(compaction.turn.id)).toEqual([]);
    expect((await w.metadata(compaction.turn.id)).connectionAccountsUnresolved).toEqual({
      reason: "owner_mismatch",
    });
  },
  120_000,
);

test.skipIf(!realDb)(
  "a compaction after a compaction keeps the same accounts and tool list",
  async () => {
    const w = await world();
    const connection = await w.connect(w.alice);
    const { active } = await finishedTurn(w);
    const first = await w.compact();
    await w.finish(first);

    const second = await w.compact();
    expect(await w.bound(second.turn.id)).toEqual([connection]);
    expect(await w.toolList(second.turn.id)).toEqual(await w.toolList(active.turn.id));
  },
  120_000,
);

test.skipIf(!realDb)(
  "without the live resolver a compaction runs without connection accounts, as before",
  async () => {
    const w = await world();
    await w.connect(w.alice);
    await finishedTurn(w);

    const compaction = await w.compact(null);
    expect(await w.bound(compaction.turn.id)).toEqual([]);
    expect(await w.delegations(compaction.turn.id)).toEqual([]);
  },
  120_000,
);
