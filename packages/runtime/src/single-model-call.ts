import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import type { ReasoningEffort } from "@opengeni/contracts";
import type OpenAI from "openai";
import { AnthropicMessagesModel } from "./anthropic-messages";
import { instrumentedModelFetch } from "./model-provider-client";
import { modelResponseUsageFromResponse, type ModelResponseUsage } from "./run-events";

/**
 * One stateless model request: no tools, no agent loop, no session. Session
 * titles and the public chat completions endpoint both use this function, so
 * every provider wire (Chat Completions, Responses, Claude Messages) has one
 * request builder and one result reader for single calls.
 */

export type SingleModelCallContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" };

export type SingleModelCallMessage = {
  role: "system" | "user" | "assistant";
  content: string | SingleModelCallContentPart[];
};

export type SingleModelCallOutputFormat =
  | { type: "text" }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };

export type SingleModelCallRequest = {
  messages: readonly SingleModelCallMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: readonly string[];
  reasoningEffort?: ReasoningEffort;
  verbosity?: "low" | "medium" | "high";
  serviceTier?: "fast" | "priority";
  outputFormat?: SingleModelCallOutputFormat;
  signal?: AbortSignal;
};

export type SingleModelCallFinishReason = "stop" | "length" | "content_filter";

export type SingleModelCallResult = {
  text: string;
  finishReason: SingleModelCallFinishReason;
  usage: ModelResponseUsage | null;
};

/**
 * A resolved provider binding, or (tests only) a scripted model with no
 * provider client.
 */
export type SingleModelCallTarget =
  | { client: OpenAI; provider: ResolvedModelProvider; modelId: string }
  | { model: Model };

export type SingleModelCallOptions = {
  /** Receives visible output text as the provider streams it. */
  onTextDelta?: (delta: string) => void | Promise<void>;
};

/** The request uses a parameter the selected provider wire cannot honor. */
export class SingleModelCallUnsupportedError extends Error {
  constructor(
    readonly parameter: string,
    message: string,
  ) {
    super(message);
    this.name = "SingleModelCallUnsupportedError";
  }
}

/** The provider ended the request without a usable result. */
export class SingleModelCallProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SingleModelCallProviderError";
  }
}

export async function runSingleModelCall(
  target: SingleModelCallTarget,
  request: SingleModelCallRequest,
  options: SingleModelCallOptions = {},
): Promise<SingleModelCallResult> {
  if (!request.messages.some((message) => message.role !== "system")) {
    throw new SingleModelCallUnsupportedError(
      "messages",
      "At least one user or assistant message is required",
    );
  }
  if ("model" in target) {
    return await runAgentsModelCall(target.model, request, options, false);
  }
  const { client, provider, modelId } = target;
  if (provider.api === "chat") {
    return await runChatCall(client, modelId, request, options);
  }
  if (provider.api === "anthropic-messages") {
    return await runAgentsModelCall(
      new AnthropicMessagesModel(
        provider,
        modelId,
        instrumentedModelFetch(provider.id, globalThis.fetch),
      ),
      request,
      options,
      true,
    );
  }
  return await runResponsesCall(client, provider, modelId, request, options);
}

/** Leading system messages become instructions; later ones stay in place. */
function splitInstructions(messages: readonly SingleModelCallMessage[]): {
  instructions: string | undefined;
  conversation: readonly SingleModelCallMessage[];
} {
  let index = 0;
  const parts: string[] = [];
  while (index < messages.length && messages[index]!.role === "system") {
    parts.push(messageText(messages[index]!));
    index += 1;
  }
  return {
    instructions: parts.length > 0 ? parts.join("\n\n") : undefined,
    conversation: messages.slice(index),
  };
}

function messageText(message: SingleModelCallMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function contentParts(message: SingleModelCallMessage): SingleModelCallContentPart[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

async function emit(options: SingleModelCallOptions, delta: string): Promise<void> {
  if (delta && options.onTextDelta) await options.onTextDelta(delta);
}

// ---------------------------------------------------------------------------
// Chat Completions wire
// ---------------------------------------------------------------------------

function chatMessages(messages: readonly SingleModelCallMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return { role: message.role, content: messageText(message) };
    }
    return {
      role: "user",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "image_url",
              image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) },
            },
      ),
    };
  });
}

function chatFinishReason(value: unknown): SingleModelCallFinishReason {
  return value === "length" ? "length" : value === "content_filter" ? "content_filter" : "stop";
}

