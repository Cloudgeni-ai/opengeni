import {
  DecisionRequestError,
  DecisionUnavailableError,
  validateDecisionAnswers,
  type DecisionModel,
  type DecisionOptions,
  type DecisionQuestion,
  type DecisionResult,
  type DecisionUsage,
} from "../../../packages/decisions/src/types";
import { BudgetStop, type BudgetLedger } from "./budget";

/**
 * Jev as an Opengeni DecisionModel through Vercel AI Gateway's evaluation API (AI SDK 7
 * `experimental_evaluate` with `gateway.evaluationModel('typesafe-ai/jev')`). Never the native
 * TypeSafe API. The evaluate function is injected so tests run against a mocked transport.
 */
export type GatewayEvaluate = (request: {
  model: unknown;
  state: unknown;
  questions: Record<string, unknown>;
  maxRetries: number;
  abortSignal?: AbortSignal;
}) => Promise<{
  answers?: Record<string, unknown>;
  results?: Record<string, unknown>;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, Record<string, unknown> | undefined>;
  response?: { id?: string };
}>;

/** Jev list price on Gateway when this harness was written: $0.042 per million input tokens, output free. */
export const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
/** Jev's context window; a request is never larger, which bounds its worst-case reservation. */
export const JEV_CONTEXT_TOKENS = 32_000;

export function toGatewayQuestion(
  question: DecisionQuestion,
): Record<string, unknown> {
  if (question.type === "predicate")
    return question.criteria
      ? {
          type: "boolean",
          instructions: question.instructions,
          criteria: question.criteria,
        }
      : { type: "boolean", instructions: question.instructions };
  return {
    type: question.type,
    instructions: question.instructions,
    criteria: question.criteria,
  };
}

function fromGatewayAnswer(question: DecisionQuestion, raw: unknown): unknown {
  const answer = raw as Record<string, unknown> | null;
  if (!answer || typeof answer !== "object") return raw;
  if (answer.type === "refusal") return answer;
  if (question.type === "predicate")
    return { type: "predicate", probability: answer.probability };
  const { type: _type, ...rest } = answer;
  return { ...rest, type: question.type };
}

/**
 * Billed cost from provider metadata. The pinned SDK passes Gateway metadata through untyped, so
 * the known spellings are tried, gateway namespace first. The first approved call confirms which.
 */
export function reportedCost(
  metadata: Record<string, Record<string, unknown> | undefined> | undefined,
): number | null {
  const namespaces = metadata
    ? [metadata.gateway, ...Object.values(metadata)]
    : [];
  for (const ns of namespaces)
    for (const key of [
      "cost",
      "totalCost",
      "total_cost",
      "marketCost",
      "market_cost",
    ]) {
      const raw = ns?.[key];
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
    }
  return null;
}

export type GatewayDecisionModelOptions = {
  evaluate: GatewayEvaluate;
  model: unknown;
  ledger: BudgetLedger;
  arm: string;
  taskId: () => string;
  /** Reject answers without a provider-reported cost (default), so spend is never guessed. */
  requireReportedCost?: boolean;
  timeoutMs?: number;
};

export function createGatewayDecisionModel(
  options: GatewayDecisionModelOptions,
): DecisionModel {
  const requireCost = options.requireReportedCost ?? true;
  return {
    async decide<Q extends Record<string, DecisionQuestion>>(
      input: unknown,
      questions: Q,
      decideOptions: DecisionOptions = {},
    ): Promise<DecisionResult<Q>> {
      const taskId = options.taskId();
      const worstCase = JEV_CONTEXT_TOKENS * JEV_INPUT_USD_PER_TOKEN;
      const hold = options.ledger.reserve(options.arm, taskId, worstCase);
      const gatewayQuestions = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [id, toGatewayQuestion(q)]),
      );
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      const signal = decideOptions.signal
        ? AbortSignal.any([decideOptions.signal, timeout])
        : timeout;
      let response: Awaited<ReturnType<GatewayEvaluate>>;
      try {
        response = await options.evaluate({
          model: options.model,
          state: input,
          questions: gatewayQuestions,
          maxRetries: 0,
          abortSignal: signal,
        });
      } catch (error) {
        // A timeout does not prove the call was unbilled: keep the worst case on the ledger.
        if (signal.aborted) hold.settle(worstCase);
        else hold.release();
        const stop = options.ledger.fail(options.arm, taskId, error);
        if (stop) throw stop;
        const status = (error as { status?: number }).status;
        throw new DecisionRequestError("Gateway evaluation failed", {
          ...(typeof status === "number" ? { status } : {}),
          cause: error,
        });
      }
      const inputTokens = response.usage?.inputTokens ?? null;
      const cost = reportedCost(response.providerMetadata);
      if (cost === null && requireCost) {
        hold.settle(worstCase);
        throw new BudgetStop(
          "unpriced",
          "Gateway response carried no billed cost; stopping rather than guessing spend",
        );
      }
      const costUsd =
        cost ?? (inputTokens ?? JEV_CONTEXT_TOKENS) * JEV_INPUT_USD_PER_TOKEN;
      hold.settle(costUsd);
      const usage: DecisionUsage = {
        model: "typesafe-ai/jev",
        provider: "vercel-ai-gateway",
        ...(response.response?.id ? { requestId: response.response.id } : {}),
        inputTokens,
        outputTokens: response.usage?.outputTokens ?? null,
        requests: 1,
        costUsd,
        costSource: cost === null ? "estimate" : "provider-reported",
      };
      await decideOptions.onUsage?.(usage);
      const rawAnswers = response.answers ?? response.results;
      if (!rawAnswers)
        throw new DecisionUnavailableError(
          "Gateway evaluation returned no answers",
        );
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [
          id,
          fromGatewayAnswer(q, rawAnswers[id]),
        ]),
      );
      return { answers: validateDecisionAnswers(questions, answers), usage };
    },
  };
}

/** The real transport, loaded only for live runs so offline tests need no SDK or credential. */
export async function loadGatewayTransport(): Promise<{
  evaluate: GatewayEvaluate;
  model: unknown;
}> {
  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
  if (!apiKey)
    throw new BudgetStop("auth", "VERCEL_AI_GATEWAY_API_KEY is not set");
  const ai = (await import("ai")) as unknown as {
    experimental_evaluate: GatewayEvaluate;
  };
  const { createGateway } = (await import("@ai-sdk/gateway")) as unknown as {
    createGateway(o: { apiKey: string }): {
      evaluationModel(id: string): unknown;
    };
  };
  return {
    evaluate: ai.experimental_evaluate,
    model: createGateway({ apiKey }).evaluationModel("typesafe-ai/jev"),
  };
}
