import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  DelegatedAccessTokenPayload,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "../src";

describe("first-party MCP tool-name contract", () => {
  test("accepts exact known names and preserves explicit empty selection", () => {
    expect(
      CreateSessionRequest.parse({
        initialMessage: "work",
        firstPartyMcpTools: [],
      }).firstPartyMcpTools,
    ).toEqual([]);
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "work",
        firstPartyMcpTools: [...FIRST_PARTY_MCP_TOOL_NAMES],
      }).success,
    ).toBe(true);
  });

  test("resource attachment remains independent of model-visible first-party tools", () => {
    const resource = {
      kind: "repository" as const,
      uri: "https://github.com/acme/example.git",
      ref: "main",
    };
    expect(
      CreateSessionRequest.parse({
        initialMessage: "work",
        resources: [resource],
        firstPartyMcpTools: [],
      }),
    ).toMatchObject({ resources: [resource], firstPartyMcpTools: [] });
    expect(
      CreateSessionRequest.parse({
        initialMessage: "work",
        resources: [resource],
        firstPartyMcpTools: ["set_session_title"],
      }),
    ).toMatchObject({
      resources: [resource],
      firstPartyMcpTools: ["set_session_title"],
    });
  });

  test("rejects unknown names at both API and delegated-token boundaries", () => {
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "work",
        firstPartyMcpTools: ["future_unreviewed_tool"],
      }).success,
    ).toBe(false);
    expect(
      DelegatedAccessTokenPayload.safeParse({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        subjectId: "worker:first-party-mcp",
        permissions: ["workspace:read"],
        sessionId: crypto.randomUUID(),
        firstPartyMcpTools: ["future_unreviewed_tool"],
        exp: Math.floor(Date.now() / 1000) + 60,
      }).success,
    ).toBe(false);
  });
});
