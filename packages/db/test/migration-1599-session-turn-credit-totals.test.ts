import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  checkSessionTurnCreditTotals,
  createDb,
  createSession,
  withRlsContext,
  withWorkspaceSessionActivityRls,
  type AppendEventInput,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// Contract (1599/1600): a terminal turn event's `usage` is exactly what the
// previous release's trigger (1514) computes, now from running per-turn totals
// the source rows' triggers keep. The oracle is the previous release's own
// trigger, read from the database before 1599 and installed next to the new
// one under another name (writing `usageBefore`), so every terminal event of
// every replayed history carries both answers computed in the same statement.
// 1599 installs the triggers without reading history; 1600 completes the
// turns that existed before it, one per transaction, online, as the
// NOSUPERUSER NOBYPASSRLS owner, while readers recount not-ready turns.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

setDefaultTimeout(600_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let directory: string | null = null;
let shippedFiles: string[] = [];
let ours = -1;

type Scope = { accountId: string; workspaceId: string; sessionId: string };
type Turn = Scope & { turnId: string };

const db = () => client!.db;

/** Deterministic PRNG (mulberry32), so a failure replays. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Random = () => number;
const pick = <T>(random: Random, values: readonly T[]): T =>
  values[Math.floor(random() * values.length)]!;
const int = (random: Random, max: number) => Math.floor(random() * max);

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

/** Files up to and including `last`, linked into the test's migration directory. */
async function linkThrough(last: number) {
  for (const file of shippedFiles.slice(0, last + 1)) {
    await symlink(join(SHIPPED, file), join(directory!, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  }
}

async function seedSession(label: string): Promise<Scope> {
  const subjectId = `user:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(db(), {
    accountExternalSource: "turn-credit-totals",
    accountExternalId: `account:${crypto.randomUUID()}`,
    accountName: `Turn totals ${label}`,
    workspaceExternalSource: "turn-credit-totals",
    workspaceExternalId: `workspace:${crypto.randomUUID()}`,
    workspaceName: `Turn totals ${label}`,
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
  return { ...scope, sessionId: session.id };
}

let position = 0;
async function seedTurn(scope: Scope): Promise<Turn> {
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
      )`);
  });
  return { ...scope, turnId };
}

type UsageRow = {
  eventType: string;
  quantity: number;
  unit?: string;
  source: string | null;
  key: string;
};

/** Usage rows of one turn in one statement, as the runtime role, retries ignored. */
async function usageRows(turn: Turn, rows: UsageRow[]) {
  await withRlsContext(db(), turn, async (tx) => {
    await tx.execute(sql`
      insert into usage_events (account_id, workspace_id, session_id, turn_id, event_type,
        quantity, unit, source_resource_type, source_resource_id, idempotency_key, occurred_at)
      select ${turn.accountId}::uuid, ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid,
        ${turn.turnId}::uuid, row.event_type, row.quantity, coalesce(row.unit, 'usd_micros'),
        'model_response', row.source, row.key, now()
      from jsonb_to_recordset(${JSON.stringify(
        rows.map((row) => ({
          event_type: row.eventType,
          quantity: row.quantity,
          unit: row.unit ?? null,
          source: row.source,
          key: row.key,
        })),
      )}::jsonb) as row(event_type text, quantity bigint, unit text, source text, key text)
      on conflict (idempotency_key) do nothing`);
  });
}

async function ledgerRow(turn: Turn, type: string, amount: number, key: string) {
  await withRlsContext(db(), turn, async (tx) => {
    await tx.execute(sql`insert into credit_ledger_entries
      (account_id, workspace_id, type, amount_micros, idempotency_key)
      values (${turn.accountId}::uuid, ${turn.workspaceId}::uuid, ${type}, ${amount}, ${key})
      on conflict (idempotency_key) do nothing`);
  });
}

const TERMINALS = ["turn.completed", "turn.failed", "turn.cancelled", "turn.superseded"] as const;

/** A recorded model call of any shape the trigger may meet. */
function callPayload(random: Random, sourceKey: unknown): Record<string, unknown> {
  const amount = () => (random() < 0.15 ? int(random, 5_000) + 0.5 : int(random, 50_000));
  const tokens = () =>
    random() < 0.1
      ? {}
      : random() < 0.05
        ? { inputTokens: "12", outputTokens: null }
        : { inputTokens: int(random, 20_000), outputTokens: int(random, 2_000) };
  const hosted =
    random() < 0.3
      ? { requests: 1, providerMicros: 100, creditMicros: int(random, 3_000) }
      : random() < 0.05
        ? { requests: 1, creditMicros: "9" }
        : null;
  const shape = int(random, 9);
  const base: Record<string, unknown> = { model: "scripted-model", ...tokens() };
  if (sourceKey !== undefined) base.sourceKey = sourceKey;
  switch (shape) {
    case 0:
      return base;
    case 1:
      return { ...base, pricedCostMicros: amount() };
    case 2:
    case 3: {
      const credit = amount();
      return {
        ...base,
        pricedCostMicros: random() < 0.8 ? credit : "1",
        settlement: {
          version: 1,
          chargesOpenGeniCredits: true,
          charges: {
            debits: credit > 0,
            creditCostMicros: random() < 0.9 ? credit : null,
            byokPlatformFeeMicros: 0,
            hostedWebSearch: hosted,
            completionKey: "k",
          },
        },
      };
    }
    case 4:
    case 5:
      return {
        ...base,
        pricedCostMicros: 0,
        settlement: {
          version: 1,
          chargesOpenGeniCredits: false,
          charges: {
            debits: false,
            creditCostMicros: 0,
            byokPlatformFeeMicros: random() < 0.6 ? int(random, 400) : random() < 0.5 ? null : "7",
            hostedWebSearch: hosted,
            completionKey: "k",
          },
        },
      };
    case 6:
      return { ...base, settlement: "settled" };
    case 7:
      return {
        ...base,
        pricedCostMicros: amount(),
        settlement: { version: 1, chargesOpenGeniCredits: "yes", charges: {} },
      };
    default:
      return { ...base, settlement: { chargesOpenGeniCredits: true, charges: [] } };
  }
}

