import { expect, test } from "bun:test";
import { APIError } from "openai";
import { unwrappedErrorBody } from "@opengeni/runtime";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";

test("a provider error wrapped in a JSON array names the provider's reason", () => {
  // Google's OpenAI-compatible endpoints answer errors as an array. Synthetic body.
  const body = [
    {
      error: {
        code: 400,
        message: "Function call is missing a thought_signature in functionCall parts.",
        status: "INVALID_ARGUMENT",
      },
    },
  ];
  const error = APIError.generate(400, unwrappedErrorBody(body), undefined, new Headers());
  const payload = agentRunFailurePayload(error);
  expect(payload.error).toBe(
    "400 Function call is missing a thought_signature in functionCall parts.",
  );
  expect(payload.error).not.toContain("no body");
});
