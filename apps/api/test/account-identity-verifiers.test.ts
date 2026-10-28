import { describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { decideOAuthAccountConnection } from "../src/integrations/oauth-account-identity";
import { mcpToolAccountIdentity } from "../src/integrations/oauth-client";
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

  test("the Atlassian tool check parses text or structured results and never throws", async () => {
    const verifier = accountIdentityVerifierFor(ATLASSIAN)!;
    if (verifier.kind !== "mcp_tool") throw new Error("expected an MCP tool verifier");
    const calls: unknown[] = [];
    const client = (result: unknown) =>
      ({
        callTool: async (params: unknown, options: unknown) => {
          calls.push([params, options]);
          if (result instanceof Error) throw result;
          return result;
        },
      }) as never;
    const check = (result: unknown, tools = ["atlassianUserInfo"], budget = 1_000) =>
      mcpToolAccountIdentity(client(result), verifier, tools, budget, new AbortController().signal);
    const text = {
      content: [
        { type: "text", text: "not json" },
        { type: "text", text: JSON.stringify({ account_id: "712020:anna", email: "a@x.test" }) },
      ],
    };
    expect(await check(text)).toEqual({
      identity: { atlassianAccountId: "712020:anna", atlassianEmail: "a@x.test" },
    });
    expect(await check({ structuredContent: { account_id: "712020:erik" } })).toEqual({
      identity: { atlassianAccountId: "712020:erik" },
    });
    expect(await check({ isError: true, content: [] })).toEqual({ failure: "tool_error" });
    expect(await check({ content: [{ type: "text", text: "{}" }] })).toEqual({
      failure: "invalid_identity",
    });
    expect(await check(new Error("socket closed"))).toEqual({ failure: "request_failed" });
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(await check(timeout)).toEqual({ failure: "timeout" });
    calls.length = 0;
    expect(await check(text, ["getJiraIssue"])).toEqual({ failure: "tool_missing" });
    expect(await check(text, undefined, 0)).toEqual({ failure: "budget_exhausted" });
    expect(calls).toEqual([]);
  });
});
