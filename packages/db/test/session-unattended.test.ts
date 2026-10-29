import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SESSION_UNATTENDED_METADATA_KEY, sessionMetadataUnattended } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  SessionCreateIdempotencyConflictError,
  bootstrapWorkspace,
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  getSession,
} from "../src/index";

// An unattended session is recorded under a reserved, immutable metadata key
// that only the explicit create option sets.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-unattended");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Unattended",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Unattended",
    subjectId: `subject-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

function sessionInput(
  grant: Awaited<ReturnType<typeof workspace>>,
  metadata: Record<string, unknown> = {},
) {
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata,
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  };
}

describe("unattended sessions", () => {
  test("the explicit option is frozen in the session metadata", async () => {
    const grant = await workspace();
    const session = await createSession(client.db, { ...sessionInput(grant), unattended: true });
    const read = await getSession(client.db, grant.workspaceId!, session.id);
    expect(sessionMetadataUnattended(read?.metadata)).toBe(true);
    const interactive = await createSession(client.db, sessionInput(grant));
    expect(
      sessionMetadataUnattended(
        (await getSession(client.db, grant.workspaceId!, interactive.id))?.metadata,
      ),
    ).toBe(false);
  }, 60_000);

  test("a caller-supplied metadata key never makes a session unattended", async () => {
    const grant = await workspace();
    const session = await createSession(
      client.db,
      sessionInput(grant, { team: "ops", [SESSION_UNATTENDED_METADATA_KEY]: true }),
    );
    const read = await getSession(client.db, grant.workspaceId!, session.id);
    expect(read?.metadata["team"]).toBe("ops");
    expect(sessionMetadataUnattended(read?.metadata)).toBe(false);
  }, 60_000);

  test("a fork, which a person makes, reads as attended", async () => {
    const grant = await workspace();
    const source = await createSession(client.db, { ...sessionInput(grant), unattended: true });
    const fork = await createSession(client.db, { ...sessionInput(grant), unattended: true });
    // The fork routine copies the source row, metadata included. Replica mode
    // skips the membership foreign key; the provenance check still applies.
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update sessions set forked_from_session_id = ${source.id},
          forked_from_visibility = 'workspace_shared', forked_from_authority_epoch = 1,
          forked_at = now(),
          forked_by_organization_membership_id =
            coalesce(owner_organization_membership_id, gen_random_uuid())
        where id = ${fork.id}`;
    });
    const [stored] = await shared.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from sessions where id = ${fork.id}`;
    expect(sessionMetadataUnattended(stored?.metadata)).toBe(true);
    const read = await getSession(client.db, grant.workspaceId!, fork.id);
    expect(sessionMetadataUnattended(read?.metadata)).toBe(false);
    const original = await getSession(client.db, grant.workspaceId!, source.id);
    expect(sessionMetadataUnattended(original?.metadata)).toBe(true);
  }, 60_000);

  test("a keyed retry that changes the option conflicts", async () => {
    const grant = await workspace();
    const key = `unattended-${crypto.randomUUID()}`;
    const first = await createSessionWithIdempotencyKeyResult(client.db, {
      ...sessionInput(grant),
      unattended: true,
      createIdempotencyKey: key,
    });
    if (first.denied) throw new Error("unexpected denial");
    const replay = await createSessionWithIdempotencyKeyResult(client.db, {
      ...sessionInput(grant),
      unattended: true,
      createIdempotencyKey: key,
    });
    if (replay.denied) throw new Error("unexpected denial");
    expect(replay.created).toBe(false);
    expect(replay.session.id).toBe(first.session.id);
    await expect(
      createSessionWithIdempotencyKeyResult(client.db, {
        ...sessionInput(grant),
        createIdempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(SessionCreateIdempotencyConflictError);
  }, 60_000);
});
