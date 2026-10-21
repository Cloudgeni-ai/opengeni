import { expect, test } from "bun:test";
import { DecisionUnavailableError, predicate } from "@opengeni/decisions";
import { createJevDecisionModel, JevClient } from "../src";

test("missing Jev usage stays unknown in the shared category, not a zero-cost claim", async () => {
  const model = createJevDecisionModel(
    new JevClient({
      apiKey: "test-only",
      model: "requested-model",
      fetch: (async () =>
        Response.json({ answers: { q: { type: "noul", noul: 0.9 } } })) as typeof fetch,
    }),
  );
  const result = await model.decide("input", { q: predicate("Question?") });
  expect(result.usage).toMatchObject({
    model: "requested-model",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    costSource: "unknown",
  });
});

test("existing Jev client adapts all three shared answer kinds and estimated usage", async () => {
  const model = createJevDecisionModel(
    new JevClient({
      apiKey: "test-only",
      fetch: (async (_, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.questions.relevant.type).toBe("noul");
        expect(body.questions.team.criteria).toEqual({ ui: "Rendering", billing: "Payments" });
        return Response.json({
          model: "jev-version",
          answers: {
            relevant: { type: "noul", noul: 0.9 },
            team: { type: "choice", choice: "ui", probabilities: { ui: 0.9, billing: 0.1 } },
            severity: { type: "score", score: 0.75 },
          },
          usage: { input_tokens: 100 },
        });
      }) as typeof fetch,
    }),
  );
  const result = await model.decide("input", {
    relevant: predicate("Relevant?"),
    team: {
      type: "choice",
      instructions: "Owner?",
      criteria: { ui: "Rendering", billing: "Payments" },
    },
    severity: { type: "score", instructions: "Severity?", criteria: ["Cosmetic", "Blocking"] },
  });
  expect(result.answers).toMatchObject({
    relevant: { type: "predicate", probability: 0.9 },
    team: { choice: "ui" },
    severity: { score: 0.75 },
  });
  expect(result.usage).toMatchObject({
    model: "jev-version",
    provider: "typesafe",
    requests: 1,
    inputTokens: 100,
    outputTokens: null,
    costSource: "estimate",
  });
  expect(result.usage.costUsd).toBeCloseTo(0.0000042);
});

test("invalid Jev choices are not silently accepted by the shared interface", async () => {
  let recorded = 0;
  const model = createJevDecisionModel(
    new JevClient({
      apiKey: "test-only",
      fetch: (async () =>
        Response.json({
          answers: { team: { type: "choice", choice: "outside-the-set" } },
          usage: { input_tokens: 100 },
        })) as typeof fetch,
    }),
  );
  await expect(
    model.decide(
      "input",
      { team: { type: "choice", instructions: "Owner?", criteria: { ui: null } } },
      {
        onUsage: () => {
          recorded++;
        },
      },
    ),
  ).rejects.toBeInstanceOf(DecisionUnavailableError);
  expect(recorded).toBe(1);
});
