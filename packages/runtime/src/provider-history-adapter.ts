import { collapseRepeatedSessionGoalContexts } from "@opengeni/contracts";
import { isAnthropicWebSearchItem } from "./anthropic-web-search";
import {
  claudeSignedThinkingBlock,
  claudeThinkingSecret,
  isClaudeThinkingContentPart,
} from "./opaque-reasoning-replay";
import {
  isHostedSearchEvidenceRecord,
  projectHostedSearchEvidence,
  withSearchRecordForm,
  withSearchRecordsAfterOpenCalls,
  type SearchRecordForm,
} from "./hosted-search-evidence";
import { withItemsAfterOpenCalls } from "./items-after-open-calls";

export type HistoryProviderApi = "responses" | "chat" | "anthropic-messages";

/** Request-local projection choices that depend on the target route. */
export type ProviderHistoryOptions = {
  /**
   * The Chat route moves system messages to the start of the conversation
   * (Gemini), so a later system message would rewrite the cached prefix.
   * Mid-conversation declarations then use a machine-origin user message.
   */
  hoistsSystemMessages?: boolean;
  /**
   * The Responses route accepts the `additional_tools` input item (see
   * responsesRouteDeclaresAdditionalTools). Other Responses routes get the
   * same declaration as a developer message carrying the definitions as text.
   */
  declaresAdditionalTools?: boolean;
  /**
   * The session's {@link SearchRecordForm} for earlier hosted searches. Without
   * it, each search keeps the form marked on it, else the original `assistant`.
   * Claude's own searches that stay native for the Claude transport are marked
   * with it, so that transport projects them in the same form when it cannot
   * replay them natively.
   */
  searchRecordForm?: SearchRecordForm;
  /**
   * The provider that receives this Responses request (see
   * opaque-reasoning-replay). Opaque reasoning (its `encrypted_content`, or
   * raw reasoning `content`) that another provider issued, or that
   * `isRejectedArtifact` reports, is left out of the request: only the issuing
   * provider accepts it, and it is never resent as text. The origin record
   * ({@link ARTIFACT_ORIGIN_KEY}) is removed from every item, so the issuing
   * provider receives exactly the item it returned. Claude checks its finer
   * binding on the wire, where it knows Claude's turn boundaries
   * (`buildAnthropicRequest`).
   *
   * On Responses and Chat requests, a Chat tool call's provider fields (see
   * `withToolCallArtifactOrigin`) likewise reach only the provider that
   * returned them.
   */
  artifactScope?: string;
  /** True for an opaque item (ciphertext or a Claude signature) this provider refused. */
  isRejectedArtifact?: (item: Record<string, unknown>) => boolean;
};

/** The one tool-name format every Chat route and gateway accepts. */
const CHAT_FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const HISTORICAL_FACT_MAX_CHARS = 32_000;

/** Marks a request-local item that declares tools newly available to the model. */
export const TOOL_DISCLOSURE_KEY = "opengeni.tool_disclosure.v1";
/**
 * Records, on an opaque reasoning item, the binding it was issued under (the
 * provider, and for Claude its account, model and prefix). It is stored with
 * the item and never sent to a provider.
 */
export const ARTIFACT_ORIGIN_KEY = "opengeni.artifact_origin.v1";
const TOOL_DISCLOSURE_TEXT_WITH_INVOKE =
  "These tools are now available. Call one by its name, or through tool_invoke with its name and a nested arguments object. Definitions:";
const MACHINE_ORIGIN_PREFIX = "Opengeni tool update (machine-origin input; no new human message).";
/**
 * The request-local user turn placed before a system message that follows
 * the model's own reply with nothing to answer (see withContinuationAnchors).
 */
export const MACHINE_CONTINUATION_TEXT =
  "Opengeni continuation (machine-origin input; no new human message).";

/**
 * Responses routes verified live to accept `additional_tools`, call a declared
 * tool by name on the next step, and keep the earlier prefix cached. Every
 * other Responses route (direct OpenAI, Azure OpenAI, xAI, OpenAI-compatible
 * gateways) gets the developer-message form until it is verified: gateways
 * that do not know the item reject the whole request.
 */