/**
 * A call as the current worker records it: its credit charges settled with
 * the usage (so no fee probe), a few with a hosted search.
 */
function productionCall(random: Random, sourceKey: string): Record<string, unknown> {
  const credit = int(random, 40_000);
  return {
    sourceKey,
    model: "scripted-model",
    inputTokens: int(random, 30_000),
    outputTokens: int(random, 2_000),
    pricedCostMicros: credit,
    settlement: {
      version: 1,
      chargesOpenGeniCredits: true,
      charges: {
        debits: credit > 0,
        creditCostMicros: credit,
        byokPlatformFeeMicros: 0,
        hostedWebSearch:
          random() < 0.05 ? { requests: 1, providerMicros: 100, creditMicros: 1_000 } : null,
        completionKey: "k",
      },
    },
  };
}

type History = {
  turn: Turn;
  /** Current usage events by source key, for duplicates. */
  current: Map<string, string>;
  keys: string[];
  videos: number;
};

function newHistory(turn: Turn): History {
  return { turn, current: new Map(), keys: ["a", "b", "c", "d", "e", "f"], videos: 0 };
}

/** One random session-event write of the turn (one statement, one or more rows). */
function randomEvents(random: Random, history: History): AppendEventInput[] {
  const { turn } = history;
  const key = pick(random, history.keys);
  const roll = random();
  if (roll < 0.45) {
    const existing = history.current.get(key);
    if (!existing) {
      return [
        { type: "agent.model.usage", turnId: turn.turnId, payload: callPayload(random, key) },
      ];
    }
    // A retried recording of a call already recorded: classified duplicate.
    return [
      {
        type: "agent.model.usage",
        turnId: turn.turnId,
        payload: callPayload(random, key),
        turnAssociation: "duplicate",
        duplicateOfEventId: existing,
        duplicateReason: "retry",
      },
    ];
  }
  if (roll < 0.55) {
    // A fenced attempt's late usage, kept for audit only.
    return [
      {
        type: "agent.model.usage",
        turnId: turn.turnId,
        payload: callPayload(random, key),
        turnAssociation: "late_rejected",
      },
    ];
  }
  if (roll < 0.75) {
    // The audit row of a fenced attempt's call (counted, first by sequence).
    return [
      {
        type: "turn.event.rejected_late",
        turnId: turn.turnId,
        payload:
          random() < 0.9
            ? { rejectedType: "agent.model.usage", rejectedPayload: callPayload(random, key) }
            : random() < 0.5
              ? { rejectedType: "agent.message", rejectedPayload: callPayload(random, key) }
              : { rejectedType: "agent.model.usage", rejectedPayload: "x" },
      },
    ];
  }
  if (roll < 0.82) {
    // Calls without a usable source key, and an unrelated event.
    return [
      {
        type: "agent.model.usage",
        turnId: turn.turnId,
        payload: callPayload(random, random() < 0.5 ? undefined : int(random, 1_000_000_000)),
      },
      { type: "agent.message.completed", turnId: turn.turnId, payload: { text: "hi" } },
    ];
  }
  // Several calls in one statement.
  const fresh = history.keys.filter((candidate) => !history.current.has(candidate));
  return fresh.slice(0, 1 + int(random, 3)).map((candidate) => ({
    type: "agent.model.usage" as const,
    turnId: turn.turnId,
    payload: callPayload(random, candidate),
  }));
}

async function writeEvents(history: History, inputs: AppendEventInput[]) {
  const written = await appendSessionEvents(
    db(),
    history.turn.workspaceId,
    history.turn.sessionId,
    inputs,
  );
  for (const event of written) {
    const payload = event.payload as Record<string, unknown> | null;
    if (
      event.type === "agent.model.usage" &&
      (event.turnAssociation ?? "current") === "current" &&
      typeof payload?.sourceKey === "string"
    ) {
      history.current.set(payload.sourceKey, event.id);
    }
  }
}

