import {
  createHttpDecisionModel,
  OPENAI_DECISIONS_ENDPOINT,
  OPENROUTER_DECISIONS_ENDPOINT,
  predicate,
  type DecisionModel,
} from "../../packages/decisions/src";
import {
  JevClient,
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD,
} from "../../packages/jev/src/client";
import { createJevDecisionModel } from "../../packages/jev/src/decision-model";

/** Transport/model warmup, not a scored case or a cached candidate/query prefix. */
export async function warmDecisionModel(model: DecisionModel) {
  const started = performance.now();
  const result = await model.decide("Ready for an evaluation run.", {
    ready: predicate("Does the input state readiness?"),
  });
  return { kind: "decision-model", ms: performance.now() - started, usage: result.usage };
}

/** Explicit eval credentials, never a workspace/customer credential fallback. */
export function configuredEvalDecisionModel(backend: string, model: string) {
  if (backend === "jev") {
    const apiKey = process.env.OPENGENI_JEV_API_KEY;
    if (!apiKey) throw new Error("OPENGENI_JEV_API_KEY is not configured");
    const baseUrl = process.env.OPENGENI_JEV_BASE_URL ?? JEV_DEFAULT_BASE_URL;
    return {
      model: createJevDecisionModel(
        new JevClient({ apiKey, baseUrl, model: model || JEV_DEFAULT_MODEL }),
      ),
      metadata: {
        backend,
        model,
        endpoint: `${baseUrl.replace(/\/$/, "")}/v1/systemone`,
        inputUsdPerMillionEstimate: JEV_PRICE_PER_MILLION_INPUT_TOKENS_USD,
      },
    };
  }
  if (backend !== "openai" && backend !== "openrouter")
    throw new Error("Unsupported typed decision backend");
  const apiKey = process.env.DECISION_MODEL_API_KEY;
  if (!apiKey) throw new Error("DECISION_MODEL_API_KEY is not configured");
  const endpoint =
    process.env.DECISION_MODEL_ENDPOINT ??
    (backend === "openai" ? OPENAI_DECISIONS_ENDPOINT : OPENROUTER_DECISIONS_ENDPOINT);
  return {
    model: createHttpDecisionModel({ provider: backend, model, apiKey, endpoint }),
    metadata: { backend, model, endpoint, inputUsdPerMillionEstimate: null },
  };
}
