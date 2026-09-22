import { test, expect } from "bun:test";
import {
  evaluateDirect,
  TYPESAFE_ENDPOINT,
  TYPESAFE_MODEL,
  TYPESAFE_INPUT_RATE,
  listNativeModels,
} from "./typesafe-direct";
import { meteredGatewayCall } from "./gateway-call";
import { budgetState } from "./iteration-ledger";
const payload = {
  state: { ready: true },
  questions: {
    ready: {
      type: "choice" as const,
      instructions: "Is ready true?",
      criteria: { yes: "True", no: "False" },
    },
  },
};
const data = {
  model: TYPESAFE_MODEL,
  answers: {
    ready: { type: "choice", choice: "yes", probabilities: { yes: 1, no: 0 }, confidence: 1 },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
};
const transport = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(fn, { preconnect: fetch.preconnect });
test("direct adapter preserves state/questions, pins version and sends only its native credential", async () => {
  const r = await evaluateDirect(payload, {
    apiKey: "native-test-key",
    signal: AbortSignal.timeout(1000),
    transport: transport(async (url, init) => {
      expect(url).toBe(TYPESAFE_ENDPOINT);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer native-test-key");
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(init?.body as string)).toEqual({ model: TYPESAFE_MODEL, ...payload });
      return Response.json(data);
    }),
  });
  expect(r.usage.inputTokens).toBe(100);
  expect(r.response.modelId).toBe(TYPESAFE_MODEL);
  expect(r.providerMetadata).not.toHaveProperty("gateway");
});
test("direct failures preserve status, omit response text and never retry", async () => {
  let calls = 0;
  const run = () =>
    evaluateDirect(payload, {
      apiKey: "native-test-key",
      signal: AbortSignal.timeout(1000),
      transport: transport(async () => {
        calls++;
        return new Response("private error source", {
          status: 529,
          headers: { "x-request-id": "native-request" },
        });
      }),
    });
  try {
    await run();
    throw new Error("expected rejection");
  } catch (e: any) {
    expect(e.statusCode).toBe(529);
    expect(JSON.stringify(e)).not.toContain("private error source");
  }
  expect(calls).toBe(1);
});
test("native cost is a catalog estimate, never fabricated reported charge", async () => {
  const rows: any[] = [];
  await meteredGatewayCall(
    {
      model: TYPESAFE_MODEL,
      stage: "test",
      runId: "offline",
      attribution: { route: "direct" },
      price: { input: TYPESAFE_INPUT_RATE, output: 0, cached: TYPESAFE_INPUT_RATE },
      maxUsd: 1,
      maxRequests: 2,
      maxOutput: 0,
      retries: 0,
      costPolicy: "typesafe_catalog",
      history: () => rows,
      append: (r) => {
        rows.push(r);
      },
    },
    payload,
    () =>
      evaluateDirect(payload, {
        apiKey: "native-test-key",
        signal: AbortSignal.timeout(1000),
        transport: transport(async () => Response.json(data)),
      }),
  );
  const receipt = rows.find((r) => r.kind === "completed");
  expect(receipt.reportedUsd).toBeNull();
  expect(receipt.nominalUsd).toBe(100 * TYPESAFE_INPUT_RATE);
  expect(budgetState(rows).attempts).toBe(1);
});
test("native adapter rejects missing usage, wrong model and invalid choices", async () => {
  for (const invalid of [
    { ...data, usage: {} },
    { ...data, model: "other" },
    { ...data, answers: { ready: { ...data.answers.ready, choice: "invented" } } },
  ])
    await expect(
      evaluateDirect(payload, {
        apiKey: "native-test-key",
        signal: AbortSignal.timeout(1000),
        transport: transport(async () => Response.json(invalid)),
      }),
    ).rejects.toThrow();
});

test("runtime extra fields cannot override native model and echoed request IDs are omitted", async () => {
  const r = await evaluateDirect({ ...payload, model: "unapproved-model" } as any, {
    apiKey: "native-secret",
    signal: AbortSignal.timeout(1000),
    transport: transport(async (_, init) => {
      expect(JSON.parse(init?.body as string).model).toBe(TYPESAFE_MODEL);
      return Response.json(data, { headers: { "x-request-id": "native-secret" } });
    }),
  });
  expect(r.providerMetadata.typesafe.requestId).toBeUndefined();
});

test("native preflight rejects a Gateway key before any transport", async () => {
  let calls = 0;
  await expect(
    listNativeModels(
      "same-test-key",
      "same-test-key",
      transport(async () => {
        calls++;
        return Response.json({ models: [] });
      }),
    ),
  ).rejects.toThrow("gateway_credential_for_native_forbidden");
  expect(calls).toBe(0);
});