/** One random usage-row or ledger write of the turn. */
async function randomUsage(random: Random, history: History) {
  const { turn } = history;
  const key = pick(random, [...history.keys, "orphan"]);
  const source = `${turn.turnId}:${key}`;
  const roll = random();
  if (roll < 0.35) {
    // The call's model.cost; a retry reuses the key (and is ignored), a
    // second settlement row has its own.
    const suffix = random() < 0.2 ? ":again" : "";
    await usageRows(turn, [
      {
        eventType: "model.cost",
        quantity: int(random, 60_000),
        source,
        key: `usage:model.cost:${source}${suffix}`,
      },
    ]);
  } else if (roll < 0.45) {
    await usageRows(turn, [
      {
        eventType: "web_search.cost",
        quantity: int(random, 3_000),
        source: `hosted:${source}`,
        key: `usage:web_search.cost:hosted:${source}`,
      },
    ]);
  } else if (roll < 0.6) {
    const eventType = pick(random, [
      "image_generation.cost",
      "video_generation.cost",
      "web_search.cost",
      "sandbox.compute.cost",
    ]);
    history.videos += 1;
    await usageRows(turn, [
      {
        eventType,
        quantity: random() < 0.05 ? -int(random, 500) : int(random, 9_000),
        source: `${eventType}-${history.videos}`,
        key: `usage:${eventType}:${turn.turnId}:${history.videos}:${int(random, 3)}`,
      },
    ]);
  } else if (roll < 0.66) {
    // A refund (its ledger row, when present, decides the amount).
    const video = `video-${turn.turnId}-${int(random, 3)}`;
    await usageRows(turn, [
      {
        eventType: "video_generation.refund",
        quantity: int(random, 900),
        source: video,
        key: `usage:video_generation.refund:${video}`,
      },
    ]);
    if (random() < 0.5) {
      await ledgerRow(
        turn,
        "video_generation_refund",
        int(random, 900),
        `credit:video_generation_refund:${video}`,
      );
    }
  } else if (roll < 0.74) {
    // Rows the sum never reads.
    await usageRows(turn, [
      { eventType: "model.refund", quantity: 50, source, key: `usage:model.refund:${source}` },
      {
        eventType: "model.provider_cost",
        quantity: 99_999,
        source,
        key: `usage:model.provider_cost:${source}`,
      },
      {
        eventType: "web_search.cost",
        quantity: 3,
        unit: "count",
        source,
        key: `usage:web_search.count:${source}:${int(random, 5)}`,
      },
      {
        eventType: "model.cost",
        quantity: 5,
        source: null,
        key: `usage:model.cost:nosource:${turn.turnId}:${int(random, 5)}`,
      },
    ]);
  } else if (roll < 0.84) {
    // An own-key platform fee settled for a call without recorded charges.
    await ledgerRow(
      turn,
      "byok_platform_fee",
      -int(random, 500) - 1,
      `credit:byok_platform_fee:${source}`,
    );
  } else if (roll < 0.92) {
    // A usage write that rolls back leaves nothing behind.
    await withRlsContext(db(), turn, async (tx) => {
      await tx.execute(sql`insert into usage_events (account_id, workspace_id, session_id,
        turn_id, event_type, quantity, unit, source_resource_id, idempotency_key, occurred_at)
        values (${turn.accountId}::uuid, ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid,
          ${turn.turnId}::uuid, 'model.cost', 123456, 'usd_micros', ${source},
          ${`usage:rolled-back:${crypto.randomUUID()}`}, now())`);
      throw new Error("rolled back");
    }).catch((error: Error) => {
      if (error.message !== "rolled back") throw error;
    });
  } else {
    await usageRows(turn, [
      {
        eventType: "model.cost",
        quantity: int(random, 60_000),
        source,
        key: `usage:model.cost:${source}`,
      },
      {
        eventType: "image_generation.cost",
        quantity: int(random, 5_000),
        source: `img-${turn.turnId}`,
        key: `usage:image_generation.cost:${turn.turnId}:${int(random, 4)}`,
      },
    ]);
  }
}

/**
 * A random burst of writes to the turn: session events and usage rows in two
 * concurrent lanes (separate transactions, as the worker writes them).
 */
async function burst(random: Random, history: History, writes: number) {
  const eventsRandom = prng(Math.floor(random() * 2 ** 31));
  const usageRandom = prng(Math.floor(random() * 2 ** 31));
  await Promise.all([
    (async () => {
      for (let index = 0; index < writes; index += 1) {
        const inputs = randomEvents(eventsRandom, history);
        if (inputs.length > 0) await writeEvents(history, inputs);
      }
    })(),
    (async () => {
      for (let index = 0; index < writes; index += 1) await randomUsage(usageRandom, history);
    })(),
  ]);
  // A failed statement (a second current recording of a call) leaves no delta.
  if (random() < 0.3) {
    const key = [...history.current.keys()][0];
    if (key) {
      await writeEvents(history, [
        {
          type: "agent.model.usage",
          turnId: history.turn.turnId,
          payload: callPayload(random, "z"),
        },
        {
          type: "agent.model.usage",
          turnId: history.turn.turnId,
          payload: callPayload(random, key),
        },
      ]).then(
        () => {
          throw new Error("a second current recording was accepted");
        },
        (error: Error) => {
          if (error.message === "a second current recording was accepted") throw error;
        },
      );
    }
  }
}

/** A terminal event, sometimes in one statement after the turn's last call. */
async function terminal(random: Random, history: History) {
  const inputs: AppendEventInput[] = [];
  const fresh = history.keys.find((key) => !history.current.has(key));
  if (fresh && random() < 0.4) {
    inputs.push({
      type: "agent.model.usage",
      turnId: history.turn.turnId,
      payload: callPayload(random, fresh),
    });
  }
  inputs.push({ type: pick(random, TERMINALS), turnId: history.turn.turnId, payload: { n: 1 } });
  await writeEvents(history, inputs);
}

type Compared = { turn_id: string; usage: unknown; usage_before: unknown };

/** Terminal events whose new `usage` differs from the previous release's. */
async function terminalMismatches(
  turnIds: string[],
): Promise<{ compared: number; differ: Compared[] }> {
  const rows = await owned!.admin<(Compared & { differs: boolean })[]>`
    select turn_id, payload -> 'usage' as usage, payload -> 'usageBefore' as usage_before,
      (payload -> 'usage') is distinct from (payload -> 'usageBefore') as differs
    from session_events
    where turn_id = any(${turnIds}::uuid[])
      and type in ('turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded')`;
  return {
    compared: rows.length,
    differ: rows.filter((row) => row.differs).map(({ differs: _, ...row }) => row),
  };
}

/** Turns whose kept usage (when kept) differs from the full sum, as the runtime sees them. */
async function keptAgainstFull(turns: Turn[]): Promise<{ kept: number; differ: string[] }> {
  let kept = 0;
  const differ: string[] = [];
  for (const turn of turns) {
    const [row] = await withRlsContext(db(), turn, async (tx) =>
      rowsOf<{ kept: unknown; full: unknown }>(
        await tx.execute(sql`select
          opengeni_private.session_turn_credit_usage_kept_v1(${turn.accountId}::uuid,
            ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid, ${turn.turnId}::uuid) as kept,
          opengeni_private.session_turn_credit_usage_full_v1(${turn.accountId}::uuid,
            ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid, ${turn.turnId}::uuid) as full`),
      ),
    );
    if (row?.kept == null) continue;
    kept += 1;
    if (JSON.stringify(row.kept) !== JSON.stringify(row.full)) differ.push(turn.turnId);
  }
  return { kept, differ };
}

