import { describe, expect, test } from "bun:test";
import {
  createHttpDecisionModel,
  DecisionRequestError,
  DecisionUnavailableError,
  predicate,
  type DecisionUsage,
} from "../src";

const questions = {
  relevant: predicate("Is this a defect?", { true: "Broken", false: "Working" }),
  team: {
    type: "choice",
    instructions: "Which team?",
    criteria: { ui: "Rendering", billing: "Payments" },
  },
  severity: { type: "score", instructions: "How severe?", criteria: ["Cosmetic", "Blocking"] },
} as const;
const mutableQuestions = {
  ...questions,
  severity: { ...questions.severity, criteria: [...questions.severity.criteria] },
};

function payload(provider: "openai" | "openrouter") {
  const answers = {
    relevant: { type: "predicate", probability: 0.9 },
    team: {
      type: "choice",
      choice: "ui",
      probabilities: { ui: 0.8, billing: 0.2 },
      confidence: 0.6,
    },
    severity: { type: "score", score: 0.75, probabilities: { 0: 0.25, 1: 0.75 }, confidence: 0.5 },
  };
  return {
    id: "decision-test",
    model: "actual-version",
    provider: "actual-provider",
    usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 },
    answers:
      provider === "openrouter"
        ? { ...answers, relevant: { type: "noul", noul: 0.9 } }
        : Object.entries(answers).map(([name, answer]) => ({
            ...answer,
            name,
            ...("probabilities" in answer
              ? {
                  probabilities: Object.entries(answer.probabilities).map(
                    ([value, probability]) => ({
                      value: name === "severity" ? Number(value) : value,
                      probability,
                    }),
                  ),
                }
              : {}),
          })),
  };
}

describe.each(["openai", "openrouter"] as const)("%s typed decision backend", (provider) => {
  test("sends the real typed protocol and normalizes every answer kind and usage", async () => {
    const model = createHttpDecisionModel({
      provider,
      model: "requested-model",
      apiKey: "test-only",
      fetch: (async (url, init) => {
        expect(String(url)).toBe(
          provider === "openai"
            ? "https://api.openai.com/v1/decisions"
            : "https://openrouter.ai/api/alpha/decisions",
        );
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("requested-model");
        expect(body.messages).toBeUndefined();
        expect(body.tools).toBeUndefined();
        expect(body.reasoning).toBeUndefined();
        if (provider === "openai") {
          expect(body.questions[0]).toMatchObject({ name: "relevant", type: "predicate" });
          expect(body.questions[1].choices).toEqual([
            { value: "ui", description: "Rendering" },
            { value: "billing", description: "Payments" },
          ]);
          expect(body.questions[2].levels).toEqual([
            { label: "0", description: "Cosmetic" },
            { label: "1", description: "Blocking" },
          ]);
        } else expect(body.questions.relevant.type).toBe("noul");
        return Response.json(payload(provider));
      }) as typeof fetch,
    });
    const receipts: DecisionUsage[] = [];
    const result = await model.decide({ text: "The page is blank" }, mutableQuestions, {
      onUsage: (usage) => {
        receipts.push(usage);
      },
    });
    expect(result.answers).toMatchObject({
      relevant: { type: "predicate", probability: 0.9 },
      team: { choice: "ui" },
      severity: { score: 0.75 },
    });
    expect(result.usage).toMatchObject({
      model: "actual-version",
      provider: "actual-provider",
      requests: 1,
      inputTokens: 100,
      outputTokens: 0,
      costUsd: 0.00001,
      costSource: "provider-reported",
    });
    expect(receipts).toEqual([result.usage]);
  });

  test("records received usage before rejecting malformed answers", async () => {
    const body = { ...payload(provider), answers: provider === "openai" ? [] : {} };
    let usage: DecisionUsage | undefined;
    const model = createHttpDecisionModel({
      provider,
      model: "test",
      apiKey: "test-only",
      fetch: (async () => Response.json(body)) as typeof fetch,
    });
    await expect(
      model.decide("input", mutableQuestions, {
        onUsage: (r) => {
          usage = r;
        },
      }),
    ).rejects.toBeInstanceOf(DecisionUnavailableError);
    expect(usage?.inputTokens).toBe(100);
  });

  test("unknown usage/cost stays unknown rather than zero", async () => {
    const body = { ...payload(provider), usage: {} };
    const model = createHttpDecisionModel({
      provider,
      model: "test",
      apiKey: "test-only",
      fetch: (async () => Response.json(body)) as typeof fetch,
    });
    expect((await model.decide("input", mutableQuestions)).usage).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      costSource: "unknown",
    });
  });

  test("unavailability and rejected requests remain distinct without raw error bodies", async () => {
    for (const status of [401, 402, 429, 500, 400]) {
      const model = createHttpDecisionModel({
        provider,
        model: "test",
        apiKey: "test-only",
        fetch: (async () =>
          Response.json({ error: "private-provider-body" }, { status })) as typeof fetch,
      });
      try {
        await model.decide("input", mutableQuestions);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(
          status === 400 ? DecisionRequestError : DecisionUnavailableError,
        );
        expect(String(error)).not.toContain("private-provider-body");
      }
    }
  });

  test("forwards abort without retry or prose fallback", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = createHttpDecisionModel({
      provider,
      model: "test",
      apiKey: "test-only",
      fetch: (async (_, init) => {
        calls++;
        expect(init?.signal).toBe(controller.signal);
        controller.abort(new Error("stop-judging"));
        throw controller.signal.reason;
      }) as typeof fetch,
    });
    await expect(
      model.decide("input", mutableQuestions, { signal: controller.signal }),
    ).rejects.toThrow("stop-judging");
    expect(calls).toBe(1);
  });
});

test("OpenAI named refusals are preserved; duplicate names are invalid", async () => {
  const make = (answers: unknown) =>
    createHttpDecisionModel({
      provider: "openai",
      model: "test",
      apiKey: "test-only",
      fetch: (async () => Response.json({ model: "test", answers })) as typeof fetch,
    });
  expect(
    (await make([{ name: "q", type: "refusal" }]).decide("input", { q: predicate("Question") }))
      .answers.q.type,
  ).toBe("refusal");
  await expect(
    make([
      { name: "q", type: "predicate", probability: 0.9 },
      { name: "q", type: "predicate", probability: 0.8 },
    ]).decide("input", { q: predicate("Question") }),
  ).rejects.toThrow("duplicate answer names");
});
