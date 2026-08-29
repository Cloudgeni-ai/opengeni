import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildGitHubAppManifest,
  authorizeGitHubAppUser,
  authorizeGitHubInstallationBinding,
  createGitHubAppInstallationRepositoryLookup,
  createGitHubAppInstallationTokenWithExpiry,
  createGitHubAppInstallationTokenWithSigningSettings,
  createSignedState,
  discoverGitHubInstallationBindingCandidates,
  envLinesFromGitHubManifestConversion,
  githubAppBotIdentity,
  githubAppBotIdentityWarnings,
  GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING,
  githubOAuthAuthorizeUrl,
  normalizeGitHubAppPrivateKey,
  openPersonalGitHubGitBrokerClaims,
  personalGitHubGitBrokerRouteId,
  prReviewGitHubAppMissingSettings,
  sealPersonalGitHubGitBrokerClaims,
  settingsForPrReviewGitHubApp,
  verifySignedState,
} from "../src";

const pkcs8PrivateKeyHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;
const pkcs8PrivateKeyFooter = `-----END ${"PRIVATE KEY"}-----`;

describe("GitHub app manifest helpers", () => {
  test("signs and verifies bounded state", () => {
    const state = createSignedState("secret", 1000);
    expect(verifySignedState(state, "secret", 1100)).toBe(true);
    expect(verifySignedState(state, "other", 1100)).toBe(false);
    expect(verifySignedState(state, "secret", 5000)).toBe(false);
  });

  test("omits webhooks until a signed GitHub webhook receiver is shipped", () => {
    const local = buildGitHubAppManifest({
      appName: "Local",
      baseUrl: "http://127.0.0.1:8000",
      public: false,
      includeCiPermissions: true,
    });
    expect(local.hook_attributes).toBeUndefined();
    expect(local.request_oauth_on_install).toBe(true);
    expect(local.default_permissions).toMatchObject({ members: "read" });
    expect(local.callback_urls).toEqual(["http://127.0.0.1:8000/v1/github/oauth/callback"]);

    const hosted = buildGitHubAppManifest({
      appName: "Hosted",
      baseUrl: "https://agents.example.com",
      public: false,
      includeCiPermissions: true,
    });
    expect(hosted.hook_attributes).toBeUndefined();
    expect(hosted.default_events).toBeUndefined();
    expect(hosted.request_oauth_on_install).toBe(true);
    expect(hosted.callback_urls).toEqual(["https://agents.example.com/v1/github/oauth/callback"]);

    const setupCallback = buildGitHubAppManifest({
      appName: "Hosted setup",
      baseUrl: "https://agents.example.com",
      public: false,
      includeCiPermissions: true,
      setupUrl: "https://agents.example.com/v1/github/setup",
    });
    expect(setupCallback.request_oauth_on_install).toBe(false);
    expect(setupCallback.setup_on_update).toBe(true);
  });

  test("renders env lines with escaped private key", () => {
    const lines = envLinesFromGitHubManifestConversion({
      id: 1,
      client_id: "client",
      client_secret: "secret",
      slug: "opengeni",
      webhook_secret: "hook",
      pem: "-----BEGIN-----\nkey\n-----END-----\n",
    });
    expect(lines).toContain("OPENGENI_GITHUB_APP_ID=1");
    expect(lines.at(-1)).toContain("\\n");
  });

  test("builds GitHub OAuth authorization URLs for installation binding", () => {
    const url = new URL(
      githubOAuthAuthorizeUrl({
        clientId: "client-id",
        state: "signed-state",
        redirectUri: "https://staging.app.opengeni.ai/v1/github/oauth/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://staging.app.opengeni.ai/v1/github/oauth/callback",
    );
  });

  test("discovers existing installations with the user's repository permission bits", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "github-user-token" });
      }
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return Response.json({
          installations: [
            {
              id: 42,
              account: { id: 7, login: "acme", type: "Organization" },
              suspended_at: null,
            },
          ],
        });
      }
      if (url.startsWith("https://api.github.com/user/installations/42/repositories?")) {
        return Response.json({
          repositories: [
            {
              id: 1001,
              full_name: "acme/admin-repo",
              name: "admin-repo",
              private: true,
              html_url: "https://github.com/acme/admin-repo",
              clone_url: "https://github.com/acme/admin-repo.git",
              default_branch: "main",
              permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
            },
            {
              id: 1002,
              full_name: "acme/read-repo",
              name: "read-repo",
              private: true,
              html_url: "https://github.com/acme/read-repo",
              clone_url: "https://github.com/acme/read-repo.git",
              default_branch: "main",
              permissions: {
                admin: false,
                maintain: false,
                push: false,
                triage: false,
                pull: true,
              },
            },
          ],
        });
      }
      return new Response("unexpected GitHub request", { status: 500 });
    }) as typeof fetch;
    try {
      const installations = await authorizeGitHubAppUser(
        {
          githubClientId: "client-id",
          githubClientSecret: "client-secret",
        } as any,
        { code: "oauth-code" },
      );
      expect(installations).toHaveLength(1);
      expect(installations[0]).toMatchObject({
        installationId: 42,
        accountLogin: "acme",
        suspended: false,
      });
      expect(
        installations[0]?.repositories.map((repository) => ({
          id: repository.id,
          admin: repository.permissions.admin,
        })),
      ).toEqual([
        { id: 1001, admin: true },
        { id: 1002, admin: false },
      ]);
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("derives GitHub App bot identity for git commits", () => {
    const identity = githubAppBotIdentity({
      githubAppId: "12345",
      githubAppSlug: "opengeni",
    } as any);
    expect(identity).toEqual({
      name: "opengeni[bot]",
      email: "12345+opengeni[bot]@users.noreply.github.com",
    });
  });

  test("warns only when a configured workspace App cannot supply stable git identity", () => {
    expect(githubAppBotIdentityWarnings({} as any)).toEqual([]);
    expect(
      githubAppBotIdentityWarnings({
        githubClientId: "configured-client",
      } as any),
    ).toEqual([GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING]);
    expect(
      githubAppBotIdentityWarnings({
        githubClientId: "configured-client",
        githubAppId: "12345",
        githubAppSlug: "opengeni",
      } as any),
    ).toEqual([]);
    expect(
      githubAppBotIdentityWarnings({
        githubClientId: "configured-client",
        gitAuthorName: "OpenGeni",
        gitAuthorEmail: "bot@opengeni.dev",
      } as any),
    ).toEqual([]);
    expect(
      githubAppBotIdentityWarnings({
        githubClientId: "configured-client",
        gitAuthorName: "OpenGeni",
      } as any),
    ).toEqual([GITHUB_APP_BOT_IDENTITY_UNAVAILABLE_WARNING]);
  });

  test("proves exact personal-account ownership with a fresh GitHub user authorization", async () => {
    await withAuthorityGitHub(
      { accountType: "User", accountId: 501, actorId: 501 },
      async (requests) => {
        const proof = await authorizeGitHubInstallationBinding(authoritySettings(), {
          code: "fresh-code",
          installationId: 42,
        });
        expect(proof).toMatchObject({
          actorId: 501,
          actorLogin: "actor",
          authorityKind: "personal_owner",
          installation: { installationId: 42, accountId: 501, suspended: false },
        });
        expect(proof.repositories.map((repository) => repository.id)).toEqual([1001]);
        expect(requests.filter((url) => url.includes("/user/memberships/orgs/"))).toEqual([]);
      },
    );
  });

  test("discovers only existing installations with exact owner authority", async () => {
    await withAuthorityGitHub(
      { accountType: "Organization", membershipRole: "admin", membershipState: "active" },
      async (requests) => {
        const candidates = await discoverGitHubInstallationBindingCandidates(authoritySettings(), {
          code: "fresh-code",
        });
        expect(candidates).toEqual([
          {
            authorityKind: "organization_owner",
            installation: {
              installationId: 42,
              accountId: 700,
              accountLogin: "acme",
              accountType: "Organization",
              suspended: false,
            },
          },
        ]);
        expect(
          requests.filter((url) => url === "https://api.github.com/user/memberships/orgs/acme"),
        ).toHaveLength(1);
        expect(requests.some((url) => url.includes("/access_tokens"))).toBe(false);
      },
    );
  });

  test("does not treat repository visibility as organization ownership", async () => {
    await withAuthorityGitHub(
      { accountType: "Organization", membershipRole: "member", membershipState: "active" },
      async () => {
        expect(
          await discoverGitHubInstallationBindingCandidates(authoritySettings(), {
            code: "fresh-code",
          }),
        ).toEqual([]);
      },
    );
  });

  test("keeps hidden organization membership out of discovery without granting authority", async () => {
    await withAuthorityGitHub({ accountType: "Organization", membershipStatus: 403 }, async () => {
      expect(
        await discoverGitHubInstallationBindingCandidates(authoritySettings(), {
          code: "fresh-code",
        }),
      ).toEqual([]);
    });
  });

  test("proves active organization ownership where GitHub exposes membership authority", async () => {
    await withAuthorityGitHub(
      { accountType: "Organization", membershipRole: "admin", membershipState: "active" },
      async (requests) => {
        const proof = await authorizeGitHubInstallationBinding(authoritySettings(), {
          code: "fresh-code",
          installationId: 42,
        });
        expect(proof.authorityKind).toBe("organization_owner");
        const membershipUrl = "https://api.github.com/user/memberships/orgs/acme";
        expect(requests.filter((url) => url === membershipUrl)).toHaveLength(2);
        expect(requests.lastIndexOf(membershipUrl)).toBeGreaterThan(
          requests.findIndex((url) =>
            url.startsWith("https://api.github.com/installation/repositories?"),
          ),
        );
      },
    );
  });

  test.each([
    [
      "revoked",
      [
        { role: "admin", state: "active" },
        { role: "member", state: "active" },
      ],
      "authority_denied",
    ],
    ["unavailable", [{ role: "admin", state: "active" }, { status: 403 }], "authority_unavailable"],
  ] as const)(
    "fails closed when organization-owner authority becomes %s before commit",
    async (_label, membershipChecks, reason) => {
      await withAuthorityGitHub(
        { accountType: "Organization", membershipChecks: [...membershipChecks] },
        async () => {
          await expect(
            authorizeGitHubInstallationBinding(authoritySettings(), {
              code: "fresh-code",
              installationId: 42,
            }),
          ).rejects.toMatchObject({ reason });
        },
      );
    },
  );

  test.each([
    ["non-owner repository administrator", "member", "active"],
    ["ordinary collaborator", "member", "active"],
    ["GitHub App Manager without organization ownership", "member", "active"],
    ["stale organization owner", "admin", "pending"],
  ])(
    "denies %s without inferring authority from repository access",
    async (_label, role, state) => {
      await withAuthorityGitHub(
        { accountType: "Organization", membershipRole: role, membershipState: state },
        async () => {
          await expect(
            authorizeGitHubInstallationBinding(authoritySettings(), {
              code: "fresh-code",
              installationId: 42,
            }),
          ).rejects.toMatchObject({ reason: "authority_denied" });
        },
      );
    },
  );

  test("fails closed when GitHub policy or token permissions hide owner membership", async () => {
    await withAuthorityGitHub({ accountType: "Organization", membershipStatus: 403 }, async () => {
      await expect(
        authorizeGitHubInstallationBinding(authoritySettings(), {
          code: "fresh-code",
          installationId: 42,
        }),
      ).rejects.toMatchObject({ reason: "authority_unavailable", status: 403 });
    });
  });

  test.each([
    ["suspended", { suspended: true }, "installation_suspended"],
    ["deleted", { deleted: true }, "installation_missing"],
    ["empty", { repositories: [] }, "repository_access_empty"],
  ])("fails closed for %s installations", async (_label, patch, reason) => {
    await withAuthorityGitHub(patch, async () => {
      await expect(
        authorizeGitHubInstallationBinding(authoritySettings(), {
          code: "fresh-code",
          installationId: 42,
        }),
      ).rejects.toMatchObject({ reason });
    });
  });

  test("normalizes GitHub App RSA private keys to PKCS#8 for JWT signing", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const normalized = normalizeGitHubAppPrivateKey(pkcs1.replace(/\n/g, "\\n"));
    expect(normalized).toStartWith(pkcs8PrivateKeyHeader);
    expect(normalized).toContain(pkcs8PrivateKeyFooter);
  });

  test("returns GitHub's installation-token expiry for host-managed renewal", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token: "ghs_test", expires_at: "2026-07-14T11:00:00Z" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await createGitHubAppInstallationTokenWithExpiry(
        {
          githubAppId: "12345",
          githubClientId: "client",
          githubClientSecret: "secret",
          githubAppSlug: "opengeni",
          githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        } as any,
        { installationId: 123, repositoryIds: [456] },
      );
      expect(result).toEqual({ token: "ghs_test", expiresAt: "2026-07-14T11:00:00Z" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps platform-App configuration strict while allowing a separate signing-only App", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingSettings = {
      githubAppId: "98765",
      githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
    await expect(
      createGitHubAppInstallationTokenWithExpiry(signingSettings as any, {
        installationId: 123,
        repositoryIds: [456],
      }),
    ).rejects.toMatchObject({
      missing: expect.arrayContaining([
        "OPENGENI_GITHUB_CLIENT_ID",
        "OPENGENI_GITHUB_CLIENT_SECRET",
        "OPENGENI_GITHUB_APP_SLUG",
      ]),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(
        { token: "ghs_prReview", expires_at: "2026-07-14T11:00:00Z" },
        { status: 201 },
      )) as typeof fetch;
    try {
      await expect(
        createGitHubAppInstallationTokenWithSigningSettings(signingSettings, {
          installationId: 123,
          repositoryIds: [456],
        }),
      ).resolves.toEqual({ token: "ghs_prReview", expiresAt: "2026-07-14T11:00:00Z" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps OpenGeni Lens identity separate and narrows its installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const settings = {
      ...authoritySettings(),
      githubAppManifestStateSecret: "durable-state-secret",
      environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
      prReviewGithubAppId: "98765",
      prReviewGithubClientId: "lens-client",
      prReviewGithubClientSecret: "lens-secret",
      prReviewGithubAppSlug: "opengeni-lens",
      prReviewGithubWebhookSecret: "lens-webhook-secret",
      prReviewGithubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    } as any;
    expect(prReviewGitHubAppMissingSettings(settings)).toEqual([]);
    expect(settingsForPrReviewGitHubApp(settings)).toMatchObject({
      githubAppId: "98765",
      githubClientId: "lens-client",
      githubAppSlug: "opengeni-lens",
    });

    let tokenRequest: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      tokenRequest = JSON.parse(String(init?.body));
      return Response.json(
        { token: "ghs_lens", expires_at: "2026-08-26T12:00:00Z" },
        { status: 201 },
      );
    }) as typeof fetch;
    try {
      await createGitHubAppInstallationTokenWithSigningSettings(
        {
          githubAppId: settings.prReviewGithubAppId,
          githubAppPrivateKey: settings.prReviewGithubAppPrivateKey,
        },
        {
          installationId: 123,
          repositoryIds: [456],
          permissions: { contents: "read", pull_requests: "write" },
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(tokenRequest).toEqual({
      repository_ids: [456],
      permissions: { contents: "read", pull_requests: "write" },
    });
  });

  test("refuses every unscoped or ambiguous exported installation-token mint", async () => {
    await expect(
      createGitHubAppInstallationTokenWithExpiry(authoritySettings(), {
        installationId: 123,
      } as { installationId: number; repositoryIds: number[] }),
    ).rejects.toThrow("explicit, unique repository allowlist");
    for (const repositoryIds of [[], [456, 456], [0], [Number.MAX_SAFE_INTEGER + 1]]) {
      await expect(
        createGitHubAppInstallationTokenWithExpiry(authoritySettings(), {
          installationId: 123,
          repositoryIds,
        }),
      ).rejects.toThrow("explicit, unique repository allowlist");
    }
  });
});

describe("personal GitHub Git broker bearer", () => {
  const baseClaims = () => {
    const authority = {
      version: 1 as const,
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "root-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      executionGeneration: 2,
      originWorkspaceId: "origin-workspace-1",
      connectionId: "connection-1",
      connectionAuthorityGeneration: 3,
      ownerSubjectId: "subject-1",
      credentialBindingId: "binding-1",
      selectionGeneration: 4,
    };
    const repository = {
      repositoryId: "1234",
      fullName: "open-geni/private-repo",
      canonicalUrl: "https://github.com/open-geni/private-repo",
      ref: "main",
      access: "write" as const,
      selectionGeneration: 4,
    };
    const claims = {
      ...authority,
      nonce: "renewal-nonce-a",
      issuedAt: 1_000,
      expiresAt: 1_300,
    };
    return {
      claims,
      routeId: personalGitHubGitBrokerRouteId("broker-secret", {
        ...authority,
        repository,
      }),
    };
  };

  test("encrypts exact authority and rejects tampering, wrong secrets, and expiry", () => {
    const { claims } = baseClaims();
    const token = sealPersonalGitHubGitBrokerClaims("broker-secret", claims);
    expect(token).not.toContain(claims.connectionId);
    expect(token.length).toBeLessThan(2_048);
    expect(openPersonalGitHubGitBrokerClaims("broker-secret", token, 1_001)).toEqual(claims);
    expect(openPersonalGitHubGitBrokerClaims("wrong-secret", token, 1_001)).toBeNull();
    expect(openPersonalGitHubGitBrokerClaims("broker-secret", `${token}x`, 1_001)).toBeNull();
    expect(openPersonalGitHubGitBrokerClaims("broker-secret", token, 1_300)).toBeNull();
  });

  test("keeps broker routes stable across bearer renewal and fences authority changes", () => {
    const first = baseClaims();
    const renewed = {
      claims: { ...first.claims, nonce: "renewal-nonce-b", issuedAt: 1_100, expiresAt: 1_400 },
      routeId: first.routeId,
    };
    expect(renewed.routeId).toBe(first.routeId);
    const changedAttemptRoute = personalGitHubGitBrokerRouteId("broker-secret", {
      ...first.claims,
      attemptId: "attempt-2",
      repository: {
        repositoryId: "1234",
        fullName: "open-geni/private-repo",
        canonicalUrl: "https://github.com/open-geni/private-repo",
        ref: "main",
        access: "write",
        selectionGeneration: 4,
      },
    });
    expect(changedAttemptRoute).not.toBe(first.routeId);
  });
});

function authoritySettings() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    githubAppId: "12345",
    githubClientId: "client-id",
    githubClientSecret: "client-secret",
    githubAppSlug: "opengeni",
    githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  } as any;
}

async function withAuthorityGitHub(
  input: {
    accountType?: "User" | "Organization";
    accountId?: number;
    actorId?: number;
    membershipRole?: string;
    membershipState?: string;
    membershipStatus?: number;
    membershipChecks?: Array<{ role?: string; state?: string; status?: number }>;
    suspended?: boolean;
    deleted?: boolean;
    repositories?: Array<Record<string, unknown>>;
  },
  run: (requests: string[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let membershipCheck = 0;
  const accountId = input.accountId ?? 700;
  const accountType = input.accountType ?? "Organization";
  const account = { id: accountId, login: "acme", type: accountType };
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    requests.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "user-access" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: input.actorId ?? 900, login: "actor" });
    }
    if (url.startsWith("https://api.github.com/user/installations?")) {
      return Response.json({
        installations: [{ id: 42, account, suspended_at: input.suspended ? "now" : null }],
      });
    }
    if (url.startsWith("https://api.github.com/app/installations?")) {
      return Response.json(
        input.deleted ? [] : [{ id: 42, account, suspended_at: input.suspended ? "now" : null }],
      );
    }
    if (url === "https://api.github.com/user/memberships/orgs/acme") {
      const current = input.membershipChecks?.[membershipCheck++];
      const status = current?.status ?? input.membershipStatus;
      if (status) {
        return Response.json({ message: "membership unavailable" }, { status });
      }
      return Response.json({
        role: current?.role ?? input.membershipRole ?? "admin",
        state: current?.state ?? input.membershipState ?? "active",
        organization: { id: accountId, login: "acme" },
      });
    }
    if (url === "https://api.github.com/app/installations/42/access_tokens") {
      return Response.json({ token: "installation-access", expires_at: "2026-07-28T10:00:00Z" });
    }
    if (url.startsWith("https://api.github.com/installation/repositories?")) {
      return Response.json({
        repositories: input.repositories ?? [
          { id: 1001, full_name: "acme/repo", name: "repo", default_branch: "main" },
        ],
      });
    }
    return Response.json({ message: `unexpected request ${url}` }, { status: 500 });
  }) as typeof fetch;
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("GitHub App installation repository lookup", () => {
  const signingSettings = () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
      githubAppId: "12345",
      githubClientId: "client",
      githubClientSecret: "secret",
      githubAppSlug: "opengeni",
      githubAppPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    } as any;
  };

  test("mints one server-side installation token per installation and resolves repositories by name", async () => {
    const requests: Array<{
      method: string;
      url: string;
      authorization: string | null;
      body: string | null;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      requests.push({
        method: init?.method ?? "GET",
        url,
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return Response.json(
          { token: "ghs_lookup", expires_at: "2026-07-14T11:00:00Z" },
          { status: 201 },
        );
      }
      if (url.endsWith("/repos/acme/app")) {
        return Response.json({
          id: 456,
          full_name: "acme/app",
          name: "app",
          private: false,
          html_url: "https://github.com/acme/app",
          clone_url: "https://github.com/acme/app.git",
          default_branch: "main",
          owner: { login: "acme", type: "Organization" },
        });
      }
      if (url.endsWith("/repos/acme/missing")) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      return Response.json({ message: "Forbidden" }, { status: 403 });
    }) as typeof fetch;
    try {
      const lookup = createGitHubAppInstallationRepositoryLookup(signingSettings());
      await expect(
        lookup({ installationId: 123, owner: "acme", name: "app" }),
      ).resolves.toMatchObject({ id: 456, installationId: 123, fullName: "acme/app" });
      await expect(
        lookup({ installationId: 123, owner: "acme", name: "missing" }),
      ).resolves.toBeNull();
      await expect(
        lookup({ installationId: 123, owner: "acme", name: "forbidden" }),
      ).rejects.toThrow("GitHub API 403");
      // Path-shaped names never reach GitHub.
      await expect(
        lookup({ installationId: 123, owner: "acme", name: "../app" }),
      ).resolves.toBeNull();
      const mints = requests.filter((request) => request.method === "POST");
      expect(mints).toHaveLength(1);
      // The lookup token is metadata-read only and never repository-scoped; it
      // exists to read one repository id and is never sent to a sandbox.
      expect(JSON.parse(mints[0]!.body ?? "{}")).toEqual({ permissions: { metadata: "read" } });
      expect(
        requests
          .filter((request) => request.method === "GET")
          .map((request) => request.authorization),
      ).toEqual(["Bearer ghs_lookup", "Bearer ghs_lookup", "Bearer ghs_lookup"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refuses to build a lookup without GitHub App credentials", () => {
    expect(() => createGitHubAppInstallationRepositoryLookup({ githubAppId: "1" } as any)).toThrow(
      "GitHub App is not configured",
    );
  });
});
