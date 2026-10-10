import { ReasoningEffort } from "@opengeni/contracts";
import { ModelCallError, type ModelCallInput } from "@opengeni/core";
import {
  normalizeModelCallUsage,
  type SingleModelCallContentPart,
  type SingleModelCallMessage,
  type SingleModelCallResult,
} from "@opengeni/runtime";
import { z } from "zod";

/**
 * The OpenAI Chat Completions wire format for stateless single model calls:
 * text and image messages, sampling and output-length controls, reasoning
 * effort, JSON-schema output and streaming. Anything agentic (tools, function
 * calls, hosted search, audio) is refused with a 400 naming the parameter;
 * agentic work uses sessions.
 */

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const ImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});
const RefusalPart = z.object({ type: z.literal("refusal"), refusal: z.string() });

const Message = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.unknown().optional(),
  function_call: z.unknown().optional(),
  tool_call_id: z.unknown().optional(),
  audio: z.unknown().optional(),
});

const JsonSchemaFormat = z.object({
  type: z.literal("json_schema"),
  json_schema: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 letters, digits, _ or -"),
    description: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
    strict: z.boolean().nullish(),
  }),
});

const ChatCompletionRequest = z.object({
  model: z.string().trim().min(1).max(256).nullish(),
  messages: z.array(Message).min(1).max(4096),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  reasoning_effort: ReasoningEffort.nullish(),
  verbosity: z.enum(["low", "medium", "high"]).nullish(),
  response_format: z.object({ type: z.string() }).passthrough().nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
  n: z.number().int().nullish(),
});

/** Parameters with no meaning without tools or outside text output. */
const AGENTIC_PARAMETERS = [
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "web_search_options",
  "audio",
  "prediction",
] as const;

export type ParsedChatCompletionRequest = {
  model: string | null;
  request: ModelCallInput["request"];
  stream: boolean;
  includeUsage: boolean;
};

function invalid(message: string, param: string | null, code = "invalid_value"): ModelCallError {
  return new ModelCallError({ status: 400, type: "invalid_request_error", code, param, message });
}

function unsupported(param: string, message: string): ModelCallError {
  return invalid(message, param, "unsupported_parameter");
}

function issueParam(path: readonly PropertyKey[]): string {
  let param = "";
  for (const segment of path) {
    param +=
      typeof segment === "number"
        ? `[${segment}]`
        : param
          ? `.${String(segment)}`
          : String(segment);
  }
  return param;
}

function present(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function refuseUnsupported(body: Record<string, unknown>): void {
  for (const key of AGENTIC_PARAMETERS) {
    if (present(body[key])) {
      throw unsupported(
        key,
        `'${key}' is not supported: this endpoint makes single model calls without tools. Use sessions for agentic work.`,
      );
    }
  }
  if (body.logprobs === true || present(body.top_logprobs)) {
    throw unsupported(
      body.logprobs === true ? "logprobs" : "top_logprobs",
      "Log probabilities are not supported.",
    );
  }
  if (present(body.logit_bias)) throw unsupported("logit_bias", "'logit_bias' is not supported.");
  for (const key of ["presence_penalty", "frequency_penalty"] as const) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== 0) {
      throw unsupported(key, `'${key}' is not supported.`);
    }
  }
  if (body.store === true) {
    throw unsupported("store", "Stored completions are not supported; requests are stateless.");
  }
  const modalities = body.modalities;
  if (Array.isArray(modalities) && modalities.some((modality) => modality !== "text")) {
    throw unsupported("modalities", "Only text output is supported.");
  }
}

function textOf(parts: Record<string, unknown>[], param: string, allowRefusal: boolean): string {
  return parts
    .map((part, index) => {
      const text = TextPart.safeParse(part);
      if (text.success) return text.data.text;
      const refusal = allowRefusal ? RefusalPart.safeParse(part) : null;
      if (refusal?.success) return refusal.data.refusal;
      throw invalid(
        `Only text content is supported for this message role.`,
        `${param}[${index}]`,
        "unsupported_content",
      );
    })
    .join("");
}

function userContent(
  parts: Record<string, unknown>[],
  param: string,
): string | SingleModelCallContentPart[] {
  return parts.map((part, index): SingleModelCallContentPart => {
    const text = TextPart.safeParse(part);
    if (text.success) return { type: "text", text: text.data.text };
    const image = ImagePart.safeParse(part);
    if (image.success) {
      return {
        type: "image",
        url: image.data.image_url.url,
        ...(image.data.image_url.detail ? { detail: image.data.image_url.detail } : {}),
      };
    }
    throw invalid(
      `Unsupported content part type '${String(part.type)}'. Text and image_url parts are supported.`,
      `${param}[${index}]`,
      "unsupported_content",
    );
  });
}

