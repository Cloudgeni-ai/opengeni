import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GOOGLE_DRIVE_INTEGRATION_DEFINITION } from "@opengeni/capabilities";
import { signDelegatedAccessToken, type AccessContext } from "@opengeni/contracts";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  ATLASSIAN_CREDENTIAL_LABEL,
  ATLASSIAN_CREDENTIAL_ROLE,
} from "@opengeni/contracts/atlassian";
import {
  requireAccessGrantAuthorization,
  stampDelegatedHumanAuthorization,
  type ApiRouteDeps,
  type DelegatedHumanAuthorization,
} from "@opengeni/core";
import * as db from "@opengeni/db";
import * as canonical from "@opengeni/db/canonical-human-identities";
import * as policy from "@opengeni/db/organization-integration-policy";
import { createSignedState, readSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as fiken from "../src/integrations/fiken";
import * as drive from "../src/integrations/google-drive";
import * as atlassian from "../src/integrations/atlassian";
import * as slack from "../src/integrations/slack-install";
import * as generic from "../src/integrations/oauth-client";
import * as providerOAuth from "../src/integrations/provider-oauth";
import * as social from "../src/integrations/social-oauth";
import { registerSocialRoutes } from "../src/routes/social";
import {
  delegatedNativeProviderStart,
  nativeProviderCallbackFailureUrl,
} from "../src/integrations/delegated-native-provider-handoff";
import { registerConnectionRoutes } from "../src/routes/connections";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const identityId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const connectionId = "66666666-6666-4666-8666-666666666666";
const userId = "native-provider-person";
const subjectId = `user:${userId}`;
const baseUrl = "https://api.example.test";
const webUrl = "https://console.example.test";
const stateSecret = "native-provider-state-fixture";
const delegationSecret = "native-provider-legacy-bearer-fixture";
const encryptionKey = Buffer.alloc(32, 81);
const cookie = "native-cookie=actual";
const providers = ["fiken", "google-drive", "atlassian"] as const;
const additionalProviders = ["slack-bot", "mcp-oauth", "provider-oauth", "social"] as const;
type Provider = (typeof providers)[number] | (typeof additionalProviders)[number];
const realStarts = {
  fiken: fiken.startFikenOAuth,
  "google-drive": drive.startGoogleDriveOAuth,
  atlassian: atlassian.startAtlassianOAuth,
};
const realCallbacks = {
  fiken: fiken.completeFikenOAuthCallback,
  "google-drive": drive.completeGoogleDriveOAuthCallback,
  atlassian: atlassian.completeAtlassianOAuthCallback,
};
function nativeAccess(): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId: organizationId, subjectId, permissions: ["account:read"] }],
    workspaceGrants: [
      {
        accountId: organizationId,
        workspaceId,
        subjectId,
        principalKind: "human_session",
        permissions: ["connections:write", "workspace:read"],
      },
    ],
    defaultAccountId: organizationId,
    defaultWorkspaceId: workspaceId,
  };
}
function startPath(provider: Provider) {
  if (provider === "mcp-oauth") return `/v1/workspaces/${workspaceId}/connections/oauth/start`;
  if (provider === "provider-oauth")
    return `/v1/workspaces/${workspaceId}/integrations/oauth/start`;
  if (provider === "social") return `/v1/workspaces/${workspaceId}/social/oauth/start`;
  return `/v1/workspaces/${workspaceId}/connections/${provider}/${provider === "fiken" ? "oauth/start" : "install"}`;
}
function callbackPath(provider: Provider) {
  if (provider === "slack-bot") return "/v1/integrations/slack/callback";
  if (provider === "mcp-oauth") return "/v1/integrations/oauth/callback";
  if (provider === "social") return "/v1/social/oauth/callback";
  return `/v1/integrations/${provider}/callback`;
}
function providerPayload(provider: Provider) {
  if (provider === "mcp-oauth")
    return { mcpUrl: "https://mcp.example.test/mcp", ownership: "workspace" };
  if (provider === "provider-oauth")
    return { definitionId: GOOGLE_DRIVE_INTEGRATION_DEFINITION.id, ownership: "personal" };
  if (provider === "social") return { provider: "x", ownership: "personal" };
  return {};
}
function nativeHeaders() {
  return {
    cookie,
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

function signed(payload: Record<string, unknown>) {
  return createSignedState(
    stateSecret,
    payload,
    typeof payload.iat === "number" ? payload.iat : Math.floor(Date.now() / 1000),
  );
}

describe("independent native consent for delegated provider setup", () => {
  const restores: Array<() => void> = [];
  let deps: ApiRouteDeps;
  let app: Hono;
  let live: AccessContext;
  let authorityLive: boolean;
  let nativeSessionValid: boolean;
  let browserUserId: string;
  let realCallback: boolean;
  let nonceUses: Set<string>;
  let callbackCookies: Map<string, string>;
  let execute: ReturnType<typeof mock>;
  let fetchProvider: ReturnType<typeof mock>;
  let sessions: ReturnType<typeof mock>;
  let starts: ReturnType<typeof startSpies>;
  let callbacks: ReturnType<typeof callbackSpies>;
  let extraStarts: ReturnType<typeof extraStartSpies>;
  let extraCallbacks: ReturnType<typeof extraCallbackSpies>;
  let pendingStates: Map<string, string>;
  let metadata: ReturnType<typeof spyOn<typeof db, "getConnectionMetadata">>;
  let attempts: ReturnType<typeof spyOn<typeof db, "getConnectAttempt">>;
  let persist: ReturnType<typeof spyOn<typeof db, "persistProviderOAuthConnection">>;
  let acquisition: ReturnType<
    typeof spyOn<typeof policy, "withOrganizationIntegrationAcquisition">
  >;

  function startSpies() {
    return {
      fiken: spyOn(fiken, "startFikenOAuth").mockImplementation(realStarts.fiken),
      "google-drive": spyOn(drive, "startGoogleDriveOAuth").mockImplementation(
        realStarts["google-drive"],
      ),
      atlassian: spyOn(atlassian, "startAtlassianOAuth").mockImplementation(realStarts.atlassian),
    };
  }
  function callbackSpies() {
    return {
      fiken: spyOn(fiken, "completeFikenOAuthCallback").mockImplementation(async (d, input) =>
        realCallback
          ? realCallbacks.fiken(d, input)
          : { redirectTo: `${webUrl}/integrations?fixture=complete` },
      ),
      "google-drive": spyOn(drive, "completeGoogleDriveOAuthCallback").mockImplementation(
        async (d, input) =>
          realCallback
            ? realCallbacks["google-drive"](d, input)
            : { redirectTo: `${webUrl}/integrations?fixture=complete` },
      ),
      atlassian: spyOn(atlassian, "completeAtlassianOAuthCallback").mockImplementation(
        async (d, input) =>
          realCallback
            ? realCallbacks.atlassian(d, input)
            : { redirectTo: `${webUrl}/integrations?fixture=complete` },
      ),
    };
  }
  const realMcpCallback = generic.completeMcpOAuthCallback;
  const realProviderCallback = providerOAuth.completeApiIntegrationProviderOAuth;
  const realSocialCallback = social.completeSocialOAuthCallback;
  const realSlackStart = slack.startSlackBotInstall;
  const realProviderStart = providerOAuth.startApiIntegrationProviderOAuth;
  const realSocialStart = social.startSocialOAuth;
  function extraStartSpies() {
    return {
      "slack-bot": spyOn(slack, "startSlackBotInstall").mockImplementation(realSlackStart),
      "provider-oauth": spyOn(providerOAuth, "startApiIntegrationProviderOAuth").mockImplementation(
        realProviderStart,
      ),
      social: spyOn(social, "startSocialOAuth").mockImplementation(realSocialStart),
      "mcp-oauth": spyOn(generic, "startMcpOAuth").mockImplementation(async (_, context) => {
        // Discovery/DCR are outside this authority unit fixture. Model the
        // existing encrypted short-state DB seam without exposing its PKCE.
        const verifier = randomBytes(48).toString("base64url");
        const full = createSignedState(stateSecret, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          subjectId: context.subjectId,
          ownership: context.payload.ownership ?? "workspace",
          personalOwnerVerified: context.personalOwnershipAllowed,
          providerDomain: "mcp.example.test",
          mcpUrl: context.payload.mcpUrl,
          resource: context.payload.mcpUrl,
          requestedScopes: [],
          authorizeScopes: ["fixture:read"],
          clientId: "fixture-mcp",
          authorizationServer: "https://provider.example.test",
          issuer: "https://provider.example.test",
          tokenEndpoint: "https://provider.example.test/token",
          clientRegistrationMethod: "manual",
          tokenEndpointAuthMethod: "none",
          encryptedPkceVerifier: db.encryptEnvironmentValue(encryptionKey, verifier),
          returnPath: `/workspaces/${workspaceId}/capabilities`,
          ...(context.payload.returnUrl ? { returnUrl: context.payload.returnUrl } : {}),
          ...(context.connectAttemptId ? { connectAttemptId: context.connectAttemptId } : {}),
          ...(context.integrationKey ? { integrationKey: context.integrationKey } : {}),
          ...(context.externalContinuation
            ? {
                encryptedExternalContinuation: db.encryptEnvironmentValue(
                  encryptionKey,
                  JSON.stringify(context.externalContinuation),
                ),
              }
            : {}),
        });
        const id = randomUUID();
        pendingStates.set(id, db.encryptEnvironmentValue(encryptionKey, full));
        const state = createSignedState(stateSecret, {
          kind: "mcp_oauth_reference",
          id,
          accountId: context.accountId,
          workspaceId: context.workspaceId,
        });
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", state);
        url.searchParams.set(
          "code_challenge",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        return {
          state,
          authorizationUrl: url.toString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
      }),
    };
  }
  function extraCallbackSpies() {
    return {
      "mcp-oauth": spyOn(generic, "completeMcpOAuthCallback").mockImplementation(async (d, input) =>
        realCallback ? realMcpCallback(d, input) : { redirectTo: "/integrations?fixture=complete" },
      ),
      "provider-oauth": spyOn(
        providerOAuth,
        "completeApiIntegrationProviderOAuth",
      ).mockImplementation(async (d, input) =>
        realCallback
          ? realProviderCallback(d, input)
          : { redirectTo: `${webUrl}/integrations?fixture=complete` },
      ),
      social: spyOn(social, "completeSocialOAuthCallback").mockImplementation(async (d, input) =>
        realCallback
          ? realSocialCallback(d, input)
          : { redirectTo: `${webUrl}/integrations?fixture=complete` },
      ),
    };
  }
  beforeEach(() => {
    live = nativeAccess();
    authorityLive = nativeSessionValid = true;
    browserUserId = userId;
    realCallback = false;
    nonceUses = new Set();
    callbackCookies = new Map();
    pendingStates = new Map();
    execute = mock(async () => {
      throw new Error("No SQL mutation expected in these unit fixtures");
    });
    fetchProvider = mock(async () => {
      throw new Error("No provider exchange expected without consent");
    });
    const profile = spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: userId, email: "person@example.test", name: "Native person" },
    ]);
    const access = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () =>
      structuredClone(live),
    );
    const validation = spyOn(canonical, "validateCanonicalHumanSession").mockImplementation(
      async () => nativeSessionValid,
    );
    const key = spyOn(db, "findActiveApiKeyByHash").mockResolvedValue(null);
    const rls = spyOn(db, "withWorkspaceSubjectRls").mockImplementation(async (_, __, ___, use) =>
      use(deps.db),
    );
    const statementTimeout = spyOn(db, "withDatabaseStatementTimeout").mockImplementation(
      async (_, __, use) => use(deps.db),
    );
    const lifecycle = spyOn(db, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(
      undefined,
    );
    const grant = spyOn(db, "getWorkspaceGrant").mockImplementation(async (_, person, ws) =>
      authorityLive
        ? (live.workspaceGrants.find(
            (candidate) => candidate.subjectId === person && candidate.workspaceId === ws,
          ) ?? null)
        : null,
    );
    const personal = spyOn(db, "resolveNamedManagedPersonalWorkspaceGrant").mockResolvedValue(null);
    const nonce = spyOn(db, "consumeIntegrationOAuthStateNonce").mockImplementation(
      async (_, input) => {
        if (nonceUses.has(input.nonce)) return false;
        nonceUses.add(input.nonce);
        return true;
      },
    );
    acquisition = spyOn(policy, "withOrganizationIntegrationAcquisition").mockImplementation(
      async (_, __, ___, use) => use(deps.db),
    );
    const fence = spyOn(policy, "withOrganizationIntegrationPolicyFence").mockImplementation(
      async (_, __, use) => use(deps.db, { mode: "unrestricted" } as never),
    );
    metadata = spyOn(db, "getConnectionMetadata").mockResolvedValue(null);
    attempts = spyOn(db, "getConnectAttempt").mockResolvedValue({
      attempt: {
        id: attemptId,
        providerId: "google-drive-knowledge",
        ownership: "personal",
        state: "requires_user_action",
        revision: 1,
      } as never,
      returnUrl: `${webUrl}/integrations`,
      operationInFlight: false,
    });
    persist = spyOn(db, "persistProviderOAuthConnection").mockImplementation(async () => {
      throw new Error("No persistence expected without independent consent");
    });
    const pending = spyOn(db, "loadIntegrationOAuthPendingState").mockImplementation(
      async (_, scope) =>
        scope.accountId === organizationId && scope.workspaceId === workspaceId
          ? (pendingStates.get(scope.id) ?? null)
          : null,
    );
    for (const spy of [
      profile,
      access,
      validation,
      key,
      rls,
      statementTimeout,
      lifecycle,
      grant,
      personal,
      nonce,
      acquisition,
      fence,
      metadata,
      attempts,
      persist,
      pending,
    ])
      restores.push(() => spy.mockRestore());
    starts = startSpies();
    callbacks = callbackSpies();
    extraStarts = extraStartSpies();
    extraCallbacks = extraCallbackSpies();
    for (const spy of [
      ...Object.values(starts),
      ...Object.values(callbacks),
      ...Object.values(extraStarts),
      ...Object.values(extraCallbacks),
    ])
      restores.push(() => spy.mockRestore());
    sessions = mock(async ({ headers }: { headers: Headers }) => ({
      headers: new Headers(),
      response: headers
        .get("cookie")
        ?.split(";")
        .some((entry) => entry.trim() === cookie)
        ? {
            user: {
              id: browserUserId,
              email: "person@example.test",
              name: "Native person",
              emailVerified: true,
            },
            session: { id: "real-native-session" },
          }
        : null,
    }));
    deps = {
      db: { execute } as unknown as db.Database,
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl: baseUrl,
        webBaseUrl: webUrl,
        integrationsEnabled: true,
        integrationsStateSecret: stateSecret,
        delegationSecret,
        betterAuthSecret: "native-provider-browser-fixture-32-bytes",
        environmentsEncryptionKey: encryptionKey.toString("base64"),
        fikenClientId: "fixture-fiken",
        fikenClientSecret: "fixture-fiken-secret",
        googleDriveClientId: "fixture-drive",
        googleDriveClientSecret: "fixture-drive-secret",
        atlassianClientId: "fixture-atlassian",
        atlassianClientSecret: "fixture-atlassian-secret",
        githubPersonalOauthEnabled: true,
        githubPersonalOauthClientId: "fixture-github",
        githubPersonalOauthClientSecret: "fixture-github-secret",
        slackClientId: "fixture-slack",
        slackClientSecret: "fixture-slack-secret",
        slackSigningSecret: "fixture-slack-signing",
        socialOauthClientsJson: JSON.stringify({
          x: { clientId: "fixture-x", clientSecret: "fixture-x-secret" },
        }),
      }),
      managedAuth: { api: { getSession: sessions } },
      fikenFetch: fetchProvider,
      googleDriveFetch: fetchProvider,
      atlassianFetch: fetchProvider,
    } as unknown as ApiRouteDeps;
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerConnectionRoutes(app, deps);
    registerSocialRoutes(app, deps);
    app.post("/fixture/start/:provider", async (c) => {
      const body = await c.req.json();
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      return c.json(
        await delegatedNativeProviderStart(deps, {
          authorization: body.clone
            ? { ...authorization, canonicalManagedHumanSession: true }
            : authorization,
          provider: c.req.param("provider") as Provider,
          payload: body.payload ?? {},
          requestUrl: c.req.url,
          ...(body.connectAttemptId ? { connectAttemptId: body.connectAttemptId } : {}),
          ...(body.connectAttemptRevision !== undefined
            ? { connectAttemptRevision: body.connectAttemptRevision }
            : {}),
        }),
      );
    });
  });
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function delegated(
    path: string,
    body: unknown = {},
    proof: Partial<DelegatedHumanAuthorization> = {},
    headers?: HeadersInit,
    method = "POST",
  ) {
    const request = new Request(`${baseUrl}${path}`, {
      method,
      headers: headers ?? { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    stampDelegatedHumanAuthorization(request, {
      organizationId,
      subjectId,
      permissions: ["account:read", "connections:write", "workspace:read"],
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      ...proof,
    });
    return request;
  }
  async function begun(
    provider: Provider,
    payload: unknown = providerPayload(provider),
    connectAttemptId?: string,
  ) {
    const response = await app.fetch(
      delegated(
        connectAttemptId ? `/fixture/start/${provider}` : startPath(provider),
        connectAttemptId ? { payload, connectAttemptId } : payload,
      ),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.authorizationUrl);
    const intent = url.searchParams.get("intent")!;
    return { result, url, intent, state: readSignedState(intent, stateSecret)! };
  }
  async function nativeStarted(provider: Provider, start?: Awaited<ReturnType<typeof begun>>) {
    const original = start ?? (await begun(provider));
    const response = await app.fetch(new Request(original.url, { headers: { cookie } }));
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const url = new URL(response.headers.get("location")!);
    const raw = url.searchParams.get("state")!;
    const boundCookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(boundCookie).toContain("opengeni_oauth_");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    callbackCookies.set(raw, boundCookie);
    return { original, response, url, raw, state: readSignedState(raw, stateSecret)! };
  }
  function callback(provider: Provider, raw: string, headers?: HeadersInit, error?: string) {
    const url = new URL(callbackPath(provider), baseUrl);
    url.searchParams.set("state", raw);
    url.searchParams.set("code", "attacker-or-consenting-code");
    if (error) url.searchParams.set("error", error);
    const resolvedHeaders = new Headers(headers);
    if (resolvedHeaders.get("cookie") === cookie && callbackCookies.has(raw))
      resolvedHeaders.set("cookie", `${cookie}; ${callbackCookies.get(raw)}`);
    return new Request(url, { headers: resolvedHeaders });
  }
  async function legacyBearer(principalKind: "human_session" | "service") {
    return `Bearer ${await signDelegatedAccessToken(delegationSecret, { accountId: organizationId, workspaceId, subjectId, principalKind, permissions: ["connections:write"], exp: Math.floor(Date.now() / 1000) + 600 })}`;
  }

  for (const provider of providers) {
    test(`${provider}: ordinary native cookie START still uses the existing lower adapter`, async () => {
      const response = await app.fetch(
        new Request(`${baseUrl}${startPath(provider)}`, {
          method: "POST",
          headers: nativeHeaders(),
          body: "{}",
        }),
      );
      expect(response.status).toBe(200);
      const url = new URL((await response.json()).authorizationUrl);
      expect(url.searchParams.get("intent")).toBeNull();
      expect(readSignedState(url.searchParams.get("state")!, stateSecret)).toMatchObject({
        accountId: organizationId,
        workspaceId,
        subjectId,
      });
      expect(starts[provider]).toHaveBeenCalledTimes(1);
      expect(nonceUses.size).toBe(0);
    });
    test(`${provider}: delegated START produces only an exact-scope intent, never provider consent state`, async () => {
      const start = await begun(provider);
      expect(start.url.pathname).toBe(
        `/v1/workspaces/${workspaceId}/connections/${provider}/oauth/native-start`,
      );
      expect(start.url.searchParams.get("state")).toBeNull();
      expect(start.state).toMatchObject({
        kind: "delegated_native_provider_handoff",
        version: 2,
        provider,
        accountId: organizationId,
        workspaceId,
        subjectId,
        permissions: ["connections:write"],
      });
      for (const key of [
        "encryptedPkceVerifier",
        "canonicalManagedHumanSession",
        "personalOwnerVerified",
        "sessionId",
        "browserSessionHash",
        "encryptedExternalContinuation",
        "payload",
      ])
        expect(start.state[key]).toBeUndefined();
      expect(typeof start.state.encryptedPayload).toBe("string");
      expect(
        JSON.parse(db.decryptEnvironmentValue(encryptionKey, String(start.state.encryptedPayload))),
      ).toMatchObject(providerPayload(provider));
      expect(Date.parse(start.result.expiresAt) - Date.now()).toBeGreaterThan(590_000);
      expect(starts[provider]).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(0);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: only an independent native owner mints fresh lower-provider state`, async () => {
      const start = await nativeStarted(provider);
      expect(starts[provider]).toHaveBeenCalledTimes(1);
      expect(start.state).toMatchObject({ accountId: organizationId, workspaceId, subjectId });
      expect(start.state.nonce).not.toBe(start.original.state.nonce);
      expect(start.raw).not.toBe(start.original.intent);
      expect(start.state.kind).not.toBe("delegated_native_provider_handoff");
      expect(start.state.encryptedExternalContinuation).toBeUndefined();
      expect(start.state.delegatedActor).toBeUndefined();
      expect(start.state.canonicalManagedHumanSession).toBeUndefined();
      if (provider === "google-drive") {
        const verifier = db.decryptEnvironmentValue(
          encryptionKey,
          String(start.state.encryptedPkceVerifier),
        );
        expect(verifier).toHaveLength(64);
        expect(start.url.searchParams.get("code_challenge")).toBe(
          createHash("sha256").update(verifier).digest("base64url"),
        );
      }
      expect(nonceUses).toContain(String(start.original.state.nonce));
      expect(
        (await app.fetch(new Request(start.original.url, { headers: { cookie } }))).status,
      ).toBe(409);
      expect(starts[provider]).toHaveBeenCalledTimes(1);
    });
    test(`${provider}: handoff cannot be redeemed as callback state, even with valid code and a native cookie`, async () => {
      const start = await begun(provider);
      for (const headers of [undefined, { cookie }])
        expect((await app.fetch(callback(provider, start.intent, headers))).status).toBe(403);
      expect(callbacks[provider]).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(0);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: known valid provider state and a typed proof still cannot redeem consent`, async () => {
      const start = await nativeStarted(provider);
      const cb = callback(provider, start.raw, { cookie });
      stampDelegatedHumanAuthorization(cb, {
        organizationId,
        subjectId,
        permissions: ["connections:write"],
        workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      });
      expect((await app.fetch(cb)).status).toBe(403);
      expect(callbacks[provider]).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(1);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: callbacks reject missing/fake cookie, proof-shaped headers, and bearer/native substitution`, async () => {
      const start = await nativeStarted(provider);
      for (const headers of [
        undefined,
        {
          cookie: "native-cookie=forged",
          "x-opengeni-browser-session": "real-native-session",
          "x-opengeni-canonical-human": "true",
        },
        { authorization: await legacyBearer("human_session"), cookie },
        { authorization: await legacyBearer("service"), cookie },
      ]) {
        expect((await app.fetch(callback(provider, start.raw, headers))).status).toBeOneOf([
          401, 403,
        ]);
      }
      expect(callbacks[provider]).not.toHaveBeenCalled();
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: exact live native callback proof dispatches the original provider state`, async () => {
      const start = await nativeStarted(provider);
      const response = await app.fetch(callback(provider, start.raw, { cookie }));
      expect(response.status).toBe(302);
      expect(callbacks[provider]).toHaveBeenCalledTimes(1);
      expect(callbacks[provider].mock.calls[0]![1]).toMatchObject({
        state: start.raw,
        code: "attacker-or-consenting-code",
      });
      expect(sessions).toHaveBeenCalledTimes(2);
    });
    test(`${provider}: actual lower callback still checks live membership and preserves denied-consent outcome`, async () => {
      const start = await nativeStarted(provider);
      realCallback = true;
      const denied = await app.fetch(callback(provider, start.raw, { cookie }, "access_denied"));
      expect(denied.status).toBe(302);
      expect(new URL(denied.headers.get("location")!).searchParams.get("reason")).toBe(
        "provider_denied",
      );
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
  }

  for (const provider of [...providers, ...additionalProviders] as const) {
    test(`${provider}: invalid and expired envelopes preserve safe failure landing without calling provider completion`, async () => {
      realCallback = true;
      for (const [raw, expectedPath, expectedReason] of [
        ["bad.signature", "/integrations", "state_invalid"],
        [
          signed({
            accountId: organizationId,
            workspaceId,
            subjectId,
            kind: "github_personal_oauth",
            returnPath: "https://attacker.example.test/steal",
          }),
          `/workspaces/${workspaceId}/plugins`,
          "state_invalid",
        ],
        [
          signed({
            accountId: organizationId,
            workspaceId,
            subjectId,
            iat: Math.floor(Date.now() / 1000) - 601,
          }),
          `/workspaces/${workspaceId}/plugins`,
          "state_expired",
        ],
        [
          signed({ workspaceId: "https://attacker.example.test", kind: "wrong_flow" }),
          "/integrations",
          "state_invalid",
        ],
      ] as const) {
        const result = await app.fetch(callback(provider, raw));
        expect(result.status).toBe(302);
        const location = result.headers.get("location")!;
        if (provider === "social") expect(location.startsWith("/")).toBe(true);
        const landing = new URL(location, webUrl);
        expect(landing.origin).toBe(provider === "slack-bot" ? baseUrl : webUrl);
        expect(landing.pathname).toBe(expectedPath);
        expect(landing.searchParams.get("reason")).toBe(
          provider === "slack-bot" ? "http_400" : expectedReason,
        );
        const flag =
          provider === "google-drive"
            ? "google_drive"
            : provider === "slack-bot"
              ? "slack"
              : provider === "mcp-oauth" || provider === "provider-oauth"
                ? "integration_oauth"
                : provider === "social"
                  ? "social_oauth"
                  : provider;
        expect(landing.searchParams.get(flag)).toBe("error");
        if (provider === "mcp-oauth")
          expect(landing.searchParams.get("stage")).toBe("state_verify");
      }
      const completion =
        provider === "fiken" || provider === "google-drive" || provider === "atlassian"
          ? callbacks[provider]
          : provider === "slack-bot"
            ? undefined
            : extraCallbacks[provider];
      if (completion) expect(completion).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
  }

  test("Social display-only failure routing preserves its relative safe landing without trusting a supplied return URL", () => {
    const invalid = nativeProviderCallbackFailureUrl(deps, "social", "bad.signature", baseUrl);
    expect(invalid).toBe("/integrations?social_oauth=error&reason=state_invalid");
    const expired = nativeProviderCallbackFailureUrl(
      deps,
      "social",
      signed({
        workspaceId,
        iat: Math.floor(Date.now() / 1000) - 601,
        returnPath: "https://attacker.example.test/steal",
      }),
      baseUrl,
    );
    expect(expired).toBe(
      `/workspaces/${workspaceId}/plugins?social_oauth=error&reason=state_expired`,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  for (const provider of additionalProviders) {
    test(`${provider}: delegated HTTP START returns an intent before any lower provider operation`, async () => {
      const start = await begun(provider);
      if (provider !== "slack-bot") expect(start.result.state).toBe(start.intent);
      expect(start.state).toMatchObject({
        provider,
        accountId: organizationId,
        workspaceId,
        subjectId,
        kind: "delegated_native_provider_handoff",
        version: 2,
      });
      expect(start.state.payload).toBeUndefined();
      expect(typeof start.state.encryptedPayload).toBe("string");
      expect(start.state.encryptedPkceVerifier).toBeUndefined();
      expect(start.result.authorizationUrl).toContain("/oauth/native-start?intent=");
      expect(extraStarts[provider]).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(0);
    });
    test(`${provider}: native handoff mints fresh lower state and a signed HttpOnly flow binding`, async () => {
      const start = await nativeStarted(provider);
      expect(extraStarts[provider]).toHaveBeenCalledTimes(1);
      expect(start.raw).not.toBe(start.original.intent);
      expect(start.state.nonce).not.toBe(start.original.state.nonce);
      expect(start.response.headers.get("set-cookie")).toContain("Secure");
      expect(start.response.headers.get("set-cookie")).not.toContain("Domain=");
      expect(
        (await app.fetch(new Request(start.original.url, { headers: { cookie } }))).status,
      ).toBe(409);
      expect(extraStarts[provider]).toHaveBeenCalledTimes(1);
    });
    test(`${provider}: known intent/state, fake browser headers and native cookie alone cannot redeem provider consent`, async () => {
      const start = await nativeStarted(provider);
      expect((await app.fetch(callback(provider, start.original.intent, { cookie }))).status).toBe(
        403,
      );
      expect((await app.fetch(callback(provider, start.raw))).status).toBe(403);
      const rawRequest = callback(provider, start.raw);
      expect((await app.fetch(new Request(rawRequest.url, { headers: { cookie } }))).status).toBe(
        403,
      );
      expect(
        (
          await app.fetch(
            new Request(rawRequest.url, {
              headers: {
                cookie: callbackCookies.get(start.raw)!,
                "x-opengeni-canonical-human": "true",
                "x-opengeni-browser-session": "real-native-session",
              },
            }),
          )
        ).status,
      ).toBeOneOf([401, 403]);
      if (provider !== "slack-bot") expect(extraCallbacks[provider]).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(1);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: typed proof and legacy/service bearers cannot borrow even the real session plus flow cookie`, async () => {
      const start = await nativeStarted(provider);
      const request = callback(provider, start.raw, { cookie });
      stampDelegatedHumanAuthorization(request, {
        organizationId,
        subjectId,
        permissions: ["connections:write"],
        workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      });
      expect((await app.fetch(request)).status).toBe(403);
      for (const kind of ["human_session", "service"] as const)
        expect(
          (
            await app.fetch(
              callback(provider, start.raw, { cookie, authorization: await legacyBearer(kind) }),
            )
          ).status,
        ).toBe(403);
      if (provider !== "slack-bot") expect(extraCallbacks[provider]).not.toHaveBeenCalled();
      expect(nonceUses.size).toBe(1);
      expect(fetchProvider).not.toHaveBeenCalled();
    });
    test(`${provider}: real native browser and its independent state binding preserve provider denial without exchanging credentials`, async () => {
      const start = await nativeStarted(provider);
      realCallback = true;
      const response = await app.fetch(callback(provider, start.raw, { cookie }, "access_denied"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBeTruthy();
      if (provider !== "slack-bot")
        expect(extraCallbacks[provider].mock.calls[0]![1].state).toBe(start.raw);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: direct native HTTP START also creates a callback binding`, async () => {
      const response = await app.fetch(
        new Request(`${baseUrl}${startPath(provider)}`, {
          method: "POST",
          headers: nativeHeaders(),
          body: JSON.stringify(providerPayload(provider)),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("opengeni_oauth_");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
      expect(extraStarts[provider]).toHaveBeenCalledTimes(1);
    });
  }
  test("native cookies without the independently minted flow binding cannot redeem the three original provider states", async () => {
    for (const provider of providers) {
      const start = await nativeStarted(provider);
      const request = callback(provider, start.raw);
      expect((await app.fetch(new Request(request.url, { headers: { cookie } }))).status).toBe(403);
      expect(callbacks[provider]).not.toHaveBeenCalled();
    }
    expect(nonceUses.size).toBe(3);
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  test("flow binding is exact-provider/state scoped and cannot be copied across simultaneous flows", async () => {
    const first = await nativeStarted("fiken");
    const second = await nativeStarted("fiken");
    const request = callback("fiken", second.raw);
    expect(
      (
        await app.fetch(
          new Request(request.url, {
            headers: { cookie: `${cookie}; ${callbackCookies.get(first.raw)}` },
          }),
        )
      ).status,
    ).toBe(403);
    expect(callbacks.fiken).not.toHaveBeenCalled();
    expect((await app.fetch(callback("fiken", second.raw, { cookie }))).status).toBe(302);
    expect((await app.fetch(callback("fiken", first.raw, { cookie }))).status).toBe(302);
  });
  test("public HTTPS flow bindings remain Secure behind an internal HTTP proxy", async () => {
    const start = await begun("fiken");
    const internalUrl = new URL(start.url);
    internalUrl.protocol = "http:";
    const response = await app.fetch(new Request(internalUrl, { headers: { cookie } }));
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
  test("delegated MCP machine-client credentials stay encrypted and reach the lower adapter only after independent native admission", async () => {
    const payload = {
      ...providerPayload("mcp-oauth"),
      oauthClient: { clientId: "manual-client", clientSecret: "manual-secret" },
    };
    const start = await begun("mcp-oauth", payload);
    expect(start.state.version).toBe(2);
    expect(start.state.payload).toBeUndefined();
    expect(typeof start.state.encryptedPayload).toBe("string");
    expect(JSON.stringify(start.state)).not.toContain("manual-secret");
    expect(JSON.stringify(start.state)).not.toContain("manual-client");
    expect(start.result.authorizationUrl).not.toContain("manual-secret");
    expect(
      JSON.parse(db.decryptEnvironmentValue(encryptionKey, String(start.state.encryptedPayload))),
    ).toMatchObject(payload);
    expect(extraStarts["mcp-oauth"]).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    expect((await app.fetch(callback("mcp-oauth", start.intent, { cookie }))).status).toBe(403);
    const native = await nativeStarted("mcp-oauth", start);
    expect(extraStarts["mcp-oauth"]).toHaveBeenCalledTimes(1);
    expect(extraStarts["mcp-oauth"].mock.calls[0]![1].payload).toMatchObject(payload);
    expect(native.raw).not.toBe(start.intent);
    expect(native.state.nonce).not.toBe(start.state.nonce);
    expect((await app.fetch(callback("mcp-oauth", native.raw))).status).toBe(403);
    expect(extraCallbacks["mcp-oauth"]).not.toHaveBeenCalled();
    expect((await app.fetch(callback("mcp-oauth", native.raw, { cookie }))).status).toBe(302);
    expect(extraCallbacks["mcp-oauth"]).toHaveBeenCalledTimes(1);
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  test("delegated handoff fails closed without an encryption key instead of returning machine credentials in plaintext", async () => {
    deps.settings = testSettings({ ...deps.settings, environmentsEncryptionKey: undefined });
    const response = await app.fetch(
      delegated(startPath("mcp-oauth"), {
        ...providerPayload("mcp-oauth"),
        oauthClient: { clientId: "manual-client", clientSecret: "manual-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("manual-secret");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(extraStarts["mcp-oauth"]).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  test("Social personal consent preserves its existing read-only setup ceiling without inventing connection-write authority", async () => {
    live.workspaceGrants[0]!.permissions = ["workspace:read"];
    const response = await app.fetch(
      delegated(startPath("social"), providerPayload("social"), {
        permissions: ["account:read", "workspace:read"],
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.authorizationUrl);
    const intent = url.searchParams.get("intent")!;
    const state = readSignedState(intent, stateSecret)!;
    expect(state.permissions).toEqual(["workspace:read"]);
    const native = await nativeStarted("social", { result, url, intent, state });
    expect((await app.fetch(callback("social", native.raw, { cookie }))).status).toBe(302);
    expect(extraCallbacks.social).toHaveBeenCalledTimes(1);
  });
  test("Social workspace consent keeps its original administration ceiling at native handoff and callback", async () => {
    const denied = await app.fetch(
      delegated(startPath("social"), { provider: "x", ownership: "workspace" }),
    );
    expect(denied.status).toBe(403);
    live.workspaceGrants[0]!.permissions = ["workspace:admin"];
    const response = await app.fetch(
      delegated(
        startPath("social"),
        { provider: "x", ownership: "workspace" },
        { permissions: ["account:read", "workspace:admin"] },
      ),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.authorizationUrl);
    const intent = url.searchParams.get("intent")!;
    const state = readSignedState(intent, stateSecret)!;
    expect(state.permissions).toEqual(["workspace:admin"]);
    const native = await nativeStarted("social", { result, url, intent, state });
    live.workspaceGrants[0]!.permissions = ["workspace:read"];
    expect((await app.fetch(callback("social", native.raw, { cookie }))).status).toBe(403);
    expect(extraCallbacks.social).not.toHaveBeenCalled();
  });
  test("MCP short-state native callback checks encrypted original scope, not reference metadata or flow cookie alone", async () => {
    const start = await nativeStarted("mcp-oauth");
    const id = String(start.state.id);
    const full = readSignedState(
      db.decryptEnvironmentValue(encryptionKey, pendingStates.get(id)!),
      stateSecret,
    )!;
    pendingStates.set(
      id,
      db.encryptEnvironmentValue(
        encryptionKey,
        signed({ ...full, subjectId: "user:other-person" }),
      ),
    );
    expect((await app.fetch(callback("mcp-oauth", start.raw, { cookie }))).status).toBe(403);
    expect(extraCallbacks["mcp-oauth"]).not.toHaveBeenCalled();
    pendingStates.delete(id);
    realCallback = true;
    const failure = await app.fetch(callback("mcp-oauth", start.raw));
    expect(failure.status).toBe(302);
    const landing = new URL(failure.headers.get("location")!);
    expect(landing.pathname).toBe(`/workspaces/${workspaceId}/plugins`);
    expect(landing.searchParams.get("reason")).toBe("state_invalid");
    expect(extraCallbacks["mcp-oauth"]).not.toHaveBeenCalled();
    expect(fetchProvider).not.toHaveBeenCalled();
  });
  test("MCP encrypted short-state external continuation remains live and cannot be rescued by a native cookie after revocation", async () => {
    const start = await nativeStarted("mcp-oauth");
    const externalSubject = `external_user:${identityId}`;
    const continuation = ExternalActorContinuation.parse({
      identity: { externalId: "host-person", source: "fixture-host" },
      actor: {
        accountId: organizationId,
        authenticatingApiKeyId: connectionId,
        externalIdentityId: identityId,
        externalSubjectId: externalSubject,
        externalAuthorizationRevision: 1,
        effectiveSubjectId: externalSubject,
        actingMode: "external",
      },
    });
    const key = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue([
      "connections:write",
    ]);
    const identity = spyOn(db, "ensureExternalIdentity").mockResolvedValue({
      id: identityId,
      accountId: organizationId,
      subjectId: externalSubject,
      authorizationRevision: 1,
      personalWorkspaceId: workspaceId,
    } as never);
    restores.push(
      () => key.mockRestore(),
      () => identity.mockRestore(),
    );
    const id = String(start.state.id);
    const full = readSignedState(
      db.decryptEnvironmentValue(encryptionKey, pendingStates.get(id)!),
      stateSecret,
    )!;
    pendingStates.set(
      id,
      db.encryptEnvironmentValue(
        encryptionKey,
        signed({
          ...full,
          subjectId: externalSubject,
          encryptedExternalContinuation: db.encryptEnvironmentValue(
            encryptionKey,
            JSON.stringify(continuation),
          ),
        }),
      ),
    );
    expect((await app.fetch(callback("mcp-oauth", start.raw))).status).toBe(302);
    expect(extraCallbacks["mcp-oauth"].mock.calls[0]![1].state).toBe(start.raw);
    key.mockResolvedValue(null);
    expect((await app.fetch(callback("mcp-oauth", start.raw, { cookie }))).status).toBe(403);
    expect(extraCallbacks["mcp-oauth"]).toHaveBeenCalledTimes(1);
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  for (const provider of additionalProviders) {
    test(`${provider}: a native browser cannot discard the original Connect host restriction or stored return destination`, async () => {
      const destination = `${webUrl}/original-connect-destination`;
      attempts.mockResolvedValue({
        attempt: {
          id: attemptId,
          providerId:
            provider === "provider-oauth"
              ? GOOGLE_DRIVE_INTEGRATION_DEFINITION.id
              : provider === "social"
                ? "x"
                : provider,
          ownership:
            provider === "provider-oauth" || provider === "social" ? "personal" : "workspace",
          state: "requires_user_action",
          revision: 1,
        } as never,
        returnUrl: destination,
        operationInFlight: false,
      });
      const payload = {
        ...providerPayload(provider),
        ...(provider === "mcp-oauth" ? { returnUrl: destination } : {}),
      };
      const native = await nativeStarted(provider, await begun(provider, payload, attemptId));
      const origin = ExternalActorContinuation.parse({
        identity: { externalId: "linked-host-person", source: "fixture-host" },
        actor: {
          accountId: organizationId,
          authenticatingApiKeyId: connectionId,
          externalIdentityId: identityId,
          externalSubjectId: `external_user:${identityId}`,
          externalAuthorizationRevision: 1,
          effectiveSubjectId: subjectId,
          actingMode: "linked_native",
          linkId: otherId,
          linkRevision: 1,
        },
      });
      const key = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue(null);
      const claim = spyOn(db, "claimConnectOperation").mockImplementation(async (_, __, input) => {
        await input.authorize?.(deps.db, {} as never, origin);
        throw new Error("Revoked original host must deny before claim");
      });
      restores.push(
        () => key.mockRestore(),
        () => claim.mockRestore(),
      );
      realCallback = true;
      const response = await app.fetch(callback(provider, native.raw, { cookie }));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(destination);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0]![2]).toMatchObject({ expectedRevision: 1 });
      expect(key).toHaveBeenCalled();
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
  }
  test("curated Google OAuth sharing the MCP callback still requires its provider-specific native binding", async () => {
    const native = await nativeStarted("provider-oauth");
    const url = new URL(callback("provider-oauth", native.raw).url);
    url.pathname = "/v1/integrations/oauth/callback";
    expect((await app.fetch(new Request(url, { headers: { cookie } }))).status).toBe(403);
    expect(extraCallbacks["provider-oauth"]).not.toHaveBeenCalled();
    expect(
      (
        await app.fetch(
          new Request(url, {
            headers: { cookie: `${cookie}; ${callbackCookies.get(native.raw)}` },
          }),
        )
      ).status,
    ).toBe(302);
    expect(extraCallbacks["provider-oauth"]).toHaveBeenCalledTimes(1);
    expect(extraCallbacks["mcp-oauth"]).not.toHaveBeenCalled();
  });

  test("native handoff rejects delegation, Authorization, metadata/fake sessions and invalid canonical sessions before lower START", async () => {
    const start = await begun("google-drive");
    for (const request of [
      new Request(start.url),
      new Request(start.url, {
        headers: { cookie: "native-cookie=forged", "x-opengeni-canonical-human": "true" },
      }),
      new Request(start.url, {
        headers: { cookie, authorization: await legacyBearer("human_session") },
      }),
      delegated(`${start.url.pathname}${start.url.search}`, {}, {}, { cookie }, "GET"),
    ])
      expect((await app.fetch(request)).status).toBeOneOf([401, 403]);
    nativeSessionValid = false;
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBeOneOf([
      401, 403,
    ]);
    expect(starts["google-drive"]).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("forged/copied authorizations and legacy human-shaped/service bearer START remain denied", async () => {
    expect((await app.fetch(delegated("/fixture/start/fiken", { clone: true }))).status).toBe(403);
    for (const provider of providers) {
      for (const kind of ["human_session", "service"] as const) {
        const result = await app.fetch(
          new Request(`${baseUrl}${startPath(provider)}`, {
            method: "POST",
            headers: { ...nativeHeaders(), authorization: await legacyBearer(kind) },
            body: "{}",
          }),
        );
        expect(result.status).toBeOneOf([403, 422]);
      }
      expect(starts[provider]).not.toHaveBeenCalled();
    }
  });
  test("typed START proof ceilings and selected-workspace bounds cannot broaden provider setup authority", async () => {
    for (const proof of [
      { permissions: ["workspace:read"] },
      { workspaceScope: { kind: "selected", workspaceIds: [otherId] } },
      { organizationId: otherId },
    ]) {
      expect(
        (
          await app.fetch(
            delegated(startPath("fiken"), {}, proof as Partial<DelegatedHumanAuthorization>),
          )
        ).status,
      ).toBeOneOf([403, 404]);
    }
    expect(starts.fiken).not.toHaveBeenCalled();
  });
  test("another actual native browser person cannot borrow the original owner's handoff or callback", async () => {
    const start = await begun("google-drive");
    const native = await nativeStarted("google-drive", start);
    browserUserId = "other-native-person";
    const otherSubject = `user:${browserUserId}`;
    live = {
      ...nativeAccess(),
      subjectId: otherSubject,
      accountGrants: [
        { accountId: organizationId, subjectId: otherSubject, permissions: ["account:read"] },
      ],
      workspaceGrants: [{ ...nativeAccess().workspaceGrants[0]!, subjectId: otherSubject }],
    };
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(403);
    expect((await app.fetch(callback("google-drive", native.raw, { cookie }))).status).toBe(403);
    expect(starts["google-drive"]).toHaveBeenCalledTimes(1);
    expect(callbacks["google-drive"]).not.toHaveBeenCalled();
  });
  test("unverified START headers and body metadata cannot fabricate native browser authority", async () => {
    const response = await app.fetch(
      new Request(`${baseUrl}${startPath("fiken")}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "native-cookie=forged",
          "x-opengeni-canonical-human": "true",
          "x-opengeni-browser-session": "real-native-session",
        },
        body: JSON.stringify({
          canonicalManagedHumanSession: true,
          principalKind: "human_session",
          session: { id: "real-native-session" },
          metadata: { delegated: false },
        }),
      }),
    );
    expect(response.status).toBeOneOf([401, 403]);
    expect(starts.fiken).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("invalid Authorization cannot fall back to a native cookie and run a lower provider START", async () => {
    for (const provider of [...providers, ...additionalProviders]) {
      const response = await app.fetch(
        new Request(`${baseUrl}${startPath(provider)}`, {
          method: "POST",
          headers: { ...nativeHeaders(), authorization: "Bearer invalid-browser-substitution" },
          body: JSON.stringify(providerPayload(provider)),
        }),
      );
      expect(response.status).toBeOneOf([401, 403]);
      expect(response.headers.get("set-cookie")).toBeNull();
      if (provider === "fiken" || provider === "google-drive" || provider === "atlassian")
        expect(starts[provider]).not.toHaveBeenCalled();
      else expect(extraStarts[provider]).not.toHaveBeenCalled();
    }
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(pendingStates.size).toBe(0);
  });
  test("handoff and callback bind exact organization, workspace and person, plus fresh native permissions", async () => {
    const start = await begun("atlassian");
    const validNative = await nativeStarted("atlassian", start);
    for (const change of [
      { accountId: otherId },
      { workspaceId: otherId },
      { subjectId: "user:other-person" },
    ]) {
      const intentUrl = new URL(start.url);
      intentUrl.searchParams.set("intent", signed({ ...start.state, ...change }));
      expect((await app.fetch(new Request(intentUrl, { headers: { cookie } }))).status).toBe(403);
      expect(
        (
          await app.fetch(
            callback("atlassian", signed({ ...validNative.state, ...change }), { cookie }),
          )
        ).status,
      ).toBeOneOf([403, 404]);
    }
    live.workspaceGrants[0]!.permissions = ["workspace:read"];
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(403);
    expect((await app.fetch(callback("atlassian", validNative.raw, { cookie }))).status).toBe(403);
    expect(starts.atlassian).toHaveBeenCalledTimes(1);
    expect(callbacks.atlassian).not.toHaveBeenCalled();
  });
  test("intent rejects tampering, unexpected flags, future/expired timestamps and provider substitution", async () => {
    const start = await begun("fiken");
    for (const change of [
      { provider: "atlassian" },
      { canonicalManagedHumanSession: true },
      { version: 1 },
      { encryptedPayload: "invalid-ciphertext" },
      { encryptedPayload: db.encryptEnvironmentValue(encryptionKey, "not-json") },
      {
        encryptedPayload: db.encryptEnvironmentValue(
          encryptionKey,
          JSON.stringify({ connectionId: "not-a-uuid" }),
        ),
      },
      { payload: { oauthClient: { clientSecret: "untrusted-cleartext" } } },
      { iat: Math.floor(Date.now() / 1000) + 60 },
      { iat: Math.floor(Date.now() / 1000) - 601 },
      { permissions: ["workspace:admin"] },
      { connectionVersion: 2 },
    ]) {
      const url = new URL(start.url);
      url.searchParams.set("intent", signed({ ...start.state, ...change }));
      expect((await app.fetch(new Request(url, { headers: { cookie } }))).status).toBe(403);
    }
    const tampered = new URL(start.url);
    tampered.searchParams.set("intent", `${start.intent}forged`);
    expect((await app.fetch(new Request(tampered, { headers: { cookie } }))).status).toBe(403);
    expect(starts.fiken).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("reconnect intent keeps the original connection generation; stale or racing generations cannot issue provider URL", async () => {
    const connection = {
      id: connectionId,
      accountId: organizationId,
      workspaceId,
      subjectId,
      version: 4,
      providerDomain: "api.atlassian.com",
      kind: "oauth2",
      metadata: {
        credentialRole: ATLASSIAN_CREDENTIAL_ROLE,
        credentialLabel: ATLASSIAN_CREDENTIAL_LABEL,
        atlassianAccountId: "fixture-person",
        displayName: "Native person",
        sites: [
          {
            cloudId: "fixture-cloud",
            name: "Fixture cloud",
            url: "https://fixture.atlassian.net",
            products: ["jira"],
          },
        ],
        verifiedAt: new Date().toISOString(),
        accessMode: "readonly",
      },
    };
    metadata.mockResolvedValue(connection as never);
    const start = await begun("atlassian", { connectionId });
    expect(start.state.connectionVersion).toBe(4);
    metadata.mockResolvedValue({ ...connection, version: 5 } as never);
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(409);
    expect(starts.atlassian).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    metadata
      .mockResolvedValueOnce(connection as never)
      .mockResolvedValueOnce({ ...connection, version: 5 } as never);
    const raced = await app.fetch(new Request(start.url, { headers: { cookie } }));
    expect(raced.status).toBe(409);
  });
  test("Connect intent carries original attempt identity/stage/revision, never silently adopts a changed attempt", async () => {
    const start = await begun("google-drive", {}, attemptId);
    expect(start.state).toMatchObject({ connectAttemptId: attemptId, connectAttemptRevision: 1 });
    const stored = await db.getConnectAttempt(deps.db, {} as never, attemptId);
    for (const change of [
      { revision: 2 },
      { state: "complete" },
      { providerId: "atlassian" },
      { ownership: "workspace" },
    ]) {
      attempts.mockResolvedValue({ ...stored, attempt: { ...stored.attempt, ...change } } as never);
      expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(409);
    }
    attempts.mockResolvedValue({ ...stored, operationInFlight: true });
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(409);
    expect(nonceUses.size).toBe(0);
    attempts.mockResolvedValue(stored);
    const native = await nativeStarted("google-drive", start);
    expect(native.state.connectAttemptId).toBe(attemptId);
  });
  test("resumable Connect stages bind an explicit server-selected revision instead of silently restarting at one", async () => {
    const response = await app.fetch(
      delegated("/fixture/start/mcp-oauth", {
        payload: providerPayload("mcp-oauth"),
        connectAttemptId: attemptId,
        connectAttemptRevision: 8,
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.authorizationUrl);
    const intent = url.searchParams.get("intent")!;
    const state = readSignedState(intent, stateSecret)!;
    expect(state.connectAttemptRevision).toBe(8);
    const stored = {
      attempt: {
        id: attemptId,
        providerId: "mcp-oauth",
        ownership: "workspace",
        state: "requires_user_action",
        revision: 7,
      } as never,
      returnUrl: `${webUrl}/integrations`,
      operationInFlight: false,
    };
    attempts.mockResolvedValue(stored);
    expect((await app.fetch(new Request(url, { headers: { cookie } }))).status).toBe(409);
    expect(extraStarts["mcp-oauth"]).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    attempts.mockResolvedValue({
      ...stored,
      attempt: { ...(stored.attempt as Record<string, unknown>), revision: 8 } as never,
    });
    const native = await nativeStarted("mcp-oauth", { result, url, intent, state });
    expect(extraStarts["mcp-oauth"].mock.calls[0]![1].connectAttemptId).toBe(attemptId);
    expect(native.state.nonce).not.toBe(state.nonce);
  });
  test("invalid explicit Connect revisions cannot produce signed handoff intents", async () => {
    for (const body of [
      { connectAttemptId: attemptId, connectAttemptRevision: 0 },
      { connectAttemptId: attemptId, connectAttemptRevision: 1.5 },
      { connectAttemptRevision: 2 },
    ]) {
      expect((await app.fetch(delegated("/fixture/start/fiken", body))).status).toBe(400);
    }
    expect(starts.fiken).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("organization acquisition policy is checked at delegation and independently at native dispatch", async () => {
    acquisition.mockRejectedValueOnce(new HTTPException(403, { message: "Policy denied" }));
    expect((await app.fetch(delegated(startPath("fiken")))).status).toBe(403);
    const start = await begun("fiken");
    acquisition.mockRejectedValueOnce(new HTTPException(403, { message: "Policy denied" }));
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(403);
    expect(starts.fiken).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("native membership revocation blocks handoff before its nonce is used", async () => {
    const start = await begun("google-drive");
    authorityLive = false;
    expect((await app.fetch(new Request(start.url, { headers: { cookie } }))).status).toBe(403);
    expect(starts["google-drive"]).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("exact GitHub native-start route remains ahead of the generic provider handoff", async () => {
    const start = await begun("fiken");
    const path = `/v1/workspaces/${workspaceId}/connections/github/oauth/native-start?intent=${encodeURIComponent(start.intent)}`;
    const response = await app.fetch(new Request(`${baseUrl}${path}`, { headers: { cookie } }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Provider handoff unavailable");
  });
  test("current resolver-native local Fiken flow remains supported without pretending managed-cookie presence", async () => {
    deps.settings = testSettings({ ...deps.settings, productAccessMode: "local" });
    live = {
      ...nativeAccess(),
      mode: "local",
      subjectId: "dev",
      workspaceGrants: [{ ...nativeAccess().workspaceGrants[0]!, subjectId: "dev" }],
      accountGrants: [
        { accountId: organizationId, subjectId: "dev", permissions: ["account:read"] },
      ],
    };
    const bootstrap = spyOn(db, "bootstrapWorkspace").mockResolvedValue(live);
    restores.push(() => bootstrap.mockRestore());
    const response = await app.fetch(
      new Request(`${baseUrl}${startPath("fiken")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).authorizationUrl);
    expect(url.searchParams.get("intent")).toBeNull();
    const state = url.searchParams.get("state")!;
    const boundCookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect((await app.fetch(callback("fiken", state, { cookie: boundCookie }))).status).toBe(302);
    expect(callbacks.fiken.mock.calls[0]![1].state).toBe(state);
    expect(sessions).not.toHaveBeenCalled();
  });

  for (const provider of providers) {
    test(`${provider}: genuine encrypted external continuation stays separate and live, with no native-cookie substitute`, async () => {
      const native = await nativeStarted(provider);
      const externalSubject = `external_user:${identityId}`;
      const continuation = ExternalActorContinuation.parse({
        identity: { externalId: "host-person", source: "fixture-host" },
        actor: {
          accountId: organizationId,
          authenticatingApiKeyId: connectionId,
          externalIdentityId: identityId,
          externalSubjectId: externalSubject,
          externalAuthorizationRevision: 1,
          effectiveSubjectId: externalSubject,
          actingMode: "external",
        },
      });
      const externalKey = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue([
        "connections:write",
      ]);
      const identity = spyOn(db, "ensureExternalIdentity").mockResolvedValue({
        id: identityId,
        accountId: organizationId,
        subjectId: externalSubject,
        source: "fixture-host",
        externalId: "host-person",
        authorizationRevision: 1,
        personalWorkspaceId: workspaceId,
      } as never);
      restores.push(
        () => externalKey.mockRestore(),
        () => identity.mockRestore(),
      );
      const raw = createSignedState(stateSecret, {
        ...native.state,
        subjectId: externalSubject,
        encryptedExternalContinuation: db.encryptEnvironmentValue(
          encryptionKey,
          JSON.stringify(continuation),
        ),
      });
      realCallback = true;
      const response = await app.fetch(callback(provider, raw, undefined, "access_denied"));
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).searchParams.get("reason")).toBe(
        "provider_denied",
      );
      expect(externalKey.mock.calls.length).toBeGreaterThanOrEqual(2);
      const consumed = nonceUses.size;
      externalKey.mockResolvedValue(null);
      expect((await app.fetch(callback(provider, raw, { cookie }))).status).toBe(403);
      expect(nonceUses.size).toBe(consumed);
      const spoof = createSignedState(stateSecret, {
        ...native.state,
        encryptedExternalContinuation: "plain-metadata-not-encrypted-authority",
      });
      expect((await app.fetch(callback(provider, spoof, { cookie }))).status).toBe(403);
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
    test(`${provider}: native handoff cannot replace a revoked original Connect host restriction at callback`, async () => {
      attempts.mockResolvedValue({
        attempt: {
          id: attemptId,
          providerId:
            provider === "fiken"
              ? "fiken-oauth"
              : provider === "atlassian"
                ? "atlassian"
                : "google-drive-knowledge",
          ownership: provider === "fiken" ? "workspace" : "personal",
          state: "requires_user_action",
          revision: 1,
        } as never,
        returnUrl: `${webUrl}/original-connect-destination`,
        operationInFlight: false,
      });
      const native = await nativeStarted(provider, await begun(provider, {}, attemptId));
      const origin = ExternalActorContinuation.parse({
        identity: { externalId: "linked-host-person", source: "fixture-host" },
        actor: {
          accountId: organizationId,
          authenticatingApiKeyId: connectionId,
          externalIdentityId: identityId,
          externalSubjectId: `external_user:${identityId}`,
          externalAuthorizationRevision: 1,
          effectiveSubjectId: subjectId,
          actingMode: "linked_native",
          linkId: otherId,
          linkRevision: 1,
        },
      });
      const key = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue(null);
      const claim = spyOn(db, "claimConnectOperation").mockImplementation(async (_, __, input) => {
        await input.authorize?.(deps.db, {} as never, origin);
        throw new Error("Revoked original host must deny before claim");
      });
      restores.push(
        () => key.mockRestore(),
        () => claim.mockRestore(),
      );
      realCallback = true;
      const response = await app.fetch(callback(provider, native.raw, { cookie }));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${webUrl}/original-connect-destination`);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0]![2]).toMatchObject({ expectedRevision: 1 });
      expect(key).toHaveBeenCalled();
      expect(fetchProvider).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });
  }
});
