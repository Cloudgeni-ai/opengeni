// A continued turn resolves its accounts inside the turn claim. The resolution
// shares its reads (`ConnectionAccountReads`): each fact is read once and
// reads with one security context share one scope. These tests pin that the
// result is exactly what the unshared resolution returns, with the same locks,
// for every kind of principal, and that the number of scopes and round trips
// no longer grows with the number of connectors.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { startPgWireProxy, type PgWireProxy } from "@opengeni/testing/pg-wire-proxy";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import type { ConnectionAccountIntent } from "@opengeni/contracts";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  getSessionTurnMcpAccountBindings,
  getSessionTurnPersonalConnectionDelegations,
  requireSession,
  withDatabaseTimingObserver,
  withWorkspaceRls,
  type ClaimSessionWorkForAttemptInput,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { acceptSessionUserMessageWithOutcome } from "../src/domain/sessions";
import { resolveContinuedConnectionAccounts } from "../src/domain/session-connection-accounts";
import {
  intentFor,
  resolveContinuedConnectionAccountsUnshared,
  settings,
  world,
  type World,
} from "./continued-connection-accounts-fixture";

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let proxy: PgWireProxy | null = null;
let proxied: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-continued-accounts-shared-reads");
  if (!shared) {
    if (realDb) throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
  proxy = await startPgWireProxy(shared.appUrl);
  proxied = createDb(proxy.url, { max: 2 });
}, 180_000);

afterAll(async () => {
  await proxied?.close();
  await proxy?.close();
  await client?.close();
  await shared?.release();
}, 60_000);

const handles = () => ({ admin: shared!.admin, db: client!.db });

type Outcome =
  | { ok: Awaited<ReturnType<typeof resolveContinuedConnectionAccounts>> }
  | { error: { name: string; message: string; code: unknown; diagnostic: unknown } };

async function outcome(
  run: () => Promise<Awaited<ReturnType<typeof resolveContinuedConnectionAccounts>>>,
): Promise<Outcome> {
  try {
    return { ok: await run() };
  } catch (error) {
    const failure = error as Error & { code?: unknown; diagnostic?: unknown; cause?: unknown };
    return {
      error: {
        name: failure.name,
        message: failure.message,
        code: failure.code ?? (failure.cause as { code?: unknown } | undefined)?.code,
        diagnostic: failure.diagnostic,
      },
    };
  }
}

/**
 * Resolve the same carried intent with the unshared and the shared reads,
 * each in its own transaction of the claim's shape, and return both results
 * with the advisory locks each transaction held when it finished.
 */
async function both(
  w: World,
  workspaceId: string,
  sessionId: string,
  intent: ConnectionAccountIntent,
) {
  const db = client!.db;
  const locks = async (tx: Database) =>
    (
      (await tx.execute(
        sql`select classid::text || ':' || objid::text || ':' || objsubid::text || ':' || mode as lock
          from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' order by 1`,
      )) as unknown as Array<{ lock: string }>
    ).map((row) => row.lock);
  // The claim supplies its locked session row; both resolutions get it.
  const claimedSession = await requireSession(db, workspaceId, sessionId);
  const input = {
    settings,
    accountId: w.accountId,
    workspaceId,
    sessionId,
    intent,
    claimedSession,
  };
  const unshared = await withWorkspaceRls(db, workspaceId, async (tx) => ({
    outcome: await outcome(() => resolveContinuedConnectionAccountsUnshared({ db: tx, ...input })),
    locks: await locks(tx),
  }));
  const sharedReads = await withWorkspaceRls(db, workspaceId, async (tx) => ({
    outcome: await outcome(() => resolveContinuedConnectionAccounts({ db: tx, ...input })),
    locks: await locks(tx),
  }));
  return { unshared, shared: sharedReads };
}

