import type { XaiHostedSearchOptions } from "./request-context";

const XAI_INTERNAL_MODEL_HANDOFF_PREFIX = "supergrok/";

export function normalizeXaiSubscriptionRequestBody(
  value: unknown,
  resolveModel: (slug: string) => string,
  hostedSearch?: XaiHostedSearchOptions,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SuperGrok subscription request body must be a JSON object");
  }
  const body = { ...(value as Record<string, unknown>) };
  if (typeof body.model !== "string") {
    throw new Error("SuperGrok subscription request is missing model");
  }
  const candidate = body.model.startsWith(XAI_INTERNAL_MODEL_HANDOFF_PREFIX)
    ? body.model.slice(XAI_INTERNAL_MODEL_HANDOFF_PREFIX.length)
    : body.model;
  body.model = resolveModel(candidate);
  body.store = false;

  const include = Array.isArray(body.include)
    ? body.include.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  body.include = include;

  const tools = Array.isArray(body.tools) ? body.tools.map(normalizeXaiSubscriptionTool) : [];
  appendHostedTool(tools, "web_search", hostedSearch?.webSearch);
  appendHostedTool(tools, "x_search", hostedSearch?.xSearch);
  if (tools.length > 0) body.tools = tools;
  return body;
}

function normalizeXaiSubscriptionTool(tool: unknown): unknown {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
  const record = tool as Record<string, unknown>;
  if (record.type !== "web_search") return tool;
  // OpenAI's Responses tool factory adds this tuning hint. Grok's CLI proxy
  // supports native web_search but rejects the OpenAI-only argument.
  const { search_context_size: _unsupported, ...supported } = record;
  return supported;
}

function appendHostedTool(
  tools: unknown[],
  type: "web_search" | "x_search",
  options: boolean | Record<string, unknown> | undefined,
): void {
  if (!options) return;
  if (
    tools.some(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        !Array.isArray(tool) &&
        (tool as Record<string, unknown>).type === type,
    )
  ) {
    return;
  }
  tools.push(normalizeXaiSubscriptionTool(options === true ? { type } : { type, ...options }));
}

export function normalizeXaiResponseEventJson(value: unknown): {
  value: unknown;
  finalContextTokens: number | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, finalContextTokens: null };
  }
  const event = value as Record<string, unknown>;
  const response =
    event.response && typeof event.response === "object" && !Array.isArray(event.response)
      ? { ...(event.response as Record<string, unknown>) }
      : null;
  if (!response) return { value, finalContextTokens: null };

  let changed = false;
  if (Array.isArray(response.tools)) {
    const filtered = response.tools.filter((tool) => isOpenAiSdkResponseTool(tool));
    if (filtered.length !== response.tools.length) {
      response.tools = filtered;
      changed = true;
    }
  }

  let finalContextTokens: number | null = null;
  if (event.type === "response.completed" || event.type === "response.incomplete") {
    const usage =
      response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
        ? { ...(response.usage as Record<string, unknown>) }
        : null;
    const context =
      usage?.context_details &&
      typeof usage.context_details === "object" &&
      !Array.isArray(usage.context_details)
        ? (usage.context_details as Record<string, unknown>)
        : null;
    const inputTokens = finiteNonNegativeInteger(context?.input_tokens);
    const outputTokens = finiteNonNegativeInteger(context?.output_tokens);
    if (usage && inputTokens !== null && outputTokens !== null) {
      finalContextTokens = inputTokens + outputTokens;
      usage.total_tokens = finalContextTokens;
      response.usage = usage;
      changed = true;
    }
  }
  return {
    value: changed ? { ...event, response } : value,
    finalContextTokens,
  };
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// The OpenAI SDK knows these Responses tool declaration families. x_search is
// intentionally absent: xAI executes it server-side and echoes it only in the
// response.tools declaration list, while its output items remain untouched.
function isOpenAiSdkResponseTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  const type = (tool as Record<string, unknown>).type;
  return (
    typeof type === "string" &&
    [
      "function",
      "file_search",
      "computer_use_preview",
      "computer",
      "web_search",
      "web_search_preview",
      "code_interpreter",
      "image_generation",
      "local_shell",
      "shell",
      "apply_patch",
      "mcp",
      "custom",
    ].includes(type)
  );
}
