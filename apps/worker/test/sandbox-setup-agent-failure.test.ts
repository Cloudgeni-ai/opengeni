import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { RoutingMutationOutcomeUnknownError } from "@opengeni/runtime";
import {
  agentErrorToControlError,
  connectionReplacedAgentError,
  offlineAgentError,
  SelfhostedControlError,
  timeoutAgentError,
} from "@opengeni/runtime/sandbox";
import { commandOutcomeUnknownAfterReplacementAgentError } from "../../../packages/runtime/src/sandbox/selfhosted/control-rpc";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import {
  createSandboxSetupReplayGuard,
  isSandboxAgentLivenessFailure,
  SandboxSetupAgentUnavailableError,
  sandboxSetupFailure,
} from "../src/activities/agent-turn/sandbox-setup-agent-failure";

function controlError(input: Partial<ConstructorParameters<typeof SelfhostedControlError>[0]>) {
  return new SelfhostedControlError({
    message: "control failure",
    code: 0 as never,
    reason: null,
    retryable: false,
    ...input,
  });
}

// The machine agent of a sandbox stopped answering while platform setup ran.
const liveness = {
  "agent replaced with the command's outcome unknown": () =>
    agentErrorToControlError(
      commandOutcomeUnknownAfterReplacementAgentError({
        startConfirmed: false,
        stopRequested: true,
      }),
    ),
  "agent replaced before the request reached it": () =>
    agentErrorToControlError(connectionReplacedAgentError(true)),
  "compute agent did not answer in time": () =>
    controlError({
      message: "The agent of compute sandbox sbx-1 did not answer within 120s.",
      reason: "agent_offline",
      agentOffline: true,
    }),
  "agent did not respond in time": () => agentErrorToControlError(timeoutAgentError()),
  "agent offline": () => agentErrorToControlError(offlineAgentError()),
  "agent draining": () => controlError({ draining: true, retryable: true }),
};

// The agent answered: these are the setup's real outcome.
const answered = {
  "epoch fence": () => controlError({ fenced: true, retryable: true }),
  "consent required": () => controlError({ reason: "consent_required" }),
  "missing path": () => controlError({ osNotFound: true }),
  "oversized reply": () => controlError({ payloadTooLarge: true }),
  "failed command": () => controlError({ message: "exit status 1" }),
  "plain error": () => new Error("did not respond in time"),
};

/** The SDK wraps the first sandbox tool call's failure on `.error`. */
function inToolCall(error: unknown): Error {
  return new ToolCallError(`Failed to run function tools: ${String(error)}`, error as Error);
}

describe("machine-agent liveness failures during sandbox setup", () => {
  for (const [label, make] of Object.entries(liveness)) {
    test(`${label} is a liveness failure the same turn retries`, () => {
      const raw = make();
      expect(isSandboxAgentLivenessFailure(raw)).toBe(true);
      expect(isSandboxAgentLivenessFailure(new Error("setup failed", { cause: raw }))).toBe(true);
      expect(isSandboxAgentLivenessFailure(new AggregateError([new Error("x"), raw]))).toBe(true);
      const setup = sandboxSetupFailure(createSandboxSetupReplayGuard(), raw);
      expect(setup).toBeInstanceOf(SandboxSetupAgentUnavailableError);
      expect(agentRunFailurePayload(inToolCall(setup))).toMatchObject({
        code: "sandbox_command_start_unavailable",
        retryable: true,
      });
      expect(agentRunFailurePayload(inToolCall(setup)).error).toContain(
        "The same turn will retry after a short delay.",
      );
    });
  }

  for (const [label, make] of Object.entries(answered)) {
    test(`${label} is not a liveness failure and keeps its own classification`, () => {
      const raw = make();
      expect(isSandboxAgentLivenessFailure(raw)).toBe(false);
      expect(sandboxSetupFailure(createSandboxSetupReplayGuard(), raw)).toBe(raw);
    });
  }

  test("the same failure from a model's own command is never retried", () => {
    // Not raised by setup: the command may have run, so the turn must not replay.
    for (const make of Object.values(liveness)) {
      const failure = agentRunFailurePayload(inToolCall(make()));
      expect(failure.code).not.toBe("sandbox_command_start_unavailable");
      expect(failure.retryable).not.toBe(true);
    }
  });

  test("an uncertain workspace mutation in the same failure vetoes the retry", () => {
    const setup = sandboxSetupFailure(createSandboxSetupReplayGuard(), liveness["agent offline"]());
    const uncertain = new AggregateError([
      setup,
      new RoutingMutationOutcomeUnknownError("skillCheckout", "outcome unknown"),
    ]);
    const failure = agentRunFailurePayload(inToolCall(uncertain));
    expect(failure.code).not.toBe("sandbox_command_start_unavailable");
    expect(failure.retryable).not.toBe(true);
  });

  test("a rig setup script that started without finishing is not replayed", async () => {
    const guard = createSandboxSetupReplayGuard();
    const raw = liveness["agent replaced with the command's outcome unknown"]();
    const coordinate = guard.trackRigSetup(async ({ execute }) => {
      await execute();
      return "executed";
    });
    const failed = await coordinate({
      specHash: "sha256:rig",
      timeoutMs: 1_000,
      execute: async () => {
        throw raw;
      },
    }).catch((error: unknown) => error);
    expect(failed).toBe(raw);
    expect(guard.replaySafe()).toBe(false);
    expect(sandboxSetupFailure(guard, raw)).toBe(raw);
  });

  test("a finished or reused rig setup keeps later setup steps replay safe", async () => {
    const guard = createSandboxSetupReplayGuard();
    const executed = guard.trackRigSetup(async ({ execute }) => {
      await execute();
      return "executed";
    });
    await executed({ specHash: "sha256:rig", timeoutMs: 1_000, execute: async () => undefined });
    expect(guard.replaySafe()).toBe(true);
    const reused = guard.trackRigSetup(async () => "reused");
    await reused({
      specHash: "sha256:rig",
      timeoutMs: 1_000,
      execute: async () => {
        throw new Error("must not run");
      },
    });
    expect(guard.replaySafe()).toBe(true);
    expect(sandboxSetupFailure(guard, liveness["agent offline"]())).toBeInstanceOf(
      SandboxSetupAgentUnavailableError,
    );
  });
});
