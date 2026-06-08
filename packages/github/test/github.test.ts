import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildGitHubAppManifest,
  createSignedState,
  envLinesFromGitHubManifestConversion,
  githubAppBotIdentity,
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
});
