import { expect, test } from "bun:test";
import { verifyDirectModelAccess } from "../src/domain/direct-model-provider";

test("connection checks use the exact official route, with redirects and response storage disabled", async () => {
  for (const provider of ["openai", "azure_openai"] as const) {
    let requestedUrl = "";
    let request: RequestInit = {};
    const transport = (async (url: string, init: RequestInit) => {
      requestedUrl = url;
      request = init;
      return Response.json({ status: "completed" });
    }) as typeof fetch;
    await verifyDirectModelAccess(
      {
        provider,
        model: "my-model",
        ...(provider === "azure_openai" ? { endpoint: "https://customer.openai.azure.com" } : {}),
      },
      "private-test-key",
      transport,
    );
    expect(requestedUrl).toBe(
      provider === "openai"
        ? "https://api.openai.com/v1/responses"
        : "https://customer.openai.azure.com/openai/v1/responses",
    );
    expect(request.redirect).toBe("error");
    expect(JSON.parse(request.body as string)).toEqual({
      model: "my-model",
      input: "Reply OK.",
      max_output_tokens: 32,
      store: false,
    });
    const headers = new Headers(request.headers);
    expect(headers.get(provider === "openai" ? "authorization" : "api-key")).toBe(
      provider === "openai" ? "Bearer private-test-key" : "private-test-key",
    );
  }
});

test("provider errors have actionable messages and never reflect upstream secrets", async () => {
  for (const [status, message] of [
    [401, "API key"],
    [403, "permissions"],
    [404, "deployment"],
    [400, "deployment"],
    [429, "quota"],
    [500, "Try again"],
  ] as const) {
    const transport = (async () =>
      Response.json({ error: { message: "private-test-key" } }, { status })) as typeof fetch;
    try {
      await verifyDirectModelAccess(
        {
          provider: "azure_openai",
          model: "deployment",
          endpoint: "https://customer.openai.azure.com",
        },
        "private-test-key",
        transport,
      );
      throw new Error("Expected connection rejection");
    } catch (error) {
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("private-test-key");
    }
  }
});

test("invalid routes never dispatch and network errors are safe to display", async () => {
  let calls = 0;
  const transport = (async () => {
    calls++;
    throw new Error("private-test-key");
  }) as typeof fetch;
  await expect(
    verifyDirectModelAccess(
      { provider: "azure_openai", model: "deployment", endpoint: "https://evil.test" },
      "private-test-key",
      transport,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(
    verifyDirectModelAccess({ provider: "openai", model: "model" }, "private-test-key", transport),
  ).rejects.toThrow("couldn’t reach");
  expect(calls).toBe(1);
});
