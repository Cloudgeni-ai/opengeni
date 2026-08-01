// stream-session-events — cycle rich live-stream scenarios (DB append +
// NATS publish) so an open web tab can watch folds, tool marathons, markdown
// crystallize under fast/slow/laggy/crawl pacing, failures, memory, sandbox,
// and workers. Token-free; no Temporal/LLM.
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
//   OPENGENI_SEED_STREAM_TOKEN_MS   baseline delay between token deltas (default 28)
//   OPENGENI_SEED_STREAM_BURST_MS   pause between phase beats (default 160)
//   OPENGENI_SEED_STREAM_TURN_MS    pause between scenarios (default 900)
//   OPENGENI_SEED_STREAM_MODE=tools  TEMP: only the tools-only vertical scrutiny loop
// Flags: --tools-only
// Per-message pacing presets (fast/slow/crawl/laggy/burst/yank) override the
// baseline so one loop exercises fast models, slow models, and stalling streams.
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  createDb,
  getSession,
  type AppendEventInput,
  type Database,
} from "@opengeni/db";
import { createNatsEventBus, publishDurableSessionEvents, type EventBus } from "@opengeni/events";
import { BASE_URL, WEB_URL } from "./harness";
import {
  SCENARIO_COUNT,
  resolveStreamPacing,
  resolveStreamScenarioMode,
  scenarioForTurn,
  type StreamCtx,
  type StreamPacing,
  type StreamPhase,
  type StreamScenario,
  type StreamScenarioMode,
} from "./stream-scenarios.ts";
import type { ToolSpec } from "./monster/payloads.ts";

const DEFAULT_WORKSPACE = "f9e27d24-06c9-4888-8e24-c658896c36df";
const DEFAULT_SESSION = "e1816d3b-fbc4-40e6-a520-4a5564d3cd78";

const TOKEN_MS = Math.max(8, Number(process.env.OPENGENI_SEED_STREAM_TOKEN_MS ?? "28"));
const BURST_MS = Math.max(40, Number(process.env.OPENGENI_SEED_STREAM_BURST_MS ?? "160"));
const TURN_MS = Math.max(200, Number(process.env.OPENGENI_SEED_STREAM_TURN_MS ?? "900"));
const TOOL_SETTLE_DEFAULT_MS = 200;

function resolveDatabaseUrl(): string {
  return (
    process.env.OPENGENI_DATABASE_URL ??
    "postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni"
  );
}

function resolveNatsUrl(): string {
  return process.env.OPENGENI_NATS_URL ?? "nats://127.0.0.1:4222";
}

