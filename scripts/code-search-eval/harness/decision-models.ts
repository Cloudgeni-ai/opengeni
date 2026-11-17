import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { JevClient, estimateJevTokens } from "../../../packages/jev/src/client";
import { createJevDecisionModel } from "../../../packages/jev/src/decision-model";
import type {
  DecisionModel,
  DecisionOptions,
  DecisionQuestion,
  DecisionResult,
  DecisionUsage,
} from "../../../packages/decisions/src/types";
import { BudgetStop } from "./budget";

/**
 * Decision Models (decisionmodels.io) speaks the same System One API as Jev, so the product's own
 * JevClient and DecisionModel adapter are used unchanged, pointed at its base URL. The budget here is
 * input tokens, not money: a free allowance with a hard stop below it.
 */
export const DECISION_MODELS_BASE_URL = "https://api.decisionmodels.io";

export class TokenLedger {
  private used = 0;
  private reserved = 0;
  private stopped: BudgetStop | null = null;
  constructor(
    readonly capTokens: number,
    private readonly path?: string,
  ) {
    if (path && existsSync(path))
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as {
          kind: string;
          tokens?: number;
          note?: string;
        };
        if (entry.kind === "settle") this.used += entry.tokens ?? 0;
        if (entry.kind === "stop")
          this.stopped = new BudgetStop(
            "credit",
            `stopped earlier: ${entry.note}`,
          );
      }
  }
  get usedTokens() {
    return this.used;
  }
  get stop() {
    return this.stopped;
  }
  private write(entry: Record<string, unknown>) {
    if (this.path)
      appendFileSync(
        this.path,
        `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      );
  }
  reserve(arm: string, taskId: string, tokens: number) {
    if (this.stopped) throw this.stopped;
    if (this.used + this.reserved + tokens > this.capTokens)
      throw new BudgetStop(
        "cap",
        `token cap ${this.capTokens} would be exceeded (used ${this.used})`,
      );
    this.reserved += tokens;
    let open = true;
    const close = () => {
      if (open) this.reserved -= tokens;
      open = false;
    };
    return {
      settle: (actual: number) => {
        close();
        this.used += actual;
        this.write({ kind: "settle", arm, taskId, tokens: actual });
      },
      release: close,
    };
  }
  halt(arm: string, taskId: string, note: string): BudgetStop {
    this.stopped = new BudgetStop(
      note.includes("402") ? "credit" : "auth",
      `provider stopped the run: ${note}`,
    );
    this.write({ kind: "stop", arm, taskId, note });
    return this.stopped;
  }
}

export function createDecisionModelsDecisionModel(options: {
  apiKey: string;
  model: string;
  ledger: TokenLedger;
  arm: string;
  taskId: () => string;
  baseUrl?: string;
  concurrency?: number;
  /** The provider's per-request question cap (GET /v1/models max_questions; s1-pro: 3). */
  maxQuestions?: number;
  /**
   * When a question map is split over several requests, send each request only the entries of per-item
   * maps in the input (objects keyed by the question ids, or by the id after "kind::") that its own
   * questions refer to. Without it every split request repeats the whole batch.
   */
  projectSplitInput?: boolean;
  /** Append one JSON line per HTTP attempt (status, ms, questions, split) and per failed decision. */
  tracePath?: string;
  /** Test transport. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): DecisionModel {
  const trace = (entry: Record<string, unknown>) => {
    if (options.tracePath)
      appendFileSync(
        options.tracePath,
        `${JSON.stringify({ at: new Date().toISOString(), arm: options.arm, taskId: options.taskId(), ...entry })}\n`,
      );
  };
  const baseFetch =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  // Every attempt, including the client's own 429 retries, is visible to the trace.
  const tracedFetch = async (url: string, init: RequestInit) => {
    const t0 = performance.now();
    let questions: number | null = null;
    let bodyChars: number | null = null;
    if (typeof init.body === "string") {
      bodyChars = init.body.length;
      try {
        const q = (JSON.parse(init.body) as { questions?: unknown }).questions;
        if (q && typeof q === "object") questions = Object.keys(q).length;
      } catch {
        // not JSON; leave unknown
      }
    }
    try {
      const res = await baseFetch(url, init);
      if (options.tracePath && !url.endsWith("/healthz"))
        trace({
          kind: "http",
          status: res.status,
          ms: Math.round(performance.now() - t0),
          questions,
          bodyChars,
          retryAfter: res.headers.get("retry-after"),
        });
      return res;
    } catch (error) {
      trace({
        kind: "http",
        status: null,
        ms: Math.round(performance.now() - t0),
        questions,
        bodyChars,
        error: String(error).slice(0, 200),
      });
      throw error;
    }
  };
  const client = new JevClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DECISION_MODELS_BASE_URL,
    model: options.model,
    timeoutMs: 30_000,
    // A batch run, not an interactive tool: wait out rate limits (429) instead of failing the task.
    maxRetries: 6,
    maxRetryAfterMs: 20_000,
    retryBaseDelayMs: 1_000,
    concurrency: options.concurrency ?? 4,
    fetch: tracedFetch,
  });
  const inner = createJevDecisionModel(client);
  const maxQuestions = options.maxQuestions ?? 3;
  const single = async <Q extends Record<string, DecisionQuestion>>(
    input: unknown,
    questions: Q,
    decideOptions: DecisionOptions = {},
    part: { index: number; of: number } = { index: 0, of: 1 },
  ): Promise<DecisionResult<Q>> => {
    const taskId = options.taskId();
    // Reserve the request's own size estimate, doubled for chunked question maps and estimate error.
    const estimate = 2 * estimateJevTokens({ input, questions }) + 1_000;
    const hold = options.ledger.reserve(options.arm, taskId, estimate);
    let reported: number | null = null;
    try {
      const result = await inner.decide(input, questions, {
        ...decideOptions,
        onUsage: async (usage: DecisionUsage) => {
          reported = usage.inputTokens;
          await decideOptions.onUsage?.(usage);
        },
      });
      hold.settle(reported ?? estimate);
      trace({
        kind: "decision",
        ok: true,
        questions: Object.keys(questions).length,
        split: part,
        inputTokens: reported,
      });
      return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
      trace({
        kind: "decision",
        ok: false,
        status: status ?? null,
        questions: Object.keys(questions).length,
        split: part,
        inputTokens: reported,
        error: String((error as Error)?.message ?? error).slice(0, 300),
      });
      if (reported !== null) hold.settle(reported);
      // A timeout or connection failure may still have been processed; count the estimate.
      else if (status === undefined) hold.settle(estimate);
      else hold.release();
      if (status === 401 || status === 402 || status === 403)
        throw options.ledger.halt(options.arm, taskId, `HTTP ${status}`);
      throw error;
    }
  };
  return {
    warmUp: (n) => inner.warmUp?.(n),
    // Question maps over the provider's cap go as several requests about the same input.
    async decide(input, questions, decideOptions = {}) {
      const ids = Object.keys(questions);
      if (ids.length <= maxQuestions)
        return single(input, questions, decideOptions);
      const parts: (typeof questions)[] = [];
      for (let i = 0; i < ids.length; i += maxQuestions)
        parts.push(
          Object.fromEntries(
            ids.slice(i, i + maxQuestions).map((id) => [id, questions[id]!]),
          ) as typeof questions,
        );
      const results = await Promise.all(
        parts.map((q, index) =>
          single(
            options.projectSplitInput ? projectInput(input, ids, Object.keys(q)) : input,
            q,
            decideOptions,
            { index, of: parts.length },
          ),
        ),
      );
      const sum = (pick: (u: DecisionUsage) => number | null) =>
        results.every((r) => pick(r.usage) !== null)
          ? results.reduce((n, r) => n + (pick(r.usage) ?? 0), 0)
          : null;
      return {
        answers: Object.assign({}, ...results.map((r) => r.answers)),
        usage: {
          ...results[0]!.usage,
          requests: results.reduce((n, r) => n + (r.usage.requests ?? 1), 0),
          inputTokens: sum((u) => u.inputTokens),
          costUsd: sum((u) => u.costUsd),
        },
      } as never;
    },
  };
}

const itemIdOf = (questionId: string) => {
  const parts = questionId.split("::");
  return parts.length > 1 ? parts[1]! : questionId;
};

/** Keeps, in each top-level per-item map of the input, only the items the given questions refer to. */
export function projectInput(
  input: unknown,
  allQuestionIds: string[],
  partQuestionIds: string[],
): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const all = new Set(allQuestionIds.map(itemIdOf));
  const keep = new Set(partQuestionIds.map(itemIdOf));
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [key, value];
      const keys = Object.keys(value);
      const perItem = keys.length > 1 && keys.every((k) => all.has(k));
      return perItem
        ? [key, Object.fromEntries(Object.entries(value).filter(([k]) => keep.has(k)))]
        : [key, value];
    }),
  );
}
