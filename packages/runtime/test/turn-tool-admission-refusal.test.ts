import { describe, expect, test } from "bun:test";
import { SandboxWorkspaceMutationFencedError } from "@opengeni/db";
import { withModelPreparationSessionDiagnostics } from "../src/model-preparation-diagnostics";
import {
  withCodemodeTokenEnvironment,
  withCodemodeTokenSession,
} from "../src/sandbox/codemode-token";
import {
  withRunCredentialEnvironment,
  withRunCredentialsSession,
} from "../src/sandbox/run-credentials";
import {
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
  type RoutableBackendSession,
} from "../src/sandbox/routing/routing-session";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";

const running = (id: number) => `Process running with session ID ${id}\n\nOutput:\n`;
const exited = (code: number) => `Process exited with code ${code}\n\nOutput:\n`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settlesWithin = async (promise: Promise<unknown>, milliseconds: number) =>
  await Promise.race([promise.then(() => true), Bun.sleep(milliseconds).then(() => false)]);

const decoratorModes = ["none", "run_credentials", "codemode", "composed"] as const;
type DecoratorMode = (typeof decoratorModes)[number];
const credentialSessionId = "admission-refusal-test";
const tokenFile = "/workspace/.opengeni/codemode-tokens/test-pointer";
const codemodeUrl = "https://codemode.example.invalid";
const clientDirectory = "/workspace/.opengeni/codemode-clients/test-client";

function decoratedSession<T extends object>(session: T, mode: DecoratorMode): T {
  if (mode === "none") return session;
  const credentialSession = ["run_credentials", "composed"].includes(mode)
    ? withRunCredentialsSession(session, credentialSessionId)
    : session;
  const commandSession = ["codemode", "composed"].includes(mode)
    ? withCodemodeTokenSession(credentialSession, tokenFile, codemodeUrl, clientDirectory)
    : credentialSession;
  // Same order as the production SDK session. These decorators only construct
  // command strings here; no credential/token files or providers are accessed.
  return withModelPreparationSessionDiagnostics(commandSession);
}

type HelperOutcome =
  | "admission_refused"
  | "replaced_refusal"
  | "rendered_refusal"
  | "provider_fence"
  | "unknown"
  | "issued";

