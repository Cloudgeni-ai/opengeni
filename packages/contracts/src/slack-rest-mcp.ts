/** The catalog and OAuth identity stay stable while calls use the ordinary Web API. */
export const OFFICIAL_SLACK_MCP_URL = "https://mcp.slack.com/mcp";
export const SLACK_REST_API_BASE = "https://slack.com/api/";

export const OPENGENI_SLACK_REST_USER_SCOPES = [
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "im:write",
  "chat:write",
] as const;

/** Slack returns comma-delimited scopes, including in existing saved grants. */
export function normalizeSlackScopes(
  scopes: readonly string[] | string | undefined | null,
): string[] {
  return [
    ...new Set(
      (typeof scopes === "string" ? [scopes] : (scopes ?? []))
        .flatMap((entry) => entry.split(/[\s,]+/u))
        .filter(Boolean),
    ),
  ].sort();
}

export type SlackRestMcpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: boolean;
    openWorldHint: true;
  };
};

const conversationScopes = ["channels:read", "groups:read", "im:read", "mpim:read"];
const historyScopes = ["channels:history", "groups:history", "im:history", "mpim:history"];
const channel = { type: "string", description: "Slack conversation ID, such as C123 or D123." };
const cursor = { type: "string", maxLength: 4096, description: "Cursor from the previous page." };
const directoryPage = { type: "integer", minimum: 1, maximum: 100, default: 100 };
const historyPage = { type: "integer", minimum: 1, maximum: 15, default: 15 };
const timestamp = { type: "string", pattern: "^[0-9]+\\.[0-9]+$" };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  mutation = false,
): SlackRestMcpTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: !mutation,
      destructiveHint: false,
      idempotentHint: !mutation,
      openWorldHint: true,
    },
  };
}

/** Static reviewed pilot surface. Each call reads only one explicitly requested page. */
export const SLACK_REST_MCP_TOOLS: SlackRestMcpTool[] = [
  tool(
    "slack_list_channels",
    "Lists one page of conversations visible to your connected Slack account. Conversation types without a granted read scope are omitted.",
    {
      types: {
        type: "array",
        items: { type: "string", enum: ["public_channel", "private_channel", "im", "mpim"] },
        minItems: 1,
        maxItems: 4,
      },
      cursor,
      limit: directoryPage,
      exclude_archived: { type: "boolean", default: true },
    },
  ),
  tool(
    "slack_get_channel_info",
    "Gets metadata for one conversation visible to your connected Slack account.",
    { channel },
    ["channel"],
  ),
  tool(
    "slack_list_channel_members",
    "Lists one page of members in a visible channel or group conversation.",
    { channel, cursor, limit: directoryPage },
    ["channel"],
  ),
  tool("slack_list_users", "Lists one page of users in the connected Slack workspace.", {
    cursor,
    limit: directoryPage,
  }),
  tool(
    "slack_get_user_info",
    "Gets a user's profile by their Slack user ID. Email is included only when Slack has granted that scope.",
    { user: { type: "string" } },
    ["user"],
  ),
  tool(
    "slack_read_channel",
    "Reads one page of at most 15 messages from a selected conversation. Slack history limits are shared across the workspace. No automatic pagination or backfill.",
    {
      channel,
      cursor,
      limit: historyPage,
      oldest: timestamp,
      latest: timestamp,
      inclusive: { type: "boolean", default: false },
    },
    ["channel"],
  ),
  tool(
    "slack_read_thread",
    "Reads one page of at most 15 messages in a selected thread. Slack thread limits are shared across the workspace. No automatic pagination or backfill.",
    {
      channel,
      ts: { ...timestamp, description: "Thread root message timestamp." },
      cursor,
      limit: historyPage,
    },
    ["channel", "ts"],
  ),
  tool(
    "slack_open_dm",
    "Opens or resumes a direct message with one Slack user as your connected account.",
    { user: { type: "string" } },
    ["user"],
    true,
  ),
  tool(
    "slack_send_message",
    "Sends a message as your connected Slack account. Supply thread_ts to reply in a thread. Review the recipient and text before approving. An uncertain submission is never automatically retried.",
    {
      channel,
      text: { type: "string", minLength: 1, maxLength: 40000 },
      thread_ts: { ...timestamp, description: "Optional thread root timestamp for a reply." },
      unfurl_links: { type: "boolean", default: false },
      unfurl_media: { type: "boolean", default: false },
    },
    ["channel", "text"],
    true,
  ),
];

const REQUIRED_ANY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  slack_list_channels: conversationScopes,
  slack_get_channel_info: conversationScopes,
  slack_list_channel_members: ["channels:read", "groups:read", "mpim:read"],
  slack_list_users: ["users:read"],
  slack_get_user_info: ["users:read"],
  slack_read_channel: historyScopes,
  slack_read_thread: historyScopes,
  slack_open_dm: ["im:write"],
  slack_send_message: ["chat:write"],
};

export function slackRestMcpToolsForScopes(scopes: readonly string[] | string): SlackRestMcpTool[] {
  const granted = new Set(normalizeSlackScopes(scopes));
  return SLACK_REST_MCP_TOOLS.filter((entry) =>
    REQUIRED_ANY_SCOPES[entry.name]?.some((scope) => granted.has(scope)),
  ).map((entry) => ({
    ...entry,
    inputSchema: {
      ...entry.inputSchema,
      required: [...entry.inputSchema.required],
      properties: { ...entry.inputSchema.properties },
    },
    annotations: { ...entry.annotations },
  }));
}

export const SLACK_CONVERSATION_READ_SCOPE_BY_TYPE = {
  public_channel: "channels:read",
  private_channel: "groups:read",
  im: "im:read",
  mpim: "mpim:read",
} as const;
