import {
  DecisionRequestError,
  DecisionUnavailableError,
  isRecord,
  validateDecisionAnswers,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionUsage,
} from "./types";

export type HttpDecisionModelOptions = {
  provider: "openai" | "openrouter";
  model: string;
  apiKey: string;
  /** Full typed endpoint; never a chat-completions fallback. */
  endpoint?: string;
  fetch?: typeof fetch;
  /** Optional deployment rate, explicitly an estimate, not a billed receipt. */
  inputUsdPerMillion?: number;
};
export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function openAiDecisionRequest(
  model: string,
  input: unknown,
  questions: Record<string, DecisionQuestion>,
) {
  return {
    model,
    input: text(input),
    questions: Object.entries(questions).map(([name, question]) => {
      if (question.type === "predicate")
        return {
          name,
          type: question.type,
          instructions: question.criteria
            ? text({ instructions: question.instructions, criteria: question.criteria })
            : text(question.instructions),
        };
      if (question.type === "choice")
        return {
          name,
          type: question.type,
          instructions: text(question.instructions),
          choices: Object.entries(question.criteria).map(([value, description]) => ({
            value,
            description: description === null ? value : text(description),
          })),
        };
      return {
        name,
        type: question.type,
        instructions: text(question.instructions),
        levels: question.criteria.map((description, index) => ({
          label: String(index),
          description: text(description),
        })),
      };
    }),
  };
}
export function openRouterDecisionRequest(
  model: string,
  input: unknown,
  questions: Record<string, DecisionQuestion>,
) {
  return {
    model,
    state: input,
    questions: Object.fromEntries(
      Object.entries(questions).map(([name, question]) => [
        name,
        { ...question, type: question.type === "predicate" ? "noul" : question.type },
      ]),
    ),
  };
}

function normalizeAnswers(raw: unknown, provider: HttpDecisionModelOptions["provider"]) {
  if (provider === "openrouter") {
    if (!isRecord(raw))
      throw new DecisionUnavailableError("Decision response has no named answers");
    return Object.fromEntries(
      Object.entries(raw).map(([name, answer]) => [
        name,
        isRecord(answer) && answer.type === "noul"
          ? { type: "predicate", probability: answer.noul }
          : answer,
      ]),
    );
  }
  if (!Array.isArray(raw))
    throw new DecisionUnavailableError("Decision response has no answer array");
  const answers = Object.create(null) as Record<string, unknown>;
  for (const value of raw) {
    if (!isRecord(value) || typeof value.name !== "string" || Object.hasOwn(answers, value.name))
      throw new DecisionUnavailableError("Decision response has invalid or duplicate answer names");
    const { name, probabilities, ...answer } = value;
    if (probabilities !== undefined) {
      if (!Array.isArray(probabilities))
        throw new DecisionUnavailableError("Decision response has invalid probabilities");
      const mapped = Object.create(null) as Record<string, unknown>;
      for (const entry of probabilities) {
        if (
          !isRecord(entry) ||
          (typeof entry.value !== "string" && typeof entry.value !== "number") ||
          Object.hasOwn(mapped, String(entry.value))
        )
          throw new DecisionUnavailableError("Decision response has invalid probability labels");
        mapped[String(entry.value)] = entry.probability;
      }
      answer.probabilities = mapped;
    }
    answers[name] = answer;
  }
  return answers;
}

/** Real typed endpoints only. Caller cancellation is forwarded; no new timeout/retry policy. */
export function createHttpDecisionModel(config: HttpDecisionModelOptions): DecisionModel {
  if (!config.apiKey || !config.model)
    throw new DecisionRequestError("Decision model and credential must be configured");
  const endpoint =
    config.endpoint ??
    (config.provider === "openai" ? OPENAI_DECISIONS_ENDPOINT : OPENROUTER_DECISIONS_ENDPOINT);
  return {
    async decide(input, questions, options = {}) {
      options.signal?.throwIfAborted();
      if (!Object.keys(questions).length)
        throw new DecisionRequestError("A decision request needs named questions");
      const request =
        config.provider === "openai"
          ? openAiDecisionRequest(config.model, input, questions)
          : openRouterDecisionRequest(config.model, input, questions);
      let response: Response;
      try {
        response = await (config.fetch ?? fetch)(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (cause) {
        options.signal?.throwIfAborted();
        throw new DecisionUnavailableError("Decision provider request failed", { cause });
      }
      if (!response.ok) {
        await response.body?.cancel();
        const ErrorType =
          [401, 402, 403, 408, 429].includes(response.status) || response.status >= 500
            ? DecisionUnavailableError
            : DecisionRequestError;
        throw new ErrorType(`Decision provider returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
      let result: unknown;
      try {
        result = await response.json();
      } catch (cause) {
        options.signal?.throwIfAborted();
        throw new DecisionUnavailableError("Decision provider returned invalid JSON", { cause });
      }
      if (!isRecord(result))
        throw new DecisionUnavailableError("Decision provider returned an invalid response");
      const rawUsage = isRecord(result.usage) ? result.usage : {};
      const inputTokens = count(rawUsage.input_tokens);
      const reportedCost =
        typeof rawUsage.cost === "number" && Number.isFinite(rawUsage.cost) && rawUsage.cost >= 0
          ? rawUsage.cost
          : null;
      const estimatedCost =
        inputTokens !== null && config.inputUsdPerMillion !== undefined
          ? (inputTokens * config.inputUsdPerMillion) / 1_000_000
          : null;
      const usage: DecisionUsage = {
        model: typeof result.model === "string" ? result.model : config.model,
        provider: typeof result.provider === "string" ? result.provider : config.provider,
        ...(typeof result.id === "string" ? { requestId: result.id } : {}),
        requests: 1,
        inputTokens,
        outputTokens: count(rawUsage.output_tokens),
        costUsd: reportedCost ?? estimatedCost,
        costSource:
          reportedCost !== null
            ? "provider-reported"
            : estimatedCost !== null
              ? "estimate"
              : "unknown",
      };
      await options.onUsage?.(usage);
      options.signal?.throwIfAborted();
      return {
        usage,
        answers: validateDecisionAnswers(
          questions,
          normalizeAnswers(result.answers, config.provider),
        ),
      };
    },
  };
}
