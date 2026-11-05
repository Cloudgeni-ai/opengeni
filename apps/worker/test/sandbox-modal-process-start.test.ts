import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import {
  agentRunFailurePayload,
  sandboxLifecycleTransitionDiagnostic,
} from "../src/activities/agent-turn/errors";
import * as setupFailure from "../src/activities/agent-turn/sandbox-setup-agent-failure";
import * as settlement from "../src/activities/agent-turn/failure-settlement";
import { SandboxLeaseTransitionError } from "@opengeni/db";
import {
  createSandboxSetupReplayGuard,
  recoverSandboxSetupFailure,
  SandboxMachineBackError,
  SandboxProcessStartFailedError,
  type SandboxProcessStartRecovery,
} from "../src/activities/agent-turn/sandbox-setup-agent-failure";

// Modal runs every command as `/bin/sh -c <command>`. With /bin/sh deleted,
// Modal answers each exec with exit code 128 and this text, which repeats the
// whole command (observed on staging, 4 Nov 2026).
const INSTALL_SCRIPT =
  "set -eu; umask 077; mkdir -p /workspace/.opengeni/codemode-clients; node -e 'secret-free install script'";
const MODAL_EXEC_ERROR = `executing processes for container: executing command "/bin/sh -c ${INSTALL_SCRIPT}" in sandbox: failed to load /bin/sh: no such file or directory`;

/** The lazy first tool call's setup failure, as the runtime throws it. */
function setupFailureError(): Error {
  return new Error(
    `Sandbox path "/workspace/.opengeni/codemode-clients/stage-1.json" failed remote validation: ${MODAL_EXEC_ERROR}`,
  );
}

/** The SDK wraps the first sandbox tool call's failure on `.error`. */
function inToolCall(error: unknown): Error {
  return new ToolCallError(`Failed to run function tools: ${String(error)}`, error as Error);
}

type Published = Parameters<SandboxProcessStartRecovery["publish"]>[0][number];
type Replacement = {
  sandboxGroupId: string;
  leaseEpoch: number;
  instanceId: string;
  liveness: "warm" | "draining";
};

/** A Modal box, its lease and a turn's event log, as the worker sees them. */
function modalTurn(
  options: {
    /** How the box answers the probe; its shell is gone by default. */
    probe?: "starts" | "no-shell" | "notice";
    /** How the box saves /workspace. */
    persistence?: string;
    /** What the lease answers when asked to replace the box. */
    replacement?: Replacement | null | "throws";
  } = {},
) {
  const events: Published[] = [];
  let replacements = 0;
  let probes = 0;
  // A real Modal session has no restart and no `exec`: its `execCommand`
  // resolves with the command page as text, even when the command could not
  // start (exit code 128 and Modal's error, or the model-facing notice).
  const page = (exitCode: number, output: string) =>
    `Provider output receipt: r-1\nProcess exited with code ${exitCode}\nOutput:\n${output}`;
  const session = {
    state: { workspacePersistence: options.persistence ?? "snapshot_directory" },
    execCommand: async () => {
      probes += 1;
      if (options.probe === "starts") return page(0, "");
      return options.probe === "notice"
        ? page(
            128,
            "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory.\nThis command did not run.",
          )
        : page(128, MODAL_EXEC_ERROR.replace(INSTALL_SCRIPT, "true"));
    },
  };
  const recovery: SandboxProcessStartRecovery = {
    session,
    backend: "modal",
    restartsThisTurn: async () => {
      const of = (type: Published["type"]) =>
        events.filter(
          (event) => event.type === type && event.payload.name === "sandbox.process_start_restart",
        ).length;
      return {
        started: of("sandbox.operation.started"),
        completed: of("sandbox.operation.completed"),
      };
    },
    publish: async (published) => {
      events.push(...published);
    },
    operationName: "sandbox.process_start_restart",
    boxReplacement: {
      sandboxGroupId: "group-1",
      leaseEpoch: 6,
      instanceId: "sb-no-shell",
      request: async () => {
        replacements += 1;
        if (options.replacement === "throws") throw new Error("database unavailable");
        return options.replacement === undefined
          ? {
              sandboxGroupId: "group-1",
              leaseEpoch: 6,
              instanceId: "sb-no-shell",
              liveness: "warm",
            }
          : options.replacement;
      },
    },
  };
  return { recovery, events, replacements: () => replacements, probes: () => probes };
}

