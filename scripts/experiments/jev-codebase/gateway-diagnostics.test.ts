import { test, expect } from "bun:test";
import { safeGatewayError, observedGatewayFetch, diagnosticSignal } from "./gateway-diagnostics";
test("safe diagnostics preserve correlation but omit headers/body secrets", () => {
  const r = safeGatewayError(
    {
      name: "GatewayInternalServerError",
      message: "key synthetic-secret Bearer another-secret",
      statusCode: 503,
      generationId: "gen-test",
      cause: {
        name: "APICallError",
        requestHeaders: { authorization: "synthetic-secret" },
        responseHeaders: { "x-vercel-id": "request-test", "set-cookie": "secret" },
        responseBody: JSON.stringify({
          generationId: "gen-test",
          error: { type: "internal_server_error", message: "synthetic-secret" },
          secret: "do-not-retain",
        }),
      },
    },
    "synthetic-secret",
  );
  expect(r.generationId).toBe("gen-test");
  expect(r.headers["x-vercel-id"]).toBe("request-test");
  expect(JSON.stringify(r)).not.toContain("synthetic-secret");
  expect(JSON.stringify(r)).not.toContain("another-secret");
  expect(JSON.stringify(r)).not.toContain("do-not-retain");
  expect(JSON.stringify(r)).not.toContain("set-cookie");
});

test("arbitrary provider messages are not retained", () => {
  const r = safeGatewayError({
    message: "echoed-private-source Basic second-credential",
    cause: {
      responseBody: JSON.stringify({
        error: { type: "service_unavailable_error", message: "password=another-secret" },
      }),
    },
  });
  expect(JSON.stringify(r)).not.toContain("echoed-private-source");
  expect(JSON.stringify(r)).not.toContain("another-secret");
  expect(r).not.toHaveProperty("message");
  expect(r).not.toHaveProperty("upstreamMessage");
});
test("transport observation returns the original response without retaining body or authorization", async () => {
  const rows: Record<string, unknown>[] = [],
    response = new Response("ok", { headers: { "x-vercel-id": "request-test" } });
  const transport = Object.assign(async () => response, { preconnect: fetch.preconnect });
  const observed = observedGatewayFetch((row) => rows.push(row), transport);
  expect(
    await observed("https://example.test/evaluation-model", {
      method: "POST",
      headers: { authorization: "Bearer secret-value", "ai-model-id": "typesafe-ai/jev" },
      body: "private-source-body",
    }),
  ).toBe(response);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.bodyBytes).toBe(19);
  expect(JSON.stringify(rows)).not.toContain("secret-value");
  expect(JSON.stringify(rows)).not.toContain("private-source-body");
});
test("diagnostic evaluator observes parent cancellation", async () => {
  const parent = new AbortController(),
    signal = diagnosticSignal(parent.signal);
  const evaluator = () =>
    new Promise<void>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  const running = evaluator();
  parent.abort(new Error("investigation_deadline"));
  await expect(running).rejects.toThrow("investigation_deadline");
});
