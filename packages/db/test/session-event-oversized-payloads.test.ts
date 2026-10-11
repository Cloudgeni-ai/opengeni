import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  TOOL_CALL_OUTPUT_EVENT_MAX_BYTES,
  sessionEventPayloadTruncation,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  SESSION_EVENT_FULL_READ_MAX_PAYLOAD_BYTES,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-oversized-payloads");
  if (!acquired) throw new Error("PostgreSQL required for oversized event payload regression");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function newSession() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Oversized events",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Oversized events",
    subjectId: `oversized-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session };
}

function noisyText(bytes: number): string {
  let text = "";
  let index = 0;
  while (text.length < bytes) text += `row ${index++} ${crypto.randomUUID()}; `;
  return text.slice(0, bytes);
}

test("tool output is bounded when stored; other event types are stored exactly", async () => {
  const { grant, session } = await newSession();
  const bigOutput = `FIRST ${noisyText(6 * 1024 * 1024)} LAST`;
  const bigMessage = noisyText(400 * 1024);
  await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.toolCall.output", payload: { id: "call-big", output: bigOutput } },
    { type: "agent.toolCall.output", payload: { id: "call-small", output: "done" } },
    { type: "user.message", payload: { text: bigMessage } },
  ]);
  const rows = await shared.admin<{ type: string; callId: string | null; bytes: number }[]>`
    select type, payload ->> 'id' as "callId", octet_length(payload::text) as bytes
    from session_events where session_id = ${session.id} order by sequence`;
  const stored = new Map(rows.map((row) => [row.callId ?? row.type, Number(row.bytes)]));
  expect(stored.get("call-big")).toBeLessThanOrEqual(TOOL_CALL_OUTPUT_EVENT_MAX_BYTES);
  expect(stored.get("user.message")).toBeGreaterThan(400 * 1024);

  const page = await listSessionEventPage(client.db, grant.workspaceId, session.id, {
    payloadMode: "full",
  });
  const [big, small, message] = page.events;
  const bigPayload = big?.payload as { id: string; output: string };
  expect(bigPayload.id).toBe("call-big");
  expect(bigPayload.output.startsWith("FIRST ")).toBe(true);
  expect(bigPayload.output.endsWith(" LAST")).toBe(true);
  expect(sessionEventPayloadTruncation(bigPayload)).toMatchObject({
    truncated: true,
    surface: "durable_audit",
  });
  expect(small?.payload).toEqual({ id: "call-small", output: "done" });
  expect(message?.payload).toEqual({ text: bigMessage });
});

test("full history reads never return an oversized legacy row whole", async () => {
  const { grant, session } = await newSession();
  // A row written before tool output was bounded, inserted directly.
  await shared.admin`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (
      ${grant.accountId}, ${grant.workspaceId}, ${session.id}, 1, 'agent.toolCall.output',
      jsonb_build_object(
        'id', 'legacy-call',
        'output', jsonb_build_object(
          'isError', false,
          'content', jsonb_build_array(jsonb_build_object(
            'type', 'text',
            'text', (select string_agg(md5(n::text), ' ') from generate_series(1, 200000) n)
          ))
        )
      )
    )`;
  await shared.admin`
    insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${grant.accountId}, ${grant.workspaceId}, ${session.id}, 2, 'agent.message.completed',
      jsonb_build_object('text', 'after the big one'))`;
  await shared.admin`update sessions set last_sequence = 2 where id = ${session.id}`;
  const [{ bytes } = { bytes: 0 }] = await shared.admin<{ bytes: number }[]>`
    select octet_length(payload::text) as bytes from session_events
    where session_id = ${session.id} and sequence = 1`;
  expect(Number(bytes)).toBeGreaterThan(SESSION_EVENT_FULL_READ_MAX_PAYLOAD_BYTES);

  const page = await listSessionEventPage(client.db, grant.workspaceId, session.id, {
    payloadMode: "full",
    limit: 1000,
  });
  expect(page.events.map((event) => event.sequence)).toEqual([1]);
  expect(page.fullPayloadsExact).toBe(false);
  const legacy = page.events[0]!.payload as {
    id: string;
    isError: boolean;
    preview: string;
    output?: unknown;
  };
  expect(legacy.id).toBe("legacy-call");
  expect(legacy.isError).toBe(false);
  expect(legacy.output).toBeUndefined();
  expect(legacy.preview.startsWith("c4ca4238a0b923820dcc509a6f75849b ")).toBe(true);
  expect(page.bytes).toBeLessThan(256 * 1024);
  expect(sessionEventPayloadTruncation(legacy)).toMatchObject({
    truncated: true,
    surface: "database_read_projection",
    reason: "payload_bytes_exceeded",
    originalBytes: Number(bytes),
    fullEvidence: { available: false, reason: "oversized" },
  });

  const next = await listSessionEventPage(client.db, grant.workspaceId, session.id, {
    payloadMode: "full",
    after: 1,
  });
  expect(next.fullPayloadsExact).toBe(true);
  expect(next.events[0]?.payload).toEqual({ text: "after the big one" });
});
