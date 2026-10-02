import { APIError } from "openai";

/**
 * Provider quota exhaustion versus ordinary rate limiting.
 *
 * Model providers use HTTP 429 for two different conditions. An ordinary rate
 * limit (requests or tokens per minute) clears within seconds, so pacing the
 * same request again is correct. An exhausted quota (a daily or monthly
 * allowance, a free-tier day cap, or an account with no credits left) cannot
 * clear inside a bounded retry budget, so every retry only delays the failure.
 *
 * This module is the single classifier for API-key provider responses. It
 * reads only provider-owned evidence: the HTTP status, provider message/code
 * strings, and the provider's own retry hint. The OpenAI SDK retry veto and the
 * worker's turn classification both read that evidence from the same thrown
 * SDK error shape (`classifyProviderQuotaError`), so one response can never be
 * classified two ways. Subscription transports (Codex, SuperGrok) own their
 * quota semantics through credential rotation and durable capacity waits and
 * must not route through it.
 */

export const PROVIDER_QUOTA_EXHAUSTED_CODE = "provider_quota_exhausted";

/** What ran out. Chooses plain-language copy only; every scope is non-retryable. */
export type ProviderQuotaScope = "daily" | "monthly" | "credits" | "quota";

export type ProviderQuotaExhaustion = { scope: ProviderQuotaScope };

export type ProviderQuotaEvidence = {
  /** HTTP status when one survived the error wrappers; null when statusless. */
  status: number | null;
  /** Provider-authored message, code and type strings, in any order. */
  texts: readonly string[];
  /** Provider retry hint from a header or structured field, in milliseconds. */
  retryAfterMs: number | null;
};

/** A provider-stated wait at or below this is an ordinary short rate limit. */
export const PROVIDER_SHORT_RETRY_HINT_MS = 60_000;

/**
 * Without any quota wording, only a provider-stated wait beyond this proves a
 * quota window rather than per-minute pacing.
 */
export const PROVIDER_QUOTA_RETRY_HINT_MS = 15 * 60_000;

// Bound the text inspected per field and in total. Provider errors are short;
// a pathological body must not turn failure classification into a hot loop.
const MAX_FIELD_CHARS = 4_096;
const MAX_FIELDS = 64;

// Account-level exhaustion that nothing clears in seconds. Structured codes are
// matched exactly; wording is matched as a phrase. OpenAI's
// `billing_hard_limit_reached` is the organization's own spending cap.
const CREDIT_CODES = new Set([
  "insufficient_credits",
  "insufficient_balance",
  "billing_hard_limit_reached",
]);
const QUOTA_CODES = new Set(["insufficient_quota"]);
const CREDIT_TEXT =
  /\binsufficient[ _](?:credits?|balance|funds)\b|\bcredit balance is too low\b|\brequires more credits\b|\bout of credits\b|\bused all (?:of )?(?:your |the )?(?:available )?credits\b|\bspending limit\b|\bbilling[ _]hard[ _]limit\b|\breached your specified api usage limits?\b/;

// Generic quota wording, including a reached "usage limit". Google reports
// per-minute limits with the same "exceeded your current quota" sentence, so
// this alone is not decisive: an explicit per-minute scope or a short provider
// retry hint keeps it retryable.
// Google's `RESOURCE_EXHAUSTED` status is deliberately absent: it accompanies
// every Google 429, including short dynamic-shared-quota capacity refusals, so
// it only marks the response as rate-shaped.
const QUOTA_TEXT =
  /\bexceeded (?:your |the )?(?:current |allotted |daily |monthly )?quota\b|\bquota (?:has been |was |is )?(?:exceeded|exhausted|reached)\b|\bout of (?:call volume )?quota\b|\bquota[ _]?exceeded\b|\b(?:hit|reached|exceeded) (?:your |the |its )?(?:[a-z]+ )?usage limits?\b/;

// Explicit limit windows. "free-models-per-min" is OpenRouter's per-minute
// free tier; "free-models-per-day" its daily cap. GitHub/Azure AI inference
// name windows like "UserByModelByDay" or "per 86400s", and Google/Vertex
// metric ids join words with underscores
// ("generate_content_requests_per_minute_per_project"). Letter lookarounds
// rather than `\b` keep snake_case ids matching, since `_` is a word character.
const MINUTE_SCOPE =
  /(?<![a-z])per[ _-]?min(?:ute)?s?(?![a-z])|perminute|byminute|(?<![a-z])(?:rpm|tpm)(?![a-z])|\/min(?![a-z])|\bper 60 ?s\b|(?<![a-z])per[ _-]?second(?![a-z])/;
const DAY_SCOPE =
  /(?<![a-z])per[ _-]?day(?![a-z])|perday|byday|(?<![a-z])(?:rpd|tpd)(?![a-z])|(?<![a-z])daily(?![a-z])|\bper 86400 ?s\b/;
const MONTH_SCOPE = /(?<![a-z])per[ _-]?month(?![a-z])|permonth|bymonth|(?<![a-z])monthly(?![a-z])/;

