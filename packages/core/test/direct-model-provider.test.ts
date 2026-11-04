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

test("an OpenAI-compatible endpoint is checked with one short Chat Completions or Responses call", async () => {
  for (const api of [undefined, "chat", "responses"] as const) {
    let requestedUrl = "";
    let request: RequestInit = {};
    const transport = (async (url: string, init: RequestInit) => {
      requestedUrl = url;
      request = init;
      return Response.json(
        api === "responses"
          ? { output: [{ type: "message", content: [] }] }
          : { choices: [{ message: { role: "assistant", content: "OK" } }] },
      );
    }) as typeof fetch;
    await verifyDirectModelAccess(
      {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        model: "org/model:tag",
        ...(api ? { api } : {}),
      },
      "private-test-key",
      transport,
    );
    expect(requestedUrl).toBe(
      api === "responses"
        ? "https://api.example.com/v1/responses"
        : "https://api.example.com/v1/chat/completions",
    );
    expect(request.redirect).toBe("error");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer private-test-key");
    expect(JSON.parse(request.body as string)).toEqual(
      api === "responses"
        ? { model: "org/model:tag", input: "Reply OK.", max_output_tokens: 32 }
        : {
            model: "org/model:tag",
            messages: [{ role: "user", content: "Reply OK." }],
            max_tokens: 32,
            stream: false,
          },
    );
  }
});

test("OpenAI-compatible check failures are actionable and never reflect the endpoint's reply", async () => {
  const config = {
    provider: "openai_compatible" as const,
    baseUrl: "https://api.example.com/v1",
    model: "model",
  };
  for (const [status, message] of [
    [401, "API key"],
    [404, "base URL"],
    [400, "model ID exactly"],
    [429, "quota"],
    [500, "Try again"],
  ] as const) {
    const transport = (async () =>
      Response.json({ error: { message: "private-test-key" } }, { status })) as typeof fetch;
    const error = await verifyDirectModelAccess(config, "private-test-key", transport).catch(
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain("private-test-key");
  }
  // A success status without a chat reply is not a working endpoint.
  const html = (async () => new Response("<html>private-test-key</html>")) as typeof fetch;
  await expect(verifyDirectModelAccess(config, "private-test-key", html)).rejects.toThrow(
    "couldn’t complete",
  );
  const refused = (async () => {
    throw new Error("Model endpoint may not target a private or special-use network address");
  }) as typeof fetch;
  const unreachable = await verifyDirectModelAccess(config, "private-test-key", refused).catch(
    (caught: unknown) => caught as Error & { status?: number },
  );
  expect(unreachable?.message).toContain("public HTTPS address");
  // Shown to the person as is: the API replaces every 502 with a generic outage message.
  expect(unreachable?.status).toBe(422);
});
