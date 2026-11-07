import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type ModelDecisionResponse,
  type DecisionPredicateQuestion,
} from "../src/index";

test("SDK stateless inference uses the existing key, scoped paths, body and abort options", async () => {
  const calls: Array<{ request: Request; body: unknown }> = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test",
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      calls.push({ request, body: await request.json() });
      return Response.json({ object: "decision" });
    }) as typeof fetch,
  });
  const signal = new AbortController().signal;
  const decisionRequest = {
    tenantLabel: "customer",
    input: "hello",
    questions: { matches: { type: "predicate" as const, instructions: "Matches?" } },
  };
  const result: ModelDecisionResponse<{ matches: DecisionPredicateQuestion }> = await client.decide(
    "workspace",
    decisionRequest,
    { signal },
  );
  expect(result.object).toBe("decision");
  expect(calls.map(({ request }) => new URL(request.url).pathname)).toEqual([
    "/v1/workspaces/workspace/decisions",
  ]);
  for (const { request } of calls) {
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer og_test");
    expect(request.signal.aborted).toBe(false);
  }
  expect(calls[0]!.body).toEqual(decisionRequest);
});

test("a failed paid inference call is not silently retried", async () => {
  let calls = 0;
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_test",
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls++;
      return Response.json(
        { error: { message: "Provider unavailable", type: "api_error", code: "provider_error" } },
        { status: 502 },
      );
    }) as typeof fetch,
  });
  await expect(
    client.decide("ws", {
      input: "hello",
      questions: { q: { type: "predicate", instructions: "Matches?" } },
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(calls).toBe(1);
});
