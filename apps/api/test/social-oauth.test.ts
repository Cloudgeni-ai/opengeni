import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import { testSettings } from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../src/http/api-error";
import {
  parseSocialCredentialBundle,
  SocialTokenRequestError,
  socialTokenNeedsRefresh,
  startSocialOAuth,
  type SocialCredentialBundle,
} from "../src/integrations/social-oauth";

const STATE_SECRET = "social-oauth-test-state-secret";

function settingsWithClients(clients: Record<string, unknown>): Settings {
  return testSettings({
    integrationsStateSecret: STATE_SECRET,
    environmentsEncryptionKey: randomBytes(32).toString("base64"),
    publicBaseUrl: "https://api.opengeni.test",
    socialOauthClientsJson: JSON.stringify(clients),
  }) as Settings;
}

// startSocialOAuth never touches the database; the deps type just carries it.
const noDb = null as unknown as Database;

const startContext = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "dev",
  requestUrl: "https://api.opengeni.test/v1/workspaces/x/social/oauth/start",
};

describe("startSocialOAuth", () => {
  test("x: builds a PKCE S256 authorization URL with default scopes", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client", clientSecret: "s" } });
    const result = await startSocialOAuth(
      { db: noDb, settings },
      { ...startContext, payload: { provider: "x" } },
    );
    const url = new URL(result.authorizationUrl!);
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("x-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.opengeni.test/v1/social/oauth/callback",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read offline.access");
  });

  test("reddit: requests a permanent grant and skips PKCE", async () => {
    const settings = settingsWithClients({ reddit: { clientId: "r-client" } });
    const result = await startSocialOAuth(
      { db: noDb, settings },
      { ...startContext, payload: { provider: "reddit" } },
    );
    const url = new URL(result.authorizationUrl!);
    expect(url.origin + url.pathname).toBe("https://www.reddit.com/api/v1/authorize");
    expect(url.searchParams.get("duration")).toBe("permanent");
    expect(url.searchParams.get("code_challenge")).toBeNull();
    expect(url.searchParams.get("scope")).toBe("identity read submit privatemessages history");
  });

  test("state is signed, typed, and carries the workspace binding", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client" } });
    const result = await startSocialOAuth(
      { db: noDb, settings },
      { ...startContext, payload: { provider: "x", returnPath: "/social?tab=x" } },
    );
    const payload = readSignedState(result.state, STATE_SECRET) as Record<string, unknown>;
    expect(payload.kind).toBe("social_oauth");
    expect(payload.workspaceId).toBe(startContext.workspaceId);
    expect(payload.provider).toBe("x");
    expect(payload.returnPath).toBe("/social?tab=x");
    expect(typeof payload.nonce).toBe("string");
    // The PKCE verifier must never travel in cleartext state.
    expect(String(payload.encryptedPkceVerifier)).toStartWith("v1:");
  });

  test("caller-provided scopes replace defaults", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client" } });
    const result = await startSocialOAuth(
      { db: noDb, settings },
      { ...startContext, payload: { provider: "x", scopes: ["tweet.read", "users.read"] } },
    );
    expect(new URL(result.authorizationUrl!).searchParams.get("scope")).toBe(
      "tweet.read users.read",
    );
  });

  test("unconfigured provider returns actionable operator configuration details", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client" } });
    const error = await startSocialOAuth(
      { db: noDb, settings },
      { ...startContext, payload: { provider: "reddit" } },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).toMatchObject({
      status: 503,
      code: "upstream_unavailable",
      retryable: false,
      message:
        "Reddit connection is not configured. An operator must add Reddit OAuth credentials to OPENGENI_SOCIAL_OAUTH_CLIENTS_JSON.",
      details: { oauthReason: "operator_oauth_app_missing", provider: "reddit" },
    });
  });

  test("absolute returnPath is rejected", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client" } });
    await expect(
      startSocialOAuth(
        { db: noDb, settings },
        { ...startContext, payload: { provider: "x", returnPath: "https://evil.example/steal" } },
      ),
    ).rejects.toThrow(HTTPException);
  });

  test("returnPath that normalizes into a protocol-relative URL is rejected", async () => {
    const settings = settingsWithClients({ x: { clientId: "x-client" } });
    // `..` collapses /a, leaving //h//@evil.com — a browser-absolute Location.
    await expect(
      startSocialOAuth(
        { db: noDb, settings },
        { ...startContext, payload: { provider: "x", returnPath: "/a/..//h//@evil.com" } },
      ),
    ).rejects.toThrow(HTTPException);
  });
});

describe("parseSocialCredentialBundle", () => {
  test("round-trips a full bundle", () => {
    const bundle: SocialCredentialBundle = {
      provider: "reddit",
      accessToken: "at",
      refreshToken: "rt",
      tokenType: "bearer",
      expiresAt: "2026-07-27T12:00:00.000Z",
      scope: "identity read",
    };
    expect(parseSocialCredentialBundle(JSON.stringify(bundle))).toEqual(bundle);
  });

  test("rejects unknown providers and missing tokens", () => {
    expect(() => parseSocialCredentialBundle('{"provider":"myspace","accessToken":"a"}')).toThrow(
      "unexpected shape",
    );
    expect(() => parseSocialCredentialBundle('{"provider":"x"}')).toThrow("unexpected shape");
    expect(() => parseSocialCredentialBundle("not json")).toThrow("not valid JSON");
  });
});

describe("SocialTokenRequestError", () => {
  test("400/401 and invalid_grant are definitive; 5xx and network-shaped are not", () => {
    expect(new SocialTokenRequestError("m", 400, null).definitive).toBe(true);
    expect(new SocialTokenRequestError("m", 401, "invalid_client").definitive).toBe(true);
    // Reddit reports invalid_grant with HTTP 200.
    expect(new SocialTokenRequestError("m", null, "invalid_grant").definitive).toBe(true);
    expect(new SocialTokenRequestError("m", 503, null).definitive).toBe(false);
    expect(new SocialTokenRequestError("m", 429, null).definitive).toBe(false);
    expect(new SocialTokenRequestError("m", null, null).definitive).toBe(false);
  });
});

describe("socialTokenNeedsRefresh", () => {
  const base: SocialCredentialBundle = { provider: "x", accessToken: "at", tokenType: "Bearer" };
  const now = new Date("2026-07-27T12:00:00.000Z");

  test("no expiry (Reddit-style long-lived token view) never refreshes", () => {
    expect(socialTokenNeedsRefresh(base, now)).toBe(false);
  });

  test("expiring within the 2-minute skew refreshes", () => {
    expect(socialTokenNeedsRefresh({ ...base, expiresAt: "2026-07-27T12:01:00.000Z" }, now)).toBe(
      true,
    );
    expect(socialTokenNeedsRefresh({ ...base, expiresAt: "2026-07-27T11:00:00.000Z" }, now)).toBe(
      true,
    );
  });

  test("comfortably-valid token does not refresh", () => {
    expect(socialTokenNeedsRefresh({ ...base, expiresAt: "2026-07-27T13:00:00.000Z" }, now)).toBe(
      false,
    );
  });
});
