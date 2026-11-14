import { AsyncLocalStorage } from "node:async_hooks";
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
import {
  hasClaudeCiteTag,
  rewriteClaudeCiteTags,
  type ClaudeCiteSource,
} from "@opengeni/contracts/claude-cite-tags";
import { withClaudeModelRequest } from "./claude-subscription-usage";
import { createModelImageSizer } from "./model-image-sizing";
import { isModelPreempted, preemptedResponseDone } from "./model-preemption";
import {
  ARTIFACT_ORIGIN_KEY,
  artifactOrigin,
  MACHINE_CONTINUATION_TEXT,
  projectHistoryForProvider,
} from "./provider-history-adapter";
import {
  claudeSignedThinkingBlock,
  claudeThinkingFingerprint,
  opaqueReasoningFingerprint,
  refusedOpaqueReasoning,
  rememberRefusedOpaqueReasoning,
} from "./opaque-reasoning-replay";
import { projectHostedSearchEvidence } from "./hosted-search-evidence";
import { splitStableSystemPromptPrefix } from "./system-prompt-cache-prefix";
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  ANTHROPIC_WEB_SEARCH_TOOL_NAME,
  anthropicSearchAccountScope,
  anthropicWebSearchAccountScope,
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

/**
 * Whether this model may write progress updates between tool calls as their
 * own `thinking` blocks (Claude Opus 5.5, Sonnet 5.5).
 *
 * Every Claude request asks for `display: "summarized"`, so each thinking
 * block, reasoning or progress update alike, comes back as Anthropic's
 * readable summary and is shown as a thought. That text is not the words the
 * model wrote (those stay inside the signed block) and it can claim things the
 * model never said. It is therefore reasoning: never the agent's message or
 * reply, and it never counts as a visible reply. A progress update is told
 * apart from reasoning by its signature (`anthropicThinkingIsProgressUpdate`)
 * and marked, so the wait_for_input guard asks for the verbatim `reply`
 * argument. Its signed block is replayed unchanged in place like any other
 * thinking block.
 */
export function anthropicWritesProgressUpdates(model: string): boolean {
  return claudeNativeModelProfile(model)?.progressUpdates === true;
}

const PROGRESS_UPDATE_SIGNATURE_MARKER = "narration";

/**
 * Whether a thinking block is a progress update (a note the model wrote for
 * the person) rather than reasoning. Anthropic documents no field for this
 * under `display: "summarized"`, but a progress update's signature carries
 * the marker "narration" and a reasoning block's never does; Claude Code
 * relies on the same marker. Checked against every thinking block of a
 * long-running production chat: all 176 blocks that `display: "updates"`
 * returned with text (the progress updates) carry it, and none of the 3,460
 * empty (reasoning) blocks do. A signature that cannot be read counts as
 * reasoning.
 */
export function anthropicThinkingIsProgressUpdate(signature: string): boolean {
  if (!signature) return false;
  return Buffer.from(signature, "base64").includes(PROGRESS_UPDATE_SIGNATURE_MARKER);
}

/**
 * The response stream broke before its terminal event: it went silent past
 * the idle timeout, or the connection ended without `message_stop`. This is
 * a dropped connection, not a provider answer, so a caller may retry it.
 */
export class AnthropicStreamInterruptedError extends Error {
  readonly code = "anthropic_stream_interrupted";
}

/**
 * The order in which a session tries an organization's Anthropic API keys
 * (rendezvous hashing of the session over the key ids). A session keeps its
 * first key while that key serves: Anthropic's prompt cache, signed thinking
 * and search results belong to the key's Anthropic organization, so moving
 * would throw them away. Removing or refusing one key moves only the sessions
 * that were on it, and adding one moves only the sessions it now ranks first.
 */
export function anthropicApiKeyOrder<T extends { id: string }>(
  keys: readonly T[],
  session: string,
): T[] {
  const score = (id: string) =>
    createHash("sha256").update(`${session}\0${id}`).digest().readBigUInt64BE(0);
  return keys
    .map((key) => ({ key, score: score(key.id) }))
    .sort((a, b) => (a.score === b.score ? 0 : a.score > b.score ? -1 : 1))
    .map(({ key }) => key);
}

/**
 * Anthropic refused an API key because its organization can't pay: the
 * credit balance is too low (HTTP 400), a billing error (402), or the
 * organization's own spend limit. Credits don't come back by themselves, so
 * the key stays out until an administrator checks it again.
 */
export function isAnthropicApiKeyCreditRefusal(error: unknown): boolean {
  if (!(error instanceof AnthropicRequestError)) return false;
  if (error.status === 402 || error.errorType === "billing_error") return true;
  if (error.code === "anthropic_billing_error" || error.code === "enforced_spend_limit_reached")
    return true;
  return error.status === 400 && /\bcredit balance is too low\b/i.test(error.detail ?? "");
}

/** Every key of the organization's pool is out of credits; nothing was sent. */
export const ANTHROPIC_API_KEYS_OUT_OF_CREDITS = "anthropic_api_keys_out_of_credits";

type AnthropicApiKeyRefusalReporter = (providerId: string, keyId: string) => void;
const apiKeyRefusalReporters = new AsyncLocalStorage<AnthropicApiKeyRefusalReporter>();

/**
 * Runs `run` with `report` told of each pooled Anthropic API key that runs
 * out of credits during it, so the caller can record it for later turns.
 */