const RESPONSES_ROUTES_WITH_ADDITIONAL_TOOLS: ReadonlySet<string> = new Set(["codex-subscription"]);

/** True when the Responses provider kind accepts the `additional_tools` item. */
export function responsesRouteDeclaresAdditionalTools(providerKind: string): boolean {
  return RESPONSES_ROUTES_WITH_ADDITIONAL_TOOLS.has(providerKind);
}

/**
 * A provider-neutral declaration of tools that became available mid-turn. It
 * is a developer message carrying the frozen definitions; each provider
 * projection renders it in that API's own form: a Responses `additional_tools`
 * item where the route accepts it, otherwise a developer or system message
 * as text. Generic routes carry definitions and call through tool_invoke;
 * native routes retain native search and direct calls. Preserve the originating
 * viaToolInvoke value on replay rather than rewriting earlier instructions.
 */
export function toolDisclosureItem(
  tools: Record<string, unknown>[],
  options: { viaToolInvoke: boolean },
): Record<string, unknown> {
  const names = tools.map((tool) => String(tool.name));
  return {
    type: "message",
    role: "developer",
    content: options.viaToolInvoke
      ? `${TOOL_DISCLOSURE_TEXT_WITH_INVOKE}\n${JSON.stringify({ tools })}`
      : `These tools are now available: ${names.join(", ")}. Load them with tool_search using names ${JSON.stringify(names)}, then call them by name.`,
    providerData: { [TOOL_DISCLOSURE_KEY]: { tools } },
  };
}

function disclosedTools(item: Record<string, unknown>): Record<string, unknown>[] | null {
  if (item.type !== "message" || item.role !== "developer") return null;
  const providerData =
    item.providerData && typeof item.providerData === "object"
      ? (item.providerData as Record<string, unknown>)
      : null;
  const disclosure = providerData?.[TOOL_DISCLOSURE_KEY] as { tools?: unknown } | undefined;
  return disclosure && Array.isArray(disclosure.tools)
    ? (disclosure.tools as Record<string, unknown>[])
    : null;
}

/** True when a Chat route is known to hoist mid-conversation system messages. */
export function chatRouteHoistsSystemMessages(modelId: string): boolean {
  return /^(google\/|gemini)/i.test(modelId) || /\/gemini/i.test(modelId);
}

export class ProviderHistoryIncompatibleError extends Error {
  readonly name = "ProviderHistoryIncompatibleError";

  constructor(
    readonly providerApi: HistoryProviderApi,
    readonly itemType: string,
  ) {
    super(
      itemType === "compaction"
        ? "This session uses Codex remote compaction and can only continue on a Codex Responses model. Choose a compatible model or start a new session."
        : `Stored ${itemType} history cannot be represented by the ${providerApi} provider API.`,
    );
  }
}

function callId(item: Record<string, unknown>): string | null {
  const providerData =
    item.providerData && typeof item.providerData === "object"
      ? (item.providerData as Record<string, unknown>)
      : null;
  const value = item.callId ?? item.call_id ?? providerData?.callId ?? providerData?.call_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedJson(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= HISTORICAL_FACT_MAX_CHARS) return rendered;
  return `${rendered.slice(0, HISTORICAL_FACT_MAX_CHARS)}…`;
}

function historicalFact(item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message",
    // This is transcript evidence, never a privileged instruction. Keeping it
    // in the assistant role avoids elevating arbitrary historical tool output.
    role: "assistant",
    content: `[Opengeni historical ${String(item.type ?? "provider item")} fact]\n${boundedJson(item)}`,
  };
}

/** Chat reasoning has plaintext rawContent, not a portable Responses reasoning
 * artifact. Another wire protocol leaves it out.
 * Native Responses/Claude reasoning continues through its existing path.
 */
