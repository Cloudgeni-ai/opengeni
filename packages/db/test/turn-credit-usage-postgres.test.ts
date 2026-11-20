import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  createWorkspaceWebhook,
  listSessionTurns,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(180_000);

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-credit-usage");
  if (!shared) {
    if (requireRealDatabase) throw new Error("turn credit usage requires real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl, { max: 1 });
  await client.db.execute(sql`set plan_cache_mode = force_generic_plan`);
}, 900_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const db = () => client!.db;

type Scope = { accountId: string; workspaceId: string; sessionId: string; subjectId: string };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

async function seedSession(label: string): Promise<Scope> {
  const subjectId = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "turn-credit-usage",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: `Turn usage ${label}`,
    workspaceExternalSource: "turn-credit-usage",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: `Turn usage ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId! };
  const session = await createSession(db(), {
    ...scope,
    initialMessage: label,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId, label: "Ada" },
    createdByContext: { label: "Ada" },
  });
  return { ...scope, sessionId: session.id, subjectId };
}

let position = 0;
async function seedTurn(scope: Scope): Promise<string> {
  const turnId = crypto.randomUUID();
  position += 1;
  await withWorkspaceSessionActivityRls(db(), scope.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata, started_at, finished_at
      ) values (
        ${turnId}, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
        ${crypto.randomUUID()}, ${`session-${scope.sessionId}`}, 'completed', ${position},
        'hello', 'scripted-model', 'medium', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        now(), now()
      )
    `);
  });
  return turnId;
}

async function usageRow(
  scope: Scope,
  turnId: string,
  eventType: string,
  quantity: number,
  sourceResourceId: string,
  idempotencyKey = `usage:${eventType}:${sourceResourceId}`,
): Promise<void> {
  await shared!.admin`
    insert into usage_events (
      account_id, workspace_id, session_id, turn_id, event_type, quantity, unit,
      source_resource_type, source_resource_id, idempotency_key, occurred_at
    ) values (
      ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${turnId}, ${eventType},
      ${quantity}, 'usd_micros', 'model_response', ${sourceResourceId}, ${idempotencyKey}, now()
    )`;
}

function creditsSettlement(
  creditCostMicros: number,
  hostedCreditMicros: number | null = null,
): Record<string, unknown> {
  return {
    version: 1,
    chargesOpenGeniCredits: true,
    charges: {
      debits: creditCostMicros > 0,
      creditCostMicros,
      byokPlatformFeeMicros: 0,
      hostedWebSearch:
        hostedCreditMicros === null
          ? null
          : { requests: 1, providerMicros: hostedCreditMicros, creditMicros: hostedCreditMicros },
      completionKey: "unused",
    },
  };
}

function modelUsage(
  sourceKey: string,
  extra: Record<string, unknown>,
  tokens: { input: number; output: number } = { input: 100, output: 10 },
) {
  return {
    sourceKey,
    model: "scripted-model",
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    ...extra,
  };
}

async function terminalEvent(scope: Scope, turnId: string, type: string) {
  return await withRlsContext(db(), scope, async (scoped) => {
    const [row] = rowsOf<{ payload: Record<string, unknown> }>(
      await scoped.execute(sql`select payload from session_events
        where workspace_id = ${scope.workspaceId}::uuid and turn_id = ${turnId}::uuid
          and type = ${type}`),
    );
    return row?.payload;
  });
}

