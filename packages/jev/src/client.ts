/**
 * Minimal client for TypeSafe Jev ("System One"): POST {baseUrl}/v1/systemone with
 * {state, model, questions} and get one typed answer per question back.
 *
 * - Splits a large question map across several requests so each stays inside the documented
 *   limits (32k tokens for state + longest question, 64k for state + all questions).
 * - Retries only network errors (including per-attempt timeouts), 429 and 5xx, with bounded
 *   backoff that honours `retry-after` up to `maxRetryAfterMs`. Other 4xx are never retried.
 * - The caller's AbortSignal cancels queued and in-flight requests and rejects with its reason.
 * - The API key is only ever sent in the Authorization header; it never appears in errors.
 */

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** USD per 1M input tokens; output tokens are free. */
export const JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD = 0.042;

// ---------------------------------------------------------------------------
// Questions and answers
// ---------------------------------------------------------------------------

/** Instructions and criteria may be a string or structured JSON. */
export type JevInstructions = string | Record<string, unknown> | unknown[];

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevInstructions;
  criteria?: { true?: JevInstructions; false?: JevInstructions };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevInstructions;
  criteria: Record<string, JevInstructions | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: JevInstructions;
  criteria: JevInstructions[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  type: "noul";
  /** Probability of "yes" in [0, 1]; NaN when the API returned no usable number. */
  probability: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  option: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** Passed through as the API returns it. */
export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevAnswerFor<Q> = Q extends JevNoulQuestion
  ? JevNoulAnswer
  : Q extends JevChoiceQuestion
    ? JevChoiceAnswer
    : Q extends JevScoreQuestion
      ? JevScoreAnswer
      : JevAnswer;

export interface JevAskResult<Q extends Record<string, JevQuestion>> {
  answers: { [K in keyof Q]: JevAnswerFor<Q[K]> };
  /** Versioned model id that answered (for example jev-1.13.0). */
  model: string;
  usage: { inputTokens: number };
  /** HTTP requests (chunks) that made up this ask. */
  requests: number;
  costUsd: number;
}

export interface JevAskOptions {
  /** Short label used in error messages (for example "code_search:wave1"). */
  tag?: string | undefined;
  signal?: AbortSignal | undefined;
}

export function noul(
  instructions: JevInstructions,
  criteria?: { true?: JevInstructions; false?: JevInstructions },
): JevNoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function jevCostUsd(inputTokens: number): number {
  return (inputTokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class JevError extends Error {
  /** HTTP status of the failed response, when there was one. */
  readonly status: number | undefined;
  /** Machine-readable reason when known (for example "max_tokens_exceeded" or "state_too_large"). */
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
  }
}

/** Jev cannot be used right now: network, timeout, 5xx, 429 after retries, or 401/402/403 auth and billing. */
export class JevUnavailableError extends JevError {}

/** Jev rejected the request itself (other 4xx), or the request cannot fit the limits. Never retried. */
export class JevRequestError extends JevError {}

// ---------------------------------------------------------------------------
// Limits and chunking
// ---------------------------------------------------------------------------

export interface JevLimits {
  /** Documented: state + longest question. */
  stateLongestMax: number;
  /** Documented: state + all questions. */
  stateAllMax: number;
  /** Fraction of each limit used (token estimates are approximate). */
  safety: number;
  /** Measured fixed overhead per request (~265 tokens). */
  perRequestOverhead: number;
  /** Measured framing overhead per question (~7-10 tokens) on top of its own text. */
  perQuestionOverhead: number;
  /** No documented cap; keeps one request reasonable. */
  maxQuestionsPerRequest: number;
}

export const JEV_DEFAULT_LIMITS: JevLimits = {
  stateLongestMax: 32_000,
  stateAllMax: 64_000,
  safety: 0.9,
  perRequestOverhead: 300,
  perQuestionOverhead: 12,
  maxQuestionsPerRequest: 256,
};

/** Measured: TS code 3.2-3.5 chars/token, prose 4.4-4.7; 3.0 keeps the limit math conservative. */
export const JEV_CHARS_PER_TOKEN = 3.0;

export function estimateJevTokens(value: unknown, charsPerToken = JEV_CHARS_PER_TOKEN): number {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(s.length / charsPerToken);
}

/**
 * Greedy packing of question ids into requests that respect both limits.
 * Throws JevRequestError (code state_too_large) when the state plus one question cannot fit.
 */
export function planChunks(
  stateTokens: number,
  questionTokens: ReadonlyArray<readonly [string, number]>,
  limits: JevLimits = JEV_DEFAULT_LIMITS,
): string[][] {
  const longestCap = limits.stateLongestMax * limits.safety;
  const allCap = limits.stateAllMax * limits.safety;
  const base = stateTokens + limits.perRequestOverhead;
  const chunks: string[][] = [];
  let cur: string[] = [];
  let curSum = 0;
  for (const [id, qt] of questionTokens) {
    const cost = qt + limits.perQuestionOverhead;
    if (base + cost > longestCap) {
      throw new JevRequestError(
        `Jev state (~${stateTokens} tokens) plus question "${id}" (~${qt} tokens) exceeds ~${Math.floor(longestCap)} tokens`,
        { code: "state_too_large" },
      );
    }
    if (
      cur.length > 0 &&
      (base + curSum + cost > allCap || cur.length >= limits.maxQuestionsPerRequest)
    ) {
      chunks.push(cur);
      cur = [];
      curSum = 0;
    }
    cur.push(id);
    curSum += cost;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (abortable while queued)
// ---------------------------------------------------------------------------

export class JevLimiter {
  private active = 0;
  private readonly queue: Array<{ grant: () => void }> = [];

  constructor(readonly max: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal?.reason);
      };
      const entry = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A released slot passes straight to the next waiter, so `active` never overshoots `max`. */
  private release(): void {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active -= 1;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  /** Per-attempt timeout. */
  timeoutMs?: number | undefined;
  /** Retries after the first attempt. */
  maxRetries?: number | undefined;
  /** Cap on a server `retry-after` hint; an interactive tool fails fast rather than sleeping 30 s. */
  maxRetryAfterMs?: number | undefined;
  /** Max concurrent HTTP requests from this client. */
  concurrency?: number | undefined;
  /** First backoff delay; doubles per attempt up to maxRetryAfterMs. */
  retryBaseDelayMs?: number | undefined;
  fetch?: JevFetch | undefined;
}

const RETRYABLE_STATUS = (status: number) => status === 429 || (status >= 500 && status <= 599);
const AUTH_STATUS = (status: number) => status === 401 || status === 402 || status === 403;
/** Keep-alive connections are reused for a few seconds after a request; no warm-up is needed inside that window. */
const WARM_WINDOW_MS = 4_000;
const WARM_TIMEOUT_MS = 3_000;
const MAX_DETAIL_CHARS = 200;

export class JevClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: JevFetch;
  private readonly limiter: JevLimiter;
  private lastActivityAt = -Infinity;

  constructor(options: JevClientOptions) {
    if (!options.apiKey) throw new JevUnavailableError("Jev API key is not configured");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? 2_000);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.limiter = new JevLimiter(Math.max(1, options.concurrency ?? 16));
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /**
   * Ask many questions about one state. Splits the questions into several requests when they exceed the
   * limits, runs them concurrently (bounded by `concurrency`) and merges the answers.
   */
  async ask<Q extends Record<string, JevQuestion>>(
    state: unknown,
    questions: Q,
    options: JevAskOptions = {},
  ): Promise<JevAskResult<Q>> {
    const { signal } = options;
    signal?.throwIfAborted();
    const ids = Object.keys(questions);
    if (!ids.length) throw new JevRequestError("Jev ask() needs at least one question");
    const stateTokens = estimateJevTokens(state);
    const chunks = planChunks(
      stateTokens,
      ids.map((id) => [id, estimateJevTokens(questions[id])] as const),
    );
    const label = options.tag ? `${options.tag}: ` : "";
    const results = await Promise.all(
      chunks.map((chunk) =>
        this.limiter.run(
          () =>
            this.post(
              JSON.stringify({
                state,
                model: this.model,
                questions: Object.fromEntries(chunk.map((id) => [id, questions[id]])),
              }),
              label,
              signal,
            ),
          signal,
        ),
      ),
    );
    const answers: Record<string, JevAnswer> = {};
    let inputTokens = 0;
    let model = "";
    results.forEach((json, i) => {
      const got = isRecord(json.answers) ? json.answers : {};
      for (const id of chunks[i]!) {
        const answer = normalizeAnswer(got[id]);
        if (!answer)
          throw new JevUnavailableError(`${label}Jev response is missing the answer "${id}"`);
        answers[id] = answer;
      }
      const usage = isRecord(json.usage) ? json.usage : {};
      inputTokens += Number(usage.input_tokens ?? 0) || 0;
      if (typeof json.model === "string" && json.model) model = json.model;
    });
    return {
      answers: answers as JevAskResult<Q>["answers"],
      model,
      usage: { inputTokens },
      requests: results.length,
      costUsd: jevCostUsd(inputTokens),
    };
  }

  /**
   * Open keep-alive connections before a burst of parallel requests (a cold TLS connection costs ~0.7 s).
   * GET /healthz is free. Skipped when the client was active within the last few seconds; never throws.
   */
  warmUp(connections: number): void {
    const now = Date.now();
    if (connections <= 0 || now - this.lastActivityAt < WARM_WINDOW_MS) return;
    this.lastActivityAt = now;
    for (let i = 0; i < connections; i++) {
      const timeout = AbortSignal.timeout(WARM_TIMEOUT_MS);
      this.fetchImpl(`${this.baseUrl}/healthz`, { method: "GET", signal: timeout })
        .then((res) => res.arrayBuffer())
        .catch(() => undefined);
    }
  }

  /** One HTTP request with retries. Returns the parsed JSON body of a 2xx response. */
  private async post(
    body: string,
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/v1/systemone`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
    let lastError = "unknown error";
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      signal?.throwIfAborted();
      const attemptSignal = withTimeout(signal, this.timeoutMs);
      let delay = this.backoff(attempt);
      let response: { res: Response; text: string } | null = null;
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: attemptSignal.signal,
        });
        response = { res, text: await res.text() };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        lastStatus = undefined;
        lastError = attemptSignal.timedOut()
          ? `timed out after ${this.timeoutMs} ms`
          : describeError(error);
      } finally {
        attemptSignal.dispose();
        this.lastActivityAt = Date.now();
      }
      if (response) {
        const { res, text } = response;
        if (res.ok) {
          const json = parseJson(text);
          if (!isRecord(json))
            throw new JevUnavailableError(`${label}Jev returned an invalid response body`);
          return json;
        }
        const detail = errorDetail(text);
        const suffix = detail.message ? `: ${detail.message}` : "";
        if (AUTH_STATUS(res.status)) {
          const what = res.status === 402 ? "billing or credits" : "authentication";
          throw new JevUnavailableError(
            `${label}Jev ${what} failed (HTTP ${res.status}${suffix})`,
            errorOptions(res.status, detail.code),
          );
        }
        if (!RETRYABLE_STATUS(res.status)) {
          throw new JevRequestError(
            `${label}Jev rejected the request (HTTP ${res.status}${suffix})`,
            errorOptions(res.status, detail.code),
          );
        }
        lastStatus = res.status;
        lastError = `HTTP ${res.status}${suffix}`;
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== null) delay = Math.min(retryAfter, this.maxRetryAfterMs);
      }
      if (attempt < this.maxRetries) await sleep(delay, signal);
    }
    throw new JevUnavailableError(
      `${label}Jev unavailable after ${this.maxRetries + 1} attempts (${lastError})`,
      lastStatus === undefined ? {} : { status: lastStatus },
    );
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.maxRetryAfterMs, this.retryBaseDelayMs * 2 ** attempt);
    return Math.round(base * (1 - Math.random() * 0.25));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function normalizeAnswer(raw: unknown): JevAnswer | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "noul") {
    return { type: "noul", probability: typeof raw.noul === "number" ? raw.noul : Number.NaN };
  }
  if (raw.type === "choice") {
    const answer: JevChoiceAnswer = {
      type: "choice",
      option: String(raw.choice ?? raw.option ?? ""),
    };
    if (isRecord(raw.probabilities))
      answer.probabilities = raw.probabilities as Record<string, number>;
    if (typeof raw.confidence === "number") answer.confidence = raw.confidence;
    return answer;
  }
  if (raw.type === "score")
    return { ...raw, type: "score", score: Number(raw.score) } as JevScoreAnswer;
  return null;
}

function errorOptions(status: number, code: string | undefined): { status: number; code?: string } {
  return code === undefined ? { status } : { status, code };
}

/** Best-effort code and message from an error body; bounded so a large body never floods a message. */
function errorDetail(text: string): { code: string | undefined; message: string } {
  const json = parseJson(text);
  const codes: string[] = [];
  let message = "";
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (!message) message = value;
      return;
    }
    if (Array.isArray(value)) {
      if (!message) message = JSON.stringify(value);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["code", "type"]) {
      const v = value[key];
      if (typeof v === "string" && v !== "error") codes.push(v);
    }
    for (const key of ["detail", "error", "message", "msg"]) if (key in value) visit(value[key]);
  };
  if (json === null) message = text.trim();
  else visit(json);
  let code = codes[0];
  if (!code && /^[a-z][a-z0-9_]{2,60}$/.test(message)) code = message;
  return { code, message: message.replace(/\s+/g, " ").slice(0, MAX_DETAIL_CHARS) };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_DETAIL_CHARS);
}

/** A per-attempt signal that fires on the caller's abort or after timeoutMs (no AbortSignal.any: Node 18). */
function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new JevUnavailableError(`Jev request timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
