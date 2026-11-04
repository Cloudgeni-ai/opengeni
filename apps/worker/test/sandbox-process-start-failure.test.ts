import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { ErrorCode } from "@opengeni/agent-proto";
import {
  agentErrorToControlError,
  ComputeSandboxSession,
  offlineAgentError,
} from "@opengeni/runtime/sandbox";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { TurnAttemptFencedError } from "../src/activities/turn-attempt-fenced";
import {
  createSandboxSetupReplayGuard,
  isSandboxProcessStartFailure,
  recoverSandboxSetupFailure,
  SandboxMachineBackError,
  SandboxMachineRestartingError,
  SandboxProcessStartFailedError,
  SandboxSetupAgentUnavailableError,
  type SandboxProcessStartRecovery,
} from "../src/activities/agent-turn/sandbox-setup-agent-failure";

// The script the Codemode client install sends as one shell command; agents
// up to 0.1.150 put it whole into their spawn error (the 4 Nov incident).
const INSTALL_SCRIPT = `node -e '
const fs = require('\\''node:fs'\\''), crypto = require('\\''node:crypto'\\'');
const transferred = fs.readFileSync(process.argv[1]);
if (crypto.createHash('\\''sha256'\\'').update(raw).digest('\\''hex'\\'') !== "f52d") throw Error('\\''Codemode client transfer integrity failure'\\'');
' '/workspace/.opengeni/codemode-clients/stage-1.json'`;

/** A newer agent names the missing device. */
const NULL_DEVICE_MISSING = " (the null device /dev/null is missing)";

/** The agent's answer when it cannot start a program. A newer agent quotes
 * the program it started; an older one (up to 0.1.150) wrote the first
 * command element unquoted, which for a shell command was the whole script. */
function processStartError(program: string, note = "") {
  const reported = program === INSTALL_SCRIPT ? program : `program "${program}"`;
  return agentErrorToControlError({
    code: ErrorCode.ERROR_CODE_NOT_FOUND,
    message: `not found: spawn or apply execution containment for ${reported}${note}: No such file or directory (os error 2)`,
    retryable: false,
    detail: {},
  });
}

/** The SDK wraps the first sandbox tool call's failure on `.error`. */
function inToolCall(error: unknown): Error {
  return new ToolCallError(`Failed to run function tools: ${String(error)}`, error as Error);
}

type Published = Parameters<SandboxProcessStartRecovery["publish"]>[0][number];

/** A compute box and a turn's event log, as the worker sees them. */
function computeTurn(options: { restartFails?: boolean; startsProgramsNow?: boolean } = {}) {
  const events: Published[] = [];
  let restarts = 0;
  let probes = 0;
  const session = {
    backendId: "compute" as const,
    restartMachine: async () => {
      restarts += 1;
      if (options.restartFails) throw new Error("compute control: 503 unavailable");
    },
    // The box answers the pre-restart probe as it is: broken unless another
    // session already restarted it.
    exec: async () => {
      probes += 1;
      if (!options.startsProgramsNow) throw processStartError("/bin/sh", NULL_DEVICE_MISSING);
      return { exitCode: 0 };
    },
  };
  const recovery: SandboxProcessStartRecovery = {
    session,
    backend: "compute",
    // Counted from the durable log, as the database helper does.
    restartsThisTurn: async () =>
      events.filter(
        (event) =>
          event.type === "sandbox.operation.started" &&
          event.payload.name === "sandbox.process_start_restart",
      ).length,
    publish: async (published) => {
      events.push(...published);
    },
    operationName: "sandbox.process_start_restart",
  };
  return { recovery, events, restarts: () => restarts, probes: () => probes };
}