async function expectSame(
  w: World,
  workspaceId: string,
  sessionId: string,
  intent: ConnectionAccountIntent,
) {
  const { unshared, shared: sharedReads } = await both(w, workspaceId, sessionId, intent);
  expect(sharedReads.outcome).toEqual(unshared.outcome);
  expect(sharedReads.locks).toEqual(unshared.locks);
  return unshared.outcome;
}

const bound = (result: Outcome) => {
  if (!("ok" in result)) throw new Error(`resolution failed: ${result.error.message}`);
  return result.ok;
};

test.skipIf(!realDb)(
  "the initiating person, another member and work without a person resolve exactly as before",
  async () => {
    const w = await world(3, handles());
    const mia = bound(await expectSame(w, w.team, w.teamSession.id, intentFor(w.mia)));
    // Mia's own accounts turned on here and the shared wiki account; never
    // her account from the other workspace, which is not turned on here.
    expect(new Set(mia.mcpAccountBindings!.map((binding) => binding.connectionId))).toEqual(
      new Set([...w.miaAccounts, w.wikiAccount]),
    );
    expect(mia.gaps).toEqual([]);
    const picked = bound(
      await expectSame(
        w,
        w.team,
        w.teamSession.id,
        intentFor(w.mia, [
          { serverId: w.servers[0]!, connectionId: w.miaAccounts[0]! },
          { serverId: w.wiki, connectionId: w.wikiAccount },
        ]),
      ),
    );
    expect(picked.gaps).toEqual([]);
    const bob = bound(await expectSame(w, w.team, w.teamSession.id, intentFor(w.bob)));
    expect(new Set(bob.mcpAccountBindings!.map((binding) => binding.connectionId))).toEqual(
      new Set([w.bobAccount, w.wikiAccount]),
    );
    const carol = bound(await expectSame(w, w.team, w.teamSession.id, intentFor(w.carol)));
    expect(carol.mcpAccountBindings!.map((binding) => binding.connectionId)).toEqual([
      w.wikiAccount,
    ]);
    // Not the initiator and no person behind it: shared accounts only.
    const none = bound(await expectSame(w, w.team, w.teamSession.id, intentFor(null)));
    expect(none.mcpAccountBindings!.map((binding) => binding.connectionId)).toEqual([
      w.wikiAccount,
    ]);
    expect(none.personalConnectionDelegations).toEqual([]);
  },
  180_000,
);

test.skipIf(!realDb)(
  "selection gaps resolve exactly as before: another member's account, a revoked pick",
  async () => {
    const w = await world(3, handles());
    // Bob's account is not Mia's to pick: that connector is left out.
    const notVisible = bound(
      await expectSame(
        w,
        w.team,
        w.teamSession.id,
        intentFor(w.mia, [{ serverId: w.servers[0]!, connectionId: w.bobAccount }]),
      ),
    );
    expect(notVisible.gaps).toEqual([
      { serverId: w.servers[0]!, connectionId: w.bobAccount, reason: "account_not_visible" },
    ]);
    await w.sql`update connections set status = 'revoked' where id = ${w.miaAccounts[1]!}`;
    const revoked = bound(
      await expectSame(
        w,
        w.team,
        w.teamSession.id,
        intentFor(w.mia, [
          { serverId: w.servers[1]!, connectionId: w.miaAccounts[1]! },
          { serverId: w.servers[2]!, connectionId: w.miaAccounts[2]! },
        ]),
      ),
    );
    expect(revoked.gaps.map((gap) => gap.connectionId)).toEqual([w.miaAccounts[1]!]);
    expect(revoked.mcpAccountBindings!.map((binding) => binding.connectionId)).not.toContain(
      w.miaAccounts[1]!,
    );
    // Without a pick the revoked account is simply not bound.
    bound(await expectSame(w, w.team, w.teamSession.id, intentFor(w.mia)));
  },
  180_000,
);

