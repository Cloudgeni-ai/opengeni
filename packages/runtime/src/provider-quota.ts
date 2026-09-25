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
 * strings, and the provider's own retry hint. Subscription transports (Codex,
 * SuperGrok) own their quota semantics through credential rotation and durable
 * capacity waits and must not route through it.
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
// matched exactly; wording is matched as a phrase.
const CREDIT_CODES = new Set(["insufficient_credits", "insufficient_balance"]);
const QUOTA_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached"]);
const CREDIT_TEXT =
  /\binsufficient[ _](?:credits?|balance|funds)\b|\bcredit balance is too low\b|\brequires more credits\b|\bout of credits\b|\bused all (?:of )?(?:your |the )?(?:available )?credits\b|\bspending limit\b|\bbilling[ _]hard[ _]limit\b|\breached your specified api usage limits?\b/;

// Generic quota wording. Google reports per-minute limits with the same
// "exceeded your current quota" sentence, so this alone is not decisive: an
// explicit per-minute scope or a short provider retry hint keeps it retryable.
const QUOTA_TEXT =
  /\bexceeded (?:your |the )?(?:current |allotted |daily |monthly )?quota\b|\bquota (?:has been |was |is )?(?:exceeded|exhausted|reached)\b|\bout of (?:call volume )?quota\b|\bquota[ _]?exceeded\b|\bresource[ _]exhausted\b/;

// Explicit limit windows. "free-models-per-min" is OpenRouter's per-minute
// free tier; "free-models-per-day" its daily cap. GitHub/Azure AI inference
// name windows like "UserByModelByDay" or "per 86400s".
const MINUTE_SCOPE =
  /\bper[ _-]?min(?:ute)?\b|perminute|byminute|\b(?:rpm|tpm)\b|\/min\b|\bper 60 ?s\b|\bper[ _-]?second\b/;
const DAY_SCOPE =
  /free-models-per-day|\bper[ _-]?day\b|perday|byday|\b(?:rpd|tpd)\b|\bdaily\b|\bper 86400 ?s\b/;
const MONTH_SCOPE = /\bper[ _-]?month\b|permonth|bymonth|\bmonthly\b/;

const RATE_TEXT = /too many requests|rate.?limit|\b429\b/;

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

function jsonErrorStrings(value: unknown, out: string[], depth: number): void {
  if (out.length >= MAX_FIELDS || depth > 4) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) jsonErrorStrings(item, out, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["message", "code", "type", "status", "error"]) {
    jsonErrorStrings(record[key], out, depth + 1);
  }
}

function headerRetryAfterMs(headers: Headers, nowMs: number): number | null {
  const millis = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(millis) && millis > 0) {
    return Math.ceil(millis);
  }
  const header = headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? Math.ceil(seconds * 1_000) : null;
  const date = Date.parse(header);
  return Number.isFinite(date) && date > nowMs ? Math.ceil(date - nowMs) : null;
}

/** Classify a raw provider HTTP response without consuming its body. */
export async function classifyProviderQuotaResponse(
  response: Response,
  nowMs = Date.now(),
): Promise<ProviderQuotaExhaustion | null> {
  if (response.status !== 429) return null;
  const text = await boundedCloneText(response, MAX_RESPONSE_BODY_BYTES);
  if (text === null) return null;
  const texts: string[] = [];
  try {
    jsonErrorStrings(JSON.parse(text), texts, 0);
  } catch {
    texts.push(text);
  }
  return classifyProviderQuotaExhaustion({
    status: response.status,
    texts,
    retryAfterMs: headerRetryAfterMs(response.headers, nowMs),
  });
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
