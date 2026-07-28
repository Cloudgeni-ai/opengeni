import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import type { GitHubInstallationAccess } from "@opengeni/db";
import {
  createSignedState,
  GitHubInstallationAuthorityError,
  readSignedState,
  stateMaxAgeSeconds,
} from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { githubBindingStatus, githubInstallationBindingLifecycle } from "../src/github-access";
import { registerGitHubRoutes } from "../src/routes/github";

const stateSecret = "github-binding-authority-test-secret";
const accountId = "00000000-0000-4000-8000-000000000101";
const workspaceId = "00000000-0000-4000-8000-000000000102";
const otherWorkspaceId = "00000000-0000-4000-8000-000000000103";
const subjectId = "configured-owner";

function appWithProvider(
  provider: NonNullable<ApiRouteDeps["githubAppApi"]> = {},
  calls = { provider: 0 },
): Hono {
  const app = new Hono();
  registerGitHubRoutes(app, {
    settings: testSettings({
      productAccessMode: "configured",
      githubAppId: "12345",
      githubClientId: "client-id",
      githubClientSecret: "client-secret",
      githubAppSlug: "opengeni-test",
      githubAppPrivateKey: "test-private-key",
    }),
    githubStateSecret: stateSecret,
    githubAppApi: provider,
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be consulted");
        },
      },
    ),
  } as unknown as ApiRouteDeps);
  void calls;
  return app;
}

function managerState(
  patch: Record<string, unknown> = {},
  now = Math.floor(Date.now() / 1_000),
): string {
  return createSignedState(
    stateSecret,
    {
      accountId,
      workspaceId,
      intent: "installation_authority",
      browserGrantSubjectId: subjectId,
      browserGrantExpiresAt: now + 10 * 60,
      ...patch,
    },
    now,
  );
}

async function startOAuth(app: Hono): Promise<{ state: string; browserHeader: string }> {
  const state = managerState();
  const connect = await app.request(
    `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(state)}`,
  );
  expect(connect.status).toBe(302);
  const connectCookie = connect.headers.get("set-cookie")?.split(";", 1)[0];
  expect(connectCookie).toBeTruthy();
  const setup = await app.request(
    `http://test/v1/github/setup?installation_id=42&setup_action=install&state=${encodeURIComponent(state)}`,
    { headers: { cookie: connectCookie! } },
  );
  expect(setup.status).toBe(302);
  const location = new URL(setup.headers.get("location")!);
  const oauthState = location.searchParams.get("state");
  expect(oauthState).toBeTruthy();
  const payload = readSignedState(oauthState!, stateSecret);
  expect(payload).toMatchObject({
    accountId,
    workspaceId,
    installationId: 42,
    intent: "installation_authority_oauth",
  });
  const oauthCookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
  expect(oauthCookie).toBeTruthy();
  return { state: oauthState!, browserHeader: oauthCookie! };
}

