import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { personalReconnectTarget } from "../src/components/mcp-capability-connect-flow";

const GMAIL = "https://gmailmcp.googleapis.com/mcp/v1";

function login(
  id: string,
  status: ConnectionMetadata["status"],
  overrides: Partial<ConnectionMetadata> = {},
): ConnectionMetadata {
  return {
    id,
    accountId: "account",
    workspaceId: "workspace",
    subjectId: "user:me",
    authorityId: `authority-${id}`,
    providerDomain: "gmailmcp.googleapis.com",
    kind: "oauth2",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { mcpUrl: GMAIL, gmailEmail: "me@example.test" },
    createdBySubjectId: "user:me",
    updatedBySubjectId: "user:me",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  } as ConnectionMetadata;
}

describe("which own login a connector card reconnects", () => {
  test("removed duplicates never make the one remaining login ambiguous", () => {
    // Two removed duplicates and the login that needs signing in again, as
    // the connections list returns them: the card repairs that login.
    expect(
      personalReconnectTarget(
        [
          login("removed-1", "revoked"),
          login("removed-2", "revoked"),
          login("lapsed", "needs_reauth"),
        ],
        GMAIL,
      ),
    ).toEqual({ ambiguous: false, connectionId: "lapsed" });
  });

  test("with only removed logins left, the card connects a new account", () => {
    expect(personalReconnectTarget([login("removed", "revoked")], GMAIL)).toEqual({
      ambiguous: false,
      connectionId: undefined,
    });
  });

  test("two logins that still exist stay a choice for the person", () => {
    expect(
      personalReconnectTarget([login("one", "active"), login("two", "needs_reauth")], GMAIL),
    ).toEqual({ ambiguous: true });
  });

  test("workspace connections and other endpoints are not the person's login here", () => {
    expect(
      personalReconnectTarget(
        [
          login("shared", "active", { subjectId: null }),
          login("calendar", "active", {
            metadata: { mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1" },
          }),
          login("mine", "error"),
        ],
        GMAIL,
      ),
    ).toEqual({ ambiguous: false, connectionId: "mine" });
  });
});
