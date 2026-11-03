import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildConnectionTokenResolver,
  ConnectionRefreshHttpError,
  refreshOAuthConnectionCredential,
  type ConnectionBrokerDeps,
  type ConnectionCredentialForBroker,
} from "../src/connection-token-resolver";

// GitHub's token endpoint answers `application/x-www-form-urlencoded` unless the
// request asks for JSON, and reports a rejected grant as HTTP 200 with an
// `error` field (checked against github.com on 3 November 2026). These fakes
// reproduce that contract instead of always answering JSON.
type GitHubTokenOutcome =
  | { kind: "token" }
  | { kind: "error"; error: string; description?: string };

function fakeGitHubTokenEndpoint(outcome: GitHubTokenOutcome, options?: { alwaysForm?: boolean }) {
  const requests: { accept: string | null; body: URLSearchParams }[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(String(init?.body));
    requests.push({ accept: headers.get("accept"), body });
    const fields: Record<string, string | number> =
      outcome.kind === "token"
        ? {
            access_token: "ghu_refreshed",
            expires_in: 28_800,
            refresh_token: "ghr_rotated",
            refresh_token_expires_in: 15_811_200,
            scope: "repo",
            token_type: "bearer",
          }
        : {
            error: outcome.error,
            error_description: outcome.description ?? "The refresh token passed is incorrect.",
            error_uri: "https://docs.github.com/apps/oauth",
          };
    if (!options?.alwaysForm && headers.get("accept")?.includes("application/json")) {
      return Response.json(fields, { status: 200 });
    }
    return new Response(
      new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString(),
      {
        status: 200,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      },
    );
  }) as unknown as typeof fetch;
  return {
    requests,
    transport: {
      fetchImpl,
      dnsLookup: async () => [{ address: "140.82.121.3", family: 4 as const }],
    },
  };
}

const clientId = "Ov23personal-client";
const settings = {
  ...testSettings({}),
  githubPersonalOauthEnabled: true,
  githubPersonalOauthClientId: clientId,
  githubPersonalOauthClientSecret: "personal-client-secret",
} as Settings;

function personalGitHubCredential(
  overrides: Partial<ConnectionCredentialForBroker> = {},
): ConnectionCredentialForBroker {
  return {
    id: "conn_personal_github",
    accountId: "acct_1",
    workspaceId: "ws_1",
    subjectId: "user:owner",
    providerDomain: "github.com",
    kind: "oauth2",
    status: "active",
    credential: {
      access_token: "ghu_expired",
      refresh_token: "ghr_current",
      token_type: "Bearer",
      token_endpoint: "https://github.com/login/oauth/access_token",
      client_id: clientId,
      token_endpoint_auth_method: "client_secret_post",
      scope_parameter_supported: false,
    },
    grantedScopes: ["repo"],
    expiresAt: new Date(Date.now() - 60_000),
    lastRefreshAt: null,
    version: 3,
    authorityGeneration: 3,
    metadata: {
      credentialRole: "opengeni_github_personal",
      providerFamily: "github",
      providerPrincipalId: "59779138",
      githubUserId: "59779138",
      githubLogin: "octocat",
      oauthEnvironment: settings.environment,
      oauthClientMarker: createHash("sha256").update(clientId).digest("hex").slice(0, 32),
      credentialBindingId: "6acc52e1-2952-4da4-9e0e-f45872f661b2",
      connectedAt: "2026-11-02T09:19:18.000Z",
      lastVerifiedAt: "2026-11-02T09:19:18.000Z",
      disconnectedAt: null,
      refreshTokenExpiresAt: "2027-05-02T09:19:18.000Z",
    },
    ...overrides,
  };
}

const personalRef = {
  connectionId: "conn_personal_github",
  providerDomain: "github.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
  scopes: ["repo"],
};