export function withAnthropicApiKeyRefusals<T>(
  report: AnthropicApiKeyRefusalReporter,
  run: () => Promise<T>,
): Promise<T> {
  return apiKeyRefusalReporters.run(report, run);
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

/**
 * Claude refused a signed thinking block that the request replayed: its
 * signature is bound to a different prefix (system prompt, tools, earlier
 * messages), model, organization or platform than this request has.
 */
export const CLAUDE_REASONING_REPLAY_REJECTED = "anthropic_reasoning_replay_rejected";
const REASONING_REPLAY_REJECTION =
  /\binvalid\W+(?:signature|data)\W+in\W+(?:redacted_)?thinking\W+block\b|\bthinking\W+block\b[^.]{0,80}\bbound to a different\b/i;

/**
 * The binding a signed thinking block issued for this request is valid under,
 * recorded on it and compared on every later request (see
 * opaque-reasoning-replay). Anthropic binds a signature to the organization,
 * platform and model that issued it; a prefix-bound model's signature also
 * binds the system prompt, which a session can change between turns (for
 * example a repository Skill added mid-chat); that is what Claude's refusal
 * names. Tools are left out: loading a tool changes them between requests of
 * one turn. Earlier messages change only through compaction, which resets the
 * prefix explicitly. Any other refusal is caught by the one retry. A digest
 * keeps credentials and prompt text out of stored history.
 */
export function claudeReplayScope(
  request: Pick<ModelRequest, "systemInstructions">,
  model: string,
  provider: ClaudeRequestProvider,
): string {
  const binding = createHash("sha256")
    .update(provider.baseUrl ?? "https://api.anthropic.com/v1")
    .update("\0")
    .update(anthropicSearchAccountScope(provider) ?? `provider:${provider.id}`);
  if (claudeNativeModelProfile(model)?.prefixBoundThinking)
    binding.update("\0").update(request.systemInstructions ?? "");
  return `claude:${model}:${binding.digest("base64url").slice(0, 22)}`;
}

/**
 * Signed thinking in earlier turns goes back natively only under the binding
 * it was issued with (`claudeReplayScope`); elsewhere it is left out of the
 * request, which is what Claude itself does with a block whose binding no
 * longer matches (`drop_block`). It is never resent as readable text: Claude's
 * own reasoning shown back to it as assistant text in a later turn can trip
 * Claude's safety systems, which refuse the whole request and every retry of
 * it (a turn "blocked by Claude's safety systems"). The turn
 * boundary is the one Claude sees: the last user message that is not only
 * tool results (a machine-origin continuation has its own). The reply in
 * progress keeps its thinking native whatever binding it records: the system
 * prompt can legitimately differ between requests of one turn (a one-shot
 * directive on its first request), Claude accepts that, and text in place of
 * leaving out the turn's thinking would turn thinking off for the rest of the
 * turn. A refusal is still caught by the retry. (That Claude accepts the reply in
 * progress under a changed system prompt is inferred from production, not
 * documented; if it is wrong, the cost is one refusal and retry.) Claude binds
 * every block to the prefix before it, so once a block of an earlier turn
 * is left out, the later blocks of that turn are too.
 */
function omitEarlierThinkingUnderOtherBinding(
  messages: Message[],
  origins: ReadonlyMap<string, string>,
  scope: string,
): void {
  if (!origins.size) return;
  let turnStart = -1;
  const opensTurn = (message: Message) =>
    message.role === "user" && message.content.some((block) => block.type !== "tool_result");
  messages.forEach((message, index) => {
    if (opensTurn(message)) turnStart = index;
  });
  let omitted = false;
  for (const message of messages.slice(0, Math.max(turnStart, 0))) {
    if (opensTurn(message)) omitted = false;
    if (message.role !== "assistant") continue;
    message.content = message.content.filter((block) => {
      const fingerprint = claudeThinkingFingerprint(block);
      if (!fingerprint) return true;
      const origin = origins.get(fingerprint);
      if (!omitted && (origin === undefined || origin === scope)) return true;
      omitted = true;
      return false;
    });
  }
}

/**
 * Messages with no content left (an assistant message that held only thinking
 * that was left out) are removed, and the neighbours they separated are joined
 * when they share a role, as Claude would join them. This depends only on the
 * messages themselves, so every later request reproduces the same prefix.
 */
function withoutEmptyMessages(messages: Message[]): Message[] {
  const kept: Message[] = [];
  for (const message of messages) {
    if (!message.content.length) continue;
    const previous = kept.at(-1);
    if (previous?.role === message.role) previous.content.push(...message.content);
    else kept.push(message);
  }
  return kept;
}

/** The binding recorded on each signed thinking block of a request's history. */
function recordedThinkingOrigins(input: ModelRequest["input"]): Map<string, string> {
  const origins = new Map<string, string>();
  if (typeof input === "string") return origins;
  for (const raw of input as unknown[]) {
    const item = object(raw);
    const block = claudeSignedThinkingBlock(item);
    const origin = block ? artifactOrigin(item) : undefined;
    if (block && origin !== undefined) origins.set(claudeThinkingFingerprint(block)!, origin);
  }
  return origins;
}

/** Fingerprints of the signed thinking blocks a request body sends natively. */
function sentThinkingFingerprints(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) => claudeThinkingFingerprint(block) ?? [])
      : [],
  );
}

/**
 * The signed thinking a request's history holds: every block, and those with
 * no recorded binding (stored before bindings were recorded, or carried on an
 * assistant message by older progress-update history).
 */
function historyThinking(input: ModelRequest["input"]): { all: number; unbound: string[] } {
  let all = 0;
  const unbound: string[] = [];
  if (typeof input === "string") return { all, unbound };
  for (const raw of input as unknown[]) {
    const item = object(raw);
    const block = claudeSignedThinkingBlock(item);
    if (block) {
      all += 1;
      if (artifactOrigin(item) === undefined) unbound.push(claudeThinkingFingerprint(block)!);
      continue;
    }
    if (item.type !== "message" && item.type !== undefined) continue;
    if (item.role !== "assistant" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const signed = part?.providerData?.anthropic?.block;
      const fingerprint = signed?.type === "thinking" ? claudeThinkingFingerprint(signed) : null;
      if (!fingerprint) continue;
      all += 1;
      unbound.push(fingerprint);
    }
  }
  return { all, unbound };
}

/**
 * The signed blocks a replay refusal implicates: the one it names
 * (`messages.N.content.M`) and every signed block after it, whose prefix was
 * built with the named block native.
 */
function refusedBlockFingerprints(
  error: AnthropicRequestError,
  body: Json,
  sent: readonly string[],
): string[] {
  const at = /\bmessages\.(\d+)\.content\.(\d+)\b/.exec(String(error.detail ?? ""));
  if (!at) return [];
  const block = body.messages?.[Number(at[1])]?.content?.[Number(at[2])];
  const named = block && typeof block === "object" ? claudeThinkingFingerprint(block) : null;
  const from = named ? sent.indexOf(named) : -1;
  return from < 0 ? [] : sent.slice(from);
}