const RATE_TEXT = /too many requests|rate.?limit|\b429\b|\bresource[ _]exhausted\b/;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

const DURATION_TOKEN =
  /^\s*(\d{1,9}(?:\.\d{1,12})?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])/i;

/** Parse a leading compound duration such as "16m32.64s", "6 seconds" or "7 days". */
function leadingDurationMs(text: string): number | null {
  let rest = text;
  let total = 0;
  let matched = false;
  for (let index = 0; index < 4; index += 1) {
    const token = DURATION_TOKEN.exec(rest);
    if (!token) break;
    const unit = UNIT_MS[token[2]!.toLowerCase()];
    if (unit === undefined) break;
    total += Number(token[1]) * unit;
    matched = true;
    rest = rest.slice(token[0].length);
  }
  return matched && Number.isFinite(total) ? Math.ceil(total) : null;
}

/**
 * Read a retry hint a provider wrote into its message ("Please retry after 6
 * seconds", "Please try again in 16m32.64s", "Please wait 42567 seconds before
 * retrying"). Used only to tell a short limit from an exhausted quota; it never
 * paces a retry.
 */
export function providerMessageRetryHintMs(text: string): number | null {
  let longest: number | null = null;
  const prefixes = /\b(?:retry|try again)\s+(?:after|in)\s+|\bwait\s+/gi;
  for (const match of text.slice(0, MAX_FIELD_CHARS * 4).matchAll(prefixes)) {
    const start = (match.index ?? 0) + match[0].length;
    const duration = leadingDurationMs(text.slice(start, start + 64));
    if (duration !== null) longest = longest === null ? duration : Math.max(longest, duration);
  }
  return longest;
}

/**
 * Decide whether a provider refusal is an exhausted quota. Returns null for an
 * ordinary short rate limit and for anything that is not provider quota
 * evidence at all (a sandbox "disk quota exceeded", an OpenGeni credit
 * refusal, a 5xx), so those keep their existing classification.
 */
export function classifyProviderQuotaExhaustion(
  evidence: ProviderQuotaEvidence,
): ProviderQuotaExhaustion | null {
  const fields = evidence.texts
    .slice(0, MAX_FIELDS)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.slice(0, MAX_FIELD_CHARS).toLowerCase());
  const text = fields.join("\n");
  if (text.includes("opengeni credits")) return null;

  const explicitStatus =
    evidence.status !== null && Number.isInteger(evidence.status) ? evidence.status : null;
  // SDK wrappers sometimes keep only the "429 ..." message prefix.
  const prefixedStatus = fields
    .map((value) => /^\s*(4\d\d)\b/.exec(value)?.[1])
    .find((value) => value !== undefined);
  const status = explicitStatus ?? (prefixedStatus ? Number(prefixedStatus) : null);
  // Only a rate-limit or payment refusal can be quota exhaustion. Every other
  // status keeps its existing classification (a 5xx is transient, other 4xx
  // are already terminal request faults).
  if (status !== null && status !== 429 && status !== 402) return null;

  const hasCode = (codes: ReadonlySet<string>) => fields.some((value) => codes.has(value.trim()));
  const creditCode = hasCode(CREDIT_CODES);
  const quotaCode = hasCode(QUOTA_CODES);
  const rateShaped = status === 429 || RATE_TEXT.test(text);
  // A statusless error must still look like a provider refusal; free text such
  // as a sandbox "Disk quota exceeded" is not model-provider evidence.
  if (status === null && !rateShaped && !creditCode && !quotaCode) return null;

  // Payment Required and account credit/billing exhaustion never clear by
  // waiting, whatever retry hint accompanies them.
  if (status === 402 || creditCode || CREDIT_TEXT.test(text)) return { scope: "credits" };
  if (quotaCode) return { scope: "quota" };

  const hint = evidence.retryAfterMs ?? providerMessageRetryHintMs(text);
  const minute = MINUTE_SCOPE.test(text);
  const day = DAY_SCOPE.test(text);
  const month = MONTH_SCOPE.test(text);
  const quotaWording = QUOTA_TEXT.test(text);

  if (!day && !month && !quotaWording) {
    // No quota wording: only a provider wait far beyond per-minute pacing
    // proves an exhausted window.
    return hint !== null && hint > PROVIDER_QUOTA_RETRY_HINT_MS ? { scope: "quota" } : null;
  }
  // An explicit per-minute window is ordinary pacing even when the provider's
  // message also advertises its daily allowance.
  if (minute) return null;
  // The provider itself says the limit clears within a minute.
  if (hint !== null && hint <= PROVIDER_SHORT_RETRY_HINT_MS) return null;
  if (day) return { scope: "daily" };
  if (month) return { scope: "monthly" };
  return { scope: "quota" };
}

/** Plain-language turn failure copy for an exhausted provider quota. */
export function providerQuotaExhaustedMessage(scope: ProviderQuotaScope): string {
  switch (scope) {
    case "daily":
      return "This model's daily limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets.";
    case "monthly":
      return "This model's monthly limit at the model provider has been reached, so automatic retries stopped. Choose another model, or try again after the limit resets.";
    case "credits":
      return "The model provider account for this model is out of credits, so automatic retries stopped. Choose another model, or add credits with the provider and try again.";
    case "quota":
      return "The model provider's usage quota for this model is used up, so automatic retries stopped. Choose another model, or try again after the quota resets.";
  }
}

