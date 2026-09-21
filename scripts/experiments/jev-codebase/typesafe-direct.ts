import { validateAnswers, type Question, type Judgment } from "./core";

export const TYPESAFE_MODEL = "jev-1.13.0";
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_INPUT_RATE = 0.042 / 1_000_000;
export function assertNativeCredential(
  apiKey: string | undefined,
  gatewayKey = process.env.VERCEL_AI_GATEWAY_API_KEY,
): asserts apiKey is string {
  if (!apiKey) throw new Error("typesafe_key_missing");
  if (apiKey === gatewayKey) throw new Error("gateway_credential_for_native_forbidden");
}
export async function listNativeModels(
  apiKey: string,
  gatewayKey: string | undefined,
  transport: typeof fetch = fetch,
) {
  assertNativeCredential(apiKey, gatewayKey);
  const response = await transport("https://api.typesafe.ai/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("native_models_http_" + response.status);
  return response.json();
}
const safeCorrelation = (value: string | null, secret: string) =>
  value && !value.includes(secret) && /^[A-Za-z0-9:_-]{1,256}$/.test(value) ? value : undefined;

/** Explicit native route: never accepts a Gateway credential or silently falls back. */
export async function evaluateDirect(
  payload: { state: unknown; questions: Record<string, Question> },
  options: { apiKey: string; signal: AbortSignal; transport?: typeof fetch },
) {
  assertNativeCredential(options.apiKey);
  if (Object.values(payload.questions).some((q) => q.type !== "choice"))
    throw new Error("unsupported_native_question");
  options.signal.throwIfAborted();
  const response = await (options.transport ?? fetch)(TYPESAFE_ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: options.signal,
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: TYPESAFE_MODEL,
      state: payload.state,
      questions: payload.questions,
    }),
  });
  if (!response.ok) {
    // Deliberately omit arbitrary error text; retain status and bounded correlation only.
    const error = Object.assign(new Error("typesafe_http_failure"), {
      name: "TypeSafeHTTPError",
      statusCode: response.status,
      cause: {
        responseHeaders: Object.fromEntries(
          ["x-request-id", "retry-after"]
            .map((k) => [k, safeCorrelation(response.headers.get(k), options.apiKey)])
            .filter(([, v]) => v !== undefined),
        ),
      },
    });
    await response.body?.cancel();
    throw error;
  }
  const data: any = await response.json();
  options.signal.throwIfAborted();
  if (data.model !== TYPESAFE_MODEL) throw new Error("unexpected_typesafe_model");
  validateAnswers(payload.questions, data.answers as Record<string, Judgment>);
  for (const answer of Object.values(data.answers) as any[]) {
    if (
      answer.type !== "choice" ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    )
      throw new Error("invalid_typesafe_answer");
  }
  const inputTokens = data.usage?.input_tokens,
    outputTokens = data.usage?.output_tokens;
  if (![inputTokens, outputTokens].every((n) => Number.isInteger(n) && n >= 0))
    throw new Error("invalid_typesafe_usage");
  return {
    answers: data.answers as Record<string, Judgment>,
    usage: { inputTokens, outputTokens },
    response: { modelId: data.model },
    providerMetadata: {
      typesafe: {
        requestId: safeCorrelation(response.headers.get("x-request-id"), options.apiKey),
        costBasis: "catalog_estimate_not_invoice",
      },
    },
  };
}
