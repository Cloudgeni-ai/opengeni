import { describe, expect, test } from "bun:test";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";
import { RoutingMutationOutcomeUnknownError } from "../src/sandbox/routing/routing-session";
import { ModalCommandStartNotDispatchedError } from "../src/sandbox/providers/modal-command-router-wire";

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
  const helperPollStarted = deferred<void>();
  const exactPollStarted = deferred<void>();
  const state = {
    launches: 0,
    ordinaryHelpers: 0,
    exactHelpers: 0,
    retained: true,
    helperRetained: true,
    helperReconciled: false,
    helperIdentity: "retained-412",
    renderHelperFault: false,
    helperReads: [] as number[],
    cancelStart: async () => start.resolve(running(411)),
    ordinaryHelper: async (): Promise<string> => {
      throw new ModalCommandStartNotDispatchedError(new Error("helper Start was never sent"));
    },
    exactPoll: async (): Promise<string> => {
      state.retained = false;
      return exited(130);
    },
    helperPoll: async (): Promise<string> => {
      state.helperRetained = false;
      return exited(76);
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
    hasRetainedProcess: (sessionId: number) =>
      sessionId === 411 ? state.retained : sessionId === 412 && state.helperRetained,
    retainedProcessIdentity: (sessionId: number) => ({
      id: sessionId === 412 ? state.helperIdentity : `retained-${sessionId}`,
    }),
    reconcileRetainedProcess: async (sessionId: number) => {
      if (sessionId !== 412 || !state.helperReconciled) return false;
      state.helperRetained = false;
      return true;
    },
    cancelPendingExecCommand: async () => await state.cancelStart(),
    cancelSupervisedCommand: async () => false,
    execCommandForProcessControl: async () => {
      state.exactHelpers++;
      return exited(0);
    },
    writeStdinForProcessControl: async (args: { sessionId: number; chars?: string }) => {
      if (args.sessionId === 412) {
        expect(args.chars).toBe("");
        state.helperReads.push(args.sessionId);
        helperPollStarted.resolve();
        return await state.helperPoll();
      }
      exactPollStarted.resolve();
      return await state.exactPoll();
    },
    execCommand: invokeExec,
    writeStdin: async () => exited(130),
  };
  const [wrapped] = controller.wrapTools(
    [
      {
        type: "function",
        name: "exec_command",
        invoke: async (context: unknown, input: string) => {
          const helper = state.launches > 0;
          try {
            return await invokeExec(context, input);
          } catch (error) {
            // The SDK's errorFunction can erase helper retained-error metadata;
            // cleanup must select the same session's direct exec instead.
            if (helper && state.renderHelperFault) return "tool error";
            throw error;
          }
        },
      },
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
    helperPollStarted: helperPollStarted.promise,
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
        return exited(76);
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

    for (const result of ["running", "retained_error"] as const) {
      test(`${entryPoint} joins the SAME ${result} proof helper's physical settlement`, async () => {
        const fixture = pendingInvocation(entryPoint);
        const release = deferred<void>();
        fixture.state.cancelStart = async () => {};
        fixture.state.renderHelperFault = true;
        fixture.state.ordinaryHelper = async () => {
          if (result === "retained_error") {
            throw new RoutingMutationOutcomeUnknownError("execCommand", "helper receipt unknown", {
              retainedProcess: { id: "retained-412", providerSessionId: 412 },
            });
          }
          return running(412);
        };
        fixture.state.helperPoll = async () => {
          await release.promise;
          fixture.state.helperRetained = false;
          return exited(76);
        };
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        try {
          expect(await settlesWithin(fixture.helperStarted, 500)).toBe(true);
          fixture.start.resolve(running(411));
          const drain = fixture.controller.waitForQuiescence();
          expect(await settlesWithin(drain, 150)).toBe(false);
          expect(fixture.state.helperRetained).toBe(true);
          expect(fixture.state.exactHelpers).toBe(0);
          expect(fixture.state.ordinaryHelpers).toBe(1);
          // Both initial helper receipt forms identify its own process, not
          // the original command's PGID. Only empty reads may join that helper.
          expect(await settlesWithin(fixture.helperPollStarted, 500)).toBe(true);
          release.resolve();
          expect(await settlesWithin(drain, 500)).toBe(true);
          expect(fixture.state.helperReads).toEqual([412]);
          expect(fixture.state.helperRetained).toBe(false);
          expect(fixture.state.ordinaryHelpers).toBe(1);
          expect(fixture.state.exactHelpers).toBe(1);
          expect(fixture.state.launches).toBe(1);
        } finally {
          release.resolve();
          await fixture.teardown();
        }
      });
    }

    test(`${entryPoint} joins exact reaper proof without detaching the helper early`, async () => {
      const fixture = pendingInvocation(entryPoint);
      const release = deferred<void>();
      fixture.state.cancelStart = async () => {};
      fixture.state.ordinaryHelper = async () => running(412);
      fixture.state.helperPoll = async () => {
        await release.promise;
        return exited(76);
      };
      await fixture.started;
      fixture.abort.abort(new Error("steered"));
      try {
        expect(await settlesWithin(fixture.helperPollStarted, 500)).toBe(true);
        fixture.start.resolve(running(411));
        const drain = fixture.controller.waitForQuiescence();
        expect(await settlesWithin(drain, 150)).toBe(false);
        expect(fixture.state.ordinaryHelpers).toBe(1);
        expect(fixture.state.exactHelpers).toBe(0);
        fixture.state.helperReconciled = true;
        expect(await settlesWithin(drain, 500)).toBe(true);
        expect(fixture.state.helperReads).toEqual([412]);
        expect(fixture.state.exactHelpers).toBe(1);
      } finally {
        release.resolve();
        await fixture.teardown();
      }
    });

    for (const result of [
      "rejected",
      "rendered_error",
      "unretained",
      "retained_error_without_locator",
      "identity_mismatch",
    ] as const) {
      test(`${entryPoint} fails closed on the issued helper's ${result} outcome`, async () => {
        const fixture = pendingInvocation(entryPoint);
        fixture.state.cancelStart = async () => {};
        fixture.state.helperRetained = false;
        fixture.state.ordinaryHelper = async () => {
          if (result === "rejected") throw new Error("helper acceptance unknown");
          if (result === "retained_error_without_locator")
            throw new RoutingMutationOutcomeUnknownError("execCommand", "helper locator unknown");
          if (result === "identity_mismatch") {
            fixture.state.helperRetained = true;
            throw new RoutingMutationOutcomeUnknownError("execCommand", "helper receipt unknown", {
              retainedProcess: { id: "different-process", providerSessionId: 412 },
            });
          }
          return result === "unretained" ? running(412) : "tool error";
        };
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        expect(await settlesWithin(fixture.helperStarted, 500)).toBe(true);
        fixture.start.resolve(running(411));
        expect(await settlesWithin(fixture.controller.waitForQuiescence(), 150)).toBe(false);
        expect(fixture.state.ordinaryHelpers).toBe(1);
        expect(fixture.state.exactHelpers).toBe(0);
        expect(fixture.state.helperReads).toEqual([]);
        expect(fixture.state.launches).toBe(1);
        // There is intentionally no fabricated settlement for an unknown,
        // unretained helper. Its unresolved promise has no polling timer or
        // provider mock running; the physical fence must remain closed.
        await fixture.invocation;
      });
    }
  }
});