test.skipIf(!realDb)(
  "a person who lost workspace membership resolves exactly as before",
  async () => {
    const w = await world(2, handles());
    await w.sql`delete from workspace_memberships where workspace_id = ${w.team} and subject_id = ${w.mia}`;
    const withPicks = bound(
      await expectSame(
        w,
        w.team,
        w.teamSession.id,
        intentFor(w.mia, [{ serverId: w.servers[0]!, connectionId: w.miaAccounts[0]! }]),
      ),
    );
    // Her own accounts are no longer visible here, so her pick is left out.
    expect(withPicks.gaps).toEqual([
      { serverId: w.servers[0]!, connectionId: w.miaAccounts[0]!, reason: "account_not_visible" },
    ]);
    const withoutPicks = bound(await expectSame(w, w.team, w.teamSession.id, intentFor(w.mia)));
    expect(withoutPicks.personalConnectionDelegations).toEqual([]);
  },
  180_000,
);

test.skipIf(!realDb)(
  "the Personal workspace, another member there and a refused subject resolve exactly as before",
  async () => {
    const w = await world(3, handles());
    // Mia's Personal workspace carries her team connectors and accounts.
    const mia = bound(await expectSame(w, w.miaPersonal, w.personalSession.id, intentFor(w.mia)));
    expect(mia.mcpAccountBindings!.map((binding) => binding.connectionId)).toEqual(
      expect.arrayContaining(w.miaAccounts),
    );
    await expectSame(
      w,
      w.miaPersonal,
      w.personalSession.id,
      intentFor(w.mia, [{ serverId: w.servers[1]!, connectionId: w.miaAccounts[1]! }]),
    );
    // Someone else's subject in Mia's Personal workspace is never its owner.
    await expectSame(w, w.miaPersonal, w.personalSession.id, intentFor(w.bob));
    // An external person with no membership: the membership oracle refuses
    // them (42501). The Personal-workspace check treats that as "not the
    // owner"; the live authority check then fails the resolution. Both agree.
    for (const [workspaceId, sessionId] of [
      [w.miaPersonal, w.personalSession.id],
      [w.team, w.teamSession.id],
    ] as const) {
      const refused = await expectSame(
        w,
        workspaceId,
        sessionId,
        intentFor(`external_user:${crypto.randomUUID()}`),
      );
      expect(refused).toMatchObject({ error: { code: "42501" } });
    }
    await expectSame(w, w.miaPersonal, w.personalSession.id, intentFor(null));
  },
  180_000,
);

