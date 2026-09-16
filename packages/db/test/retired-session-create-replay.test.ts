import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSessionWithIdempotencyKeyResult,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase;
let client: DbClient;
const retiredKey = "_opengeni_session_create_host_delegations_v1";

beforeAll(async () => {
  const database = await acquireSharedTestDatabase("retired-session-create-replay");
  if (!database) throw new Error("PostgreSQL required for retired create replay regression");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("new creates strip retired metadata and historical nonempty identities cannot replay as native", async () => {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Create replay test",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Create replay test",
      subjectId: `user:replay-${id}`,
    })
  ).workspaceGrants[0]!;
  const legacySelection = [
    { serverId: "retired", delegationId: crypto.randomUUID(), generation: 1 },
  ];
  const input = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createIdempotencyKey: id,
    initialMessage: "Native create fixture",
    resources: [],
    metadata: { keep: "unchanged", [retiredKey]: legacySelection },
    model: "test",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
  const first = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (first.denied) throw new Error("Unexpected admission denial");
  expect(first.created).toBe(true);
  const [stored] = await shared.admin`select metadata from sessions where id = ${first.session.id}`;
  expect(stored!.metadata.keep).toBe("unchanged");
  expect(stored!.metadata[retiredKey]).toBeUndefined();
  const replay = await createSessionWithIdempotencyKeyResult(client.db, input);
  if (replay.denied) throw new Error("Unexpected replay denial");
  expect(replay.created).toBe(false);
  expect(replay.session.id).toBe(first.session.id);

  // Only the test administrator constructs a pre-cutover historical record.
  await shared.admin`update sessions set metadata = metadata || ${shared.admin.json({ [retiredKey]: legacySelection })}::jsonb where id = ${first.session.id}`;
  await expect(createSessionWithIdempotencyKeyResult(client.db, input)).rejects.toThrow(
    "Session create idempotency key was reused with a different request",
  );
  const [historical] =
    await shared.admin`select metadata from sessions where id = ${first.session.id}`;
  expect(historical!.metadata[retiredKey]).toEqual(legacySelection);
  const [count] =
    await shared.admin`select count(*)::int as count from sessions where workspace_id = ${grant.workspaceId}`;
  expect(count!.count).toBe(1);
});