function realAdmission(
  entryPoint: "model" | "lifecycle",
  helperOutcome: HelperOutcome,
  mode: DecoratorMode,
) {
  const abort = new AbortController();
  const controller = createTurnToolCancellationController(abort.signal);
  const started = deferred<void>();
  const registration = deferred<string>();
  const helperAttempted = deferred<void>();
  const helperRead = deferred<void>();
  const helperExit = deferred<void>();
  const originalRead = deferred<void>();
  const originalExit = deferred<void>();
  const originalSettlement = deferred<void>();
  const originalCommit = deferred<void>();
  const fence = new SandboxWorkspaceMutationFencedError("attempt_fenced", "attempt fenced");
  const state = {
    registrationReleased: false,
    admissions: 0,
    denied: 0,
    originalExecs: 0,
    ordinaryHelpers: 0,
    exactHelpers: 0,
    reads: [] as number[],
    settled: [] as number[],
    rejected: [] as string[],
  };
  const backend: RoutableBackendSession = {
    supportsPty: () => true,
    async execCommand(_args, ...trailing) {
      // Admission proof terminates at the router, not at the provider boundary.
      expect(trailing).toEqual([]);
      if (state.originalExecs === 0) {
        state.originalExecs++;
        started.resolve();
        return await registration.promise;
      }
      if (!state.registrationReleased) {
        state.ordinaryHelpers++;
        helperAttempted.resolve();
        if (helperOutcome === "provider_fence") throw fence;
        if (helperOutcome === "unknown")
          throw new RoutingMutationOutcomeUnknownError("execCommand", "helper outcome unknown");
        return running(412);
      }
      state.exactHelpers++;
      return exited(0);
    },
    async writeStdin(args) {
      const { sessionId, chars } = args as { sessionId: number; chars?: string };
      expect(chars).toBe("");
      state.reads.push(sessionId);
      if (sessionId === 412) {
        helperRead.resolve();
        await helperExit.promise;
        return exited(76);
      }
      expect(sessionId).toBe(411);
      originalRead.resolve();
      await originalExit.promise;
      return exited(130);
    },
  };
  const route = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
    beforeMutation: async () => {
      if (
        state.admissions > 0 &&
        ["admission_refused", "replaced_refusal", "rendered_refusal"].includes(helperOutcome)
      ) {
        state.denied++;
        helperAttempted.resolve();
        throw fence;
      }
      state.admissions++;
      return state.admissions;
    },
    afterMutation: async ({ outcome, retainedProcess }) => {
      if (outcome === "rejected") state.rejected.push(outcome);
      if (retainedProcess) expect([411, 412]).toContain(retainedProcess.providerSessionId);
    },
    settleProcess: async ({ process }) => {
      if (process.providerSessionId === 411) {
        originalSettlement.resolve();
        await originalCommit.promise;
      }
      state.settled.push(process.providerSessionId);
    },
  });
  const routedExec = route.execCommand.bind(route);
  route.execCommand = async (args, options) => {
    try {
      return await routedExec(args, options);
    } catch (error) {
      if (helperOutcome === "replaced_refusal")
        throw new Error("refusal identity erased", { cause: error });
      if (helperOutcome === "rendered_refusal") return "tool error";
      throw error;
    }
  };
  const session = decoratedSession(route, mode);
  const [wrapped] = controller.wrapTools(
    [
      {
        type: "function",
        name: "exec_command",
        invoke: async (_context: unknown, input: string) =>
          await session.execCommand(JSON.parse(input)),
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
  const releaseRegistration = () => {
    state.registrationReleased = true;
    registration.resolve(running(411));
  };
  return {
    abort,
    controller,
    route,
    state,
    started: started.promise,
    helperAttempted: helperAttempted.promise,
    helperRead: helperRead.promise,
    helperExit,
    originalRead: originalRead.promise,
    originalExit,
    originalSettlement: originalSettlement.promise,
    originalCommit,
    invocation,
    releaseRegistration,
    teardown: async () => {
      releaseRegistration();
      helperExit.resolve();
      originalExit.resolve();
      originalCommit.resolve();
      await invocation;
    },
  };
}

describe.each(decoratorModes)(
  "pending cancellation through real routing admission (%s)",
  (mode) => {
    for (const entryPoint of ["model", "lifecycle"] as const) {
      test(`${mode} ${entryPoint} hands off after authoritative admission refusal, not before exact settlement`, async () => {
        const fixture = realAdmission(entryPoint, "admission_refused", mode);
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        try {
          // This event requires the real ordinary-helper admission attempt after
          // the 100ms grace, while the original provider registration is held.
          expect(await settlesWithin(fixture.helperAttempted, 700)).toBe(true);
          expect(fixture.state.denied).toBe(1);
          expect(fixture.state.ordinaryHelpers).toBe(0);
          fixture.releaseRegistration();
          await fixture.invocation;
          const drain = fixture.controller.waitForQuiescence();
          expect(await settlesWithin(fixture.originalRead, 700)).toBe(true);
          expect(await settlesWithin(drain, 120)).toBe(false);
          expect(fixture.route.hasRetainedProcess(411)).toBe(true);
          fixture.originalExit.resolve();
          expect(await settlesWithin(fixture.originalSettlement, 700)).toBe(true);
          expect(await settlesWithin(drain, 120)).toBe(false);
          expect(fixture.route.hasRetainedProcess(411)).toBe(true);
          fixture.originalCommit.resolve();
          expect(await settlesWithin(drain, 700)).toBe(true);
          expect(fixture.route.hasRetainedProcess(411)).toBe(false);
          expect(fixture.state).toMatchObject({
            admissions: 1,
            denied: 1,
            originalExecs: 1,
            ordinaryHelpers: 0,
            exactHelpers: 1,
            reads: [411],
            settled: [411],
            rejected: [],
          });
        } finally {
          await fixture.teardown();
        }
      });

      for (const helperOutcome of [
        "provider_fence",
        "unknown",
        "replaced_refusal",
        "rendered_refusal",
      ] as const) {
        test(`${mode} ${entryPoint} fails closed on the helper's ${helperOutcome}`, async () => {
          const fixture = realAdmission(entryPoint, helperOutcome, mode);
          await fixture.started;
          fixture.abort.abort(new Error("steered"));
          try {
            expect(await settlesWithin(fixture.helperAttempted, 700)).toBe(true);
            fixture.releaseRegistration();
            await fixture.invocation;
            const drain = fixture.controller.waitForQuiescence();
            expect(await settlesWithin(drain, 200)).toBe(false);
            const refused = ["replaced_refusal", "rendered_refusal"].includes(helperOutcome);
            expect(fixture.state).toMatchObject({
              admissions: refused ? 1 : 2,
              denied: refused ? 1 : 0,
              originalExecs: 1,
              ordinaryHelpers: refused ? 0 : 1,
              exactHelpers: 0,
              reads: [],
              settled: [],
            });
            // Even independent exact physical settlement of the original cannot
            // release the no-locator helper's independent join or license replay.
            fixture.originalExit.resolve();
            fixture.originalCommit.resolve();
            await fixture.route.writeStdinForProcessControl({ sessionId: 411, chars: "" });
            expect(fixture.route.hasRetainedProcess(411)).toBe(false);
            expect(await settlesWithin(drain, 200)).toBe(false);
            expect(fixture.state.ordinaryHelpers).toBe(refused ? 0 : 1);
            expect(fixture.state.exactHelpers).toBe(0);
          } finally {
            await fixture.teardown();
          }
        });
      }

      test(`${mode} ${entryPoint} retains the issued helper's independent physical join`, async () => {
        const fixture = realAdmission(entryPoint, "issued", mode);
        await fixture.started;
        fixture.abort.abort(new Error("steered"));
        try {
          expect(await settlesWithin(fixture.helperRead, 700)).toBe(true);
          fixture.releaseRegistration();
          await fixture.invocation;
          const drain = fixture.controller.waitForQuiescence();
          expect(await settlesWithin(drain, 200)).toBe(false);
          expect(fixture.route.hasRetainedProcess(412)).toBe(true);
          expect(fixture.state.exactHelpers).toBe(0);
          fixture.helperExit.resolve();
          expect(await settlesWithin(fixture.originalRead, 700)).toBe(true);
          expect(fixture.route.hasRetainedProcess(412)).toBe(false);
          expect(await settlesWithin(drain, 120)).toBe(false);
          fixture.originalExit.resolve();
          fixture.originalCommit.resolve();
          expect(await settlesWithin(drain, 700)).toBe(true);
          expect(fixture.state).toMatchObject({
            admissions: 2,
            denied: 0,
            originalExecs: 1,
            ordinaryHelpers: 1,
            exactHelpers: 1,
            reads: [412, 411],
            settled: [412, 411],
          });
        } finally {
          await fixture.teardown();
        }
      });
    }
  },
);

describe.each(decoratorModes)("routing admission-refusal provenance (%s)", (mode) => {
  for (const firstOperation of [false, true]) {
    test(`${mode} preserves refusal identity and never stamps a reused post-dispatch error (first-operation observer: ${firstOperation})`, async () => {
      const fence = new SandboxWorkspaceMutationFencedError("attempt_fenced", "attempt fenced");
      let admit = false;
      let providerCalls = 0;
      let resolves = 0;
      let lossCallbacks = 0;
      const settlements: string[] = [];
      const backend: RoutableBackendSession = {
        async execCommand(_args, ...trailing) {
          expect(trailing).toEqual([]);
          providerCalls++;
          throw fence;
        },
      };
      const route = new RoutingSandboxSession({
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
        resolveActiveBackend: async () => {
          resolves++;
          return { session: backend, sandboxId: null, kind: "modal" };
        },
        beforeMutation: async () => {
          if (!admit) throw fence;
          return "admitted";
        },
        afterMutation: async ({ outcome }) => {
          settlements.push(outcome);
        },
        onDefaultBackendError: async () => {
          lossCallbacks++;
          return null;
        },
        ...(firstOperation ? { onFirstOperation: () => {} } : {}),
      });
      const session = decoratedSession(route, mode);
      const refused: unknown[] = [];
      const firstError = await session
        .execCommand(
          { cmd: "refused" },
          {
            onMutationAdmissionRefused: (error) => {
              refused.push(error);
              throw new Error("observer failed");
            },
          },
        )
        .catch((error: unknown) => error);
      expect(firstError).toBe(fence);
      expect(refused).toEqual([fence]);
      expect(providerCalls).toBe(0);
      expect(settlements).toEqual([]);
      admit = true;
      const laterRefusals: unknown[] = [];
      const laterError = await session
        .execCommand(
          { cmd: "dispatched" },
          { onMutationAdmissionRefused: (error) => laterRefusals.push(error) },
        )
        .catch((error: unknown) => error);
      expect(laterError).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
      expect((laterError as RoutingMutationOutcomeUnknownError).cause).toBe(fence);
      expect(laterRefusals).toEqual([]);
      expect(providerCalls).toBe(1);
      expect(settlements).toEqual(["rejected"]);
      expect(resolves).toBe(1);
      expect(lossCallbacks).toBe(0);
    });
  }

  test(`${mode} an identical error from route resolution carries no admission proof`, async () => {
    const fence = new SandboxWorkspaceMutationFencedError("attempt_fenced", "attempt fenced");
    const refusals: unknown[] = [];
    let resolves = 0;
    const route = new RoutingSandboxSession({
      readPointer: async () => {
        throw fence;
      },
      resolveActiveBackend: async () => {
        resolves++;
        return { session: {}, sandboxId: null, kind: "modal" };
      },
    });
    const error = await decoratedSession(route, mode)
      .execCommand(
        { cmd: "unresolved" },
        { onMutationAdmissionRefused: (refusal) => refusals.push(refusal) },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBe(fence);
    expect(refusals).toEqual([]);
    expect(resolves).toBe(0);
  });
});

describe("credential command decorator forwarding", () => {
  for (const mode of decoratorModes.filter((candidate) => candidate !== "none")) {
    for (const method of ["exec", "execCommand"] as const) {
      test(`${mode} ${method} preserves trailing arguments, target binding and private controls`, async () => {
        const receipt = {};
        const fence = new SandboxWorkspaceMutationFencedError("attempt_fenced", "attempt fenced");
        class Session {
          #receipt = receipt;
          failure: unknown;
          calls: { args: { cmd: string; tty?: boolean }; trailing: unknown[] }[] = [];
          async exec(args: { cmd: string; tty?: boolean }, ...trailing: unknown[]) {
            this.calls.push({ args, trailing });
            if (this.failure) throw this.failure;
            return this.#receipt;
          }
          async execCommand(args: { cmd: string; tty?: boolean }, ...trailing: unknown[]) {
            return await this.exec(args, ...trailing);
          }
          async execCommandForProcessControl(args: { cmd: string }, ...trailing: unknown[]) {
            this.calls.push({ args, trailing });
            return this.#receipt;
          }
          supportsPty() {
            return this.#receipt === receipt;
          }
        }
        const raw = new Session();
        const session = decoratedSession(raw, mode);
        const args = { cmd: "echo test", tty: false };
        const options = { onMutationAdmissionRefused: (_error: unknown) => {} };
        const opaque = {};
        expect(await session[method](args, options, undefined, opaque)).toBe(receipt);
        const expectedCodemode = ["codemode", "composed"].includes(mode)
          ? withCodemodeTokenEnvironment(args.cmd, tokenFile, codemodeUrl, clientDirectory)
          : args.cmd;
        const expectedCommand = ["run_credentials", "composed"].includes(mode)
          ? withRunCredentialEnvironment(expectedCodemode, credentialSessionId)
          : expectedCodemode;
        expect(raw.calls[0]!.args).toEqual({ ...args, cmd: expectedCommand });
        expect(args.cmd).toBe("echo test");
        expect(raw.calls[0]!.trailing).toHaveLength(3);
        expect(raw.calls[0]!.trailing[0]).toBe(options);
        expect(raw.calls[0]!.trailing[1]).toBeUndefined();
        expect(raw.calls[0]!.trailing[2]).toBe(opaque);
        expect(session.supportsPty()).toBe(true);
        expect(await session.execCommandForProcessControl(args, opaque)).toBe(receipt);
        expect(raw.calls[1]!.args).toBe(args);
        expect(raw.calls[1]!.trailing[0]).toBe(opaque);
        raw.failure = fence;
        expect(await session[method](args, options).catch((error: unknown) => error)).toBe(fence);
        expect(raw.calls[2]!.trailing[0]).toBe(options);
      });
    }
  }
});