describe("a sandbox that cannot start programs", () => {
  test("a compute box is restarted once and the same turn retries", async () => {
    const turn = computeTurn();
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError(INSTALL_SCRIPT),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxMachineRestartingError);
    expect(turn.restarts()).toBe(1);
    expect(turn.events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.completed",
    ]);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_machine_restarting", retryable: true });
    expect(failure.error).toContain("couldn't start programs, so it was restarted");
    expect(failure.error).toContain("Your files are kept");
  });

  test("a box another session already restarted is retried as is, never restarted again", async () => {
    const turn = computeTurn({ startsProgramsNow: true });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError(INSTALL_SCRIPT),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxMachineBackError);
    expect(turn.probes()).toBe(1);
    expect(turn.restarts()).toBe(0);
    // Nothing was restarted, so nothing says it was, nor counts as a restart.
    expect(turn.events).toEqual([]);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_command_start_unavailable", retryable: true });
    expect(failure.error).not.toContain("restarted");
    expect(failure.error).not.toContain("node -e");
  });

  test("a box still broken after its restart stops the turn instead of looping", async () => {
    const turn = computeTurn();
    const guard = createSandboxSetupReplayGuard();
    // Attempt 1 restarts; attempt 2 of the same turn finds that restart.
    await recoverSandboxSetupFailure(
      guard,
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    const second = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    const third = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    expect(turn.restarts()).toBe(1);
    for (const error of [second, third]) {
      expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
      const failure = agentRunFailurePayload(inToolCall(error));
      expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
      expect(failure.error).toContain("still can't start programs after it was restarted");
    }
  });

  test("no restart without proof that none happened yet", async () => {
    const turn = computeTurn();
    turn.recovery.restartsThisTurn = async () => {
      throw new Error("database unavailable");
    };
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.restarts()).toBe(0);
  });

  test("a failed restart stops the turn as a sandbox failure, not a control-service outage", async () => {
    const turn = computeTurn({ restartFails: true });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
    expect(failure.error).toContain("couldn't be restarted");
    expect(String(failure.detail)).toContain("restart failed");
  });

  test("a setup script that started is not replayed by a restart", async () => {
    const turn = computeTurn();
    const guard = createSandboxSetupReplayGuard();
    const coordinate = guard.trackRigSetup(async ({ execute }) => {
      await execute();
      return "executed";
    });
    await coordinate({
      specHash: "sha256:rig",
      timeoutMs: 1_000,
      execute: async () => {
        throw processStartError("/bin/sh", NULL_DEVICE_MISSING);
      },
    }).catch(() => undefined);
    const error = await recoverSandboxSetupFailure(
      guard,
      processStartError("/bin/sh", NULL_DEVICE_MISSING),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.restarts()).toBe(0);
    // No restart was tried, so the copy never says one failed.
    expect(agentRunFailurePayload(inToolCall(error)).error).toBe(
      "The workspace machine can't start programs, so this turn stopped. Retry, or start a new chat if it keeps failing.",
    );
  });

  test("a connected machine is never restarted and its copy says what to do", async () => {
    const events: Published[] = [];
    const recovery: SandboxProcessStartRecovery = {
      session: { backendId: "selfhosted" },
      backend: "selfhosted",
      restartsThisTurn: async () => 0,
      publish: async (published) => {
        events.push(...published);
      },
      operationName: "sandbox.process_start_restart",
    };
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/bash", " (the null device /dev/null is missing)"),
      recovery,
    );
    expect(events).toEqual([]);
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure.code).toBe("sandbox_process_start_failed");
    expect(failure.error).toBe(
      "Your connected machine can't start programs because the null device /dev/null is missing. Restart the machine to restore it, then retry.",
    );
    // /dev/null is named only when the agent detected it as the cause.
    const unnamed = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError(INSTALL_SCRIPT),
      recovery,
    );
    expect(agentRunFailurePayload(inToolCall(unnamed)).error).toBe(
      "Your connected machine can't start programs. Restart the machine, then retry.",
    );
  });

  test("an unanswered agent keeps its own recovery", async () => {
    const turn = computeTurn();
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      agentErrorToControlError(offlineAgentError()),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxSetupAgentUnavailableError);
    expect(turn.restarts()).toBe(0);
  });

  test("other failures pass through unchanged", async () => {
    const turn = computeTurn();
    const plain = new Error("exit status 1");
    expect(isSandboxProcessStartFailure(plain)).toBe(false);
    expect(
      await recoverSandboxSetupFailure(createSandboxSetupReplayGuard(), plain, turn.recovery),
    ).toBe(plain);
    expect(turn.restarts()).toBe(0);
  });

  test("one missing or forbidden program never restarts the machine", async () => {
    for (const message of [
      'not found: spawn or apply execution containment for program "/nonexistent/opengeni-missing-program": No such file or directory (os error 2)',
      'spawn or apply execution containment for program "/usr/local/bin/tool": Permission denied (os error 13)',
      'not found: spawn or apply execution containment for program "C:\\Windows\\System32\\cmd.exe": The system cannot find the file specified. (os error 2)',
      // An older agent's plain program name.
      "not found: spawn or apply execution containment for /nonexistent/opengeni-missing-program: No such file or directory (os error 2)",
      // Brief resource pressure: several sessions can share one box.
      'spawn or apply execution containment for program "/bin/sh": Resource temporarily unavailable (os error 11)',
    ]) {
      const turn = computeTurn();
      const error = agentErrorToControlError({
        code: message.startsWith("not found")
          ? ErrorCode.ERROR_CODE_NOT_FOUND
          : ErrorCode.ERROR_CODE_OS,
        message,
        retryable: false,
        detail: {},
      });
      expect(isSandboxProcessStartFailure(error)).toBe(false);
      expect(isSandboxProcessStartFailure(inToolCall(error))).toBe(false);
      expect(
        await recoverSandboxSetupFailure(createSandboxSetupReplayGuard(), error, turn.recovery),
      ).toBe(error);
      expect(turn.restarts()).toBe(0);
      expect(turn.events).toEqual([]);
    }
  });

  test("a fenced attempt stops as such and restarts nothing", async () => {
    const turn = computeTurn();
    const fenced = new TurnAttemptFencedError("turn execution generation was fenced");
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError(INSTALL_SCRIPT),
      {
        ...turn.recovery,
        publish: async () => {
          throw fenced;
        },
      },
    );
    expect(error).toBe(fenced);
    expect(turn.restarts()).toBe(0);
  });

  test("an unrecorded restart is never made", async () => {
    const turn = computeTurn();
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError(INSTALL_SCRIPT),
      {
        ...turn.recovery,
        publish: async () => {
          throw new Error("database unavailable");
        },
      },
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.restarts()).toBe(0);
  });

  test("the real compute session is the restartable shape the recovery looks for", () => {
    // Duck-typed in the worker; a rename here would silently stop restarts.
    const restartable: {
      readonly backendId: "compute";
      restartMachine(): Promise<void>;
      exec(args: { cmd: string }): Promise<unknown>;
    } = Object.create(ComputeSandboxSession.prototype) as ComputeSandboxSession;
    expect(typeof restartable.restartMachine).toBe("function");
    expect(typeof restartable.exec).toBe("function");
  });
});
