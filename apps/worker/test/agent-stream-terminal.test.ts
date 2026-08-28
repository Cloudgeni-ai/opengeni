import { describe, expect, test } from "bun:test";
import { StreamedRunResult } from "@openai/agents-core";
import {
  assertAgentStreamNotCancelled,
  assertSuccessfulAgentStreamCompletion,
  IncompleteAgentStreamError,
  requireAgentStreamFinalOutput,
} from "../src/activities/agent-turn/quiescence";
import { SandboxDeadlineRotationError } from "../src/activities/agent-turn/sandbox-provision";

describe("agent stream terminal authority", () => {
  test("an SDK abort EOF cannot become an empty successful turn", async () => {
    const runtimeController = new AbortController();
    const rotation = new SandboxDeadlineRotationError("sandbox-group", 7);
    const stream = new StreamedRunResult({
      state: { _currentStep: undefined } as never,
      signal: runtimeController.signal,
    });
    const iterator = stream.toStream()[Symbol.asyncIterator]();

    runtimeController.abort(rotation);
    expect(await iterator.next()).toMatchObject({ done: true });

    // The SDK closes its readable side synchronously on abort, then rejects
    // `completed` when its internal run loop exits. Exercise that exact split
    // without replacing the SDK object with a friendlier fake.
    (
      stream as unknown as {
        _raiseError(error: unknown): void;
      }
    )._raiseError(rotation);

    await expect(
      assertSuccessfulAgentStreamCompletion({
        batcherFlush: Promise.resolve(),
        stream,
        temporalCancellationSignal: undefined,
        runtimeCancellationSignal: runtimeController.signal,
      }),
    ).rejects.toBe(rotation);
  });

  test("Temporal cancellation detaches hung cleanup but still prevents success", async () => {
    const cancellationController = new AbortController();
    const cancellation = new Error("STEER");
    const hung = new Promise<never>(() => undefined);
    const startedAt = performance.now();
    const completion = assertSuccessfulAgentStreamCompletion({
      batcherFlush: hung,
      stream: {
        completed: hung,
        error: null,
      },
      temporalCancellationSignal: cancellationController.signal,
      runtimeCancellationSignal: cancellationController.signal,
    });

    cancellationController.abort(cancellation);
    await expect(completion).rejects.toBe(cancellation);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("an SDK completion rejection propagates without a cancellation signal", async () => {
    const providerFailure = new Error("provider stream failed after EOF");

    await expect(
      assertSuccessfulAgentStreamCompletion({
        batcherFlush: Promise.resolve(),
        stream: {
          completed: Promise.reject(providerFailure),
          error: null,
        },
        temporalCancellationSignal: undefined,
        runtimeCancellationSignal: new AbortController().signal,
      }),
    ).rejects.toBe(providerFailure);
  });

  test("a cancelled SDK stream cannot proceed to normal settlement", () => {
    expect(() => assertAgentStreamNotCancelled(true)).toThrow(IncompleteAgentStreamError);
    expect(() => assertAgentStreamNotCancelled(false)).not.toThrow();
  });

  test("a resolved SDK stream without final output fails closed", () => {
    expect(() => requireAgentStreamFinalOutput(undefined)).toThrow(IncompleteAgentStreamError);
  });

  test("an explicit empty final output remains a valid completed result", () => {
    expect(requireAgentStreamFinalOutput("")).toBe("");
  });
});