function isChatReasoning(item: Record<string, unknown>): boolean {
  const metadata =
    item.providerData && typeof item.providerData === "object"
      ? (item.providerData as Record<string, unknown>)
      : undefined;
  return (
    item.type === "reasoning" &&
    Array.isArray(item.rawContent) &&
    item.rawContent.some(
      (part) => part?.type === "reasoning_text" && typeof part.text === "string",
    ) &&
    (!Array.isArray(item.content) || item.content.length === 0) &&
    !item.encrypted_content &&
    !item.encryptedContent &&
    !metadata?.encrypted_content &&
    !metadata?.encryptedContent &&
    !metadata?.anthropic
  );
}

/**
 * Marks a reasoning item that the target request cannot carry natively. It is
 * left out of that request. Reasoning is never converted into readable
 * user/assistant text for another provider, route or binding: shown back as
 * text, a model's own (or another model's) reasoning can trip the provider's
 * safety systems, which then refuse the whole request and every retry.
 * Canonical history keeps the item for a later switch back to its issuer.
 */
const OMITTED_REASONING = Symbol("omitted reasoning");
type Projected = Record<string, unknown> | typeof OMITTED_REASONING;

function withoutOmittedReasoning(projected: Projected[]): Array<Record<string, unknown>> {
  return projected.filter((item): item is Record<string, unknown> => item !== OMITTED_REASONING);
}

function providerDataOf(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return item.providerData && typeof item.providerData === "object"
    ? (item.providerData as Record<string, unknown>)
    : undefined;
}

/**
 * Plain reasoning a Responses provider returned in the reasoning item's own
 * `content` (for example an open-weight model behind a compatible endpoint).
 * The SDK keeps it in providerData and spreads it back onto the wire item.
 * OpenAI and Azure OpenAI accept no reasoning `content` at all, so it is as
 * provider-specific as ciphertext.
 */
function rawResponsesReasoning(item: Record<string, unknown>): unknown[] | undefined {
  if (item.type !== "reasoning") return undefined;
  const raw = providerDataOf(item)?.content;
  return Array.isArray(raw) && raw.length > 0 ? raw : undefined;
}

/**
 * The provider-issued state of a reasoning item that only its issuer can
 * verify, if any: Responses ciphertext, or Claude's thinking signature (or
 * redacted thinking data).
 */
