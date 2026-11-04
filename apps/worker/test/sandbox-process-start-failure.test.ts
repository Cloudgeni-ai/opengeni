import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { ErrorCode } from "@opengeni/agent-proto";
import { agentErrorToControlError, offlineAgentError } from "@opengeni/runtime/sandbox";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import {
  createSandboxSetupReplayGuard,
  isSandboxProcessStartFailure,
  recoverSandboxSetupFailure,
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

/** The agent's answer when it cannot start a program. */
function processStartError(program: string, note = "") {
  return agentErrorToControlError({
    code: ErrorCode.ERROR_CODE_NOT_FOUND,
    message: `not found: spawn or apply execution containment for ${program}${note}: No such file or directory (os error 2)`,
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
function computeTurn(options: { restartFails?: boolean } = {}) {
  const events: Published[] = [];
  let restarts = 0;
  const session = {
    backendId: "compute" as const,
    restartMachine: async () => {
      restarts += 1;
      if (options.restartFails) throw new Error("compute control: 503 unavailable");
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
  return { recovery, events, restarts: () => restarts };
}

describe("a sandbox that cannot start programs", () => {
  test("the agent's error never carries the command text", () => {
    const error = processStartError(INSTALL_SCRIPT);
    expect(error.processStartFailed).toBe(true);
    // A failed spawn is not a missing path the caller asked about.
    expect(error.osNotFound).toBe(false);
    expect(error.message).toBe(
      "not found: spawn or apply execution containment for a shell command: No such file or directory (os error 2)",
    );
    for (const leaked of ["node -e", "crypto", "integrity failure", "\n"]) {
      expect(error.message).not.toContain(leaked);
    }
  });

  test("the turn fails with short copy, never the raw script (the incident)", () => {
    // The lazy setup's Codemode client install failed inside the first tool call.
    const failure = agentRunFailurePayload(inToolCall(processStartError(INSTALL_SCRIPT)));
    expect(failure.code).toBe("sandbox_process_start_failed");
    expect(failure.retryable).toBe(false);
    expect(failure.error).toContain("can't start programs");
    for (const text of [failure.error, String(failure.detail ?? "")]) {
      expect(text).not.toContain("node -e");
      expect(text).not.toContain("Codemode client transfer integrity failure");
    }
    expect(failure.error.length).toBeLessThan(200);
  });

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
    expect(failure.error).toContain("stopped being able to start programs");
    expect(failure.error).toContain("Your files are kept");
  });

  test("a box still broken after its restart stops the turn instead of looping", async () => {
    const turn = computeTurn();
    const guard = createSandboxSetupReplayGuard();
    // Attempt 1 restarts; attempt 2 of the same turn finds that restart.
    await recoverSandboxSetupFailure(guard, processStartError("/bin/sh"), turn.recovery);
    const second = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh"),
      turn.recovery,
    );
    const third = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh"),
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
      processStartError("/bin/sh"),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.restarts()).toBe(0);
  });

  test("a failed restart stops the turn as a sandbox failure, not a control-service outage", async () => {
    const turn = computeTurn({ restartFails: true });
    const error = await recoverSandboxSetupFailure(
      createSandboxSetupReplayGuard(),
      processStartError("/bin/sh"),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.events.map((event) => event.type)).toEqual([
      "sandbox.operation.started",
      "sandbox.operation.failed",
    ]);
    const failure = agentRunFailurePayload(inToolCall(error));
    expect(failure).toMatchObject({ code: "sandbox_process_start_failed", retryable: false });
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
        throw processStartError("/bin/sh");
      },
    }).catch(() => undefined);
    const error = await recoverSandboxSetupFailure(
      guard,
      processStartError("/bin/sh"),
      turn.recovery,
    );
    expect(error).toBeInstanceOf(SandboxProcessStartFailedError);
    expect(turn.restarts()).toBe(0);
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
});