describe("a Modal box that cannot start programs", () => {
  test("is replaced once and the same turn waits for the fresh box", async () => {
    const turn = modalTurn();
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect((error as Error).name).toBe("SandboxMachineReplacingError");
    expect(turn.probes()).toBe(1);
    expect(turn.replacements()).toBe(1);
    // Not completed yet: the drain replaces the box (the row settles with the turn).
    expect(turn.events.map((event) => event.type)).toEqual(["sandbox.operation.started"]);
    // The restart names the replaced box, so a drain that cannot save it
    // releases the turns waiting on it (see releaseSandboxProcessStartReplacementWaiters).
    expect(turn.events[0]?.payload).toMatchObject({
      name: "sandbox.process_start_restart",
      reason: "process_start_failed",
      sandboxGroupId: "group-1",
      leaseEpoch: 6,
    });
    // Failure settlement parks the turn on this exact rotation and resumes it
    // on the replacement, as it does for any other box rotation.
    expect(sandboxLifecycleTransitionDiagnostic(inToolCall(error))).toEqual({
      sandboxGroupId: "group-1",
      leaseEpoch: 6,
      reason: "rotation_in_progress",
    });
  });

  test("a box that already works again is retried as is, never replaced", async () => {
    const turn = modalTurn({ probe: "starts" });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxMachineBackError);
    expect(turn.replacements()).toBe(0);
    expect(turn.events).toEqual([]);
  });

  test("a fresh box that still cannot start programs stops the turn instead of looping", async () => {
    const turn = modalTurn();
    await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    const second = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect(turn.replacements()).toBe(1);
    expect(second).toBeInstanceOf(SandboxProcessStartFailedError);
    const failure = agentRunFailurePayload(inToolCall(second));
    expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
    expect(failure.error).toContain("still can't start programs after it was restarted");
    expect(String(failure.detail)).not.toContain("umask");
  });

  test("a replacement the lease refuses stops the turn with clear copy", async () => {
    const turn = modalTurn({ replacement: "throws" });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect(turn.replacements()).toBe(1);
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
    expect(failure.error).toContain("couldn't be restarted");
    expect(sandboxLifecycleTransitionDiagnostic(inToolCall(error))).toBeNull();
  });

  test("a box the lease already replaced is retried on the new box, not stopped", async () => {
    const turn = modalTurn({ replacement: null });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect(turn.replacements()).toBe(1);
    expect(error).toBeInstanceOf(SandboxMachineBackError);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_command_start_unavailable", retryable: true });
    expect(failure.error).toContain("already been replaced");
    // The restart still counts: a new box that also fails stops the turn.
    expect(turn.events.map((event) => event.type)).toEqual(["sandbox.operation.started"]);
  });

  test("the model-facing notice is read as the same failure by the probe", async () => {
    const turn = modalTurn({ probe: "notice" });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect((error as Error).name).toBe("SandboxMachineReplacingError");
    expect(turn.replacements()).toBe(1);
  });

  test("without a replacement its failure is short copy, never Modal's command dump", async () => {
    const turn = modalTurn();
    delete turn.recovery.boxReplacement;
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      setupFailureError(),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
    expect(failure.detail).toBe(
      "Modal could not start the sandbox shell: failed to load /bin/sh: no such file or directory",
    );
    // The raw error, unwrapped, is classified the same way.
    const raw = agentRunFailurePayload(inToolCall(setupFailureError()));
    expect(raw).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
    expect(String(raw.detail)).not.toContain("umask");
  });

  test("only a Modal box with a known lease epoch and instance gets a replacement", () => {
    const replacer = (setupFailure as Partial<typeof setupFailure>).modalSandboxBoxReplacer;
    expect(typeof replacer).toBe("function");
    if (!replacer) return;
    const box = { leaseEpoch: 6, established: { instanceId: "sb-no-shell" } };
    const base = { accountId: "a", workspaceId: "w", sandboxGroupId: "g", box };
    const db = {} as Parameters<typeof replacer>[0];
    const session = { state: { workspacePersistence: "snapshot_directory" } };
    expect(replacer(db, { ...base, session, backend: "modal" })).toMatchObject({
      sandboxGroupId: "g",
      leaseEpoch: 6,
      instanceId: "sb-no-shell",
    });
    expect(replacer(db, { ...base, session, backend: "compute" })).toBeUndefined();
    expect(
      replacer(db, { ...base, session, backend: "modal", sandboxGroupId: null }),
    ).toBeUndefined();
    expect(replacer(db, { ...base, session, backend: "modal", box: null })).toBeUndefined();
    // Only a directory-snapshot box is restored clean: a whole-filesystem
    // snapshot keeps the broken /bin/sh, and a tar save needs the box's shell.
    for (const workspacePersistence of ["snapshot_filesystem", "tar", undefined]) {
      expect(
        replacer(db, { ...base, backend: "modal", session: { state: { workspacePersistence } } }),
      ).toBeUndefined();
    }
    expect(
      replacer(db, {
        ...base,
        backend: "modal",
        session: { state: { providerState: { workspacePersistence: "snapshot_directory" } } },
      }),
    ).toBeDefined();
  });
});

