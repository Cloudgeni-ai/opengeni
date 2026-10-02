import { createHash, randomUUID } from "node:crypto";
import { applyClaudeCodeIdentity } from "./claude-code-identity";
import { AnthropicRequestError } from "./anthropic-request-error";
import {
  protocol,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from "@openai/agents";
import { claudeNativeModelProfile, type ResolvedModelProvider } from "@opengeni/config";

type Json = Record<string, any>;
type Message = { role: "user" | "assistant" | "system"; content: Json[] };

export class AnthropicProtocolError extends Error {
  readonly code = "anthropic_protocol_error";
}

/** Closed provider rejections carry authored copy, never arbitrary response text. */
export class AnthropicProviderRejection extends Error {
  readonly name = "AnthropicProviderRejection";
  constructor(
    readonly code:
      | "anthropic_model_access_suspended"
      | "anthropic_permission_denied"
      | "content_policy_violation",
    readonly status: number,
    readonly request_id?: string,
    readonly suspendedUntil?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(
      code === "anthropic_model_access_suspended"
        ? suspendedUntil
          ? `Claude suspended access to this model for the connected account until ${suspendedUntil.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC")}. Try again after that time.`
          : "Claude suspended access to this model for the connected account. Signing in again will not lift this restriction."
        : code === "content_policy_violation"
          ? "Claude blocked this request through its safety systems. Automatic retries stopped."
          : "Claude denied this request (HTTP 403). Check the connected account's permissions.",
    );
  }
}

function suspensionDeadline(error: Json): string | undefined {
  if (typeof error.message !== "string") return undefined;
  const raw =
    /^model: "[A-Za-z0-9._:/-]{1,128}" is suspended for this organization until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/.exec(
      error.message,
    )?.[1];
  if (!raw) return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return undefined;
  const normalized = date.toISOString();
  return normalized.replace(/\.000Z$/, "Z") === raw.replace(/\.000Z$/, "Z")
    ? normalized
    : undefined;
}

function providerRejection(
  status: number,
  detail: unknown,
  responseHeaders: Headers,
): AnthropicProviderRejection | undefined {
  if (status !== 403) return undefined;
  const requestId = responseHeaders.get("request-id") ?? undefined;
  const headers = responseHeaders.has("retry-after")
    ? { "retry-after": responseHeaders.get("retry-after")! }
    : {};
  const error =
    detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Json) : {};
  if (error.type === "permission_error" && error.details?.error_code === "model_access_suspended")
    return new AnthropicProviderRejection(
      "anthropic_model_access_suspended",
      status,
      requestId,
      suspensionDeadline(error),
      headers,
    );
  return new AnthropicProviderRejection(
    "anthropic_permission_denied",
    status,
    requestId,
    undefined,
    headers,
  );
}

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnthropicProtocolError("Expected an object in the Claude protocol");
  }
  return value as Json;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AnthropicProtocolError(`Missing Claude ${field}`);
  return value;
}

/** Error text is diagnostic only: never delay a known HTTP failure indefinitely. */
async function readErrorDetail(
  body: Response["body"],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // One budget for the entire diagnostic drain, including slow trickles. This
  // does not limit successful model requests, streams, or agent execution.
  const deadline = new Promise<undefined>((resolve, reject) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    if (signal) {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    let bytes = 0;
    while (bytes < 65536) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk || chunk.done) break;
      detail += decoder.decode(chunk.value.subarray(0, 65536 - bytes), { stream: true });
      bytes += chunk.value.byteLength;
    }
  } catch {
    // A truncated/erroring diagnostic body must not hide status/Retry-After.
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    // Cancel immediately, but do not await untrusted transport cleanup: its
    // promise can itself stall after the diagnostic deadline or caller abort.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  return detail;
}

