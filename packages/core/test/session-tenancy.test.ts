import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionAuthorizationOperation, SessionAuthorizationPort } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getSessionForSubject,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { AccessGrantAuthorization } from "../src/access";
import {
  forkManagedHumanSessionPrivate,
  SessionTenancyManagedHumanRequiredError,
  updateManagedHumanSessionVisibility,
} from "../src/application/session-tenancy";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-session-tenancy");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("managed-human session tenancy application service", () => {
  test("authorizes, mutates, publishes the exact durable events, and replays without a wake", async () => {
    if (!shared || !client) return;
    const userId = `core-session-tenancy-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Core session tenancy",
    });
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== access.defaultWorkspaceId,
    );
    if (!grant) throw new Error("managed human has no personal workspace grant");
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${grant.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'core-test'
      )`;
    const source = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "fork me",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const authorization: AccessGrantAuthorization = {
      grant,
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    };
    const operations: SessionAuthorizationOperation[] = [];
    const sessionAuthorization: SessionAuthorizationPort = {
      authorizeSession: async (input) => {
        operations.push(input.operation);
        return { allowed: true, relatedSessionAccess: "root" };
      },
      resolveListScope: async () => ({ kind: "all" }),
    };
    const bus = new MemoryEventBus();
    const deps = { db: client.db, bus, sessionAuthorization };

    const changed = await updateManagedHumanSessionVisibility(
      deps,
      authorization,
      grant.workspaceId,
      source.id,
      {
        visibility: "private",
        expectedAuthorityEpoch: 1,
        idempotencyKey: "visibility-core-1",
      },
    );
    expect(changed).toMatchObject({
      visibility: "private",
      authorityEpoch: 2,
      changed: true,
      replay: false,
    });
    expect(bus.published[0]?.[0]).toMatchObject({
      id: changed.eventId,
      sessionId: source.id,
      sequence: changed.eventSequence,
      type: "session.visibility.changed",
    });

    const forked = await forkManagedHumanSessionPrivate(
      deps,
      authorization,
      grant.workspaceId,
      source.id,
      { idempotencyKey: "fork-core-1" },
    );
    expect(forked).toMatchObject({ visibility: "private", authorityEpoch: 1, replay: false });
    expect(bus.published[1]?.[0]).toMatchObject({
      id: forked.eventId,
      sessionId: forked.sessionId,
      sequence: 1,
      type: "session.created",
    });

    const replay = await forkManagedHumanSessionPrivate(
      deps,
      authorization,
      grant.workspaceId,
      source.id,
      { idempotencyKey: "fork-core-1" },
    );
    expect(replay).toMatchObject({
      replay: true,
      sessionId: forked.sessionId,
      eventId: forked.eventId,
    });
    expect(bus.published[2]?.[0]?.id).toBe(forked.eventId);
    expect(operations).toEqual([
      "session.visibility.write",
      "session.fork.create",
      "session.fork.create",
    ]);

    const destination = await getSessionForSubject(
      client.db,
      grant.workspaceId,
      forked.sessionId,
      subjectId,
    );
    expect(destination?.tenancy).toMatchObject({
      visibility: "private",
      authorityEpoch: 1,
      ownedByCurrentUser: true,
      fork: { sourceVisibility: "private", sourceAuthorityEpoch: 2 },
    });
  }, 180_000);

  test("rejects a human-shaped bearer before persistence or host authorization", async () => {
    const authorization = {
      grant: {
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: `user:${crypto.randomUUID()}`,
        permissions: ["sessions:read", "sessions:create", "sessions:control"],
      },
      accountGrant: null,
      authenticatedSubjectId: "user:substituted",
      contextIntegrity: false,
      canonicalManagedHumanSession: false,
    } satisfies AccessGrantAuthorization;
    await expect(
      forkManagedHumanSessionPrivate(
        {
          db: null as never,
          bus: null as never,
          sessionAuthorization: {
            authorizeSession: async () => {
              throw new Error("host authorization must not run");
            },
            resolveListScope: async () => ({ kind: "all" }),
          },
        },
        authorization,
        authorization.grant.workspaceId,
        crypto.randomUUID(),
        { idempotencyKey: "denied" },
      ),
    ).rejects.toBeInstanceOf(SessionTenancyManagedHumanRequiredError);
  });
});
