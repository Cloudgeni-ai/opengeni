// stream-session-events — continuously append + NATS-publish realistic session
// events so an open web tab (SSE) updates live. Token-free; no Temporal/LLM.
//
// Defaults target the current monster re-seed session. Ctrl+C stops cleanly.
//
// Run (stack up). Prefer --env-file=/dev/null so a stale .env :5432 URL cannot
// override the remapped compose port (`bun run dev` often uses 6432):
//   OPENGENI_DATABASE_URL=postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni \
//     bun --env-file=/dev/null test/e2e/seed/stream-session-events.ts
//
// Override target:
//   bun --env-file=/dev/null test/e2e/seed/stream-session-events.ts \
//     --workspace <uuid> --session <uuid>
//
// Env (optional):
//   OPENGENI_DATABASE_URL   default postgres://…@127.0.0.1:6432/opengeni
//   OPENGENI_NATS_URL       default nats://127.0.0.1:4222
//   OPENGENI_SEED_WORKSPACE_ID / OPENGENI_SEED_SESSION_ID
//   OPENGENI_SEED_STREAM_TOKEN_MS   delay between token deltas (default 45)
//   OPENGENI_SEED_STREAM_BURST_MS   pause between bursts (default 350)
//   OPENGENI_SEED_STREAM_TURN_MS    pause between full turns (default 1200)
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  createDb,
  getSession,
  type AppendEventInput,
  type Database,
} from "@opengeni/db";
import {
  createNatsEventBus,
  publishDurableSessionEvents,
  type EventBus,
} from "@opengeni/events";
import { execOk } from "./monster/payloads.ts";
import { BASE_URL, WEB_URL } from "./harness";

const DEFAULT_WORKSPACE = "f9e27d24-06c9-4888-8e24-c658896c36df";
const DEFAULT_SESSION = "e1816d3b-fbc4-40e6-a520-4a5564d3cd78";

const TOKEN_MS = Math.max(10, Number(process.env.OPENGENI_SEED_STREAM_TOKEN_MS ?? "45"));
const BURST_MS = Math.max(50, Number(process.env.OPENGENI_SEED_STREAM_BURST_MS ?? "350"));
const TURN_MS = Math.max(200, Number(process.env.OPENGENI_SEED_STREAM_TURN_MS ?? "1200"));

function resolveDatabaseUrl(): string {
  return (
    process.env.OPENGENI_DATABASE_URL ??
    "postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni"
  );
}

function resolveNatsUrl(): string {
  return process.env.OPENGENI_NATS_URL ?? "nats://127.0.0.1:4222";
}