function messages(input: z.infer<typeof Message>[]): SingleModelCallMessage[] {
  return input.map((message, index): SingleModelCallMessage => {
    const param = `messages[${index}]`;
    if (message.role === "tool" || message.role === "function") {
      throw unsupported(
        `${param}.role`,
        `'${message.role}' messages are not supported without tools.`,
      );
    }
    if (present(message.tool_calls) || present(message.function_call)) {
      throw unsupported(`${param}.tool_calls`, "Tool calls are not supported.");
    }
    if (present(message.audio)) throw unsupported(`${param}.audio`, "Audio is not supported.");
    const content = message.content ?? null;
    if (message.role === "system" || message.role === "developer") {
      if (content === null) throw invalid("System messages need content.", `${param}.content`);
      return {
        role: "system",
        content: typeof content === "string" ? content : textOf(content, `${param}.content`, false),
      };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content:
          content === null
            ? ""
            : typeof content === "string"
              ? content
              : textOf(content, `${param}.content`, true),
      };
    }
    if (message.role === "user") {
      if (content === null) throw invalid("User messages need content.", `${param}.content`);
      return {
        role: "user",
        content: typeof content === "string" ? content : userContent(content, `${param}.content`),
      };
    }
    throw invalid(`Unknown message role '${message.role}'.`, `${param}.role`);
  });
}

export function parseChatCompletionRequest(body: unknown): ParsedChatCompletionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("The request body must be a JSON object.", null);
  }
  refuseUnsupported(body as Record<string, unknown>);
  const parsed = ChatCompletionRequest.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const param = issueParam(issue.path);
    throw invalid(param ? `Invalid '${param}': ${issue.message}` : issue.message, param || null);
  }
  const data = parsed.data;
  if (data.n !== null && data.n !== undefined && data.n !== 1) {
    throw unsupported("n", "Only one choice per request is supported.");
  }
  const format = data.response_format;
  if (format && format.type !== "text" && format.type !== "json_schema") {
    throw unsupported(
      "response_format",
      format.type === "json_object"
        ? "JSON mode is not supported; use response_format type 'json_schema'."
        : `Unsupported response_format type '${format.type}'.`,
    );
  }
  let jsonSchema: z.infer<typeof JsonSchemaFormat>["json_schema"] | null = null;
  if (format?.type === "json_schema") {
    const schema = JsonSchemaFormat.safeParse(format);
    if (!schema.success) {
      const issue = schema.error.issues[0]!;
      const param = issueParam(["response_format", ...issue.path]);
      throw invalid(`Invalid '${param}': ${issue.message}`, param);
    }
    jsonSchema = schema.data.json_schema;
  }
  const maxOutputTokens = data.max_completion_tokens ?? data.max_tokens ?? undefined;
  const stop = typeof data.stop === "string" ? [data.stop] : (data.stop ?? undefined);
  const converted = messages(data.messages);
  if (!converted.some((message) => message.role !== "system")) {
    throw invalid("At least one user or assistant message is required.", "messages");
  }
  return {
    model: data.model ?? null,
    stream: data.stream === true,
    includeUsage: data.stream_options?.include_usage === true,
    request: {
      messages: converted,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(data.temperature != null ? { temperature: data.temperature } : {}),
      ...(data.top_p != null ? { topP: data.top_p } : {}),
      ...(stop?.length ? { stop } : {}),
      ...(data.reasoning_effort ? { reasoningEffort: data.reasoning_effort } : {}),
      ...(data.verbosity ? { verbosity: data.verbosity } : {}),
      ...(jsonSchema
        ? {
            outputFormat: {
              type: "json_schema" as const,
              name: jsonSchema.name,
              schema: jsonSchema.schema,
              strict: jsonSchema.strict ?? false,
            },
          }
        : {}),
    },
  };
}

export function chatCompletionUsage(usage: SingleModelCallResult["usage"]) {
  if (!usage) return null;
  const normalized = normalizeModelCallUsage(usage.usage);
  const prompt = normalized.telemetry.inputTokens ?? 0;
  const completion = normalized.telemetry.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: normalized.totalTokens ?? prompt + completion,
    prompt_tokens_details: { cached_tokens: normalized.telemetry.cachedTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: normalized.telemetry.reasoningTokens ?? 0 },
  };
}

export function chatCompletionId(requestId: string): string {
  return `chatcmpl-${requestId.replaceAll("-", "")}`;
}

export function chatCompletionResponse(input: {
  requestId: string;
  created: number;
  model: string;
  result: SingleModelCallResult;
}) {
  return {
    id: chatCompletionId(input.requestId),
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.result.text, refusal: null },
        logprobs: null,
        finish_reason: input.result.finishReason,
      },
    ],
    usage: chatCompletionUsage(input.result.usage),
  };
}

export function chatCompletionChunk(input: {
  requestId: string;
  created: number;
  model: string;
  delta: { role?: "assistant"; content?: string };
  finishReason: SingleModelCallResult["finishReason"] | null;
  includeUsage: boolean;
}) {
  return {
    id: chatCompletionId(input.requestId),
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [{ index: 0, delta: input.delta, logprobs: null, finish_reason: input.finishReason }],
    ...(input.includeUsage ? { usage: null } : {}),
  };
}

export function chatCompletionError(error: ModelCallError) {
  return {
    error: { message: error.message, type: error.type, param: error.param, code: error.code },
  };
}
