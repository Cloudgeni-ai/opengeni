import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHttpDecisionModel, type DecisionModel } from "../../../packages/decisions/src";

/**
 * OpenAI-compatible chat and embedding clients for evaluation runs. They work
 * with OpenAI, OpenRouter and Azure OpenAI v1 endpoints (`<resource>/openai/v1`).
 *
 * Every answer is cached on disk by its exact request, so re-running unchanged
 * cases costs nothing, and a run stops once its new spending reaches the budget.
 * Costs come from configured prices per million tokens, because Azure does not
 * report a price; leave prices unset and costs read as zero.
 */

export type Usage = { input: number; cachedInput: number; output: number };
export type Priced = { usage: Usage; costUsd: number; latencyMs: number; cached: boolean };

/**
 * Time a search spent waiting out rate limits. It belongs to the eval's quota, not to
 * the strategy, so run.ts subtracts it from the search's measured latency. Waits are
 * kept as time spans: a search's parallel requests can wait at the same time, and only
 * the time some request was waiting counts.
 */
export const rateLimitWait = new AsyncLocalStorage<{ spans: [number, number][] }>();

/** How long at least one of a search's requests was waiting. */
export function waitedMs(store: { spans: [number, number][] }): number {
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of [...store.spans].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

async function waitOutRateLimit(ms: number) {
  const store = rateLimitWait.getStore();
  const start = performance.now();
  if (store) store.spans.push([start, start + ms]);
  await Bun.sleep(ms);
}

function retryDelayMs(response: Response, attempt: number) {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
}

/** A provider request that has not answered after this long is abandoned and retried. */
const HUNG_REQUEST_MS = 30_000;

/**
 * One provider request with a hang deadline. A hung attempt is retried up to twice and its
 * time is booked like a rate-limit wait: it measures the eval's connection, not the strategy.
 * Production callers need their own deadline; this only keeps a long run from stalling.
 */
async function fetchUnlessHung(url: string | URL | Request, init: RequestInit | undefined) {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const deadline = AbortSignal.timeout(HUNG_REQUEST_MS);
    try {
      return await fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    } catch (error) {
      if (!deadline.aborted || init?.signal?.aborted || attempt >= 2) throw error;
      const store = rateLimitWait.getStore();
      if (store) store.spans.push([started, performance.now()]);
      console.error(`A provider request hung for ${HUNG_REQUEST_MS / 1000} s; retrying.`);
    }
  }
}

export class Budget {
  spentUsd = 0;
  constructor(readonly limitUsd: number) {}
  charge(usd: number) {
    this.spentUsd += usd;
  }
  check() {
    if (this.spentUsd >= this.limitUsd)
      throw new Error(
        `Evaluation budget of $${this.limitUsd} reached ($${this.spentUsd.toFixed(4)} spent)`,
      );
  }
}

export class ResponseCache {
  constructor(private readonly directory: string | undefined) {}

  async read<T>(key: unknown): Promise<T | undefined> {
    if (!this.directory) return undefined;
    const file = Bun.file(this.path(key));
    return (await file.exists()) ? ((await file.json()) as T) : undefined;
  }

  async write(key: unknown, value: unknown) {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    await Bun.write(this.path(key), JSON.stringify(value));
  }

  private path(key: unknown) {
    const digest = createHash("sha256").update(JSON.stringify(key)).digest("hex");
    return join(this.directory!, `${digest}.json`);
  }
}

type Endpoint = {
  baseUrl: string;
  /** Read before every request; see {@link credentialFromEnv}. */
  apiKey: () => string;
  /** `bearer` (OpenAI, OpenRouter, Azure Entra tokens) or `api-key` (Azure keys). */
  auth: "bearer" | "api-key";
  model: string;
  /** USD per million input, cached input and output tokens. */
  prices: [number, number, number];
};

/**
 * `<PREFIX>_API_KEY`, or `<PREFIX>_API_KEY_FILE` read again before every request, so a
 * short-lived token (such as a Microsoft Entra access token) can be replaced during a long run.
 */
function credentialFromEnv(prefix: string): (() => string) | undefined {
  const key = process.env[`${prefix}_API_KEY`];
  if (key) return () => key;
  const file = process.env[`${prefix}_API_KEY_FILE`];
  return file ? () => readFileSync(file, "utf8").trim() : undefined;
}

