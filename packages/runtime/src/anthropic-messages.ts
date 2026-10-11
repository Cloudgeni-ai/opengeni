import { createHash, randomUUID } from "node:crypto";
import { applyClaudeCodeIdentity } from "./claude-code-identity";
import { AnthropicRequestError } from "./anthropic-request-error";
import { isCompactionSummary } from "./context-compaction";
import {
  ANTHROPIC_IMAGE_MAX_ENCODED_BYTES,
  ANTHROPIC_REQUEST_MAX_BYTES,
  AnthropicRequestSizeError,
  anthropicRequestSize,
} from "./anthropic-request-size";
import {
  protocol,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from "@openai/agents";
import { claudeNativeModelProfile, type ResolvedModelProvider } from "@opengeni/config";
import { withClaudeModelRequest } from "./claude-subscription-usage";
import { createModelImageSizer } from "./model-image-sizing";
import { projectHistoryForProvider } from "./provider-history-adapter";
import { projectHostedSearchEvidence } from "./hosted-search-evidence";
import { splitStableSystemPromptPrefix } from "./system-prompt-cache-prefix";
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  anthropicWebSearchBlockFact,
  anthropicWebSearchBlocks,
  anthropicWebSearchItem,
  anthropicWebSearchQueries,
  isAnthropicWebSearchItem,
  isHostedWebSearchTool,
} from "./anthropic-web-search";

type Json = Record<string, any>;
type Message = { role: "user" | "assistant" | "system"; content: Json[] };

/**
 * A long server-side search loop can pause; each continuation re-sends the
 * paused content. Bounded like any retry loop so a misbehaving provider cannot
 * hold a turn forever.
 */
export const ANTHROPIC_PAUSE_TURN_MAX_REQUESTS = 8;

export class AnthropicProtocolError extends Error {
  readonly code = "anthropic_protocol_error";
}

/** Preserve documented spend proof, without retaining an arbitrary error body. */
function anthropicSpendLimitCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const value = error as Json;
  if (
    value.type === "rate_limit_error" &&
    value.details?.error_code === "enforced_spend_limit_reached"
  )
    return "enforced_spend_limit_reached";
  if (
    value.type === "invalid_request_error" &&
    typeof value.message === "string" &&
    /^You have reached your specified (?:workspace )?API usage limits\b/.test(value.message)
  )
    return "enforced_spend_limit_reached";
  return undefined;
}

