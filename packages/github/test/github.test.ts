import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildGitHubAppManifest,
  createGitHubAppInstallationTokenWithExpiry,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  githubAppBotIdentity,
  githubOAuthAuthorizeUrl,
  normalizeGitHubAppPrivateKey,
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

    const hosted = buildGitHubAppManifest({
      appName: "Hosted",
      baseUrl: "https://agents.example.com",
      public: false,
      includeCiPermissions: true,
    });
    expect(hosted.hook_attributes).toBeUndefined();
    expect(hosted.default_events).toBeUndefined();
    expect(hosted.request_oauth_on_install).toBe(true);
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
});
