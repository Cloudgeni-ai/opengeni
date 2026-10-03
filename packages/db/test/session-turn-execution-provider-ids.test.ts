import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionTurnExecutionProviderIds,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-turn-execution-provider-ids");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("session turn provider PostgreSQL fixture is unavailable");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function sessionWithTurn() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `turn-provider-account-${suffix}`,
    accountName: "Turn provider test",
    workspaceExternalSource: "test",
    workspaceExternalId: `turn-provider-workspace-${suffix}`,
    workspaceName: "Turn provider test",
    subjectId: `turn-provider-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  if (!started.turn) throw new Error("initial turn was not created");
  return { workspaceId: grant.workspaceId!, sessionId: session.id, turnId: started.turn.id };
}

describe("listSessionTurnExecutionProviderIds", () => {
  test("returns each turn's frozen provider and omits policy-less or foreign turns", async () => {
    if (!shared) return;
    const first = await sessionWithTurn();
    const other = await sessionWithTurn();
    // Turns without a frozen policy are legacy: absent from the result.
    expect(
      await listSessionTurnExecutionProviderIds(client.db, first.workspaceId, first.sessionId, [
        first.turnId,
      ]),
    ).toEqual(new Map());

    await shared.admin`
      update session_turns
      set metadata = metadata || ${shared.admin.json({
        turnExecutionPolicyV1: { providerId: "opengeni-gateway" },
      })}::jsonb
      where id in (${first.turnId}, ${other.turnId})`;
    expect(
      await listSessionTurnExecutionProviderIds(client.db, first.workspaceId, first.sessionId, [
        first.turnId,
        first.turnId,
        // Another workspace's turn never resolves through this session scope.
        other.turnId,
      ]),
    ).toEqual(new Map([[first.turnId, "opengeni-gateway"]]));
    expect(
      await listSessionTurnExecutionProviderIds(client.db, first.workspaceId, first.sessionId, []),
    ).toEqual(new Map());
  });
});