function opaqueReasoningCiphertext(item: Record<string, unknown>): string | undefined {
  if (item.type !== "reasoning") return undefined;
  const block = claudeSignedThinkingBlock(item);
  if (block) return claudeThinkingSecret(block);
  const metadata = providerDataOf(item);
  for (const value of [
    item.encrypted_content,
    item.encryptedContent,
    metadata?.encrypted_content,
    metadata?.encryptedContent,
  ])
    if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/** The provider that issued this item's opaque reasoning, when it was recorded. */
export function artifactOrigin(item: Record<string, unknown>): string | undefined {
  const origin = providerDataOf(item)?.[ARTIFACT_ORIGIN_KEY];
  return typeof origin === "string" ? origin : undefined;
}

/**
 * Record the issuing provider on a reasoning item that carries ciphertext or
 * raw provider reasoning. Every other item, and one already recorded, is
 * returned by reference.
 */
export function withArtifactOrigin<T>(item: T, origin: string): T {
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;
  if (
    (!opaqueReasoningCiphertext(record) && !rawResponsesReasoning(record)) ||
    artifactOrigin(record) !== undefined
  )
    return item;
  return {
    ...record,
    providerData: { ...providerDataOf(record), [ARTIFACT_ORIGIN_KEY]: origin },
  } as T;
}

// Projections are memoized per canonical item so a repeated request reuses the
// same projected object (the append-only Responses converter matches by identity).
const nativeArtifactProjections = new WeakMap<object, Record<string, unknown>>();
const foreignArtifactProjections = new WeakMap<object, Record<string, unknown>>();

function memoized(
  cache: WeakMap<object, Record<string, unknown>>,
  item: Record<string, unknown>,
  project: () => Record<string, unknown>,
): Record<string, unknown> {
  let projected = cache.get(item);
  if (!projected) {
    projected = project();
    cache.set(item, projected);
  }
  return projected;
}

function withoutArtifactOrigin(item: Record<string, unknown>): Record<string, unknown> {
  const { [ARTIFACT_ORIGIN_KEY]: _origin, ...providerData } = providerDataOf(item) ?? {};
  const { providerData: _metadata, ...rest } = item;
  return Object.keys(providerData).length ? { ...rest, providerData } : rest;
}

/** Opengeni's own records on an item (`opengeni.*` keys); never provider wire fields. */
function isOpengeniRecordKey(key: string): boolean {
  return key.startsWith("opengeni.");
}

/**
 * The fields a Chat Completions provider returned on a tool call beyond the
 * call itself (for example Gemini's `extra_content` thought signature). The
 * SDK spreads them back onto the replayed call, and the SDK's own `type` and
 * `function` envelope from a non-streamed reply is not one of them.
 */
function chatToolCallProviderFields(item: Record<string, unknown>): string[] {
  return Object.keys(providerDataOf(item) ?? {}).filter(
    (key) => key !== "type" && key !== "function" && !isOpengeniRecordKey(key),
  );
}

/**
 * Record the issuing provider on a Chat Completions tool call that carries
 * provider fields (see {@link chatToolCallProviderFields}). Only that provider
 * understands them: Gemini requires its thought signature back on the call,
 * and another provider may reject the unknown field. Every other item, and
 * one already recorded, is returned by reference.
 */
export function withToolCallArtifactOrigin<T>(item: T, origin: string): T {
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;
  if (
    record.type !== "function_call" ||
    chatToolCallProviderFields(record).length === 0 ||
    artifactOrigin(record) !== undefined
  )
    return item;
  return {
    ...record,
    providerData: { ...providerDataOf(record), [ARTIFACT_ORIGIN_KEY]: origin },
  } as T;
}

/**
 * A tool call's provider fields go back only to the provider that returned
 * them; every other provider gets the plain call. The origin record itself
 * never reaches the wire. Without a scope (or an origin) the item is kept, so
 * a provider-neutral pass leaves the decision to the request's own route.
 */
function scopedToolCallArtifact(
  item: Record<string, unknown>,
  options: ProviderHistoryOptions,
): Record<string, unknown> | undefined {
  if (item.type !== "function_call") return undefined;
  const scope = options.artifactScope;
  const origin = artifactOrigin(item);
  if (scope === undefined || origin === undefined) return undefined;
  if (origin === scope)
    return memoized(nativeArtifactProjections, item, () => withoutArtifactOrigin(item));
  return memoized(foreignArtifactProjections, item, () => {
    const providerData = Object.fromEntries(
      Object.entries(providerDataOf(item) ?? {}).filter(
        ([key]) => key !== ARTIFACT_ORIGIN_KEY && isOpengeniRecordKey(key),
      ),
    );
    const { providerData: _metadata, ...rest } = item;
    return Object.keys(providerData).length ? { ...rest, providerData } : rest;
  });
}

/**
 * Opaque reasoning goes back natively only under the binding that issued it.
 * Any other request cannot verify it and the provider rejects the whole
 * request, so it is left out ({@link OMITTED_REASONING}). Untagged items
 * (stored before origins were recorded) stay native until the provider
 * refuses them. Raw reasoning `content` follows the same rule, except that an
 * untagged item carrying it is always left out on a scoped route, with or
 * without ciphertext: no refusal names it (providers reject its shape, not a
 * ciphertext), so it could otherwise fail every retry on a provider that did
 * not issue it.
 */
function scopedOpaqueArtifact(
  item: Record<string, unknown>,
  options: ProviderHistoryOptions,
): Projected | undefined {
  const scope = options.artifactScope;
  if (item.type !== "reasoning" || (scope === undefined && !options.isRejectedArtifact))
    return undefined;
  const origin = artifactOrigin(item);
  const ciphertext = opaqueReasoningCiphertext(item);
  const raw = rawResponsesReasoning(item) !== undefined;
  if (
    (ciphertext || raw) &&
    ((scope !== undefined && origin !== undefined && origin !== scope) ||
      (scope !== undefined && origin === undefined && raw) ||
      options.isRejectedArtifact?.(item) === true)
  )
    return OMITTED_REASONING;
  // Without a scope the item keeps its own projection (for Claude, the
  // native block; another provider's reasoning is left out).
  if (origin === undefined || scope === undefined) return undefined;
  return memoized(nativeArtifactProjections, item, () => withoutArtifactOrigin(item));
}

/** Reasoning belongs to its native API. A foreign API receives none of it:
 * no signatures or ciphertext, and no readable text in their place.
 * The canonical artifact stays intact for a later switch back to its native API.
 */
function foreignReasoning(
  item: Record<string, unknown>,
  providerApi: HistoryProviderApi,
): typeof OMITTED_REASONING | undefined {
  if (item.type !== "reasoning") return undefined;
  const metadata = item.providerData as Record<string, any> | undefined;
  const nativeApi: HistoryProviderApi = metadata?.anthropic?.block
    ? "anthropic-messages"
    : isChatReasoning(item)
      ? "chat"
      : "responses";
  if (nativeApi === providerApi) return undefined;
  return OMITTED_REASONING;
}

/** The Chat SDK stores a complete reply message (including its role) in an
 * output text/refusal part's metadata. That is not Responses content metadata:
 * projecting it verbatim sends fields like role/tools/reasoning_content in an
 * output_text block. Only this identifiable Chat shape is removed; canonical
 * history and native Responses annotations/provider extensions remain intact.
 */
function portableChatMetadata(item: Record<string, unknown>): Record<string, unknown> {
  const metadata = item.providerData as Record<string, unknown> | undefined;
  if (item.type === "function_call" && metadata?.type === "function" && metadata.function) {
    // Non-streamed Chat calls also retain their nested wire function envelope.
    // The canonical call already owns name/arguments/callId; Responses has no
    // nested `function` field. Preserve unrelated provider extensions.
    const { type: _type, function: _function, ...providerData } = metadata;
    const { providerData: _metadata, ...projected } = item;
    return Object.keys(providerData).length ? { ...projected, providerData } : projected;
  }
  if (item.role !== "assistant" || !Array.isArray(item.content)) return item;
  let changed = false;
  // Before the shared Chat adapter, reasoning_content survived only inside
  // reply metadata. Removing that foreign envelope also leaves that reasoning
  // out: it is never inlined as reply text.
  const content = item.content.map((part) => {
    if (
      (part?.type !== "output_text" && part?.type !== "refusal") ||
      part.providerData?.role !== "assistant"
    )
      return part;
    const { providerData: _replyMetadata, ...projected } = part;
    changed = true;
    return projected;
  });
  return changed ? { ...item, content } : item;
}

function isChatIncompatibleCall(item: Record<string, unknown>): boolean {
  if (item.type !== "function_call") return false;
  return (
    (typeof item.namespace === "string" && item.namespace.trim().length > 0) ||
    (typeof item.name === "string" && !CHAT_FUNCTION_NAME.test(item.name))
  );
}

const CHAT_INCOMPATIBLE_ITEM_TYPES = new Set([
  "tool_search_call",
  "tool_search_output",
  "computer_call",
  "computer_call_result",
  "shell_call",
  "shell_call_output",
  "apply_patch_call",
  "apply_patch_call_output",
]);

function isChatIncompatibleHostedToolCall(item: Record<string, unknown>): boolean {
  return item.type === "hosted_tool_call" && item.name !== "file_search_call";
}

/** The Chat SDK passes system content through instead of converting Responses
 * text parts. Normalize only text-only content; preserve canonical input.
 */
function chatSystemContent(content: unknown): unknown {
  if (
    !Array.isArray(content) ||
    !content.every(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string",
    )
  )
    return content;
  return content.map((part) => part.text).join("\n");
}

/**
 * Build the one attempt-local history view required by the target wire API.
 * Canonical history remains untouched. SDK-unsupported developer messages use
 * the Responses pass-through item. Other history is returned by reference when every
 * item is already representable by the SDK's Chat Completions converter.
 */
export function projectHistoryForProvider(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
  options: ProviderHistoryOptions = {},
): Array<Record<string, unknown>> {
  const nativeClaude = providerApi === "anthropic-messages";
  // Each distinct session goal context reaches the model once per request.
  const goalOnce = collapseRepeatedSessionGoalContexts(items);
  // A search record never separates a tool call from its result on any API.
  const projected = withSearchRecordsAfterOpenCalls(
    withoutOmittedReasoning(
      goalOnce.map((item): Projected => {
        const form = options.searchRecordForm;
        const evidence = projectHostedSearchEvidence(item, {
          preserveAnthropicNative: nativeClaude,
          ...(form ? { form } : {}),
        });
        if (nativeClaude && form && isAnthropicWebSearchItem(evidence))
          return withSearchRecordForm(evidence, form);
        return nativeClaude ? evidence : withoutClaudeMessageMetadata(evidence);
      }),
    ),
  );
  const input =
    projected.length === items.length && projected.every((item, index) => item === items[index])
      ? items
      : projected;
  return projectWireHistory(withWireValidFunctionCallArguments(input), providerApi, options);
}

/**
 * Claude citations ride on assistant text parts as `providerData.anthropic`.
 * The Responses and Chat converters would serialize that metadata onto the
 * wire, so other providers get the plain text. A part holding Claude's
 * thinking (`isClaudeThinkingContentPart`) is left out instead, and a message
 * left with nothing is left out too. Canonical history keeps both for a later
 * switch back to Claude, which must replay them exactly.
 */
function withoutClaudeMessageMetadata(item: Record<string, unknown>): Projected {
  if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
    return item;
  let changed = false;
  const content = item.content.flatMap((part) => {
    if (isClaudeThinkingContentPart(part)) {
      changed = true;
      return [];
    }
    const metadata = part?.providerData;
    if (!metadata || typeof metadata !== "object" || !("anthropic" in metadata)) return [part];
    changed = true;
    const { anthropic: _anthropic, ...rest } = metadata as Record<string, unknown>;
    const { providerData: _providerData, ...plain } = part;
    return [Object.keys(rest).length ? { ...plain, providerData: rest } : plain];
  });
  if (!changed) return item;
  return content.length ? { ...item, content } : OMITTED_REASONING;
}

/** Bound on the raw text carried by a request-local invalid-arguments wrapper. */
export const INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS = 4_000;

function isJsonObjectText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * A model can emit a function call whose `arguments` are not a JSON object
 * (truncated output, a leaked provider control token). The SDK answers that
 * call with a model-visible parse error, and canonical history keeps the exact
 * text. Replaying it verbatim makes Chat Completions providers reject the whole
 * request ("function.arguments must be valid JSON") and the Claude converter
 * throw, poisoning every later turn. Request-locally, wrap such text in a
 * deterministic JSON object so the transcript stays honest and prompt-cache
 * stable while canonical history is never rewritten.
 */
export function withWireValidFunctionCallArguments(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let changed = false;
  const projected = items.map((item) => {
    if (item.type !== "function_call" || typeof item.arguments !== "string") return item;
    const raw = item.arguments;
    if (isJsonObjectText(raw)) return item;
    changed = true;
    if (raw.trim().length === 0) return { ...item, arguments: "{}" };
    const bounded =
      raw.length <= INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS
        ? raw
        : `${raw.slice(0, INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS)}…[truncated ${raw.length - INVALID_FUNCTION_CALL_ARGUMENTS_MAX_CHARS} chars]`;
    return { ...item, arguments: JSON.stringify({ _invalid_arguments: bounded }) };
  });
  return changed ? projected : items;
}

function projectWireHistory(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
  options: ProviderHistoryOptions,
): Array<Record<string, unknown>> {
  if (providerApi === "responses") {
    // agents-js 0.14's message converter supports system/user/assistant only.
    // The Responses API itself supports developer; use the SDK's raw-item adapter.
    let changed = false;
    const projected = items.map((item): Projected => {
      const tools = disclosedTools(item);
      const next = tools
        ? options.declaresAdditionalTools
          ? {
              type: "unknown",
              providerData: { type: "additional_tools", role: "developer", tools },
            }
          : {
              type: "unknown",
              providerData: { type: "message", role: "developer", content: item.content },
            }
        : item.type === "message" && item.role === "developer"
          ? { type: "unknown", providerData: item }
          : (scopedOpaqueArtifact(item, options) ??
            scopedToolCallArtifact(item, options) ??
            foreignReasoning(item, providerApi) ??
            portableChatMetadata(item));
      changed ||= next !== item;
      return next;
    });
    return withContinuationAnchors(changed ? withoutOmittedReasoning(projected) : items);
  }

  if (providerApi === "anthropic-messages") {
    if (items.some((item) => item.type === "compaction"))
      throw new ProviderHistoryIncompatibleError(providerApi, "compaction");
    let changed = false;
    const projected = items.map((item): Projected => {
      const next = disclosedTools(item)
        ? { type: "message", role: "system", content: item.content }
        : item.type === "message" && item.role === "developer"
          ? { ...item, role: "system" }
          : (scopedOpaqueArtifact(item, options) ??
            foreignReasoning(item, providerApi) ??
            portableChatMetadata(item));
      changed ||= next !== item;
      return next;
    });
    // Claude accepts other assistant content inside its reply, after its tool
    // calls, and a system notice right before the results, but nothing
    // between two results of one step. Such an item that falls there (another
    // provider's records become readable facts) moves back to just before the
    // step's first result; after the results it would open the next reply,
    // ahead of its thinking. The Claude adapter places system notices.
    return withItemsAfterOpenCalls(
      changed ? withoutOmittedReasoning(projected) : items,
      (item) => isClaudeAssistantContent(item) || isSystemMessage(item),
      {
        resultTypeByCallType: FUNCTION_RESULT_TYPE_BY_CALL_TYPE,
        placement: "before-results",
        endsStep: isPersonMessage,
      },
    );
  }
  const incompatibleCallIds = new Set<string>();
  for (const item of items) {
    if (item.type === "compaction") {
      throw new ProviderHistoryIncompatibleError(providerApi, "compaction");
    }
    if (isChatIncompatibleCall(item)) {
      const id = callId(item);
      if (id) incompatibleCallIds.add(id);
    }
  }

  let changed = false;
  // Request-local tool disclosures that Chat receives as user messages.
  const machineOrigin = new Set<Record<string, unknown>>();
  const isRuntimeNotice = (item: Record<string, unknown>) =>
    isSystemMessage(item) || machineOrigin.has(item) || isHostedSearchEvidenceRecord(item);
  const projected = items.map((canonical): Projected => {
    const scoped = scopedToolCallArtifact(canonical, options);
    if (scoped) changed = true;
    const item = scoped ?? canonical;
    if (disclosedTools(item)) {
      changed = true;
      if (!options.hoistsSystemMessages)
        return { type: "message", role: "system", content: item.content };
      const notice = {
        type: "message",
        role: "user",
        content: `${MACHINE_ORIGIN_PREFIX}\n${item.content}`,
      };
      machineOrigin.add(notice);
      return notice;
    }
    const reasoning = foreignReasoning(item, providerApi);
    if (reasoning) {
      changed = true;
      return reasoning;
    }
    if (item.type === "message" && (item.role === "developer" || item.role === "system")) {
      const content = chatSystemContent(item.content);
      if (item.role === "developer" || content !== item.content) {
        changed = true;
        return { ...item, role: "system", content };
      }
    }
    const resultId = item.type === "function_call_result" ? callId(item) : null;
    if (
      CHAT_INCOMPATIBLE_ITEM_TYPES.has(String(item.type ?? "")) ||
      isChatIncompatibleHostedToolCall(item) ||
      isChatIncompatibleCall(item) ||
      (resultId !== null && incompatibleCallIds.has(resultId))
    ) {
      changed = true;
      return historicalFact(item);
    }
    return item;
  });
  // Chat Completions ends an assistant tool_calls message at any other
  // message, and a tool result must answer the message right before it.
  // Historical facts, any other assistant message and runtime notices inside
  // an unfinished step wait for its last result. Only a person's message ends
  // a step early.
  return withContinuationAnchors(
    withItemsAfterOpenCalls(
      changed ? withoutOmittedReasoning(projected) : items,
      (item) => isAssistantMessage(item) || isRuntimeNotice(item),
      {
        resultTypeByCallType: FUNCTION_RESULT_TYPE_BY_CALL_TYPE,
        endsStep: (item) => isPersonMessage(item) && !machineOrigin.has(item),
      },
    ),
  );
}

/**
 * A system or developer message that follows the model's own reply, with no
 * user message after it before the model speaks again, answers nothing. A
 * route that moves system messages out of the conversation (Claude behind a
 * Responses or Chat gateway, Gemini on Chat) then ends the request on that
 * reply, which the model reads as its own unfinished message: it continues
 * the old reply or returns nothing at all. This is the shape of every
 * machine-started turn (a delivered update, a reply reminder) after an
 * answered turn. A request-local machine-origin user message goes before each
 * such run of system messages, as the Claude adapter does
 * (placeConversationSystems). The decision depends only on the items, so the
 * next request of the turn reproduces the same prefix.
 *
 * It applies to every Responses and Chat route, including native OpenAI and
 * Codex Responses, which keep system messages in place and do not need it:
 * the route cannot tell which model sits behind a gateway. A session whose
 * history already has such a run gets the anchor in its earlier prefix once,
 * so its first request after the change misses the prompt cache once.
 */
function withContinuationAnchors(
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let result: Array<Record<string, unknown>> | undefined;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const previous = index > 0 ? items[index - 1]! : undefined;
    if (previous && isSystemLikeItem(item) && endsModelReply(previous)) {
      let next = index + 1;
      while (next < items.length && isSystemLikeItem(items[next]!)) next++;
      const following = items[next];
      if (!following || !isUserRoleMessage(following)) {
        result ??= items.slice(0, index);
        result.push({ type: "message", role: "user", content: MACHINE_CONTINUATION_TEXT });
      }
    }
    result?.push(item);
  }
  return result ?? items;
}