/** The database's message for a rejected query (drizzle wraps it as the cause). */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  return "no error";
}

/** Histories written before 1599 (their turns predate the triggers). */
const preexisting: History[] = [];
let bigTurn: Turn | null = null;
const BIG_CALLS = 3_000;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-1599-turn-credit");
  if (!owned) {
    if (requireRealDatabase) throw new Error("PostgreSQL fixture is unavailable");
    return;
  }
  directory = await mkdtemp(join(tmpdir(), "og-migration-1599-"));
  shippedFiles = (await readdir(SHIPPED)).filter((file) => file.endsWith(".sql")).sort();
  ours = shippedFiles.findIndex((file) => file.endsWith("_session_turn_credit_totals.sql"));
  if (ours < 0) throw new Error("the session turn credit totals migration is missing");
  await linkThrough(ours - 1);
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 12, rlsStrategy: "force" });

  // The oracle: the previous release's terminal trigger, verbatim, writing
  // `usageBefore` from a second trigger with the same condition.
  const [previous] = await owned.admin<{ fn: string; trigger: string }[]>`
    select pg_get_functiondef('opengeni_private.attach_session_turn_credit_usage_v1()'::regprocedure) as fn,
      pg_get_triggerdef(t.oid) as trigger
    from pg_trigger t
    where t.tgrelid = 'session_events'::regclass and t.tgname = 'session_events_turn_credit_usage_v1'`;
  const oracle = previous!.fn
    .replace(
      "opengeni_private.attach_session_turn_credit_usage_v1()",
      "opengeni_private.test_turn_credit_usage_before_1599()",
    )
    .replace(
      "jsonb_build_object('usage', usage_value)",
      "jsonb_build_object('usageBefore', usage_value)",
    );
  expect(oracle).toContain("test_turn_credit_usage_before_1599()");
  expect(oracle).toContain("'usageBefore'");
  await owned.admin.unsafe(oracle);
  const oracleTrigger = previous!.trigger
    .replace("session_events_turn_credit_usage_v1", "session_events_turn_credit_usage_before_1599")
    .replace("attach_session_turn_credit_usage_v1()", "test_turn_credit_usage_before_1599()");
  expect(oracleTrigger).toContain("test_turn_credit_usage_before_1599()");
  await owned.admin.unsafe(oracleTrigger);

  // Histories before the triggers exist, some already finished.
  const random = prng(1599);
  for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
    const scope = await seedSession(`before-${sessionIndex}`);
    for (let turnIndex = 0; turnIndex < 6; turnIndex += 1) {
      const history = newHistory(await seedTurn(scope));
      await burst(random, history, 1 + int(random, 6));
      if (random() < 0.3) await terminal(random, history);
      preexisting.push(history);
    }
  }
  // One long turn: the backfill's largest single recount.
  const scope = await seedSession("before-big");
  bigTurn = await seedTurn(scope);
  for (let chunk = 0; chunk < BIG_CALLS / 500; chunk += 1) {
    await appendSessionEvents(
      db(),
      scope.workspaceId,
      scope.sessionId,
      Array.from({ length: 500 }, (_, index) => ({
        type: "agent.model.usage" as const,
        turnId: bigTurn!.turnId,
        payload: callPayload(random, `big-${chunk * 500 + index}`),
      })),
    );
  }
  await usageRows(
    bigTurn,
    Array.from({ length: BIG_CALLS }, (_, index) => ({
      eventType: "model.cost",
      quantity: 1 + (index % 977),
      source: `${bigTurn!.turnId}:big-${index}`,
      key: `usage:model.cost:${bigTurn!.turnId}:big-${index}`,
    })),
  );
  preexisting.push(newHistory(bigTurn));

  // 1599 alone: triggers and tables, no history read.
  await linkThrough(ours);
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });
}, 1_800_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

test("before the backfill, a turn that predates the triggers keeps the previous full sum", async () => {
  if (!owned) return;
  const random = prng(42);
  // A later write to a pre-existing turn creates its rows not ready.
  const touched = preexisting.slice(0, 6);
  for (const history of touched) await burst(random, history, 2);
  const rows = await owned.admin<{ ready: boolean; n: number }[]>`
    select ready, count(*)::int as n from session_turn_credit_totals
    where turn_id = any(${touched.map((history) => history.turn.turnId)}::uuid[])
    group by ready`;
  expect(rows.every((row) => !row.ready)).toBe(true);
  for (const history of touched) await terminal(random, history);
  const compared = await terminalMismatches(touched.map((history) => history.turn.turnId));
  expect(compared.compared).toBeGreaterThanOrEqual(touched.length);
  expect(compared.differ).toEqual([]);
  expect((await keptAgainstFull(touched.map((history) => history.turn))).kept).toBe(0);
});

