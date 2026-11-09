import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as network from "@opengeni/network";
import { testSettings } from "@opengeni/testing/settings";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";
import { stableAccountIdentity } from "../src/integrations/oauth-client";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
  gmailAcceptedSendAsAddresses,
  googleSubjectFromTokenInfo,
  stableAccountSubjectKeyFor,
} from "../src/integrations/oauth-profiles";

const base = {
  mcpUrl: OFFICIAL_GMAIL_MCP_URL,
  authorizationServerIssuer: "https://accounts.google.com",
  clientId: "client",
};
const keys = ["gmailEmail"];

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
  ownedAddresses?: string[];
}) {
  return decideOAuthAccountConnection({
    accounts: [input.stored],
    ownerSubjectId: "owner",
    providerDomain: "gmailmcp.googleapis.com",
    mcpUrl: OFFICIAL_GMAIL_MCP_URL,
    metadata: { ...base, ...input.signedIn },
    identityKeys: keys,
    subjectKey: stableAccountSubjectKeyFor(OFFICIAL_GMAIL_MCP_URL),
    ownedAddresses: input.ownedAddresses,
    grantedScopes: ["read"],
    ...(input.reconnect === false ? {} : { requestedConnectionId: "existing" }),
  });
}

const renamed = { gmailEmail: "person@new.test", googleSubject: "1001" };

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
    expect(decide({ stored, signedIn: renamed })).toEqual({
      kind: "reject",
      reason: "account_mismatch",
    });
  });

  test("a login saved before the account ID adopts it when the email matches", () => {
    const stored = login({ gmailEmail: "person@new.test" });
    expect(decide({ stored, signedIn: renamed })).toEqual({ kind: "write" });
  });

  test("a login saved before the account ID adopts it when its address is one the account owns", () => {
    const stored = login({ gmailEmail: "Person@Old.test" });
    expect(
      decide({ stored, signedIn: renamed, ownedAddresses: ["person@new.test", "person@old.test"] }),
    ).toEqual({ kind: "write" });
    expect(
      decide({ stored, signedIn: renamed, ownedAddresses: ["person@new.test"] }),
    ).toEqual({ kind: "reject", reason: "account_mismatch" });
  });

  test("an owned address only counts with the account ID, so the login adopts it", () => {
    const stored = login({ gmailEmail: "person@old.test" });
    expect(
      decide({
        stored,
        signedIn: { gmailEmail: "person@new.test" },
        ownedAddresses: ["person@old.test"],
      }),
    ).toEqual({ kind: "reject", reason: "account_mismatch" });
  });

  test("an owned address never overrides a recorded account ID", () => {
    const stored = login({ gmailEmail: "person@old.test", googleSubject: "2002" });
    expect(
      decide({ stored, signedIn: renamed, ownedAddresses: ["person@old.test"] }),
    ).toEqual({ kind: "reject", reason: "account_mismatch" });
  });

  test("without the account ID this time, the email still decides as before", () => {
    const stored = login({ gmailEmail: "person@new.test", googleSubject: "1001" });
    expect(decide({ stored, signedIn: { gmailEmail: "person@new.test" } })).toEqual({
      kind: "write",
    });
    expect(decide({ stored, signedIn: { gmailEmail: "person@other.test" } })).toEqual({
      kind: "reject",
      reason: "account_mismatch",
    });
  });

  test("adding the renamed account again points at the existing login", () => {
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
});

describe("reading Google's account ID", () => {
  test("only a token issued to our own client counts", () => {
    expect(googleSubjectFromTokenInfo({ sub: "1001", aud: "client" }, "client")).toBe("1001");
    expect(googleSubjectFromTokenInfo({ sub: "1001", azp: "client" }, "client")).toBe("1001");
    for (const payload of [
      { sub: "1001", aud: "another-client" },
      { sub: "", aud: "client" },
      { aud: "client" },
      { sub: "x".repeat(256), aud: "client" },
    ])
      expect(() => googleSubjectFromTokenInfo(payload, "client")).toThrow(
        "Google account verification failed",
      );
  });

  test("only the primary and accepted send-as addresses are owned", () => {
    expect(
      gmailAcceptedSendAsAddresses({
        sendAs: [
          { sendAsEmail: "Person@New.test", isPrimary: true },
          { sendAsEmail: "person@old.test", verificationStatus: "accepted" },
          { sendAsEmail: "someone@else.test", verificationStatus: "pending" },
          { sendAsEmail: "not-an-address", verificationStatus: "accepted" },
          "junk",
        ],
      }),
    ).toEqual(["person@new.test", "person@old.test"]);
    expect(gmailAcceptedSendAsAddresses({})).toEqual([]);
  });
});

describe("the callback's account ID read", () => {
  const settings = testSettings({});
  const deadline = { signal: new AbortController().signal, remainingMs: () => 30_000 };
  const token = { accessToken: "new-access", tokenType: "Bearer" };
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  test("reads the account ID with the token in the body, and Gmail's owned addresses", async () => {
    const seen: string[] = [];
    spy = spyOn(network, "pinnedFetch").mockImplementation(async (input, init) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://oauth2.googleapis.com/tokeninfo") {
        expect(init?.method).toBe("POST");
        expect(new URLSearchParams(String(init?.body)).get("access_token")).toBe("new-access");
        return Response.json({ sub: "1001", aud: "client", scope: "gmail.readonly" });
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer new-access");
        return Response.json({
          sendAs: [{ sendAsEmail: "person@old.test", verificationStatus: "accepted" }],
        });
      }
      throw new Error(`Unexpected destination: ${url}`);
    });
    expect(
      await stableAccountIdentity(
        undefined,
        settings,
        { mcpUrl: OFFICIAL_GMAIL_MCP_URL },
        token,
        "client",
        deadline,
      ),
    ).toEqual({ identity: { googleSubject: "1001" }, ownedAddresses: ["person@old.test"] });
    expect(seen.every((url) => !url.includes("new-access"))).toBe(true);
  });

  test("Calendar reads only the account ID; failures leave both unknown", async () => {
    const seen: string[] = [];
    spy = spyOn(network, "pinnedFetch").mockImplementation(async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 503 });
    });
    expect(
      await stableAccountIdentity(
        undefined,
        settings,
        { mcpUrl: OFFICIAL_GOOGLE_CALENDAR_MCP_URL },
        token,
        "client",
        deadline,
      ),
    ).toEqual({ identity: {}, ownedAddresses: [] });
    expect(seen).toEqual(["https://oauth2.googleapis.com/tokeninfo"]);
  });

  test("services without an account ID make no request", async () => {
    spy = spyOn(network, "pinnedFetch").mockImplementation(async () => {
      throw new Error("must not be called");
    });
    expect(
      await stableAccountIdentity(
        undefined,
        settings,
        { mcpUrl: "https://mcp.notion.com/mcp" },
        token,
        "client",
        deadline,
      ),
    ).toEqual({ identity: {}, ownedAddresses: [] });
  });
});
