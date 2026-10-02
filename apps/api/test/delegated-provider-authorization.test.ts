import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as codex from "@opengeni/codex";
import * as xai from "@opengeni/xai-subscription";
import * as db from "@opengeni/db";
import * as canonical from "@opengeni/db/canonical-human-identities";
import { signDelegatedAccessToken, type AccessContext, type Permission } from "@opengeni/contracts";
import {
  requireAccessGrantAuthorization,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import { createSignedState, readSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as claudeOAuth from "../src/claude-subscription-oauth";
import { registerClaudeSubscriptionOAuthRoutes } from "../src/routes/claude-subscription-oauth";
import { registerCodexRoutes } from "../src/routes/codex";
import { registerSuperGrokRoutes } from "../src/routes/supergrok";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const otherOrganizationId = "44444444-4444-4444-8444-444444444444";
const credentialId = "55555555-5555-4555-8555-555555555555";
const userId = "consenting-native-person";
const subjectId = `user:${userId}`;
const publicOrigin = "https://console.example.test";
const stateSecret = "delegated-provider-state-test-secret";
const delegationSecret = "delegated-provider-bearer-test-secret";
const encryptionKey = Buffer.alloc(32, 71);
const ceilings: Permission[] = [
  "workspace:admin",
  "connections:write",
  "account:read",
  "account:admin",
];
const browserHeaders = {
  cookie: "native-session=verified",
  origin: publicOrigin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

function nativeAccess(): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [
      { accountId: organizationId, subjectId, permissions: ["account:read", "account:admin"] },
    ],
    workspaceGrants: [workspaceId, otherWorkspaceId].map((id) => ({
      workspaceId: id,
      accountId: organizationId,
      subjectId,
      principalKind: "human_session",
      permissions: ["workspace:admin", "connections:write"],
    })),
    defaultAccountId: organizationId,
    defaultWorkspaceId: workspaceId,
  };
}
function jwt(payload: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
function devicePath(provider: "codex" | "supergrok", organization = false, poll = false) {
  return organization
    ? `/v1/organizations/${organizationId}/${provider}/connect/${poll ? "poll" : "start"}`
    : `/v1/workspaces/${workspaceId}/${provider}/connect/${poll ? "poll" : "start"}`;
}
function claudePath(organization = false, complete = false) {
  return `/v1/${organization ? `organizations/${organizationId}` : `workspaces/${workspaceId}`}/model-providers/claude_subscription/oauth/${complete ? "complete" : "start"}`;
}

describe("delegated native provider authorization (no DB or provider services)", () => {
  const restores: Array<() => void> = [];
  let live: AccessContext;
  let deps: ApiRouteDeps;
  let app: Hono;
  let pending: Map<string, { encrypted: string; expiresAt: Date }>;
  let sessions: ReturnType<typeof mock>;
  let startCodex: ReturnType<typeof spyOn<typeof codex, "startDeviceCode">>;
  let pollCodex: ReturnType<typeof spyOn<typeof codex, "pollDeviceCode">>;
  let startXai: ReturnType<typeof spyOn<typeof xai, "requestXaiDeviceCode">>;
  let pollXai: ReturnType<typeof spyOn<typeof xai, "pollXaiDeviceCode">>;
  let codexWrite: ReturnType<typeof spyOn<typeof db, "upsertCodexSubscriptionCredential">>;
  let xaiWrite: ReturnType<typeof spyOn<typeof db, "upsertXaiSubscriptionCredential">>;
  let organizationRole: ReturnType<typeof spyOn<typeof db, "getOrganizationCodexRotationSettings">>;
  let nativeLookup: ReturnType<typeof spyOn<typeof db, "ensureManagedAccessForUser">>;
  let profiles: ReturnType<typeof spyOn<typeof db, "getManagedUserProfilesByIds">>;
  let apiKeys: ReturnType<typeof spyOn<typeof db, "findActiveApiKeyByHash">>;
  let completeClaude: ReturnType<
    typeof spyOn<typeof claudeOAuth, "completeClaudeSubscriptionOAuth">
  >;

  const pendingKey = (scope: { accountId: string; workspaceId: string | null; id: string }) =>
    `${scope.accountId}/${scope.workspaceId}/${scope.id}`;
  beforeEach(() => {
    live = nativeAccess();
    pending = new Map();
    profiles = spyOn(db, "getManagedUserProfilesByIds").mockImplementation(async (_, ids) =>
      ids.map((id) => ({ id, name: "Native person", email: `${id}@example.test` })),
    );
    nativeLookup = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async (_, input) => {
      const context = structuredClone(live);
      context.subjectId = `user:${input.userId}`;
      for (const grant of [...context.accountGrants, ...context.workspaceGrants])
        grant.subjectId = context.subjectId;
      return context;
    });
    const membership = spyOn(db, "getWorkspaceGrant").mockImplementation(
      async (_, person, id) =>
        live.workspaceGrants.find(
          (grant) => grant.subjectId === person && grant.workspaceId === id,
        ) ?? null,
    );
    const canonicalSession = spyOn(canonical, "validateCanonicalHumanSession").mockResolvedValue(
      true,
    );
    apiKeys = spyOn(db, "findActiveApiKeyByHash").mockResolvedValue(null);
    organizationRole = spyOn(db, "getOrganizationCodexRotationSettings").mockResolvedValue({
      activeCredentialId: credentialId,
    } as never);
    startCodex = spyOn(codex, "startDeviceCode").mockResolvedValue({
      deviceAuthId: "fixture-device",
      userCode: "CODE-1234",
      intervalSeconds: 5,
      verificationUri: "https://auth.openai.com/codex/device",
    });
    pollCodex = spyOn(codex, "pollDeviceCode").mockResolvedValue({ status: "pending" });
    const exchange = spyOn(codex, "exchangeDeviceCode").mockResolvedValue({
      accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refreshToken: "fixture-refresh",
      idToken: jwt({
        email: "native@example.test",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "provider-person",
          chatgpt_plan_type: "pro",
        },
      }),
    });
    startXai = spyOn(xai, "requestXaiDeviceCode").mockResolvedValue({
      deviceCode: "fixture-device",
      userCode: "XAI-1234",
      intervalSeconds: 1,
      expiresInSeconds: 600,
      verificationUri: "https://accounts.x.ai/device",
      verificationUriComplete: "https://accounts.x.ai/device?code=XAI-1234",
    });
    pollXai = spyOn(xai, "pollXaiDeviceCode").mockResolvedValue({ status: "pending" });
    codexWrite = spyOn(db, "upsertCodexSubscriptionCredential").mockResolvedValue({
      kind: "saved",
      id: credentialId,
    } as never);
    const source = spyOn(db, "getWorkspaceCodexSubscriptionSource").mockResolvedValue({
      mode: "workspace",
      effectiveSource: "workspace",
    } as never);
    const capacity = spyOn(db, "withSessionCodexCapacityMutation").mockImplementation(
      async (_, __, use) => {
        const result = await use(deps.db);
        return { result: result.result, wakeTargets: [] };
      },
    );
    const codexRotation = spyOn(db, "ensureCodexRotationSettings").mockResolvedValue({} as never);
    const initialCodex = spyOn(db, "setInitialActiveCodexCredential").mockResolvedValue(
      true as never,
    );
    const sourceMode = spyOn(
      db,
      "setWorkspaceCodexSubscriptionModeInTransaction",
    ).mockResolvedValue({} as never);
    const rotation = spyOn(db, "getCodexRotationSettings").mockResolvedValue({
      activeCredentialId: credentialId,
    } as never);
    const orgEnsure = spyOn(db, "ensureOrganizationCodexRotationSettings").mockResolvedValue(
      {} as never,
    );
    const orgCodexWrite = spyOn(
      db,
      "upsertOrganizationCodexSubscriptionCredential",
    ).mockResolvedValue({ id: credentialId, wakeTargets: [] } as never);
    xaiWrite = spyOn(db, "upsertXaiSubscriptionCredential").mockResolvedValue({
      account: { id: credentialId },
      authoritySnapshot: {},
    } as never);
    const xaiRotation = spyOn(db, "ensureXaiRotationSettings").mockResolvedValue({
      activeCredentialId: credentialId,
    } as never);
    const xaiWake = spyOn(db, "wakeXaiCapacityWaiters").mockResolvedValue([] as never);
    const orgXaiWrite = spyOn(db, "upsertOrganizationXaiSubscription").mockResolvedValue({
      account: { id: credentialId },
      isActive: true,
    } as never);
    const workspaceClaude = spyOn(
      db,
      "getWorkspaceProviderApiKeyConnectionMetadata",
    ).mockResolvedValue(null);
    const organizationClaude = spyOn(
      db,
      "getOrganizationModelProviderConnection",
    ).mockResolvedValue(null);
    const store = spyOn(db, "storeIntegrationOAuthPendingState").mockImplementation(
      async (_, scope) => {
        pending.set(pendingKey(scope), {
          encrypted: scope.stateEncrypted,
          expiresAt: scope.expiresAt,
        });
      },
    );
    const load = spyOn(db, "loadIntegrationOAuthPendingState").mockImplementation(
      async (_, scope) => {
        const row = pending.get(pendingKey(scope));
        return row && row.expiresAt.getTime() > Date.now() ? row.encrypted : null;
      },
    );
    const consume = spyOn(db, "consumeIntegrationOAuthPendingState").mockImplementation(
      async (_, scope) => {
        if (pending.get(pendingKey(scope))?.encrypted !== scope.stateEncrypted) return false;
        return pending.delete(pendingKey(scope));
      },
    );
    completeClaude = spyOn(claudeOAuth, "completeClaudeSubscriptionOAuth").mockImplementation(
      async (_, __, ___, reauthorize) => {
        await reauthorize();
        return { connected: true, credentialVersion: 1 };
      },
    );
    for (const spy of [
      profiles,
      nativeLookup,
      membership,
      canonicalSession,
      apiKeys,
      organizationRole,
      startCodex,
      pollCodex,
      exchange,
      startXai,
      pollXai,
      codexWrite,
      source,
      capacity,
      codexRotation,
      initialCodex,
      sourceMode,
      rotation,
      orgEnsure,
      orgCodexWrite,
      xaiWrite,
      xaiRotation,
      xaiWake,
      orgXaiWrite,
      workspaceClaude,
      organizationClaude,
      store,
      load,
      consume,
      completeClaude,
    ])
      restores.push(() => spy.mockRestore());
    sessions = mock(async ({ headers }: { headers: Headers }) => {
      const valid = headers.get("cookie") === browserHeaders.cookie;
      return {
        headers: new Headers(),
        response: valid
          ? {
              user: {
                id: userId,
                name: "Native person",
                email: "native@example.test",
                emailVerified: true,
              },
              session: { id: "actual-native-session-id" },
            }
          : null,
      };
    });
    deps = {
      db: {} as db.Database,
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl: publicOrigin,
        environmentsEncryptionKey: encryptionKey.toString("base64"),
        delegationSecret,
        codexSubscriptionEnabled: true,
        supergrokSubscriptionEnabled: true,
        claudeSubscriptionEnabled: true,
      }),
      managedAuth: { api: { getSession: sessions } },
      githubStateSecret: stateSecret,
      workflowClient: {},
    } as unknown as ApiRouteDeps;
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerCodexRoutes(app, deps);
    registerSuperGrokRoutes(app, deps);
    registerClaudeSubscriptionOAuthRoutes(app, deps);
    app.post("/proof", async (c) =>
      c.json(await requireAccessGrantAuthorization(c, deps, workspaceId)),
    );
  });
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function request(
    path: string,
    body: unknown = {},
    bounds: Partial<DelegatedHumanAuthorization> = {},
    headers?: HeadersInit,
  ) {
    const raw = new Request(`https://api.example.test${path}`, {
      method: "POST",
      headers: headers ?? { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    stampDelegatedHumanAuthorization(raw, {
      organizationId,
      subjectId,
      permissions: ceilings,
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      ...bounds,
    });
    return raw;
  }
  async function start(provider: "codex" | "supergrok", organization = false, scope = "workspace") {
    const response = await app.fetch(request(devicePath(provider, organization), { scope }));
    expect(response.status).toBe(200);
    return await response.json();
  }
  async function poll(
    provider: "codex" | "supergrok",
    state: string,
    organization = false,
    bounds: Partial<DelegatedHumanAuthorization> = {},
  ) {
    return app.fetch(request(devicePath(provider, organization, true), { state }, bounds));
  }
  function authorizeDevice(provider: "codex" | "supergrok") {
    if (provider === "codex")
      pollCodex.mockResolvedValue({
        status: "authorized",
        authorizationCode: "fixture-code",
        codeVerifier: "fixture-verifier",
      });
    else
      pollXai.mockResolvedValue({
        status: "authorized",
        tokens: {
          accessToken: jwt({ principal_type: "User", principal_id: "provider-person" }),
          refreshToken: "fixture-refresh",
          idToken: jwt({ sub: "provider-person", email: "native@example.test" }),
          expiresInSeconds: 3600,
        },
      });
  }

  for (const provider of ["codex", "supergrok"] as const) {
    for (const organization of [false, true]) {
      const label = `${provider} ${organization ? "organization" : "workspace"}`;
      test(`${label}: typed START and pending POLL need no browser presence`, async () => {
        const begun = await start(provider, organization);
        const state = readSignedState(begun.state, stateSecret)!;
        expect(state.delegatedActor).toEqual({
          kind: "delegated_human",
          version: 1,
          provider,
          organizationId,
          workspaceId: organization ? null : workspaceId,
          subjectId,
        });
        expect(JSON.stringify(state)).not.toContain("browserSessionHash");
        expect(state.externalContinuationEncrypted).toBeUndefined();
        expect((await poll(provider, begun.state, organization)).status).toBe(200);
        expect(sessions).not.toHaveBeenCalled();
      });
      test(`${label}: provider-approved POLL persists only the exact connecting person`, async () => {
        const begun = await start(provider, organization);
        authorizeDevice(provider);
        const response = await poll(provider, begun.state, organization);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "connected" });
        if (!organization) {
          const writer = provider === "codex" ? codexWrite : xaiWrite;
          expect(writer.mock.calls[0]![1]).toMatchObject({
            accountId: organizationId,
            workspaceId,
            ...(provider === "codex" ? { connectedBySubjectId: subjectId } : { subjectId }),
          });
        }
        expect(sessions).not.toHaveBeenCalled();
        expect(nativeLookup.mock.calls.length).toBeGreaterThanOrEqual(3);
      });
      test(`${label}: actor, organization, provider, workspace and transport cannot substitute`, async () => {
        const begun = await start(provider, organization);
        const signed = readSignedState(begun.state, stateSecret)!;
        for (const changes of [
          { subjectId: "user:other-person" },
          { organizationId: otherOrganizationId },
          { provider: provider === "codex" ? "supergrok" : "codex" },
          { workspaceId: organization ? workspaceId : otherWorkspaceId },
        ]) {
          const altered = createSignedState(stateSecret, {
            ...signed,
            delegatedActor: { ...(signed.delegatedActor as object), ...changes },
          });
          expect((await poll(provider, altered, organization)).status).toBe(403);
        }
        expect(
          (await poll(provider, begun.state, organization, { subjectId: "user:other-person" }))
            .status,
        ).toBeGreaterThanOrEqual(400);
        const native = await app.request(devicePath(provider, organization, true), {
          method: "POST",
          headers: browserHeaders,
          body: JSON.stringify({ state: begun.state }),
        });
        expect(native.status).toBe(403);
        const nativeState = { ...signed };
        delete nativeState.delegatedActor;
        expect(
          (await poll(provider, createSignedState(stateSecret, nativeState), organization)).status,
        ).toBe(403);
        const tampered = begun.state.replace(/.$/, begun.state.endsWith("a") ? "b" : "a");
        expect((await poll(provider, tampered, organization)).status).toBe(400);
        expect(provider === "codex" ? pollCodex : pollXai).not.toHaveBeenCalled();
      });
      test(`${label}: live revocation and insufficient ceiling fail before provider poll`, async () => {
        const begun = await start(provider, organization);
        expect(
          (await poll(provider, begun.state, organization, { permissions: ["workspace:read"] }))
            .status,
        ).toBe(403);
        live.workspaceGrants = [];
        expect((await poll(provider, begun.state, organization)).status).toBe(403);
        expect(provider === "codex" ? pollCodex : pollXai).not.toHaveBeenCalled();
      });
      test(`${label}: service bearers cannot connect or poll, even riding a real cookie`, async () => {
        const begun = await start(provider, organization);
        const token = await signDelegatedAccessToken(delegationSecret, {
          accountId: organizationId,
          workspaceId,
          subjectId,
          principalKind: "service",
          permissions: ceilings,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        for (const isPoll of [false, true]) {
          const response = await app.request(devicePath(provider, organization, isPoll), {
            method: "POST",
            headers: { ...browserHeaders, authorization: `Bearer ${token}` },
            body: JSON.stringify({ state: begun.state }),
          });
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
        expect(provider === "codex" ? pollCodex : pollXai).not.toHaveBeenCalled();
      });
    }
    test(`${provider}: organization starts need literal account ceiling and DB role`, async () => {
      expect(
        (
          await app.fetch(
            request(devicePath(provider, true), {}, { permissions: ["workspace:admin"] }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.fetch(
            request(devicePath(provider, true), {}, { permissions: ["connections:write"] }),
          )
        ).status,
      ).toBe(403);
      organizationRole.mockRejectedValue(
        Object.assign(new Error("role revoked"), { code: "42501" }),
      );
      expect((await app.fetch(request(devicePath(provider, true)))).status).toBe(403);
      expect(provider === "codex" ? startCodex : startXai).not.toHaveBeenCalled();
    });
    test(`${provider}: forged headers, metadata and fake sessions cannot replace raw proof`, async () => {
      const begun = await start(provider);
      const token = await signDelegatedAccessToken(delegationSecret, {
        accountId: organizationId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ceilings,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const response = await app.request(devicePath(provider, false, true), {
        method: "POST",
        headers: {
          ...browserHeaders,
          authorization: `Bearer ${token}`,
          "x-opengeni-delegated-human": subjectId,
          "x-browser-session-id": "pretend-browser-session",
        },
        body: JSON.stringify({
          state: begun.state,
          canonicalManagedHumanSession: true,
          delegatedHumanAuthorization: true,
          session: { id: "pretend-browser-session" },
        }),
      });
      expect(response.status).toBe(403);
      expect(provider === "codex" ? pollCodex : pollXai).not.toHaveBeenCalled();
    });
    test(`${provider}: native device start/poll retain their existing state lane`, async () => {
      const begun = await app.request(devicePath(provider), {
        method: "POST",
        headers: browserHeaders,
        body: "{}",
      });
      expect(begun.status).toBe(200);
      const state = (await begun.json()).state;
      expect(readSignedState(state, stateSecret)!.delegatedActor).toBeUndefined();
      const response = await app.request(devicePath(provider, false, true), {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({ state }),
      });
      expect(response.status).toBe(200);
    });
    test(`${provider}: expired device state and narrowed workspace scope never reach the provider`, async () => {
      const begun = await start(provider);
      expect(
        (
          await poll(provider, begun.state, false, {
            workspaceScope: { kind: "selected", workspaceIds: [otherWorkspaceId] },
          })
        ).status,
      ).toBe(403);
      const state = readSignedState(begun.state, stateSecret)!;
      const now = Math.floor(Date.now() / 1000);
      const expired =
        provider === "codex"
          ? createSignedState(stateSecret, state, now - 901)
          : createSignedState(stateSecret, { ...state, expiresAt: now - 1 });
      const response = await poll(provider, expired);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "expired" });
      expect(provider === "codex" ? pollCodex : pollXai).not.toHaveBeenCalled();
    });
  }

  test("verified organization API keys cannot borrow a connecting person or native cookie", async () => {
    apiKeys.mockResolvedValue({
      id: credentialId,
      accountId: organizationId,
      workspaceId: null,
      name: "Organization service",
      credentialKind: "organization",
      permissions: ceilings,
    } as never);
    const workspace = spyOn(db, "requireWorkspace").mockResolvedValue({
      id: workspaceId,
      accountId: organizationId,
      kind: "shared",
    } as never);
    restores.push(() => workspace.mockRestore());
    for (const provider of ["codex", "supergrok"] as const) {
      for (const organization of [false, true]) {
        for (const isPoll of [false, true]) {
          const response = await app.request(devicePath(provider, organization, isPoll), {
            method: "POST",
            headers: { ...browserHeaders, authorization: "Bearer fixture-organization-key" },
            body: JSON.stringify({ state: "pretend-state", connectedBySubjectId: subjectId }),
          });
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
      }
    }
    for (const organization of [false, true]) {
      expect(
        (
          await app.request(claudePath(organization), {
            method: "POST",
            headers: { ...browserHeaders, authorization: "Bearer fixture-organization-key" },
            body: "{}",
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
    }
    expect(startCodex).not.toHaveBeenCalled();
    expect(startXai).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });
  test("missing live native profile denies typed starts and polls", async () => {
    const begun = await start("codex");
    profiles.mockResolvedValue([]);
    expect((await poll("codex", begun.state)).status).toBe(403);
    expect((await app.fetch(request(devicePath("supergrok")))).status).toBe(403);
    expect((await app.fetch(request(claudePath()))).status).toBe(403);
    expect(pollCodex).not.toHaveBeenCalled();
    expect(startXai).not.toHaveBeenCalled();
    expect(pending.size).toBe(0);
  });

  test("private SuperGrok uses native owning-person proof, not an external continuation", async () => {
    const begun = await start("supergrok", false, "user");
    expect(readSignedState(begun.state, stateSecret)!.scope).toBe("user");
    expect((await poll("supergrok", begun.state)).status).toBe(200);
    const altered = readSignedState(begun.state, stateSecret)!;
    altered.externalContinuationEncrypted = "pretend-external-claim";
    expect((await poll("supergrok", createSignedState(stateSecret, altered))).status).toBe(403);
  });
  test("a revoked native membership during token exchange cannot persist a credential", async () => {
    const begun = await start("codex");
    pollCodex.mockImplementation(async () => {
      live.workspaceGrants = [];
      return {
        status: "authorized",
        authorizationCode: "fixture-code",
        codeVerifier: "fixture-verifier",
      };
    });
    expect((await poll("codex", begun.state)).status).toBe(403);
    expect(codexWrite).not.toHaveBeenCalled();
  });
  test("delegation never stamps canonical cookie/session authority", async () => {
    const response = await app.fetch(request("/proof", {}, {}, browserHeaders));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canonicalManagedHumanSession: false,
      canonicalLocalHumanSession: false,
    });
    expect(sessions).not.toHaveBeenCalled();
  });
  for (const organization of [false, true]) {
    test(`Claude ${organization ? "organization" : "workspace"} START stores browserless bound PKCE; COMPLETE needs the real browser`, async () => {
      const begun = await app.fetch(request(claudePath(organization)));
      expect(begun.status).toBe(200);
      const result = await begun.json();
      const url = new URL(result.authorizationUrl);
      const rowKey = pendingKey({
        accountId: organizationId,
        workspaceId: organization ? null : workspaceId,
        id: result.attemptId,
      });
      const attempt = JSON.parse(
        db.decryptEnvironmentValue(encryptionKey, pending.get(rowKey)!.encrypted),
      );
      expect(attempt.stage).toBe("delegated_pending");
      expect(attempt.browserSessionHash).toBeUndefined();
      expect(attempt.session).toBeUndefined();
      expect(attempt.delegatedActor).toMatchObject({
        subjectId,
        provider: "claude_subscription",
        organizationId,
        workspaceId: organization ? null : workspaceId,
      });
      expect(url.searchParams.get("state")).toBe(attempt.state);
      expect(url.searchParams.get("code_challenge")).toBe(
        createHash("sha256").update(attempt.verifier).digest("base64url"),
      );
      expect(readSignedState(attempt.authorizationBinding, stateSecret)!.delegatedActor).toEqual(
        attempt.delegatedActor,
      );
      expect(sessions).not.toHaveBeenCalled();
      const payload = { attemptId: result.attemptId, code: `fixture-code#${attempt.state}` };
      expect(
        (await app.fetch(request(claudePath(organization, true), payload, {}, browserHeaders)))
          .status,
      ).toBe(403);
      expect(completeClaude).not.toHaveBeenCalled();
      const response = await app.request(claudePath(organization, true), {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      const adopted = JSON.parse(
        db.decryptEnvironmentValue(encryptionKey, pending.get(rowKey)!.encrypted),
      );
      expect(adopted.stage).toBe("pending");
      expect(adopted.browserSessionHash).toBe(
        createHash("sha256").update("actual-native-session-id").digest("base64url"),
      );
      expect(adopted.state.length).toBeLessThanOrEqual(128); // Existing native Attempt schema.
      expect(adopted.delegatedActor).toBeUndefined();
      expect(completeClaude).toHaveBeenCalledTimes(1);
    });
  }
  test("Claude native completion rejects wrong actor, code, provider and HMAC before adoption", async () => {
    const begun = await app.fetch(request(claudePath()));
    const result = await begun.json();
    const key = pendingKey({ accountId: organizationId, workspaceId, id: result.attemptId });
    const original = pending.get(key)!;
    const attempt = JSON.parse(db.decryptEnvironmentValue(encryptionKey, original.encrypted));
    for (const change of [
      { delegatedActor: { ...attempt.delegatedActor, subjectId: "user:other-person" } },
      { delegatedActor: { ...attempt.delegatedActor, provider: "codex" } },
      { authorizationBinding: "forged-state" },
    ]) {
      pending.set(key, {
        ...original,
        encrypted: db.encryptEnvironmentValue(
          encryptionKey,
          JSON.stringify({ ...attempt, ...change }),
        ),
      });
      const response = await app.request(claudePath(false, true), {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({
          attemptId: result.attemptId,
          code: `fixture-code#${attempt.state}`,
        }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(
        JSON.parse(db.decryptEnvironmentValue(encryptionKey, pending.get(key)!.encrypted)).stage,
      ).toBe("delegated_pending");
    }
    pending.set(key, original);
    expect(
      (
        await app.request(claudePath(false, true), {
          method: "POST",
          headers: browserHeaders,
          body: JSON.stringify({ attemptId: result.attemptId, code: "fixture-code#wrong" }),
        })
      ).status,
    ).toBe(422);
    expect(completeClaude).not.toHaveBeenCalled();
  });
  test("reset-credit prepare/redeem remain strict for typed delegation with browser-looking headers", async () => {
    for (const action of ["prepare", "redeem"]) {
      const path = `/v1/workspaces/${workspaceId}/codex/accounts/${credentialId}/reset-credits/${action}`;
      expect(
        (
          await app.fetch(
            request(
              path,
              { attemptId: credentialId, creditId: "fixture-credit" },
              {},
              browserHeaders,
            ),
          )
        ).status,
      ).toBe(403);
    }
    expect(sessions).not.toHaveBeenCalled();
  });
});