test("the batched backfill completes every pre-existing turn exactly while writers keep writing", async () => {
  if (!owned) return;
  // Every pre-existing turn gets rows (not ready) from a write, then 1600
  // runs while writers keep writing to the same turns.
  const random = prng(1600);
  for (const [index, history] of preexisting.entries()) {
    await writeEvents(history, [
      {
        type: "agent.model.usage",
        turnId: history.turn.turnId,
        payload: callPayload(random, `touch-${index}`),
      },
    ]);
    await burst(random, history, 1);
  }
  const [pending] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from session_turn_credit_totals where side = 'events' and not ready`;
  expect(pending!.n).toBe(preexisting.length);

  const writing = { stop: false };
  let writes = 0;
  let maxWriteMs = 0;
  const hot = [preexisting.at(-1)!, ...preexisting.slice(0, 5)];
  const loops = Array.from({ length: 4 }, (_, writer) =>
    (async () => {
      const writerRandom = prng(7000 + writer);
      while (!writing.stop) {
        const history = pick(writerRandom, hot);
        const started = performance.now();
        if (writer % 2 === 0) {
          await writeEvents(history, [
            {
              type: "agent.model.usage",
              turnId: history.turn.turnId,
              payload: callPayload(writerRandom, `live-${writer}-${writes}`),
            },
          ]);
        } else {
          await usageRows(history.turn, [
            {
              eventType: "model.cost",
              quantity: int(writerRandom, 9_000),
              source: `${history.turn.turnId}:live-${writer - 1}-${int(writerRandom, writes + 1)}`,
              key: `usage:model.cost:live:${crypto.randomUUID()}`,
            },
          ]);
        }
        maxWriteMs = Math.max(maxWriteMs, performance.now() - started);
        writes += 1;
      }
    })(),
  );
  const backfillStarted = performance.now();
  try {
    await linkThrough(shippedFiles.length - 1);
    await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory! });
  } finally {
    writing.stop = true;
    await Promise.all(loops);
  }
  const backfillMs = performance.now() - backfillStarted;
  console.info(
    `[turn credit totals backfill] ${preexisting.length} turns (${BIG_CALLS} calls in the largest), ` +
      `${backfillMs.toFixed(0)} ms with ${writes} concurrent writes; max write ${maxWriteMs.toFixed(1)} ms`,
  );
  expect(writes).toBeGreaterThan(10);
  // A writer waits at most for one turn's recount, never for the backfill.
  expect(maxWriteMs).toBeLessThan(1_500);

  const [left] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from session_turn_credit_totals where not ready`;
  expect(left!.n).toBe(0);
  const turns = preexisting.map((history) => history.turn);
  const checked = await keptAgainstFull(turns);
  expect(checked).toEqual({ kept: turns.length - (await refundTurns(turns)), differ: [] });

  for (const history of preexisting) await terminal(random, history);
  const compared = await terminalMismatches(turns.map((turn) => turn.turnId));
  expect(compared.differ).toEqual([]);
});

/** Turns with a refund usage row: recounted, never kept. */
async function refundTurns(turns: Turn[]): Promise<number> {
  const [row] = await owned!.admin<{ n: number }[]>`
    select count(distinct turn_id)::int as n from usage_events
    where turn_id = any(${turns.map((turn) => turn.turnId)}::uuid[])
      and event_type like '%.refund' and event_type <> 'model.refund' and unit = 'usd_micros'`;
  return row!.n;
}

test("replayed random histories give the previous release's usage on every terminal event", async () => {
  if (!owned) return;
  const random = prng(8197);
  const sessions = await Promise.all(
    Array.from({ length: 6 }, (_, index) => seedSession(`replay-${index}`)),
  );
  const turns: Turn[] = [];
  // Sessions run concurrently; within a session, turns follow each other,
  // some finishing more than once (a new attempt after a terminal event).
  await Promise.all(
    sessions.map(async (scope, sessionIndex) => {
      const sessionRandom = prng(Math.floor(random() * 2 ** 31) + sessionIndex);
      for (let turnIndex = 0; turnIndex < 25; turnIndex += 1) {
        const history = newHistory(await seedTurn(scope));
        turns.push(history.turn);
        const rounds = 1 + int(sessionRandom, 3);
        for (let round = 0; round < rounds; round += 1) {
          await burst(sessionRandom, history, 1 + int(sessionRandom, 8));
          await terminal(sessionRandom, history);
        }
      }
    }),
  );
  const compared = await terminalMismatches(turns.map((turn) => turn.turnId));
  console.info(
    `[turn credit totals replay] ${turns.length} turns, ${compared.compared} terminal events`,
  );
  expect(compared.compared).toBeGreaterThan(turns.length);
  expect(compared.differ).toEqual([]);
  // Most turns took the kept path (the rest have a refund and recount).
  const checked = await keptAgainstFull(turns);
  expect(checked.differ).toEqual([]);
  expect(checked.kept).toBeGreaterThan(turns.length / 2);
  expect(checked.kept).toBe(turns.length - (await refundTurns(turns)));
});

test("the sampled drift check compares kept turns and reports a corrupted one", async () => {
  if (!owned) return;
  const scope = await seedSession("drift");
  const turns = await Promise.all(Array.from({ length: 3 }, () => seedTurn(scope)));
  const random = prng(5);
  for (const turn of turns) await burst(random, newHistory(turn), 3);
  const clean = await checkSessionTurnCreditTotals(db(), [scope.accountId], 10);
  expect(clean.mismatchedTurnIds).toEqual([]);
  const kept = (await keptAgainstFull(turns)).kept;
  expect(clean.checked).toBe(kept);
  const plain = await seedTurn(scope);
  await writeEvents(newHistory(plain), [
    { type: "agent.model.usage", turnId: plain.turnId, payload: productionCall(prng(6), "a") },
  ]);
  const [corrupt] = await owned.admin<{ turn_id: string }[]>`
    update session_turn_credit_totals set model_micros = model_micros + 1
    where turn_id = ${plain.turnId} and side = 'events' returning turn_id`;
  expect(corrupt?.turn_id).toBe(plain.turnId);
  const drifted = await checkSessionTurnCreditTotals(db(), [scope.accountId], 10);
  expect(drifted.mismatchedTurnIds).toEqual([plain.turnId]);
});

