import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AccessContext } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  PERSONAL_GITHUB_TOKEN_URL,
  PERSONAL_GITHUB_USER_URL,
} from "@opengeni/contracts/personal-github";
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
import {
  handleManagedSignInConnectCallback,
  registerManagedSignInMethodRoutes,
} from "../src/routes/managed-sign-in-methods";
import {
  startPersonalGitHubOAuth,
  completePersonalGitHubOAuthCallback,
} from "../src/integrations/personal-github";
import { registerConnectionRoutes } from "../src/routes/connections";
import { registerPersonalGitHubRoutes } from "../src/routes/personal-github";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const identityId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const connectionId = "66666666-6666-4666-8666-666666666666";
const userId = "native-setup-person";
const subjectId = `user:${userId}`;
const stateSecret = "delegated-github-native-state-fixture";
const delegationSecret = "delegated-sign-in-bearer-fixture";
const publicBaseUrl = "https://api.example.test";
const webBaseUrl = "https://console.example.test";
const encryptionKey = Buffer.alloc(32, 79);
const browserHeaders = {
  cookie: "native-cookie=actual",
  origin: publicBaseUrl,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const connectBody = {
  provider: "github",
  expectedIdentityId: identityId,
  expectedIdentityRevision: 1,
  operationId,
};
function nativeAccess(): AccessContext {
  return {
    mode: "managed",
    subjectId,
    accountGrants: [{ accountId: organizationId, subjectId, permissions: ["account:read"] }],
    workspaceGrants: [
      {
        workspaceId,
        accountId: organizationId,
        subjectId,
        principalKind: "human_session",
        permissions: ["connections:write", "workspace:read"],
      },
    ],
    defaultWorkspaceId: workspaceId,
    defaultAccountId: organizationId,
  };
}

describe("delegated sign-in initiation and personal GitHub owner continuation", () => {
  const restores: Array<() => void> = [];
  let deps: ApiRouteDeps;
  let app: Hono;
  let live: AccessContext;
  let nativeAuthorityLive: boolean;
  let ordinaryMembershipPresent: boolean;
  let execute: ReturnType<typeof mock>;
  let sessions: ReturnType<typeof mock>;
  let linkSocial: ReturnType<typeof mock>;
  let nativeHandler: ReturnType<typeof mock>;
  let projections: ReturnType<
    typeof spyOn<typeof canonical, "getCanonicalHumanIdentityProjection">
  >;
  let profiles: ReturnType<typeof spyOn<typeof db, "getManagedUserProfilesByIds">>;
  let persist: ReturnType<typeof spyOn<typeof db, "persistProviderOAuthConnection">>;
  let metadata: ReturnType<typeof spyOn<typeof db, "getConnectionMetadata">>;
  let attempts: ReturnType<typeof spyOn<typeof db, "getConnectAttempt">>;
  let providerRequests: string[];
  let revokeDuringProvider: boolean;
  let nonceUses: Set<string>;

  beforeEach(() => {
    live = nativeAccess();
    nativeAuthorityLive = true;
    ordinaryMembershipPresent = true;
    providerRequests = [];
    revokeDuringProvider = false;
    nonceUses = new Set();
    execute = mock(async () => {
      throw new Error("No SQL lifecycle mutation expected in these fixtures");
    });
    profiles = spyOn(db, "getManagedUserProfilesByIds").mockResolvedValue([
      { id: userId, name: "Native person", email: "native@example.test" },
    ]);
    const native = spyOn(db, "ensureManagedAccessForUser").mockImplementation(async () =>
      structuredClone(live),
    );
    const validation = spyOn(canonical, "validateCanonicalHumanSession").mockResolvedValue(true);
    projections = spyOn(canonical, "getCanonicalHumanIdentityProjection").mockResolvedValue({
      activeIdentity: { id: identityId, identityRevision: 1 },
      loginBindings: [],
    } as never);
    const acquisition = spyOn(policy, "withOrganizationIntegrationAcquisition").mockImplementation(
      async (_, __, ___, use) => use(deps.db),
    );
    const rls = spyOn(db, "withWorkspaceSubjectRls").mockImplementation(async (_, __, ___, use) =>
      use(deps.db),
    );
    const lock = spyOn(db, "lockExternalWorkspaceMembershipLifecycle").mockResolvedValue(undefined);
    // Keep callback authority implementation real; only its DB ports are fake.
    const membership = spyOn(db, "getWorkspaceGrant").mockImplementation(async (_, person, ws) =>
      nativeAuthorityLive && ordinaryMembershipPresent
        ? (live.workspaceGrants.find(
            (grant) => grant.subjectId === person && grant.workspaceId === ws,
          ) ?? null)
        : null,
    );
    const personal = spyOn(db, "resolveNamedManagedPersonalWorkspaceGrant").mockImplementation(
      async (_, scope) =>
        nativeAuthorityLive &&
        scope.accountId === organizationId &&
        scope.workspaceId === workspaceId &&
        scope.subjectId === subjectId
          ? live.workspaceGrants[0]!
          : null,
    );
    const nonce = spyOn(db, "consumeIntegrationOAuthStateNonce").mockImplementation(
      async (_, input) => {
        if (nonceUses.has(input.nonce)) return false;
        nonceUses.add(input.nonce);
        return true;
      },
    );
    metadata = spyOn(db, "getConnectionMetadata").mockResolvedValue(null);
    attempts = spyOn(db, "getConnectAttempt").mockResolvedValue({
      attempt: {
        id: operationId,
        workspaceId,
        providerId: "github-personal",
        ownership: "personal",
        revision: 1,
        state: "requires_user_action",
      } as never,
      returnUrl: `${webBaseUrl}/integrations`,
      operationInFlight: false,
    });
    const connections = spyOn(db, "listConnectionsMetadata").mockResolvedValue([]);
    persist = spyOn(db, "persistProviderOAuthConnection").mockImplementation(async (_, input) => {
      await input.authorize?.(deps.db);
      return { id: connectionId, version: 1 } as never;
    });
    const key = spyOn(db, "findActiveApiKeyByHash").mockResolvedValue(null);
    for (const spy of [
      profiles,
      native,
      validation,
      projections,
      acquisition,
      rls,
      lock,
      membership,
      personal,
      nonce,
      metadata,
      attempts,
      connections,
      persist,
      key,
    ])
      restores.push(() => spy.mockRestore());
    sessions = mock(async ({ headers }: { headers: Headers }) => ({
      headers: new Headers(),
      response:
        headers.get("cookie") === browserHeaders.cookie
          ? {
              user: {
                id: userId,
                name: "Native person",
                email: "native@example.test",
                emailVerified: true,
              },
              session: { id: "actual-native-session" },
            }
          : null,
    }));
    linkSocial = mock(async () => {
      throw new Error("Browserless flow cannot create native link state");
    });
    nativeHandler = mock(async () => {
      throw new Error("Delegation cannot commit native credential bindings");
    });
    deps = {
      db: { execute } as unknown as db.Database,
      settings: testSettings({
        productAccessMode: "managed",
        publicBaseUrl,
        webBaseUrl,
        delegationSecret,
        betterAuthSecret: "managed-native-credential-test-secret-32-bytes",
        managedAuthGithubClientId: "fixture-github-login",
        managedAuthGithubClientSecret: "fixture-login-secret",
        managedAuthGoogleClientId: "fixture-google-login",
        managedAuthGoogleClientSecret: "fixture-google-secret",
        integrationsEnabled: true,
        integrationsStateSecret: stateSecret,
        githubPersonalOauthEnabled: true,
        githubPersonalOauthClientId: "fixture-github-personal",
        githubPersonalOauthClientSecret: "fixture-personal-secret",
        environmentsEncryptionKey: encryptionKey.toString("base64"),
      }),
      managedAuth: {
        api: { getSession: sessions, linkSocialAccount: linkSocial },
        handler: nativeHandler,
        $context: Promise.resolve({
          internalAdapter: {
            findVerificationValue: async () => ({
              value: JSON.stringify({
                opengeniSignInMethod: { intentId: operationId, provider: "github" },
                link: { userId, email: "native@example.test" },
                callbackURL: `${publicBaseUrl}/settings/security?signInMethod=connected`,
                errorURL: `${publicBaseUrl}/settings/security?signInMethod=error`,
              }),
            }),
          },
        }),
      },
      githubPersonalFetch: async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        providerRequests.push(url);
        if (url === PERSONAL_GITHUB_TOKEN_URL) {
          if (revokeDuringProvider) nativeAuthorityLive = false;
          return Response.json({
            access_token: "fixture-github-access",
            refresh_token: "fixture-github-refresh",
            token_type: "bearer",
            scope: "repo",
            expires_in: 3600,
          });
        }
        if (url === PERSONAL_GITHUB_USER_URL)
          return Response.json(
            { id: 12345, login: "fixture-person" },
            { headers: { "x-oauth-scopes": "repo" } },
          );
        throw new Error("Unexpected provider URL");
      },
    } as unknown as ApiRouteDeps;
    app = new Hono();
    app.onError((error) => {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    });
    registerManagedSignInMethodRoutes(app, deps);
    registerConnectionRoutes(app, deps);
    registerPersonalGitHubRoutes(app, deps);
    app.get(
      "/sign-in-callback",
      async (c) =>
        (await handleManagedSignInConnectCallback(c, deps, "github")) ??
        c.text("not a managed connect callback"),
    );
    app.post("/github/start", async (c) => {
      const input = await c.req.json().catch(() => ({}));
      return c.json(
        await startPersonalGitHubOAuth(deps, {
          access: await requireAccessGrantAuthorization(c, deps, workspaceId, "connections:write"),
          workspaceId,
          ...(input.connectAttemptId ? { connectAttemptId: input.connectAttemptId } : {}),
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        }),
      );
    });
    app.post("/github/forged", async (c) => {
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "connections:write",
      );
      return c.json(
        await startPersonalGitHubOAuth(deps, {
          access: { ...access, canonicalManagedHumanSession: true },
          workspaceId,
        }),
      );
    });
  });
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function request(
    path: string,
    body: unknown = connectBody,
    proof: Partial<DelegatedHumanAuthorization> = {},
    headers?: HeadersInit,
    method = "POST",
  ) {
    const raw = new Request(`${publicBaseUrl}${path}`, {
      method,
      headers: headers ?? { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    stampDelegatedHumanAuthorization(raw, {
      organizationId,
      subjectId,
      permissions: ["account:read", "connections:write"],
      workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
      ...proof,
    });
    return raw;
  }
  async function githubStart(input: Record<string, unknown> = {}) {
    const response = await app.fetch(request("/github/start", input));
    expect(response.status).toBe(200);
    const result = await response.json();
    return {
      result,
      url: new URL(result.authorizationUrl),
      intent: new URL(result.authorizationUrl).searchParams.get("intent")!,
      state: readSignedState(
        new URL(result.authorizationUrl).searchParams.get("intent")!,
        stateSecret,
      )!,
    };
  }
  async function nativeGithubStart(input?: Awaited<ReturnType<typeof githubStart>>) {
    const begun = input ?? (await githubStart());
    const response = await app.fetch(
      new Request(begun.url, { headers: { cookie: browserHeaders.cookie } }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const url = new URL(response.headers.get("location")!);
    return {
      begun,
      url,
      state: readSignedState(url.searchParams.get("state")!, stateSecret)!,
    };
  }
  async function callback(state: string, code?: string) {
    return completePersonalGitHubOAuthCallback(deps, {
      requestUrl: `${publicBaseUrl}/v1/integrations/github-personal/oauth/callback`,
      state,
      ...(code ? { code } : {}),
    });
  }

  for (const provider of ["google", "github"]) {
    test(`sign-in ${provider}: exact verified person gets an existing browser destination without any link mutation`, async () => {
      const response = await app.fetch(
        request("/v1/auth/sign-in-methods/connect", { ...connectBody, provider }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        url: `${webBaseUrl}/settings/security`,
        nextAction: "open_in_browser",
        provider,
        providerFlowStarted: false,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(sessions).not.toHaveBeenCalled();
      expect(linkSocial).not.toHaveBeenCalled();
      expect(nativeHandler).not.toHaveBeenCalled();
    });
  }
  test("sign-in initiation checks exact canonical identity and revision without treating them as actor selectors", async () => {
    for (const changes of [{ expectedIdentityId: operationId }, { expectedIdentityRevision: 2 }]) {
      const response = await app.fetch(
        request("/v1/auth/sign-in-methods/connect", { ...connectBody, ...changes }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "SIGN_IN_METHOD_IDENTITY_CHANGED" });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(linkSocial).not.toHaveBeenCalled();
  });
  test("sign-in initiation needs the live native profile and literal account:read ceiling", async () => {
    const path = "/v1/auth/sign-in-methods/connect";
    expect(
      (await app.fetch(request(path, connectBody, { permissions: ["connections:write"] }))).status,
    ).toBe(403);
    live.accountGrants[0]!.permissions = [];
    expect((await app.fetch(request(path))).status).toBe(403);
    profiles.mockResolvedValue([]);
    expect((await app.fetch(request(path))).status).toBe(403);
    expect(projections).not.toHaveBeenCalled();
  });
  test("sign-in provider configuration and schema are checked before returning a browser destination", async () => {
    const path = "/v1/auth/sign-in-methods/connect";
    expect((await app.fetch(request(path, { ...connectBody, provider: "unknown" }))).status).toBe(
      422,
    );
    expect(
      (await app.fetch(request(path, { ...connectBody, authSessionId: "invented" }))).status,
    ).toBe(422);
    deps.settings.managedAuthGithubClientSecret = undefined;
    expect((await app.fetch(request(path))).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect(linkSocial).not.toHaveBeenCalled();
  });
  test("delegation cannot disconnect, set a password or bind a native OAuth callback even with native-looking headers", async () => {
    for (const action of ["disconnect", "password"]) {
      const response = await app.fetch(
        request(
          `/v1/auth/sign-in-methods/${action}`,
          { ...connectBody, newPassword: "fixture-new-password" },
          {},
          browserHeaders,
        ),
      );
      expect(response.status).toBe(403);
    }
    const response = await app.fetch(
      request("/sign-in-callback?state=fixture-state", {}, {}, browserHeaders, "GET"),
    );
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(nativeHandler).not.toHaveBeenCalled();
  });
  test("forged headers/metadata/session ids and service bearers cannot borrow the native credential path", async () => {
    const token = await signDelegatedAccessToken(delegationSecret, {
      accountId: organizationId,
      workspaceId,
      subjectId,
      principalKind: "service",
      permissions: ["workspace:admin"],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    for (const path of [
      "/v1/auth/sign-in-methods/connect",
      "/v1/auth/sign-in-methods/disconnect",
      "/v1/auth/sign-in-methods/password",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          ...browserHeaders,
          authorization: `Bearer ${token}`,
          "x-opengeni-delegated-human": subjectId,
        },
        body: JSON.stringify({
          ...connectBody,
          canonicalManagedHumanSession: true,
          session: { id: "fake-session" },
        }),
      });
      expect(response.status).toBe(403);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
  });
  test("native sign-in connect still rejects missing same-origin browser admission", async () => {
    expect(
      (
        await app.request("/v1/auth/sign-in-methods/connect", {
          method: "POST",
          headers: { cookie: browserHeaders.cookie },
          body: JSON.stringify(connectBody),
        })
      ).status,
    ).toBe(403);
    expect(sessions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  test("sign-in initiation in broker mode never manufactures an actor fence or browser session", async () => {
    deps.settings.managedAuthSessionSetMode = "broker";
    const response = await app.fetch(request("/v1/auth/sign-in-methods/connect"));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.providerFlowStarted).toBe(false);
    expect(result.actorFence).toBeUndefined();
    expect(result.authSessionId).toBeUndefined();
    expect(sessions).not.toHaveBeenCalled();
    expect(linkSocial).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("personal GitHub delegation gets only an exact-owner signed native handoff, never provider state or PKCE", async () => {
    const { state, url } = await githubStart();
    expect(state).toMatchObject({
      kind: "personal_github_native_handoff",
      version: 1,
      provider: "github-personal",
      accountId: organizationId,
      workspaceId,
      subjectId,
      permissions: ["connections:write"],
    });
    expect(url.origin).toBe(publicBaseUrl);
    expect(url.pathname).toBe(
      `/v1/workspaces/${workspaceId}/connections/github/oauth/native-start`,
    );
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(state.canonicalManagedHumanSession).toBeUndefined();
    expect(state.personalOwnerVerified).toBeUndefined();
    expect(state.encryptedPkceVerifier).toBeUndefined();
    expect(state.encryptedExternalContinuation).toBeUndefined();
    expect(state.browserSessionHash).toBeUndefined();
    expect(state.session).toBeUndefined();
    expect(sessions).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(providerRequests).toEqual([]);
    expect(nonceUses.size).toBe(0);
  });
  test("personal GitHub proof-only callback rejects known initiation and legacy delegated provider state even with a valid code", async () => {
    const begun = await githubStart();
    const legacy = {
      ...begun.state,
      kind: "personal_github_oauth",
      delegatedActor: {
        kind: "delegated_human",
        version: 1,
        provider: "github-personal",
        organizationId,
        workspaceId,
        subjectId,
        permissions: ["connections:write"],
      },
      personalOwnerVerified: true,
      canonicalManagedHumanSession: false,
      encryptedPkceVerifier: db.encryptEnvironmentValue(encryptionKey, "known-pkce-fixture"),
    };
    for (const state of [
      begun.intent,
      createSignedState(stateSecret, legacy),
      createSignedState(stateSecret, { ...legacy, canonicalManagedHumanSession: true }),
      createSignedState(stateSecret, { ...legacy, delegatedActor: undefined }),
    ]) {
      const target = `/v1/integrations/github-personal/oauth/callback?code=valid-provider-code&state=${encodeURIComponent(state)}`;
      const response = await app.fetch(request(target, {}, {}, browserHeaders, "GET"));
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).searchParams.get("reason")).toBe(
        "invalid_state",
      );
    }
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
  });
  test("personal GitHub native handoff mints fresh provider nonce and PKCE only from independently resolved browser proof", async () => {
    const begun = await githubStart();
    const native = await nativeGithubStart(begun);
    expect(native.url.origin).toBe("https://github.com");
    expect(native.state.kind).toBe("personal_github_oauth");
    expect(native.state.nonce).not.toBe(begun.state.nonce);
    expect(native.url.searchParams.get("state")).not.toBe(begun.intent);
    expect(native.state.canonicalManagedHumanSession).toBe(true);
    expect(native.state.personalOwnerVerified).toBe(true);
    expect(native.state.delegatedActor).toBeUndefined();
    expect(native.state.encryptedExternalContinuation).toBeUndefined();
    expect(native.state).toMatchObject({ accountId: organizationId, workspaceId, subjectId });
    const verifier = db.decryptEnvironmentValue(
      encryptionKey,
      String(native.state.encryptedPkceVerifier),
    );
    expect(native.url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(nonceUses.has(String(begun.state.nonce))).toBe(true);
    expect(nonceUses.has(String(native.state.nonce))).toBe(false);
    const replay = await app.fetch(
      new Request(begun.url, { headers: { cookie: browserHeaders.cookie } }),
    );
    expect(replay.status).toBe(409);
  });
  test("personal GitHub handoff rejects delegated dispatch, service bearer and fabricated browser headers before resolving a session", async () => {
    const begun = await githubStart();
    expect(
      (
        await app.fetch(
          request(begun.url.pathname + begun.url.search, {}, {}, browserHeaders, "GET"),
        )
      ).status,
    ).toBe(403);
    for (const headers of [
      {},
      { cookie: browserHeaders.cookie, authorization: "Bearer fake-service" },
      { "x-opengeni-delegated-human": subjectId, "x-opengeni-browser-session": "fake" },
    ])
      expect((await app.fetch(new Request(begun.url, { headers }))).status).toBe(403);
    expect(sessions).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    expect(providerRequests).toEqual([]);
  });
  test("personal GitHub handoff binds exact native person, organization, workspace, provider and permission ceiling", async () => {
    const begun = await githubStart();
    for (const change of [
      { subjectId: "user:other-native-person" },
      { accountId: operationId },
      { workspaceId: otherWorkspaceId },
      { provider: "google" },
      { permissions: [] },
      { permissions: ["connections:write", "account:admin"] },
      { canonicalManagedHumanSession: true },
    ]) {
      const url = new URL(begun.url);
      url.searchParams.set("intent", createSignedState(stateSecret, { ...begun.state, ...change }));
      expect(
        (await app.fetch(new Request(url, { headers: { cookie: browserHeaders.cookie } }))).status,
      ).toBe(403);
    }
    live.workspaceGrants[0]!.permissions = ["workspace:read"];
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(403);
    expect(nonceUses.size).toBe(0);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub handoff cannot be resumed by a different actual native browser person", async () => {
    const begun = await githubStart();
    const otherUserId = "different-native-browser-owner";
    const otherSubjectId = `user:${otherUserId}`;
    live.subjectId = otherSubjectId;
    for (const grant of [...live.accountGrants, ...live.workspaceGrants])
      grant.subjectId = otherSubjectId;
    sessions.mockResolvedValue({
      headers: new Headers(),
      response: {
        user: { id: otherUserId, email: "other@example.test", emailVerified: true, name: "Other" },
        session: { id: "other-real-native-session" },
      },
    });
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(403);
    expect(sessions).toHaveBeenCalled();
    expect(nonceUses.size).toBe(0);
    expect(providerRequests).toEqual([]);
  });
  test("personal GitHub cookie-shaped headers and session metadata cannot replace native cookie verification", async () => {
    const begun = await githubStart();
    const response = await app.fetch(
      new Request(begun.url, {
        headers: {
          cookie: "native-cookie=fabricated",
          "x-opengeni-native-session-id": "invented-session",
          "x-opengeni-canonical-managed-human-session": "true",
        },
      }),
    );
    expect(response.status).toBe(401);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(nonceUses.size).toBe(0);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub handoff is signed, expiry-bound and fails closed on live owner revocation", async () => {
    const begun = await githubStart();
    for (const intent of [
      begun.intent.replace(/.$/, begun.intent.endsWith("a") ? "b" : "a"),
      createSignedState(stateSecret, begun.state, Math.floor(Date.now() / 1000) - 601),
    ]) {
      const url = new URL(begun.url);
      url.searchParams.set("intent", intent);
      expect(
        (await app.fetch(new Request(url, { headers: { cookie: browserHeaders.cookie } }))).status,
      ).toBe(403);
    }
    nativeAuthorityLive = false;
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(403);
    expect(nonceUses.size).toBe(0);
    expect(providerRequests).toEqual([]);
  });
  test("personal GitHub native handoff preserves exact Connect attempt and refuses a changed stage before minting consent", async () => {
    const begun = await githubStart({ connectAttemptId: operationId });
    expect(begun.state.connectAttemptId).toBe(operationId);
    attempts.mockResolvedValueOnce({
      attempt: {
        providerId: "github-personal",
        ownership: "personal",
        state: "complete",
        revision: 2,
      } as never,
      returnUrl: `${webBaseUrl}/integrations`,
      operationInFlight: false,
    });
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(409);
    expect(nonceUses.size).toBe(0);
    const native = await nativeGithubStart(begun);
    expect(native.state.connectAttemptId).toBe(operationId);
    expect(native.state.nonce).not.toBe(begun.state.nonce);
    expect(attempts.mock.calls[0]![1]).toMatchObject({
      accountId: organizationId,
      workspaceId,
      subjectId,
    });
    expect(attempts.mock.calls[0]![2]).toBe(operationId);
  });
  test("personal GitHub reconnect handoff never silently adopts a newer credential generation", async () => {
    const connection = {
      id: connectionId,
      version: 1,
      accountId: organizationId,
      workspaceId,
      subjectId,
      providerDomain: "github.com",
      kind: "oauth2",
      metadata: {
        credentialRole: "opengeni_github_personal",
        providerFamily: "github",
        providerPrincipalId: "12345",
        githubUserId: "12345",
        githubLogin: "fixture-person",
        oauthEnvironment: "test",
        oauthClientMarker: "1".repeat(32),
        credentialBindingId: identityId,
        connectedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      },
    };
    metadata.mockResolvedValue(connection as never);
    const begun = await githubStart({ connectionId });
    expect(begun.state).toMatchObject({ connectionId, connectionVersion: 1 });
    metadata.mockResolvedValue({ ...connection, version: 2 } as never);
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(409);
    expect(nonceUses.size).toBe(0);
    metadata.mockResolvedValueOnce(connection as never);
    expect(
      (await app.fetch(new Request(begun.url, { headers: { cookie: browserHeaders.cookie } })))
        .status,
    ).toBe(409);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub native completion preserves the exact Personal owner seam and single-use provider nonce", async () => {
    const begun = await nativeGithubStart();
    ordinaryMembershipPresent = false;
    const state = begun.url.searchParams.get("state")!;
    const result = await callback(state, "fixture-consented-provider-code");
    expect(new URL(result.redirectTo).searchParams.get("github_personal_oauth")).toBe("success");
    expect(providerRequests).toEqual([PERSONAL_GITHUB_TOKEN_URL, PERSONAL_GITHUB_USER_URL]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![1]).toMatchObject({
      accountId: organizationId,
      workspaceId,
      subjectId,
      createdBySubjectId: subjectId,
      requireLiveUserAuthority: true,
      requiredLiveUserPermission: "connections:write",
      allowCanonicalPersonalWorkspaceOwner: true,
    });
    expect(begun.state.canonicalManagedHumanSession).toBe(true);
    const replay = await callback(state, "fixture-consented-provider-code");
    expect(new URL(replay.redirectTo).searchParams.get("reason")).toBe("state_replayed");
    expect(persist).toHaveBeenCalledTimes(1);
  });
  test("personal GitHub missing provider consent cannot persist a credential", async () => {
    const begun = await nativeGithubStart();
    const result = await callback(begun.url.searchParams.get("state")!);
    expect(new URL(result.redirectTo).searchParams.get("reason")).toBe("missing_code");
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub callback rejects non-native state and mixed canonical/external claims", async () => {
    const { state } = await nativeGithubStart();
    const consumed = nonceUses.size;
    for (const change of [
      { canonicalManagedHumanSession: false },
      { encryptedExternalContinuation: "fake-external-identity" },
    ]) {
      const result = await callback(
        createSignedState(stateSecret, { ...state, ...change }),
        "fixture-code",
      );
      expect(new URL(result.redirectTo).searchParams.get("reason")).toBe("invalid_state");
    }
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(consumed);
  });
  test("personal GitHub existing encrypted external continuation remains separate, live and revocable", async () => {
    const native = await nativeGithubStart();
    const externalSubjectId = `external_user:${identityId}`;
    const continuation = ExternalActorContinuation.parse({
      identity: { externalId: "fixture-host-person", source: "fixture-host" },
      actor: {
        accountId: organizationId,
        authenticatingApiKeyId: connectionId,
        externalIdentityId: identityId,
        externalSubjectId,
        externalAuthorizationRevision: 1,
        effectiveSubjectId: externalSubjectId,
        actingMode: "external",
      },
    });
    const externalKey = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue([
      "connections:write",
    ]);
    const externalIdentity = spyOn(db, "ensureExternalIdentity").mockResolvedValue({
      id: identityId,
      accountId: organizationId,
      subjectId: externalSubjectId,
      source: "fixture-host",
      externalId: "fixture-host-person",
      authorizationRevision: 1,
      personalWorkspaceId: workspaceId,
    } as never);
    restores.push(
      () => externalKey.mockRestore(),
      () => externalIdentity.mockRestore(),
    );
    // Model the existing server-minted encrypted external callback, not a
    // native/delegated caller manufacturing an external request proof.
    const payload = {
      ...native.state,
      subjectId: externalSubjectId,
      canonicalManagedHumanSession: false,
      encryptedExternalContinuation: db.encryptEnvironmentValue(
        encryptionKey,
        JSON.stringify(continuation),
      ),
    };
    const result = await callback(createSignedState(stateSecret, payload), "fixture-code");
    expect(new URL(result.redirectTo).searchParams.get("github_personal_oauth")).toBe("success");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![1].subjectId).toBe(externalSubjectId);
    expect(externalKey.mock.calls.length).toBeGreaterThanOrEqual(3);
    externalKey.mockResolvedValue(null);
    const revoked = await callback(createSignedState(stateSecret, payload), "fixture-code");
    expect(new URL(revoked.redirectTo).searchParams.get("github_personal_oauth")).toBe("error");
    expect(providerRequests).toEqual([PERSONAL_GITHUB_TOKEN_URL, PERSONAL_GITHUB_USER_URL]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
  test("personal GitHub native handoff retains the Connect DB origin restriction through callback claim", async () => {
    const native = await nativeGithubStart(await githubStart({ connectAttemptId: operationId }));
    const origin = ExternalActorContinuation.parse({
      identity: { externalId: "fixture-linked-person", source: "fixture-host" },
      actor: {
        accountId: organizationId,
        authenticatingApiKeyId: connectionId,
        externalIdentityId: identityId,
        externalSubjectId: `external_user:${identityId}`,
        externalAuthorizationRevision: 1,
        effectiveSubjectId: subjectId,
        actingMode: "linked_native",
        linkId: otherWorkspaceId,
        linkRevision: 1,
      },
    });
    const externalKey = spyOn(db, "lockActiveExternalOrganizationKey").mockResolvedValue(null);
    const fence = spyOn(policy, "withOrganizationIntegrationPolicyFence").mockImplementation(
      async (_, __, use) => use(deps.db, { mode: "unrestricted" } as never),
    );
    const claim = spyOn(db, "claimConnectOperation").mockImplementation(async (_, __, input) => {
      // DB port fixture supplies the stored origin independently of native
      // callback state; the real callback authorizer must not discard it.
      await input.authorize?.(deps.db, {} as never, origin);
      throw new Error("Revoked original host must deny before claiming");
    });
    restores.push(
      () => externalKey.mockRestore(),
      () => fence.mockRestore(),
      () => claim.mockRestore(),
    );
    const result = await callback(native.url.searchParams.get("state")!, "fixture-code");
    expect(result).toEqual({ redirectTo: `${webBaseUrl}/integrations`, exactReturn: true });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0]![2]).toMatchObject({ expectedRevision: 1 });
    expect(externalKey).toHaveBeenCalled();
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub rechecks native membership at callback and again after provider exchange", async () => {
    const first = await nativeGithubStart();
    nativeAuthorityLive = false;
    const result = await callback(first.url.searchParams.get("state")!, "fixture-code");
    expect(new URL(result.redirectTo).searchParams.get("github_personal_oauth")).toBe("error");
    expect(providerRequests).toEqual([]);
    nativeAuthorityLive = true;
    const second = await nativeGithubStart();
    revokeDuringProvider = true;
    const during = await callback(second.url.searchParams.get("state")!, "fixture-code");
    expect(new URL(during.redirectTo).searchParams.get("github_personal_oauth")).toBe("error");
    expect(providerRequests.length).toBe(2);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub cloned authorization and fake canonical flags cannot mint owner state", async () => {
    expect((await app.fetch(request("/github/forged", {}))).status).toBe(403);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub narrowed ceilings and selected workspace bounds cannot start a provider flow", async () => {
    expect(
      (await app.fetch(request("/github/start", {}, { permissions: ["account:read"] }))).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          request(
            "/github/start",
            {},
            {
              workspaceScope: { kind: "selected", workspaceIds: [otherWorkspaceId] },
            },
          ),
        )
      ).status,
    ).toBe(403);
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub service and human-shaped legacy bearers cannot mint verified owning-user state", async () => {
    for (const principalKind of ["service", "human_session"] as const) {
      const token = await signDelegatedAccessToken(delegationSecret, {
        accountId: organizationId,
        workspaceId,
        subjectId,
        principalKind,
        permissions: ["connections:write"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const response = await app.request("/github/start", {
        method: "POST",
        headers: {
          ...browserHeaders,
          authorization: `Bearer ${token}`,
          "x-opengeni-delegated-human": subjectId,
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
  test("personal GitHub tampered and expired signed state fail before provider exchange", async () => {
    const begun = await nativeGithubStart();
    const consumed = nonceUses.size;
    const raw = begun.url.searchParams.get("state")!;
    const invalid = raw.replace(/.$/, raw.endsWith("a") ? "b" : "a");
    for (const state of [
      invalid,
      createSignedState(stateSecret, begun.state, Math.floor(Date.now() / 1000) - 3601),
    ]) {
      const response = await callback(state, "fixture-code");
      expect(new URL(response.redirectTo).searchParams.get("reason")).toBe("invalid_state");
    }
    expect(providerRequests).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
    expect(nonceUses.size).toBe(consumed);
  });
  test("personal GitHub native cookie starts keep the native flag and omit delegated state", async () => {
    const response = await app.request("/github/start", {
      method: "POST",
      headers: browserHeaders,
      body: "{}",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    const state = readSignedState(
      new URL(result.authorizationUrl).searchParams.get("state")!,
      stateSecret,
    )!;
    expect(state.canonicalManagedHumanSession).toBe(true);
    expect(state.delegatedActor).toBeUndefined();
    expect(state.personalOwnerVerified).toBe(true);
  });
});
