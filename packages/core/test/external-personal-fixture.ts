import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { testSettings, MemoryEventBus, type SharedTestDatabase } from "@opengeni/testing";
import {
  createOrganizationApiKey,
  createSession,
  createSocialConnection,
  ensureExternalIdentity,
  grantWorkspaceAccess,
  listSessionsForSubject,
  nestedPostgresSqlState,
  setSessionPin,
  transitionSessionVisibility,
  withSessionRlsActorContext,
  type Database,
} from "@opengeni/db";
import {
  externalActorContinuationForAuthorization,
  hasVerifiedOwningUserAuthorization,
  requireAccessGrantAuthorization,
  requireFreshAccessGrant,
} from "../src/access";
import {
  forkManagedHumanSession,
  getManagedHumanSessionCreateCapabilities,
  requireCanonicalManagedHuman,
  requireVerifiedOwningUser,
  requireManagedHumanPrivateSessionCreate,
} from "../src/application/session-tenancy";
import {
  requireExternalContinuationAuthority,
  externalContinuationCommitAuthorizer,
} from "../src/application/external-continuation";
import {
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
} from "../src/session-authorization";
import type { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { freezePersonalConnectionDelegations } from "../src/domain/personal-connection-delegations";
import { verifyHostMcpBindings } from "./host-mcp-binding-fixture";

export async function verifyExternalPersonal(
  db: Database,
  admin: SharedTestDatabase["admin"],
  scope: { accountId: string; workspaceId: string },
) {
  const token = crypto.randomUUID();
  const permissions = [
    "workspace:read",
    "sessions:read",
    "sessions:create",
    "sessions:control",
  ] as const;
  const key = await createOrganizationApiKey(db, {
    accountId: scope.accountId,
    name: "External Personal",
    prefix: "test",
    keyHash: createHash("sha256").update(token).digest("hex"),
    permissions: [...permissions],
  });
  const owner = await ensureExternalIdentity(db, {
    accountId: scope.accountId,
    externalId: "personal-owner",
  });
  const other = await ensureExternalIdentity(db, {
    accountId: scope.accountId,
    externalId: "personal-other",
  });
  for (const identity of [owner, other])
    await grantWorkspaceAccess(db, {
      ...scope,
      subjectId: identity.subjectId,
      permissions: [...permissions],
    });
  await admin`insert into session_tenancy_activations (account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${scope.accountId}, 1, ${"1".repeat(64)}, ${"2".repeat(64)}, 'external-personal-fixture') on conflict do nothing`;
  await admin`insert into organization_private_session_settings (account_id, enabled, version, updated_by_membership_id)
    values (${scope.accountId}, true, 1, null) on conflict (account_id) do update set enabled = true`;
  const deps = {
    db,
    bus: new MemoryEventBus(),
    settings: testSettings({ productAccessMode: "configured" }),
  };
  const personalConnection = await createSocialConnection(db, {
    accountId: scope.accountId,
    workspaceId: owner.personalWorkspaceId,
    subjectId: owner.subjectId,
    provider: "x",
    accountHandle: "external-fixture",
    status: "connected",
  });
  const frozen = await freezePersonalConnectionDelegations({
    db,
    workspaceId: owner.personalWorkspaceId,
    settings: { mcpServers: [] },
    tools: [{ kind: "mcp", id: "opengeni" }],
    source: { kind: "subject", accountId: scope.accountId, subjectId: owner.subjectId },
  });
  expect(frozen).toHaveLength(1);
  expect(frozen[0]).toMatchObject({
    connectionId: personalConnection.id,
    ownerSubjectId: owner.subjectId,
    serverId: "social:x",
  });
  expect(
    await freezePersonalConnectionDelegations({
      db,
      workspaceId: owner.personalWorkspaceId,
      settings: { mcpServers: [] },
      tools: [{ kind: "mcp", id: "opengeni" }],
      source: { kind: "subject", accountId: scope.accountId, subjectId: other.subjectId },
    }),
  ).toEqual([]);
  const app = new Hono();
  await verifyHostMcpBindings(
    db,
    {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      subjectId: owner.subjectId,
      authorizationRevision: owner.authorizationRevision,
    },
    other.subjectId,
  );
  let continuation: ExternalActorContinuation | null = null;
  let beforeCommit: ((tx: Database) => Promise<void>) | undefined;
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status === 503) throw error;
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof SessionAuthorizationDeniedError) return c.json({ error: "denied" }, 404);
    if (nestedPostgresSqlState(error) === "42501") return c.json({ error: "denied" }, 403);
    throw error;
  });
  app.post("/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "sessions:create",
    );
    expect(authorization.canonicalManagedHumanSession).toBe(false);
    expect(() => requireCanonicalManagedHuman(authorization, workspaceId)).toThrow();
    expect(hasVerifiedOwningUserAuthorization(authorization)).toBe(true);
    expect(hasVerifiedOwningUserAuthorization({ ...authorization })).toBe(false);
    requireVerifiedOwningUser(authorization, workspaceId);
    expect(
      (await getManagedHumanSessionCreateCapabilities(deps, authorization, workspaceId))
        .canCreatePrivate,
    ).toBe(true);
    await requireManagedHumanPrivateSessionCreate(deps, authorization, workspaceId);
    continuation = externalActorContinuationForAuthorization(authorization);
    beforeCommit = externalContinuationCommitAuthorizer(authorization);
    const session = await withSessionRlsActorContext(
      { subjectId: authorization.grant.subjectId },
      () =>
        createSession(db, {
          accountId: scope.accountId,
          workspaceId,
          subjectId: authorization.grant.subjectId,
          createdBy: { kind: "subject", subjectId: authorization.grant.subjectId },
          visibility: "user_private",
          initialMessage: "External private session",
          resources: [],
          tools: [],
          metadata: {},
          model: "test-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
    );
    return c.json(session);
  });
  app.get("/:workspaceId/:sessionId", async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      c.req.param("workspaceId"),
      "sessions:read",
    );
    await requireSessionAuthorization(deps, authorization.grant, {
      sessionId: c.req.param("sessionId"),
      operation: "session.read",
      surface: "http",
    });
    return c.json({ allowed: true });
  });
  app.get("/:workspaceId/:sessionId/stream-recheck", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "sessions:read",
    );
    await requireSessionAuthorization(deps, authorization.grant, {
      sessionId: c.req.param("sessionId"),
      operation: "session.stream.read",
      surface: "stream",
    });
    // The real SSE route uses this fresh (uncached) resolver on every bounded
    // reauthorization. Revoke during the same HTTP request to exercise that seam.
    await admin`update api_keys set revoked_at = clock_timestamp() where id = ${key.id}`;
    try {
      await requireFreshAccessGrant(c, deps, workspaceId, "sessions:read");
      throw new Error("Revoked external key retained stream admission");
    } catch (error) {
      if (!(error instanceof HTTPException)) throw error;
      expect([401, 403]).toContain(error.status);
      return c.json({ revoked: true });
    } finally {
      await admin`update api_keys set revoked_at = null where id = ${key.id}`;
    }
  });
  app.post("/:workspaceId/:sessionId/fork", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "sessions:create",
    );
    return c.json(
      await forkManagedHumanSession(
        deps,
        authorization,
        workspaceId,
        c.req.param("sessionId"),
        await c.req.json(),
      ),
    );
  });
  app.get("/:workspaceId", async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      c.req.param("workspaceId"),
      "sessions:read",
    );
    return c.json(
      await listSessionsForSubject(db, c.req.param("workspaceId"), {
        subjectId: authorization.grant.subjectId,
        personalWorkspaceOwnerException: hasVerifiedOwningUserAuthorization(authorization),
      }),
    );
  });
  const headers = (externalId?: string) => ({
    authorization: `Bearer ${token}`,
    ...(externalId
      ? {
          "x-opengeni-external-actor": encodeURIComponent(
            JSON.stringify({ mode: "external", identity: { externalId } }),
          ),
        }
      : {}),
  });
  const personalResponse = await app.request(`/${owner.personalWorkspaceId}`, {
    method: "POST",
    headers: headers(owner.externalId),
  });
  expect(personalResponse.status).toBe(200);
  const personal = await personalResponse.json();
  const [storedPersonal] =
    await admin`select visibility, owner_subject_id from sessions where id = ${personal.id}`;
  expect(storedPersonal).toEqual({ visibility: "user_private", owner_subject_id: owner.subjectId });
  await db.transaction((tx) =>
    requireExternalContinuationAuthority(
      tx,
      continuation,
      {
        accountId: scope.accountId,
        workspaceId: owner.personalWorkspaceId,
        subjectId: owner.subjectId,
      },
      "sessions:read",
    ),
  );
  expect((await app.request(`/${owner.personalWorkspaceId}`, { headers: headers() })).status).toBe(
    403,
  );
  expect(
    (await app.request(`/${owner.personalWorkspaceId}`, { headers: headers(other.externalId) }))
      .status,
  ).toBe(403);
  const listed = await app.request(`/${owner.personalWorkspaceId}`, {
    headers: headers(owner.externalId),
  });
  expect(listed.status).toBe(200);
  const rechecked = await app.request(
    `/${owner.personalWorkspaceId}/${personal.id}/stream-recheck`,
    { headers: headers(owner.externalId) },
  );
  expect(rechecked.status).toBe(200);
  expect(await rechecked.json()).toEqual({ revoked: true });
  expect(JSON.stringify(await listed.json())).toContain(personal.id);
  expect(
    await setSessionPin(db, {
      workspaceId: owner.personalWorkspaceId,
      sessionId: personal.id,
      subjectId: owner.subjectId,
      pinned: true,
      personalWorkspaceOwnerException: true,
    }),
  ).not.toBeNull();
  // A previously verified request loses authority during asynchronous preflight.
  // The canonical command may run, but its entire transaction must roll back.
  await admin`update api_keys set permissions = '["workspace:read","sessions:read"]'::jsonb where id = ${key.id}`;
  await expect(
    transitionSessionVisibility(db, {
      workspaceId: owner.personalWorkspaceId,
      sessionId: personal.id,
      actorSubjectId: owner.subjectId,
      targetVisibility: "workspace_shared",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
      ...(beforeCommit ? { beforeCommit } : {}),
    }),
  ).rejects.toThrow("external authority changed");
  const [unchanged] =
    await admin`select visibility, authority_epoch::int as epoch from sessions where id = ${personal.id}`;
  expect(unchanged).toEqual({ visibility: "user_private", epoch: 1 });
  await admin`update api_keys set permissions = ${admin.json([...permissions])} where id = ${key.id}`;
  const sharedResponse = await app.request(`/${scope.workspaceId}`, {
    method: "POST",
    headers: headers(owner.externalId),
  });
  expect(sharedResponse.status).toBe(200);
  const shared = await sharedResponse.json();
  expect(
    (
      await app.request(`/${scope.workspaceId}/${shared.id}`, {
        headers: headers(owner.externalId),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`/${scope.workspaceId}/${shared.id}`, {
        headers: headers(other.externalId),
      })
    ).status,
  ).toBe(404);
  const forkRequest = {
    visibility: "workspace",
    workspaceSharedAcknowledged: true,
    idempotencyKey: crypto.randomUUID(),
  };
  const fork = await app.request(`/${scope.workspaceId}/${shared.id}/fork`, {
    method: "POST",
    headers: { ...headers(owner.externalId), "content-type": "application/json" },
    body: JSON.stringify(forkRequest),
  });
  expect(fork.status).toBe(200);
  const forked = await fork.json();
  expect(forked).toMatchObject({ visibility: "workspace", replay: false });
  const replay = await app.request(`/${scope.workspaceId}/${shared.id}/fork`, {
    method: "POST",
    headers: { ...headers(owner.externalId), "content-type": "application/json" },
    body: JSON.stringify(forkRequest),
  });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ sessionId: forked.sessionId, replay: true });
  expect(
    (
      await app.request(`/${scope.workspaceId}/${forked.sessionId}`, {
        headers: headers(other.externalId),
      })
    ).status,
  ).toBe(200);
  await admin`update api_keys set permissions = '["workspace:read","sessions:read"]'::jsonb where id = ${key.id}`;
  expect(
    (
      await app.request(`/${owner.personalWorkspaceId}`, {
        method: "POST",
        headers: headers(owner.externalId),
      })
    ).status,
  ).toBe(403);
}
