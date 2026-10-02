import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import {
  OFFICIAL_SLACK_MCP_URL,
  SLACK_REST_API_BASE,
  SLACK_CONVERSATION_READ_SCOPE_BY_TYPE,
  normalizeSlackScopes,
  slackRestMcpToolsForScopes,
} from "@opengeni/contracts/slack-rest-mcp";
import {
  defineLocalMcpBridgeDescriptor,
  IntegrationInvocationError,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";

export {
  OFFICIAL_SLACK_MCP_URL,
  SLACK_REST_API_BASE,
  SLACK_REST_MCP_TOOLS,
} from "@opengeni/contracts/slack-rest-mcp";

const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "account_inactive",
]);
const HISTORY_METHODS = new Set(["conversations.history", "conversations.replies"]);
const MUTATION_TOOLS = new Set(["slack_open_dm", "slack_send_message"]);

type CredentialResult =
  | {
      status: "ok";
      headers: Record<string, string>;
      connectionId: string;
      grantedScopes?: string[];
      authorizeProviderRequest?: () => Promise<boolean>;
    }
  | {
      status: "auth_needed";
      reason: ToolAuthNeededPayload["reason"];
      providerDomain: string;
      authoritySource?: "host";
      provider?: string;
      connectionId?: string;
      scopes?: string[];
      resource?: string;
      authorizationUrl?: string;
    };
type Credential = Extract<CredentialResult, { status: "ok" }>;
type Payload = Record<string, unknown> & { ok?: boolean; error?: string };
type Plan = {
  method: string;
  params: Record<string, string | number | boolean>;
  mutation: boolean;
};

/** Reserve one request, or extend a shared provider cooldown after a 429. */
export type SlackApiRateLimiter = (
  teamId: string,
  method: string,
  retryAfterSeconds?: number,
) => Promise<number>;

export type SlackRestMcpServerOptions = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  connectionRef: McpServerConnectionRef;
  resolveCredential: (input: {
    workspaceId: string;
    subjectId?: string;
    serverId: string;
    toolName?: string;
    connectionRef: McpServerConnectionRef;
    destinationUrl: string;
    forceRefresh?: boolean;
  }) => Promise<CredentialResult>;
  slackRateLimit?: SlackApiRateLimiter;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
};
export type SlackRestMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};
export type SlackRestMcpBridgeContext = Omit<SlackRestMcpServerOptions, "connectionRef">;

export const SLACK_REST_MCP_BRIDGE_DESCRIPTOR = defineLocalMcpBridgeDescriptor({
  adapterId: "slack-rest",
  providerId: "slack",
  catalogIdentity: `mcp:${OFFICIAL_SLACK_MCP_URL}`,
  authority: "connection",
  toolSurface: "static_reviewed",
  mutationReplay: "safe_reads_only",
  destinations: [{ origin: "https://slack.com", pathPrefix: "/api/" }],
});

export function isOfficialSlackMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://mcp.slack.com" &&
      parsed.pathname.replace(/\/+$/u, "") === "/mcp" &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password &&
      connectionRef?.providerDomain.toLowerCase() === "slack.com" &&
      connectionRef.kind === "oauth2"
    );
  } catch {
    return false;
  }
}