describe("personal GitHub token refresh against GitHub's response contract", () => {
  test("asks for JSON and stores the rotated token pair", async () => {
    const github = fakeGitHubTokenEndpoint({ kind: "token" });
    const refreshed = await refreshOAuthConnectionCredential(
      personalGitHubCredential(),
      personalRef,
      settings,
      github.transport,
    );

    expect(github.requests).toHaveLength(1);
    expect(github.requests[0]!.accept).toBe("application/json");
    expect(github.requests[0]!.body.get("grant_type")).toBe("refresh_token");
    expect(github.requests[0]!.body.get("refresh_token")).toBe("ghr_current");
    expect(refreshed.credential).toMatchObject({
      access_token: "ghu_refreshed",
      refresh_token: "ghr_rotated",
    });
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test("a grant GitHub rejects with HTTP 200 is a permanent refresh error", async () => {
    const github = fakeGitHubTokenEndpoint({ kind: "error", error: "bad_refresh_token" });
    const error = await refreshOAuthConnectionCredential(
      personalGitHubCredential(),
      personalRef,
      settings,
      github.transport,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionRefreshHttpError);
    expect((error as ConnectionRefreshHttpError).oauthErrorCode).toBe("bad_refresh_token");
    expect((error as ConnectionRefreshHttpError).httpStatus).toBe(400);
    expect((error as Error).message).toBe(
      "connection refresh refused by the provider (bad_refresh_token)",
    );
  });

  test("a form-encoded answer still refreshes when the Accept header is lost", async () => {
    const github = fakeGitHubTokenEndpoint({ kind: "token" }, { alwaysForm: true });
    const refreshed = await refreshOAuthConnectionCredential(
      personalGitHubCredential(),
      personalRef,
      settings,
      github.transport,
    );
    expect(refreshed.credential).toMatchObject({
      access_token: "ghu_refreshed",
      refresh_token: "ghr_rotated",
    });
    expect(refreshed.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 3600 * 1000);
  });

  for (const code of ["slow_down", "temporarily_unavailable", "incorrect_client_credentials"]) {
    test(`${code} in a 200 answer stays transient: reconnecting would not help`, async () => {
      const github = fakeGitHubTokenEndpoint({ kind: "error", error: code });
      const error = await refreshOAuthConnectionCredential(
        personalGitHubCredential(),
        personalRef,
        settings,
        github.transport,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectionRefreshHttpError);
      expect((error as ConnectionRefreshHttpError).httpStatus).toBe(503);
      expect((error as ConnectionRefreshHttpError).oauthErrorCode).toBe(code);
    });
  }

  test("an expired personal GitHub token refreshes through the resolver", async () => {
    const github = fakeGitHubTokenEndpoint({ kind: "token" });
    let stored = personalGitHubCredential();
    const statuses: string[] = [];
    const deps: ConnectionBrokerDeps = {
      withRefreshLock: async (database, _credential, work) => work(database),
      loadCredential: async () => stored,
      recordRefresh: async (_db, input) => {
        stored = {
          ...stored,
          credential: { ...stored.credential, access_token: "ghu_refreshed" },
          expiresAt: input.expiresAt,
          lastRefreshAt: input.lastRefreshAt,
          version: stored.version + 1,
        };
        return true;
      },
      setStatus: async (_db, _workspaceId, status) => {
        statuses.push(status);
        return true;
      },
      recordUsed: async () => undefined,
      refresh: refreshOAuthConnectionCredential,
      encrypt: () => "v1:enc",
      keyBytes: () => new Uint8Array(32),
      now: () => new Date(),
    };
    const resolver = buildConnectionTokenResolver({} as never, settings, deps, {
      refreshTransport: github.transport,
    });

    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "user:owner",
      serverId: "github:personal",
      destinationUrl: "https://api.github.com/user",
      credentialTarget: "http_api",
      connectionRef: personalRef,
    });

    expect(result).toMatchObject({ status: "ok", connectionId: "conn_personal_github" });
    expect(statuses).toEqual([]);
    expect(stored.lastRefreshAt).not.toBeNull();
  });

  test("a rejected refresh marks the connection for reconnecting instead of staying active", async () => {
    const github = fakeGitHubTokenEndpoint({ kind: "error", error: "bad_refresh_token" });
    const transitions: { status: string; lastError: string | null; version: number }[] = [];
    const deps: ConnectionBrokerDeps = {
      withRefreshLock: async (database, _credential, work) => work(database),
      loadCredential: async () => personalGitHubCredential(),
      recordRefresh: async () => true,
      setStatus: async (_db, _workspaceId, status, lastError, guard) => {
        transitions.push({ status, lastError, version: guard.version });
        return true;
      },
      recordUsed: async () => undefined,
      refresh: refreshOAuthConnectionCredential,
      encrypt: () => "v1:enc",
      keyBytes: () => new Uint8Array(32),
      now: () => new Date(),
    };
    const resolver = buildConnectionTokenResolver({} as never, settings, deps, {
      refreshTransport: github.transport,
    });

    const result = await resolver({
      workspaceId: "ws_1",
      subjectId: "user:owner",
      serverId: "github:personal",
      destinationUrl: "https://api.github.com/user",
      credentialTarget: "http_api",
      connectionRef: personalRef,
    });

    expect(result).toMatchObject({ status: "auth_needed", reason: "refresh_failed" });
    expect(transitions).toEqual([
      { status: "needs_reauth", lastError: expect.any(String), version: 3 },
    ]);
  });
});