/** Reads `<PREFIX>_BASE_URL`, `_API_KEY` or `_API_KEY_FILE`, `_AUTH`, `_MODEL` and `_USD_PER_MILLION` ("in,cached,out"). */
export function endpointFromEnv(prefix: string, modelOverride?: string): Endpoint | undefined {
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const apiKey = credentialFromEnv(prefix);
  const model = modelOverride ?? process.env[`${prefix}_MODEL`];
  if (!baseUrl || !apiKey || !model) return undefined;
  const prices = (process.env[`${prefix}_USD_PER_MILLION`] ?? "0,0,0")
    .split(",")
    .map((value) => Number(value.trim()));
  if (prices.length !== 3 || prices.some((value) => !Number.isFinite(value)))
    throw new Error(`${prefix}_USD_PER_MILLION must be three numbers: input,cached,output`);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    auth: process.env[`${prefix}_AUTH`] === "api-key" ? "api-key" : "bearer",
    model,
    prices: prices as [number, number, number],
  };
}

function headers(endpoint: Endpoint) {
  return {
    "content-type": "application/json",
    ...(endpoint.auth === "api-key"
      ? { "api-key": endpoint.apiKey() }
      : { authorization: `Bearer ${endpoint.apiKey()}` }),
  };
}

function price(endpoint: Endpoint, usage: Usage) {
  const [input, cached, output] = endpoint.prices;
  return (
    ((usage.input - usage.cachedInput) * input +
      usage.cachedInput * cached +
      usage.output * output) /
    1_000_000
  );
}

