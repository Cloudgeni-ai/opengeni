import type { MCPServer } from "@openai/agents";
import {
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import {
  classifyNangoTool,
  NANGO_DEFAULT_API_BASE_URL,
  nangoApiUrl,
  nangoIntegrationKeyFromProviderDomain,
  nangoToolsIntegrationKeyFromMcpUrl,
  nangoToolsMcpUrl,
  selectNangoTools,
  type NangoIntegrationDefinition,
  type NangoToolDescriptor,
} from "@opengeni/contracts/nango";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { ResolveConnectionCredentialInput, ResolveConnectionCredentialResult } from "./index";
import { NANGO_PROXY_TRANSPORTS, type NangoUsageRecorder } from "./nango-transport";

/**
 * Generic in-process MCP bridge for config-only Nango integrations (LinkedIn,
 * X and future ones added by the operator switch alone; docs/nango.md).
 *
 * Tools are the integration's deployed Nango tools/actions: their names,
 * descriptions and input JSON schemas come from Nango, filtered by the
 * operator definition's allowlist. Reads are annotated read-only and writes
 * destructive, so the ordinary approval defaults apply (writes ask first).
 * Calls run through `POST /connections/{id}/tools/{name}/calls`; a write is
 * never replayed after it may have reached Nango.
 */

const MAX_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024;
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

export type NangoToolsMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef | undefined;
};

export type NangoToolsMcpBridgeContext = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  resolveCredential: (
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
  recordNangoUsage?: NangoUsageRecorder;
  /** Operator definitions of the Nango-backed integrations for this turn. */
  nangoIntegrationDefinitions?: ReadonlyMap<string, NangoIntegrationDefinition>;
  /** The deployment's Nango API base; the bridge's only destination. */
  nangoApiBaseUrl?: string;
};

type ToolResult = Awaited<ReturnType<NonNullable<MCPServer["callToolResult"]>>>;
type ListedTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];
type OkCredential = Extract<ResolveConnectionCredentialResult, { status: "ok" }>;

export function isNangoToolsMcpConfig(config: NangoToolsMcpBridgeConfig): boolean {
  const key = nangoToolsIntegrationKeyFromMcpUrl(config.url);
  return (
    key !== null &&
    nangoIntegrationKeyFromProviderDomain(config.connectionRef?.providerDomain) === key &&
    config.connectionRef?.kind === "oauth2" &&
    config.connectionRef.subjectScope === "subject"
  );
}

class NangoToolOutcomeUnknownError extends Error {
  readonly code = 40102;
  readonly connectorActionOutcome = "uncertain";
  readonly retryable = false;
  constructor(toolName: string) {
    super(
      `${toolName} was submitted but its outcome is uncertain. Check the result before trying again.`,
    );
  }
}

function errorResult(text: string, code: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: {
      error: {
        connectorActionOutcome: "not_executed",
        outcomeUnknown: false,
        code,
        retryable: false,
      },
    },
  };
}

