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
  googleSubjectFromTokenInfo,
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

  test("without the account ID this time, the email decides as before", () => {
    const stored = login({ gmailEmail: "person@new.test", googleSubject: "1001" });
    expect(decide({ stored, signedIn: { gmailEmail: "person@new.test" } })).toEqual({
      kind: "write",
    });
    expect(decide({ stored, signedIn: { gmailEmail: "person@other.test" } })).toEqual(mismatch);
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
});

describe("the callback's account ID read", () => {
  const settings = testSettings({});
  const deadline = { signal: new AbortController().signal, remainingMs: () => 30_000 };
  const token = { accessToken: "new-access" };
  let spy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => spy?.mockRestore());
  const read = (mcpUrl: string) =>
    stableAccountIdentity(undefined, settings, { mcpUrl }, token, "client", deadline);

  test("reads the account ID with the token in the body, never the URL", async () => {
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
