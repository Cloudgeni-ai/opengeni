// seed-monster-chat — token-free deterministic DB seed: enormous realistic
// session timeline (all tool/renderer paths, long agent solos, human ping-pong,
// failures) via appendSessionEvents. No LLM, no Temporal turn execution.
// Newest ~page is chat-dense (messages/tools/turns); mid-history may include
// fs/usage noise. Re-seed after tip-generator changes to see the open UX.
//
// Pattern matches seed-session-rail.ts (DB createSession, sandboxBackend none).
//
// Run (stack up). Prefer --env-file=/dev/null so a stale .env :5432 URL cannot
// override the remapped compose port (`bun run dev` often uses 6432+):
//   OPENGENI_DATABASE_URL=postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni \
//     OPENGENI_SEED_MONSTER_PROFILE=monster \
//     bun --env-file=/dev/null test/e2e/seed/seed-monster-chat.ts
//
// Faster smoke:
//   OPENGENI_SEED_MONSTER_PROFILE=ui bun --env-file=/dev/null test/e2e/seed/seed-monster-chat.ts
//
// Env (optional):
//   OPENGENI_SEED_BASE_URL / OPENGENI_SEED_WORKSPACE_ID / OPENGENI_SEED_ACCOUNT_ID
//   OPENGENI_SEED_SUBJECT_ID (default: from /v1/access/me)
//   OPENGENI_SEED_WEB_URL
//   OPENGENI_SEED_MONSTER_PROFILE  ui|monster|stress|payload-heavy  (default monster)
//   OPENGENI_SEED_MONSTER_SEED     integer RNG seed (default 1)
//   OPENGENI_SEED_MONSTER_CHUNK    append batch size (default 750)
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  createDb,
  createSession,
  getSession,
  updateSessionTitle,
  withRlsContext,
  type AppendEventInput,
  type Database,
  type Session,
} from "@opengeni/db";
import { and, eq, sql } from "drizzle-orm";
import { sessionEvents, sessions } from "@opengeni/db/schema";
import { BASE_URL, resolveWorkspaceId, WEB_URL } from "./harness";
import {
  buildMonsterEvents,
  resolveProfile,
  type MonsterProfile,
} from "./monster/builder.ts";

const ORIGIN = "monster-chat-seed";
const BATCH = `monster-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const SUBJECT = process.env.OPENGENI_SEED_SUBJECT_ID;
const CHUNK = Math.max(50, Number(process.env.OPENGENI_SEED_MONSTER_CHUNK ?? "750"));
const CHILD_COUNT = 4;

type AccessMe = {
  subjectId?: string;
  defaultWorkspaceId?: string;
  workspaceGrants?: Array<{ workspaceId: string; accountId: string; subjectId: string }>;
};

async function resolveIdentity(): Promise<{
  workspaceId: string;
  accountId: string;
  subjectId: string;
}> {
  const workspaceId =
    process.env.OPENGENI_SEED_WORKSPACE_ID ?? (await resolveWorkspaceId());
  const envAccount = process.env.OPENGENI_SEED_ACCOUNT_ID;
  if (envAccount && SUBJECT) {
    return { workspaceId, accountId: envAccount, subjectId: SUBJECT };
  }
  const res = await fetch(`${BASE_URL}/v1/access/me`, {
    headers: process.env.OPENGENI_SEED_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENGENI_SEED_API_KEY}` }
      : {},
  });
  if (!res.ok) {
    throw new Error(`access/me failed HTTP ${res.status}; set SEED account/subject env vars`);
  }
  const me = (await res.json()) as AccessMe;
  const grant =
    me.workspaceGrants?.find((g) => g.workspaceId === workspaceId) ?? me.workspaceGrants?.[0];
  if (!grant) throw new Error("access/me has no workspace grant for seed target");
  return {
    workspaceId: grant.workspaceId,
    accountId: grant.accountId,
    subjectId: SUBJECT ?? grant.subjectId ?? me.subjectId ?? "dev",
  };
}

function resolveDatabaseUrl(): string {
  if (process.env.OPENGENI_DATABASE_URL) return process.env.OPENGENI_DATABASE_URL;
  return "postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni";
}