async function post(endpoint: Endpoint, path: string, body: unknown, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchUnlessHung(`${endpoint.baseUrl}${path}`, {
      method: "POST",
      headers: headers(endpoint),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
    const text = await response.text();
    // Rate limits are waited out; transient server errors are retried a few times.
    if (response.status === 429 && attempt < 8) {
      await waitOutRateLimit(retryDelayMs(response, attempt));
      continue;
    }
    if (response.status >= 500 && attempt < 3) {
      await Bun.sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
}

export type ChatRequest = {
  system: string;
  user: string;
  /** A JSON schema the answer must follow (structured output). */
  schema: Record<string, unknown>;
  reasoningEffort?: string;
  maxOutputTokens?: number;
};

export class ChatClient {
  constructor(
    readonly endpoint: Endpoint,
    private readonly cache: ResponseCache,
    private readonly budget: Budget,
  ) {}

  get label() {
    return this.endpoint.model;
  }

  async complete(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<{ answer: unknown } & Priced> {
    const body = {
      model: this.endpoint.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true, schema: request.schema },
      },
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
    };
    const key = { kind: "chat", baseUrl: this.endpoint.baseUrl, body };
    const hit = await this.cache.read<{ answer: unknown; usage: Usage; latencyMs: number }>(key);
    if (hit) return { ...hit, costUsd: price(this.endpoint, hit.usage), cached: true };
    this.budget.check();
    const started = performance.now();
    const response = await post(this.endpoint, "/chat/completions", body, signal);
    const latencyMs = performance.now() - started;
    const choice = (response.choices as { message?: { content?: string } }[] | undefined)?.[0];
    const raw = response.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        }
      | undefined;
    const usage: Usage = {
      input: raw?.prompt_tokens ?? 0,
      cachedInput: raw?.prompt_tokens_details?.cached_tokens ?? 0,
      output: raw?.completion_tokens ?? 0,
    };
    const costUsd = price(this.endpoint, usage);
    this.budget.charge(costUsd);
    const answer = JSON.parse(choice?.message?.content ?? "null");
    await this.cache.write(key, { answer, usage, latencyMs });
    return { answer, usage, latencyMs, costUsd, cached: false };
  }
}

export class EmbeddingClient {
  constructor(
    readonly endpoint: Endpoint,
    private readonly cache: ResponseCache,
    private readonly budget: Budget,
    readonly dimensions?: number,
  ) {}

  get label() {
    return `${this.endpoint.model}${this.dimensions ? `@${this.dimensions}` : ""}`;
  }

  /** Embeds texts in batches; each batch is cached on its own. */
  async embed(texts: string[], signal?: AbortSignal): Promise<{ vectors: number[][] } & Priced> {
    const vectors: number[][] = [];
    const total: Priced = {
      usage: { input: 0, cachedInput: 0, output: 0 },
      costUsd: 0,
      latencyMs: 0,
      cached: true,
    };
    for (let start = 0; start < texts.length; start += 128) {
      const body = {
        model: this.endpoint.model,
        input: texts.slice(start, start + 128),
        ...(this.dimensions ? { dimensions: this.dimensions } : {}),
      };
      const key = { kind: "embedding", baseUrl: this.endpoint.baseUrl, body };
      let entry = await this.cache.read<{ vectors: number[][]; input: number; latencyMs: number }>(
        key,
      );
      if (!entry) {
        this.budget.check();
        const started = performance.now();
        const response = await post(this.endpoint, "/embeddings", body, signal);
        const data = (response.data as { embedding: number[]; index: number }[]).sort(
          (a, b) => a.index - b.index,
        );
        entry = {
          vectors: data.map((item) => item.embedding),
          input: (response.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens ?? 0,
          latencyMs: performance.now() - started,
        };
        const cost = price(this.endpoint, { input: entry.input, cachedInput: 0, output: 0 });
        this.budget.charge(cost);
        await this.cache.write(key, entry);
        total.cached = false;
      }
      vectors.push(...entry.vectors);
      total.usage.input += entry.input;
      total.latencyMs += entry.latencyMs;
      total.costUsd += price(this.endpoint, { input: entry.input, cachedInput: 0, output: 0 });
    }
    return { vectors, ...total };
  }
}

export function cosine(a: readonly number[], b: readonly number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/**
 * A typed decision model (the runtime's tool selector backend) from
 * `${prefix}_PROVIDER` (`openai` or `openrouter` request format), `_MODEL`,
 * `_ENDPOINT` (the full decisions URL; Azure: `<resource>/openai/v1/decisions`),
 * `_API_KEY` or `_API_KEY_FILE` (any bearer: a key or an Entra token) and
 * `_USD_PER_MILLION` (input price, for an estimate). Answers are cached by
 * request. A cached answer replays its recorded latency, so re-runs cost
 * nothing yet report the same timing; only new answers count against the budget.
 */
export async function decisionModelFromEnv(
  prefix: string,
  cache: ResponseCache,
  budget: Budget,
  modelOverride?: string,
): Promise<{ label: string; model: DecisionModel } | undefined> {
  const provider = process.env[`${prefix}_PROVIDER`] ?? "openai";
  const model = modelOverride ?? process.env[`${prefix}_MODEL`];
  const credential = credentialFromEnv(prefix);
  if (!model || !credential) return undefined;
  if (provider !== "openai" && provider !== "openrouter")
    throw new Error(`${prefix}_PROVIDER must be openai or openrouter`);
  const endpoint = process.env[`${prefix}_ENDPOINT`];
  const usdPerMillion = Number(process.env[`${prefix}_USD_PER_MILLION`] ?? 0);
  const replaying: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = { url: String(url), body: init?.body };
    const hit = await cache.read<{ status: number; body: unknown; latencyMs: number }>(key);
    if (hit) {
      await Bun.sleep(hit.latencyMs);
      return Response.json(hit.body, { status: hit.status });
    }
    budget.check();
    // Rate limits are a property of the eval's quota, not of the strategy: wait them out so a
    // throttled run cannot pass for a keyword fallback. Latency is the successful attempt only.
    let response: Response;
    let started: number;
    for (let attempt = 0; ; attempt += 1) {
      // The credential is read per request, so a refreshed token file takes effect mid-run.
      const signed = new Headers(init?.headers);
      signed.set("authorization", `Bearer ${credential()}`);
      started = performance.now();
      response = await fetchUnlessHung(url, { ...init, headers: signed });
      if (response.status !== 429 || attempt >= 8) break;
      await response.body?.cancel();
      await waitOutRateLimit(retryDelayMs(response, attempt));
    }
    const latencyMs = performance.now() - started;
    const body = await response.json().catch(() => null);
    const inputTokens = (body as { usage?: { input_tokens?: number } } | null)?.usage?.input_tokens;
    budget.charge(((inputTokens ?? 0) * usdPerMillion) / 1e6);
    if (response.ok) await cache.write(key, { status: response.status, body, latencyMs });
    return Response.json(body, { status: response.status });
  }) as typeof fetch;
  return {
    label: model,
    model: createHttpDecisionModel({
      provider,
      model,
      // Replaced per request by the replaying fetch above.
      apiKey: "per-request",
      fetch: replaying,
      ...(endpoint ? { endpoint } : {}),
      ...(usdPerMillion ? { inputUsdPerMillion: usdPerMillion } : {}),
    }),
  };
}
