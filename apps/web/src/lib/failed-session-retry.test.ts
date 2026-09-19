import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import { createFailedSessionRetry, type FailedSessionRetryInput } from "./failed-session-retry";

const policy = {
  model: "selected-model",
  reasoningEffort: "medium",
  latencyMode: "standard",
} as const;

test("recovery captures the selected model without adding a user prompt", async () => {
  const inputs: FailedSessionRetryInput[] = [];
  const retry = createFailedSessionRetry(async (input) => {
    inputs.push(input);
  });
  expect(await retry("failure-a", policy)).toBe(true);
  expect(await retry("failure-a", policy)).toBe(true);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toEqual({
    ...policy,
    failureEventId: "failure-a",
    clientEventId: expect.any(String),
  });
  expect(inputs[0]).not.toHaveProperty("text");
});

test("double clicks coalesce and an uncertain retry retains its body and key", async () => {
  const inputs: FailedSessionRetryInput[] = [];
  let reject!: (error: Error) => void;
  const retry = createFailedSessionRetry(async (input) => {
    inputs.push(input);
    if (inputs.length === 1)
      await new Promise<never>((_resolve, fail) => {
        reject = fail;
      });
  });
  const first = retry("failure-a", policy);
  expect(retry("failure-a", policy)).toBe(first);
  reject(new Error("Connection lost after dispatch"));
  await expect(first).rejects.toThrow("Connection lost");
  await retry("failure-a", { ...policy, model: "later-selection" });
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toBe(inputs[0]);
  expect(inputs[1]?.model).toBe("selected-model");
});

test("a definitive policy rejection allows a corrected model with a new operation", async () => {
  const inputs: FailedSessionRetryInput[] = [];
  const retry = createFailedSessionRetry(async (input) => {
    inputs.push(input);
    if (inputs.length === 1) throw new OpenGeniApiError(422, "Unsupported model");
  });
  await expect(retry("failure-a", policy)).rejects.toThrow("Unsupported model");
  await retry("failure-a", { ...policy, model: "corrected-model" });
  expect(inputs[1]?.clientEventId).not.toBe(inputs[0]?.clientEventId);
  expect(inputs[1]?.model).toBe("corrected-model");
});

test("a late receipt for an older failure does not consume a newer retry", async () => {
  let settle!: () => void;
  const inputs: FailedSessionRetryInput[] = [];
  const retry = createFailedSessionRetry(async (input) => {
    inputs.push(input);
    if (inputs.length === 1)
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
  });
  const old = retry("failure-a", policy);
  await retry("failure-b", policy);
  settle();
  await old;
  await retry("failure-b", policy);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]?.clientEventId).not.toBe(inputs[1]?.clientEventId);
});
