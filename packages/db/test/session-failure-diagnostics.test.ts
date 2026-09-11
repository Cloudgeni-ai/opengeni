import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEventsAndUpdateSession,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionForSubject,
  listSessionEvents,
} from "../src/index";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-failure-diagnostics");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("detail failure survives timeline paging and later pre-claim failure replaces it", async () => {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Failure diagnostics",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Failure diagnostics",
    subjectId: id,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "test",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const read = () => getSessionForSubject(client.db, grant.workspaceId!, session.id, id);
  const events = await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [
      { type: "turn.failed", payload: { error: "Old failure", providerRecoveryCount: 4 } },
      {
        type: "turn.failed",
        payload: { error: "Current failure", providerRecoveryCount: 1, stack: "x".repeat(10000) },
      },
      ...Array.from({ length: 20 }, () => ({
        type: "agent.message.delta" as const,
        payload: { delta: "historical output" },
      })),
    ],
    { status: "failed" },
  );
  const before = await read();
  expect(before?.failureDiagnostics).toMatchObject({
    eventId: events[1]!.id,
    payload: { error: "Current failure", providerRecoveryCount: 1 },
  });
  const tail = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
    direction: "before",
    limit: 3,
  });
  expect(tail.every((e) => e.type !== "turn.failed")).toBe(true);
  expect((await read())?.failureDiagnostics).toEqual(before?.failureDiagnostics);
  expect(
    await getSessionForSubject(client.db, grant.workspaceId!, crypto.randomUUID(), id),
  ).toBeNull();
  // READ COMMITTED can pair an older failed status row with a newer cursor.
  await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [{ type: "session.status.changed", payload: { status: "running" } }],
    { status: "failed" },
  );
  expect((await read())?.failureDiagnostics).toBeNull();
  const longError = "🧪".repeat(3000);
  await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [
      {
        type: "turn.failed",
        payload: { error: longError, code: "provider_unavailable", providerRecoveryCount: 5 },
      },
    ],
    { status: "failed" },
  );
  const projected = (await read())!.failureDiagnostics!;
  expect(projected.payload).toMatchObject({
    error: "🧪".repeat(1024),
    providerRecoveryCount: 5,
    code: "provider_unavailable",
    projection: { truncatedFields: ["error"] },
  });
  expect(new TextEncoder().encode(JSON.stringify(projected)).length).toBeLessThan(40 * 1024);
  const escaped = Object.fromEntries(
    ["error", "message", "detail", "lastRetryableError", "code", "status"].map((key) => [
      key,
      "\u0001".repeat(3000),
    ]),
  );
  await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [{ type: "turn.failed", payload: escaped }],
    { status: "failed" },
  );
  const escapedProjection = (await read())!.failureDiagnostics!;
  expect(new TextEncoder().encode(JSON.stringify(escapedProjection)).length).toBeLessThan(
    40 * 1024,
  );
  expect(escapedProjection.payload).toMatchObject({
    projection: {
      fieldLimitChars: 1024,
      truncatedFields: ["error", "message", "detail", "lastRetryableError", "code", "status"],
    },
  });
  const [unclaimed] = await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [
      {
        type: "session.status.changed",
        payload: { status: "failed", code: "pre_claim_failure", error: "Admission unavailable" },
      },
    ],
    { status: "failed" },
  );
  expect((await read())?.failureDiagnostics).toMatchObject({
    eventId: unclaimed!.id,
    payload: { error: "Admission unavailable" },
  });
  await appendSessionEventsAndUpdateSession(
    client.db,
    grant.workspaceId!,
    session.id,
    [{ type: "session.status.changed", payload: { status: "queued" } }],
    { status: "queued" },
  );
  expect((await read())?.failureDiagnostics).toBeNull();
}, 30_000);
