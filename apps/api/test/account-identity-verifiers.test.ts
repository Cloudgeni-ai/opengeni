import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  accountIdentityKeysFor,
  accountIdentityVerifierFor,
  builtInOAuthProfileFor,
} from "../src/integrations/oauth-profiles";

const ATLASSIAN = "https://mcp.atlassian.com/v1/mcp/authv2";

describe("reviewed account identity verifiers", () => {
  test("Google Drive reads the signed-in email from Drive About", () => {
    const verifier = accountIdentityVerifierFor(OFFICIAL_DRIVE_MCP_URL)!;
    expect(verifier).toMatchObject({ kind: "http", identityKeys: ["googleDriveEmail"] });
    expect(verifier.kind === "http" && new URL(verifier.url).origin).toBe(
      "https://www.googleapis.com",
    );
    expect(verifier.validateIdentity({ user: { emailAddress: "anna@example.test" } })).toEqual({
      googleDriveEmail: "anna@example.test",
    });
    for (const payload of [{}, { user: {} }, { user: { emailAddress: "not an email" } }]) {
      expect(() => verifier.validateIdentity(payload)).toThrow();
    }
    expect(
      accountIdentityKeysFor(
        builtInOAuthProfileFor({ mcpUrl: OFFICIAL_DRIVE_MCP_URL }),
        OFFICIAL_DRIVE_MCP_URL,
      ),
    ).toEqual(["googleDriveEmail"]);
  });

  test("Atlassian uses the stable account id and keeps the email only for the label", () => {
    const verifier = accountIdentityVerifierFor(ATLASSIAN)!;
    expect(verifier).toMatchObject({
      kind: "mcp_tool",
      toolName: "atlassianUserInfo",
      identityKeys: ["atlassianAccountId"],
    });
    const identity = verifier.validateIdentity({
      account_id: "712020:abc",
      email: "anna@example.test",
      name: "Anna",
      picture: "https://avatar.example.test/a.png",
    });
    expect(identity).toEqual({
      atlassianAccountId: "712020:abc",
      atlassianEmail: "anna@example.test",
      atlassianName: "Anna",
    });
    expect(connectionAccountIdentityLabel(identity, "Atlassian account")).toBe("anna@example.test");
    expect(() => verifier.validateIdentity({ email: "anna@example.test" })).toThrow();
    expect(accountIdentityKeysFor(null, ATLASSIAN)).toEqual(["atlassianAccountId"]);
  });

  test("profiles that verify identity themselves keep their own keys", () => {
    const gmail = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL });
    expect(accountIdentityKeysFor(gmail, OFFICIAL_GMAIL_MCP_URL)).toEqual(["gmailEmail"]);
    expect(accountIdentityVerifierFor("https://unreviewed.example.test/mcp")).toBeUndefined();
    expect(accountIdentityKeysFor(null, "https://unreviewed.example.test/mcp")).toBeUndefined();
  });

  test("a verified Atlassian identity allows a second account and reuses the same one", () => {
    const base = {
      mcpUrl: ATLASSIAN,
      authorizationServerIssuer: "https://auth.atlassian.com",
      clientId: "client",
    };
    const existing = {
      id: "existing",
      subjectId: "owner",
      providerDomain: "mcp.atlassian.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      metadata: { ...base, atlassianAccountId: "712020:anna" },
      createdAt: "2026-01-01",
    } as unknown as ConnectionMetadata;
    const decide = (atlassianAccountId: string | undefined) =>
      decideOAuthAccountConnection({
        accounts: [existing],
        ownerSubjectId: "owner",
        providerDomain: "mcp.atlassian.com",
        mcpUrl: ATLASSIAN,
        metadata: { ...base, ...(atlassianAccountId ? { atlassianAccountId } : {}) },
        grantedScopes: [],
        identityKeys: accountIdentityKeysFor(null, ATLASSIAN),
      });
    expect(decide("712020:anna")).toMatchObject({ kind: "reuse" });
    expect(decide("712020:erik")).toEqual({ kind: "write" });
    // A failed identity read stays unknown: never assumed to be a new account.
    expect(decide(undefined)).toEqual({ kind: "reject", reason: "account_identity_unavailable" });
  });
});
