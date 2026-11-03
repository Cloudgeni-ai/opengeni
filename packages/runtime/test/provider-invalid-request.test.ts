import { afterEach, expect, test } from "bun:test";
import { configureRuntimeMetricsHooks, instrumentedModelFetch } from "../src/model-provider-client";
import { invalidRequestSignature } from "../src/provider-invalid-request";

afterEach(() => configureRuntimeMetricsHooks(null));

test("the error path is the provider's, with every index collapsed and no message", () => {
  // OpenAI and Responses gateways name the parameter.
  expect(
    invalidRequestSignature({
      error: {
        message: "Invalid 'input[26].tools[1].name': string does not match pattern.",
        type: "invalid_request_error",
        param: "input[26].tools[1].name",
        code: "invalid_string",
      },
    }),
  ).toEqual({ path: "input[].tools[].name", code: "invalid_string" });
  // Claude leads its message with the path.
  expect(
    invalidRequestSignature({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "messages.3.content.0.tool_use.name: String should match pattern",
      },
    }),
  ).toEqual({ path: "messages[].content[].tool_use.name", code: "invalid_request_error" });
  // A path inside the message, as some gateways relay it.
  expect(
    invalidRequestSignature({
      error: { message: "400 [StringParam] [input[26].tools[1].name] [invalid_string]", code: 400 },
    }),
  ).toEqual({ path: "input[].tools[].name", code: "unknown" });
  // Nothing structural: no path, and never the message.
  expect(invalidRequestSignature({ error: { message: "Bad request: secret-ish words" } })).toEqual({
    path: "unknown",
    code: "unknown",
  });
  expect(invalidRequestSignature({ error: { param: "x".repeat(200), code: "a b" } })).toEqual({
    path: "unknown",
    code: "unknown",
  });
});

test("a 400 model call is counted by path without delaying or consuming the response", async () => {
  const counted: unknown[] = [];
  configureRuntimeMetricsHooks({ onModelInvalidRequest: (input) => counted.push(input) });
  const body = JSON.stringify({
    error: { type: "invalid_request_error", param: "input[2].name", code: "invalid_string" },
  });
  const fetcher = instrumentedModelFetch(
    "openai",
    (async () => new Response(body, { status: 400 })) as typeof fetch,
  );
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    body: "{}",
  });
  // The caller still reads the whole error body.
  expect(await response.text()).toBe(body);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(counted).toEqual([{ provider: "openai", path: "input[].name", code: "invalid_string" }]);

  // Other statuses are not counted.
  const success = instrumentedModelFetch(
    "openai",
    (async () => new Response(body, { status: 200 })) as typeof fetch,
  );
  await (
    await success("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
  ).text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(counted).toHaveLength(1);

  // A throwing hook never fails the call.
  configureRuntimeMetricsHooks({
    onModelInvalidRequest: () => {
      throw new Error("metrics down");
    },
  });
  const ok = instrumentedModelFetch(
    "openai",
    (async () => new Response("{}", { status: 400 })) as typeof fetch,
  );
  expect(
    (await ok("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })).status,
  ).toBe(400);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
