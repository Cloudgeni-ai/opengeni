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
      reason: "account_identity_unavailable",
    });
  });
  test("an unknown legacy account cannot be assumed distinct from a verified incoming account", () => {
    expect(decide({ accounts: [account({ metadata: { mcpUrl: metadata.mcpUrl } })] })).toEqual({
      kind: "reject",
      reason: "account_identity_unavailable",
    });
  });
  test("verified reconnect cannot lose proof or change issuer", () => {
    for (const value of [
      { ...metadata, subject: undefined },
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