async function runChatCall(
  client: OpenAI,
  modelId: string,
  request: SingleModelCallRequest,
  options: SingleModelCallOptions,
): Promise<SingleModelCallResult> {
  const stream = options.onTextDelta !== undefined;
  const body: Record<string, unknown> = {
    model: modelId,
    messages: chatMessages(request.messages),
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.stop?.length ? { stop: [...request.stop] } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
    ...(request.outputFormat?.type === "json_schema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.outputFormat.name,
              schema: request.outputFormat.schema,
              strict: request.outputFormat.strict,
            },
          },
        }
      : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  if (!stream) {
    const completion = await client.chat.completions.create(body as never, requestOptions);
    const choice = (
      completion as {
        choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>;
      }
    ).choices?.[0];
    const content = choice?.message?.content;
    return {
      text: typeof content === "string" ? content : "",
      finishReason: chatFinishReason(choice?.finish_reason),
      usage: modelResponseUsageFromResponse(completion),
    };
  }
  const chunks = (await client.chat.completions.create(
    body as never,
    requestOptions,
  )) as unknown as AsyncIterable<Record<string, unknown>>;
  let text = "";
  let finishReason: unknown;
  let usageChunk: Record<string, unknown> | null = null;
  for await (const chunk of chunks) {
    const choice = (
      chunk.choices as Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> | undefined
    )?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      await emit(options, delta);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage && typeof chunk.usage === "object") usageChunk = chunk;
  }
  return {
    text,
    finishReason: chatFinishReason(finishReason),
    usage: usageChunk ? modelResponseUsageFromResponse(usageChunk) : null,
  };
}

// ---------------------------------------------------------------------------
// Responses wire
// ---------------------------------------------------------------------------

function responsesInput(messages: readonly SingleModelCallMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return { role: "assistant", content: messageText(message) };
    }
    if (message.role === "system") {
      return { role: "developer", content: messageText(message) };
    }
    return {
      role: "user",
      content: contentParts(message).map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.url, detail: part.detail ?? "auto" },
      ),
    };
  });
}

function responsesOutputText(response: unknown): string {
  const output = (response as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return "";
  let text = "";
  for (const item of output) {
    if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content))
      continue;
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

function responsesFinishReason(response: unknown): SingleModelCallFinishReason {
  const record = response as {
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
  } | null;
  if (record?.status !== "incomplete") return "stop";
  return record.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
}

/**
 * Streamed when the caller wants deltas or the provider is a subscription
 * backend (they require it). The raw stream is read directly so an
 * output-limit stop stays a normal `length` result instead of an error.
 */
async function runResponsesCall(
  client: OpenAI,
  provider: ResolvedModelProvider,
  modelId: string,
  request: SingleModelCallRequest,
  options: SingleModelCallOptions,
): Promise<SingleModelCallResult> {
  if (request.stop?.length) {
    throw new SingleModelCallUnsupportedError(
      "stop",
      "Stop sequences are not supported by this model's provider",
    );
  }
  const { instructions, conversation } = splitInstructions(request.messages);
  const format =
    request.outputFormat?.type === "json_schema"
      ? {
          format: {
            type: "json_schema",
            name: request.outputFormat.name,
            schema: request.outputFormat.schema,
            strict: request.outputFormat.strict,
          },
        }
      : {};
  const text = { ...(request.verbosity ? { verbosity: request.verbosity } : {}), ...format };
  const body: Record<string, unknown> = {
    model: modelId,
    ...(instructions !== undefined ? { instructions } : {}),
    input: responsesInput(conversation),
    ...(request.maxOutputTokens !== undefined
      ? { max_output_tokens: request.maxOutputTokens }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(Object.keys(text).length > 0 ? { text } : {}),
    ...(provider.wireProfile === "azure-openai" ? {} : { store: false }),
    ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
  };
  const requestOptions = request.signal ? { signal: request.signal } : undefined;
  const stream =
    options.onTextDelta !== undefined ||
    provider.kind === "codex-subscription" ||
    provider.kind === "xai-subscription";
  if (!stream) {
    const response = await client.responses.create(body as never, requestOptions);
    if ((response as { status?: unknown }).status === "failed") {
      const error = (response as { error?: { message?: unknown } | null }).error;
      throw new SingleModelCallProviderError(
        typeof error?.message === "string" ? error.message : "The model request failed",
      );
    }
    return {
      text: responsesOutputText(response),
      finishReason: responsesFinishReason(response),
      usage: modelResponseUsageFromResponse(response),
    };
  }
  const events = (await client.responses.create(
    { ...body, stream: true } as never,
    requestOptions,
  )) as unknown as AsyncIterable<Record<string, unknown>>;
  let streamed = "";
  let terminal: Record<string, unknown> | null = null;
  for await (const event of events) {
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta) {
          streamed += event.delta;
          await emit(options, event.delta);
        }
        break;
      case "response.completed":
      case "response.incomplete":
        terminal = (event.response as Record<string, unknown> | undefined) ?? {};
        break;
      case "response.failed": {
        const error = (event.response as { error?: { message?: unknown } } | undefined)?.error;
        throw new SingleModelCallProviderError(
          typeof error?.message === "string" ? error.message : "The model request failed",
        );
      }
      case "error":
        throw new SingleModelCallProviderError(
          typeof event.message === "string" ? event.message : "The model request failed",
        );
    }
    if (terminal) break;
  }
  if (!terminal) {
    throw new SingleModelCallProviderError("The model stream ended without a final response");
  }
  let output = streamed;
  if (!output) {
    // Some compatible providers return the text only on the final response.
    output = responsesOutputText(terminal);
    await emit(options, output);
  }
  return {
    text: output,
    finishReason: responsesFinishReason(terminal),
    usage: modelResponseUsageFromResponse(terminal),
  };
}