export function anthropicToolName(name: string, namespace?: string): string {
  if (!namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  const identity = JSON.stringify([namespace ?? null, name]);
  return "og_" + createHash("sha256").update(identity).digest("hex").slice(0, 60);
}
function toolNames(request: ModelRequest): Map<string, { name: string; namespace?: string }> {
  const names = new Map<string, { name: string; namespace?: string }>();
  const add = (wireName: string, identity: { name: string; namespace?: string }) => {
    if (names.has(wireName)) throw new AnthropicProtocolError("Duplicate Claude wire tool name");
    names.set(wireName, identity);
  };
  for (const tool of request.tools)
    if (tool.type === "function")
      add(anthropicToolName(tool.name, tool.namespace), {
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
      });
  for (const handoff of request.handoffs)
    add(anthropicToolName(handoff.toolName), { name: handoff.toolName });
  return names;
}
function imageSource(value: unknown): Json {
  if (typeof value === "object" && value !== null) {
    const image = object(value);
    if (image.data !== undefined) {
      return {
        type: "base64",
        media_type: image.mediaType ?? "image/png",
        data:
          typeof image.data === "string" ? image.data : Buffer.from(image.data).toString("base64"),
      };
    }
    if (image.url) return imageSource(image.url);
    throw new AnthropicProtocolError(
      "Claude requires image bytes or a URL, not a provider file ID",
    );
  }
  const url = text(value, "image");
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]+)$/.exec(url);
  if (data) return { type: "base64", media_type: data[1], data: data[2] };
  if (!/^https?:\/\//.test(url))
    throw new AnthropicProtocolError("Unsupported Claude image source");
  return { type: "url", url };
}

function contentBlocks(value: unknown): Json[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.map((entry) => {
    const block = object(entry);
    if (["text", "input_text", "output_text", "refusal"].includes(block.type)) {
      return { type: "text", text: text(block.text ?? block.refusal, "text") };
    }
    if (["image", "input_image"].includes(block.type)) {
      return {
        type: "image",
        source: imageSource(block.image ?? block.imageUrl ?? block.image_url),
      };
    }
    throw new AnthropicProtocolError(`Unsupported Claude content block: ${block.type}`);
  });
}

/** Request-local projection only. Never mutate canonical conversation items. */
export function anthropicMessages(input: ModelRequest["input"]): Message[] {
  const messages: Message[] = [];
  const append = (role: Message["role"], content: Json[]) => {
    if (!content.length) return;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  const items = typeof input === "string" ? [{ role: "user", content: input }] : input;
  for (const raw of items) {
    const item = object(raw);
    switch (item.type ?? "message") {
      case "message": {
        const role = item.role === "developer" ? "system" : item.role;
        if (!["user", "assistant", "system"].includes(role))
          throw new AnthropicProtocolError(`Unsupported Claude role: ${role}`);
        append(role, contentBlocks(item.content));
        break;
      }
      case "function_call": {
        const args =
          typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        append("assistant", [
          {
            type: "tool_use",
            id: text(item.callId ?? item.call_id, "tool ID"),
            name: anthropicToolName(text(item.name, "tool name"), item.namespace),
            input: object(args),
          },
        ]);
        break;
      }
      case "function_call_result": {
        append("user", [
          {
            type: "tool_result",
            tool_use_id: text(item.callId ?? item.call_id, "tool result ID"),
            content: contentBlocks(item.output),
            ...(item.providerData?.anthropic?.is_error ? { is_error: true } : {}),
          },
        ]);
        break;
      }
      case "reasoning": {
        const block = item.providerData?.anthropic?.block;
        if (block) append("assistant", [structuredClone(object(block))]);
        else if (item.content?.length) append("assistant", contentBlocks(item.content));
        break;
      }
      case "compaction":
        throw new AnthropicProtocolError(
          "Codex remote compaction cannot be continued on Claude. Use portable history.",
        );
      default:
        // Preserve foreign provider items as transcript evidence, never as instructions or executable calls.
        append("assistant", [
          {
            type: "text",
            text: `[OpenGeni historical ${item.type} fact]\n${JSON.stringify(item)}`,
          },
        ]);
    }
  }
  // Validate adjacency and pairing before network I/O. Reorder only results within their user message.
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") continue;
    const results = message.content.filter((block) => block.type === "tool_result");
    if (pending.size && message.role !== "user")
      throw new AnthropicProtocolError(
        "Claude tool calls require results before another assistant message",
      );
    for (const result of results) {
      if (!pending.delete(result.tool_use_id))
        throw new AnthropicProtocolError("Claude tool result has no matching pending call");
    }
    if (pending.size) throw new AnthropicProtocolError("Claude tool results are incomplete");
    if (results.length)
      message.content = [
        ...results,
        ...message.content.filter((block) => block.type !== "tool_result"),
      ];
    for (const block of message.content)
      if (block.type === "tool_use") {
        if (pending.has(block.id))
          throw new AnthropicProtocolError("Duplicate Claude tool call ID");
        pending.add(block.id);
      }
  }
  if (pending.size) throw new AnthropicProtocolError("Claude tool results are missing");
  return messages;
}

