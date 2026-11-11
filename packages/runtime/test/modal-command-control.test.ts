import { expect, test } from "bun:test";
import {
  ModalCommandControl,
  modalCommandAbortMiddleware,
} from "../src/sandbox/providers/modal-command-control";

test("unsupported SDK contracts fail before provider execution", () => {
  expect(() =>
    ModalCommandControl.forSandbox(
      { cpClient: {}, version: () => "0.10.0" } as never,
      "sb-test",
      "/workspace",
    ),
  ).toThrow("verified 0.9.0");
});

test("dedicated non-retrying middleware preserves unary and streaming abort authority", async () => {
  const cancellation = new AbortController();
  const observed: unknown[] = [];
  const call = (value: unknown) =>
    ({
      request: {},
      next: async function* (_request: unknown, downstream: { signal?: AbortSignal }) {
        observed.push(downstream.signal);
        yield value;
      },
    }) as never;
  const results: unknown[] = [];
  for await (const value of modalCommandAbortMiddleware(call("unary"), {
    signal: cancellation.signal,
  }))
    results.push(value);
  for await (const value of modalCommandAbortMiddleware(call("stream"), {
    signal: cancellation.signal,
  }))
    results.push(value);
  expect(results).toEqual(["unary", "stream"]);
  expect(observed).toEqual([cancellation.signal, cancellation.signal]);

  cancellation.abort(new Error("cancelled"));
  const pipeline = modalCommandAbortMiddleware(call("late"), { signal: cancellation.signal });
  await expect(pipeline.next()).rejects.toThrow("cancelled");
  expect(observed).toHaveLength(2);
});