// ---------------------------------------------------------------------------
// Agents SDK models (Claude Messages, and scripted test models)
// ---------------------------------------------------------------------------

function agentsInput(messages: readonly SingleModelCallMessage[]): ModelRequest["input"] {
  return messages.map((message) => {
    if (message.role === "system") {
      return { role: "system", content: messageText(message) };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: messageText(message) }],
      };
    }
    return {
      role: "user",
      content: contentParts(message).map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : {
              type: "input_image",
              image: part.url,
              ...(part.detail ? { detail: part.detail } : {}),
            },
      ),
    };
  }) as ModelRequest["input"];
}

function agentsFinishReason(response: ModelResponse): SingleModelCallFinishReason {
  const providerData = response.providerData as
    | {
        status?: unknown;
        incomplete_details?: { reason?: unknown };
        anthropic?: { stopReason?: unknown };
      }
    | undefined;
  const stopReason = providerData?.anthropic?.stopReason;
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "content_filter";
  if (providerData?.status === "incomplete") {
    return providerData.incomplete_details?.reason === "content_filter"
      ? "content_filter"
      : "length";
  }
  return "stop";
}

async function runAgentsModelCall(
  model: Model,
  request: SingleModelCallRequest,
  options: SingleModelCallOptions,
  supportsStop: boolean,
): Promise<SingleModelCallResult> {
  if (request.stop?.length && !supportsStop) {
    throw new SingleModelCallUnsupportedError(
      "stop",
      "Stop sequences are not supported by this model's provider",
    );
  }
  const { instructions, conversation } = splitInstructions(request.messages);
  const providerData: Record<string, unknown> = {
    ...(request.stop?.length ? { stop_sequences: [...request.stop] } : {}),
    ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
  };
  const modelRequest: ModelRequest = {
    ...(instructions !== undefined ? { systemInstructions: instructions } : {}),
    input: agentsInput(conversation),
    modelSettings: {
      ...(request.maxOutputTokens !== undefined ? { maxTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { topP: request.topP } : {}),
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
      ...(request.verbosity ? { text: { verbosity: request.verbosity } } : {}),
      ...(Object.keys(providerData).length > 0 ? { providerData } : {}),
    },
    tools: [],
    toolsExplicitlyProvided: true,
    outputType:
      request.outputFormat?.type === "json_schema"
        ? {
            type: "json_schema",
            name: request.outputFormat.name,
            strict: request.outputFormat.strict,
            schema: request.outputFormat.schema as never,
          }
        : "text",
    handoffs: [],
    tracing: false,
    ...(request.signal ? { signal: request.signal } : {}),
  };
  let response: ModelResponse | undefined;
  let streamed = "";
  if (options.onTextDelta) {
    for await (const event of model.getStreamedResponse(modelRequest)) {
      if (event.type === "output_text_delta" && event.delta) {
        streamed += event.delta;
        await emit(options, event.delta);
      } else if (event.type === "response_done") {
        response = event.response as unknown as ModelResponse;
      }
    }
    if (!response) {
      throw new SingleModelCallProviderError("The model stream ended without a final response");
    }
  } else {
    response = await model.getResponse(modelRequest);
  }
  let text = streamed;
  if (!text) {
    text = responsesOutputText(response);
    await emit(options, text);
  }
  return {
    text,
    finishReason: agentsFinishReason(response),
    usage: modelResponseUsageFromResponse(response),
  };
}
