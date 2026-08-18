import { describe, expect, test } from "bun:test";
import {
  CreateSessionRequest,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  DelegatedAccessTokenPayload,
  FIRST_PARTY_MCP_TOOL_NAMES,
} from "../src";

// Retired Memory V1 writes: still in the name union so previously written
// scheduled-task snapshots parse, but never default and never registered.
const RETIRED_TOOLS = ["memory_save", "memory_correct"] as const;

const EXPLICIT_ONLY_CONNECTOR_TOOLS = [
  "social_connections_list",
  "social_posts_recent",
  "social_daily_analysis_context",
  "social_search_live",
  "social_mentions_live",
  "social_thread_fetch",
  "social_posts_sync",
  "social_post_reply",
  "x_accounts_list",
  "x_search_live",
  "x_mentions_live",
  "x_thread_fetch",
  "x_posts_sync",
  "x_post_reply",
  "reddit_accounts_list",
  "reddit_search_live",
  "reddit_mentions_live",
  "reddit_thread_fetch",
  "reddit_posts_sync",
  "reddit_post_reply",
  "slack_bot_list_channels",
  "slack_bot_search",
  "slack_bot_channel_history",
  "slack_bot_thread_replies",
  "slack_bot_list_users",
  "slack_bot_list_files",
  "slack_bot_file_info",
  "slack_bot_file_content",
  "slack_bot_post_message",
  "slack_bot_delete_message",
  "fiken_companies_list",
  "fiken_contacts_list",
  "fiken_contact_create",
  "fiken_products_list",
  "fiken_invoices_list",
  "fiken_invoice_get",
  "fiken_invoice_draft_create",
  "fiken_bank_accounts_list",
  "fiken_purchases_list",
  "fiken_sales_list",
  "atlassian_sources_list",
  "atlassian_search",
  "atlassian_get",
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
    expect(
      CreateSessionRequest.parse({
        initialMessage: "preserve stored Slack selection",
        firstPartyMcpTools: ["slack_bot_post_message"],
      }).firstPartyMcpTools,
    ).toEqual(["slack_bot_post_message"]);
  });

  test("keeps connector-wide and retired tools outside the ordinary default selection", () => {
    expect(
      FIRST_PARTY_MCP_TOOL_NAMES.filter((name) => !DEFAULT_FIRST_PARTY_MCP_TOOLS.includes(name)),
    ).toEqual([...RETIRED_TOOLS, ...EXPLICIT_ONLY_CONNECTOR_TOOLS]);
  });

  test("still parses a retired tool name so stored selections keep loading", () => {
    // Immutable scheduled-task execution snapshots recorded the tool set that
    // was default when they were accepted. Dropping the name from the union
    // would make those snapshots fail to parse on replay.
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "replay a stored selection",
        firstPartyMcpTools: [...RETIRED_TOOLS],
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
    expect(FIRST_PARTY_MCP_TOOL_NAMES).not.toContain("github_token");
    expect(
      CreateSessionRequest.safeParse({
        initialMessage: "work",
        firstPartyMcpTools: ["github_token"],
      }).success,
    ).toBe(false);
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

  test("accepts paired agent-attempt depth claims and rejects partial or non-agent claims", () => {
    const base = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: "worker:first-party-mcp",
      permissions: ["sessions:create" as const],
      principalKind: "agent_attempt" as const,
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    expect(
      DelegatedAccessTokenPayload.safeParse({
        ...base,
        nestedAgentDepth: 2,
        effectiveMaxNestedAgentDepth: 3,
      }).success,
    ).toBe(true);
    expect(
      DelegatedAccessTokenPayload.safeParse({
        ...base,
        nestedAgentDepth: 2,
      }).success,
    ).toBe(false);
    expect(
      DelegatedAccessTokenPayload.safeParse({
        ...base,
        principalKind: "service",
        sessionId: undefined,
        turnId: undefined,
        attemptId: undefined,
        executionGeneration: undefined,
        nestedAgentDepth: 0,
        effectiveMaxNestedAgentDepth: 3,
      }).success,
    ).toBe(false);
  });

  test("preserves advanced public session-create compatibility outside the model surface", () => {
    const targetSandboxId = crypto.randomUUID();
    expect(
      CreateSessionRequest.parse({
        initialMessage: "advanced public caller",
        maxNestedAgentDepth: 0,
        sandbox: "shared",
        targetSandboxId,
        workingDir: "/srv/worktree",
      }),
    ).toMatchObject({
      maxNestedAgentDepth: 0,
      sandbox: "shared",
      targetSandboxId,
      workingDir: "/srv/worktree",
    });
  });
});