function rewriteTriggerIds(
  events: AppendEventInput[],
  clientToEventId: Map<string, string>,
): AppendEventInput[] {
  return events.map((event) => {
    if (event.type !== "turn.queued" && event.type !== "turn.started") return event;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const trigger = payload.triggerEventId;
    if (typeof trigger !== "string" || !trigger.startsWith("monster:trigger:")) return event;
    const real = clientToEventId.get(trigger);
    if (!real) return event;
    return { ...event, payload: { ...payload, triggerEventId: real } };
  });
}

/**
 * Persist events in chunks. Conversational user.message rows (monster:trigger
 * clientEventIds) are inserted alone first so turn.queued/started in the same
 * turn can carry the durable event UUID as triggerEventId.
 */
async function persistChunked(
  db: Database,
  workspaceId: string,
  sessionId: string,
  events: AppendEventInput[],
): Promise<number> {
  const clientToEventId = new Map<string, string>();
  let buffer: AppendEventInput[] = [];
  let inserted = 0;
  let lastLog = 0;

  const flush = async (settleIdle: boolean): Promise<void> => {
    if (buffer.length === 0) {
      if (settleIdle) {
        throw new Error("cannot settle idle with an empty final event batch");
      }
      return;
    }
    const slice = rewriteTriggerIds(buffer, clientToEventId);
    const rows = settleIdle
      ? await appendSessionEventsAndUpdateSession(db, workspaceId, sessionId, slice, {
          status: "idle",
          activeTurnId: null,
        })
      : await appendSessionEvents(db, workspaceId, sessionId, slice);
    inserted += rows.length;
    buffer = [];
    if (inserted - lastLog >= CHUNK * 4 || settleIdle) {
      lastLog = inserted;
      console.log(`[seed:monster-chat] appended ${inserted}/${events.length}`);
    }
  };

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    const isTriggerUser =
      event.type === "user.message" &&
      typeof event.clientEventId === "string" &&
      event.clientEventId.startsWith("monster:trigger:");

    if (isTriggerUser) {
      await flush(false);
      const [row] = await appendSessionEvents(db, workspaceId, sessionId, [event]);
      if (!row) throw new Error("failed to insert trigger user.message");
      clientToEventId.set(event.clientEventId!, row.id);
      inserted += 1;
      continue;
    }

    buffer.push(event);
    const isLast = i === events.length - 1;
    if (!isLast && buffer.length >= CHUNK) {
      await flush(false);
    }
  }
  await flush(true);
  return inserted;
}

async function countEvents(
  db: Database,
  accountId: string,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  return await withRlsContext(db, { accountId, workspaceId }, async (scoped) => {
    const [row] = await scoped
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionEvents)
      .where(
        and(eq(sessionEvents.workspaceId, workspaceId), eq(sessionEvents.sessionId, sessionId)),
      );
    return Number(row?.n ?? 0);
  });
}

async function mkChild(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    parentSessionId: string;
    title: string;
  },
): Promise<Session> {
  const session = await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.title,
    resources: [],
    metadata: { origin: ORIGIN, batch: BATCH, role: "monster-child" },
    model: "scripted-model",
    sandboxBackend: "none",
    parentSessionId: input.parentSessionId,
    maxNestedAgentDepthOverride: 6,
    allowNestedAgentDepthIncrease: true,
    createdBy: { kind: "subject", subjectId: "dev", label: "Monster seed" },
  });
  await updateSessionTitle(db, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    title: input.title,
    source: "user",
  });
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scoped) => {
    await scoped
      .update(sessions)
      .set({ status: "idle", updatedAt: new Date() })
      .where(and(eq(sessions.workspaceId, input.workspaceId), eq(sessions.id, session.id)));
  });
  return session;
}

async function spotCheckApi(workspaceId: string, sessionId: string): Promise<void> {
  const headers = process.env.OPENGENI_SEED_API_KEY
    ? { Authorization: `Bearer ${process.env.OPENGENI_SEED_API_KEY}` }
    : {};
  const sessionRes = await fetch(`${BASE_URL}/v1/workspaces/${workspaceId}/sessions/${sessionId}`, {
    headers,
  });
  if (!sessionRes.ok) {
    console.warn(`[seed:monster-chat] API session check HTTP ${sessionRes.status}`);
    return;
  }
  const session = (await sessionRes.json()) as { status?: string; lastSequence?: number };
  console.log(
    `[seed:monster-chat] API session status=${session.status} lastSequence=${session.lastSequence}`,
  );
  const eventsRes = await fetch(
    `${BASE_URL}/v1/workspaces/${workspaceId}/sessions/${sessionId}/events?limit=5`,
    { headers },
  );
  if (!eventsRes.ok) {
    console.warn(`[seed:monster-chat] API events tail HTTP ${eventsRes.status}`);
    return;
  }
  const body = (await eventsRes.json()) as
    | Array<{ type: string; sequence: number }>
    | { events?: Array<{ type: string; sequence: number }> };
  const tail = Array.isArray(body) ? body : (body.events ?? []);
  console.log(
    `[seed:monster-chat] API events tail: ${tail.map((e) => `${e.sequence}:${e.type}`).join(", ")}`,
  );
}

