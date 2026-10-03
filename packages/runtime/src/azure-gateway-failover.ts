import { REPLAYABLE_REQUEST_BODY_FACTORY, requestBodyText } from "./replayable-json-body";

const FAILURE_STATUSES = new Set([429, 500, 502, 503, 504]);
const READ_ONLY_HOSTED_TOOLS = new Set([
  "function",
  "web_search",
  "web_search_preview",
  "tool_search",
]);
const GATEWAY_RESPONSES_URL = "https://ai-gateway.vercel.sh/v1/responses";

type ReplayableInit = RequestInit & {
  [REPLAYABLE_REQUEST_BODY_FACTORY]?: () => ReadableStream<Uint8Array>;
};

/**
 * One rejected Azure Responses request may use the exact same model through
 * deployment-owned Gateway credentials. A successful response belongs wholly
 * to its original stream. Lost acknowledgements, stream failures, cancellation,
 * provider-owned state, and unreviewed hosted tools grant no replay authority.
 */
export function azureGatewayFailoverFetch(
  models: Readonly<Record<string, string>>,
  gatewayKey: string,
  primary: typeof fetch,
  gateway: typeof fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: ReplayableInit) => {
    const response = await primary(input, init);
    if (
      init?.signal?.aborted ||
      init?.method?.toUpperCase() !== "POST" ||
      !isResponsesCreate(input)
    ) {
      return response;
    }
    const compatibilityRefusal =
      response.status === 400 && (await isEncryptedContentRefusal(response, init.signal));
    if (!FAILURE_STATUSES.has(response.status) && !compatibilityRefusal) return response;
    // A fresh iterator is mandatory after the primary consumed a streaming
    // body. Never consume/replay an arbitrary caller-owned one-shot stream.
    const body =
      typeof init.body === "string"
        ? init.body
        : init[REPLAYABLE_REQUEST_BODY_FACTORY]
          ? await requestBodyText(init[REPLAYABLE_REQUEST_BODY_FACTORY]!())
          : null;
    if (body === null) return response;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== "object" || Array.isArray(value)) return response;
      parsed = value as Record<string, unknown>;
    } catch {
      return response;
    }
    const model = typeof parsed.model === "string" ? parsed.model : "";
    if (
      !Object.hasOwn(models, model) ||
      parsed.previous_response_id ||
      parsed.conversation ||
      parsed.background === true ||
      !canReplayInput(parsed.input) ||
      !canReplayTools(parsed.tools)
    ) {
      return response;
    }
    if (
      compatibilityRefusal &&
      (!Array.isArray(parsed.input) ||
        !parsed.input.some(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "reasoning" &&
            typeof (item as Record<string, unknown>).encrypted_content === "string" &&
            (item as Record<string, unknown>).encrypted_content,
        ))
    )
      return response;
    // Replace caller routing wholesale. The fallback must neither use another
    // model nor loop back through the unavailable primary or unrelated keys.
    const nextBody = {
      ...parsed,
      model: models[model],
      providerOptions: {
        gateway: { only: ["openai"], order: ["openai"] },
      },
    };
    await response.body?.cancel().catch(() => undefined);
    init.signal?.throwIfAborted();
    // Start with a fresh header set: primary API keys, AD tokens, cookies,
    // organization/project identity and provider-specific query never cross.
    return await gateway(GATEWAY_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${gatewayKey}`, "content-type": "application/json" },
      body: JSON.stringify(nextBody),
      ...(init.signal ? { signal: init.signal } : {}),
      redirect: "error",
    });
  }) as typeof fetch;
}

/** One exact request-validation code permits continuing Gateway-origin reasoning. */
async function isEncryptedContentRefusal(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<boolean> {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const deadline = AbortSignal.any([AbortSignal.timeout(1000), ...(signal ? [signal] : [])]);
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  deadline.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (!deadline.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (deadline.aborted) return false;
        const data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        return data?.error?.code === "invalid_encrypted_content";
      }
      bytes += chunk.value.length;
      if (bytes > 16 * 1024) return false;
      chunks.push(chunk.value);
    }
  } catch {
    return false;
  } finally {
    deadline.removeEventListener("abort", cancel);
    cancel();
  }
  return false;
}

function isResponsesCreate(input: Parameters<typeof fetch>[0]): boolean {
  const url = input instanceof Request ? input.url : String(input);
  try {
    return new URL(url).pathname.endsWith("/responses");
  } catch {
    return false;
  }
}

function canReplayTools(tools: unknown): boolean {
  if (tools === undefined) return true;
  return (
    Array.isArray(tools) &&
    tools.every(
      (tool) =>
        tool &&
        typeof tool === "object" &&
        READ_ONLY_HOSTED_TOOLS.has((tool as Record<string, unknown>).type as string),
    )
  );
}

function canReplayInput(input: unknown): boolean {
  if (typeof input === "string") return true;
  if (!Array.isArray(input)) return false;
  // Provider-owned file/item locators and remote compaction are not portable.
  // Inline reasoning, including encrypted_content, remains byte-exact: the
  // same Responses model validates it; this transport never drops history.
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every(visit);
    const item = value as Record<string, unknown>;
    if (item.file_id || item.type === "item_reference" || item.type === "compaction") return false;
    return Object.values(item).every(visit);
  };
  return input.every(visit);
}