/**
 * Compaction retains user/system inputs but removes their intervening assistant
 * replies. Anthropic's system beta requires a system message after a user and
 * before an assistant (or at the end), not user -> system -> user. Coalesce each
 * user phase and its system blocks at that boundary, retaining their own roles,
 * exact content and relative order. Never move a system across an assistant.
 */
function placeConversationSystems(messages: Message[]): Message[] {
  const result: Message[] = [];
  let systems: Json[] = [];
  const flush = () => {
    if (!systems.length) return;
    if (result.at(-1)?.role !== "user")
      throw new AnthropicProtocolError("Claude system messages require a preceding user message");
    result.push({ role: "system", content: systems });
    systems = [];
  };
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(...message.content);
      continue;
    }
    if (message.role === "assistant") flush();
    const previous = result.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else result.push(message);
  }
  flush();
  return result;
}

export function buildAnthropicRequest(
  request: ModelRequest,
  model: string,
  provider: Pick<ResolvedModelProvider, "anthropic"> & Partial<Pick<ResolvedModelProvider, "kind">>,
  stream: boolean,
): Json {
  if (request.previousResponseId || request.conversationId)
    throw new AnthropicProtocolError(
      "Claude uses complete local history; remote response references are unsupported",
    );
  if (request.prompt)
    throw new AnthropicProtocolError("OpenAI prompt templates cannot be used with Claude");
  const settings = request.modelSettings;
  const profile = claudeNativeModelProfile(model);
  const managed =
    provider.kind === "anthropic-workspace" ||
    provider.kind === "anthropic-organization" ||
    provider.kind === "claude-subscription-workspace" ||
    provider.kind === "claude-subscription-organization";
  const outputLimit = profile?.maxOutputTokens ?? (managed ? 32_000 : undefined);
  const names = toolNames(request);
  const forcedName = (name: string): string => {
    const matches = [...names].filter(([, identity]) => identity.name === name);
    if (matches.length !== 1)
      throw new AnthropicProtocolError(
        "Claude forced tool must identify exactly one available tool",
      );
    return matches[0]![0];
  };
  let messages = anthropicMessages(request.input);
  if (!messages.length) throw new AnthropicProtocolError("Claude requires at least one message");
  const system = request.systemInstructions
    ? ([{ type: "text", text: request.systemInstructions }] as Json[])
    : [];
  // Initial system/developer instructions belong in the top-level field. Later
  // systems keep their authority within the same assistant-delimited phase.
  while (messages[0]?.role === "system") system.push(...messages.shift()!.content);
  if (!messages.length) throw new AnthropicProtocolError("Claude requires a conversation message");
  messages = placeConversationSystems(messages);
  const tools: Json[] = request.tools.map((tool) => {
    if (tool.type !== "function")
      throw new AnthropicProtocolError(`Claude does not support the ${tool.type} tool transport`);
    return {
      name: anthropicToolName(tool.name, tool.namespace),
      description: tool.description,
      input_schema: structuredClone(tool.parameters),
    };
  });
  for (const handoff of request.handoffs)
    tools.push({
      name: anthropicToolName(handoff.toolName),
      description: handoff.toolDescription,
      input_schema: structuredClone(handoff.inputJsonSchema),
    });
  // Up to four breakpoints: tools, instructions, previous request, current history.
  // No TTL mixing, no global scope, and no marker on signed thinking blocks.
  if (provider.anthropic?.cacheTtl !== "off") {
    const cache = { type: "ephemeral", ttl: provider.anthropic?.cacheTtl ?? "5m" };
    if (tools.length) tools.at(-1)!.cache_control = { ...cache };
    if (system.length) system.at(-1)!.cache_control = { ...cache };
    // Anthropic searches only a bounded number of blocks before a breakpoint.
    // A large parallel tool batch can move the old request prefix outside that
    // window; explicitly retain its boundary before the latest assistant reply.
    let lastAssistant = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === "assistant") {
        lastAssistant = index;
        break;
      }
    }
    const previous = messages
      .slice(0, Math.max(0, lastAssistant))
      .flatMap((message) => message.content)
      .reverse()
      .find((block) => !["thinking", "redacted_thinking"].includes(block.type));
    if (previous) previous.cache_control = { ...cache };
    const last = [...messages.at(-1)!.content]
      .reverse()
      .find((block) => !["thinking", "redacted_thinking"].includes(block.type));
    if (last) last.cache_control = { ...cache };
  }
  const body: Json = {
    model,
    max_tokens: Math.min(
      settings.maxTokens ??
        provider.anthropic?.maxOutputTokens ??
        profile?.maxOutputTokens ??
        32000,
      outputLimit ?? Infinity,
    ),
    messages,
    stream,
  };
  if (system.length) body.system = system;
  if (tools.length) body.tools = tools;
  if (settings.toolChoice && tools.length)
    body.tool_choice =
      settings.toolChoice === "required"
        ? { type: "any" }
        : ["auto", "none"].includes(settings.toolChoice)
          ? { type: settings.toolChoice }
          : { type: "tool", name: forcedName(settings.toolChoice) };
  if (settings.parallelToolCalls === false && tools.length)
    body.tool_choice = {
      ...(body.tool_choice ?? { type: "auto" }),
      disable_parallel_tool_use: true,
    };
  const requestedEffort = settings.reasoning?.effort;
  // Preserve actual native levels; do not silently turn Extra into High.
  const effort = requestedEffort === "minimal" ? "low" : requestedEffort;
  const supportsThinking = profile ? profile.efforts.length > 0 : !managed;
  // Anthropic forbids forced tool selection together with thinking.
  const forcedTool = body.tool_choice?.type === "any" || body.tool_choice?.type === "tool";
  if (supportsThinking && effort && effort !== "none" && !forcedTool) {
    if (profile && !profile.efforts.includes(effort))
      throw new AnthropicProtocolError(
        "The selected Claude model does not support this reasoning effort",
      );
    body.thinking = { type: "adaptive" };
    body.output_config = {
      effort,
    };
  } else if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.topP !== undefined && !body.thinking) body.top_p = settings.topP;
  if (request.outputType !== "text")
    body.output_config = {
      ...body.output_config,
      format: { type: "json_schema", schema: request.outputType.schema },
    };
  return body;
}