describe("per-turn credit usage on terminal turn events", () => {
  test("terminal usage does not read unrelated billing history under runtime RLS", async () => {
    if (!client) return;
    const scope = await seedSession("large billing history");
    const hostedTurnId = await seedTurn(scope);
    const subscriptionTurnId = await seedTurn(scope);
    // The history is visible to this session's runtime connection, but has
    // nothing to do with either turn. Exercise the real table policies.
    await shared!.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model, reasoning_effort,
        sandbox_backend, resources, tools, metadata, started_at, finished_at
      )
      select md5(n::text)::uuid, ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
        gen_random_uuid(), ${`session-${scope.sessionId}`}, 'completed', n + 1000,
        '', 'scripted-model', 'medium', 'none', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now()
      from generate_series(0, 999) fixture(n)`;
    await shared!.admin`
      insert into usage_events (
        account_id, workspace_id, session_id, turn_id, event_type, quantity, unit, idempotency_key, occurred_at
      )
      select ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId},
        md5((n / 100)::text)::uuid, 'model.tokens', 1, 'count', 'usage:history:' || n::text, now()
      from generate_series(0, 99999) fixture(n)`;
    await shared!.admin`
      insert into credit_ledger_entries (account_id, workspace_id, type, amount_micros, idempotency_key)
      select ${scope.accountId}, ${scope.workspaceId}, 'adjustment', 1,
        'credit:history:' || n::text
      from generate_series(1, 25000) fixture(n)`;
    await shared!.admin`analyze usage_events`;
    await shared!.admin`analyze credit_ledger_entries`;
    const scans = async () => {
      await db().execute(sql`select pg_stat_force_next_flush()`);
      await Bun.sleep(50);
      return await shared!.admin<{ relname: string; seq_tup_read: string }[]>`
        select relname, seq_tup_read::text from pg_stat_user_tables
        where relname in ('usage_events', 'credit_ledger_entries') order by relname`;
    };

    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      ...Array.from({ length: 277 }, (_, index) => ({
        type: "agent.model.usage" as const,
        turnId: subscriptionTurnId,
        payload: modelUsage(
          `subscription-${index}`,
          index < 233
            ? { settlement: { ...creditsSettlement(0), chargesOpenGeniCredits: false } }
            : { pricedCostMicros: 0 },
        ),
      })),
    ]);
    await withRlsContext(db(), scope, async (scoped) => {
      await scoped.execute(sql`insert into credit_ledger_entries
        (account_id, workspace_id, type, amount_micros, idempotency_key)
        values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, 'adjustment', -200,
          ${`credit:byok_platform_fee:${subscriptionTurnId}:subscription-233`})`);
    });
    const beforeSubscription = await scans();
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "turn.completed", turnId: subscriptionTurnId, payload: { status: "completed" } },
    ]);
    const afterSubscription = await scans();
    expect((await terminalEvent(scope, subscriptionTurnId, "turn.completed"))?.usage).toMatchObject(
      {
        creditsMicros: 200,
        tokens: { input: 27_700, output: 2_770 },
      },
    );

    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      {
        type: "agent.model.usage",
        turnId: hostedTurnId,
        payload: modelUsage("settled", { settlement: creditsSettlement(100, 20) }),
      },
      {
        type: "agent.model.usage",
        turnId: hostedTurnId,
        payload: modelUsage("owed", { settlement: creditsSettlement(100, 30) }),
      },
    ]);
    await usageRow(
      scope,
      hostedTurnId,
      "web_search.cost",
      20,
      `hosted:${hostedTurnId}:settled`,
      `usage:web_search.cost:hosted:${hostedTurnId}:settled`,
    );
    const beforeHosted = await scans();
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "turn.completed", turnId: hostedTurnId, payload: { status: "completed" } },
    ]);
    const afterHosted = await scans();
    expect((await terminalEvent(scope, hostedTurnId, "turn.completed"))?.usage).toMatchObject({
      creditsMicros: 250,
      breakdown: { model: 200, webSearch: 50 },
    });
    expect({ subscription: afterSubscription, hosted: afterHosted }).toEqual({
      subscription: beforeSubscription,
      hosted: beforeHosted,
    });
  });

  test("sums every charge of the turn once, including the last call's owed settlement", async () => {
    if (!client) return;
    const scope = await seedSession("credits");
    const turnId = await seedTurn(scope);
    const webhook = await createWorkspaceWebhook(db(), {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      url: "https://example.test/hooks",
      secretEncrypted: "encrypted",
      eventTypes: ["turn.completed"],
      enabled: true,
      description: null,
      createdBySubjectId: scope.subjectId,
    });
    // A: settled (model.cost and its hosted search written).
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      {
        type: "agent.model.usage",
        turnId,
        payload: modelUsage("a", {
          pricedCostMicros: 29_000,
          settlement: creditsSettlement(30_000, 130),
        }),
      },
      // B: its ledger writes are still owed.
      {
        type: "agent.model.usage",
        turnId,
        payload: modelUsage("b", {
          pricedCostMicros: 9_100,
          settlement: creditsSettlement(9_100, 2_000),
        }),
      },
      // A fenced attempt's copy of A is counted once.
      {
        type: "turn.event.rejected_late",
        turnId,
        payload: {
          rejectedType: "agent.model.usage",
          rejectedPayload: modelUsage("a", {
            pricedCostMicros: 29_000,
            settlement: creditsSettlement(30_000, 130),
          }),
        },
      },
    ]);
    await usageRow(scope, turnId, "model.cost", 30_000, `${turnId}:a`);
    await usageRow(
      scope,
      turnId,
      "web_search.cost",
      130,
      `hosted:${turnId}:a`,
      `usage:web_search.cost:hosted:${turnId}:a`,
    );
    await usageRow(scope, turnId, "image_generation.cost", 5_000, "image-1");
    await usageRow(scope, turnId, "video_generation.cost", 700, "video-1");
    // A video that failed and was refunded within the turn nets to nothing.
    await usageRow(scope, turnId, "video_generation.cost", 900, "video-2");
    await usageRow(scope, turnId, "video_generation.refund", 900, "video-2");
    // One partly paid with plan credit that has no way back: only the
    // ledger's refund nets, so 300 stays charged.
    await usageRow(scope, turnId, "video_generation.cost", 900, "video-3");
    await usageRow(scope, turnId, "video_generation.refund", 900, "video-3");
    await withRlsContext(db(), scope, async (scoped) => {
      await scoped.execute(sql`insert into credit_ledger_entries
        (account_id, workspace_id, type, amount_micros, idempotency_key)
        values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, 'video_generation_refund', 600,
          'credit:video_generation_refund:video-3')`);
    });
    // Tokens and provider costs are not credits.
    await usageRow(scope, turnId, "model.provider_cost", 99_999, `${turnId}:x`);
    // C commits with the terminal event, before its settlement runs.
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      {
        type: "agent.model.usage",
        turnId,
        payload: modelUsage(
          "c",
          { pricedCostMicros: 1_000, settlement: creditsSettlement(1_000) },
          { input: 18_000, output: 900 },
        ),
      },
      { type: "turn.completed", turnId, payload: { status: "completed" } },
    ]);

    const expected = {
      creditsMicros: 48_230,
      tokens: { input: 18_200, output: 920 },
      breakdown: { model: 40_100, webSearch: 2_130, imageGeneration: 5_000, other: 1_000 },
    };
    const payload = await terminalEvent(scope, turnId, "turn.completed");
    expect(payload).toEqual({ status: "completed", usage: expected });

    const deliveries = await withRlsContext(db(), scope, async (scoped) =>
      rowsOf<{ payload: { data: Record<string, unknown> } }>(
        await scoped.execute(sql`select payload from workspace_webhook_deliveries
          where webhook_id = ${webhook.id}::uuid`),
      ),
    );
    expect(deliveries.map((row) => row.payload.data)).toEqual([
      { status: "completed", usage: expected },
    ]);

    const turns = await listSessionTurns(db(), scope.workspaceId, scope.sessionId);
    expect(turns.find((turn) => turn.id === turnId)?.usage).toEqual(expected);
  });

  test("a recovered turn counts a fenced attempt's calls, and a failed turn reports what it spent", async () => {
    if (!client) return;
    const scope = await seedSession("recovery");
    const turnId = await seedTurn(scope);
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      {
        type: "turn.event.rejected_late",
        turnId,
        payload: {
          rejectedType: "agent.model.usage",
          rejectedPayload: modelUsage("first-attempt", {
            pricedCostMicros: 4_000,
            settlement: creditsSettlement(4_000),
          }),
        },
      },
      // A compaction call of the second attempt: settled before it is recorded.
      {
        type: "agent.model.usage",
        turnId,
        payload: modelUsage("compaction-1", { pricedCostMicros: 600 }),
      },
    ]);
    await usageRow(scope, turnId, "model.cost", 4_000, `${turnId}:first-attempt`);
    await usageRow(scope, turnId, "model.cost", 600, `${turnId}:compaction-1`);
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "turn.failed", turnId, payload: { reason: "model_error" } },
    ]);
    expect((await terminalEvent(scope, turnId, "turn.failed"))?.usage).toEqual({
      creditsMicros: 4_600,
      tokens: { input: 200, output: 20 },
      breakdown: { model: 4_600, webSearch: 0, imageGeneration: 0, other: 0 },
    });
  });

  test("cancelled, superseded, subscription and bring-your-own-key turns", async () => {
    if (!client) return;
    const scope = await seedSession("kinds");
    // An aggregate call recorded without a price, but settled.
    const cancelled = await seedTurn(scope);
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "agent.model.usage", turnId: cancelled, payload: modelUsage("agg", {}) },
    ]);
    await usageRow(scope, cancelled, "model.cost", 250, `${cancelled}:agg`);
    // An unpriced call: the total is unknown, never a false 0.
    const superseded = await seedTurn(scope);
    // Subscription: 0 credits.
    const subscription = await seedTurn(scope);
    // Bring your own key: a planned fee, plus a fee settled without recorded charges.
    const byok = await seedTurn(scope);
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "agent.model.usage", turnId: superseded, payload: modelUsage("free?", {}) },
      {
        type: "agent.model.usage",
        turnId: subscription,
        payload: modelUsage("sub", {
          pricedCostMicros: 0,
          settlement: {
            version: 1,
            chargesOpenGeniCredits: false,
            charges: {
              debits: false,
              creditCostMicros: 0,
              byokPlatformFeeMicros: 0,
              hostedWebSearch: null,
              completionKey: "k",
            },
          },
        }),
      },
      {
        type: "agent.model.usage",
        turnId: byok,
        payload: modelUsage("planned", {
          pricedCostMicros: 0,
          settlement: {
            version: 1,
            chargesOpenGeniCredits: false,
            charges: {
              debits: false,
              creditCostMicros: 0,
              byokPlatformFeeMicros: 120,
              hostedWebSearch: null,
              completionKey: "k",
            },
          },
        }),
      },
      { type: "agent.model.usage", turnId: byok, payload: modelUsage("plain", {}) },
    ]);
    await usageRow(scope, subscription, "model.cost", 0, `${subscription}:sub`);
    await usageRow(scope, byok, "model.cost", 0, `${byok}:planned`);
    await usageRow(scope, byok, "model.cost", 0, `${byok}:plain`);
    await shared!.admin`
      insert into credit_ledger_entries (account_id, workspace_id, type, amount_micros, idempotency_key)
      values (${scope.accountId}, ${scope.workspaceId}, 'byok_platform_fee', -80,
        ${`credit:byok_platform_fee:${byok}:plain`})`;
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "turn.cancelled", turnId: cancelled, payload: { reason: "user" } },
      { type: "turn.superseded", turnId: superseded, payload: { reason: "steer" } },
      { type: "turn.completed", turnId: subscription, payload: {} },
      { type: "turn.completed", turnId: byok, payload: {} },
    ]);
    const zero = { model: 0, webSearch: 0, imageGeneration: 0, other: 0 };
    const tokens = { input: 100, output: 10 };
    expect((await terminalEvent(scope, cancelled, "turn.cancelled"))?.usage).toEqual({
      creditsMicros: 250,
      tokens,
      breakdown: { ...zero, model: 250 },
    });
    expect((await terminalEvent(scope, superseded, "turn.superseded"))?.usage).toEqual({
      creditsMicros: null,
      tokens,
      breakdown: zero,
    });
    expect((await terminalEvent(scope, subscription, "turn.completed"))?.usage).toEqual({
      creditsMicros: 0,
      tokens,
      breakdown: zero,
    });
    expect((await terminalEvent(scope, byok, "turn.completed"))?.usage).toEqual({
      creditsMicros: 200,
      tokens: { input: 200, output: 20 },
      breakdown: { ...zero, other: 200 },
    });
    const turns = await listSessionTurns(db(), scope.workspaceId, scope.sessionId);
    expect(turns.find((turn) => turn.id === superseded)?.usage?.creditsMicros).toBeNull();
  });

  test("a turn with no charges reports 0; one written outside the tenant scope or never run reports nothing", async () => {
    if (!client) return;
    const scope = await seedSession("scope");
    const idle = await seedTurn(scope);
    const unknown = crypto.randomUUID();
    const running = await seedTurn(scope);
    await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
      { type: "turn.completed", turnId: idle, payload: {} },
      { type: "turn.completed", turnId: unknown, payload: { status: "imported" } },
    ]);
    expect((await terminalEvent(scope, idle, "turn.completed"))?.usage).toEqual({
      creditsMicros: 0,
      tokens: { input: 0, output: 0 },
      breakdown: { model: 0, webSearch: 0, imageGeneration: 0, other: 0 },
    });
    expect(await terminalEvent(scope, unknown, "turn.completed")).toEqual({ status: "imported" });
    // A superuser write has no tenant scope to read the charges in.
    await shared!.admin`
      insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${scope.accountId}, ${scope.workspaceId}, ${scope.sessionId}, ${running},
        max(sequence) + 1, 'turn.failed', '{"reason":"x"}'::jsonb
      from session_events where session_id = ${scope.sessionId}`;
    expect(await terminalEvent(scope, running, "turn.failed")).toEqual({ reason: "x" });
    const turns = await listSessionTurns(db(), scope.workspaceId, scope.sessionId);
    expect(turns.find((turn) => turn.id === running)?.usage).toBeNull();
  });
});