test.skipIf(!realDb)(
  "inside a real continued claim both resolutions agree and the claim binds the result",
  async () => {
    const w = await world(3, handles());
    const db = client!.db;
    const scope = { accountId: w.accountId, workspaceId: w.team };
    const origin = (
      await acceptSessionUserMessageWithOutcome(
        {
          settings,
          db,
          bus: new MemoryEventBus(),
          workflowClient: { wakeSessionWorkflow: async () => {} },
          objectStorage: null,
        },
        { ...scope, subjectId: w.mia, permissions: ["admin"], principalKind: "human_session" },
        w.team,
        w.teamSession.id,
        {
          text: "Work",
          clientEventId: crypto.randomUUID(),
          delivery: "send",
          connectionAccounts: [{ serverId: w.servers[0]!, connectionId: w.miaAccounts[0]! }],
        },
      )
    ).turn;
    let compared = 0;
    const resolver: NonNullable<
      ClaimSessionWorkForAttemptInput["resolveContinuedConnectionAccounts"]
    > = async (tx, { sessionId, intent, session }) => {
      const input = { db: tx, settings, ...scope, sessionId, intent, claimedSession: session };
      const unshared = await outcome(() => resolveContinuedConnectionAccountsUnshared(input));
      const resolved = await resolveContinuedConnectionAccounts(input);
      expect({ ok: resolved }).toEqual(unshared as never);
      compared += 1;
      return resolved;
    };
    const claim = async () => {
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(db, w.team, {
        sessionId: w.teamSession.id,
        workflowId: `session-${w.teamSession.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
        resolveContinuedConnectionAccounts: resolver,
      });
      if (claimed.action !== "claimed") throw new Error(`Expected claim: ${claimed.reason}`);
      return { turn: claimed.turn, attemptId };
    };
    const active = await claim();
    for (const started of [true, false]) {
      const settled = await applySessionTurnSettlement(db, w.team, {
        sessionId: w.teamSession.id,
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
    await w.sql`update connections set status = 'revoked' where id = ${w.miaAccounts[0]!}`;
    const childSessionId = crypto.randomUUID();
    await addSessionSystemUpdate(db, {
      ...scope,
      sessionId: w.teamSession.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: childSessionId,
      dedupeKey: `child_terminal_result:${childSessionId}`,
      summary: "Child finished",
      lineage: { parentTurnId: origin.id, parentSessionId: w.teamSession.id },
      payload: { type: "child_terminal_result", childSessionId, status: "idle" as const },
      mcpAccountBindings: await getSessionTurnMcpAccountBindings(
        db,
        w.team,
        w.teamSession.id,
        origin.id,
      ),
      personalConnectionDelegations: await getSessionTurnPersonalConnectionDelegations(
        db,
        w.team,
        w.teamSession.id,
        origin.id,
      ),
    });
    const continued = await claim();
    expect(compared).toBeGreaterThan(0);
    const [row] = await w.sql`select metadata from session_turns where id = ${continued.turn.id}`;
    expect((row!.metadata as Record<string, unknown>).connectionAccountGaps).toEqual([
      expect.objectContaining({ serverId: w.servers[0]!, connectionId: w.miaAccounts[0]! }),
    ]);
  },
  180_000,
);

/** Scopes and round trips one resolution sends, through the counting proxy. */
async function measure(
  w: World,
  resolve: (tx: Database) => Promise<unknown>,
): Promise<{ scopes: number; roundTrips: number; statements: number }> {
  return await withWorkspaceRls(proxied!.db, w.team, async (tx) => {
    let scopes = 0;
    proxy!.reset();
    await withDatabaseTimingObserver(
      (observation) => {
        if (observation.stage === "savepoint_admission") scopes += 1;
      },
      () => resolve(tx),
    );
    return { scopes, ...proxy!.counts() };
  });
}

test.skipIf(!realDb)(
  "one resolution uses a fixed number of scopes and round trips, however many connectors",
  async () => {
    const counts: Record<number, { shared: unknown; unshared: unknown }> = {};
    const sharedCounts: Array<{ scopes: number; roundTrips: number; statements: number }> = [];
    for (const connectors of [1, 3, 6]) {
      const w = await world(connectors, handles());
      const input = {
        settings,
        accountId: w.accountId,
        workspaceId: w.team,
        sessionId: w.teamSession.id,
        intent: intentFor(w.mia, [{ serverId: w.servers[0]!, connectionId: w.miaAccounts[0]! }]),
        // The claim supplies its locked session row, so neither reads it.
        claimedSession: await requireSession(client!.db, w.team, w.teamSession.id),
      };
      const unshared = await measure(w, (tx) =>
        resolveContinuedConnectionAccountsUnshared({ db: tx, ...input }),
      );
      const sharedReads = await measure(w, (tx) =>
        resolveContinuedConnectionAccounts({ db: tx, ...input }),
      );
      counts[connectors] = { shared: sharedReads, unshared };
      sharedCounts.push(sharedReads);
      // The unshared resolution reads per connector and repeats its reads;
      // these bounds fail on it.
      expect(unshared.scopes).toBeGreaterThan(12);
      expect(unshared.roundTrips).toBeGreaterThan(60);
      expect(sharedReads.scopes).toBeLessThanOrEqual(12);
      expect(sharedReads.roundTrips).toBeLessThanOrEqual(60);
    }
    console.info(JSON.stringify(counts));
    // Nothing grows with the number of connectors.
    expect(new Set(sharedCounts.map((count) => JSON.stringify(count))).size).toBe(1);
  },
  180_000,
);