function normalizeUsage(raw: Json): Usage {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const cached = count(raw.cache_read_input_tokens);
  const written = count(raw.cache_creation_input_tokens);
  const input = count(raw.input_tokens) + cached + written;
  const output = count(raw.output_tokens);
  return new Usage({
    requests: 1,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokensDetails: {
      cached_tokens: cached,
      cache_write_tokens: written,
      ...(raw.cache_creation?.ephemeral_5m_input_tokens === undefined
        ? {}
        : { cache_write_tokens_5m: count(raw.cache_creation.ephemeral_5m_input_tokens) }),
      ...(raw.cache_creation?.ephemeral_1h_input_tokens === undefined
        ? {}
        : { cache_write_tokens_1h: count(raw.cache_creation.ephemeral_1h_input_tokens) }),
    },
    outputTokensDetails: { reasoning_tokens: count(raw.output_tokens_details?.thinking_tokens) },
  });
}

export function anthropicResponse(
  message: Json,
  requestId?: string,
  names = new Map<string, { name: string; namespace?: string }>(),
): ModelResponse {
  // A refused response can be HTTP 200 with no content blocks. It must not
  // become an empty successful response or admit a tool call from partial output.
  if (message.stop_reason === "refusal")
    throw new AnthropicProviderRejection("content_policy_violation", 200, requestId);
  if (!["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(message.stop_reason))
    throw new AnthropicProtocolError(`Claude response did not finish: ${message.stop_reason}`);
  text(message.id, "message ID");
  if (!Array.isArray(message.content))
    throw new AnthropicProtocolError("Claude response content must be an array");
  const callIds = new Set<string>();
  const output: ModelResponse["output"] = [];
  for (const [index, block] of (message.content as Json[]).entries()) {
    const id = `${message.id}:${index}`;
    switch (block.type) {
      case "text":
        output.push({
          type: "message",
          role: "assistant",
          id,
          status: message.stop_reason === "max_tokens" ? "incomplete" : "completed",
          content: [{ type: "output_text", text: text(block.text, "response text") }],
        });
        break;
      case "tool_use":
        if (callIds.has(block.id))
          throw new AnthropicProtocolError("Duplicate Claude response tool call ID");
        callIds.add(text(block.id, "tool ID"));
        if (message.stop_reason !== "tool_use")
          throw new AnthropicProtocolError("Claude tool call did not finish with tool_use");
        output.push({
          type: "function_call",
          id,
          callId: text(block.id, "tool ID"),
          name: names.get(block.name)?.name ?? text(block.name, "tool name"),
          ...(names.get(block.name)?.namespace
            ? { namespace: names.get(block.name)!.namespace }
            : {}),
          arguments: JSON.stringify(object(block.input)),
          status: "completed",
        });
        break;
      case "thinking":
      case "redacted_thinking":
        if (block.type === "thinking") {
          text(block.thinking, "thinking text");
          text(block.signature, "thinking signature");
        } else text(block.data, "redacted thinking data");
        output.push({
          type: "reasoning",
          id,
          content: block.thinking ? [{ type: "input_text", text: block.thinking }] : [],
          providerData: { anthropic: { block: structuredClone(block) } },
        });
        break;
      default:
        throw new AnthropicProtocolError(`Unsupported Claude response block: ${block.type}`);
    }
  }
  if (message.stop_reason === "tool_use" && callIds.size === 0)
    throw new AnthropicProtocolError("Claude tool_use stop has no tool calls");
  return {
    output,
    usage: normalizeUsage(message.usage ?? {}),
    responseId: message.id,
    ...(requestId ? { requestId } : {}),
    providerData: {
      anthropic: { stopReason: message.stop_reason, usage: message.usage },
      ...(message.stop_reason === "max_tokens"
        ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
        : {}),
    },
  };
}

/** Native Messages transport; retries are owned by the worker, never hidden here. */
export class AnthropicMessagesModel implements Model {
  private readonly fallbackSessionId = randomUUID();
  private readonly promptId = randomUUID();
  private previousRequestId: string | undefined;
  constructor(
    readonly provider: ResolvedModelProvider,
    readonly model: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private async send(request: ModelRequest, stream: boolean): Promise<Response> {
    request.signal?.throwIfAborted();
    const body = buildAnthropicRequest(request, this.model, this.provider, stream);
    const base = this.provider.baseUrl ?? "https://api.anthropic.com/v1";
    const url = new URL(`${base.replace(/\/$/, "")}/messages`);
    for (const [key, value] of Object.entries(this.provider.defaultQuery ?? {}))
      url.searchParams.set(key, value);
    const headers = new Headers(this.provider.defaultHeaders);
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    headers.set("anthropic-version", "2023-06-01");
    if ((claudeNativeModelProfile(this.model)?.contextWindowTokens ?? 0) > 200_000) {
      const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
      betas.add("context-1m-2025-08-07");
      headers.set("anthropic-beta", [...betas].join(","));
    }
    if (body.messages.some((message: Message) => message.role === "system")) {
      const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
      betas.add("mid-conversation-system-2026-04-07");
      headers.set("anthropic-beta", [...betas].join(","));
    }
    if (this.provider.kind !== "anonymous") {
      if (!this.provider.apiKey)
        throw new AnthropicProtocolError("Claude credentials are unavailable");
      if (this.provider.anthropic?.auth === "oauth") {
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${this.provider.apiKey}`);
        const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
        betas.add("oauth-2025-04-20");
        headers.set("anthropic-beta", [...betas].join(","));
      } else {
        headers.delete("authorization");
        headers.set("x-api-key", this.provider.apiKey);
      }
    }
    if (this.provider.anthropic?.auth === "oauth") {
      const identity = this.provider.anthropic.identity;
      if (!identity)
        throw new AnthropicProtocolError(
          "Claude subscription identity is missing. Replace the connection with its Claude account UUID and device ID in Models.",
        );
      const session = request.modelSettings.providerData?.prompt_cache_key;
      const sessionId =
        typeof session === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(session)
          ? session
          : this.fallbackSessionId;
      applyClaudeCodeIdentity(body, headers, url, request, identity, {
        sessionId,
        promptId: this.promptId,
        previousRequestId: this.previousRequestId,
      });
    }
    const response = await this.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (request.signal?.aborted) {
      void response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
    }
    if (!response.ok) {
      const detail = await readErrorDetail(
        response.body,
        Math.min(this.provider.anthropic?.streamIdleTimeoutMs ?? 600000, 5000),
        request.signal,
      );
      const contextExceeded =
        response.status === 400 &&
        /prompt is too long|context_length_exceeded|exceeds.*context window/i.test(detail);
      let providerError: unknown;
      try {
        providerError = JSON.parse(detail).error;
      } catch {
        /* Diagnostics can be truncated. */
      }
      const rejection = providerRejection(response.status, providerError, response.headers);
      if (rejection) throw rejection;
      // Classify the bounded provider detail without leaking echoed prompts or credentials.
      const message = contextExceeded
        ? "Claude context window exceeded"
        : response.status === 401
          ? "Claude credentials expired or were revoked. Replace the key or setup token in Models."
          : "Claude request failed (HTTP " + response.status + ")";
      let source: unknown;
      try {
        source = JSON.parse(detail)?.error;
      } catch {
        // Malformed, truncated or non-JSON bodies retain structural status only.
      }
      throw new AnthropicRequestError(
        message,
        response.status,
        contextExceeded ? "context_length_exceeded" : "anthropic_http_error",
        source,
        response.headers,
      );
    }
    this.previousRequestId = response.headers.get("request-id") ?? undefined;
    return response;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.send(request, false);
    return anthropicResponse(
      object(await response.json()),
      response.headers.get("request-id") ?? undefined,
      toolNames(request),
    );
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const response = await this.send(request, true);
    if (!response.body) throw new AnthropicProtocolError("Claude returned an empty stream");
    const blocks = new Map<number, { block: Json; json: string; stopped: boolean }>();
    let message: Json | undefined;
    let finalDelta = false;
    for await (const event of anthropicSse(
      response.body,
      this.provider.anthropic?.streamIdleTimeoutMs ?? 600000,
      request.signal,
    )) {
      request.signal?.throwIfAborted();
      if (event.type === "error") {
        const kind = event.error?.type;
        // Preserve retry classification without retaining arbitrary provider text.
        const statuses: Record<string, number> = {
          invalid_request_error: 400,
          authentication_error: 401,
          permission_error: 403,
          not_found_error: 404,
          request_too_large: 413,
          rate_limit_error: 429,
          api_error: 500,
          overloaded_error: 529,
        };
        const status = typeof kind === "string" ? (statuses[kind] ?? 502) : 502;
        const rejection = providerRejection(status, event.error, response.headers);
        if (rejection) throw rejection;
        throw Object.assign(new Error(`Claude stream failed (HTTP ${status})`), {
          status,
          code: status === 429 ? "rate_limit_exceeded" : "anthropic_stream_error",
          request_id: response.headers.get("request-id"),
          headers: response.headers.has("retry-after")
            ? { "retry-after": response.headers.get("retry-after")! }
            : {},
          // Keep the structural stream wrapper stable for provider rejection
          // guards while the typed cause keeps provider text private.
          cause: new AnthropicRequestError(
            `Claude stream failed (HTTP ${status})`,
            status,
            status === 429 ? "rate_limit_exceeded" : "anthropic_stream_error",
            event.error,
            response.headers,
          ),
        });
      }
      switch (event.type) {
        case "message_start":
          if (message) throw new AnthropicProtocolError("Duplicate Claude message_start");
          message = object(event.message);
          yield { type: "response_started" };
          break;
        case "content_block_start":
          if (!message || blocks.has(event.index) || finalDelta)
            throw new AnthropicProtocolError("Invalid Claude block start");
          blocks.set(event.index, { block: object(event.content_block), json: "", stopped: false });
          break;
        case "content_block_delta": {
          const state = blocks.get(event.index);
          if (!state || state.stopped)
            throw new AnthropicProtocolError("Claude delta has no open block");
          const delta = object(event.delta);
          const expected = {
            text_delta: "text",
            thinking_delta: "thinking",
            signature_delta: "thinking",
            input_json_delta: "tool_use",
          }[delta.type as string];
          if (expected && state.block.type !== expected)
            throw new AnthropicProtocolError("Claude delta type does not match its content block");
          if (delta.type === "text_delta") {
            state.block.text += text(delta.text, "text delta");
            yield {
              type: "output_text_delta",
              itemId: `${message!.id}:${event.index}`,
              delta: delta.text,
            };
          } else if (delta.type === "thinking_delta") {
            state.block.thinking += text(delta.thinking, "thinking delta");
            yield {
              type: "model",
              event: { type: "anthropic.thinking.delta", delta: delta.thinking },
            };
          } else if (delta.type === "signature_delta")
            state.block.signature =
              (state.block.signature ?? "") + text(delta.signature, "signature delta");
          else if (delta.type === "input_json_delta")
            state.json += text(delta.partial_json, "tool input delta");
          else throw new AnthropicProtocolError(`Unsupported Claude delta: ${delta.type}`);
          break;
        }
        case "content_block_stop": {
          const state = blocks.get(event.index);
          if (!state || state.stopped)
            throw new AnthropicProtocolError("Invalid Claude block stop");
          if (state.block.type === "tool_use" && state.json)
            state.block.input = object(JSON.parse(state.json));
          state.stopped = true;
          break;
        }
        case "message_delta":
          if (!message) throw new AnthropicProtocolError("Claude message_delta without a message");
          Object.assign(message, event.delta);
          message.usage = { ...message.usage, ...event.usage };
          if (message.stop_reason === "refusal")
            throw new AnthropicProviderRejection(
              "content_policy_violation",
              200,
              response.headers.get("request-id") ?? undefined,
            );
          finalDelta = true;
          break;
        case "message_stop": {
          if (!message || !finalDelta || [...blocks.values()].some((state) => !state.stopped))
            throw new AnthropicProtocolError("Claude response ended before its blocks completed");
          message.content = [...blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, state]) => state.block);
          const result = anthropicResponse(
            message,
            response.headers.get("request-id") ?? undefined,
            toolNames(request),
          );
          yield protocol.StreamEventResponseCompleted.parse({
            type: "response_done",
            response: { id: result.responseId!, ...result },
          });
          return;
        }
      }
    }
    throw new AnthropicProtocolError("Claude stream ended without message_stop");
  }
}

/** UTF-8 and SSE boundaries are independent of network chunks. */
export async function* anthropicSse(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs = 600000,
  signal?: AbortSignal,
): AsyncGenerator<Json> {
  if (signal?.aborted) void body.cancel().catch(() => undefined);
  signal?.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        if (signal) {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      });
      const chunk = await Promise.race([
        reader.read(),
        aborted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AnthropicProtocolError("Claude stream timed out waiting for data")),
            idleTimeoutMs,
          );
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      });
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length) yield object(JSON.parse(data.join("\n")));
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (chunk.done) break;
    }
  } finally {
    // A terminal rejection must not wait on untrusted transport cleanup.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