async function main(): Promise<void> {
  const profile: MonsterProfile = resolveProfile(process.env.OPENGENI_SEED_MONSTER_PROFILE);
  const seed = Number(process.env.OPENGENI_SEED_MONSTER_SEED ?? "1");
  if (!Number.isFinite(seed)) throw new Error("OPENGENI_SEED_MONSTER_SEED must be a number");

  const databaseUrl = resolveDatabaseUrl();
  const { workspaceId, accountId, subjectId } = await resolveIdentity();
  const { db, close } = createDb(databaseUrl);

  console.log(
    `[seed:monster-chat] workspace=${workspaceId} account=${accountId} subject=${subjectId}`,
  );
  console.log(
    `[seed:monster-chat] db=${databaseUrl.replace(/:[^:@/]+@/, ":***@")} profile=${profile} seed=${seed} batch=${BATCH}`,
  );

  try {
    const parent = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "Monster chat seed (synthetic timeline)",
      resources: [],
      metadata: { origin: ORIGIN, batch: BATCH, profile, seed },
      model: "scripted-model",
      sandboxBackend: "none",
      maxNestedAgentDepthOverride: 8,
      allowNestedAgentDepthIncrease: true,
      createdBy: { kind: "subject", subjectId: "dev", label: "Monster seed" },
    });
    await updateSessionTitle(db, {
      workspaceId,
      sessionId: parent.id,
      title: `🧪 Monster chat · ${profile} · seed=${seed}`,
      source: "user",
    });

    const children: Session[] = [];
    const childTitles = [
      "Worker · verify login flow",
      "Worker · migrate billing",
      "Worker · p95 latency baseline",
      "Worker · CI wiring",
    ];
    for (let c = 0; c < CHILD_COUNT; c += 1) {
      children.push(
        await mkChild(db, {
          accountId,
          workspaceId,
          parentSessionId: parent.id,
          title: childTitles[c] ?? `Worker ${c + 1}`,
        }),
      );
    }

    const built = buildMonsterEvents({
      profile,
      seed,
      childSessionIds: children.map((s) => s.id),
    });
    console.log(
      `[seed:monster-chat] built events=${built.events.length} hash=${built.histogramHash}`,
    );
    const topTypes = Object.entries(built.histogram)
      .sort((a, b) => b[1]! - a[1]!)
      .slice(0, 12)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    console.log(`[seed:monster-chat] histogram top: ${topTypes}`);

    const inserted = await persistChunked(db, workspaceId, parent.id, built.events);
    const counted = await countEvents(db, accountId, workspaceId, parent.id);
    const session = await getSession(db, workspaceId, parent.id);
    if (!session) throw new Error("parent session missing after seed");

    if (inserted !== built.events.length) {
      throw new Error(`insert mismatch: inserted=${inserted} built=${built.events.length}`);
    }
    if (counted !== built.events.length) {
      throw new Error(`count mismatch: db=${counted} built=${built.events.length}`);
    }
    if (session.lastSequence !== built.events.length) {
      throw new Error(
        `lastSequence mismatch: ${session.lastSequence} !== ${built.events.length}`,
      );
    }
    if (session.status !== "idle") {
      throw new Error(`expected idle, got ${session.status}`);
    }

    console.log(
      `[seed:monster-chat] DONE session=${parent.id} events=${counted} lastSequence=${session.lastSequence} status=${session.status} children=${children.length}`,
    );
    console.log(`[seed:monster-chat] histogramHash=${built.histogramHash}`);
    await spotCheckApi(workspaceId, parent.id);
    console.log(`[seed:monster-chat] open: ${WEB_URL}/workspaces/${workspaceId}/sessions/${parent.id}`);
  } finally {
    await close();
  }
}

await main();
