import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import * as network from "@opengeni/network";
import { testSettings } from "@opengeni/testing/settings";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";
import { stableAccountIdentity } from "../src/integrations/oauth-client";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
  googleSubjectFromClaims,
  stableAccountSubjectKeyFor,
} from "../src/integrations/oauth-profiles";

const base = {
  mcpUrl: OFFICIAL_GMAIL_MCP_URL,
  authorizationServerIssuer: "https://accounts.google.com",
  clientId: "client",
};

function login(
  metadata: Record<string, unknown>,
  overrides: Partial<ConnectionMetadata> = {},
): ConnectionMetadata {
  return {
    id: "existing",
    subjectId: "owner",
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status: "needs_reauth",
    grantedScopes: ["read"],
    metadata: { ...base, ...metadata },
    createdAt: "2026-01-01",
    ...overrides,
  } as ConnectionMetadata;
}

function decide(input: {
  stored: ConnectionMetadata;
  signedIn: Record<string, unknown>;
  reconnect?: boolean;
}) {
  return decideOAuthAccountConnection({
    accounts: [input.stored],
    ownerSubjectId: "owner",
    providerDomain: "gmailmcp.googleapis.com",
    mcpUrl: OFFICIAL_GMAIL_MCP_URL,
    metadata: { ...base, ...input.signedIn },
    identityKeys: ["gmailEmail"],
    subjectKey: stableAccountSubjectKeyFor(OFFICIAL_GMAIL_MCP_URL),
    grantedScopes: ["read"],
    ...(input.reconnect === false ? {} : { requestedConnectionId: "existing" }),
  });
}

const renamed = { gmailEmail: "person@new.test", googleSubject: "1001" };
const mismatch = { kind: "reject", reason: "account_mismatch" };

describe("Google logins are identified by Google's account ID", () => {
  test("Gmail, Calendar and Drive record it; other services don't", () => {
    for (const url of [
      OFFICIAL_GMAIL_MCP_URL,
      OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
      OFFICIAL_DRIVE_MCP_URL,
    ])
      expect(stableAccountSubjectKeyFor(url)).toBe("googleSubject");
    expect(stableAccountSubjectKeyFor("https://mcp.notion.com/mcp")).toBeUndefined();
  });

  test("reconnecting an account whose email changed reconnects it", () => {
    const stored = login({ gmailEmail: "person@old.test", googleSubject: "1001" });
    expect(decide({ stored, signedIn: renamed })).toEqual({ kind: "write" });
  });

  test("an email now on another Google account is a different account", () => {
    const stored = login({ gmailEmail: "person@new.test", googleSubject: "2002" });
    expect(decide({ stored, signedIn: renamed })).toEqual(mismatch);
  });

  test("a login saved before the account ID adopts it only when the email matches", () => {
    expect(decide({ stored: login({ gmailEmail: "person@new.test" }), signedIn: renamed })).toEqual(
      { kind: "write" },
    );
    expect(decide({ stored: login({ gmailEmail: "person@old.test" }), signedIn: renamed })).toEqual(
      mismatch,
    );
  });

  test("a login with its account ID isn't reconnected on email alone", () => {
    const stored = login({ gmailEmail: "person@new.test", googleSubject: "1001" });
    expect(decide({ stored, signedIn: { gmailEmail: "person@new.test" } })).toEqual({
      kind: "reject",
      reason: "account_identity_unavailable",
    });
    // Adding finds it by email as before (nothing is written on reuse).
    const active = login(
      { gmailEmail: "person@new.test", googleSubject: "1001" },
      { status: "active" },
    );
    expect(
      decide({ stored: active, signedIn: { gmailEmail: "person@new.test" }, reconnect: false }),
    ).toEqual({ kind: "reuse", connection: active });
  });

  test("adding the renamed account again points at its existing login", () => {
    const needsReauth = login({ gmailEmail: "person@old.test", googleSubject: "1001" });
    expect(decide({ stored: needsReauth, signedIn: renamed, reconnect: false })).toEqual({
      kind: "reject",
      reason: "account_already_connected",
    });
    const active = login(
      { gmailEmail: "person@old.test", googleSubject: "1001" },
      { status: "active" },
    );
    expect(decide({ stored: active, signedIn: renamed, reconnect: false })).toEqual({
      kind: "reuse",
      connection: active,
    });
  });

  test("adding another account that took over an address saves a separate login", () => {
    const other = login({ gmailEmail: "person@new.test", googleSubject: "2002" });
    expect(decide({ stored: other, signedIn: renamed, reconnect: false })).toEqual({
      kind: "write",
    });
  });

  test("reviving a removed login refuses while the same account has a live one", () => {
    const live = login(
      { gmailEmail: "person@old.test", googleSubject: "1001" },
      { id: "live", status: "active" },
    );
    const removed = login({ gmailEmail: "person@new.test" }, { status: "revoked" });
    expect(
      decideOAuthAccountConnection({
        accounts: [removed, live],
        ownerSubjectId: "owner",
        providerDomain: "gmailmcp.googleapis.com",
        mcpUrl: OFFICIAL_GMAIL_MCP_URL,
        metadata: { ...base, ...renamed },
        identityKeys: ["gmailEmail"],
        subjectKey: "googleSubject",
        grantedScopes: ["read"],
        requestedConnectionId: "existing",
      }),
    ).toEqual({ kind: "reject", reason: "account_already_connected" });
  });
});

