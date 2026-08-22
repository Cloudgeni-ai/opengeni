import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionAuthorizationOperation, SessionAuthorizationPort } from "@opengeni/contracts";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getSessionForSubject,
  SessionTenancyNotActivatedError,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { AccessGrantAuthorization } from "../src/access";
import { HTTPException } from "hono/http-exception";
import { SessionAuthorizationDeniedError } from "../src/session-authorization";
import {
  forkManagedHumanSessionPrivate,
  getManagedHumanSessionCreateCapabilities,
  SessionTenancyManagedHumanRequiredError,
  updateManagedHumanSessionVisibility,
} from "../src/application/session-tenancy";
import {
  issueManagedHumanUserResourceGrant,
  listManagedHumanUserResourceAuthorities,
  revokeManagedHumanUserResourceGrant,
} from "../src/application/user-resource-grants";

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
  test("reports private-create availability to members only after organization enablement", async () => {
    if (!shared || !client) return;
    const userId = `core-private-create-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Private create capability",
    });
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    );
    if (!grant) throw new Error("managed human has no shared workspace grant");
    const canonical = {
      grant,
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    } satisfies AccessGrantAuthorization;

    await expect(
      getManagedHumanSessionCreateCapabilities(
        { db: client.db },
        {
          ...canonical,
          grant: {
            ...grant,
            permissions: grant.permissions.filter(
              (permission) => permission !== "sessions:create" && permission !== "workspace:admin",
            ),
          },
        },
        grant.workspaceId,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      getManagedHumanSessionCreateCapabilities({ db: client.db }, canonical, grant.workspaceId),
    ).resolves.toEqual({
      activated: false,
      canCreatePrivate: false,
      reason: "not_activated",
    });
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${grant.accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'core-private-create'
      )`;
    await expect(
      getManagedHumanSessionCreateCapabilities({ db: client.db }, canonical, grant.workspaceId),
    ).resolves.toEqual({
      activated: false,
      canCreatePrivate: false,
      reason: "not_activated",
    });
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${grant.accountId} and subject_id = ${subjectId}`;
    if (!membership) throw new Error("organization membership missing");
    await shared.admin`
      insert into organization_private_session_settings (
        account_id, enabled, version, updated_by_membership_id
      ) values (${grant.accountId}, true, 1, ${membership.id})`;
    await shared.admin`
      update organization_memberships set role = 'member' where id = ${membership.id}`;
    await expect(
      getManagedHumanSessionCreateCapabilities({ db: client.db }, canonical, grant.workspaceId),
    ).resolves.toEqual({
      activated: true,
      canCreatePrivate: true,
      reason: "available",
    });
    // A canonical managed human without an ACTIVE organization membership is a
    // capability answer (not private-ready), never an unmapped database error.
    await shared.admin`
      update organization_memberships set status = 'suspended' where id = ${membership.id}`;
    try {
      await expect(
        getManagedHumanSessionCreateCapabilities({ db: client.db }, canonical, grant.workspaceId),
      ).resolves.toEqual({
        activated: false,
        canCreatePrivate: false,
        reason: "not_activated",
      });
    } finally {
      await shared.admin`
        update organization_memberships set status = 'active' where id = ${membership.id}`;
    }

    await expect(
      getManagedHumanSessionCreateCapabilities(
        { db: client.db },
        { ...canonical, canonicalManagedHumanSession: false },
        grant.workspaceId,
      ),
    ).resolves.toEqual({
      activated: false,
      canCreatePrivate: false,
      reason: "managed_session_required",
    });
  }, 180_000);

  test("lists, issues, reissues expired identities, and route-fences revocation", async () => {
    if (!shared || !client) return;
    const userId = `core-personal-grants-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Core personal grants",
    });
    const personalGrant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== access.defaultWorkspaceId,
    );
    if (!personalGrant) throw new Error("managed human has no personal workspace grant");
    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${personalGrant.accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'grant-test'
      )`;
    const [membership] = await shared.admin<{ id: string }[]>`
      select id from organization_memberships
      where account_id = ${personalGrant.accountId} and subject_id = ${subjectId}`;
    if (!membership) throw new Error("managed human membership missing");
    const authorityIds = [crypto.randomUUID(), crypto.randomUUID()];
    const resourceIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (let index = 0; index < authorityIds.length; index += 1) {
      await shared.admin`
        insert into organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind, resource_id,
          origin_workspace_id, generation, status, created_at
        ) values (
          ${authorityIds[index]}, ${personalGrant.accountId}, ${membership.id}, 'rig',
          ${resourceIds[index]}, ${personalGrant.workspaceId}, 1, 'active',
          clock_timestamp() + (${index}::text || ' milliseconds')::interval
        )`;
    }
    const authorization = {
      grant: {
        ...personalGrant,
        permissions: [...new Set([...personalGrant.permissions, "rigs:use", "sessions:control"])],
      },
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    } satisfies AccessGrantAuthorization;
    const session = await createSession(client.db, {
      accountId: personalGrant.accountId,
      workspaceId: personalGrant.workspaceId,
      initialMessage: "grant target",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const grantOperations: SessionAuthorizationOperation[] = [];
    const deps = {
      db: client.db,
      sessionAuthorization: {
        authorizeSession: async (input) => {
          grantOperations.push(input.operation);
          return { allowed: true as const, relatedSessionAccess: "root" as const };
        },
        resolveListScope: async () => ({ kind: "all" as const }),
      },
    };

    const firstPage = await listManagedHumanUserResourceAuthorities(
      deps,
      authorization,
      personalGrant.workspaceId,
      { resourceKind: "rig", limit: 1 },
    );
    expect(firstPage.authorities).toHaveLength(1);
    expect(firstPage.nextCursor).toBe(firstPage.authorities[0]?.authorityId ?? null);
    const secondPage = await listManagedHumanUserResourceAuthorities(
      deps,
      authorization,
      personalGrant.workspaceId,
      { resourceKind: "rig", cursor: firstPage.nextCursor ?? undefined, limit: 1 },
    );
    expect(secondPage.authorities).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const issued = await issueManagedHumanUserResourceGrant(
      deps,
      authorization,
      personalGrant.workspaceId,
      authorityIds[0]!,
      {
        scope: "user",
        resourceKind: "rig",
        mode: "session",
        context: "workspace_shared",
        sessionId: session.id,
        expectedAuthorityEpoch: 1,
        workspaceSharedAcknowledged: true,
      },
    );
    expect(issued).toMatchObject({
      action: "rig.use",
      authorityEpoch: 1,
      mode: "session",
      status: "active",
      delegation: {
        authorityId: authorityIds[0],
        organizationId: personalGrant.accountId,
        workspaceId: personalGrant.workspaceId,
        sessionId: session.id,
        authorityEpoch: 1,
        authorityGeneration: 1,
        grantGeneration: 1,
      },
    });
    expect(grantOperations).toEqual(["session.personal_resource.grant"]);
    await shared.admin`
      update organization_user_resource_grants
      set expires_at = clock_timestamp() - interval '1 second'
      where id = ${issued.grantId}`;
    const reissued = await issueManagedHumanUserResourceGrant(
      deps,
      authorization,
      personalGrant.workspaceId,
      authorityIds[0]!,
      {
        scope: "user",
        resourceKind: "rig",
        mode: "session",
        context: "workspace_shared",
        sessionId: session.id,
        expectedAuthorityEpoch: 1,
        workspaceSharedAcknowledged: true,
      },
    );
    expect(reissued).toMatchObject({ status: "active", action: "rig.use" });
    expect(reissued.grantId).not.toBe(issued.grantId);
    await expect(
      issueManagedHumanUserResourceGrant(
        deps,
        authorization,
        personalGrant.workspaceId,
        authorityIds[1]!,
        {
          scope: "user",
          resourceKind: "rig",
          mode: "session",
          context: "workspace_shared",
          sessionId: crypto.randomUUID(),
          expectedAuthorityEpoch: 1,
          workspaceSharedAcknowledged: true,
        },
      ),
    ).rejects.toBeInstanceOf(SessionAuthorizationDeniedError);
    expect(grantOperations).toEqual([
      "session.personal_resource.grant",
      "session.personal_resource.grant",
    ]);

    const revoked = await revokeManagedHumanUserResourceGrant(
      deps,
      authorization,
      personalGrant.workspaceId,
      reissued.grantId,
    );
    expect(revoked).toMatchObject({ grantId: reissued.grantId, status: "revoked", generation: 2 });
    const replay = await revokeManagedHumanUserResourceGrant(
      deps,
      authorization,
      personalGrant.workspaceId,
      reissued.grantId,
    );
    expect(replay).toEqual(revoked);

    const otherWorkspaceGrant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    );
    if (!otherWorkspaceGrant) throw new Error("managed human has no shared workspace grant");
    const otherAuthorization = { ...authorization, grant: otherWorkspaceGrant };
    await expect(
      revokeManagedHumanUserResourceGrant(
        deps,
        otherAuthorization,
        otherWorkspaceGrant.workspaceId,
        reissued.grantId,
      ),
    ).rejects.toBeDefined();
  }, 180_000);

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

  test("rejects a human-shaped bearer before activation, target resolution, or host authorization", async () => {
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
    const deps = {
      db: null as never,
      bus: null as never,
      sessionAuthorization: {
        authorizeSession: async () => {
          throw new Error("host authorization must not run");
        },
        resolveListScope: async () => ({ kind: "all" as const }),
      },
    };
    for (const sessionId of [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]) {
      await expect(
        updateManagedHumanSessionVisibility(
          deps,
          authorization,
          authorization.grant.workspaceId,
          sessionId,
          {
            visibility: "private",
            expectedAuthorityEpoch: 1,
            idempotencyKey: `denied-visibility-${sessionId}`,
          },
        ),
      ).rejects.toBeInstanceOf(SessionTenancyManagedHumanRequiredError);
      await expect(
        forkManagedHumanSessionPrivate(
          deps,
          authorization,
          authorization.grant.workspaceId,
          sessionId,
          { idempotencyKey: `denied-fork-${sessionId}` },
        ),
      ).rejects.toBeInstanceOf(SessionTenancyManagedHumanRequiredError);
    }
  });

  test("rejects missing exact permissions before activation or host authorization", async () => {
    const workspaceId = crypto.randomUUID();
    const subjectId = `user:${crypto.randomUUID()}`;
    const authorization = {
      grant: {
        accountId: crypto.randomUUID(),
        workspaceId,
        subjectId,
        permissions: [],
      },
      accountGrant: null,
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    } satisfies AccessGrantAuthorization;
    const deps = {
      db: null as never,
      bus: null as never,
      sessionAuthorization: {
        authorizeSession: async () => {
          throw new Error("host authorization must not run");
        },
        resolveListScope: async () => ({ kind: "all" as const }),
      },
    };
    await expect(
      updateManagedHumanSessionVisibility(deps, authorization, workspaceId, crypto.randomUUID(), {
        visibility: "private",
        expectedAuthorityEpoch: 1,
        idempotencyKey: "missing-control",
      }),
    ).rejects.toMatchObject({ status: 403 } satisfies Partial<HTTPException>);
    await expect(
      forkManagedHumanSessionPrivate(deps, authorization, workspaceId, crypto.randomUUID(), {
        idempotencyKey: "missing-read-create",
      }),
    ).rejects.toMatchObject({ status: 403 } satisfies Partial<HTTPException>);
  });

  test("rejects an unactivated organization before any target or host authorization", async () => {
    if (!shared || !client) return;
    const userId = `core-session-tenancy-inactive-${crypto.randomUUID()}`;
    const subjectId = `user:${userId}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Inactive session tenancy",
    });
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId !== access.defaultWorkspaceId,
    );
    if (!grant) throw new Error("managed human has no personal workspace grant");
    const authorization = {
      grant,
      accountGrant: access.accountGrants[0] ?? null,
      authenticatedSubjectId: subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    } satisfies AccessGrantAuthorization;
    let hostCalls = 0;
    const deps = {
      db: client.db,
      bus: new MemoryEventBus(),
      sessionAuthorization: {
        authorizeSession: async () => {
          hostCalls += 1;
          return { allowed: true as const };
        },
        resolveListScope: async () => ({ kind: "all" as const }),
      },
    };
    for (const sessionId of [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]) {
      await expect(
        updateManagedHumanSessionVisibility(deps, authorization, grant.workspaceId, sessionId, {
          visibility: "private",
          expectedAuthorityEpoch: 1,
          idempotencyKey: `inactive-visibility-${sessionId}`,
        }),
      ).rejects.toBeInstanceOf(SessionTenancyNotActivatedError);
      await expect(
        forkManagedHumanSessionPrivate(deps, authorization, grant.workspaceId, sessionId, {
          idempotencyKey: `inactive-fork-${sessionId}`,
        }),
      ).rejects.toBeInstanceOf(SessionTenancyNotActivatedError);
    }
    expect(hostCalls).toBe(0);
  });
});