/**
 * How far a request fell back from replaying signed thinking natively:
 * `binding` leaves out blocks issued under another binding (or already
 * refused); `refused` additionally leaves out the blocks a refusal points at;
 * `plain` sends history with no opaque provider state.
 */
type ThinkingReplay = "binding" | "refused" | "plain";

/**
 * Operator-only record of the thinking a fallback request left out.
 * The steady-state binding projection is not a fallback and is not recorded.
 */
const REPLAY_TRANSFORMATION_REASON: Record<Exclude<ThinkingReplay, "binding">, string> = {
  refused: "opengeni_refused_replay",
  plain: "opengeni_plain_history",
};
const replayTransformations = new WeakMap<Response, Json[]>();

/** A response's message, with the thinking its request left out recorded. */
function withReplayTransformations(message: Json, response: Response): Json {
  const recorded = replayTransformations.get(response);
  if (!recorded?.length) return message;
  return {
    ...message,
    input_transformations: [
      ...(Array.isArray(message.input_transformations) ? message.input_transformations : []),
      ...recorded,
    ],
  };
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

/**
 * Claude accepts only `[a-zA-Z0-9_-]` in tool call IDs. Calls recorded by
 * other providers may carry other characters. Such an
 * ID gets a stable, collision-safe Claude form; the call and its result map
 * to the same form, and an ID that is already valid passes through unchanged.
 */
export function anthropicToolUseId(id: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(id)) return id;
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `${readable}_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
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

function contentBlocks(
  value: unknown,
  options: {
    citations?: boolean;
    assistant?: boolean;
    isRefusedThinking?: (fingerprint: string | null) => boolean;
  } = {},
): Json[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap((entry): Json[] => {
    const block = object(entry);
    // History recorded while progress updates became assistant messages keeps
    // Claude's own signed thinking block on the message. It goes back exactly
    // as received, never as the summary text it was shown as.
    // One this provider refused is left out (see omitEarlierThinkingUnderOtherBinding).
    const signed = options.assistant ? block.providerData?.anthropic?.block : undefined;
    if (signed?.type === "thinking") {
      if (!options.isRefusedThinking?.(claudeThinkingFingerprint(signed)))
        return [structuredClone(object(signed))];
      return [];
    }
    if (["text", "input_text", "output_text", "refusal"].includes(block.type)) {
      const blockText = text(block.text ?? block.refusal, "text");
      // Claude rejects an empty text block. Other providers can record one (a
      // reply with no words), and it says nothing, so it is left out. A request
      // that held one was always refused, so no cached prefix changes.
      if (!blockText) return [];
      // Claude's own cited text is replayed with its citations exactly while
      // the cited searches are still native in this request.
      const citations = block.providerData?.anthropic?.citations;
      return [
        {
          type: "text",
          text: blockText,
          ...(options.citations && Array.isArray(citations) && citations.length
            ? { citations: structuredClone(citations) }
            : {}),
        },
      ];
    }
    if (["image", "input_image"].includes(block.type)) {
      return [
        {
          type: "image",
          source: imageSource(block.image ?? block.imageUrl ?? block.image_url),
        },
      ];
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
 *
 * `accountScope` is the Anthropic account this request runs on. A search
 * produced under another (or an unrecorded) account cannot be decrypted here,
 * so it becomes readable facts too, and no later citation is sent because it
 * may point into that search. The account determines the cache anyway, so the
 * projection is stable for as long as the conversation stays on one account.
 */
export function anthropicMessages(
  input: ModelRequest["input"],
  options: {
    webSearch?: boolean;
    accountScope?: string | null;
    /** A signed thinking block (by fingerprint) this provider already refused. */
    isRefusedThinking?: (fingerprint: string | null) => boolean;
  } = {},
): Message[] {
  const messages: Message[] = [];
  let foreignSearch = false;
  // A runtime-form search record waits for the next user message: inside a
  // reply it would split it (thinking from its tool call), and it is never
  // Claude's speech. An assistant-form record keeps its original place.
  let pendingRecords: Json[] = [];
  // Tool calls of the history so far that have no result yet.
  const openCalls = new Set<string>();
  // A system message inside an unfinished tool step (another provider can put
  // one there, for example a search notice after a search that ran in the
  // middle of a step). Claude accepts it there only when the step's results
  // come next, so it keeps its place then; when more of the reply follows, it
  // moves to just after the step's results. Either way it depends only on the
  // items themselves, so every later request reproduces the same prefix.
  let heldSystem: Json[] = [];
  let heldPastReply = false;
  const emit = (role: Message["role"], content: Json[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  const releaseHeldSystem = () => {
    if (heldSystem.length) emit("system", heldSystem);
    heldSystem = [];
    heldPastReply = false;
  };
  const append = (role: Message["role"], content: Json[]) => {
    if (role === "user" && pendingRecords.length) {
      content = [...pendingRecords, ...content];
      pendingRecords = [];
    }
    if (!content.length) return;
    if (role === "system" && openCalls.size) {
      heldSystem.push(...content);
      return;
    }
    if (heldSystem.length) {
      if (role === "assistant") heldPastReply = true;
      else if (!heldPastReply) releaseHeldSystem();
    }
    emit(role, content);
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
            citations: role === "assistant" && options.webSearch === true && !foreignSearch,
            assistant: role === "assistant",
            ...(options.isRefusedThinking ? { isRefusedThinking: options.isRefusedThinking } : {}),
          }),
        );
        break;
      }
      case "function_call": {
        const args =
          typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        const id = anthropicToolUseId(text(item.callId ?? item.call_id, "tool ID"));
        append("assistant", [
          {
            type: "tool_use",
            id,
            name: anthropicToolName(text(item.name, "tool name"), item.namespace),
            input: object(args),
          },
        ]);
        openCalls.add(id);
        break;
      }
      case "function_call_result": {
        const id = anthropicToolUseId(text(item.callId ?? item.call_id, "tool result ID"));
        append("user", [
          {
            type: "tool_result",
            tool_use_id: id,
            content: contentBlocks(item.output),
            ...(item.providerData?.anthropic?.is_error ? { is_error: true } : {}),
          },
        ]);
        openCalls.delete(id);
        if (!openCalls.size && heldPastReply) releaseHeldSystem();
        break;
      }
      case "reasoning": {
        const block = item.providerData?.anthropic?.block;
        if (block) {
          // Claude's own thinking this provider refused is left out, never
          // resent as readable text (see omitEarlierThinkingUnderOtherBinding).
          if (!options.isRefusedThinking?.(claudeThinkingFingerprint(object(block))))
            append("assistant", [structuredClone(object(block))]);
        } else if (item.content?.length) append("assistant", contentBlocks(item.content));
        break;
      }
      case "compaction":
        throw new AnthropicProtocolError(
          "Codex remote compaction cannot be continued on Claude. Use portable history.",
        );
      case "hosted_tool_call":
        if (isAnthropicWebSearchItem(item)) {
          const sameAccount =
            anthropicWebSearchAccountScope(item) === (options.accountScope ?? null);
          if (options.webSearch && sameAccount) append("assistant", anthropicWebSearchBlocks(item));
          else {
            if (!sameAccount) foreignSearch = true;
            const projected = object(projectHostedSearchEvidence(item));
            if (projected.role === "user") pendingRecords.push(...contentBlocks(projected.content));
            else append("assistant", contentBlocks(projected.content));
          }
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
  releaseHeldSystem();
  // A request that ends in Claude's own reply continues it (a paused search).
  // A record placed after that reply would end it, and would move once the
  // reply grows, so records still waiting then reach Claude with the next
  // user message, in a later request.
  if (messages.at(-1)?.role !== "assistant") append("user", []);
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
 *
 * A reply with thinking must end with its tool calls: when it carries anything
 * after its first tool call and is followed only by tool results, Claude reads
 * the request as an assistant prefill and rejects it. Claude itself can emit a
 * search after our tool call in such a reply, so that search (and a result
 * after the call) becomes readable text, and text after the first tool call
 * moves to just before it, keeping its order. Replies without thinking keep
 * their exact shape, where a deferred search does continue.
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
    const thinks = message.content.some(
      (block) => block.type === "thinking" || block.type === "redacted_thinking",
    );
    const firstCall = thinks ? message.content.findIndex((block) => block.type === "tool_use") : -1;
    const afterCall = (position: number) => firstCall >= 0 && position > firstCall;
    message.content = message.content.map((block, position) => {
      if (block.type === "server_tool_use" && block.name === ANTHROPIC_WEB_SEARCH_TOOL_NAME) {
        if (afterCall(position)) return anthropicWebSearchBlockFact(block);
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
        if (nativeCalls.has(block.tool_use_id) && !afterCall(position)) return block;
        convertedResult = true;
        return anthropicWebSearchBlockFact(block);
      }
      return block;
    });
    if (firstCall >= 0) {
      const trailing = (block: Json, position: number) =>
        afterCall(position) &&
        !["tool_use", "thinking", "redacted_thinking"].includes(String(block.type));
      const moved = message.content.filter(trailing);
      if (moved.length) {
        const kept = message.content.filter((block, position) => !trailing(block, position));
        message.content = [...kept.slice(0, firstCall), ...moved, ...kept.slice(firstCall)];
      }
    }
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
        content: [{ type: "text", text: MACHINE_CONTINUATION_TEXT }],
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

type ClaudeRequestProvider = Pick<ResolvedModelProvider, "anthropic"> &
  Partial<Pick<ResolvedModelProvider, "kind" | "apiKey" | "id" | "baseUrl">>;

export function buildAnthropicRequest(
  request: ModelRequest,
  model: string,
  provider: ClaudeRequestProvider,
  stream: boolean,
  options: {
    /** Fallback of last resort: history with no opaque provider state at all. */
    plainHistory?: boolean;
    /** Signed thinking (by fingerprint) to leave out of this request only. */
    omitThinking?: ReadonlySet<string>;
  } = {},
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
    provider.kind === "claude-subscription-organization" ||
    provider.kind === "claude-subscription";
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
  // Signed thinking goes back natively only under the binding it was issued
  // with, and never once this provider refused it (opaque-reasoning-replay).
  const remembered = provider.id ? refusedOpaqueReasoning(provider.id) : undefined;
  const { plainHistory, omitThinking } = options;
  const isRefused =
    plainHistory === true
      ? () => true
      : remembered || omitThinking?.size
        ? (fingerprint: string | null) =>
            fingerprint !== null &&
            (omitThinking?.has(fingerprint) === true || remembered?.(fingerprint) === true)
        : undefined;
  const input =
    typeof request.input === "string"
      ? request.input
      : (projectHistoryForProvider(request.input, "anthropic-messages", {
          // Claude's own signed thinking is handled below and never becomes text.
          isRejectedArtifact: (item) =>
            !claudeSignedThinkingBlock(item) &&
            isRefused?.(opaqueReasoningFingerprint(item)) === true,
        }) as ModelRequest["input"]);
  const webSearch = request.tools.some(isHostedWebSearchTool);
  let messages = anthropicMessages(input, {
    // Plain history replays earlier searches as readable facts, never as
    // provider-encrypted results or citations into them.
    webSearch: webSearch && plainHistory !== true,
    accountScope: anthropicSearchAccountScope(provider),
    ...(isRefused ? { isRefusedThinking: isRefused } : {}),
  });
  if (!messages.length) throw new AnthropicProtocolError("Claude requires at least one message");
  // A recorded session-independent prefix becomes its own block so it can
  // carry a cache breakpoint (OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT).
  const split =
    request.systemInstructions && provider.anthropic?.cacheTtl !== "off"
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
  omitEarlierThinkingUnderOtherBinding(
    messages,
    recordedThinkingOrigins(request.input),
    claudeReplayScope(request, model, provider),
  );
  // Plain history carries no thinking block of any kind, signed or not.
  if (plainHistory === true)
    for (const message of messages)
      if (message.role === "assistant")
        message.content = message.content.filter(
          (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
        );
  messages = withoutEmptyMessages(messages);
  if (!messages.length) throw new AnthropicProtocolError("Claude requires a conversation message");
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
        ...Object.values(REPLAY_TRANSFORMATION_REASON),
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

/**
 * Claude's web-search results in the order it numbers them for citations:
 * each `web_search_result` of each result block, counted from 1.
 */
export function anthropicSearchResultSources(blocks: Iterable<unknown>): ClaudeCiteSource[] {
  const sources: ClaudeCiteSource[] = [];
  for (const block of blocks) {
    const result = block as Json | null;
    if (result?.type !== "web_search_tool_result" || !Array.isArray(result.content)) continue;
    for (const entry of result.content as Json[])
      if (entry?.type === "web_search_result")
        sources.push({
          url: typeof entry.url === "string" ? entry.url : "",
          title: typeof entry.title === "string" ? entry.title : null,
        });
  }
  return sources;
}

/** The search results a built request sends, in order. */
function requestSearchResultSources(body: Json): ClaudeCiteSource[] {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? anthropicSearchResultSources(message.content) : [],
  );
}

/**
 * With native web search, Anthropic tells Claude to mark quotes with citation
 * tags (a `cite` tag whose `index="N-M"` names search result N, sentence M),
 * and turns them into structured citations only in ordinary answer text. A
 * `wait_for_input` or `goal_complete` call's `reply` is shown verbatim as the
 * turn's answer, so its tags would reach the person as raw markup. They become
 * the quoted text, linked to the search result the index names among the
 * results this request and response hold, or plain text when it names none.
 * Only that reply is changed: other tool arguments, such as file edits, keep
 * their exact text.
 */
function withLinkedReplyCitations(
  toolName: string,
  input: Json,
  searchResults: () => readonly ClaudeCiteSource[],
): Json {
  if (!/(?:^|__)(?:wait_for_input|goal_complete)$/u.test(toolName)) return input;
  const reply = input.reply;
  if (typeof reply !== "string" || !hasClaudeCiteTag(reply)) return input;
  const sources = searchResults();
  return {
    ...input,
    reply: rewriteClaudeCiteTags(reply, (result) => sources[result - 1] ?? null),
  };
}

export function anthropicResponse(
  message: Json,
  requestId?: string,
  names = new Map<string, { name: string; namespace?: string }>(),
  searchQueries: ReadonlyMap<string, string> = new Map(),
  requestUsages: Json[] = [],
  accountScope: string | null = null,
  options: {
    progressUpdates?: boolean;
    /** The search results the request sent, in order, read only when needed. */
    requestSearchResults?: () => readonly ClaudeCiteSource[];
    /** The request's binding (`claudeReplayScope`), recorded on signed thinking. */
    replayScope?: string;
  } = {},
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
            accountScope,
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
          arguments: JSON.stringify(
            withLinkedReplyCitations(
              names.get(block.name)?.name ?? block.name,
              object(block.input),
              () => [
                ...(options.requestSearchResults?.() ?? []),
                ...anthropicSearchResultSources(content.slice(0, index)),
              ],
            ),
          ),
          status: "completed",
        });
        break;
      case "thinking":
      case "redacted_thinking":
        if (block.type === "thinking") {
          text(block.thinking, "thinking text");
          text(block.signature, "thinking signature");
        } else text(block.data, "redacted thinking data");
        // Readable thinking text is always Anthropic's summary (of reasoning
        // or of a progress update), never words the model wrote for the
        // person. It stays reasoning so it is never shown or recorded as the
        // agent's message (anthropicWritesProgressUpdates). A progress update
        // (anthropicThinkingIsProgressUpdate) is marked, because it holds a
        // note for the person that was not shown as written: the
        // wait_for_input guard then asks for the verbatim `reply` argument.
        output.push({
          type: "reasoning",
          id,
          content: block.thinking ? [{ type: "input_text", text: block.thinking }] : [],
          providerData: {
            anthropic: {
              block: structuredClone(block),
              ...(options.progressUpdates &&
              block.type === "thinking" &&
              block.thinking &&
              anthropicThinkingIsProgressUpdate(String(block.signature ?? ""))
                ? { progressUpdate: true }
                : {}),
            },
            ...(options.replayScope ? { [ARTIFACT_ORIGIN_KEY]: options.replayScope } : {}),
          },
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
  /** Pooled API keys Anthropic refused for lack of credits while this model ran. */
  private readonly refusedApiKeys = new Set<string>();
  /** The pooled API key each accepted response was sent with. */
  private readonly responseApiKeys = new WeakMap<Response, string>();
  constructor(
    readonly provider: ResolvedModelProvider,
    readonly model: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  /**
   * The provider as this request sends it: with an organization's several
   * API keys (`anthropic.apiKeys`), its key is the session's first key that
   * Anthropic has not refused for lack of credits (`anthropicApiKeyOrder`).
   * The search and replay scopes follow that key. Without a pool it is the
   * provider itself, unchanged.
   */
  private providerFor(request: ModelRequest): ResolvedModelProvider & { apiKeyId?: string } {
    const keys = this.provider.anthropic?.apiKeys;
    if (!keys) return this.provider;
    const session = request.modelSettings.providerData?.prompt_cache_key;
    const key = anthropicApiKeyOrder(
      keys,
      typeof session === "string" && session ? session : this.fallbackSessionId,
    ).find((candidate) => !this.refusedApiKeys.has(candidate.id));
    if (!key)
      throw new AnthropicRequestError(
        "Every Anthropic API key of this organization is out of credits. An organization administrator can add a key, or check the keys again in Models after adding credits.",
        402,
        ANTHROPIC_API_KEYS_OUT_OF_CREDITS,
        undefined,
        new Headers(),
      );
    return { ...this.provider, apiKey: key.apiKey, apiKeyId: key.id };
  }

  private requestScopes(request: ModelRequest) {
    const provider = this.providerFor(request);
    return {
      accountScope: anthropicSearchAccountScope(provider),
      replayScope: claudeReplayScope(request, this.model, provider),
    };
  }

  /**
   * Leave a pooled API key out for the rest of this model's requests and
   * report it, so later turns skip it too. True when `error` is Anthropic
   * refusing that key for lack of credits; the caller then sends the same
   * request again, which goes to the session's next key.
   */
  private refusedForCredits(apiKeyId: string | undefined, error: unknown): boolean {
    if (apiKeyId === undefined || !isAnthropicApiKeyCreditRefusal(error)) return false;
    this.refusedApiKeys.add(apiKeyId);
    apiKeyRefusalReporters.getStore()?.(this.provider.id, apiKeyId);
    return true;
  }

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
        if (image.data === block.source.data) {
          // Same bytes under a wrong type label (a JPEG sent as image/png): send
          // them with the type they really are. Nothing was resized, so no note.
          // A mislabeled image was never sent before, so this is its only form.
          result.push({ ...block, source: { ...block.source, media_type: image.mediaType } });
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

  /**
   * The search results a request sends, in order, as Claude numbers them for
   * citations. A paused turn's continuation adds its earlier content after
   * these, and the response numbers those blocks itself.
   */
  private requestSearchResults(request: ModelRequest): ClaudeCiteSource[] {
    return requestSearchResultSources(
      buildAnthropicRequest(request, this.model, this.providerFor(request), false),
    );
  }

  private async prepare(
    request: ModelRequest,
    stream: boolean,
    replay: { fallback: ThinkingReplay; omitThinking?: ReadonlySet<string> } = {
      fallback: "binding",
    },
  ) {
    request.signal?.throwIfAborted();
    const provider = this.providerFor(request);
    const body = buildAnthropicRequest(request, this.model, provider, stream, {
      plainHistory: replay.fallback === "plain",
      ...(replay.omitThinking ? { omitThinking: replay.omitThinking } : {}),
    });
    const projection = { resized: false };
    for (const message of body.messages) {
      message.content = await this.sizeImageBlocks(message.content, projection, request.signal);
    }
    const signedThinking = sentThinkingFingerprints(body.messages);
    request.signal?.throwIfAborted();
    const base = provider.baseUrl ?? "https://api.anthropic.com/v1";
    const url = new URL(`${base.replace(/\/$/, "")}/messages`);
    for (const [key, value] of Object.entries(provider.defaultQuery ?? {}))
      url.searchParams.set(key, value);
    const headers = new Headers(provider.defaultHeaders);
    headers.set("content-type", "application/json");
    headers.set("accept", stream ? "text/event-stream" : "application/json");
    headers.set("anthropic-version", "2023-06-01");
    // Prefix-bound thinking blocks are valid only after the exact prefix they
    // were created with, and that prefix legitimately changes between
    // requests: a portable checkpoint (including a standalone tool-less
    // summary request) or an image-policy upgrade rewrites history, and the
    // system prompt follows live workspace state (for example the repository
    // Skills index after a branch checkout). Without the provider's explicit
    // reset Claude rejects the whole request, and every retry, with HTTP 400.
    // Keep signed blocks verbatim and let the provider drop only the blocks the
    // changed prefix invalidated (reported as thinkingBlocksDropped); never
    // strip signatures ourselves. An unchanged prefix drops nothing. Every
    // request that already asks for thinking opts in, so the setting never
    // flips inside a conversation; a request without thinking is moved into it
    // only while its input carries a checkpoint summary or a resized image, and
    // never when it forces a tool (Claude refuses thinking with a forced tool).
    // A summary request that reuses the prepared ordinary prefix therefore
    // keeps its thinking mode unchanged (the mode is part of the cache key).
    // Where drop_block is unavailable (a gateway that strips it) or does not
    // apply (another model, account or platform), our own replay policy still
    // keeps every request valid (opaque-reasoning-replay).
    const resetsPrefix =
      projection.resized ||
      request.modelSettings.providerData?.opengeni_portable_compaction === true ||
      (Array.isArray(request.input) && request.input.some(isCompactionSummary));
    const forcesTool = body.tool_choice?.type === "any" || body.tool_choice?.type === "tool";
    if (
      claudeNativeModelProfile(this.model)?.prefixBoundThinking &&
      (Boolean(body.thinking) || (resetsPrefix && !forcesTool))
    ) {
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
    if (provider.kind !== "anonymous") {
      if (!provider.apiKey) throw new AnthropicProtocolError("Claude credentials are unavailable");
      if (provider.anthropic?.auth === "oauth") {
        headers.delete("x-api-key");
        headers.set("authorization", `Bearer ${provider.apiKey}`);
        const betas = new Set((headers.get("anthropic-beta") ?? "").split(",").filter(Boolean));
        betas.add("oauth-2025-04-20");
        headers.set("anthropic-beta", [...betas].join(","));
      } else {
        headers.delete("authorization");
        headers.set("x-api-key", provider.apiKey);
      }
    }
    if (provider.anthropic?.auth === "oauth") {
      const identity = provider.anthropic.identity;
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
        model: this.model,
      });
    }
    const serialized = JSON.stringify(body);
    return {
      url,
      headers,
      serialized,
      size: anthropicRequestSize(body, serialized),
      signedThinking,
      body,
      replay: replay.fallback,
      apiKeyId: provider.apiKeyId,
    };
  }

  /** Uses the same final serialization as dispatch, but performs no network I/O. */
  async measureRequest(request: ModelRequest, stream = false) {
    return (await this.prepare(request, stream)).size;
  }

  /**
   * Replayed signed thinking never fails a turn. A request carries native
   * thinking only under the binding it was issued with (opaque-reasoning-
   * replay). If Claude still refuses a replayed signature (history stored
   * before bindings were recorded, or a binding Claude checks that we do
   * not record), the request is sent once more with the blocks the refusal
   * concerns left out: those with no recorded binding and the one it
   * names. They are remembered for this provider, so later requests do not
   * repeat the refusal. If Claude refuses that too, the request is sent with
   * no opaque provider state at all, which it always accepts, and every block
   * the retry still carried is remembered. Each fallback is recorded for
   * operators (`thinkingBlocksDropped`), never shown to the person.
   */
  private async send(request: ModelRequest, stream: boolean): Promise<Response> {
    let replay: { fallback: ThinkingReplay; omitThinking?: ReadonlySet<string> } = {
      fallback: "binding",
    };
    const history = historyThinking(request.input);
    for (;;) {
      const prepared = await this.prepare(request, stream, replay);
      try {
        const response = await this.dispatch(request, prepared);
        const leftOut = history.all - prepared.signedThinking.length;
        if (leftOut > 0 && replay.fallback !== "binding")
          replayTransformations.set(
            response,
            Array.from({ length: leftOut }, () => ({
              type: "thinking_dropped",
              reason: REPLAY_TRANSFORMATION_REASON[replay.fallback as "refused" | "plain"],
            })),
          );
        if (prepared.apiKeyId !== undefined) this.responseApiKeys.set(response, prepared.apiKeyId);
        return response;
      } catch (error) {
        // A pooled API key whose organization is out of credits: it is left
        // out from now on (and reported), and the same request goes to the
        // session's next key. Its signed thinking and searches stay behind,
        // since they belong to the refused key's Anthropic organization.
        if (this.refusedForCredits(prepared.apiKeyId, error)) continue;
        if (
          prepared.replay === "plain" ||
          !(error instanceof AnthropicRequestError) ||
          error.code !== CLAUDE_REASONING_REPLAY_REJECTED
        )
          throw error;
        if (prepared.replay === "binding" && prepared.signedThinking.length > 0) {
          const suspects = new Set(
            history.unbound.filter((fingerprint) => prepared.signedThinking.includes(fingerprint)),
          );
          for (const fingerprint of refusedBlockFingerprints(
            error,
            prepared.body,
            prepared.signedThinking,
          ))
            suspects.add(fingerprint);
          // A refusal we cannot attribute concerns every block it carried.
          const refused = suspects.size ? suspects : new Set(prepared.signedThinking);
          rememberRefusedOpaqueReasoning(this.provider.id, refused);
          replay = { fallback: "refused", omitThinking: refused };
        } else {
          rememberRefusedOpaqueReasoning(this.provider.id, prepared.signedThinking);
          replay = { fallback: "plain" };
        }
      }
    }
  }

  private async dispatch(
    request: ModelRequest,
    { url, headers, serialized, size }: Awaited<ReturnType<AnthropicMessagesModel["prepare"]>>,
  ): Promise<Response> {
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
      const reasoningReplayRejected =
        response.status === 400 && REASONING_REPLAY_REJECTION.test(detail);
      // Classify the bounded provider detail without leaking echoed prompts or credentials.
      const message = contextExceeded
        ? "Claude context window exceeded"
        : response.status === 401
          ? "Claude credentials expired or were revoked. Replace the key or setup token in Models."
          : webSearchDisabled
            ? "Web search is turned off for this Claude organization. An admin can turn it on in the Claude Console, or web search can be turned off in the workspace's model settings."
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
            : reasoningReplayRejected
              ? CLAUDE_REASONING_REPLAY_REJECTED
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
    let { accountScope, replayScope } = this.requestScopes(request);
    let merged: Json | undefined;
    let requestId: string | undefined;
    for (let continuation = 0; ; continuation += 1) {
      const current = merged
        ? pausedTurnRequest(request, merged, names, searchQueries, accountScope, replayScope)
        : request;
      const response = await this.send(current, false);
      // A pooled key out of credits moves the request to the next key.
      ({ accountScope, replayScope } = this.requestScopes(request));
      requestId = response.headers.get("request-id") ?? undefined;
      const message = withReplayTransformations(object(await response.json()), response);
      if (message.stop_reason === "refusal")
        throw new AnthropicProviderRejection("content_policy_violation", 200, requestId);
      merged = mergePausedMessage(merged, message);
      if (message.stop_reason !== "pause_turn") break;
      assertPauseContinuationAllowed(continuation);
    }
    return anthropicResponse(
      merged!,
      requestId,
      names,
      searchQueries,
      merged!.requestUsages,
      accountScope,
      {
        progressUpdates: anthropicWritesProgressUpdates(this.model),
        requestSearchResults: () => this.requestSearchResults(request),
        replayScope,
      },
    );
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const names = toolNames(request);
    const searchQueries = anthropicWebSearchQueries(request.input);
    let { accountScope, replayScope } = this.requestScopes(request);
    let merged: Json | undefined;
    let requestId: string | undefined;
    const partial: AnthropicPartialMessage = {};
    try {
      for (let continuation = 0; ; continuation += 1) {
        const current = merged
          ? pausedTurnRequest(request, merged, names, searchQueries, accountScope, replayScope)
          : request;
        // A continuation's blocks extend the same logical response: stream
        // their text under the ids the merged response will give them.
        const streamed = yield* this.streamMessage(
          current,
          {
            started: merged !== undefined,
            ...(merged ? { baseId: merged.id as string } : {}),
            offset: merged?.content.length ?? 0,
            ...(merged ? trailingTextRunStart(merged.content) : {}),
          },
          partial,
        );
        requestId = streamed.requestId;
        // A pooled key out of credits moves the request to the next key.
        ({ accountScope, replayScope } = this.requestScopes(request));
        merged = mergePausedMessage(merged, streamed.message);
        if (streamed.message.stop_reason !== "pause_turn") break;
        assertPauseContinuationAllowed(continuation);
      }
    } catch (error) {
      if (!isModelPreempted(request.signal)) throw error;
      // A Steer cut the stream short. Keep the text blocks Claude already
      // closed (content_block_stop); drop everything else (see
      // preemptedResponseDone). Claude reports input usage at message_start.
      const preempted = preemptedAnthropicMessage(merged, partial);
      if (!preempted) {
        yield preemptedResponseDone({ requestId: partial.requestId ?? requestId });
        return;
      }
      // The response shape supplies only the id and usage; the kept text
      // keeps the message ids its deltas were streamed under.
      const result = anthropicResponse(
        preempted.message,
        partial.requestId ?? requestId,
        names,
        searchQueries,
        preempted.message.requestUsages,
        accountScope,
      );
      yield preemptedResponseDone({
        id: result.responseId,
        requestId: result.requestId,
        output: preempted.output,
        usage: result.usage,
      });
      return;
    }
    const result = anthropicResponse(
      merged!,
      requestId,
      names,
      searchQueries,
      merged!.requestUsages,
      accountScope,
      {
        progressUpdates: anthropicWritesProgressUpdates(this.model),
        requestSearchResults: () => this.requestSearchResults(request),
        replayScope,
      },
    );
    yield protocol.StreamEventResponseCompleted.parse({
      type: "response_done",
      response: { id: result.responseId!, ...result },
    });
  }

  private async *streamMessage(
    request: ModelRequest,
    continuation: {
      started: boolean;
      baseId?: string;
      offset: number;
      textRunStart?: number;
    },
    partial: AnthropicPartialMessage = {},
  ): AsyncGenerator<ResponseStreamEvent, { message: Json; requestId: string | undefined }> {
    // A pooled API key can also be refused for lack of credits after its
    // response began: Anthropic then reports it as an error event in the
    // stream. That key is left out like one refused before the stream, and
    // the same request goes to the session's next key. The response has
    // started only once; what the refused stream had sent stays as it was.
    const started = { value: continuation.started };
    for (;;) {
      const streamed = yield* this.streamAttempt(request, continuation, partial, started);
      if (streamed) return streamed;
    }
  }

  /** One streamed request; undefined when Anthropic refused its pooled key for lack of credits. */
  private async *streamAttempt(
    request: ModelRequest,
    continuation: { baseId?: string; offset: number; textRunStart?: number },
    partial: AnthropicPartialMessage,
    started: { value: boolean },
  ): AsyncGenerator<
    ResponseStreamEvent,
    { message: Json; requestId: string | undefined } | undefined
  > {
    partial.message = undefined;
    partial.blocks = undefined;
    const response = await this.send(request, true);
    if (!response.body) throw new AnthropicProtocolError("Claude returned an empty stream");
    partial.requestId = response.headers.get("request-id") ?? undefined;
    // `item` is the merged response index of the message this block's text
    // belongs to: adjacent text blocks share the first block's message.
    const blocks = new Map<number, { block: Json; json: string; stopped: boolean; item: number }>();
    partial.blocks = blocks;
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
        const cause = new AnthropicRequestError(
          failureMessage,
          status,
          code,
          event.error,
          response.headers,
          { subscription: this.provider.anthropic?.auth === "oauth" },
        );
        if (this.refusedForCredits(this.responseApiKeys.get(response), cause)) {
          partial.message = undefined;
          partial.blocks = undefined;
          return undefined;
        }
        throw Object.assign(new Error(failureMessage), {
          ...(status !== undefined ? { status } : {}),
          code,
          request_id: response.headers.get("request-id"),
          headers: response.headers.has("retry-after")
            ? { "retry-after": response.headers.get("retry-after")! }
            : {},
          // Keep the structural stream wrapper stable for provider rejection
          // guards while the typed cause keeps provider text private.
          cause,
        });
      }
      switch (event.type) {
        case "message_start":
          if (message) throw new AnthropicProtocolError("Duplicate Claude message_start");
          message = object(event.message);
          partial.message = message;
          if (!started.value) {
            started.value = true;
            yield { type: "response_started" };
          }
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
            const chunk = text(delta.thinking, "thinking delta");
            state.block.thinking += chunk;
            // Thinking text (including a progress-update summary) streams as
            // reasoning, never as message text; empty reasoning streams nothing.
            if (chunk)
              yield {
                type: "model",
                event: { type: "anthropic.thinking.delta", delta: chunk },
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
          return {
            message: withReplayTransformations(message, response),
            requestId: response.headers.get("request-id") ?? undefined,
          };
        }
      }
    }
    throw new AnthropicStreamInterruptedError("Claude stream ended without message_stop");
  }
}

/** What a stream had received when a Steer cut it short. */
type AnthropicPartialMessage = {
  message?: Json | undefined;
  blocks?: Map<number, { block: Json; stopped: boolean; item: number }> | undefined;
  requestId?: string | undefined;
};

/**
 * The logical response a preempted stream leaves: the closed text blocks of
 * earlier paused requests and of the current one, as assistant messages under
 * the same ids their streamed text used (adjacent text blocks are one message,
 * as in {@link anthropicResponse}), with the usage Claude reported for each
 * request so far. `undefined` when no request had started.
 */
function preemptedAnthropicMessage(
  merged: Json | undefined,
  partial: AnthropicPartialMessage,
): { message: Json & { requestUsages: Json[] }; output: unknown[] } | undefined {
  const current = partial.message;
  if (!merged && !current) return undefined;
  const id = (merged?.id ?? current?.id) as string;
  // Merged-response index of each message -> its text parts, in order.
  const texts = new Map<number, string[]>();
  const add = (item: number, block: Json) => {
    if (typeof block?.text !== "string" || block.text.length === 0) return;
    texts.set(item, [...(texts.get(item) ?? []), block.text]);
  };
  const earlier = (merged?.content as Json[] | undefined) ?? [];
  let runStart: number | undefined;
  earlier.forEach((block, index) => {
    if (block?.type !== "text") {
      runStart = undefined;
      return;
    }
    runStart ??= index;
    add(runStart, block);
  });
  if (current) {
    // Adjacent text blocks are one message; it is finished only when every
    // block of its run has closed, so a message never keeps part of its text.
    const states = [...(partial.blocks?.entries() ?? [])].sort(([x], [y]) => x - y);
    const open = new Set(
      states
        .filter(([, state]) => !state.stopped && state.block?.type === "text")
        .map(([, state]) => state.item),
    );
    for (const [, state] of states) {
      if (state.stopped && state.block?.type === "text" && !open.has(state.item))
        add(state.item, state.block);
    }
    for (const item of open) texts.delete(item);
  }
  const output = [...texts.entries()]
    .sort(([x], [y]) => x - y)
    .map(([item, parts]) => ({
      type: "message",
      role: "assistant",
      id: `${id}:${item}`,
      status: "completed",
      content: parts.map((part) => ({ type: "output_text", text: part })),
    }));
  const currentUsage = current ? ((current.usage as Json | undefined) ?? {}) : undefined;
  return {
    message: {
      ...(merged ?? current),
      id,
      stop_reason: "end_turn",
      content: [],
      usage:
        merged && currentUsage
          ? addUsage(merged.usage ?? {}, currentUsage)
          : (merged?.usage ?? currentUsage ?? {}),
      requestUsages: [
        ...((merged?.requestUsages as Json[] | undefined) ?? []),
        ...(currentUsage ? [currentUsage] : []),
      ],
    },
    output,
  };
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
  accountScope: string | null,
  replayScope: string,
): ModelRequest {
  // Its thinking was signed under this same request's binding moments ago.
  const replay = anthropicResponse(
    { ...paused, stop_reason: "pause_turn" },
    undefined,
    names,
    searchQueries,
    [],
    accountScope,
    { replayScope },
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
            () =>
              reject(
                new AnthropicStreamInterruptedError("Claude stream timed out waiting for data"),
              ),
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