export class SlackRestMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor = SLACK_REST_MCP_BRIDGE_DESCRIPTOR;
  private readonly fetchImpl: FetchLike;
  private identity: { teamId: string; userId: string; connectionId: string } | undefined;

  constructor(private readonly options: SlackRestMcpServerOptions) {
    this.name = `opengeni-slack-rest-${options.serverId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async connect(): Promise<void> {
    await this.verifyIdentity();
  }
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<Awaited<ReturnType<MCPServer["listTools"]>>> {
    const credential = await this.resolve("auth.test", undefined, false);
    return slackRestMcpToolsForScopes(credential.grantedScopes!);
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(toolName, args)).content;
  }

  async callToolResult(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    try {
      // Validate the complete input before even an identity request is dispatched.
      const plan = requestPlan(toolName, args ?? {});
      await this.verifyIdentity(toolName);
      const credential = await this.resolve(plan.method, toolName, false);
      if (
        !slackRestMcpToolsForScopes(credential.grantedScopes!).some(
          (entry) => entry.name === toolName,
        )
      ) {
        throw new SlackInputError(
          `Slack has not granted access to ${toolName}. Reconnect to grant the required permissions.`,
        );
      }
      if (toolName === "slack_list_channels") {
        const granted = new Set(normalizeSlackScopes(credential.grantedScopes));
        const requested = String(plan.params.types).split(",");
        const allowed = requested.filter((type) =>
          granted.has(
            SLACK_CONVERSATION_READ_SCOPE_BY_TYPE[
              type as keyof typeof SLACK_CONVERSATION_READ_SCOPE_BY_TYPE
            ],
          ),
        );
        if (args?.types && allowed.length !== requested.length)
          throw new SlackInputError(
            "Slack has not granted read access to every requested conversation type.",
          );
        if (allowed.length === 0)
          throw new SlackInputError("Slack has not granted conversation read access.");
        plan.params.types = allowed.join(",");
      }
      const payload = await this.request(plan, credential, toolName, false);
      const output = projectResult(toolName, payload);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      // The ordinary connector lifecycle must settle an ambiguous write as
      // uncertain, rather than treating a returned tool error as completed.
      if (error instanceof SlackMutationOutcomeUnknownError) throw error;
      const message =
        error instanceof SlackInputError ||
        error instanceof SlackProviderError ||
        error instanceof SlackAuthError
          ? error.message
          : "Slack tool failed";
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        ...(error instanceof SlackRateLimitError
          ? {
              structuredContent: {
                error: "rate_limited",
                method: error.method,
                retryAfterSeconds: error.retryAfterSeconds,
              },
            }
          : {}),
      };
    }
  }

  private async resolve(
    method: string,
    toolName: string | undefined,
    forceRefresh: boolean,
  ): Promise<Credential> {
    const result = await this.options.resolveCredential({
      workspaceId: this.options.workspaceId,
      serverId: this.options.serverId,
      connectionRef: this.options.connectionRef,
      destinationUrl: `${SLACK_REST_API_BASE}${method}`,
      forceRefresh,
      ...(toolName ? { toolName } : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
    if (result.status === "auth_needed") {
      await this.reportAuthNeeded(result, toolName);
      throw new SlackAuthError("Authentication required for Slack. Reconnect your account.");
    }
    if (!result.grantedScopes)
      throw new SlackAuthError(
        "Slack granted permissions are unavailable. Reconnect your account.",
      );
    if (this.identity && this.identity.connectionId !== result.connectionId)
      throw new SlackAuthError("Slack connection changed during this attempt.");
    this.options.onResolvedConnectionId?.(result.connectionId);
    return result;
  }

  private async verifyIdentity(toolName?: string): Promise<void> {
    const credential = await this.resolve("auth.test", toolName, false);
    const payload = await this.request(
      { method: "auth.test", params: {}, mutation: false },
      credential,
      toolName,
      false,
    );
    if (
      typeof payload.team_id !== "string" ||
      typeof payload.user_id !== "string" ||
      !payload.team_id ||
      !payload.user_id ||
      payload.bot_id
    ) {
      throw new SlackAuthError("Slack personal connection requires a valid user account.");
    }
    if (
      this.identity &&
      (this.identity.teamId !== payload.team_id || this.identity.userId !== payload.user_id)
    ) {
      throw new SlackAuthError(
        "Slack account changed during this attempt. Start a new turn after reconnecting.",
      );
    }
    this.identity = {
      teamId: payload.team_id,
      userId: payload.user_id,
      connectionId: credential.connectionId,
    };
  }

  private async request(
    plan: Plan,
    credential: Credential,
    toolName: string | undefined,
    refreshed: boolean,
  ): Promise<Payload> {
    const url = new URL(`${SLACK_REST_API_BASE}${plan.method}`);
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (!plan.mutation)
      for (const [name, value] of Object.entries(plan.params))
        url.searchParams.set(name, String(value));
    if (plan.method !== "auth.test" && !this.identity)
      throw new SlackAuthError("Slack account identity is unavailable.");
    if (this.identity) {
      if (!this.options.slackRateLimit && HISTORY_METHODS.has(plan.method))
        throw new SlackProviderError(
          "Slack history rate-limit coordination is unavailable. Try again later.",
        );
      if (this.options.slackRateLimit) {
        const retryAfter = await this.options.slackRateLimit(this.identity.teamId, plan.method);
        if (!Number.isFinite(retryAfter) || retryAfter < 0)
          throw new SlackProviderError(
            "Slack rate-limit coordination is unavailable. Try again later.",
          );
        if (retryAfter > 0) throw new SlackRateLimitError(plan.method, retryAfter);
      }
    }
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new SlackAuthError("Slack connection authority is no longer available.");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: plan.mutation ? "POST" : "GET",
        headers: {
          ...credential.headers,
          ...(plan.mutation ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        ...(plan.mutation ? { body: JSON.stringify(plan.params) } : {}),
        redirect: "error",
        signal: deadline,
      });
    } catch {
      if (plan.mutation)
        throw new SlackMutationOutcomeUnknownError(
          "Slack message submission failed; outcome is uncertain. Check Slack before sending again.",
        );
      throw new SlackProviderError("Slack request could not be completed. Try again later.");
    }
    if (response.status === 429) {
      const retryAfter = parseSlackRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      if (this.identity && this.options.slackRateLimit)
        await this.options.slackRateLimit(this.identity.teamId, plan.method, retryAfter);
      throw new SlackRateLimitError(plan.method, retryAfter);
    }
    let payload: Payload;
    try {
      if (response.status === 401) await response.body?.cancel().catch(() => undefined);
      const value =
        response.status === 401
          ? { ok: false, error: "invalid_auth" }
          : await readResponseJsonBounded<unknown>(
              response,
              RESPONSE_MAX_BYTES,
              "Slack REST response",
              { signal: deadline },
            );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid Slack response");
      payload = value as Payload;
    } catch {
      if (plan.mutation)
        throw new SlackMutationOutcomeUnknownError(
          "Slack returned an unreadable response after submission; outcome is uncertain. Check Slack before sending again.",
        );
      throw new SlackProviderError("Slack returned an unreadable response.");
    }
    if (
      response.status === 401 ||
      (payload.ok === false && AUTH_ERRORS.has(String(payload.error)))
    ) {
      if (!plan.mutation && !refreshed) {
        const renewed = await this.resolve(plan.method, toolName, true);
        return await this.request(plan, renewed, toolName, true);
      }
      await this.reportAuthNeeded(
        {
          status: "auth_needed",
          reason: "expired",
          providerDomain: "slack.com",
          connectionId: credential.connectionId,
        },
        toolName,
      ).catch(() => undefined);
      if (plan.mutation)
        throw new SlackMutationOutcomeUnknownError(
          "Slack authentication failed after submission; outcome is uncertain. Check Slack before sending again.",
        );
      throw new SlackAuthError("Authentication required for Slack. Reconnect your account.");
    }
    if (!response.ok || payload.ok !== true) {
      const providerCode =
        typeof payload.error === "string" && /^[a-z0-9_]{1,80}$/u.test(payload.error)
          ? payload.error
          : `http_${response.status}`;
      if (plan.mutation && response.status >= 500)
        throw new SlackMutationOutcomeUnknownError(
          "Slack returned a server error after submission; outcome is uncertain. Check Slack before sending again.",
        );
      throw new SlackProviderError(
        `Slack request failed: ${providerCode}${providerCode === "missing_scope" ? ". Reconnect to grant the required permissions." : ""}`,
      );
    }
    return payload;
  }

  private async reportAuthNeeded(
    result: Extract<CredentialResult, { status: "auth_needed" }>,
    toolName?: string,
  ): Promise<void> {
    await this.options.onAuthNeeded?.({
      serverId: this.options.serverId,
      ...(toolName ? { toolName } : {}),
      providerDomain: result.providerDomain,
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(result.resource ? { resource: result.resource } : {}),
      ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
      ...(result.authoritySource === "host" || this.options.connectionRef.authoritySource === "host"
        ? { authoritySource: "host" as const }
        : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
  }
}

export const SLACK_REST_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  SlackRestMcpBridgeConfig,
  SlackRestMcpBridgeContext
> = Object.freeze({
  adapterId: "slack-rest",
  matches: (config: SlackRestMcpBridgeConfig) =>
    isOfficialSlackMcpConfig(config.url, config.connectionRef),
  create: (config: SlackRestMcpBridgeConfig, context: SlackRestMcpBridgeContext) => {
    if (!config.connectionRef) throw new Error("Slack REST bridge requires a connection reference");
    return new SlackRestMcpServer({ ...context, connectionRef: config.connectionRef });
  },
});

export function slackRestToolIsMutation(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName);
}

function requestPlan(toolName: string, input: Record<string, unknown>): Plan {
  const schemas = slackRestMcpToolsForScopes([
    ...Object.values(SLACK_CONVERSATION_READ_SCOPE_BY_TYPE),
    "channels:history",
    "users:read",
    "im:write",
    "chat:write",
  ]);
  const schema = schemas.find((entry) => entry.name === toolName);
  if (!schema) throw new SlackInputError(`Unsupported Slack tool: ${toolName}`);
  for (const key of Object.keys(input))
    if (!Object.hasOwn(schema.inputSchema.properties, key))
      throw new SlackInputError(`Unsupported Slack argument: ${key}`);
  const params: Plan["params"] = {};
  const copyString = (name: string, required = false, max = 4096) => {
    if (input[name] === undefined && !required) return;
    params[name] = boundedString(input[name], name, max);
  };
  const copyTimestamp = (name: string, required = false) => {
    copyString(name, required, 40);
    if (params[name] !== undefined && !/^\d{1,20}\.\d{1,10}$/u.test(String(params[name])))
      throw new SlackInputError(`${name} must be a Slack message timestamp`);
  };
  const copyBoolean = (name: string, defaultValue: boolean) => {
    if (input[name] !== undefined && typeof input[name] !== "boolean")
      throw new SlackInputError(`${name} must be a boolean`);
    params[name] = input[name] === undefined ? defaultValue : (input[name] as boolean);
  };
  if ("channel" in schema.inputSchema.properties) {
    copyString("channel", true, 80);
    if (!/^[CDG][A-Z0-9]+$/u.test(String(params.channel)))
      throw new SlackInputError("channel must be a Slack conversation ID");
  }
  if ("user" in schema.inputSchema.properties) {
    copyString("user", true, 80);
    if (!/^[UW][A-Z0-9]+$/u.test(String(params.user)))
      throw new SlackInputError("user must be a Slack user ID");
  }
  if ("cursor" in schema.inputSchema.properties) copyString("cursor");
  if ("limit" in schema.inputSchema.properties) {
    const maximum =
      toolName === "slack_read_channel" || toolName === "slack_read_thread" ? 15 : 100;
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > maximum)
    )
      throw new SlackInputError(`limit must be an integer between 1 and ${maximum}`);
    params.limit = input.limit === undefined ? maximum : (input.limit as number);
  }
  switch (toolName) {
    case "slack_list_channels": {
      const types = input.types ?? Object.keys(SLACK_CONVERSATION_READ_SCOPE_BY_TYPE);
      if (
        !Array.isArray(types) ||
        types.length < 1 ||
        types.length > 4 ||
        types.some(
          (type) =>
            typeof type !== "string" || !Object.hasOwn(SLACK_CONVERSATION_READ_SCOPE_BY_TYPE, type),
        )
      )
        throw new SlackInputError("types must contain 1-4 valid Slack conversation types");
      params.types = [...new Set(types)].join(",");
      copyBoolean("exclude_archived", true);
      return { method: "conversations.list", params, mutation: false };
    }
    case "slack_get_channel_info":
      return { method: "conversations.info", params, mutation: false };
    case "slack_list_channel_members":
      return { method: "conversations.members", params, mutation: false };
    case "slack_list_users":
      return { method: "users.list", params, mutation: false };
    case "slack_get_user_info":
      return { method: "users.info", params, mutation: false };
    case "slack_read_channel":
      copyTimestamp("oldest");
      copyTimestamp("latest");
      copyBoolean("inclusive", false);
      return { method: "conversations.history", params, mutation: false };
    case "slack_read_thread":
      copyTimestamp("ts", true);
      return { method: "conversations.replies", params, mutation: false };
    case "slack_open_dm":
      params.users = params.user!;
      delete params.user;
      return { method: "conversations.open", params, mutation: true };
    case "slack_send_message":
      copyString("text", true, 40_000);
      copyTimestamp("thread_ts");
      copyBoolean("unfurl_links", false);
      copyBoolean("unfurl_media", false);
      return { method: "chat.postMessage", params, mutation: true };
    default:
      throw new SlackInputError(`Unsupported Slack tool: ${toolName}`);
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\0/u.test(value))
    throw new SlackInputError(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function parseSlackRetryAfter(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(Math.min(seconds, 86400)) : 60;
}
function projectResult(toolName: string, payload: Payload): Record<string, unknown> {
  if (toolName === "slack_send_message")
    return { channel: payload.channel, ts: payload.ts, message: payload.message };
  const { ok: _ok, ...result } = payload;
  return result;
}
class SlackInputError extends Error {}
class SlackAuthError extends Error {}
class SlackProviderError extends Error {}
class SlackMutationOutcomeUnknownError extends IntegrationInvocationError {
  constructor(message: string) {
    super("slack_mutation_outcome_unknown", message, "unknown", false);
  }
}
class SlackRateLimitError extends SlackProviderError {
  constructor(
    readonly method: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Slack ${method} is rate limited. Try again in ${Math.ceil(retryAfterSeconds)} seconds.`);
  }
}
