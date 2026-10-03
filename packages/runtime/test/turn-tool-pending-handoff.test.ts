import { describe, expect, test } from "bun:test";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";

const running = (sessionId: number) => `Process running with session ID ${sessionId}\n\nOutput:\n`;
const exited = (exitCode: number) => `Process exited with code ${exitCode}\n\nOutput:\n`;

describe("pending shell cancellation after exact retained handoff", () => {
  for (const entryPoint of ["model", "lifecycle"] as const) {
    test(`${entryPoint} drains the retained process without retrying a fenced ordinary helper`, async () => {
      const abort = new AbortController();
      const controller = createTurnToolCancellationController(abort.signal);
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let returnStart!: (output: string) => void;
      const pendingStart = new Promise<string>((resolve) => {
        returnStart = resolve;
      });
      let launches = 0;
      let ordinaryHelpers = 0;
      let exactHelpers = 0;
      let retained = true;
      let allowOrdinaryHelperForTeardown = false;
      const invokeExec = async (_context?: unknown, _input?: string) => {
        if (launches === 0) {
          launches++;
          markStarted();
          return await pendingStart;
        }
        ordinaryHelpers++;
        // Ordinary mutation admission is fenced after Steer. The already
        // retained process still has its independent exact control surface.
        if (!allowOrdinaryHelperForTeardown) throw new Error("ordinary attempt is fenced");
        return exited(0);
      };
      const session = {
        supportsPty: () => true,
        hasRetainedProcess: (sessionId: number) => sessionId === 411 && retained,
        cancelPendingExecCommand: async () => {
          // Transport cancellation races the original start's successful
          // retained handoff, rather than proving that no process was started.
          returnStart(running(411));
        },
        cancelSupervisedCommand: async () => false,
        execCommandForProcessControl: async () => {
          exactHelpers++;
          return exited(0);
        },
        writeStdinForProcessControl: async () => {
          retained = false;
          return exited(130);
        },
        execCommand: invokeExec,
        writeStdin: async () => exited(130),
      };
      const [wrapped] = controller.wrapTools(
        [{ type: "function", name: "exec_command", invoke: invokeExec }],
        session,
      );
      const invocation = (
        entryPoint === "model"
          ? wrapped!.invoke({}, JSON.stringify({ cmd: "sleep 60", tty: false, yield_time_ms: 0 }))
          : controller.runSandboxCommand(session, {
              cmd: "sleep 60",
              tty: false,
              yieldTimeMs: 0,
            })
      ).catch((error: unknown) => error);
      await started;
      abort.abort(new Error("steered"));
      const quiescence = controller.waitForQuiescence();
      let drained = false;
      try {
        drained = await Promise.race([
          quiescence.then(() => true),
          Bun.sleep(50).then(() => false),
        ]);
      } finally {
        // Baseline fails this regression; release only the mock helper so no
        // pending drain survives the failing assertion or pollutes other tests.
        allowOrdinaryHelperForTeardown = true;
        await quiescence;
      }
      expect(drained).toBe(true);
      expect(ordinaryHelpers).toBe(0);
      expect(exactHelpers).toBe(1);
      expect(retained).toBe(false);
      expect(launches).toBe(1);
      expect(await invocation).toBeInstanceOf(Error);
    });
  }
});