export class NangoToolsMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge;
  private readonly integrationKey: string;
  private readonly fetchImpl: FetchLike;
  private tools: Map<string, NangoToolDescriptor & { group: "read" | "write" }> | null = null;

  constructor(
    private readonly config: NangoToolsMcpBridgeConfig,
    private readonly context: NangoToolsMcpBridgeContext,
  ) {
    this.integrationKey = nangoToolsIntegrationKeyFromMcpUrl(config.url)!;
    this.name = `opengeni-nango-${this.integrationKey}`;
    this.fetchImpl = context.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.bridge = defineLocalMcpBridgeDescriptor({
      adapterId: NANGO_TOOLS_MCP_BRIDGE_ADAPTER_ID,
      providerId: `nango-${this.integrationKey}`,
      catalogIdentity: `mcp:${nangoToolsMcpUrl(this.integrationKey)}`,
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [
        {
          origin: new URL(context.nangoApiBaseUrl ?? NANGO_DEFAULT_API_BASE_URL).origin,
          pathPrefix: "/",
        },
      ],
    });
  }

  private get definition(): NangoIntegrationDefinition {
    return this.context.nangoIntegrationDefinitions?.get(this.integrationKey) ?? {};
  }

  private async resolve(toolName?: string): Promise<OkCredential | null> {
    const result = await this.context.resolveCredential({
      workspaceId: this.context.workspaceId,
      serverId: this.context.serverId,
      connectionRef: this.config.connectionRef!,
      destinationUrl: nangoToolsMcpUrl(this.integrationKey),
      forceRefresh: false,
      acceptedTransports: NANGO_PROXY_TRANSPORTS,
      ...(toolName ? { toolName } : {}),
      ...(this.context.subjectId ? { subjectId: this.context.subjectId } : {}),
    });
    if (result.status === "auth_needed") {
      await this.context.onAuthNeeded?.({
        ...result,
        serverId: this.context.serverId,
        ...(toolName ? { toolName } : {}),
        ...(this.context.subjectId ? { subjectId: this.context.subjectId } : {}),
      });
      return null;
    }
    if (!result.proxy) return null;
    this.context.onResolvedConnectionId?.(result.connectionId);
    return result;
  }

  async connect(): Promise<void> {
    if (!(await this.resolve())) throw new Error("Authentication required for this connection");
  }
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {
    this.tools = null;
  }

  private async loadTools(): Promise<
    Map<string, NangoToolDescriptor & { group: "read" | "write" }>
  > {
    if (this.tools) return this.tools;
    const credential = await this.resolve();
    if (!credential?.proxy) throw new Error("Authentication required for this connection");
    const listed: NangoToolDescriptor[] = [];
    for (let page = 0; page < 10; page += 1) {
      const url = nangoApiUrl(
        credential.proxy.baseUrl,
        `/integrations/${encodeURIComponent(credential.proxy.providerConfigKey)}/functions?page=${page}&limit=100`,
      );
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: credential.headers.authorization ?? "",
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      });
      const body = await readResponseJsonBounded<{
        data?: unknown[];
        pagination?: { total?: unknown };
      }>(response, MAX_TOOL_RESPONSE_BYTES, "Nango tools");
      if (!response.ok) throw new Error(`Nango tools could not be listed (${response.status})`);
      for (const entry of body.data ?? []) {
        const raw = entry as Record<string, unknown>;
        if ((raw.type !== "tool" && raw.type !== "action") || raw.enabled === false) continue;
        if (typeof raw.name !== "string") continue;
        const schema = (raw.input_json_schema ?? raw.json_schema) as
          | Record<string, unknown>
          | null
          | undefined;
        const endpoint = raw.endpoint as { method?: unknown } | undefined;
        const method =
          typeof raw.method === "string"
            ? raw.method
            : typeof endpoint?.method === "string"
              ? endpoint.method
              : undefined;
        listed.push({
          name: raw.name,
          description:
            typeof raw.description === "string" && raw.description.trim()
              ? raw.description.slice(0, 4000)
              : raw.name,
          inputSchema:
            schema && typeof schema === "object" && !Array.isArray(schema)
              ? schema
              : { type: "object", properties: {} },
          ...(method ? { method } : {}),
        });
      }
      const total = typeof body.pagination?.total === "number" ? body.pagination.total : 0;
      if ((page + 1) * 100 >= total) break;
    }
    const definition = this.definition;
    this.tools = new Map(
      selectNangoTools(listed, definition).map((tool) => [
        tool.name,
        { ...tool, group: classifyNangoTool(tool, definition) },
      ]),
    );
    return this.tools;
  }

  async listTools(): Promise<ListedTool[]> {
    const tools = await this.loadTools();
    return [...tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: {},
        ...tool.inputSchema,
      } as ListedTool["inputSchema"],
      annotations: {
        readOnlyHint: tool.group === "read",
        destructiveHint: tool.group === "write",
        idempotentHint: tool.group === "read",
        openWorldHint: true,
      },
    })) as ListedTool[];
  }

  async callTool(name: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(name, args)).content;
  }

  async callToolResult(
    name: string,
    args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<ToolResult> {
    options?.signal?.throwIfAborted();
    const tool = (await this.loadTools()).get(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`, "invalid_input");
    const credential = await this.resolve(name);
    if (!credential?.proxy)
      return errorResult("Authentication required for this connection", "authentication_required");
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      return errorResult("Authentication required for this connection", "authentication_required");
    const proxy = credential.proxy;
    const payload = JSON.stringify({ input: args ?? {} });
    const startedAt = Date.now();
    const report = (httpStatus: number | null, responseBytes: number) => {
      try {
        this.context.recordNangoUsage?.({
          connectionId: credential.connectionId,
          integrationKey: proxy.integrationKey,
          providerConfigKey: proxy.providerConfigKey,
          nangoConnectionId: proxy.nangoConnectionId,
          kind: "tool_call",
          toolName: name,
          httpMethod: "POST",
          httpStatus,
          requestBytes: new TextEncoder().encode(payload).byteLength,
          responseBytes,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Usage accounting never affects the call.
      }
    };
    const write = tool.group === "write";
    let response: Response;
    try {
      response = await this.fetchImpl(
        nangoApiUrl(
          proxy.baseUrl,
          `/connections/${encodeURIComponent(proxy.nangoConnectionId)}/tools/${encodeURIComponent(name)}/calls`,
        ),
        {
          method: "POST",
          headers: {
            authorization: credential.headers.authorization ?? "",
            "provider-config-key": proxy.providerConfigKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: payload,
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(CALL_TIMEOUT_MS),
            ...(options?.signal ? [options.signal] : []),
          ]),
        },
      );
    } catch {
      report(null, 0);
      if (write) throw new NangoToolOutcomeUnknownError(name);
      return errorResult(`${name} could not be reached. Try again.`, "tool_failed");
    }
    let read: { text: string; bytes: number; tooLarge: boolean };
    try {
      read = await readBoundedResponseText(response, MAX_TOOL_RESPONSE_BYTES);
    } catch {
      report(response.status, 0);
      if (write) throw new NangoToolOutcomeUnknownError(name);
      return errorResult(
        `${name} returned an unreadable response (${response.status}).`,
        "tool_failed",
      );
    }
    report(response.status, read.bytes);
    if (read.tooLarge) {
      // A write that answered 2xx already ran; never invite a retry.
      if (write && response.ok)
        return {
          content: [{ type: "text", text: `${name} completed; its output was too large to show.` }],
          structuredContent: { completed: true, outputOmitted: true },
        };
      if (write) throw new NangoToolOutcomeUnknownError(name);
      return errorResult(`${name} returned too much data.`, "tool_failed");
    }
    const text = read.text;
    let output: unknown = text;
    try {
      output = text ? JSON.parse(text) : {};
    } catch {
      // Plain-text output stays text.
    }
    if (!response.ok) {
      // Only a clear refusal before the function ran means nothing happened;
      // anything else (a runtime error, a timeout, 5xx) may have had effects.
      if (write && !nangoRefusedBeforeExecution(response.status, output))
        throw new NangoToolOutcomeUnknownError(name);
      const message =
        (output as { error?: { message?: unknown } } | null)?.error?.message ??
        `${name} failed (${response.status}).`;
      return errorResult(
        String(message).slice(0, 2000),
        response.status === 401 || response.status === 403
          ? "authentication_required"
          : "tool_failed",
      );
    }
    const structured =
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : { result: output };
    return {
      content: [
        { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
      ],
      structuredContent: structured,
    };
  }
}

/**
 * Whether a failed Nango call was refused before its function ran: the call
 * was not authorized, the tool or connection is unknown, the input failed
 * validation, or it was rate limited. A function runtime error, a timeout or
 * any other failure may have had effects.
 */
export function nangoRefusedBeforeExecution(status: number, body: unknown): boolean {
  const rawCode = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const code = typeof rawCode === "string" ? rawCode.toLowerCase() : "";
  if (/runtime|script|function_|timeout|timed_out|failure|internal/u.test(code)) return false;
  if (status === 401 || status === 403 || status === 404 || status === 429) return true;
  if (status === 400 || status === 422)
    return /^(invalid_|missing_|unknown_|bad_request|validation|not_found)|_not_found$|_invalid$/u.test(
      code,
    );
  return false;
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; tooLarge: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: "", bytes, tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes, tooLarge: false };
}

export const NANGO_TOOLS_MCP_BRIDGE_ADAPTER_ID = "nango-tools";

export const NANGO_TOOLS_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  NangoToolsMcpBridgeConfig,
  NangoToolsMcpBridgeContext
> = Object.freeze({
  adapterId: NANGO_TOOLS_MCP_BRIDGE_ADAPTER_ID,
  matches: isNangoToolsMcpConfig,
  create: (config: NangoToolsMcpBridgeConfig, context: NangoToolsMcpBridgeContext) =>
    new NangoToolsMcpServer(config, context),
});
