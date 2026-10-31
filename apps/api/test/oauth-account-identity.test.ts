import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";

const metadata = {
  mcpUrl: "https://service.test/mcp",
  authorizationServerIssuer: "https://issuer.test",
  clientId: "client",
  subject: "person",
  tenant: "team",
};
function account(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "existing",
    subjectId: "owner",
    providerDomain: "service.test",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["read"],
    metadata,
    createdAt: "2026-01-01",
    ...overrides,
  } as ConnectionMetadata;
}
function decide(overrides: Partial<Parameters<typeof decideOAuthAccountConnection>[0]> = {}) {
  return decideOAuthAccountConnection({
    accounts: [account()],
    ownerSubjectId: "owner",
    providerDomain: "service.test",
    mcpUrl: metadata.mcpUrl,
    metadata,
    identityKeys: ["tenant", "subject"],
    grantedScopes: ["read"],
    ...overrides,
  });
}

describe("shared OAuth account policy", () => {
  test("a declared identity works without any provider-specific policy branch", () => {
    expect(decide().kind).toBe("reuse");
    expect(decide({ metadata: { ...metadata, tenant: "other" } }).kind).toBe("write");
  });
  test("a display name or token field alone cannot identify an opaque account", () => {
    expect(decide({ identityKeys: undefined })).toEqual({
      kind: "reject",
      reason: "account_limit_one",
    });
  });
  test("a failed identity read on a service that identifies accounts says so", () => {
    expect(decide({ metadata: { ...metadata, subject: undefined } })).toEqual({
      kind: "reject",
      reason: "account_identity_unavailable",
    });
  });
  test("an unknown legacy account must be reconnected once before another is added", () => {
    expect(decide({ accounts: [account({ metadata: { mcpUrl: metadata.mcpUrl } })] })).toEqual({
      kind: "reject",
      reason: "account_reconnect_required",
    });
  });
  test("verified reconnect cannot lose proof or change issuer", () => {
    // A failed identity read is unknown, not evidence of a different account.
    expect(
      decide({ requestedConnectionId: "existing", metadata: { ...metadata, subject: undefined } }),
    ).toEqual({ kind: "reject", reason: "account_identity_unavailable" });
    for (const value of [
      { ...metadata, subject: "other" },
      { ...metadata, authorizationServerIssuer: "https://other.test" },
    ]) {
      expect(decide({ requestedConnectionId: "existing", metadata: value })).toEqual({
        kind: "reject",
        reason: "account_mismatch",
      });
    }
  });
  test("new scopes require explicit reconnect instead of reporting an insufficient existing grant as connected", () => {
    expect(decide({ grantedScopes: ["read", "write"] })).toEqual({
      kind: "reject",
      reason: "account_already_connected",
    });
  });
  test("reconnect of an unknown legacy row cannot adopt another live identity", () => {
    expect(
      decide({
        requestedConnectionId: "legacy",
        accounts: [account(), account({ id: "legacy", metadata: { mcpUrl: metadata.mcpUrl } })],
      }),
    ).toEqual({ kind: "reject", reason: "account_already_connected" });
  });
  test("reviving a removed account cannot create another duplicate, even for opaque providers", () => {
    for (const identityKeys of [undefined, ["tenant", "subject"]]) {
      expect(
        decide({
          identityKeys,
          requestedConnectionId: "removed",
          accounts: [account(), account({ id: "removed", status: "revoked" })],
        }),
      ).toEqual({ kind: "reject", reason: "account_already_connected" });
    }
  });
  test("explicit reconnect can still repair an existing active legacy duplicate", () => {
    expect(
      decide({
        requestedConnectionId: "existing",
        accounts: [account(), account({ id: "duplicate" })],
      }).kind,
    ).toBe("write");
  });
  test("another owner or exact resource does not collide", () => {
    expect(decide({ ownerSubjectId: "someone-else" }).kind).toBe("write");
    expect(decide({ mcpUrl: "https://service.test/other" }).kind).toBe("write");
  });
});

describe("one account per person when the service can't identify accounts", () => {
  const opaque = { mcpUrl: metadata.mcpUrl };
  const unidentified = (overrides: Partial<Parameters<typeof decide>[0]> = {}) =>
    decide({ identityKeys: undefined, metadata: opaque, ...overrides });
  const personal = (subjectId: string, overrides: Partial<ConnectionMetadata> = {}) =>
    account({ id: `personal-${subjectId}`, subjectId, metadata: opaque, ...overrides });
  const shared = (overrides: Partial<ConnectionMetadata> = {}) =>
    account({ id: "shared", subjectId: null, metadata: opaque, ...overrides });
  const limit = { kind: "reject", reason: "account_limit_one" };

  test("the first connection in either bucket is written", () => {
    expect(unidentified({ accounts: [] }).kind).toBe("write");
    expect(
      unidentified({ accounts: [], ownerSubjectId: null, requesterSubjectId: "alice" }).kind,
    ).toBe("write");
  });
  test("a second one in the same bucket is refused", () => {
    expect(unidentified({ accounts: [personal("owner")] })).toEqual(limit);
    expect(
      unidentified({ accounts: [shared()], ownerSubjectId: null, requesterSubjectId: "alice" }),
    ).toEqual(limit);
  });
  test("a personal one is refused while a shared one exists", () => {
    expect(unidentified({ accounts: [shared()] })).toEqual(limit);
  });
  test("a shared one is refused while the requester has a personal one", () => {
    expect(
      unidentified({
        accounts: [personal("alice")],
        ownerSubjectId: null,
        requesterSubjectId: "alice",
      }),
    ).toEqual(limit);
  });
  test("other people's personal connections never block, so both can stay", () => {
    expect(unidentified({ accounts: [personal("bob")] }).kind).toBe("write");
    expect(
      unidentified({
        accounts: [personal("bob"), personal("carol")],
        ownerSubjectId: null,
        requesterSubjectId: "alice",
      }).kind,
    ).toBe("write");
  });
  test("removed connections and other resources don't count", () => {
    expect(unidentified({ accounts: [shared({ status: "revoked" })] }).kind).toBe("write");
    expect(
      unidentified({
        accounts: [personal("alice", { status: "revoked" })],
        ownerSubjectId: null,
        requesterSubjectId: "alice",
      }).kind,
    ).toBe("write");
    expect(
      unidentified({ accounts: [shared({ metadata: { mcpUrl: "https://service.test/other" } })] })
        .kind,
    ).toBe("write");
  });
  test("reconnecting the existing connection is unaffected", () => {
    expect(
      unidentified({ accounts: [personal("owner")], requestedConnectionId: "personal-owner" }).kind,
    ).toBe("write");
    expect(
      unidentified({
        accounts: [shared()],
        ownerSubjectId: null,
        requesterSubjectId: "alice",
        requestedConnectionId: "shared",
      }).kind,
    ).toBe("write");
  });
  test("URL variants of the same server count as one resource", () => {
    expect(
      decide({
        identityKeys: undefined,
        mcpUrl: "https://mcp.stripe.com",
        metadata: { mcpUrl: "https://mcp.stripe.com" },
        accounts: [account({ metadata: { mcpUrl: "https://mcp.stripe.com/" } })],
      }),
    ).toEqual(limit);
  });
});
