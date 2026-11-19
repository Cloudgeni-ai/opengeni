import { describe, expect, test } from "bun:test";
import type { RunCredentialsRequest } from "@opengeni/contracts";
import { credentialProviderRequestBody } from "../src/activities/workspace-credential-provider";

/**
 * Compatibility contract for Console agents: the `credentials.request` body a
 * host's credential provider (CloudGeni, Kontali) receives must not change.
 * Organization tool servers ask the same provider through `mcpServers`, so
 * this pins today's exact body. Recorded on main d07d727.
 */
const input = {
  accountId: "acct_1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  rootSessionId: "22222222-2222-4222-8222-222222222222",
  parentSessionId: null,
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  purpose: "provision",
  forceRefresh: false,
  initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
  initiatorContext: { via: [{ kind: "human", subjectId: "external_user:cg-user-1" }] },
  sandboxOs: "linux",
  effectiveSandboxBackend: "modal",
} as unknown as RunCredentialsRequest;

describe("credentials.request body (recorded on main)", () => {
  test("workspace lane without MCP servers", () => {
    expect(JSON.parse(JSON.stringify(credentialProviderRequestBody(input, null)))).toEqual({
      type: "credentials.request",
      lane: "workspace",
      mcpServers: [],
      purpose: "provision",
      forceRefresh: false,
      accountId: "acct_1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      rootSessionId: "22222222-2222-4222-8222-222222222222",
      parentSessionId: null,
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
      initiatorContext: {
        kind: "human",
        initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
        context: { via: [{ kind: "human", subjectId: "external_user:cg-user-1" }] },
      },
      initiatingHumanSubjectId: null,
      initiatingHuman: null,
      sandboxBackend: "modal",
      sandboxOs: "linux",
    });
  });

  test("organization lane with MCP servers sends only id and url, and an agent hop is an agent", () => {
    const human = {
      subjectId: "external_user:cg-user-1",
      externalIdentity: { source: "cloudgeni", externalUserId: "cg-user-1" },
    };
    const body = credentialProviderRequestBody(
      {
        ...input,
        initiatorContext: { via: [{ kind: "human" }, { kind: "agent", sessionId: "parent" }] },
      } as unknown as RunCredentialsRequest,
      human.subjectId,
      human as never,
      {
        lane: "organization",
        mcpServers: [
          {
            id: "cloudgeni-capability",
            url: "https://cloudgeni.example/mcp",
            extra: "dropped",
          } as never,
        ],
      },
    );
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      type: "credentials.request",
      lane: "organization",
      mcpServers: [{ id: "cloudgeni-capability", url: "https://cloudgeni.example/mcp" }],
      purpose: "provision",
      forceRefresh: false,
      accountId: "acct_1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      rootSessionId: "22222222-2222-4222-8222-222222222222",
      parentSessionId: null,
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
      initiatorContext: {
        kind: "agent",
        initiator: { kind: "subject", subjectId: "external_user:cg-user-1" },
        context: { via: [{ kind: "human" }, { kind: "agent", sessionId: "parent" }] },
      },
      initiatingHumanSubjectId: "external_user:cg-user-1",
      initiatingHuman: human,
      sandboxBackend: "modal",
      sandboxOs: "linux",
    });
    expect(Object.keys(body)).toEqual([
      "type",
      "lane",
      "mcpServers",
      "purpose",
      "forceRefresh",
      "accountId",
      "workspaceId",
      "sessionId",
      "rootSessionId",
      "parentSessionId",
      "turnId",
      "attemptId",
      "initiator",
      "initiatorContext",
      "initiatingHumanSubjectId",
      "initiatingHuman",
      "sandboxBackend",
      "sandboxOs",
    ]);
  });
});