describe("reading Google's account ID", () => {
  test("only a token issued to our own client counts", () => {
    expect(googleSubjectFromClaims({ sub: "1001", aud: "client" }, "client")).toBe("1001");
    expect(googleSubjectFromClaims({ sub: "1001", azp: "client" }, "client")).toBe("1001");
    for (const payload of [
      { sub: "1001", aud: "another-client" },
      { sub: "", aud: "client" },
      { aud: "client" },
      { sub: "x".repeat(256), aud: "client" },
    ])
      expect(() => googleSubjectFromClaims(payload, "client")).toThrow(
        "Google account verification failed",
      );
  });
});

describe("the callback's account ID read", () => {
  const settings = testSettings({});
  const deadline = { signal: new AbortController().signal, remainingMs: () => 30_000 };
  const token = { accessToken: "new-access", raw: {} as Record<string, unknown> };
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());
  const read = (mcpUrl: string, raw: Record<string, unknown> = {}) =>
    stableAccountIdentity(undefined, settings, { mcpUrl }, { ...token, raw }, "client", deadline);

  test("reads the account ID from Google's signed ID token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const idToken = (claims: Record<string, unknown>, issuer = "https://accounts.google.com") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const seen: string[] = [];
    let certsAvailable = true;
    // Token info for a token that only an unproven ID token came with: not ours.
    let tokenInfo = () => Response.json({ sub: "1001", aud: "another-client" });
    spy = spyOn(network, "pinnedFetch").mockImplementation(async (input) => {
      seen.push(String(input));
      if (String(input) === "https://www.googleapis.com/oauth2/v3/certs")
        return certsAvailable
          ? Response.json({ keys: [jwk] })
          : new Response(null, { status: 503 });
      if (String(input) === "https://oauth2.googleapis.com/tokeninfo") return tokenInfo();
      throw new Error(`Unexpected destination: ${String(input)}`);
    });
    for (const issuer of ["https://accounts.google.com", "accounts.google.com"])
      expect(
        await read(OFFICIAL_GMAIL_MCP_URL, {
          id_token: await idToken({ sub: "1001", aud: "client" }, issuer),
        }),
      ).toEqual({ googleSubject: "1001" });
    // Another client's token, another issuer, or a forged signature prove nothing.
    for (const raw of [
      { id_token: await idToken({ sub: "1001", aud: "another-client" }) },
      { id_token: await idToken({ sub: "1001", aud: "client" }, "https://issuer.test") },
      {
        id_token: await new SignJWT({ sub: "1001", aud: "client" })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer("https://accounts.google.com")
          .setExpirationTime("5m")
          .sign((await generateKeyPair("RS256")).privateKey),
      },
    ])
      expect(await read(OFFICIAL_GMAIL_MCP_URL, raw)).toEqual({});
    // An ID token that can't be checked (Google's keys are unreachable) falls
    // back to token info for the access token.
    certsAvailable = false;
    tokenInfo = () => Response.json({ sub: "1002", aud: "client" });
    expect(
      await read(OFFICIAL_GMAIL_MCP_URL, {
        id_token: await idToken({ sub: "1001", aud: "client" }),
      }),
    ).toEqual({ googleSubject: "1002" });
    expect(seen).toContain("https://oauth2.googleapis.com/tokeninfo");
  });

  test("without an ID token, reads token info with the token in the body, never the URL", async () => {
    const seen: string[] = [];
    spy = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
      seen.push(String(input));
      expect(init?.method).toBe("POST");
      expect(new URLSearchParams(String(init?.body)).get("access_token")).toBe("new-access");
      return Response.json({ sub: "1001", aud: "client" });
    });
    for (const url of [
      OFFICIAL_GMAIL_MCP_URL,
      OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
      OFFICIAL_DRIVE_MCP_URL,
    ])
      expect(await read(url)).toEqual({ googleSubject: "1001" });
    expect(new Set(seen)).toEqual(new Set(["https://oauth2.googleapis.com/tokeninfo"]));
  });

  test("a failed or unproven read leaves it unknown", async () => {
    for (const answer of [
      () => new Response(null, { status: 503 }),
      () => Response.json({ aud: "client" }),
      () => Response.json({ sub: "1001", aud: "someone-else" }),
    ]) {
      spy?.mockRestore();
      spy = spyOn(network, "pinnedFetch").mockImplementation(async () => answer());
      expect(await read(OFFICIAL_GMAIL_MCP_URL)).toEqual({});
    }
  });

  test("services without an account ID make no request", async () => {
    spy = spyOn(network, "pinnedFetch").mockImplementation(async () => {
      throw new Error("must not be called");
    });
    expect(await read("https://mcp.notion.com/mcp")).toEqual({});
  });
});
