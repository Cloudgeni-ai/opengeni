#!/usr/bin/env bun
/**
 * A local judge endpoint for benchmark runs of the product's decision-model tools. It speaks the Jev
 * System One wire format the product's JevClient sends (POST /v1/systemone, GET /healthz), so a
 * benchmark deployment points OPENGENI_JEV_BASE_URL here with a dummy key, and the shim forwards each
 * request to the judge under test:
 *
 *   --mode dm       Decision Models (Jev-compatible): the body is forwarded unchanged. Budget: input
 *                   tokens on a TokenLedger (a free allowance; the ledger file is shared across runs).
 *   --mode gateway  Jev through Vercel AI Gateway's evaluation API only (never the native TypeSafe
 *                   API): noul questions become boolean questions. Budget: billed USD on a BudgetLedger;
 *                   a response without a billed cost stops the run.
 *
 * The shim paces requests (concurrency and minimum spacing), never retries, and logs every request
 * with its status, so a benchmark task that overlapped a 429 or provider error can be rerun. On an
 * auth or credit error it stops: every later request gets HTTP 402 and the stop is written to the
 * ledger. Credentials come from the environment only (DECISION_MODELS_API_KEY or
 * VERCEL_AI_GATEWAY_API_KEY) and are never logged.
 *
 *   DECISION_MODELS_API_KEY=... bun scripts/code-search-eval/judge-shim.ts --mode dm --port 18420 \
 *     --ledger dm-ledger.jsonl --cap-tokens 95000000 --log shim.jsonl --concurrency 4
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BudgetLedger, BudgetStop, classifyProviderError } from "./harness/budget";
import { TokenLedger } from "./harness/decision-models";
import {
  JEV_CONTEXT_TOKENS,
  JEV_INPUT_USD_PER_TOKEN,
  reportedCost,
} from "./harness/gateway-decision-model";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    port: { type: "string", default: "18420" },
    ledger: { type: "string" },
    "cap-tokens": { type: "string" },
    "cap-usd": { type: "string" },
    log: { type: "string" },
    arm: { type: "string", default: "shim" },
    concurrency: { type: "string", default: "4" },
    "min-interval-ms": { type: "string", default: "0" },
    "dm-model": { type: "string", default: "s1-pro" },
    "dm-base-url": { type: "string", default: "https://api.decisionmodels.io" },
    "timeout-ms": { type: "string", default: "30000" },
  },
});

const mode = values.mode;
if (mode !== "dm" && mode !== "gateway") throw new Error("--mode dm|gateway is required");
if (!values.ledger || !values.log) throw new Error("--ledger and --log are required");

export type ShimLogEntry = {
  at: string;
  kind: "request" | "stop" | "start";
  status?: number;
  ms?: number;
  questions?: number;
  inputTokens?: number | null;
  costUsd?: number | null;
  error?: string;
};
const log = (entry: Omit<ShimLogEntry, "at">) =>
  appendFileSync(values.log!, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

// ---- pacing: bounded concurrency plus a minimum spacing between request starts
const maxConcurrent = Math.max(1, Number(values.concurrency));
const minInterval = Math.max(0, Number(values["min-interval-ms"]));
let active = 0;
let lastStart = 0;
const waiting: Array<() => void> = [];
async function acquire() {
  if (active >= maxConcurrent) await new Promise<void>((r) => waiting.push(r));
  active++;
  const wait = lastStart + minInterval - Date.now();
  lastStart = Math.max(Date.now(), lastStart + minInterval);
  if (wait > 0) await Bun.sleep(wait);
}
function release() {
  active--;
  waiting.shift()?.();
}

const timeoutMs = Number(values["timeout-ms"]);
const json = (status: number, body: unknown) => Response.json(body, { status });
let stopped: string | null = null;
function stop(note: string) {
  stopped ??= note;
  log({ kind: "stop", error: note });
}

type JevBody = { state?: unknown; model?: string; questions?: Record<string, Record<string, unknown>> };

// ---- Decision Models: forward unchanged; tokens on the shared ledger
const dmLedger = mode === "dm" ? new TokenLedger(Number(values["cap-tokens"] ?? 95_000_000), values.ledger) : null;
const dmKey = process.env.DECISION_MODELS_API_KEY;
async function forwardDm(raw: string, body: JevBody): Promise<Response> {
  // The ledger reserves the request's whole context window, so concurrent requests never overshoot.
  const hold = dmLedger!.reserve(values.arm!, "shim", 32_000);
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${values["dm-base-url"]!.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dmKey}` },
      body: JSON.stringify({ ...body, model: values["dm-model"] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // A timeout does not prove the request was unbilled: keep its worst case.
    hold.settle(32_000);
    log({ kind: "request", status: 0, ms: Math.round(performance.now() - t0), questions: Object.keys(body.questions ?? {}).length, error: String(error).slice(0, 200) });
    return json(503, { error: { message: "judge transport failed" } });
  }
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let inputTokens: number | null = null;
  try {
    const usage = (JSON.parse(text) as { usage?: { input_tokens?: number } }).usage;
    inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  } catch {
    // not JSON
  }
  if (res.ok) hold.settle(inputTokens ?? Math.ceil(raw.length / 3));
  else hold.release();
  log({ kind: "request", status: res.status, ms, questions: Object.keys(body.questions ?? {}).length, inputTokens });
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    dmLedger!.halt(values.arm!, "shim", `HTTP ${res.status}`);
    stop(`HTTP ${res.status}`);
  }
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
}

// ---- Jev through Vercel AI Gateway: translate noul <-> boolean; billed USD on the ledger
const usdLedger = mode === "gateway" ? new BudgetLedger(Number(values["cap-usd"] ?? 0), values.ledger) : null;
let gateway: { evaluate: (r: Record<string, unknown>) => Promise<Record<string, unknown>>; model: unknown } | null = null;
let metadataKeysLogged = false;
async function forwardGateway(body: JevBody): Promise<Response> {
  if (!gateway) {
    const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
    if (!apiKey) throw new BudgetStop("auth", "VERCEL_AI_GATEWAY_API_KEY is not set");
    const ai = (await import("ai")) as unknown as { experimental_evaluate: (r: Record<string, unknown>) => Promise<Record<string, unknown>> };
    const { createGateway } = (await import("@ai-sdk/gateway")) as unknown as {
      createGateway(o: { apiKey: string }): { evaluationModel(id: string): unknown };
    };
    gateway = { evaluate: ai.experimental_evaluate, model: createGateway({ apiKey }).evaluationModel("typesafe-ai/jev") };
  }
  const questions = body.questions ?? {};
  const translated = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type !== "noul") throw new BudgetStop("unpriced", `unsupported question type ${String(q.type)}`);
      return [id, q.criteria ? { type: "boolean", instructions: q.instructions, criteria: q.criteria } : { type: "boolean", instructions: q.instructions }];
    }),
  );
  const worstCase = JEV_CONTEXT_TOKENS * JEV_INPUT_USD_PER_TOKEN;
  const hold = usdLedger!.reserve(values.arm!, "shim", worstCase);
  const t0 = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Record<string, unknown>;
  try {
    response = await gateway.evaluate({ model: gateway.model, state: body.state, questions: translated, maxRetries: 0, abortSignal: signal });
  } catch (error) {
    if (signal.aborted) hold.settle(worstCase);
    else hold.release();
    const status = Number((error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode ?? 0);
    log({ kind: "request", status, ms: Math.round(performance.now() - t0), questions: Object.keys(questions).length, error: String((error as Error).name ?? "error") });
    const kind = classifyProviderError(error);
    if (kind) {
      usdLedger!.fail(values.arm!, "shim", error);
      stop(kind);
      return json(402, { error: { message: `judge ${kind} error` } });
    }
    return json(status === 429 ? 429 : 503, { error: { message: "judge request failed" } });
  }
  const metadata = response.providerMetadata as Record<string, Record<string, unknown> | undefined> | undefined;
  if (!metadataKeysLogged) {
    metadataKeysLogged = true;
    // Field names only, to confirm which one carries the billed cost.
    log({ kind: "start", error: `providerMetadata keys: ${JSON.stringify(Object.fromEntries(Object.entries(metadata ?? {}).map(([k, v]) => [k, Object.keys(v ?? {})])))}` });
  }
  const cost = reportedCost(metadata);
  const usage = response.usage as { inputTokens?: number } | undefined;
  const ms = Math.round(performance.now() - t0);
  if (cost === null) {
    hold.settle(worstCase);
    stop("unpriced response");
    log({ kind: "request", status: 200, ms, questions: Object.keys(questions).length, inputTokens: usage?.inputTokens ?? null, costUsd: null, error: "unpriced" });
    return json(402, { error: { message: "judge response carried no billed cost" } });
  }
  hold.settle(cost);
  log({ kind: "request", status: 200, ms, questions: Object.keys(questions).length, inputTokens: usage?.inputTokens ?? null, costUsd: cost });
  const raw = (response.answers ?? response.results ?? {}) as Record<string, { probability?: number; type?: string }>;
  const answers = Object.fromEntries(
    Object.keys(questions).map((id) => {
      const a = raw[id];
      return [id, a && typeof a.probability === "number" ? { type: "noul", noul: a.probability } : { type: "refusal" }];
    }),
  );
  return json(200, { model: "typesafe-ai/jev", answers, usage: { input_tokens: usage?.inputTokens ?? null } });
}

if (mode === "dm" && !dmKey) throw new Error("DECISION_MODELS_API_KEY is not set");
if (mode === "gateway" && !(Number(values["cap-usd"]) > 0)) throw new Error("--cap-usd is required for gateway mode");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(values.port),
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });
    if (req.method !== "POST" || url.pathname !== "/v1/systemone") return json(404, { error: { message: "not found" } });
    if (stopped) return json(402, { error: { message: `judge stopped: ${stopped}` } });
    const raw = await req.text();
    let body: JevBody;
    try {
      body = JSON.parse(raw) as JevBody;
    } catch {
      return json(400, { error: { message: "invalid JSON" } });
    }
    await acquire();
    try {
      return mode === "dm" ? await forwardDm(raw, body) : await forwardGateway(body);
    } catch (error) {
      if (error instanceof BudgetStop) {
        stop(`${error.reason}: ${error.message}`);
        return json(402, { error: { message: `judge stopped: ${error.reason}` } });
      }
      log({ kind: "request", status: 500, error: String(error).slice(0, 200) });
      return json(503, { error: { message: "judge shim error" } });
    } finally {
      release();
    }
  },
});
log({ kind: "start", error: `mode ${mode} on ${server.hostname}:${server.port}` });
console.log(`judge shim (${mode}) on ${server.hostname}:${server.port}`);
