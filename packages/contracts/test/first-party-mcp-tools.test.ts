import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  DelegatedAccessTokenPayload,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "../src";

const EXPLICIT_ONLY_CONNECTOR_TOOLS = [
  "social_connections_list",
  "social_posts_recent",
  "social_daily_analysis_context",
  "social_search_live",
  "social_mentions_live",
  "social_thread_fetch",
  "social_posts_sync",
  "social_post_reply",
  "slack_bot_list_channels",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
  "slack_bot_post_message",
  "slack_bot_delete_message",
] as const;

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

  test("keeps every connector-wide tool outside the ordinary default selection", () => {
    expect(
      FIRST_PARTY_MCP_TOOL_NAMES.filter((name) => !DEFAULT_FIRST_PARTY_MCP_TOOLS.includes(name)),
    ).toEqual([...EXPLICIT_ONLY_CONNECTOR_TOOLS]);
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