function anthropicHttpSpendLimitCode(detail: string): string | undefined {
  try {
    return anthropicSpendLimitCode(JSON.parse(detail)?.error);
  } catch {
    return undefined;
  }
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
    else if (isHostedWebSearchTool(tool))
      // Claude's server tool owns this wire name; a function tool with the
      // same name would make every request ambiguous.
      add(ANTHROPIC_WEB_SEARCH_TOOL_NAME, { name: ANTHROPIC_WEB_SEARCH_TOOL_NAME });
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

function contentBlocks(value: unknown, options: { citations?: boolean } = {}): Json[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.map((entry) => {
    const block = object(entry);
    if (["text", "input_text", "output_text", "refusal"].includes(block.type)) {
      // Claude's own cited text is replayed with its citations exactly while
      // the cited searches are still native in this request.
      const citations = block.providerData?.anthropic?.citations;
      return {
        type: "text",
        text: text(block.text ?? block.refusal, "text"),
        ...(options.citations && Array.isArray(citations) && citations.length
          ? { citations: structuredClone(citations) }
          : {}),
      };
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

/**
 * Request-local projection only. Never mutate canonical conversation items.
 *
 * `webSearch` is whether this request declares Claude's web search tool.
 * Stored searches are replayed natively only then (Claude rejects a pending
 * search whose tool is missing); otherwise they become readable facts. The
 * tool list changes in that case anyway, so this costs no extra cache.
 */
export function anthropicMessages(
  input: ModelRequest["input"],
  options: { webSearch?: boolean } = {},
): Message[] {
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
        append(
          role,
          contentBlocks(item.content, {
            citations: role === "assistant" && options.webSearch === true,
          }),
        );
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
      case "hosted_tool_call":
        if (isAnthropicWebSearchItem(item)) {
          if (options.webSearch) append("assistant", anthropicWebSearchBlocks(item));
          else
            append("assistant", contentBlocks(object(projectHostedSearchEvidence(item)).content));
          break;
        }
        append("assistant", [
          {
            type: "text",
            text: `[Opengeni historical ${item.type} fact]\n${JSON.stringify(item)}`,
          },
        ]);
        break;
      default:
        // Preserve foreign provider items as transcript evidence, never as instructions or executable calls.
        append("assistant", [
          {
            type: "text",
            text: `[Opengeni historical ${item.type} fact]\n${JSON.stringify(item)}`,
          },
        ]);
    }
  }
  withoutUncontinuableSearches(messages);
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
 * Claude continues a search it has not run yet only in two shapes: the
 * request itself ends with that assistant content (a paused turn), or the
 * next message carries nothing but our tool results (a search deferred behind
 * our own tool calls), answered at the start of the following assistant
 * message. Anything else (a cancelled turn, a steer, a compacted call) would
 * be rejected, so that call, and any result whose call is gone, becomes inert
 * readable text. Every decision depends only on the messages themselves, so a
 * later request reproduces the same prefix.
 */
function withoutUncontinuableSearches(messages: Message[]): void {
  const nativeCalls = new Set<string>();
  const continues = (index: number, id: string): boolean => {
    const next = messages[index + 1];
    if (!next) return true;
    if (
      next.role !== "user" ||
      !next.content.length ||
      next.content.some((block) => block.type !== "tool_result")
    )
      return false;
    const after = messages[index + 2];
    if (!after) return true;
    return (
      after.role === "assistant" &&
      after.content.some(
        (block) => block.type === "web_search_tool_result" && block.tool_use_id === id,
      )
    );
  };
  // Citations index into search results, and a later answer can cite an
  // earlier search. From the first result that became text onward, never
  // send citations whose result may be gone.
  let convertedResult = false;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    message.content = message.content.map((block, position) => {
      if (block.type === "server_tool_use" && block.name === ANTHROPIC_WEB_SEARCH_TOOL_NAME) {
        const answeredHere = message.content
          .slice(position + 1)
          .some(
            (later) => later.type === "web_search_tool_result" && later.tool_use_id === block.id,
          );
        if (answeredHere || continues(index, block.id)) {
          nativeCalls.add(block.id);
          return block;
        }
        return anthropicWebSearchBlockFact(block);
      }
      if (block.type === "web_search_tool_result") {
        if (nativeCalls.has(block.tool_use_id)) return block;
        convertedResult = true;
        return anthropicWebSearchBlockFact(block);
      }
      return block;
    });
    if (convertedResult)
      message.content = message.content.map((block) => {
        if (block.type !== "text" || !("citations" in block)) return block;
        const { citations: _citations, ...plain } = block;
        return plain;
      });
  }
}

/**
 * Compaction retains user/system inputs but removes their intervening assistant
 * replies. Anthropic's system beta requires a system message after a user and
 * before an assistant (or at the end), not user -> system -> user. Coalesce each
 * user phase and its system blocks at that boundary, retaining their own roles,
 * exact content and relative order. A machine-only continuation after an
 * assistant needs a request-local input anchor; it is not a new human message.
 * Never move a system across an assistant.
 */
function placeConversationSystems(messages: Message[]): Message[] {
  const result: Message[] = [];
  let systems: Json[] = [];
  const flush = () => {
    if (!systems.length) return;
    if (result.at(-1)?.role !== "user")
      result.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Opengeni continuation (machine-origin input; no new human message).",
          },
        ],
      });
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
  const input =
    typeof request.input === "string"
      ? request.input
      : (projectHistoryForProvider(request.input, "anthropic-messages") as ModelRequest["input"]);
  const webSearch = request.tools.some(isHostedWebSearchTool);
  let messages = anthropicMessages(input, { webSearch });
  if (!messages.length) throw new AnthropicProtocolError("Claude requires at least one message");
  // A recorded session-independent prefix becomes its own block so it can
  // carry a cache breakpoint (OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT).
  const split = request.systemInstructions
    ? splitStableSystemPromptPrefix(request.systemInstructions)
    : undefined;
  const system = split
    ? ([
        { type: "text", text: split[0] },
        { type: "text", text: split[1] },
      ] as Json[])
    : request.systemInstructions
      ? ([{ type: "text", text: request.systemInstructions }] as Json[])
      : [];
  const stableSystem = split ? system[0] : undefined;
  // Initial system/developer instructions belong in the top-level field. Later
  // systems keep their authority within the same assistant-delimited phase.
  while (messages[0]?.role === "system") system.push(...messages.shift()!.content);
  if (!messages.length) throw new AnthropicProtocolError("Claude requires a conversation message");
  messages = placeConversationSystems(messages);
  const tools: Json[] = request.tools.map((tool) => {
    // Claude's own server-side search, at the agent's tool position so the
    // tools prefix is identical on every request of the conversation.
    if (isHostedWebSearchTool(tool)) return { ...ANTHROPIC_WEB_SEARCH_TOOL };
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
  // A split system adds one after its stable prefix; when all five would apply,
  // the tools breakpoint yields because the stable prefix already covers tools.
  // No TTL mixing, no global scope, and no marker on signed thinking blocks.
  if (provider.anthropic?.cacheTtl !== "off") {
    const cache = { type: "ephemeral", ttl: provider.anthropic?.cacheTtl ?? "5m" };
    if (stableSystem) stableSystem.cache_control = { ...cache };
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
    const marked =
      (stableSystem ? 1 : 0) + (system.length ? 1 : 0) + (previous ? 1 : 0) + (last ? 1 : 0);
    if (tools.length && marked < 4) tools.at(-1)!.cache_control = { ...cache };
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
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = {
      effort,
    };
  } else if (settings.temperature !== undefined) body.temperature = settings.temperature;
  if (settings.topP !== undefined && !body.thinking) body.top_p = settings.topP;
  // Single model calls pass caller stop sequences; agent turns never set them.
  const stopSequences = settings.providerData?.stop_sequences;
  if (
    Array.isArray(stopSequences) &&
    stopSequences.length > 0 &&
    stopSequences.every((value) => typeof value === "string")
  )
    body.stop_sequences = [...stopSequences];
  if (request.outputType !== "text")
    body.output_config = {
      ...body.output_config,
      format: { type: "json_schema", schema: request.outputType.schema },
    };
  return body;
}

function thinkingDropCounts(transformations: unknown): Record<string, number> | undefined {
  if (!Array.isArray(transformations)) return undefined;
  const counts: Record<string, number> = {};
  for (const entry of transformations) {
    if (
      entry?.type !== "thinking_dropped" ||
      ![
        "prefix_binding_mismatch",
        "model_binding_mismatch",
        "organization_binding_mismatch",
      ].includes(entry.reason)
    )
      continue;
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return Object.keys(counts).length ? counts : undefined;
}

/**
 * Usage of one logical response. A paused turn's continuations are separate
 * billed requests, each re-sending the whole prefix: the totals sum them for
 * billing, and the per-request entries keep the final request's input as the
 * real context size.
 */
function normalizeUsage(raw: Json, perRequest: Json[] = []): Usage {
  const usage = requestUsage(raw);
  if (perRequest.length < 2) return usage;
  return new Usage({
    requests: perRequest.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: usage.inputTokensDetails[0],
    outputTokensDetails: usage.outputTokensDetails[0],
    requestUsageEntries: perRequest.map((entry) => {
      const request = requestUsage(entry);
      return {
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        totalTokens: request.totalTokens,
        inputTokensDetails: request.inputTokensDetails[0],
        outputTokensDetails: request.outputTokensDetails[0],
      };
    }),
  });
}

function requestUsage(raw: Json): Usage {
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
  searchQueries: ReadonlyMap<string, string> = new Map(),
  requestUsages: Json[] = [],
): ModelResponse {
  // A refused response can be HTTP 200 with no content blocks. It must not
  // become an empty successful response or admit a tool call from partial output.
  if (message.stop_reason === "refusal")
    throw new AnthropicProviderRejection("content_policy_violation", 200, requestId);
  // pause_turn is continued inside the transport; it only reaches here to
  // replay the paused content on that continuation.
  if (
    !["end_turn", "tool_use", "stop_sequence", "max_tokens", "pause_turn"].includes(
      message.stop_reason,
    )
  )
    throw new AnthropicProtocolError(`Claude response did not finish: ${message.stop_reason}`);
  text(message.id, "message ID");
  if (!Array.isArray(message.content))
    throw new AnthropicProtocolError("Claude response content must be an array");
  const callIds = new Set<string>();
  const output: ModelResponse["output"] = [];
  const content = message.content as Json[];
  for (let index = 0; index < content.length; index += 1) {
    const block = object(content[index]);
    const id = `${message.id}:${index}`;
    switch (block.type) {
      case "text": {
        const citations = Array.isArray(block.citations) ? block.citations : [];
        const part = {
          type: "output_text" as const,
          text: text(block.text, "response text"),
          ...(citations.length
            ? { providerData: { anthropic: { citations: structuredClone(citations) } } }
            : {}),
        };
        // Claude splits a cited answer into many adjacent text blocks. They
        // are one message (one part per block, so replay sends the same
        // blocks); separate messages would make the last fragment the reply.
        const previous = output.at(-1);
        if (content[index - 1]?.type === "text" && previous?.type === "message")
          (previous.content as unknown[]).push(part);
        else
          output.push({
            type: "message",
            role: "assistant",
            id,
            status: message.stop_reason === "max_tokens" ? "incomplete" : "completed",
            content: [part],
          });
        break;
      }
      case "server_tool_use":
      case "web_search_tool_result": {
        if (block.type === "server_tool_use" && block.name !== ANTHROPIC_WEB_SEARCH_TOOL_NAME)
          throw new AnthropicProtocolError(`Unsupported Claude server tool: ${block.name}`);
        if (block.type === "server_tool_use") text(block.id, "server tool ID");
        else text(block.tool_use_id, "server tool result ID");
        // A call and the result Claude ran right after it are one search.
        const next = content[index + 1];
        const pair =
          block.type === "server_tool_use" &&
          next?.type === "web_search_tool_result" &&
          next.tool_use_id === block.id;
        output.push(
          anthropicWebSearchItem({
            id,
            blocks: pair ? [block, next] : [block],
            queriesByCallId: searchQueries,
          }) as ModelResponse["output"][number],
        );
        if (pair) index += 1;
        break;
      }
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
  const droppedThinking = thinkingDropCounts(message.input_transformations);
  const webSearchRequests = message.usage?.server_tool_use?.web_search_requests;
  return {
    output,
    usage: normalizeUsage(message.usage ?? {}, requestUsages),
    responseId: message.id,
    ...(requestId ? { requestId } : {}),
    providerData: {
      anthropic: {
        stopReason: message.stop_reason,
        usage: message.usage,
        ...(droppedThinking ? { thinkingBlocksDropped: droppedThinking } : {}),
        ...(typeof webSearchRequests === "number" && webSearchRequests > 0
          ? { webSearchRequests }
          : {}),
      },
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
  // The same bound applies from the first image onward. A growing conversation
  // must not resize its old prefix when it crosses the many-image threshold.
  private readonly sizeImage = createModelImageSizer(2000, ANTHROPIC_IMAGE_MAX_ENCODED_BYTES);
  constructor(
    readonly provider: ResolvedModelProvider,
    readonly model: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /** Project inline images only; never fetch arbitrary URLs or edit stored history. */
  private async sizeImageBlocks(
    blocks: Json[],
    projection: { resized: boolean },
    signal?: AbortSignal,
  ): Promise<Json[]> {
    const result: Json[] = [];
    for (const block of blocks) {
      signal?.throwIfAborted();
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        result.push({
          ...block,
          content: await this.sizeImageBlocks(block.content, projection, signal),
        });
      } else if (block.type === "image" && block.source?.type === "base64") {
        const image = await this.sizeImage(block.source.data, block.source.media_type);
        if (image.data === block.source.data && image.mediaType === block.source.media_type) {
          result.push(block);
          continue;
        }
        const { cache_control: cache, ...unmarked } = block;
        projection.resized = true;
        result.push({
          ...unmarked,
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        });
        // Preserve the mapping for tools whose coordinates refer to the original
        // frame. This note is deterministic and belongs inside the same cache prefix.
        result.push({
          type: "text",
          text: `Image resized for transport: oriented original ${image.originalWidth}x${image.originalHeight}; encoded image ${image.width}x${image.height}. For pixel coordinates, account for any further provider resizing and use the coordinate system required by the tool.`,
          ...(cache ? { cache_control: cache } : {}),
        });
      } else result.push(block);
    }
    return result;
  }

  private async prepare(request: ModelRequest, stream: boolean) {
    request.signal?.throwIfAborted();
    const body = buildAnthropicRequest(request, this.model, this.provider, stream);
    const projection = { resized: false };
    for (const message of body.messages) {
      message.content = await this.sizeImageBlocks(message.content, projection, request.signal);
    }
    request.signal?.throwIfAborted();
    const base = this.provider.baseUrl ?? "https://api.anthropic.com/v1";
    const url = new URL(`${base.replace(/\/$/, "")}/messages`);
    for (const [key, value] of Object.entries(this.provider.defaultQuery ?? {}))
      url.searchParams.set(key, value);
    const headers = new Headers(this.provider.defaultHeaders);
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    headers.set("anthropic-version", "2023-06-01");
    // A portable checkpoint (including a standalone tool-less summary request)
    // rewrites the prefix. Image-policy upgrades can do so too. Keep signed
    // blocks verbatim and use the provider's explicit invalid-block reset, never
    // strip signatures ourselves. Retained checkpoints/images make this choice
    // reproducible after worker/model-instance restarts. A summary request that
    // reuses the prepared ordinary prefix keeps its thinking mode unchanged (the
    // mode is part of the cache key) and only opts its existing thinking into
    // the reset, in case the checkpoint history differs from what was sent.
    const preparedCompaction =
      request.modelSettings.providerData?.opengeni_compaction_prefix === "prepared";
    const resetsPrefix =
      projection.resized ||
      request.modelSettings.providerData?.opengeni_portable_compaction === true ||
      (Array.isArray(request.input) && request.input.some(isCompactionSummary)) ||
      (preparedCompaction && Boolean(body.thinking));
    if (claudeNativeModelProfile(this.model)?.prefixBoundThinking && resetsPrefix) {
      body.thinking = {
        type: "adaptive",
        display: "summarized",
        ...body.thinking,
        block_binding: { prefix_mismatch_behavior: "drop_block" },
      };
      delete body.temperature;
      delete body.top_p;
      const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
      betas.add("thinking-binding-controls-2026-08-01");
      headers.set("anthropic-beta", [...betas].join(","));
    }
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
    const serialized = JSON.stringify(body);
    return { url, headers, serialized, size: anthropicRequestSize(body, serialized) };
  }

  /** Uses the same final serialization as dispatch, but performs no network I/O. */
  async measureRequest(request: ModelRequest, stream = false) {
    return (await this.prepare(request, stream)).size;
  }

  private async send(request: ModelRequest, stream: boolean): Promise<Response> {
    const { url, headers, serialized, size } = await this.prepare(request, stream);
    if (size.requestBytes > ANTHROPIC_REQUEST_MAX_BYTES)
      throw new AnthropicRequestSizeError(size, "preflight");
    request.signal?.throwIfAborted();
    const response = await withClaudeModelRequest(this.model, () =>
      this.fetch(url, {
        method: "POST",
        headers,
        body: serialized,
        ...(request.signal ? { signal: request.signal } : {}),
      }),
    );
    if (request.signal?.aborted) {
      void response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
    }
    if (!response.ok) {
      if (response.status === 413) {
        void response.body?.cancel().catch(() => undefined);
        throw new AnthropicRequestSizeError(size, "http_413", response.headers);
      }
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
      // An organization admin can switch Claude's web search off; the request
      // then fails as a whole instead of returning a search error.
      const webSearchDisabled =
        response.status === 400 && /web[ _]search[^"]{0,40}not enabled/i.test(detail);
      // Classify the bounded provider detail without leaking echoed prompts or credentials.
      const message = contextExceeded
        ? "Claude context window exceeded"
        : response.status === 401
          ? "Claude credentials expired or were revoked. Replace the key or setup token in Models."
          : webSearchDisabled
            ? "Web search is turned off for this Claude organization. An admin can turn it on in the Claude Console, or web search can be turned off in Opengeni."
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
        contextExceeded
          ? "context_length_exceeded"
          : webSearchDisabled
            ? "anthropic_web_search_disabled"
            : response.status === 402
              ? "anthropic_billing_error"
              : response.status === 400 || response.status === 429
                ? (anthropicHttpSpendLimitCode(detail) ?? "anthropic_http_error")
                : "anthropic_http_error",
        source,
        response.headers,
        { subscription: this.provider.anthropic?.auth === "oauth" },
      );
    }
    this.previousRequestId = response.headers.get("request-id") ?? undefined;
    return response;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const names = toolNames(request);
    const searchQueries = anthropicWebSearchQueries(request.input);
    let merged: Json | undefined;
    let requestId: string | undefined;
    for (let continuation = 0; ; continuation += 1) {
      const current = merged ? pausedTurnRequest(request, merged, names, searchQueries) : request;
      const response = await this.send(current, false);
      requestId = response.headers.get("request-id") ?? undefined;
      const message = object(await response.json());
      if (message.stop_reason === "refusal")
        throw new AnthropicProviderRejection("content_policy_violation", 200, requestId);
      merged = mergePausedMessage(merged, message);
      if (message.stop_reason !== "pause_turn") break;
      assertPauseContinuationAllowed(continuation);
    }
    return anthropicResponse(merged!, requestId, names, searchQueries, merged!.requestUsages);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const names = toolNames(request);
    const searchQueries = anthropicWebSearchQueries(request.input);
    let merged: Json | undefined;
    let requestId: string | undefined;
    for (let continuation = 0; ; continuation += 1) {
      const current = merged ? pausedTurnRequest(request, merged, names, searchQueries) : request;
      // A continuation's blocks extend the same logical response: stream
      // their text under the ids the merged response will give them.
      const streamed = yield* this.streamMessage(current, {
        started: merged !== undefined,
        ...(merged ? { baseId: merged.id as string } : {}),
        offset: merged?.content.length ?? 0,
        ...(merged ? trailingTextRunStart(merged.content) : {}),
      });
      requestId = streamed.requestId;
      merged = mergePausedMessage(merged, streamed.message);
      if (streamed.message.stop_reason !== "pause_turn") break;
      assertPauseContinuationAllowed(continuation);
    }
    const result = anthropicResponse(
      merged!,
      requestId,
      names,
      searchQueries,
      merged!.requestUsages,
    );
    yield protocol.StreamEventResponseCompleted.parse({
      type: "response_done",
      response: { id: result.responseId!, ...result },
    });
  }

  private async *streamMessage(
    request: ModelRequest,
    continuation: { started: boolean; baseId?: string; offset: number; textRunStart?: number },
  ): AsyncGenerator<ResponseStreamEvent, { message: Json; requestId: string | undefined }> {
    const response = await this.send(request, true);
    if (!response.body) throw new AnthropicProtocolError("Claude returned an empty stream");
    // `item` is the merged response index of the message this block's text
    // belongs to: adjacent text blocks share the first block's message.
    const blocks = new Map<number, { block: Json; json: string; stopped: boolean; item: number }>();
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
          billing_error: 402,
          permission_error: 403,
          not_found_error: 404,
          conflict_error: 409,
          request_too_large: 413,
          rate_limit_error: 429,
          api_error: 500,
          timeout_error: 504,
          overloaded_error: 529,
        };
        // A new error type is not evidence of a server failure. Never invent
        // a retryable status for an unknown terminal; completed tools stay saved.
        const status =
          typeof kind === "string" && Object.hasOwn(statuses, kind) ? statuses[kind] : undefined;
        const rejection =
          status !== undefined
            ? providerRejection(status, event.error, response.headers)
            : undefined;
        if (rejection) throw rejection;
        const spendCode =
          status === 400 || status === 429 ? anthropicSpendLimitCode(event.error) : undefined;
        const code =
          spendCode ??
          (status === 402
            ? "anthropic_billing_error"
            : status === 429
              ? "rate_limit_exceeded"
              : "anthropic_stream_error");
        const failureMessage =
          status === undefined
            ? "Claude returned an unrecognized stream error. Automatic retries stopped."
            : `Claude stream failed (HTTP ${status})`;
        throw Object.assign(new Error(failureMessage), {
          ...(status !== undefined ? { status } : {}),
          code,
          request_id: response.headers.get("request-id"),
          headers: response.headers.has("retry-after")
            ? { "retry-after": response.headers.get("retry-after")! }
            : {},
          // Keep the structural stream wrapper stable for provider rejection
          // guards while the typed cause keeps provider text private.
          cause: new AnthropicRequestError(
            failureMessage,
            status,
            code,
            event.error,
            response.headers,
            { subscription: this.provider.anthropic?.auth === "oauth" },
          ),
        });
      }
      switch (event.type) {
        case "message_start":
          if (message) throw new AnthropicProtocolError("Duplicate Claude message_start");
          message = object(event.message);
          if (!continuation.started) yield { type: "response_started" };
          break;
        case "content_block_start":
          if (!message || blocks.has(event.index) || finalDelta)
            throw new AnthropicProtocolError("Invalid Claude block start");
          {
            const block = object(event.content_block);
            const previous = blocks.get(event.index - 1);
            const runStart =
              block.type !== "text"
                ? undefined
                : event.index === 0
                  ? continuation.textRunStart
                  : previous?.block.type === "text"
                    ? previous.item
                    : undefined;
            blocks.set(event.index, {
              block,
              json: "",
              stopped: false,
              item: runStart ?? continuation.offset + event.index,
            });
          }
          break;
        case "content_block_delta": {
          const state = blocks.get(event.index);
          if (!state || state.stopped)
            throw new AnthropicProtocolError("Claude delta has no open block");
          const delta = object(event.delta);
          const expected = {
            text_delta: "text",
            citations_delta: "text",
            thinking_delta: "thinking",
            signature_delta: "thinking",
          }[delta.type as string];
          if (expected && state.block.type !== expected)
            throw new AnthropicProtocolError("Claude delta type does not match its content block");
          if (
            delta.type === "input_json_delta" &&
            state.block.type !== "tool_use" &&
            state.block.type !== "server_tool_use"
          )
            throw new AnthropicProtocolError("Claude delta type does not match its content block");
          if (delta.type === "text_delta") {
            state.block.text += text(delta.text, "text delta");
            yield {
              type: "output_text_delta",
              itemId: `${continuation.baseId ?? message!.id}:${state.item}`,
              delta: delta.text,
            };
          } else if (delta.type === "citations_delta") {
            state.block.citations = [
              ...(Array.isArray(state.block.citations) ? state.block.citations : []),
              object(delta.citation),
            ];
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
          if (
            (state.block.type === "tool_use" || state.block.type === "server_tool_use") &&
            state.json
          )
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
          return { message, requestId: response.headers.get("request-id") ?? undefined };
        }
      }
    }
    throw new AnthropicProtocolError("Claude stream ended without message_stop");
  }
}

function assertPauseContinuationAllowed(continuation: number): void {
  if (continuation + 1 >= ANTHROPIC_PAUSE_TURN_MAX_REQUESTS)
    throw new AnthropicProtocolError(
      `Claude paused its web search ${ANTHROPIC_PAUSE_TURN_MAX_REQUESTS} times without finishing`,
    );
}

/** Index of the first block of the text run that ends `content`, if it ends in text. */
function trailingTextRunStart(content: Json[]): { textRunStart?: number } {
  let start = content.length;
  while (start > 0 && content[start - 1]?.type === "text") start -= 1;
  return start < content.length ? { textRunStart: start } : {};
}

/** Sums every numeric usage counter, keeping the latest non-numeric fields. */
function addUsage(previous: unknown, next: unknown): unknown {
  if (typeof previous === "number" && typeof next === "number") return previous + next;
  if (
    previous &&
    next &&
    typeof previous === "object" &&
    typeof next === "object" &&
    !Array.isArray(previous) &&
    !Array.isArray(next)
  ) {
    const result: Json = { ...(previous as Json) };
    for (const [key, value] of Object.entries(next as Json))
      result[key] = key in result ? addUsage(result[key], value) : value;
    return result;
  }
  return next ?? previous;
}

/**
 * One logical response from a paused turn and its continuations: the
 * continuation's blocks extend the paused content, ids stay those of the first
 * message, and usage covers every request that was billed.
 */
function mergePausedMessage(previous: Json | undefined, next: Json): Json {
  if (!Array.isArray(next.content))
    throw new AnthropicProtocolError("Claude response content must be an array");
  if (!previous) return { ...next, content: [...next.content], requestUsages: [next.usage ?? {}] };
  return {
    ...next,
    id: previous.id,
    content: [...previous.content, ...next.content],
    usage: addUsage(previous.usage ?? {}, next.usage ?? {}),
    requestUsages: [...previous.requestUsages, next.usage ?? {}],
    ...(previous.input_transformations || next.input_transformations
      ? {
          input_transformations: [
            ...(Array.isArray(previous.input_transformations)
              ? previous.input_transformations
              : []),
            ...(Array.isArray(next.input_transformations) ? next.input_transformations : []),
          ],
        }
      : {}),
  };
}

/**
 * The continuation of a paused turn: the same request with the paused
 * assistant content appended unchanged, through the ordinary projection, so
 * the continuation and every later request send identical blocks.
 */
function pausedTurnRequest(
  request: ModelRequest,
  paused: Json,
  names: Map<string, { name: string; namespace?: string }>,
  searchQueries: ReadonlyMap<string, string>,
): ModelRequest {
  const replay = anthropicResponse(
    { ...paused, stop_reason: "pause_turn" },
    undefined,
    names,
    searchQueries,
  ).output;
  const input =
    typeof request.input === "string"
      ? [{ type: "message", role: "user", content: request.input }]
      : request.input;
  return { ...request, input: [...input, ...replay] as ModelRequest["input"] };
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
