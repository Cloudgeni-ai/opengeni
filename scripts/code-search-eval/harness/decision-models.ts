import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { JevClient, estimateJevTokens } from "../../../packages/jev/src/client";
import { createJevDecisionModel } from "../../../packages/jev/src/decision-model";
import type {
  DecisionModel,
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
  /** Test transport. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): DecisionModel {
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
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const inner = createJevDecisionModel(client);
  const maxQuestions = options.maxQuestions ?? 3;
  const single: DecisionModel["decide"] = async (
    input,
    questions,
    decideOptions = {},
  ) => {
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
      return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
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
        parts.map((q) => single(input, q, decideOptions)),
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
