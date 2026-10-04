import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION, type EventBus } from "@opengeni/events";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  type DbClient,
} from "@opengeni/db";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../packages/db/src/schema";
import { browserSseDeliveryOptions, sseSessionStream } from "../src/http/sse";

const eventCount = 24;
const text = (sequence: number) =>
  `HEAD-${sequence}-🙂\0${"x".repeat(1024 * 1024)}-TAIL-${sequence}`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function readEventFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let frame = "";
  while (!frame.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("replay ended before a complete event frame");
    frame += decoder.decode(next.value, { stream: true });
  }
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error("replay frame is missing event data");
  return JSON.parse(data.slice(6));
}
const bus = {
  sessionEventDurableFanout: {
    version: SESSION_EVENT_DURABLE_FANOUT_CAPABILITY_VERSION,
    subscribeRecovery: () => () => {},
  },
  subscribe: async () => () => {},
} as unknown as EventBus;
let shared: SharedTestDatabase;
let client: DbClient;
let workspaceId: string;
let sessionId: string;

beforeAll(async () => {
  const fixture = await acquireSharedTestDatabase("session-replay-pages");
  if (!fixture) throw new Error("session replay pages require PostgreSQL");
  shared = fixture;
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Replay fixture",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Replay fixture",
    subjectId: "user:replay-fixture",
  });
  const grant = access.workspaceGrants[0]!;
  workspaceId = grant.workspaceId;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Replay fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  sessionId = session.id;
  await appendSessionEvents(
    client.db,
    workspaceId,
    sessionId,
    Array.from({ length: eventCount }, (_, index) => ({
      type: "agent.message.completed",
      payload: { text: text(index + 1) },
    })),
  );
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("oversized exact replay pages advance without pulling later payloads into the page", async () => {
  let after = 0;
  for (let index = 1; index <= eventCount; index++) {
    const page = await listSessionEventPage(client.db, workspaceId, sessionId, {
      after,
      limit: 100,
    });
    expect(page.events).toHaveLength(1);
    expect(page.fullPayloadsExact).toBe(true);
    expect(page.hasMore).toBe(index < eventCount);
    const event = page.events[0]!;
    expect(event.sequence).toBe(index);
    expect(digest((event.payload as { text: string }).text)).toBe(digest(text(index)));
    after = page.nextAfter!;
  }
  expect(
    (await listSessionEventPage(client.db, workspaceId, sessionId, { after, limit: 100 })).events,
  ).toEqual([]);
});

test("a stalled stream transfers at most the current page and the waiting next page", async () => {
  const receivedSequences: number[] = [];
  const connection = postgres(shared.appUrl, {
    prepare: false,
    transform: {
      value: {
        from: (value, column) => {
          if (column.name === "sequence") receivedSequences.push(Number(value));
          return value;
        },
      },
    },
  });
  const db = drizzle(connection, { schema });
  let released = 0;
  const response = await sseSessionStream(
    db,
    {
      ...bus,
      subscribe: async () => () => {
        released++;
      },
    },
    workspaceId,
    sessionId,
    0,
    new AbortController().signal,
    { stallTimeoutMs: 5_000 },
  );
  const reader = response.body!.getReader();
  try {
    const deadline = Date.now() + 5_000;
    while (receivedSequences.length < 2) {
      if (Date.now() >= deadline) throw new Error("replay did not reach the waiting page");
      await Bun.sleep(10);
    }
    await Bun.sleep(30);
    expect(receivedSequences).toEqual([1, 2]);
    await reader.cancel();
    expect(released).toBe(1);
  } finally {
    await reader.cancel().catch(() => {});
    await connection.end();
  }
}, 15_000);

test("stream reconnect and finite browser batches preserve every large message exactly", async () => {
  for (const finite of [false, true]) {
    let after = 0;
    while (after < eventCount) {
      const abort = new AbortController();
      const response = await sseSessionStream(
        client.db,
        bus,
        workspaceId,
        sessionId,
        after,
        abort.signal,
        finite ? browserSseDeliveryOptions("http1-bounded") : {},
      );
      const reader = response.body!.getReader();
      try {
        const event = await readEventFrame(reader);
        expect(event.sequence).toBe(after + 1);
        expect(digest(event.payload.text)).toBe(digest(text(after + 1)));
        after = event.sequence;
      } finally {
        // Reconnecting before EOF must resume exactly after the delivered frame.
        await reader.cancel();
        abort.abort();
      }
    }
  }
}, 60_000);