function parseArgs(argv: string[]): { workspaceId: string; sessionId: string } {
  let workspaceId =
    process.env.OPENGENI_SEED_WORKSPACE_ID ??
    process.env.OPENGENI_STREAM_WORKSPACE_ID ??
    DEFAULT_WORKSPACE;
  let sessionId =
    process.env.OPENGENI_SEED_SESSION_ID ??
    process.env.OPENGENI_STREAM_SESSION_ID ??
    DEFAULT_SESSION;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if ((arg === "--workspace" || arg === "-w") && next) {
      workspaceId = next;
      i += 1;
    } else if ((arg === "--session" || arg === "-s") && next) {
      sessionId = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun test/e2e/seed/stream-session-events.ts [--workspace UUID] [--session UUID]
Streams realistic session events (DB append + NATS publish) until Ctrl+C.`);
      process.exit(0);
    }
  }
  return { workspaceId, sessionId };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function publish(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  events: AppendEventInput[],
  sessionUpdate?: { status?: "running" | "idle" },
): Promise<number> {
  if (events.length === 0) return 0;
  // Never set activeTurnId here — that column FKs a real session_turns row.
  // Status alone drives the timeline "Working…" affordance.
  const rows = sessionUpdate
    ? await appendSessionEventsAndUpdateSession(db, workspaceId, sessionId, events, sessionUpdate)
    : await appendSessionEvents(db, workspaceId, sessionId, events);
  await publishDurableSessionEvents(bus, workspaceId, sessionId, rows);
  return rows.length;
}

function tokenChunks(text: string): string[] {
  const words = text.split(/(\s+)/).filter((part) => part.length > 0);
  const chunks: string[] = [];
  let buf = "";
  for (const word of words) {
    buf += word;
    if (buf.length >= 12 || /\n$/.test(buf)) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length > 0 ? chunks : [text];
}

async function streamTurn(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  turnIndex: number,
  signal: AbortSignal,
): Promise<number> {
  const turnId = crypto.randomUUID();
  const callId = `stream-call-${turnIndex}`;
  let published = 0;

  const [userRow] = await appendSessionEvents(db, workspaceId, sessionId, [
    {
      type: "user.message",
      payload: {
        text: `Live stream pulse #${turnIndex}: keep the timeline moving.`,
      },
      turnId: null,
    },
  ]);
  if (!userRow) throw new Error("failed to insert user.message");
  await publishDurableSessionEvents(bus, workspaceId, sessionId, [userRow]);
  published += 1;
  if (signal.aborted) return published;

  published += await publish(
    db,
    bus,
    workspaceId,
    sessionId,
    [
      {
        type: "turn.queued",
        payload: { turnId, triggerEventId: userRow.id, source: "user" },
        turnId,
      },
      {
        type: "turn.started",
        payload: { turnId, triggerEventId: userRow.id },
        turnId,
      },
      {
        type: "agent.reasoning.delta",
        payload: { text: `Planning pulse ${turnIndex}: stream tokens, run a tool, narrate.` },
        turnId,
      },
    ],
    { status: "running" },
  );
  await sleep(BURST_MS, signal);
  if (signal.aborted) return published;

  const narration = [
    `Streaming reply for pulse **${turnIndex}**. `,
    "Tokens arrive in small bursts so the open session can be watched live. ",
    "Next I'll run a quick shell check, then finish the turn.\n\n",
    "- stick-to-bottom should follow\n",
    "- no tip flash from older-history hydration\n",
  ].join("");

  for (const chunk of tokenChunks(narration)) {
    if (signal.aborted) return published;
    published += await publish(db, bus, workspaceId, sessionId, [
      { type: "agent.message.delta", payload: { text: chunk }, turnId },
    ]);
    await sleep(TOKEN_MS, signal);
  }

  await sleep(BURST_MS, signal);
  if (signal.aborted) return published;

  const tool = execOk(callId, `echo stream-pulse-${turnIndex}`);
  published += await publish(db, bus, workspaceId, sessionId, [
    {
      type: "agent.toolCall.created",
      payload: {
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments ?? null,
      },
      turnId,
    },
  ]);
  await sleep(BURST_MS, signal);
  if (signal.aborted) return published;

  published += await publish(db, bus, workspaceId, sessionId, [
    {
      type: "agent.toolCall.output",
      payload: { id: tool.id, output: tool.output ?? null, error: false },
      turnId,
    },
  ]);
  await sleep(TOKEN_MS * 2, signal);
  if (signal.aborted) return published;

  const closing = `Pulse ${turnIndex} complete — tool ok, continuing.\n`;
  for (const chunk of tokenChunks(closing)) {
    if (signal.aborted) return published;
    published += await publish(db, bus, workspaceId, sessionId, [
      { type: "agent.message.delta", payload: { text: chunk }, turnId },
    ]);
    await sleep(TOKEN_MS, signal);
  }

  published += await publish(
    db,
    bus,
    workspaceId,
    sessionId,
    [
      {
        type: "agent.message.completed",
        payload: { text: narration + closing },
        turnId,
      },
      { type: "turn.completed", payload: {}, turnId },
    ],
    { status: "idle" },
  );
  return published;
}

async function main(): Promise<void> {
  const { workspaceId, sessionId } = parseArgs(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();
  const natsUrl = resolveNatsUrl();
  const dbClient = createDb(databaseUrl);
  const bus = await createNatsEventBus(natsUrl);

  const session = await getSession(dbClient.db, workspaceId, sessionId);
  if (!session) {
    throw new Error(`Session not found: workspace=${workspaceId} session=${sessionId}`);
  }

  const link = `${WEB_URL}/workspaces/${workspaceId}/sessions/${sessionId}`;
  console.log(`[stream] api=${BASE_URL} db=${databaseUrl.replace(/:[^:@/]+@/, ":***@")} nats=${natsUrl}`);
  console.log(`[stream] workspace=${workspaceId}`);
  console.log(`[stream] session=${sessionId} status=${session.status}`);
  console.log(`[stream] open: ${link}`);
  console.log(
    `[stream] pacing token=${TOKEN_MS}ms burst=${BURST_MS}ms turn=${TURN_MS}ms — Ctrl+C to stop`,
  );

  const ac = new AbortController();
  const onStop = () => {
    if (!ac.signal.aborted) {
      console.log("\n[stream] stopping…");
      ac.abort();
    }
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  let turnIndex = 0;
  let total = 0;
  try {
    while (!ac.signal.aborted) {
      turnIndex += 1;
      const n = await streamTurn(
        dbClient.db,
        bus,
        workspaceId,
        sessionId,
        turnIndex,
        ac.signal,
      );
      total += n;
      console.log(`[stream] turn=${turnIndex} +${n} events (total=${total})`);
      await sleep(TURN_MS, ac.signal);
    }
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    await bus.close();
    await dbClient.close();
    console.log(`[stream] stopped after ${turnIndex} turn(s), ${total} events published`);
  }
}

await main();