const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** Read at most `maxBytes` of a cloned body; the original stays unread. */
async function boundedCloneText(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function statusOf(value: Record<string, unknown>): number | null {
  const body =
    value.error && typeof value.error === "object"
      ? (value.error as Record<string, unknown>)
      : null;
  const status = Number(value.status ?? value.statusCode ?? body?.status ?? body?.statusCode);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

/** The first HTTP status along an error and its cause chain. */
function errorHttpStatus(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const status = statusOf(current as Record<string, unknown>);
    if (status !== null) return status;
    current = (current as Record<string, unknown>).cause;
  }
  return null;
}

/**
 * Provider-authored strings on an SDK error and its wrappers: message, code,
 * type, name and param, recursing through `error`, `cause`, `response` and
 * `data`. These are exactly the fields the worker's other failure classifiers
 * read, so quota evidence never depends on a key only one reader sees.
 */
function errorTexts(value: unknown, out: string[], seen: WeakSet<object>): void {
  if (out.length >= MAX_FIELDS) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["message", "code", "type", "name", "param"]) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) out.push(field);
  }
  for (const key of ["error", "cause", "response", "data"]) errorTexts(record[key], out, seen);
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" ? value : null;
  }
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([key, value]) => key.toLowerCase() === name && typeof value === "string",
  );
  return typeof entry?.[1] === "string" ? entry[1] : null;
}

/** A provider retry hint (`retry-after-ms`, `retry-after`, or a structured field) in milliseconds. */
function errorRetryAfterMs(error: unknown, nowMs: number): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const body =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : null;
    for (const headers of [value.headers, value.responseHeaders, body?.headers]) {
      const millis = Number(headerValue(headers, "retry-after-ms") ?? Number.NaN);
      if (Number.isFinite(millis) && millis > 0) return Math.ceil(millis);
      const header = headerValue(headers, "retry-after");
      if (header === null) continue;
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1_000);
      const date = Date.parse(header);
      if (Number.isFinite(date) && date > nowMs) return Math.ceil(date - nowMs);
    }
    const seconds = Number(
      value.retry_after_seconds ?? body?.retry_after_seconds ?? value.retryAfterSeconds,
    );
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1_000);
    current = value.cause;
  }
  return null;
}

/**
 * Classify a thrown provider error: an OpenAI SDK `APIError`, or any wrapper
 * whose `error`/`cause` chain reaches one. This is the one evidence reader for
 * both the SDK retry veto and the worker's turn failure.
 */
export function classifyProviderQuotaError(
  error: unknown,
  nowMs = Date.now(),
): ProviderQuotaExhaustion | null {
  try {
    const texts: string[] = [];
    errorTexts(error, texts, new WeakSet());
    return classifyProviderQuotaExhaustion({
      status: errorHttpStatus(error),
      texts,
      retryAfterMs: errorRetryAfterMs(error, nowMs),
    });
  } catch {
    // A hostile getter is not quota evidence; callers keep their existing path.
    return null;
  }
}

/**
 * Classify a raw provider HTTP response without consuming its body. It builds
 * the exact error the OpenAI SDK throws for this response (the same
 * `APIError.generate` inputs as the SDK's own failure path) and classifies
 * that, so the veto and the worker read identical evidence.
 */
export async function classifyProviderQuotaResponse(
  response: Response,
  nowMs = Date.now(),
): Promise<ProviderQuotaExhaustion | null> {
  if (response.status !== 429) return null;
  const text = await boundedCloneText(response, MAX_RESPONSE_BODY_BYTES);
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const sdkError = APIError.generate(
    response.status,
    json as object | undefined,
    json ? undefined : text,
    response.headers,
  );
  return classifyProviderQuotaError(sdkError, nowMs);
}

/**
 * Tell the OpenAI SDK not to replay an exhausted-quota 429. The SDK otherwise
 * retries every 429 up to `maxRetries` times, which only delays a refusal that
 * cannot clear. The SDK honors the standard-for-it `x-should-retry` header, so
 * the exact response (status, headers, body) is passed through with only that
 * header added. Ordinary rate limits and every other response are untouched.
 */
export function withoutQuotaExhaustedRetries(inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await inner(input, init);
    if (response.status !== 429 || response.headers.has("x-should-retry")) return response;
    let exhausted: ProviderQuotaExhaustion | null = null;
    try {
      exhausted = await classifyProviderQuotaResponse(response);
    } catch {
      // Classification is advisory; the SDK keeps its ordinary retry decision.
    }
    if (!exhausted) return response;
    const headers = new Headers(response.headers);
    headers.set("x-should-retry", "false");
    const vetoed = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // Keep the request URL the SDK reports in its request logs.
    if (response.url) Object.defineProperty(vetoed, "url", { value: response.url });
    return vetoed;
  }) as typeof fetch;
}
