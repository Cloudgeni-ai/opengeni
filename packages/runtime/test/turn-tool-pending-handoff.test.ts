import { describe, expect, test } from "bun:test";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import { RoutingMutationOutcomeUnknownError } from "../src/sandbox/routing/routing-session";

const running = (sessionId: number) => `Process running with session ID ${sessionId}\n\nOutput:\n`;
const exited = (exitCode: number) => `Process exited with code ${exitCode}\n\nOutput:\n`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const settlesWithin = async (promise: Promise<unknown>, milliseconds: number) =>
  await Promise.race([promise.then(() => true), Bun.sleep(milliseconds).then(() => false)]);

function pendingInvocation(entryPoint: "model" | "lifecycle") {
  const abort = new AbortController();
  const controller = createTurnToolCancellationController(abort.signal);
  const started = deferred<void>();
  const start = deferred<string>();
  const helperStarted = deferred<void>();
  const exactPollStarted = deferred<void>();
  const state = {
    launches: 0,
    ordinaryHelpers: 0,
    exactHelpers: 0,
    retained: true,
    cancelStart: async () => start.resolve(running(411)),
    ordinaryHelper: async (): Promise<string> => {
      throw new Error("ordinary attempt is fenced");
    },
    exactPoll: async (): Promise<string> => {
      state.retained = false;
      return exited(130);
    },
  };
  const invokeExec = async (_context?: unknown, _input?: string) => {
    if (state.launches === 0) {
      state.launches++;
      started.resolve();
      return await start.promise;
    }
    state.ordinaryHelpers++;
    helperStarted.resolve();
    return await state.ordinaryHelper();
  };
  const session = {
    supportsPty: () => true,
    hasRetainedProcess: (sessionId: number) => sessionId === 411 && state.retained,
    cancelPendingExecCommand: async () => await state.cancelStart(),
    cancelSupervisedCommand: async () => false,
    execCommandForProcessControl: async () => {
      state.exactHelpers++;
      return exited(0);
    },
    writeStdinForProcessControl: async () => {
      exactPollStarted.resolve();
      return await state.exactPoll();
    },
    execCommand: invokeExec,
    writeStdin: async () => exited(130),
  };
  const [wrapped] = controller.wrapTools(
    [
      { type: "function", name: "exec_command", invoke: invokeExec },
      { type: "function", name: "write_stdin", invoke: async () => exited(130) },
    ],
    session,
  );
  const invocation = (
    entryPoint === "model"
      ? wrapped!.invoke({}, JSON.stringify({ cmd: "sleep 60", tty: false, yield_time_ms: 0 }))
      : controller.runSandboxCommand(session, { cmd: "sleep 60", tty: false, yieldTimeMs: 0 })
  ).catch((error: unknown) => error);
  return {
    controller,
    abort,
    state,
    start,
    started: started.promise,
    helperStarted: helperStarted.promise,
    exactPollStarted: exactPollStarted.promise,
    invocation,
    teardown: async () => {
      // Release only mocks so even a failing baseline leaves no pending drain.
      state.ordinaryHelper = async () => exited(0);
      start.resolve(running(411));
      await controller.waitForQuiescence();
      await invocation;
    },
  };
}

describe("pending shell cancellation after exact retained handoff", () => {
  for (const entryPoint of ["model", "lifecycle"] as const) {
    for (const result of ["running", "retained_error"] as const) {
      test(`${entryPoint} hands off ${result} without retrying a fenced ordinary helper`, async () => {
        const fixture = pendingInvocation(entryPoint);
        if (result === "retained_error") {
          fixture.state.cancelStart = async () =>
            fixture.start.reject(
              new RoutingMutationOutcomeUnknownError("execCommand", "promotion pending", {
                retainedProcess: { id: "retained-process", providerSessionId: 411 },
              }),
            );
        }
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        try {
          expect(await settlesWithin(fixture.controller.waitForQuiescence(), 500)).toBe(true);
          // One proof helper may race the still-pending handoff. It must never
          // be retried after the exact retained route has been registered.
          expect(fixture.state.ordinaryHelpers).toBeLessThanOrEqual(1);
          expect(fixture.state.exactHelpers).toBe(1);
          expect(fixture.state.retained).toBe(false);
          expect(fixture.state.launches).toBe(1);
        } finally {
          await fixture.teardown();
        }
      });
    }

    for (const result of ["rejected", "rendered_error", "unretained"] as const) {
      test(`${entryPoint} does not treat ${result} transport settlement as a retained handoff`, async () => {
        const fixture = pendingInvocation(entryPoint);
        fixture.state.retained = false;
        fixture.state.cancelStart = async () => {
          if (result === "rejected") fixture.start.reject(new Error("start outcome unknown"));
          else fixture.start.resolve(result === "unretained" ? running(411) : "tool error");
        };
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        try {
          expect(await settlesWithin(fixture.controller.waitForQuiescence(), 150)).toBe(false);
          expect(fixture.state.ordinaryHelpers).toBeGreaterThanOrEqual(2);
          expect(fixture.state.exactHelpers).toBe(0);
          expect(fixture.state.launches).toBe(1);
        } finally {
          await fixture.teardown();
        }
      });
    }

    test(`${entryPoint} still waits for exact retained-process settlement`, async () => {
      const fixture = pendingInvocation(entryPoint);
      const release = deferred<void>();
      fixture.state.exactPoll = async () => {
        await release.promise;
        fixture.state.retained = false;
        return exited(130);
      };
      await fixture.started;
      fixture.abort.abort(new Error("steered"));
      try {
        expect(await settlesWithin(fixture.exactPollStarted, 500)).toBe(true);
        expect(await settlesWithin(fixture.controller.waitForQuiescence(), 50)).toBe(false);
        expect(fixture.state.retained).toBe(true);
      } finally {
        release.resolve();
        await fixture.teardown();
      }
      expect(fixture.state.retained).toBe(false);
    });

    test(`${entryPoint} does not detach a proof helper already issued before handoff`, async () => {
      const fixture = pendingInvocation(entryPoint);
      const release = deferred<void>();
      fixture.state.cancelStart = async () => {};
      fixture.state.ordinaryHelper = async () => {
        await release.promise;
        throw new Error("ordinary attempt is fenced");
      };
      await fixture.started;
      fixture.abort.abort(new Error("steered"));
      try {
        expect(await settlesWithin(fixture.helperStarted, 500)).toBe(true);
        fixture.start.resolve(running(411));
        expect(await settlesWithin(fixture.controller.waitForQuiescence(), 50)).toBe(false);
        expect(fixture.state.exactHelpers).toBe(0);
        release.resolve();
        expect(await settlesWithin(fixture.controller.waitForQuiescence(), 500)).toBe(true);
        expect(fixture.state.ordinaryHelpers).toBe(1);
        expect(fixture.state.exactHelpers).toBe(1);
      } finally {
        release.resolve();
        await fixture.teardown();
      }
    });
  }
});