test("the runtime writes totals only through the triggers; updates mark a turn for recount", async () => {
  if (!owned) return;
  const scope = await seedSession("posture");
  const turn = await seedTurn(scope);
  const history = newHistory(turn);
  await writeEvents(history, [
    { type: "agent.model.usage", turnId: turn.turnId, payload: callPayload(prng(1), "a") },
  ]);
  await usageRows(turn, [
    { eventType: "model.cost", quantity: 10, source: `${turn.turnId}:a`, key: `k:${turn.turnId}` },
  ]);
  const asRuntime = (statement: ReturnType<typeof sql>) =>
    withRlsContext(db(), turn, async (tx) =>
      rowsOf<Record<string, unknown>>(await tx.execute(statement)),
    );
  expect(
    await failure(
      asRuntime(sql`insert into session_turn_credit_totals (turn_id, side, account_id, workspace_id, session_id)
        values (${turn.turnId}::uuid, 'events', ${turn.accountId}::uuid, ${turn.workspaceId}::uuid,
          ${turn.sessionId}::uuid)`),
    ),
  ).toContain("row-level security");
  expect(
    await asRuntime(sql`update session_turn_credit_totals set model_micros = 0
      where turn_id = ${turn.turnId}::uuid returning turn_id`),
  ).toEqual([]);
  expect(
    await asRuntime(sql`delete from session_turn_credit_totals
      where turn_id = ${turn.turnId}::uuid returning turn_id`),
  ).toEqual([]);
  expect(
    await asRuntime(sql`delete from session_turn_credit_calls
      where turn_id = ${turn.turnId}::uuid returning turn_id`),
  ).toEqual([]);
  expect(
    await failure(
      asRuntime(sql`select opengeni_private.session_turn_credit_apply_call(${turn.turnId}::uuid, 'usage',
        ${`${turn.turnId}:x`}, ${turn.accountId}::uuid, ${turn.workspaceId}::uuid, null, null, 5)`),
    ),
  ).toContain("row-level security");
  expect(
    await failure(
      asRuntime(
        sql`select opengeni_private.session_turn_credit_totals_recount(${turn.turnId}::uuid)`,
      ),
    ),
  ).toContain("permission denied");
  expect((await keptAgainstFull([turn])).kept).toBe(1);

  // An update of a counted row has no exact delta: the turn is recounted.
  await owned.admin`update usage_events set quantity = quantity + 1 where idempotency_key = ${`k:${turn.turnId}`}`;
  const [state] = await owned.admin<{ ready: boolean; exact: boolean }[]>`
    select bool_or(ready) as ready, bool_or(exact) as exact from session_turn_credit_totals
    where turn_id = ${turn.turnId}`;
  expect(state).toEqual({ ready: false, exact: false });
  expect((await keptAgainstFull([turn])).kept).toBe(0);
  await terminal(prng(2), history);
  expect((await terminalMismatches([turn.turnId])).differ).toEqual([]);

  const [posture] = await owned.admin<
    {
      force: boolean;
      definers: number;
      public_execute: number;
      app_select: boolean;
      app_insert_update: boolean;
      app_delete: boolean;
      foreign_keys_beyond_workspace: number;
    }[]
  >`
    select bool_and(c.relforcerowsecurity) as force,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private' and p.proname like 'session_turn_credit%' and p.prosecdef) as definers,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'opengeni_private' and (p.proname like 'session_turn_credit%'
          or p.proname in ('clear_session_turn_credit_totals', 'forget_session_turn_credit_totals'))
          and has_function_privilege('public', p.oid, 'EXECUTE')) as public_execute,
      bool_and(has_table_privilege('opengeni_app', c.oid, 'SELECT')) as app_select,
      bool_and(has_table_privilege('opengeni_app', c.oid, 'INSERT')
        and has_table_privilege('opengeni_app', c.oid, 'UPDATE')) as app_insert_update,
      bool_and(has_table_privilege('opengeni_app', c.oid, 'DELETE')) as app_delete,
      (select count(*)::int from pg_constraint fk where fk.contype = 'f'
        and fk.conrelid in ('session_turn_credit_totals'::regclass, 'session_turn_credit_calls'::regclass)
        and fk.confrelid <> 'workspaces'::regclass) as foreign_keys_beyond_workspace
    from pg_class c
    where c.oid in ('session_turn_credit_totals'::regclass, 'session_turn_credit_calls'::regclass)`;
  expect(posture).toEqual({
    force: true,
    definers: 0,
    public_execute: 0,
    app_select: true,
    app_insert_update: true,
    // DELETE serves the session-delete trigger only (its policy needs a trigger).
    app_delete: true,
    foreign_keys_beyond_workspace: 0,
  });
});

