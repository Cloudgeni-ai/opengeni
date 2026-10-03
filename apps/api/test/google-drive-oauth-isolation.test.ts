import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Settings } from "@opengeni/config";
import { requireAccessGrantAuthorization, stampDelegatedHumanAuthorization } from "@opengeni/core";
import {
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  signDelegatedAccessToken,
  type Permission,
} from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
} from "@opengeni/contracts/google-drive";
import {
  createDb,
  getConnectionMetadata,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
  synchronizeCanonicalHumanLoginBindings,
  type DbClient,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";
import { bindNativeProviderStart } from "../src/integrations/delegated-native-provider-handoff";

const DELEGATION_SECRET = "google-drive-isolation-delegation-secret";
const STATE_SECRET = "google-drive-isolation-state-secret";
const CLIENT_ID = "google-drive-isolation.apps.googleusercontent.com";
const CLIENT_SECRET = "google-drive-isolation-client-secret-do-not-leak";
const ACCESS_TOKEN = "google-drive-isolation-access-token-do-not-leak";
const REFRESH_TOKEN = "google-drive-isolation-refresh-token-do-not-leak";
const ROTATED_ACCESS_TOKEN = "google-drive-isolation-rotated-access-token-do-not-leak";
const ROTATED_REFRESH_TOKEN = "google-drive-isolation-rotated-refresh-token-do-not-leak";
const PROVIDER_ERROR_DETAIL = "google-drive-isolation-provider-error-detail-do-not-leak";

type Authority = { accountId: string; workspaceId: string };
type NativeBrowser = {
  cookie: string;
  flowCookies: Map<string, string>;
  sessionId: string;
  user: { id: string; name: string; email: string; emailVerified: boolean };
};
const nativeBrowsers = new Map<string, NativeBrowser>();

function subjectFor(authority: Authority, label = "subject-a"): string {
  return `user:google-drive-isolation-${authority.accountId}-${label}`;
}

let shared: SharedTestDatabase;
let client: DbClient;
let settings: Settings;

beforeAll(async () => {
  const database = await acquireSharedTestDatabase("api_google_drive_oauth_isolation");
  if (!database) {
    throw new Error(
      "Google Drive isolation proof requires the repository PostgreSQL test database",
    );
  }
  shared = database;
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "http://127.0.0.1:8000",
    webBaseUrl: "http://127.0.0.1:3000",
    googleDriveClientId: CLIENT_ID,
    googleDriveClientSecret: CLIENT_SECRET,
  }) as Settings;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function freshAuthority(accountId?: string): Promise<Authority> {
  const resolvedAccountId =
    accountId ??
    (
      await shared.admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('Google Drive isolation account') returning id`
    )[0]!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${resolvedAccountId}, 'Google Drive isolation workspace') returning id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${resolvedAccountId})`;
  for (const label of ["subject-a", "subject-b"]) {
    const subjectId = subjectFor(
      { accountId: resolvedAccountId, workspaceId: workspace!.id },
      label,
    );
    if (!accountId) {
      const userId = subjectId.slice("user:".length);
      await shared.admin`insert into auth_users (id, name, email, email_verified)
        values (${userId}, 'Google Drive isolation user', ${`${resolvedAccountId}-${label}@example.test`}, true)`;
      const [personal] = await shared.admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${resolvedAccountId}, 'Google Drive isolation personal workspace') returning id`;
      await shared.admin`insert into workspace_inference_controls (workspace_id, account_id)
        values (${personal!.id}, ${resolvedAccountId})`;
      await shared.admin`insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (${resolvedAccountId}, ${subjectId}, 'member', 'active', ${personal!.id})`;
      await shared.admin`insert into auth_identities (id, user_id, provider_id, account_id)
        values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
      const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
      const sessionId = crypto.randomUUID();
      await shared.admin`insert into auth_sessions (
        id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
      ) values (${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
        ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision})`;
      nativeBrowsers.set(subjectId, {
        cookie: `google-drive-native-session=${sessionId}`,
        flowCookies: new Map(),
        sessionId,
        user: {
          id: userId,
          name: "Google Drive isolation user",
          email: `${resolvedAccountId}-${label}@example.test`,
          emailVerified: true,
        },
      });
    }
    await shared.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${resolvedAccountId}, ${workspace!.id}, ${subjectId}, ${subjectId}, 'member',
        ${shared.admin.json(["connections:read", "connections:write"])}
      )`;
  }
  return { accountId: resolvedAccountId, workspaceId: workspace!.id };
}

async function bearer(
  authority: Authority,
  subjectId: string,
  permissions: Permission[] = ["connections:read", "connections:write"],
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...authority,
    subjectId: subjectFor(authority, subjectId),
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerDouble(
  options: {
    scopes?: string[];
    permissionId?: string;
    identityGate?: Promise<void>;
    identityStarted?: () => void;
    refreshError?: string;
  } = {},
) {
  const requests: Array<{
    url: string;
    redirect: RequestRedirect | undefined;
    authorization: string | null;
    body: URLSearchParams;
  }> = [];
  const fetch = (async (...[input, init]: Parameters<typeof globalThis.fetch>) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body =
      init?.body instanceof URLSearchParams
        ? new URLSearchParams(init.body)
        : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    requests.push({
      url: url.toString(),
      redirect: init?.redirect,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (body.get("grant_type") === "refresh_token" && options.refreshError) {
        return Response.json(
          {
            error: options.refreshError,
            error_description: PROVIDER_ERROR_DETAIL,
          },
          { status: 400 },
        );
      }
      const refresh = body.get("grant_type") === "refresh_token";
      return Response.json({
        access_token: refresh ? ROTATED_ACCESS_TOKEN : ACCESS_TOKEN,
        refresh_token: refresh ? ROTATED_REFRESH_TOKEN : REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        scope: (options.scopes ?? [GOOGLE_DRIVE_READONLY_SCOPE]).join(" "),
      });
    }
    if (url.pathname === "/drive/v3/about") {
      options.identityStarted?.();
      await options.identityGate;
      return Response.json({
        user: {
          displayName: "Google Drive Isolation User",
          emailAddress: "google-drive-isolation@example.com",
          permissionId: options.permissionId ?? "google-drive-isolation-permission-a",
        },
      });
    }
    if (url.pathname === "/drive/v3/files") {
      return Response.json({ incompleteSearch: false, files: [] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

function browserCookie(authority: Authority, label = "subject-a") {
  const browser = nativeBrowsers.get(subjectFor(authority, label))!;
  return [browser.cookie, ...browser.flowCookies.values()].join("; ");
}

function rememberFlowCookies(authority: Authority, response: Response, label = "subject-a") {
  const browser = nativeBrowsers.get(subjectFor(authority, label))!;
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie).toContain("HttpOnly");
    const pair = cookie.split(";", 1)[0]!;
    browser.flowCookies.set(pair.slice(0, pair.indexOf("=")), pair);
  }
}

function api(googleDriveFetch: typeof globalThis.fetch) {
  const deps = {
    settings,
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const cookies = (headers.get("cookie") ?? "").split(";").map((value) => value.trim());
          const browser = [...nativeBrowsers.values()].find((candidate) =>
            cookies.includes(candidate.cookie),
          );
          return {
            headers: new Headers(),
            response: browser ? { session: { id: browser.sessionId }, user: browser.user } : null,
          };
        },
      },
    },
    googleDriveFetch,
  } as never;
  const server = createApp(deps);
  // Explicitly bind hand-signed malformed parser fixtures through the real
  // native resolver. Normal starts and callbacks never use this test endpoint.
  server.post("/__fixture/google-drive/native-bind", async (c) => {
    const { workspaceId, state } = (await c.req.json()) as { workspaceId: string; state: string };
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("state", state);
    bindNativeProviderStart(c, deps, {
      authorization,
      provider: "google-drive",
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    return c.body(null, 204);
  });
  return server;
}

async function bindParserFixture(
  authority: Authority,
  fetch: typeof globalThis.fetch,
  state: string,
) {
  const response = await api(fetch).request("/__fixture/google-drive/native-bind", {
    method: "POST",
    headers: { cookie: browserCookie(authority), "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: authority.workspaceId, state }),
  });
  expect(response.status, await response.clone().text()).toBe(204);
  rememberFlowCookies(authority, response);
}

async function start(
  authority: Authority,
  fetch: typeof globalThis.fetch,
  subjectId = "subject-a",
  connectionId?: string,
) {
  const request = new Request(
    `http://127.0.0.1:8000/v1/workspaces/${authority.workspaceId}/connections/google-drive/install`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
      },
      body: JSON.stringify(connectionId ? { connectionId } : {}),
    },
  );
  stampDelegatedHumanAuthorization(request, {
    organizationId: authority.accountId,
    subjectId: subjectFor(authority, subjectId),
    permissions: ["connections:read", "connections:write"],
    workspaceScope: { kind: "selected", workspaceIds: [authority.workspaceId] },
  });
  // Hono.request(string, init) constructs another Request and loses this proof.
  const server = api(fetch);
  const started = await server.fetch(request);
  if (started.status !== 200) return started;
  const body = (await started.json()) as { authorizationUrl: string; expiresAt: string };
  const handoff = new URL(body.authorizationUrl);
  expect(handoff.origin).toBe("http://127.0.0.1:8000");
  expect(handoff.pathname).toBe(
    `/v1/workspaces/${authority.workspaceId}/connections/google-drive/oauth/native-start`,
  );
  expect(handoff.searchParams.has("state")).toBe(false);
  const intent = handoff.searchParams.get("intent")!;
  const claims = readSignedState(intent, STATE_SECRET)!;
  expect(claims).toMatchObject({
    kind: "delegated_native_provider_handoff",
    provider: "google-drive",
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    subjectId: subjectFor(authority, subjectId),
  });
  const opened = await server.request(handoff.toString(), {
    headers: { cookie: browserCookie(authority, subjectId) },
  });
  expect(opened.status, await opened.clone().text()).toBe(302);
  rememberFlowCookies(authority, opened, subjectId);
  const authorizationUrl = new URL(opened.headers.get("location")!);
  expect(authorizationUrl.origin).toBe("https://accounts.google.com");
  const providerState = readSignedState(authorizationUrl.searchParams.get("state")!, STATE_SECRET)!;
  expect(providerState.kind).toBe("google_drive_oauth");
  expect(providerState.nonce).not.toBe(claims.nonce);
  return Response.json({ ...body, authorizationUrl: authorizationUrl.toString() });
}