/** A system/developer message, including the Responses pass-through forms. */
function isSystemLikeItem(item: Record<string, unknown>): boolean {
  if (isSystemMessage(item)) return true;
  if (item.type !== "unknown") return false;
  const role = (item.providerData as Record<string, unknown> | undefined)?.role;
  return role === "developer" || role === "system";
}

function endsModelReply(item: Record<string, unknown>): boolean {
  return isAssistantMessage(item) || item.type === "reasoning";
}

function isUserRoleMessage(item: Record<string, unknown>): boolean {
  return isMessage(item) && item.role === "user";
}

/** After wire projection, only function calls are executable on Chat and Claude. */
const FUNCTION_RESULT_TYPE_BY_CALL_TYPE = { function_call: "function_call_result" } as const;

function isMessage(item: Record<string, unknown>): boolean {
  return item.type === undefined || item.type === "message";
}

function isAssistantMessage(item: Record<string, unknown>): boolean {
  return isMessage(item) && item.role === "assistant";
}

function isSystemMessage(item: Record<string, unknown>): boolean {
  return isMessage(item) && (item.role === "system" || item.role === "developer");
}

/** A user-role message other than a runtime search record. */
function isPersonMessage(item: Record<string, unknown>): boolean {
  return isMessage(item) && item.role === "user" && !isHostedSearchEvidenceRecord(item);
}

/** An item `anthropicMessages` sends as Claude's own content, other than a tool call. */
function isClaudeAssistantContent(item: Record<string, unknown>): boolean {
  if (isMessage(item)) return item.role === "assistant";
  return item.type !== "function_call" && item.type !== "function_call_result";
}