test("the backfill never waits for a session event writer holding the turn", async () => {
  if (!owned) return;
  const scope = await seedSession("lock order");
  const turn = await seedTurn(scope);
  await writeEvents(newHistory(turn), [
    { type: "agent.model.usage", turnId: turn.turnId, payload: productionCall(prng(20), "before") },
  ]);
  await owned.admin`update session_turn_credit_totals set ready = false where turn_id = ${turn.turnId}`;
  // Session event writers lock their turns FOR UPDATE (lockSessionEventWriteRows)
  // before they append and wait for the turn's events row. The backfill holds
  // that row while it rebuilds the call rows: a foreign key from them to the
  // turn would make it wait for the writer's turn lock (a deadlock).
  let turnLocked!: () => void;
  const locked = new Promise<void>((resolve) => (turnLocked = resolve));
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const eventWriter = withRlsContext(db(), turn, async (tx) => {
    await tx.execute(sql`select id from session_turns where id = ${turn.turnId}::uuid for update`);
    turnLocked();
    await released;
    await appendSessionEvents(tx, turn.workspaceId, turn.sessionId, [
      {
        type: "agent.model.usage",
        turnId: turn.turnId,
        payload: productionCall(prng(21), "shared"),
      },
    ]);
  });
  await locked;
  const backfill = await readFile(
    join(SHIPPED, "1600_session_turn_credit_totals_backfill.sql"),
    "utf8",
  );
  const owner = postgres(owned.ownerUrl, { max: 1 });
  let backfillError: string | null = null;
  try {
    await owner.begin(async (tx) => {
      await tx`set local lock_timeout = '3s'`;
      // As the migrator's batched backfill runs each batch.
      await tx`select pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true),
        pg_catalog.set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
      const done = await tx.unsafe(backfill);
      // Both of the turn's rows completed, within the lock timeout.
      expect(done.map((row) => row.turn_id)).toEqual([turn.turnId, turn.turnId]);
    });
  } catch (error) {
    backfillError = String((error as { message?: string }).message ?? error);
  } finally {
    release();
    await owner.end();
  }
  await eventWriter;
  expect(backfillError).toBeNull();
  const history = newHistory(turn);
  await terminal(prng(22), history);
  expect((await keptAgainstFull([turn])).kept).toBe(1);
  const compared = await terminalMismatches([turn.turnId]);
  expect(compared.compared).toBe(1);
  expect(compared.differ).toEqual([]);
});

test("direct reads see a turn's totals only in its scope and for a session the person may see", async () => {
  if (!owned) return;
  const scope = await seedSession("privacy");
  const turn = await seedTurn(scope);
  await writeEvents(newHistory(turn), [
    { type: "agent.model.usage", turnId: turn.turnId, payload: productionCall(prng(23), "seen") },
  ]);
  const other = await seedSession("privacy other");
  const visible = (context: { accountId: string; workspaceId?: string }, subjectId?: string) =>
    withRlsContext(db(), context, async (tx) => {
      if (subjectId)
        await tx.execute(sql`select set_config('opengeni.subject_id', ${subjectId}, true)`);
      const [row] = rowsOf<{ totals: number; calls: number; sessions: number }>(
        await tx.execute(sql`select
          (select count(*)::int from session_turn_credit_totals where turn_id = ${turn.turnId}::uuid) as totals,
          (select count(*)::int from session_turn_credit_calls where turn_id = ${turn.turnId}::uuid) as calls,
          (select count(*)::int from sessions where id = ${turn.sessionId}::uuid) as sessions`),
      );
      return row!;
    });
  expect(await visible(turn)).toEqual({ totals: 2, calls: 1, sessions: 1 });
  // The account scope alone (the sampled drift check) sees them.
  expect(await visible({ accountId: turn.accountId })).toMatchObject({ totals: 2, calls: 1 });
  expect(await visible(other)).toMatchObject({ totals: 0, calls: 0 });
  // Another person sees them exactly when they see the session.
  const stranger = await visible(turn, `user:${crypto.randomUUID()}`);
  expect({ totals: stranger.totals, calls: stranger.calls }).toEqual(
    stranger.sessions === 1 ? { totals: 2, calls: 1 } : { totals: 0, calls: 0 },
  );
  const checked = await checkSessionTurnCreditTotals(db(), [turn.accountId], 10);
  expect(checked).toEqual({ checked: 1, mismatchedTurnIds: [] });
});

test("deleting a session deletes its turns' kept rows", async () => {
  if (!owned) return;
  const scope = await seedSession("forget");
  const turn = await seedTurn(scope);
  const kept = await seedTurn(await seedSession("forget other"));
  for (const each of [turn, kept]) {
    await writeEvents(newHistory(each), [
      { type: "agent.model.usage", turnId: each.turnId, payload: productionCall(prng(24), "gone") },
    ]);
  }
  await owned.admin`delete from sessions where id = ${scope.sessionId}`;
  const left = await owned.admin<{ turn_id: string; totals: number; calls: number }[]>`
    select t.turn_id, count(distinct t.side)::int as totals, count(distinct c.source_id)::int as calls
    from session_turn_credit_totals t left join session_turn_credit_calls c on c.turn_id = t.turn_id
    where t.turn_id in (${turn.turnId}, ${kept.turnId}) group by t.turn_id`;
  expect([...left]).toEqual([{ turn_id: kept.turnId, totals: 2, calls: 1 }]);
  const [orphans] = await owned.admin<{ calls: number }[]>`
    select count(*)::int as calls from session_turn_credit_calls where turn_id = ${turn.turnId}`;
  expect(orphans?.calls).toBe(0);
});

test("terminal insert at production shape: kept totals against the previous full sum", async () => {
  if (!owned) return;
  const CALLS = 4_000;
  const scope = await seedSession("perf");
  // The session's other history: earlier turns' events.
  const filler = await seedTurn(scope);
  for (let chunk = 0; chunk < 10; chunk += 1) {
    await appendSessionEvents(
      db(),
      scope.workspaceId,
      scope.sessionId,
      Array.from({ length: 2_000 }, () => ({
        type: "agent.message.completed" as const,
        turnId: filler.turnId,
        payload: { text: "x".repeat(200) },
      })),
    );
  }
  const shaped = async (
    payload: (random: Random, sourceKey: string) => Record<string, unknown>,
  ) => {
    const turn = await seedTurn(scope);
    const random = prng(77);
    for (let chunk = 0; chunk < CALLS / 500; chunk += 1) {
      await appendSessionEvents(
        db(),
        scope.workspaceId,
        scope.sessionId,
        Array.from({ length: 500 }, (_, index) => ({
          type: "agent.model.usage" as const,
          turnId: turn.turnId,
          payload: payload(random, `call-${chunk * 500 + index}`),
        })),
      );
    }
    await usageRows(
      turn,
      Array.from({ length: CALLS }, (_, index) => ({
        eventType: "model.cost",
        quantity: 1 + (index % 977),
        source: `${turn.turnId}:call-${index}`,
        key: `usage:model.cost:${turn.turnId}:call-${index}`,
      })),
    );
    return turn;
  };
  const kept = await shaped(productionCall);
  const recounted = await shaped(productionCall);
  // Calls recorded without their charges (older workers): each still probes
  // the fee ledger at terminal time, as before.
  const legacy = await shaped(callPayload);
  // The previous release's path: no kept rows, so the full sum.
  await owned.admin`delete from session_turn_credit_totals where turn_id = ${recounted.turnId}`;
  await owned.admin`analyze session_events`;
  await owned.admin`analyze usage_events`;
  // Time the new trigger alone.
  await owned.admin`alter table session_events disable trigger session_events_turn_credit_usage_before_1599`;
  type Plan = { ms: number; buffers: number };
  const explain = async (turn: Turn): Promise<Plan> => {
    const [next] = await owned!.admin<{ sequence: number }[]>`
      select max(sequence)::int + 1 as sequence from session_events
      where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}`;
    return await withRlsContext(db(), turn, async (tx) => {
      const [row] = rowsOf<{
        "QUERY PLAN": [{ "Execution Time": number; Plan: Record<string, number> }];
      }>(
        await tx.execute(sql`explain (analyze, buffers, format json)
          insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload, turn_association)
          values (${turn.accountId}::uuid, ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid,
            ${turn.turnId}::uuid, ${next!.sequence}, 'turn.completed', '{}'::jsonb, 'current')`),
      );
      const plan = row!["QUERY PLAN"][0];
      // Roll back: explain analyze inserted the row.
      throw Object.assign(new Error("measured"), {
        measured: {
          ms: plan["Execution Time"],
          buffers: (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0),
        },
      });
    }).catch((error: Error & { measured?: Plan }) => {
      if (!error.measured) throw error;
      return error.measured;
    });
  };
  try {
    // Warm both, then take the best of three.
    const best = async (turn: Turn) => {
      await explain(turn);
      const runs = [await explain(turn), await explain(turn), await explain(turn)];
      return runs.reduce((a, b) => (a.ms <= b.ms ? a : b));
    };
    await owned.admin`select pg_stat_reset()`;
    const after = await best(kept);
    // Where the new terminal insert's remaining time goes (functions it ran).
    await db().execute(sql`select pg_stat_force_next_flush()`);
    await Bun.sleep(100);
    const spent = await owned.admin<{ name: string; ms: number }[]>`
      select funcname as name, round((self_time / greatest(calls, 1))::numeric, 2)::float8 as ms
      from pg_stat_user_functions where calls >= 4 order by self_time desc limit 6`;
    console.info(
      `[turn credit totals perf] terminal insert self time per call: ${spent
        .map((row) => `${row.name} ${row.ms} ms`)
        .join(", ")}`,
    );
    const before = await best(recounted);
    const afterLegacy = await best(legacy);
    console.info(
      `[turn credit totals perf] terminal insert with ${CALLS} calls: before ${before.ms.toFixed(1)} ms / ` +
        `${before.buffers} buffers, after ${after.ms.toFixed(1)} ms / ${after.buffers} buffers; ` +
        `calls without recorded charges: ${afterLegacy.ms.toFixed(1)} ms / ${afterLegacy.buffers} buffers`,
    );
    expect(after.buffers * 10).toBeLessThan(before.buffers);
    expect(after.ms * 2).toBeLessThan(before.ms);

    // What each recorded call now adds to its writer (one row per statement).
    const writer = async (label: string) => {
      const turn = await seedTurn(scope);
      const started = performance.now();
      for (let index = 0; index < 200; index += 1) {
        await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
          {
            type: "agent.model.usage",
            turnId: turn.turnId,
            payload: callPayload(prng(index), `${label}-${index}`),
          },
        ]);
      }
      return (performance.now() - started) / 200;
    };
    const withTotals = await writer("with");
    await owned.admin`alter table session_events disable trigger session_events_turn_credit_totals_v1`;
    const withoutTotals = await writer("without");
    await owned.admin`alter table session_events enable trigger session_events_turn_credit_totals_v1`;
    console.info(
      `[turn credit totals perf] usage event append: ${withoutTotals.toFixed(2)} ms without the totals trigger, ` +
        `${withTotals.toFixed(2)} ms with it`,
    );
  } finally {
    await owned.admin`alter table session_events enable trigger session_events_turn_credit_usage_before_1599`;
  }
});

test("a TRUNCATE of a source clears every kept row and readers recount", async () => {
  if (!owned) return;
  await truncateTest();
});

test("a turn whose records were written before its row starts not ready and keeps the full sum", async () => {
  if (!owned) return;
  const scope = await seedSession("early records");
  const turnId = crypto.randomUUID();
  const early: Turn = { ...scope, turnId };
  // Usage rows cannot precede their turn (a trigger checks it); a session
  // event can: nothing references turn_id with a foreign key.
  await appendSessionEvents(db(), scope.workspaceId, scope.sessionId, [
    { type: "agent.model.usage", turnId, payload: productionCall(prng(8), "early") },
  ]);
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
      )`);
  });
  const history = newHistory(early);
  await burst(prng(9), history, 3);
  await terminal(prng(10), history);
  expect((await keptAgainstFull([early])).kept).toBe(0);
  const compared = await terminalMismatches([turnId]);
  expect(compared.compared).toBe(1);
  expect(compared.differ).toEqual([]);
});

async function truncateTest() {
  const database = owned!;
  const scope = await seedSession("truncate");
  const turn = await seedTurn(scope);
  const history = newHistory(turn);
  await burst(prng(3), history, 4);
  const owner = postgres(database.ownerUrl, { max: 1 });
  try {
    await owner.begin(async (tx) => {
      await tx`truncate usage_events`;
    });
  } finally {
    await owner.end();
  }
  const [left] = await database.admin<{ totals: number; calls: number }[]>`
    select (select count(*)::int from session_turn_credit_totals) as totals,
      (select count(*)::int from session_turn_credit_calls) as calls`;
  expect(left).toEqual({ totals: 0, calls: 0 });
  await burst(prng(4), history, 2);
  await terminal(prng(5), history);
  expect((await terminalMismatches([turn.turnId])).differ).toEqual([]);
  expect((await keptAgainstFull([turn])).kept).toBe(0);
}
