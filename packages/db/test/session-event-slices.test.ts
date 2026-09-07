import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { bootstrapWorkspace, createDb, createSession, listSessionEventPage } from "../src";
import { listSessionEventSlices } from "../src/session-event-slices";
import { LOSSLESS_JSON_STRING_PREFIX, toPostgresLosslessJson } from "../src/lossless-json";
import {
  readSessionEventView,
  SESSION_EVENT_VIEW_MAX_BYTES,
} from "../../../apps/api/src/mcp/session-event-view";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let workspaceId: string;
let accountId: string;
let sessionId: string;
let otherSessionId: string;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-slices");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Slices",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Slices",
    subjectId: crypto.randomUUID(),
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
  otherSessionId = (await makeSession()).id;
}, 180_000);
const makeSession = () =>
  createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "slice fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
beforeEach(async () => {
  sessionId = (await makeSession()).id;
});
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function insert(
  sequence: number,
  type: string,
  payload: unknown,
  version: number | null = null,
) {
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version)
    values (${accountId}, ${workspaceId}, ${sessionId}, ${sequence}, ${type}, ${shared.admin.json(payload as never)}, ${version})`;
}
const read = async (options: Parameters<typeof listSessionEventSlices>[3]) => {
  const page = await listSessionEventSlices(
    client.db,
    workspaceId,
    sessionId,
    options,
    (legacyOptions) => listSessionEventPage(client.db, workspaceId, sessionId, legacyOptions),
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
  return page;
};

for (const direction of ["after", "before"] as const) {
  test(`real PostgreSQL reconstructs >1MiB legacy and canonical scalar text (${direction})`, async () => {
    const sequence = 1;
    const legacy = "🙂界" + "x".repeat(1_048_577);
    const canonical = "a\u0000🙂\ud800\\\n" + "x".repeat(1_048_577);
    await insert(sequence, "agent.message.completed", { text: legacy });
    await insert(
      sequence + 1,
      "agent.message.completed",
      toPostgresLosslessJson({ text: canonical }),
      1,
    );
    const reconstructed = new Map<number, string[]>();
    let cursor: string | undefined;
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(5000);
      const page = await readSessionEventView(
        cursor
          ? { sessionId, cursor }
          : { sessionId, direction, after: sequence - 1, before: sequence + 2 },
        read,
      );
      expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(
        SESSION_EVENT_VIEW_MAX_BYTES,
      );
      expect(page.sourceExact).toBe(true);
      for (const item of page.events) {
        const parts = reconstructed.get(item.sequence) ?? [];
        parts.push(item.text!);
        reconstructed.set(item.sequence, parts);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(reconstructed.get(sequence)?.join("")).toBe(legacy);
    expect(reconstructed.get(sequence + 1)?.join("")).toBe(canonical);
  }, 180_000);
}

test("structured results keep the existing budget and legacy cursors keep UTF-16 offsets", async () => {
  const output = { body: "structured".repeat(2000) };
  await insert(1, "agent.toolCall.output", { callId: "structured", output });
  let cursor: string | undefined;
  let actual = "";
  do {
    const page = await readSessionEventView(
      cursor
        ? { sessionId, cursor }
        : {
            sessionId,
            view: "tools",
            includeOutput: true,
            after: 0,
          },
      read,
    );
    expect(page.sourceExact).toBe(true);
    actual += page.events.map((event) => event.text ?? "").join("");
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(actual).toBe(JSON.stringify(output));
  const text = "🙂prefix" + "x".repeat(20_000);
  await insert(2, "agent.message.completed", { text });
  const legacyCursor = Buffer.from(
    JSON.stringify({
      v: 1,
      selection: {
        sessionId,
        view: "conversation",
        includeArguments: false,
        includeOutput: false,
        callId: null,
        direction: "after",
        after: 1,
        before: null,
      },
      sequence: 2,
      offset: 8,
    }),
  ).toString("base64url");
  const page = await readSessionEventView({ sessionId, cursor: legacyCursor }, read);
  expect(page.events[0]?.text).toBe(text.slice(8, 8 + page.events[0]!.text!.length));
  await insert(3, "agent.toolCall.output", {
    callId: "error",
    output: { isError: true, content: [] },
  });
  const compact = await readSessionEventView({ sessionId, view: "tools", after: 2 }, read);
  expect(compact.events[0]?.isError).toBe(true);
  expect(compact.events[0]?.text).toBeUndefined();
});

test("legacy marker remains literal, malformed canonical marker remains literal, and offsets are checked", async () => {
  const literal = LOSSLESS_JSON_STRING_PREFIX + "YQA=";
  const malformed = LOSSLESS_JSON_STRING_PREFIX + "YQB=";
  await insert(1, "agent.message.completed", { text: literal });
  await insert(2, "agent.message.completed", { text: malformed }, 1);
  await insert(3, "agent.message.completed", toPostgresLosslessJson({ text: "🙂\u0000" }), 1);
  const page = await read({
    after: 0,
    before: 4,
    includeTypes: ["agent.message.completed"],
    view: "conversation",
  });
  expect(page.events.map((event) => (event.payload as { text: string }).text)).toEqual([
    literal,
    malformed,
    "🙂\u0000",
  ]);
  await expect(
    read({ after: 2, before: 4, sourceSequence: 3, sourceOffset: 1, view: "conversation" }),
  ).rejects.toThrow("surrogate pair");
  await expect(
    read({ after: 2, before: 4, sourceSequence: 3, sourceOffset: 99, view: "conversation" }),
  ).rejects.toThrow("offset");
  const other = await listSessionEventSlices(client.db, workspaceId, otherSessionId, {
    after: 0,
    sourceSequence: 3,
    sourceOffset: 0,
    view: "conversation",
  });
  expect(other.events).toEqual([]);
});

test("large result/tool scalar slots remain resumable; structured omissions are explicit", async () => {
  const text = "result ".repeat(320_000);
  await insert(1, "turn.completed", { output: text });
  await insert(2, "agent.toolCall.output", { callId: "large", output: text });
  await insert(3, "agent.toolCall.output", { callId: "structured", output: { body: text } });
  for (const view of ["results", "tools"] as const) {
    const page = await readSessionEventView(
      {
        sessionId,
        view,
        after: 0,
        before: 3,
        ...(view === "tools" ? { callId: "large", includeOutput: true } : {}),
      },
      read,
    );
    expect(page.events[0]!.text).toBe(text.slice(0, page.events[0]!.text!.length));
    expect(page.nextCursor).not.toBeNull();
    expect(page.sourceExact).toBe(true);
  }
  const omitted = await readSessionEventView(
    { sessionId, view: "tools", after: 2, includeOutput: true },
    read,
  );
  expect(omitted.events[0]!.text).toBeUndefined();
  expect(omitted.events[0]!.sourceOmitted).toBeDefined();
  expect(omitted.sourceExact).toBe(false);
  await insert(4, "turn.completed", { output: { body: text } });
  const structuredResult = await readSessionEventView(
    { sessionId, view: "results", after: 3 },
    read,
  );
  expect(structuredResult.events[0]!.sourceOmitted).toBeDefined();
  expect(structuredResult.events[0]!.text).toBeUndefined();
  await insert(5, "agent.toolCall.output", {
    callId: "x".repeat(10_000),
    id: "target",
    output: "wrong",
  });
  const precedence = await readSessionEventView(
    { sessionId, view: "tools", after: 4, callId: "target", includeOutput: true },
    read,
  );
  expect(precedence.events).toEqual([]);
  await insert(
    6,
    "agent.toolCall.output",
    toPostgresLosslessJson({
      callId: "\u0000".repeat(1000),
      name: "\u0000".repeat(1000),
      output: "readable",
    }),
    1,
  );
  const identity = await readSessionEventView(
    { sessionId, view: "tools", after: 5, includeOutput: true },
    read,
  );
  expect(identity.events[0]!.identityOmitted).toBe(true);
  expect(identity.events[0]!.text).toBe("readable");
  expect(Buffer.byteLength(JSON.stringify(identity, null, 2))).toBeLessThanOrEqual(
    SESSION_EVENT_VIEW_MAX_BYTES,
  );
});