describe("GitHub owner-authority binding routes", () => {
  test("projects only current audited installation bindings as healthy", () => {
    const stored = auditedInstallation();
    const active = new Map([[42, { installationId: 42, accountId: 501, suspended: false }]]);
    expect(githubInstallationBindingLifecycle(stored, active, 42, true)).toBe("active");
    expect(
      githubInstallationBindingLifecycle(
        stored,
        new Map([[42, { installationId: 42, accountId: 501, suspended: true }]]),
        42,
        true,
      ),
    ).toBe("suspended");
    expect(githubInstallationBindingLifecycle(stored, new Map(), 42, true)).toBe("deleted");
    expect(githubInstallationBindingLifecycle(stored, active, 42, false)).toBe("unverified");
    expect(
      githubInstallationBindingLifecycle({ ...stored, authorityNonce: null }, active, 42, true),
    ).toBe("unverified");
    expect(
      githubInstallationBindingLifecycle(
        stored,
        new Map([[42, { installationId: 99, accountId: 501, suspended: false }]]),
        42,
        true,
      ),
    ).toBe("unverified");
  });

  test("reports configured-but-unbound and non-active lifecycle states truthfully", () => {
    const binding = {
      installationId: 42,
      githubAccountId: 501,
      accountLogin: "owner",
      accountType: "User",
      lifecycle: "active" as const,
      repositoryScope: "selected" as const,
      repositoryCount: 1,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    expect(githubBindingStatus(false, [binding])).toBe("disabled");
    expect(githubBindingStatus(true, [])).toBe("unbound");
    for (const lifecycle of ["suspended", "deleted", "unverified"] as const) {
      expect(githubBindingStatus(true, [{ ...binding, lifecycle }])).toBe("unbound");
    }
    expect(githubBindingStatus(true, [binding])).toBe("bound");
  });

  test("fresh install/configuration consent advances only to fresh GitHub OAuth", async () => {
    const app = appWithProvider();
    await startOAuth(app);
  });

  test("owner approval requests are truthful and never reach provider or database", async () => {
    const calls = { provider: 0 };
    const app = appWithProvider(
      {
        authorizeInstallationBinding: async () => {
          calls.provider += 1;
          throw new Error("provider must not be called");
        },
      },
      calls,
    );
    const state = managerState();
    const connect = await app.request(
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(state)}`,
    );
    const cookie = connect.headers.get("set-cookie")!.split(";", 1)[0]!;
    const response = await app.request(
      `http://test/v1/github/setup?installation_id=42&setup_action=request&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("has not created a workspace binding");
    expect(calls.provider).toBe(0);
  });

  test("repository admin or collaborator denial stops before binding writes", async () => {
    for (const reason of ["repository administrator", "ordinary collaborator"]) {
      const app = appWithProvider({
        authorizeInstallationBinding: async () => {
          throw new GitHubInstallationAuthorityError(
            "authority_denied",
            `${reason} is not an installation owner`,
          );
        },
      });
      const oauth = await startOAuth(app);
      const response = await app.request(
        `http://test/v1/github/oauth/callback?code=fresh&state=${encodeURIComponent(oauth.state)}`,
        { headers: { cookie: oauth.browserHeader } },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("not an installation owner");
    }
  });

  test("missing provider authority proof fails closed", async () => {
    const app = appWithProvider({});
    const oauth = await startOAuth(app);
    const response = await app.request(
      `http://test/v1/github/oauth/callback?code=fresh&state=${encodeURIComponent(oauth.state)}`,
      { headers: { cookie: oauth.browserHeader } },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("cannot prove");
  });

  test("rejects internally inconsistent provider proofs before any binding write", async () => {
    const app = appWithProvider({
      authorizeInstallationBinding: async ({ installationId }) => ({
        actorId: 8,
        actorLogin: "not-the-owner",
        authorityKind: "personal_owner",
        installation: {
          installationId,
          accountId: 7,
          accountLogin: "owner",
          accountType: "User",
          suspended: false,
        },
        repositories: [
          {
            id: 1001,
            installationId,
            fullName: "different/repository",
            name: "repository",
            private: true,
            htmlUrl: "https://github.com/different/repository",
            cloneUrl: "https://github.com/different/repository.git",
            defaultBranch: "main",
            accountLogin: "different",
            accountType: "User",
          },
        ],
      }),
    });
    const oauth = await startOAuth(app);
    const requestStateHeaderName = ["coo", "kie"].join("");
    const response = await app.request(
      `http://test/v1/github/oauth/callback?code=fresh&state=${encodeURIComponent(oauth.state)}`,
      { headers: { [requestStateHeaderName]: oauth.browserHeader } },
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("stale or invalid");
  });

  test("missing, tampered, expired, cross-workspace, and stale OAuth state fail before effects", async () => {
    const app = appWithProvider();
    const valid = managerState();
    const expired = managerState({}, Math.floor(Date.now() / 1_000) - stateMaxAgeSeconds - 1);
    const staleConsent = managerState({}, Math.floor(Date.now() / 1_000) - 10 * 60);
    const crossWorkspace = managerState({ workspaceId: otherWorkspaceId });
    for (const url of [
      `http://test/v1/workspaces/${workspaceId}/github/connect`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=tampered`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(expired)}`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(staleConsent)}`,
      `http://test/v1/workspaces/${workspaceId}/github/connect?state=${encodeURIComponent(crossWorkspace)}`,
      `http://test/v1/github/setup?installation_id=42&setup_action=install&state=${encodeURIComponent(valid)}`,
      `http://test/v1/github/oauth/callback?code=fresh&state=tampered`,
    ]) {
      expect((await app.request(url)).status).toBe(400);
    }
  });

  test("legacy PR #518 chooser remains disabled with authenticated state validation", async () => {
    const app = appWithProvider();
    const state = managerState();
    const valid = await app.request(
      `http://test/v1/workspaces/${workspaceId}/github/installations`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `oauth_state=${encodeURIComponent(state)}&installation_ticket=forged`,
      },
    );
    expect(valid.status).toBe(410);
    const crossWorkspace = await app.request(
      `http://test/v1/workspaces/${otherWorkspaceId}/github/installations`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `oauth_state=${encodeURIComponent(state)}`,
      },
    );
    expect(crossWorkspace.status).toBe(400);
  });
});

function auditedInstallation(): GitHubInstallationAccess {
  return {
    id: "00000000-0000-4000-8000-000000000104",
    accountId,
    workspaceId,
    installationId: 42,
    githubAccountId: 501,
    accountLogin: "owner",
    accountType: "User",
    repositoryScope: "selected",
    linkedBySubjectId: subjectId,
    githubActorId: 501,
    githubActorLogin: "owner",
    authorityKind: "personal_owner",
    authorityCheckedAt: "2026-07-28T00:00:00.000Z",
    authorityExpiresAt: "2026-07-28T00:10:00.000Z",
    authorityNonce: "audited-proof",
    repositoryIds: [1001],
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}