describe("a Modal box whose replacement cannot be saved yet", () => {
  /** The fence a later attempt of the turn meets while the box drains. */
  const fenced = (reason: "rotation_in_progress" | "capture_in_progress", leaseEpoch = 6) =>
    inToolCall(
      new SandboxLeaseTransitionError(
        "group-1",
        leaseEpoch,
        reason,
        "modal",
        "sb-no-shell",
        "draining",
      ),
    );
  const deps = (error: unknown) => ({
    error,
    db: {} as never,
    input: { workspaceId: "ws-1", sessionId: "session-1" } as never,
    attempt: { turnId: "turn-1" },
  });
  const stop = (settlement as Partial<typeof settlement>).sandboxBoxNotSavedStop;
  /** A save of group-1 at epoch 6 failed while this turn waited on it. */
  const replacedThisBox = async () => ({ sandboxGroupId: "group-1", leaseEpoch: 6 });

  test("a turn released by a failed save stops with clear copy instead of waiting", async () => {
    expect(typeof stop).toBe("function");
    if (!stop) return;
    for (const reason of ["rotation_in_progress", "capture_in_progress"] as const) {
      const error = await stop(deps(fenced(reason)), replacedThisBox);
      expect((error as Error).name).toBe("SandboxBoxNotSavedError");
      // Not a lifecycle wait: failure settlement fails the turn terminally.
      expect(sandboxLifecycleTransitionDiagnostic(error)).toBeNull();
      const failure = agentRunFailurePayload(error);
      expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
      expect(failure.error).toBe(
        "The workspace machine can't start programs and its files couldn't be saved yet. Opengeni will replace it once they're saved; retry then.",
      );
    }
  });

  test("every other fenced turn keeps waiting for the replacement", async () => {
    expect(typeof stop).toBe("function");
    if (!stop) return;
    // The attempt that requested the replacement parks on it.
    const turn = modalTurn();
    const replacing = inToolCall(
      await recoverSandboxSetupFailure(
        createSandboxSetupReplayGuard(),
        setupFailureError(),
        turn.recovery,
      ),
    );
    expect(await stop(deps(replacing), replacedThisBox)).toBe(replacing);
    // A turn no failed save released, or one fenced by another box, waits as before.
    const other = fenced("rotation_in_progress");
    expect(await stop(deps(other), async () => null)).toBe(other);
    const newer = fenced("rotation_in_progress", 7);
    expect(await stop(deps(newer), replacedThisBox)).toBe(newer);
    // An unreadable record never stops a turn.
    expect(
      await stop(deps(other), async () => {
        throw new Error("database unavailable");
      }),
    ).toBe(other);
  });
});