function parseArgs(argv: string[]): {
  workspaceId: string;
  sessionId: string;
  mode: StreamScenarioMode;
} {
  let workspaceId =
    process.env.OPENGENI_SEED_WORKSPACE_ID ??
    process.env.OPENGENI_STREAM_WORKSPACE_ID ??
    DEFAULT_WORKSPACE;
  let sessionId =
    process.env.OPENGENI_SEED_SESSION_ID ??
    process.env.OPENGENI_STREAM_SESSION_ID ??
    DEFAULT_SESSION;
  let mode = resolveStreamScenarioMode();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if ((arg === "--workspace" || arg === "-w") && next) {
      workspaceId = next;
      i += 1;
    } else if ((arg === "--session" || arg === "-s") && next) {
      sessionId = next;
      i += 1;
    } else if (arg === "--tools-only" || arg === "--tools") {
      mode = "tools";
    } else if ((arg === "--mode" || arg === "-m") && next) {
      mode = resolveStreamScenarioMode(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun test/e2e/seed/stream-session-events.ts [options]
  --workspace UUID / -w   target workspace
  --session UUID / -s     target session
  --tools-only            TEMP: loop tools-only vertical scrutiny (free varying speed)
  --mode all|tools        same as OPENGENI_SEED_STREAM_MODE

Default cycles ${SCENARIO_COUNT} rich scenarios (DB append + NATS) until Ctrl+C.`);
      process.exit(0);
    }
  }
  return { workspaceId, sessionId, mode };
}

function resolveMs(value: number | ((index: number) => number) | undefined, index: number, fallback: number): number {
  if (value === undefined) return fallback;
  return typeof value === "function" ? value(index) : value;
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
  const rows = sessionUpdate
    ? await appendSessionEventsAndUpdateSession(db, workspaceId, sessionId, events, sessionUpdate)
    : await appendSessionEvents(db, workspaceId, sessionId, events);
  await publishDurableSessionEvents(bus, workspaceId, sessionId, rows);
  return rows.length;
}

function tokenChunks(text: string, chunkChars: number): string[] {
  const target = Math.max(1, Math.floor(chunkChars));
  // Word-ish packing with a small amount of irregularity so fast/yank modes
  // feel like real token boundaries instead of a metronome.
  const words = text.split(/(\s+)/).filter((part) => part.length > 0);
  const chunks: string[] = [];
  let buf = "";
  let i = 0;
  for (const word of words) {
    buf += word;
    const softLimit = target + ((i * 7) % Math.max(1, Math.floor(target / 2)));
    if (buf.length >= softLimit || /\n$/.test(buf)) {
      chunks.push(buf);
      buf = "";
      i += 1;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length > 0 ? chunks : [text];
}

function pacedDelay(pacing: StreamPacing, chunkIndex: number): number {
  let ms = pacing.tokenMs ?? TOKEN_MS;
  const jitter = pacing.jitter ?? 0;
  if (jitter > 0) {
    // Deterministic pseudo-random in [-jitter, +jitter] from chunk index.
    const unit = ((chunkIndex * 1103515245 + 12345) >>> 0) / 0xffffffff;
    ms = ms * (1 + (unit * 2 - 1) * jitter);
  }
  if (pacing.stallEvery && pacing.stallEvery > 0 && pacing.stallMs) {
    if ((chunkIndex + 1) % pacing.stallEvery === 0) {
      ms += pacing.stallMs;
    }
  }
  if (pacing.burstSize && pacing.burstSize > 0 && pacing.burstPauseMs) {
    if ((chunkIndex + 1) % pacing.burstSize === 0) {
      ms += pacing.burstPauseMs;
    }
  }
  return Math.max(4, Math.round(ms));
}

async function streamMessage(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  text: string,
  stream: boolean,
  signal: AbortSignal,
  pacingInput?: Parameters<typeof resolveStreamPacing>[0],
): Promise<number> {
  let published = 0;
  if (!stream) {
    return publish(db, bus, workspaceId, sessionId, [
      { type: "agent.message.delta", payload: { text }, turnId },
    ]);
  }
  const pacing = resolveStreamPacing(pacingInput, TOKEN_MS);
  const chunks = tokenChunks(text, pacing.chunkChars ?? 10);
  for (let i = 0; i < chunks.length; i += 1) {
    if (signal.aborted) return published;
    published += await publish(db, bus, workspaceId, sessionId, [
      { type: "agent.message.delta", payload: { text: chunks[i]! }, turnId },
    ]);
    await sleep(pacedDelay(pacing, i), signal);
  }
  return published;
}

async function streamTool(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  turnId: string,
  tool: ToolSpec,
  signal: AbortSignal,
  settleMs: number,
): Promise<number> {
  let published = 0;
  published += await publish(db, bus, workspaceId, sessionId, [
    {
      type: "agent.toolCall.created",
      payload: {
        id: tool.id,
        name: tool.name,
        arguments: tool.arguments ?? null,
        ...(tool.raw !== undefined ? { raw: tool.raw } : {}),
      },
      turnId,
    },
  ]);
  if (signal.aborted) return published;
  await sleep(settleMs, signal);
  if (signal.aborted || tool.running) return published;
  published += await publish(db, bus, workspaceId, sessionId, [
    {
      type: "agent.toolCall.output",
      payload: {
        id: tool.id,
        output: tool.output ?? null,
        error: Boolean(tool.error),
      },
      turnId,
    },
  ]);
  return published;
}

async function playPhase(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  ctx: StreamCtx,
  phase: StreamPhase,
  signal: AbortSignal,
  messageAcc: { text: string },
): Promise<number> {
  if (signal.aborted) return 0;
  switch (phase.kind) {
    case "sleep":
      await sleep(phase.ms, signal);
      return 0;
    case "reason":
      return publish(db, bus, workspaceId, sessionId, [
        { type: "agent.reasoning.delta", payload: { text: phase.text }, turnId: ctx.turnId },
      ]);
    case "message": {
      messageAcc.text += phase.text;
      return streamMessage(
        db,
        bus,
        workspaceId,
        sessionId,
        ctx.turnId,
        phase.text,
        phase.stream !== false,
        signal,
        phase.pacing,
      );
    }
    case "tools": {
      let published = 0;
      const tools = phase.tools(ctx);
      for (let i = 0; i < tools.length; i += 1) {
        if (signal.aborted) return published;
        const settleMs = Math.max(20, resolveMs(phase.settleMs, i, TOOL_SETTLE_DEFAULT_MS));
        const gapMs = Math.max(
          0,
          resolveMs(phase.gapMs, i, Math.max(80, Math.floor(settleMs * 0.6))),
        );
        published += await streamTool(
          db,
          bus,
          workspaceId,
          sessionId,
          ctx.turnId,
          tools[i]!,
          signal,
          settleMs,
        );
        if (i < tools.length - 1) {
          await sleep(gapMs, signal);
        }
      }
      return published;
    }
    case "memory-save":
      return publish(db, bus, workspaceId, sessionId, [
        {
          type: "memory.saved",
          payload: {
            memoryId: crypto.randomUUID(),
            kind: phase.kindLabel,
            preview: phase.preview,
            deduped: false,
          },
          turnId: ctx.turnId,
        },
      ]);
    case "memory-correct":
      return publish(db, bus, workspaceId, sessionId, [
        {
          type: "memory.corrected",
          payload: {
            memoryId: crypto.randomUUID(),
            kind: phase.kindLabel,
            preview: phase.oldPreview,
            action: "updated",
            reason: "Verified in-session.",
            replacementMemoryId: crypto.randomUUID(),
            replacementPreview: phase.preview,
          },
          turnId: ctx.turnId,
        },
      ]);
    case "sandbox": {
      let published = await publish(db, bus, workspaceId, sessionId, [
        {
          type: "sandbox.operation.started",
          payload: {
            name: phase.operation,
            command: phase.detail ?? phase.operation,
          },
          turnId: ctx.turnId,
        },
      ]);
      await sleep(BURST_MS, signal);
      if (signal.aborted) return published;
      published += await publish(db, bus, workspaceId, sessionId, [
        phase.outcome === "completed"
          ? {
              type: "sandbox.operation.completed",
              payload: { name: phase.operation },
              turnId: ctx.turnId,
            }
          : {
              type: "sandbox.operation.failed",
              payload: {
                name: phase.operation,
                error: phase.detail ?? "sandbox unavailable",
                code: "SANDBOX_UNAVAILABLE",
              },
              turnId: ctx.turnId,
            },
      ]);
      return published;
    }
    case "goal-set":
      return publish(db, bus, workspaceId, sessionId, [
        { type: "goal.set", payload: { text: phase.text }, turnId: ctx.turnId },
      ]);
    case "goal-update":
      return publish(db, bus, workspaceId, sessionId, [
        { type: "goal.updated", payload: { text: phase.text }, turnId: ctx.turnId },
      ]);
    case "raw":
      return publish(db, bus, workspaceId, sessionId, phase.events(ctx));
  }
}

async function streamScenario(
  db: Database,
  bus: EventBus,
  workspaceId: string,
  sessionId: string,
  turnIndex: number,
  scenario: StreamScenario,
  signal: AbortSignal,
): Promise<number> {
  const turnId = crypto.randomUUID();
  const ctx: StreamCtx = {
    turnIndex,
    turnId,
    id: (label) => `stream-${turnIndex}-${label}-${crypto.randomUUID().slice(0, 8)}`,
  };
  let published = 0;
  const messageAcc = { text: "" };

  const [userRow] = await appendSessionEvents(db, workspaceId, sessionId, [
    {
      type: "user.message",
      payload: { text: scenario.userText(ctx) },
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
    ],
    { status: "running" },
  );
  await sleep(BURST_MS, signal);

  for (const phase of scenario.phases) {
    if (signal.aborted) return published;
    published += await playPhase(db, bus, workspaceId, sessionId, ctx, phase, signal, messageAcc);
  }

  if (signal.aborted) return published;

  const closingEvents: AppendEventInput[] = [];
  if (messageAcc.text.length > 0) {
    closingEvents.push({
      type: "agent.message.completed",
      payload: { text: messageAcc.text },
      turnId,
    });
  }
  closingEvents.push({ type: "turn.completed", payload: {}, turnId });
  published += await publish(db, bus, workspaceId, sessionId, closingEvents, { status: "idle" });
  return published;
}

async function main(): Promise<void> {
  const { workspaceId, sessionId, mode } = parseArgs(process.argv.slice(2));
  const databaseUrl = resolveDatabaseUrl();
  const natsUrl = resolveNatsUrl();
  const dbClient = createDb(databaseUrl);
  const bus = await createNatsEventBus(natsUrl);

  const session = await getSession(dbClient.db, workspaceId, sessionId);
  if (!session) {
    throw new Error(`Session not found: workspace=${workspaceId} session=${sessionId}`);
  }

  const link = `${WEB_URL}/workspaces/${workspaceId}/sessions/${sessionId}`;
  console.log(
    `[stream] api=${BASE_URL} db=${databaseUrl.replace(/:[^:@/]+@/, ":***@")} nats=${natsUrl}`,
  );
  console.log(`[stream] workspace=${workspaceId}`);
  console.log(`[stream] session=${sessionId} status=${session.status}`);
  console.log(`[stream] open: ${link}`);
  console.log(
    mode === "tools"
      ? `[stream] MODE=tools (TEMP vertical scrutiny) · burst=${BURST_MS}ms turn=${TURN_MS}ms — Ctrl+C to stop`
      : `[stream] ${SCENARIO_COUNT} scenarios · token=${TOKEN_MS}ms burst=${BURST_MS}ms turn=${TURN_MS}ms — Ctrl+C to stop`,
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
      const scenario = scenarioForTurn(turnIndex, mode);
      console.log(`[stream] ▶ ${scenario.id} — ${scenario.title}`);
      const n = await streamScenario(
        dbClient.db,
        bus,
        workspaceId,
        sessionId,
        turnIndex,
        scenario,
        ac.signal,
      );
      total += n;
      console.log(
        `[stream] ✓ turn=${turnIndex} scenario=${scenario.id} +${n} events (total=${total})`,
      );
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