async function connect(authority: Authority, google: ReturnType<typeof providerDouble>) {
  const started = await start(authority, google.fetch);
  expect(started.status).toBe(200);
  const authorizationUrl = new URL(
    ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
  );
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  const completed = await callback(authority, google.fetch, state!);
  expect(completed.headers.get("location")).toContain("google_drive=connected");
  const connection = (
    await listConnectionsMetadata(client.db, authority.workspaceId, subjectFor(authority))
  ).find((candidate) => candidate.providerDomain === "googleapis.com");
  expect(connection).toBeTruthy();
  return { state: state!, connection: connection!, completed };
}

async function callback(
  authority: Authority,
  fetch: typeof globalThis.fetch,
  state: string,
  suffix = "code=fixture-code",
) {
  return await api(fetch).request(
    `/v1/integrations/google-drive/callback?${suffix}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: browserCookie(authority) } },
  );
}

describe("Google Drive OAuth isolation proof", () => {
  test("human-shaped legacy bearer cannot start personal OAuth", async () => {
    const authority = await freshAuthority();
    const google = providerDouble();
    const response = await api(google.fetch).request(
      `/v1/workspaces/${authority.workspaceId}/connections/google-drive/install`,
      {
        method: "POST",
        headers: {
          authorization: await bearer(authority, "subject-a"),
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(403);
    expect(google.requests).toHaveLength(0);
    expect((await start(authority, google.fetch)).status).toBe(200);
  });
  test("callback requires its flow cookie and exact native browser, not delegation", async () => {
    const authority = await freshAuthority();
    const google = providerDouble();
    const started = await start(authority, google.fetch);
    const state = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const callbackUrl = `http://127.0.0.1:8000/v1/integrations/google-drive/callback?code=fixture-code&state=${encodeURIComponent(state)}`;
    const browser = nativeBrowsers.get(subjectFor(authority))!;
    const other = nativeBrowsers.get(subjectFor(authority, "subject-b"))!;
    const server = api(google.fetch);
    expect(
      (await server.request(callbackUrl, { headers: { cookie: browser.cookie } })).status,
    ).toBe(403);
    expect(
      (
        await server.request(callbackUrl, {
          headers: { cookie: [other.cookie, ...browser.flowCookies.values()].join("; ") },
        })
      ).status,
    ).toBe(403);
    const delegated = new Request(callbackUrl, { headers: { cookie: browserCookie(authority) } });
    stampDelegatedHumanAuthorization(delegated, {
      organizationId: authority.accountId,
      subjectId: subjectFor(authority),
      permissions: ["connections:read", "connections:write"],
      workspaceScope: { kind: "selected", workspaceIds: [authority.workspaceId] },
    });
    expect((await server.fetch(delegated)).status).toBe(403);
    expect(google.requests).toHaveLength(0);
    expect((await callback(authority, google.fetch, state)).headers.get("location")).toContain(
      "google_drive=connected",
    );
  });
  test("a state minted by another flow cannot be presented to this callback", async () => {
    // This state carries no ownership field and no provider identity, and its
    // return path is byte-identical to `/workspaces/<ws>/capabilities` - a path
    // the MCP OAuth start signs from caller input. Without an exact flow kind, a
    // caller's own MCP state reached this callback and passed its personal-owner
    // fence. Same subject and connections:write is rechecked, so never an
    // escalation, but the state was not bound to the flow that minted it.
    const authority = await freshAuthority();
    const google = providerDouble();
    const started = await start(authority, google.fetch);
    expect(started.status).toBe(200);
    const state = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const payload = readSignedState(state, STATE_SECRET) as Record<string, unknown>;
    expect(payload.kind).toBe("google_drive_oauth");

    const { kind: _dropped, ...foreignFlow } = payload;
    for (const candidate of [foreignFlow, { ...foreignFlow, kind: "atlassian_oauth" }]) {
      const refused = await callback(
        authority,
        google.fetch,
        createSignedState(STATE_SECRET, candidate),
      );
      expect(refused.status).toBe(302);
      // Correctly signed, so it may name its own workspace page, but never
      // anything its payload chose.
      expect(refused.headers.get("location")).toBe(
        `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/plugins?google_drive=error&reason=state_invalid`,
      );
    }
    // Refused before any provider traffic, and nothing was written.
    expect(google.requests).toHaveLength(0);
    expect(
      (
        await listConnectionsMetadata(client.db, authority.workspaceId, subjectFor(authority))
      ).filter((candidate) => candidate.providerDomain === "googleapis.com"),
    ).toEqual([]);

    // Positive control: the original browser-minted state retains its own kind
    // and flow-binding cookie, and connects.
    const accepted = await callback(authority, google.fetch, state);
    expect(accepted.headers.get("location")).toContain("google_drive=connected");
  });

  test("a legacy in-flight state cannot land a personal owner through the callback", async () => {
    // Google Drive is personal-only: the callback always writes
    // `subjectId: state.subjectId`. The start route admits only a managed human
    // and stamps `personalOwnerVerified` into the signed state; a state minted
    // by an older deployment carries no such claim, which is the rolling-deploy
    // window this fence exists to close. This is a real native subject with
    // live membership, so only the removed owner claim explains the refusal.
    const authority = await freshAuthority();
    const google = providerDouble();
    const started = await start(authority, google.fetch);
    expect(started.status).toBe(200);
    const state = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const payload = readSignedState(state, STATE_SECRET) as Record<string, unknown>;
    expect(payload.personalOwnerVerified).toBe(true);

    const { personalOwnerVerified: _dropped, ...legacyPayload } = payload;
    const legacyState = createSignedState(STATE_SECRET, legacyPayload);
    await bindParserFixture(authority, google.fetch, legacyState);
    const refused = await callback(authority, google.fetch, legacyState);
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toContain("google_drive=error");
    expect(refused.headers.get("location")).toContain("reason=http_422");
    // No provider call and no row: the refusal happens before token exchange.
    expect(google.requests).toHaveLength(0);
    expect(
      (
        await listConnectionsMetadata(client.db, authority.workspaceId, subjectFor(authority))
      ).filter((candidate) => candidate.providerDomain === "googleapis.com"),
    ).toEqual([]);

    // The original native state has the claim and its genuine flow cookie.
    const accepted = await callback(authority, google.fetch, state);
    expect(accepted.headers.get("location")).toContain("google_drive=connected");
  });

  test("binds PKCE and exact redirects, and rejects signed redirect/reconnect confusion", async () => {
    const authority = await freshAuthority();
    const google = providerDouble();
    const started = await start(authority, google.fetch);
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as { authorizationUrl: string };
    const authorizationUrl = new URL(startedBody.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/google-drive/callback",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(GOOGLE_DRIVE_READONLY_SCOPE);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const payload = readSignedState(state!, STATE_SECRET) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ...authority,
      subjectId: subjectFor(authority),
      returnPath: `/workspaces/${authority.workspaceId}/capabilities`,
    });
    expect(JSON.stringify(payload)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(payload)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(payload)).not.toContain(CLIENT_SECRET);

    // A correctly signed state that its flow rejects never supplies its own
    // return path. It may land only on the UUID-checked workspace Plugins page.
    const maliciousReturn = createSignedState(STATE_SECRET, {
      ...payload,
      returnPath: "https://attacker.invalid/oauth-capture",
    });
    await bindParserFixture(authority, google.fetch, maliciousReturn);
    const rejectedReturn = await callback(
      authority,
      google.fetch,
      maliciousReturn,
      "error=access_denied",
    );
    expect(rejectedReturn.status).toBe(302);
    expect(rejectedReturn.headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/plugins?google_drive=error&reason=state_invalid`,
    );
    expect(google.requests).toHaveLength(0);

    const unpairedReconnect = createSignedState(STATE_SECRET, {
      ...payload,
      connectionId: "c0ffee00-cafe-4000-8000-000000000001",
    });
    await bindParserFixture(authority, google.fetch, unpairedReconnect);
    const rejectedReconnect = await callback(authority, google.fetch, unpairedReconnect);
    expect(rejectedReconnect.headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/plugins?google_drive=error&reason=state_invalid`,
    );
    expect(google.requests).toHaveLength(0);

    const completed = await callback(authority, google.fetch, state!);
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toMatch(
      new RegExp(
        `^http://127\\.0\\.0\\.1:3000/workspaces/${authority.workspaceId}/capabilities\\?google_drive=connected&connectionId=[0-9a-f-]+$`,
      ),
    );
    expect(google.requests.every((request) => request.redirect === "error")).toBe(true);
    const tokenRequest = google.requests.find(
      (request) => request.url === "https://oauth2.googleapis.com/token",
    );
    expect(tokenRequest?.body.get("redirect_uri")).toBe(
      "http://127.0.0.1:8000/v1/integrations/google-drive/callback",
    );
    expect(tokenRequest?.body.get("client_secret")).toBe(CLIENT_SECRET);
    const verifier = tokenRequest?.body.get("code_verifier");
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier!).digest("base64url")).toBe(
      authorizationUrl.searchParams.get("code_challenge")!,
    );
    expect(startedBody.authorizationUrl).not.toContain(verifier!);

    const replay = await callback(authority, google.fetch, state!);
    expect(replay.headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/capabilities?google_drive=error&reason=state_replayed`,
    );
    expect(
      google.requests.filter((request) => request.url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(1);
  });

  test("rejects expired, tampered, cross-account, cross-workspace, and cross-subject authority", async () => {
    const authority = await freshAuthority();
    const google = providerDouble();
    const started = await start(authority, google.fetch);
    const state = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const payload = readSignedState(state, STATE_SECRET) as Record<string, unknown>;

    // An authentic but aged link names its workspace, so it returns there and
    // says it expired. It still authorizes nothing.
    const expired = createSignedState(STATE_SECRET, payload, Math.floor(Date.now() / 1000) - 601);
    expect((await callback(authority, google.fetch, expired)).headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/plugins?google_drive=error&reason=state_expired`,
    );
    // A tampered or foreign-secret state names no trustworthy workspace.
    const tampered = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;
    expect((await callback(authority, google.fetch, tampered)).headers.get("location")).toBe(
      "http://127.0.0.1:3000/integrations?google_drive=error&reason=state_invalid",
    );
    const foreign = createSignedState("another-deployment-secret", payload);
    expect((await callback(authority, google.fetch, foreign)).headers.get("location")).toBe(
      "http://127.0.0.1:3000/integrations?google_drive=error&reason=state_invalid",
    );
    expect(google.requests).toHaveLength(0);

    const otherAccount = await freshAuthority();
    const accountMismatch = createSignedState(STATE_SECRET, {
      ...payload,
      accountId: otherAccount.accountId,
    });
    // The new browser boundary denies mismatched ownership before entering the
    // provider adapter; this is an HTTP refusal, not an OAuth failure redirect.
    expect((await callback(authority, google.fetch, accountMismatch)).status).toBe(403);
    expect(google.requests).toHaveLength(0);

    const connected = await connect(authority, google);
    const subjectDenied = await start(
      authority,
      google.fetch,
      "subject-b",
      connected.connection.id,
    );
    expect(subjectDenied.status).toBe(404);
    const siblingWorkspace = await freshAuthority(authority.accountId);
    expect(
      (await start(siblingWorkspace, google.fetch, "subject-a", connected.connection.id)).status,
    ).toBe(404);
    expect(
      (await start(otherAccount, google.fetch, "subject-a", connected.connection.id)).status,
    ).toBe(404);
    expect(
      (
        await listConnectionsMetadata(
          client.db,
          authority.workspaceId,
          subjectFor(authority, "subject-b"),
        )
      ).filter((connection) => connection.providerDomain === "googleapis.com"),
    ).toEqual([]);
  });

  test("revalidates the initiating subject grant after provider identity and consumes state once", async () => {
    const authority = await freshAuthority();
    const identityGate = deferred();
    const identityStarted = deferred();
    const google = providerDouble({
      identityGate: identityGate.promise,
      identityStarted: identityStarted.resolve,
    });
    const started = await start(authority, google.fetch);
    const state = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const pending = callback(authority, google.fetch, state);
    await identityStarted.promise;
    await shared.admin`
      update workspace_memberships
      set permissions = ${shared.admin.json(["connections:read"])}
      where workspace_id = ${authority.workspaceId} and subject_id = ${subjectFor(authority)}`;
    identityGate.resolve();

    const rejected = await pending;
    expect(rejected.headers.get("location")).toBe(
      `http://127.0.0.1:3000/workspaces/${authority.workspaceId}/capabilities?google_drive=error&reason=http_403`,
    );
    expect(
      (
        await listConnectionsMetadata(client.db, authority.workspaceId, subjectFor(authority))
      ).filter((connection) => connection.providerDomain === "googleapis.com"),
    ).toEqual([]);
    expect(
      google.requests.filter((request) => request.url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(1);

    const replay = await callback(authority, google.fetch, state);
    expect(replay.status).toBe(403);
    expect(
      google.requests.filter((request) => request.url === "https://oauth2.googleapis.com/token"),
    ).toHaveLength(1);
  });

  test("asserts fail-closed capability grants and fences stale reconnect versions", async () => {
    for (const scopes of [
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_METADATA_READONLY_SCOPE],
      ["https://www.googleapis.com/auth/drive.unknown"],
      ["openid", "email"],
    ]) {
      const authority = await freshAuthority();
      const google = providerDouble({ scopes });
      const started = await start(authority, google.fetch);
      const state = new URL(
        ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state")!;
      const rejected = await callback(authority, google.fetch, state);
      expect(rejected.headers.get("location")).toContain("reason=scope_not_granted");
      expect(
        google.requests.some((request) => new URL(request.url).pathname === "/drive/v3/about"),
      ).toBe(false);
      expect(
        (
          await listConnectionsMetadata(client.db, authority.workspaceId, subjectFor(authority))
        ).filter((connection) => connection.providerDomain === "googleapis.com"),
      ).toEqual([]);
    }

    const authority = await freshAuthority();
    const first = providerDouble();
    const connected = await connect(authority, first);
    const credentialBefore = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: authority.workspaceId,
      connectionId: connected.connection.id,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      subjectId: subjectFor(authority),
      allowSubjectOwned: true,
    });
    const reconnect = providerDouble();
    const reconnectStart = await start(
      authority,
      reconnect.fetch,
      "subject-a",
      connected.connection.id,
    );
    const reconnectState = new URL(
      ((await reconnectStart.json()) as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const paused = await api(first.fetch).request(
      `/v1/workspaces/${authority.workspaceId}/connections/google-drive/${connected.connection.id}/lifecycle`,
      {
        method: "PATCH",
        headers: {
          authorization: await bearer(authority, "subject-a"),
          "content-type": "application/json",
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
        body: JSON.stringify({ action: "pause", expectedVersion: connected.connection.version }),
      },
    );
    expect(paused.status).toBe(200);
    const stale = await callback(authority, reconnect.fetch, reconnectState);
    expect(stale.headers.get("location")).toContain("reason=connection_conflict");
    const credentialAfter = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: authority.workspaceId,
      connectionId: connected.connection.id,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      subjectId: subjectFor(authority),
      allowSubjectOwned: true,
    });
    expect(credentialAfter?.credential).toEqual(credentialBefore?.credential);
    expect(
      await getConnectionMetadata(
        client.db,
        authority.workspaceId,
        connected.connection.id,
        subjectFor(authority),
      ),
    ).toMatchObject({
      version: connected.connection.version + 1,
      metadata: { lifecycle: { state: "paused" } },
    });
  });

  test("rotates tokens, disconnects locally, normalizes revocation, and proves secret sinks empty", async () => {
    const authority = await freshAuthority();
    const google = providerDouble();
    const connected = await connect(authority, google);
    await shared.admin`
      update connections set expires_at = now() - interval '1 minute'
      where id = ${connected.connection.id}`;
    const browse = await api(google.fetch).request(
      `/v1/workspaces/${authority.workspaceId}/connections/google-drive/${connected.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization: await bearer(authority, "subject-a", ["connections:read"]),
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    expect(browse.status).toBe(200);
    const refreshRequest = google.requests.find(
      (request) => request.body.get("grant_type") === "refresh_token",
    );
    expect(refreshRequest?.body.get("refresh_token")).toBe(REFRESH_TOKEN);
    expect(refreshRequest?.body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(
      google.requests.some((request) => request.authorization === `Bearer ${ROTATED_ACCESS_TOKEN}`),
    ).toBe(true);
    const rotated = await loadConnectionCredentialForBroker(client.db, settings, {
      workspaceId: authority.workspaceId,
      connectionId: connected.connection.id,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      subjectId: subjectFor(authority),
      allowSubjectOwned: true,
    });
    expect(rotated?.credential).toMatchObject({
      access_token: ROTATED_ACCESS_TOKEN,
      refresh_token: ROTATED_REFRESH_TOKEN,
    });
    const current = await getConnectionMetadata(
      client.db,
      authority.workspaceId,
      connected.connection.id,
      subjectFor(authority),
    );
    expect(JSON.stringify(current)).not.toContain(ROTATED_ACCESS_TOKEN);
    expect(JSON.stringify(current)).not.toContain(ROTATED_REFRESH_TOKEN);

    const providerRequestCount = google.requests.length;
    const disconnectBody = JSON.stringify({
      expectedVersion: current!.version,
      idempotencyKey: `google-drive-isolation-disconnect:${connected.connection.id}:${current!.version}`,
    });
    const disconnect = async () =>
      await api(google.fetch).request(
        `/v1/workspaces/${authority.workspaceId}/connections/${connected.connection.id}`,
        {
          method: "DELETE",
          headers: {
            authorization: await bearer(authority, "subject-a"),
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: disconnectBody,
        },
      );
    expect((await disconnect()).status).toBe(200);
    expect((await disconnect()).status).toBe(200);
    expect(google.requests).toHaveLength(providerRequestCount);

    const revokedAuthority = await freshAuthority();
    const revoked = providerDouble({ refreshError: "invalid_grant" });
    const revokedConnection = await connect(revokedAuthority, revoked);
    await shared.admin`
      update connections set expires_at = now() - interval '1 minute'
      where id = ${revokedConnection.connection.id}`;
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    const rejectedBrowse = await api(revoked.fetch).request(
      `/v1/workspaces/${revokedAuthority.workspaceId}/connections/google-drive/${revokedConnection.connection.id}/browse?parentId=root`,
      {
        headers: {
          authorization: await bearer(revokedAuthority, "subject-a", ["connections:read"]),
          [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
        },
      },
    );
    logSpy.mockRestore();
    expect(rejectedBrowse.status).toBe(401);
    const publicError = JSON.stringify(await rejectedBrowse.json());
    expect(publicError).not.toContain("invalid_grant");
    expect(publicError).not.toContain(PROVIDER_ERROR_DETAIL);
    expect(logs.join("\n")).not.toContain(PROVIDER_ERROR_DETAIL);
    expect(
      await getConnectionMetadata(
        client.db,
        revokedAuthority.workspaceId,
        revokedConnection.connection.id,
        subjectFor(revokedAuthority),
      ),
    ).toMatchObject({
      status: "needs_reauth",
      lastError: "google_drive_token_revoked",
      metadata: { lifecycle: { state: "token_revoked", recoverable: true } },
    });

    const googleBrowserSources = await Promise.all([
      readFile(new URL("../../web/src/lib/google-drive-connection.ts", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../web/src/components/capabilities/use-api-integration-accounts.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(googleBrowserSources.join("\n")).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie/,
    );

    // The Drive adapter itself keeps exactly one browser-storage marker: which
    // OAuth capability the redirect asked for. No credential, token, or
    // connection material may reach any browser store.
    const driveAdapterSource = await readFile(
      new URL(
        "../../web/src/components/capabilities/use-google-drive-integration.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(driveAdapterSource).not.toMatch(/localStorage|indexedDB|document\.cookie/);
    const driveStorageKeys = [
      ...driveAdapterSource.matchAll(/sessionStorage\.\w+\(\s*`([^`]+)`/g),
    ].map((match) => match[1]!);
    expect(driveStorageKeys.length).toBeGreaterThan(0);
    for (const key of driveStorageKeys) {
      expect(key).toMatch(/^opengeni:google-drive-oauth-capability:/);
    }

    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      ROTATED_ACCESS_TOKEN,
      ROTATED_REFRESH_TOKEN,
      CLIENT_SECRET,
      PROVIDER_ERROR_DETAIL,
    ]) {
      const exposed = await shared.admin<{ sink: string }[]>`
        select sink from (
          select 'connections'::text as sink, to_jsonb(value)::text as body from connections value
          union all select 'oauth_state', to_jsonb(value)::text from integration_oauth_state_nonces value
          union all select 'session_events', to_jsonb(value)::text from session_events value
          union all select 'session_history', to_jsonb(value)::text from session_history_items value
          union all select 'sandbox_inputs', to_jsonb(value)::text from sandbox_session_envelopes value
          union all select 'source_metadata', to_jsonb(value)::text from knowledge_memories value
          union all select 'audits', to_jsonb(value)::text from audit_events value
          union all select 'webhooks', to_jsonb(value)::text from stripe_webhook_events value
          union all select 'host_exports', to_jsonb(value)::text from host_export_outbox value
        ) sinks where body like ${`%${secret}%`}`;
      expect([...exposed]).toEqual([]);
    }
  });
});
